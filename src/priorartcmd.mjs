/**
 * `prior-art` command (Goal 4, Q4): arguments in, a report out. It reads nothing from the machine except its arguments, writes nothing (the caller
 * prints what this returns), and never waits on a terminal. GitHub is reached only through the injected runner, which is wrapped so that anything
 * but a plain read is refused before it runs (the design note's rule: no issue, comment, fork, star or message from this command, ever).
 *
 *   exit 0  complete      exit 3  PARTIAL (a GitHub error or rate limit stopped it; the report says so)
 *   exit 1  nothing could be searched at all (no report: "nothing found" would be a lie)      exit 2  bad arguments
 */
import { createSearch, clean, LIMITS } from "./ghsearch.mjs";
import { GhError, HEADERS } from "./ghclient.mjs";
import { extractTerms, overlap, makePolicy, scoreCandidate, rank, formatReport, runOneLine, CAVEATS, MATCHER_CAVEAT } from "./priorart.mjs";
import { shown as shownOf, reorder } from "./matcher.mjs";
import { describeSend, matchCandidates, modelVersion, loopbackHost, validModel, DEFAULT_HOST } from "./matcherclient.mjs";

export const MAX_SEARCHES = 6;
const MAX_DESCRIPTION = 2000;
const DAY = 86400000;

export const USAGE = `usage: prior-art "<what you plan to build, in a sentence or two>" --gh /abs/path/to/gh [--language L] [--license-ok MIT,Apache-2.0,...] [--max-age-days N] [--min-contributors N] [--limit 1-10] [--json] [--matcher OLLAMA_MODEL [--matcher-host URL] [--dry-run-matcher]]
--limit is how many candidates are read in detail (the search itself always fetches at least 10 results).
Looks for existing open projects on GitHub (read-only, through your own gh) and says whether one is worth contributing to instead. It never opens an issue, comments, forks, stars or contacts anyone.
--matcher asks a model running on THIS machine (Ollama, loopback only) whether each candidate is the same kind of project, and orders the list by its answer. It is off unless you pass it; it prints exactly what it sends before it asks; --dry-run-matcher prints that and stops without asking.`;

class UsageError extends Error {}

const FLAGS = { "--gh": true, "--language": true, "--license-ok": true, "--max-age-days": true, "--min-contributors": true, "--limit": true, "--json": false, "--matcher": true, "--matcher-host": true, "--dry-run-matcher": false };

