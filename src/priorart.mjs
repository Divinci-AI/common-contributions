/**
 * `prior-art` scoring and report (Goal 4, Q3). Pure functions: raw numbers in, a verdict and text out. No network, no clock (`now` is passed in),
 * no files. Every threshold lives in POLICY below (decision D2: the numbers are PROVISIONAL placeholders, to be decided from real runs).
 * The rule that matters most: a number that is missing is `null` and prints as "unknown". It is never scored as good, and it never counts as a failure either.
 */
import { clean } from "./ghsearch.mjs";
import { reorder } from "./matcher.mjs";

/** Provisional (D2). One object, so changing a default is a one-line edit. */
export const POLICY = Object.freeze({
  maxAgeDays: 365,            // last push older than this fails the age criterion
  skipAgeFactor: 2,           // ... and older than this many times it is skipped outright
  minContributors: 2,         // people with commits in the last year (among the latest 100 commits)
  contributeOverlap: 0.5,     // share of the description's terms found in the project's name, description and topics
  closeOverlap: 0.25,
  minResponseSamples: 5,      // fewer answered items than this and the response time is unknown
  responseMaxHours: 336,      // median hours to first reply (14 days)
  minResponseRate: 0.25, // share of the last 20 closed items that got a reply at all (0.25 from the 2026-10-15 calibration: big healthy projects close by merging, without a comment)
  maxSoftFailures: 1,         // age, contributors and response are the soft criteria; more failures than this with a good match is a skip
  licenseOk: null,            // null = no restriction; otherwise a list of SPDX ids
});

const STOP = new Set("the and for with that this from into over under onto using use used uses are was were been being have has had can could would should will want wants need needs like make makes made build building built get gets give gives let lets our their your its not but all any some more most much many very just also than then them they you who what when where which how why out off new one two per via etc own able".split(" "));

/** Up to 8 distinct lowercase words of 3+ letters, in order of first appearance, minus stop words. Words are split on anything that is not a letter. */
export function extractTerms(description, max = 8) {
  if (typeof description !== "string") return [];
  const out = [];
  for (const w of description.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3 || w.length > 40 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length === max) break;
  }
  return out;
}

// Both splits, so "oauth2" is found by the term "oauth" (terms are letters only) and by "oauth2".
const words = (s) => { const l = String(s ?? "").toLowerCase(); return [...new Set([...l.split(/[^a-z0-9]+/), ...l.split(/[^a-z]+/)])].filter(Boolean); };

/** Which of the terms appear as whole words (or a plural with an s) in the repository's name (not its owner), description or topics. Crude on purpose, and it shows its work. */
export function overlap(terms, repo) {
  const bag = new Set([...words(String(repo?.fullName ?? "").split("/").slice(1).join("/")), ...words(repo?.description), ...(repo?.topics ?? []).flatMap(words)]);
  const matched = terms.filter((t) => bag.has(t) || bag.has(t + "s") || (t.endsWith("s") && bag.has(t.slice(0, -1))));
  return { matched, of: terms.length, fraction: terms.length === 0 ? 0 : matched.length / terms.length };
}

/** Validated policy: unknown keys, wrong types and out-of-range values throw. */
export function makePolicy(overrides = {}) {
  const p = { ...POLICY };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in POLICY)) throw new Error(`unknown policy setting: ${String(k).slice(0, 40)}`);
    p[k] = v;
  }
  const num = (k, lo, hi) => { if (!Number.isFinite(p[k]) || p[k] < lo || p[k] > hi) throw new Error(`policy ${k}: a number from ${lo} to ${hi}`); };
  num("maxAgeDays", 1, 3650); num("skipAgeFactor", 1, 10); num("minContributors", 1, 1000); num("contributeOverlap", 0.01, 1); num("closeOverlap", 0.01, 1);
  num("minResponseSamples", 1, 20); num("responseMaxHours", 1, 24 * 365); num("minResponseRate", 0, 1); num("maxSoftFailures", 0, 3);
  if (p.closeOverlap > p.contributeOverlap) throw new Error("policy: closeOverlap cannot exceed contributeOverlap");
  if (p.licenseOk !== null && !(Array.isArray(p.licenseOk) && p.licenseOk.length > 0 && p.licenseOk.length <= 50 && p.licenseOk.every((x) => typeof x === "string" && /^[A-Za-z0-9.+-]{1,40}$/.test(x)))) throw new Error("policy licenseOk: null or a list of SPDX ids");
  return Object.freeze(p);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Score one candidate. `repo` is a searchRepos item; `facts` is createSearch().facts(...) or null when the candidate was not read.
 * Verdicts: contribute | close | skip | no-match. `unknowns` lists what could not be said; `failures` what was measured and failed.
 */
