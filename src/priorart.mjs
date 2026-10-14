/**
 * `prior-art` scoring and report (Goal 4, Q3). Pure functions: raw numbers in, a verdict and text out. No network, no clock (`now` is passed in),
 * no files. Every threshold lives in POLICY below (decision D2: the numbers are PROVISIONAL placeholders, to be decided from real runs).
 * The rule that matters most: a number that is missing is `null` and prints as "unknown". It is never scored as good, and it never counts as a failure either.
 */
import { clean } from "./ghsearch.mjs";

/** Provisional (D2). One object, so changing a default is a one-line edit. */
export const POLICY = Object.freeze({
  maxAgeDays: 365,            // last push older than this fails the age criterion
  skipAgeFactor: 2,           // ... and older than this many times it is skipped outright
  minContributors: 2,         // people with commits in the last year (among the latest 100 commits)
  contributeOverlap: 0.5,     // share of the description's terms found in the project's name, description and topics
  closeOverlap: 0.25,
  minResponseSamples: 5,      // fewer answered items than this and the response time is unknown
  responseMaxHours: 336,      // median hours to first reply (14 days)
  minResponseRate: 0.5,       // share of the last 20 closed items that got a reply at all
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

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Which of the terms appear as whole words (or a plural with an s) in the name, description or topics. Crude on purpose, and it shows its work. */
export function overlap(terms, repo) {
  const bag = new Set([...words(repo?.fullName), ...words(repo?.description), ...(repo?.topics ?? []).flatMap(words)]);
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
  num("maxAgeDays", 1, 3650); num("skipAgeFactor", 1, 10); num("minContributors", 1, 1000); num("contributeOverlap", 0, 1); num("closeOverlap", 0, 1);
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
  const ov = overlap(terms, repo);
  const failures = [], unknowns = [], notes = [];
  const ageDays = Number.isFinite(Date.parse(repo.pushedAt)) ? Math.floor((now - Date.parse(repo.pushedAt)) / 86400000) : null;
  const license = repo.license ?? null;
  const licenseKnown = license !== null && license !== "NOASSERTION";

  // contributors: a lower bound that fails the minimum proves nothing, so it is unknown
  const c = facts?.contributors ?? null;
  let contributors = null;
  if (c) contributors = c.contributors >= policy.minContributors ? { count: c.contributors, atLeast: c.atLeast, ok: true } : c.atLeast ? null : { count: c.contributors, atLeast: false, ok: false };
  // response: only items that got a reply have a time; the rate says how many did
  const r = facts?.response ?? null;
  let response = null;
  if (r && r.responded >= policy.minResponseSamples && r.considered > 0) {
    const med = median(r.hours), rate = r.responded / r.considered;
    response = { medianHours: med, responded: r.responded, considered: r.considered, rate, ok: med <= policy.responseMaxHours && rate >= policy.minResponseRate };
  }
  const numbers = {
    license, pushedAt: repo.pushedAt, ageDays, archived: repo.archived, openIssues: repo.openIssues,
    contributors: c ? { count: c.contributors, atLeast: c.atLeast } : null,
    response: r ? { considered: r.considered, responded: r.responded, medianHours: r.responded > 0 ? median(r.hours) : null } : null,
    lastReleaseAt: facts ? facts.lastReleaseAt : null, ci: facts ? facts.ci : null, tests: facts ? facts.tests : null,
  };

  const base = { fullName: repo.fullName, url: repo.url, description: repo.description, overlap: ov, numbers, failures, unknowns, notes, optin: optinLine(facts?.optin ?? null), read: facts !== null };
  const done = (verdict) => ({ ...base, verdict });

  // ---- skip: things no amount of matching rescues
  if (repo.archived === true) { failures.push("archived"); return done("skip"); }
  if (policy.licenseOk && licenseKnown && !policy.licenseOk.includes(license)) { failures.push(`license ${license} is outside your list`); return done("skip"); }
  if (ageDays !== null && ageDays > policy.maxAgeDays * policy.skipAgeFactor) { failures.push(`last push ${ageDays} days ago`); return done("skip"); }
  if (ov.fraction < policy.closeOverlap) return done("no-match");

  // ---- the measured criteria
  if (ageDays === null) unknowns.push("last push date"); else if (ageDays > policy.maxAgeDays) failures.push(`last push ${ageDays} days ago (limit ${policy.maxAgeDays})`);
  if (contributors === null) unknowns.push(facts ? "contributors (only a lower bound)" : "contributors (not read)"); else if (!contributors.ok) failures.push(`${contributors.count} contributor${contributors.count === 1 ? "" : "s"} in the last year (minimum ${policy.minContributors})`);
  if (response === null) unknowns.push(facts ? `first response time (fewer than ${policy.minResponseSamples} answered)` : "first response time (not read)");
  else if (!response.ok) failures.push(`slow or missing replies (median ${fmtHours(response.medianHours)}, ${response.responded} of ${response.considered} answered)`);
  if (!licenseKnown) unknowns.push(license === null ? "license (none detected)" : "license (GitHub could not identify it)");
  if (facts?.optin && facts.optin.present && !facts.optin.valid) notes.push("opt-in file present but not valid");

  // Response time is advisory when unknown (small projects often have too few closed items), so it does not block "contribute" by itself.
  const blocking = unknowns.filter((u) => !u.startsWith("first response time"));
  if (ov.fraction >= policy.contributeOverlap) {
    if (failures.length === 0 && blocking.length === 0) return done("contribute");
    return done(failures.length <= policy.maxSoftFailures ? "close" : "skip");
  }
  return done("close");
}

function optinLine(o) {
  if (!o) return { status: "unknown", text: "opt-in not checked" };
  if (!o.present) return { status: "none", text: "opted in to Common AI: no (no opt-in file: this project has not asked for AI contributions; contributing here means ordinary human-submitted work)" };
  if (!o.valid) return { status: "invalid", text: `opt-in file present but not valid or expired (${(o.errors ?? []).join("; ")}): treat as not opted in` };
  if (o.paused) return { status: "paused", text: "opt-in file present but PAUSED: do not send AI contributions here" };
  return { status: "yes", text: `opted in to Common AI: yes (interval ${o.intervalHours} hours, contact ${o.contact}, review by ${o.reviewBy})` };
}

const order = { contribute: 0, close: 1, skip: 2, "no-match": 3 };
/** Deterministic: verdict, then opted-in first, then overlap, then most recent push, then name. */
export function rank(list) {
  return [...list].sort((a, b) => order[a.verdict] - order[b.verdict] || (b.optin.status === "yes") - (a.optin.status === "yes") || b.overlap.fraction - a.overlap.fraction || String(b.numbers.pushedAt).localeCompare(String(a.numbers.pushedAt)) || a.fullName.localeCompare(b.fullName));
}

// ---- the report ------------------------------------------------------------------------------------------------------------------------

const fmtHours = (h) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const yn = (v) => (v === null || v === undefined ? "unknown" : v ? "yes" : "no");
const pct = (f) => `${Math.round(f * 100)}%`;
const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "unknown");

/** Numbers first, then the verdict. Every string is cleaned again here, so a caller that forgot cannot print an escape sequence. */
export function formatCandidate(c, i) {
  const n = c.numbers;
  const contributors = n.contributors ? `${n.contributors.count}${n.contributors.atLeast ? "+" : ""} contributors/yr` : "contributors unknown";
  const response = n.response && n.response.responded > 0 ? `first reply median ${fmtHours(n.response.medianHours)} (${n.response.responded} of ${n.response.considered} answered)` : n.response ? `no replies seen in ${n.response.considered} closed items` : "first reply unknown";
  const lines = [
    `${i}. ${clean(c.fullName, 120)}  ${clean(c.url, 160)}`,
    `   numbers: ${n.license ? clean(n.license, 40) : "no license detected"} · pushed ${day(n.pushedAt)}${n.ageDays !== null ? ` (${n.ageDays}d ago)` : ""} · ${contributors} · ${response} · release ${n.lastReleaseAt ? day(n.lastReleaseAt) : "none on GitHub"} · CI ${yn(n.ci)} · tests ${yn(n.tests)} · overlap ${pct(c.overlap.fraction)} (${c.overlap.matched.map((t) => clean(t, 40)).join(", ") || "none"} of ${c.overlap.of} terms)`,
    `   verdict: ${c.verdict}${c.failures.length ? ` — ${c.failures.map((x) => clean(x, 120)).join("; ")}` : ""}`,
  ];
  if (c.unknowns.length) lines.push(`   unknown: ${c.unknowns.map((x) => clean(x, 80)).join("; ")}`);
  if (c.notes.length) lines.push(`   note: ${c.notes.map((x) => clean(x, 120)).join("; ")}`);
  lines.push(`   ${clean(c.optin.text, 400)}`);
  if (c.description) lines.push(`   "${clean(c.description, 160)}"`);
  return lines.join("\n");
}

/**
 * The whole report. `searches` are the query strings that ran; `notRead` candidates were found but their details were not read;
 * `partial` carries the reason a run stopped early (a rate limit, an HTTP error). Only contribute / close are listed.
 */
export function formatReport({ asOf, searches, candidates, notRead = 0, partial = null, found = null }) {
  const ranked = rank(candidates), shown = ranked.filter((c) => c.verdict === "contribute" || c.verdict === "close");
  const head = `prior-art: ${searches.length} search${searches.length === 1 ? "" : "es"}, ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} scored${notRead ? `, ${notRead} not read` : ""}${found !== null ? ` (GitHub reports ${found} matching repositories in all)` : ""}${partial ? "   [PARTIAL]" : ""}  as of ${asOf}`;
  const out = [head];
  if (partial) out.push(`stopped early: ${clean(partial, 160)}. The result below is incomplete.`);
  if (shown.length === 0) out.push("Nothing decent found.");
  shown.forEach((c, i) => out.push("", formatCandidate(c, i + 1)));
  const skipped = ranked.filter((c) => c.verdict === "skip");
  if (skipped.length) out.push("", `Skipped (${skipped.length}): ${skipped.map((c) => `${clean(c.fullName, 80)} (${clean(c.failures[0] ?? "several criteria fail", 60)})`).join("; ")}`);
  out.push("", "This is keyword matching on names, descriptions and topics, not understanding, and it does not prove nothing better exists.", "A recommendation to contribute is not a promise the project wants it.", `Searches: ${searches.map((s) => clean(s, 200)).join(" | ")}`);
  return out.join("\n");
}