/** Strict parsing: one positional (the description), known flags only, each flag at most once, numbers are plain digits. */
export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new UsageError("no arguments");
  const seen = new Set(), flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") throw new UsageError("arguments must be strings");
    if (a.startsWith("--")) {
      if (!(a in FLAGS)) throw new UsageError(`unknown option: ${clean(a, 40)}`);
      if (seen.has(a)) throw new UsageError(`${a} given twice`);
      seen.add(a);
      if (FLAGS[a]) {
        const v = argv[++i];
        if (typeof v !== "string" || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
        flags[a] = v;
      } else flags[a] = true;
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new UsageError("give the description as ONE quoted argument");
  const description = positional[0];
  if (description.trim().length === 0) throw new UsageError("the description is empty");
  if ([...description].length > MAX_DESCRIPTION) throw new UsageError(`the description is longer than ${MAX_DESCRIPTION} characters`);
  const gh = flags["--gh"];
  if (!gh || !gh.startsWith("/")) throw new UsageError("--gh must be the absolute path of your gh");
  const int = (name, lo, hi) => {
    if (!(name in flags)) return undefined;
    if (!/^\d{1,6}$/.test(flags[name]) || Number(flags[name]) < lo || Number(flags[name]) > hi) throw new UsageError(`${name}: a whole number from ${lo} to ${hi}`);
    return Number(flags[name]);
  };
  const overrides = {};
  const age = int("--max-age-days", 1, 3650), minc = int("--min-contributors", 1, 1000);
  if (age !== undefined) overrides.maxAgeDays = age;
  if (minc !== undefined) overrides.minContributors = minc;
  if ("--license-ok" in flags) overrides.licenseOk = flags["--license-ok"].split(",");
  let matcher = null;
  if ("--matcher" in flags) {
    if (!validModel(flags["--matcher"])) throw new UsageError("--matcher: the name of a model in your local Ollama");
    const host = loopbackHost(flags["--matcher-host"] ?? DEFAULT_HOST);
    if (!host) throw new UsageError("--matcher-host must be an address on this machine (127.0.0.1 or localhost); a hosted matcher is not available here");
    matcher = { model: flags["--matcher"], host, dryRun: flags["--dry-run-matcher"] === true };
  } else if ("--matcher-host" in flags || "--dry-run-matcher" in flags) throw new UsageError("--matcher-host and --dry-run-matcher need --matcher MODEL");
  let policy;
  try { policy = makePolicy(overrides); } catch (e) { throw new UsageError(clean(e.message, 200)); }
  return { description, gh, language: flags["--language"], limit: int("--limit", 1, 10) ?? 10, json: flags["--json"] === true, policy, matcher };
}

/**
 * Defence in depth: whatever the caller built, only `gh api <GET path>` and `gh api graphql` with a query (never a mutation) get through.
 * ghsearch.mjs already builds nothing else; this makes the property independent of that file.
 */
export function readOnly(run) {
  const refuse = (why) => { throw new GhError(`refusing: this command only reads (${why})`); };
  return (args, opts) => {
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) refuse("not a list of strings");
    // An ALLOWLIST of exactly the two shapes ghsearch.mjs builds. gh turns any -f / -F / --field / --input into a POST, and accepts the joined forms
    // (-fx=1, --field=x=1), so naming the dangerous flags would always miss one. Anything else is refused, including --paginate and --cache.
    if (args.length === 1 + HEADERS.length + 1 && args[0] === "api" && HEADERS.every((h, i) => args[1 + i] === h) && /^\/[A-Za-z0-9_\/.?&=%:+,~*'()!-]*$/.test(args[args.length - 1])) return run(args, opts);
    if (args.length === 6 && args[0] === "api" && args[1] === "graphql" && args[2] === "-f" && args[4] === "-f" && /^query=query[({ ]/.test(args[3]) && !/\b(mutation|subscription)\b/i.test(args[3]) && /^q=repo:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ is:closed sort:updated-desc$/.test(args[5])) return run(args, opts);
    return refuse("not one of the two read shapes");
  };
}

/** Search words joined must stay under GitHub's 256-character query limit (qualifiers excluded); drop trailing words until they fit. */
export const fitTerms = (terms, max = 250) => { const t = [...terms]; while (t.length > 1 && t.join(" ").length > max) t.pop(); return t; };

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The 3 terms with the fewest hits among the candidates seen so far; ties go to the longer word, then to order of appearance. */
export function rarest(terms, repos, n = 3) {
  return terms
    .map((t, i) => ({ t, i, hits: repos.filter((r) => overlap([t], r).matched.length > 0).length }))
    .sort((a, b) => a.hits - b.hits || b.t.length - a.t.length || a.i - b.i)
    .slice(0, n).map((x) => x.t);
}

/**
 * The GitHub half: arguments in, the scored candidates out (or a finished result when the run ends early). Reads GitHub only, through the read-only wrapper.
 * Returns { result } (a final { code, stdout, stderr }) or { ctx } (what `render` needs).
 */
function gather(argv, { run, now, maxSearches = MAX_SEARCHES }) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) return { result: { code: 2, stdout: "", stderr: `${clean(e.message, 300)}\n${USAGE}\n` } };
    throw e;
  }
  if (!Number.isFinite(now)) throw new Error("runPriorArt needs `now`");
  const terms = extractTerms(args.description, LIMITS.maxTerms);
  const termsDropped = extractTerms(args.description, 100).length - terms.length;
  if (terms.length === 0) return { result: { code: 2, stdout: "", stderr: `no searchable words in the description (it needs words of 3+ letters that are not filler)\n${USAGE}\n` } };

  const search = createSearch(readOnly(run));
  const perPage = Math.min(LIMITS.maxResults, Math.max(args.limit, 10));
  const asOf = isoSeconds(now).slice(0, 16) + "Z";
  const since = isoSeconds(now - 365 * DAY);
  const ran = [], seenSets = new Set(), byId = new Map();
  let partial = null, searchCalls = 0, found = 0;

  const doSearch = (set) => {
    const key = [...set].sort().join(" ");
    if (seenSets.has(key)) return;
    seenSets.add(key);
    if (++searchCalls > maxSearches) throw new GhError(`more than ${maxSearches} searches; refusing`);
    const r = search.searchRepos({ terms: set, language: args.language, limit: perPage });
    ran.push(r.query);
    found = Math.max(found, r.total);
    for (const item of r.items) if (!byId.has(item.id)) byId.set(item.id, item);
  };
  const why = (e) => `${clean(e instanceof Error ? e.message : String(e), 200)}${e?.httpStatus === 403 || e?.httpStatus === 429 ? " (probably a rate limit; wait a minute and run it again)" : ""}`;

  try {
    doSearch(fitTerms(terms));
    if (terms.length > 4) doSearch(fitTerms(terms.slice(0, 4)));
    doSearch(fitTerms(rarest(terms, [...byId.values()])));
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    partial = why(e);
  }
  if (ran.length === 0) return { result: { code: 1, stdout: "", stderr: `could not search GitHub: ${partial}\nNo report was made: an empty result here would not mean nothing exists.\n` } };

  // Cheap first pass with no details: archived, wrong-licence, long-dead and unrelated projects are settled without spending any reads.
  const repos = [...byId.values()];
  const settled = [], readable = [];
  for (const repo of repos) {
    const pre = scoreCandidate({ repo, facts: null, terms, policy: args.policy, now });
    (pre.verdict === "skip" || pre.verdict === "no-match" ? settled : readable).push({ repo, pre });
  }
  // Read the most promising first; the rest are counted, never silently dropped.
  const order = rank(readable.map((x) => x.pre));
  const toRead = order.slice(0, args.limit).map((pre) => readable.find((x) => x.pre === pre));
  let notRead = readable.length - toRead.length;
  const scored = settled.map((s) => s.pre);
  const unread = order.slice(args.limit).map((pre) => pre.fullName);
  let nRead = 0;
  // A rate limit or any surprise stops the run. A timeout or a server error on ONE candidate only skips that candidate (and names it), because
  // one slow repository must not abandon the rest; three in a row means GitHub itself is struggling, so that stops too.
  const transient = (e) => (e.httpStatus === undefined && /\(no response\)/.test(e.message)) || e.httpStatus >= 500;
  const skippedNames = [];
  let streak = 0, kind = "stopped";
  for (let i = 0; i < toRead.length; i++) {
    const { repo } = toRead[i];
    if (partial) { notRead++; unread.push(repo.fullName); continue; }
    try {
      const facts = search.facts(repo, { since, now });
      scored.push(scoreCandidate({ repo, facts, terms, policy: args.policy, now }));
      nRead++; streak = 0;
    } catch (e) {
      if (!(e instanceof GhError)) throw e;
      notRead++;
      unread.push(repo.fullName);
      if (transient(e) && ++streak < 3) { skippedNames.push(clean(repo.fullName, 80)); continue; }
      partial = `reading ${clean(repo.fullName, 80)}: ${why(e)}`;
    }
  }
  if (!partial && skippedNames.length) { kind = "skipped"; partial = `${skippedNames.length} candidate${skippedNames.length === 1 ? "" : "s"} could not be read (a timeout or a server error on GitHub's side): ${skippedNames.join(", ")}`; }

  return { ctx: { args, asOf, terms, termsDropped, ran, partial, notRead, found, unread, scored, nRead, kind } };
}

/** The report (or the JSON) from what `gather` found, with the model's opinions when there are any. Pure: no network, no clock. */
function render({ args, asOf, terms, termsDropped, ran, partial, notRead, found, unread, scored, nRead, kind }, matcher = null) {
  if (args.json) {
    const ranked = rank(scored), listed = matcher ? reorder(shownOf(ranked), matcher.answers) : [];
    const candidates = (matcher ? [...listed, ...ranked.filter((c) => !listed.includes(c))] : ranked).map((c) => ({ ...c, runOne: runOneLine(c, args.gh), ...(matcher ? { matcherOpinion: matcher.answers[c.fullName] ?? null } : {}) }));
    const out = { asOf, terms, termsDropped, searches: ran, partial, notRead, found, unread, ...(matcher ? { matcher: { model: matcher.model, version: matcher.version, host: matcher.host, unavailable: matcher.unavailable, stopped: matcher.stopped } } : {}), candidates, caveats: matcher ? [...CAVEATS, MATCHER_CAVEAT] : CAVEATS };
    return { code: partial ? 3 : 0, stdout: JSON.stringify(out, null, 2) + "\n", stderr: "" };
  }
  const text = formatReport({ asOf, searches: ran, candidates: scored, notRead, partial, terms, termsDropped, ghPath: args.gh, found, unread, nRead, partialKind: kind, matcher });
  return { code: partial ? 3 : 0, stdout: text + "\n", stderr: "" };
}

/** Run the whole thing, keywords only. `run` is the gh runner (real or fake), `now` is milliseconds. Returns { code, stdout, stderr }: nothing is printed here. */
export function runPriorArt(argv, opts) {
  const g = gather(argv, opts);
  if (g.result) return g.result;
  if (g.ctx.args.matcher) return { code: 2, stdout: "", stderr: "--matcher needs the asynchronous entry point (runPriorArtMatched)\n" };
  return render(g.ctx);
}

/**
 * The same, with the optional model-assisted matcher (only when --matcher was given; otherwise this is exactly runPriorArt). `ask` is an async
 * function task -> the model's text; `fetchImpl` is used only to read the model's version. `announce(text)` receives what is about to be sent, BEFORE any
 * question is asked. The matcher can only reorder: the candidates and their verdicts are the keyword run's, and any failure leaves the keyword report with a note.
 */
export async function runPriorArtMatched(argv, { ask, announce = () => {}, fetchImpl, ...opts }) {
  const g = gather(argv, opts);
  if (g.result) return g.result;
  const { ctx } = g, m = ctx.args.matcher;
  if (!m) return render(ctx);
  const candidates = shownOf(rank(ctx.scored));
  const send = describeSend({ description: ctx.args.description, candidates, model: m.model, host: m.host });
  if (m.dryRun) return { code: 0, stdout: `${send}\n\nThis was a dry run: no question was asked, and no model was contacted.\n`, stderr: "" };
  if (candidates.length === 0) return render(ctx); // nothing to ask about: no model call, no model opinion line
  announce(send);
  const version = await modelVersion({ host: m.host, model: m.model, fetchImpl });
  const r = await matchCandidates({ description: ctx.args.description, candidates, ask });
  return render(ctx, { model: m.model, host: m.host, version, ...r });
}