export function scoreCandidate({ repo, facts = null, terms, policy = POLICY, now }) {
  if (!Number.isFinite(now)) throw new Error("scoreCandidate needs `now` (milliseconds)");
  if (!repo || typeof repo !== "object" || typeof repo.fullName !== "string") throw new Error("scoreCandidate needs a repo with a fullName");
  const ov = overlap(terms, repo);
  const failures = [], unknowns = [], notes = [];
  const pushed = Date.parse(repo.pushedAt);
  let ageDays = Number.isFinite(pushed) ? Math.floor((now - pushed) / 86400000) : null;
  if (ageDays !== null && ageDays < 0) ageDays = ageDays >= -1 ? 0 : null; // a day of clock skew is fine; a date further in the future is unknown, not "very fresh"
  const license = repo.license ?? null;
  const licenseKnown = license !== null && license !== "NOASSERTION";
  const inList = (list) => list.some((x) => x.toLowerCase() === String(license).toLowerCase()); // SPDX ids are not case-sensitive

  // A pure function that promises "unknown is never scored" does not score malformed numbers either: they become unknown.
  const count = (v) => Number.isInteger(v) && v >= 0;
  const cRaw = facts?.contributors ?? null;
  const c = cRaw && count(cRaw.contributors) && typeof cRaw.atLeast === "boolean" ? cRaw : null;
  // contributors: a lower bound that fails the minimum proves nothing, so it is unknown
  let contributors = null;
  // Authors GitHub could not link to an account may be one person under two addresses, so they cannot carry the count over the minimum.
  const solid = c ? c.contributors - (Number.isInteger(c.unlinked) && c.unlinked >= 0 && c.unlinked <= c.contributors ? c.unlinked : 0) : 0;
  const unlinkedDoubt = c !== null && c.contributors >= policy.minContributors && solid < policy.minContributors;
  if (c) contributors = unlinkedDoubt ? null : c.contributors >= policy.minContributors ? { count: c.contributors, atLeast: c.atLeast, ok: true } : c.atLeast ? null : { count: c.contributors, atLeast: false, ok: false };
  const rRaw = facts?.response ?? null;
  const r = rRaw && count(rRaw.considered) && count(rRaw.responded) && rRaw.responded <= rRaw.considered && Array.isArray(rRaw.hours) && rRaw.hours.length === rRaw.responded && rRaw.hours.every((h) => Number.isFinite(h) && h >= 0) ? rRaw : null;
  // response: two separate measurements. The answer RATE needs enough closed items; the MEDIAN needs enough answered ones.
  // (Gating both on answered items would score "0 of 20 ever got a reply" as unknown, the best possible reading of the worst case.)
  let response = null;
  if (r) {
    const rateMeasured = r.considered >= policy.minResponseSamples, medMeasured = r.responded >= policy.minResponseSamples;
    if (rateMeasured || medMeasured) {
      const med = r.responded > 0 ? median(r.hours) : null;
      response = { medianHours: med, responded: r.responded, considered: r.considered, medMeasured, ok: (!rateMeasured || r.responded / r.considered >= policy.minResponseRate) && (!medMeasured || med <= policy.responseMaxHours) };
    }
  }
  const numbers = {
    license, pushedAt: repo.pushedAt, ageDays, archived: repo.archived, openIssues: repo.openIssues,
    contributors: c ? { count: c.contributors, atLeast: c.atLeast } : null,
    response: r ? { considered: r.considered, responded: r.responded, medianHours: r.responded > 0 ? median(r.hours) : null } : null,
    lastReleaseAt: facts ? facts.lastReleaseAt : null, ci: facts ? facts.ci : null, tests: facts ? facts.tests : null,
  };

  const optin = optinLine(facts?.optin ?? null);
  if (optin.status === "paused") notes.push("this verdict rates the project; its opt-in is PAUSED, so do not send AI contributions");
  const base = { fullName: repo.fullName, url: repo.url, description: repo.description, overlap: ov, numbers, failures, unknowns, notes, optin, read: facts !== null };
  const done = (verdict) => ({ ...base, verdict });

  // ---- skip: things no amount of matching rescues
  if (repo.archived === true) { failures.push("archived"); return done("skip"); }
  if (repo.fork === true) { failures.push("a fork (contribute to the original)"); return done("skip"); }
  if (policy.licenseOk && licenseKnown && !inList(policy.licenseOk)) { failures.push(`license ${license} is outside your list`); return done("skip"); }
  if (ageDays !== null && ageDays > policy.maxAgeDays * policy.skipAgeFactor) { failures.push(`last push ${ageDays} days ago`); return done("skip"); }
  if (ov.fraction < policy.closeOverlap) return done("no-match");

  // ---- the measured criteria
  if (typeof repo.archived !== "boolean") unknowns.push("archived status");
  // A project not pushed to for a year has no commits in that year either: that is one cause, so it is one failure.
  const silent = c !== null && c.contributors === 0 && !c.atLeast;
  const aged = ageDays !== null && ageDays > policy.maxAgeDays;
  if (ageDays === null) unknowns.push("last push date"); else if (aged) failures.push(`last push ${ageDays} days ago (limit ${policy.maxAgeDays})${silent ? ", and no commits in the last year" : ""}`);
  if (contributors === null) unknowns.push(!facts ? "contributors (not read)" : unlinkedDoubt ? "contributors (some authors are not linked to accounts and may be counted twice)" : c ? "contributors (only a lower bound)" : "contributors (not available)");
  else if (!contributors.ok && !(aged && silent)) failures.push(`${contributors.count} contributor${contributors.count === 1 ? "" : "s"} in the last year (minimum ${policy.minContributors})`);
  if (response === null) unknowns.push(!facts ? "first response time (not read)" : `first response time (fewer than ${policy.minResponseSamples} closed items seen)`);
  else if (!response.ok) failures.push(`slow or missing replies (${response.responded} of ${response.considered} answered${response.medMeasured ? `, median ${fmtHours(response.medianHours)}` : ""})`);
  if (!licenseKnown) unknowns.push(license === null ? "license (none detected)" : "license (GitHub could not identify it; check the LICENSE file yourself)");
  if (facts?.optin && facts.optin.present && !facts.optin.valid) notes.push("opt-in file present but not valid");

  // Two independent readings, and the verdict is the worse of them, so a better keyword match can never give a worse verdict:
  // how well it matches, and how healthy it looks. Response time is advisory when unknown (small projects often have too few closed items).
  const blocking = unknowns.filter((u) => !u.startsWith("first response time"));
  const match = ov.fraction >= policy.contributeOverlap ? "contribute" : "close";
  const health = failures.length === 0 && blocking.length === 0 ? "contribute" : failures.length <= policy.maxSoftFailures ? "close" : "skip";
  return done(order[match] >= order[health] ? match : health);
}

function optinLine(o) {
  if (!o) return { status: "unknown", text: "opt-in not checked" };
  if (!o.present) return { status: "none", text: "opted in to Common AI: no (no opt-in file: this project has not asked for AI contributions; contributing here means ordinary human-submitted work)" };
  if (!o.valid) return { status: "invalid", text: `opt-in file present but not valid or expired (${(o.errors ?? []).join("; ")}): treat as not opted in` };
  if (o.paused) return { status: "paused", text: "opt-in file present but PAUSED: do not send AI contributions here" };
  return { status: "yes", text: `opted in to Common AI: yes (interval ${o.intervalHours} hours, contact ${o.contact}, review by ${o.reviewBy})` };
}

const order = { contribute: 0, close: 1, skip: 2, "no-match": 3 };
const when = (c) => { const t = Date.parse(c.numbers.pushedAt); return Number.isFinite(t) ? t : -Infinity; };
const cmpNewer = (a, b) => (when(b) > when(a)) - (when(b) < when(a)); // newer first; an unknown date sorts last, never first
/** Deterministic: verdict, then opted-in first, then overlap, then most recent push, then name. */
export function rank(list) {
  return [...list].sort((a, b) => order[a.verdict] - order[b.verdict] || (b.optin.status === "yes") - (a.optin.status === "yes") || b.overlap.fraction - a.overlap.fraction || cmpNewer(a, b) || a.fullName.localeCompare(b.fullName));
}

// ---- the report ------------------------------------------------------------------------------------------------------------------------

const fmtHours = (h) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const yn = (v) => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");
const pct = (f) => `${Math.round(f * 100)}%`;
const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "unknown");

const SLUG = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const shellWord = (w) => (/^[A-Za-z0-9_\/.@+:-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
/**
 * The command a person could run to start work on a project that has a valid, unpaused opt-in file, or null. NOTHING is run by prior-art.
 * The CAPITAL words are the person's own (their issues file, the issue, their clone, their model). They are plain words, not <brackets>: brackets are
 * shell redirections, and a person who edited only some of them would have run the command with stdin and stdout redirected.
 * Only for contribute and close; a skipped or unrelated project never gets a line. `ghPath` is the absolute gh the person gave.
 */
export function runOneLine(c, ghPath) {
  if (!c || (c.verdict !== "contribute" && c.verdict !== "close") || c.optin?.status !== "yes") return null;
  if (typeof c.fullName !== "string" || !SLUG.test(c.fullName) || c.fullName.split("/").some((x) => x === "." || x === "..")) return null;
  if (typeof ghPath !== "string" || !ghPath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(ghPath)) return null;
  const line = `node src/cli.mjs run-one ISSUES_JSON ISSUE_NUMBER --repo YOUR_CLONE_OF_${c.fullName.split("/")[1].replace(/[^A-Za-z0-9]/g, "_").toUpperCase()} --model OLLAMA_MODEL --github ${c.fullName} --gh ${shellWord(ghPath)}`;
  return clean(line, 2000) === line ? line : null; // printed exactly or not at all: a line that had to be altered to be shown could run differently
}

/** Said by every report, in either form. */
export const CAVEATS = ["This is keyword matching on names, descriptions and topics, not understanding, and it does not prove nothing better exists.", "A recommendation to contribute is not a promise the project wants it."];

export const MATCHER_CAVEAT = "A model's opinion of relevance can be wrong; the verdicts above are the keyword verdicts, and no candidate was hidden or added by the model.";
const label = (m) => `${clean(m.model, 100)}${m.version ? `, ${clean(m.version, 20)}` : ""}`;
/** The line under a candidate: the model's answer, labelled as opinion, or a plain "unavailable". Never a number. */
export const opinionLine = (m, c) => (m.answers[c.fullName] ? `model opinion (${label(m)}): ${{ yes: "the same kind of project", partly: "partly the same kind of project", no: "a different kind of project" }[m.answers[c.fullName]]}` : `model opinion (${label(m)}): unavailable for this candidate`);
const matcherHeader = (m, n) => [
  `matcher: ${label(m)}, on this machine (${clean(m.host, 60)}). The list below is ordered by that model's opinion of "same kind of project", then by the keyword order; verdicts and numbers are unchanged.`,
  ...(m.unavailable.length ? [`matcher unavailable for ${m.unavailable.length} of ${n} candidate${n === 1 ? "" : "s"}${m.stopped ? " (the model stopped answering, so the rest were not asked)" : ""}; those keep their keyword position.`] : []),
];

/** Numbers first, then the verdict. Every string is cleaned again here, so a caller that forgot cannot print an escape sequence. */
export function formatCandidate(c, i, { ghPath = null, opinion = null } = {}) {
  const n = c.numbers;
  const contributors = n.contributors ? `${n.contributors.count}${n.contributors.atLeast ? "+" : ""} commit author${n.contributors.count === 1 && !n.contributors.atLeast ? "" : "s"} in the last year` : "commit authors unknown";
  const response = n.response && n.response.responded > 0 ? `first non-author reply median ${fmtHours(n.response.medianHours)} (${n.response.responded} of ${n.response.considered} answered)` : n.response && n.response.considered === 0 ? "no closed issues or PRs found to measure (or the lookup came back empty)" : n.response ? `no replies seen in ${n.response.considered} closed item${n.response.considered === 1 ? "" : "s"}` : "first reply unknown";
  const lines = [
    `${i}. ${clean(c.fullName, 120)}  ${clean(c.url, 160)}`,
    `   numbers: ${n.license ? clean(n.license, 40) : "no license detected"} · pushed ${day(n.pushedAt)}${n.ageDays !== null ? ` (${n.ageDays}d ago)` : ""} · ${contributors} · ${response} · release ${!c.read ? "unknown (not read)" : n.lastReleaseAt ? day(n.lastReleaseAt) : "none on GitHub"} · CI ${yn(n.ci)} · tests ${yn(n.tests)} · overlap ${pct(c.overlap.fraction)} (${c.overlap.matched.map((t) => clean(t, 40)).join(", ") || "none"} of ${c.overlap.of} terms)`,
    `   verdict: ${c.verdict}${c.failures.length ? ` — ${c.failures.map((x) => clean(x, 120)).join("; ")}` : ""}`,
  ];
  if (opinion) lines.push(`   ${clean(opinion, 200)}`);
  if (c.unknowns.length) lines.push(`   unknown: ${c.unknowns.map((x) => clean(x, 80)).join("; ")}`);
  if (c.notes.length) lines.push(`   note: ${c.notes.map((x) => clean(x, 120)).join("; ")}`);
  lines.push(`   ${clean(c.optin.text, 400)}`);
  const start = runOneLine(c, ghPath);
  if (start) lines.push("   to start (nothing is run for you; replace the CAPITAL words, pick an issue the maintainer labelled for agents, and keep to their interval):", `   ${start}`);
  if (c.description) lines.push(`   "${clean(c.description, 160)}"`);
  return lines.join("\n");
}

/**
 * The whole report. `searches` are the query strings that ran; `notRead` candidates were found but their details were not read;
 * `partial` carries the reason a run stopped early (a rate limit, an HTTP error). Only contribute / close are listed.
 */
export function formatReport({ asOf, searches, candidates, notRead = 0, partial = null, found = null, terms = null, termsDropped = 0, ghPath = null, unread = [], nRead = null, partialKind = "stopped", matcher = null }) {
  const ranked = rank(candidates), shown = ranked.filter((c) => c.verdict === "contribute" || c.verdict === "close");
  const head = `prior-art: ${searches.length} search${searches.length === 1 ? "" : "es"}, ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} scored${notRead ? `, ${notRead} not read` : ""}${found !== null && found > candidates.length + notRead ? ` (the broadest search matched ${found} repositories on GitHub; only the top results of each search were looked at)` : ""}${partial ? "   [PARTIAL]" : ""}  as of ${asOf}`;
  const out = [head];
  if (matcher) out.push(...matcherHeader(matcher, shown.length));
  if (partial) out.push(`${partialKind === "skipped" ? "some candidates were skipped" : "stopped early"}: ${clean(partial, 300)}. The result below is incomplete.`);
  if (terms) out.push(`matched on: ${terms.map((t) => clean(t, 40)).join(", ")}${termsDropped > 0 ? ` (${termsDropped} more word${termsDropped === 1 ? "" : "s"} in your description were not used)` : ""}${terms.length <= 2 ? `; only ${terms.length} searchable word${terms.length === 1 ? "" : "s"}, so matches are broad` : ""}`);
  if (shown.length === 0) out.push(nRead === 0 && (partial || notRead) ? "No candidate details were read, so nothing could be judged." : partial || notRead ? "Nothing decent found among the candidates that were read." : "Nothing decent found.");
  if (unread.length) out.push(`Found but not read: ${unread.slice(0, 10).map((u) => clean(u, 80)).join(", ")}${unread.length > 10 ? ` and ${unread.length - 10} more` : ""}`);
  const listed = matcher ? reorder(shown, matcher.answers) : shown;
  listed.forEach((c, i) => out.push("", formatCandidate(c, i + 1, { ghPath, opinion: matcher ? opinionLine(matcher, c) : null })));
  const skipped = ranked.filter((c) => c.verdict === "skip");
  if (skipped.length) out.push("", `Skipped (${skipped.length}): ${skipped.map((c) => `${clean(c.fullName, 80)} (${clean(c.failures.join("; ") || "several criteria fail", 110)})`).join("; ")}`);
  out.push("", ...CAVEATS, ...(matcher ? [MATCHER_CAVEAT] : []), `Searches: ${searches.map((s) => clean(s, 200)).join(" | ")}`);
  return out.join("\n");
}
