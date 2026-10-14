import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY, makePolicy, extractTerms, overlap, scoreCandidate, rank, formatCandidate, formatReport } from "../src/priorart.mjs";

const NOW = Date.parse("2026-10-13T08:00:00Z");
const DAY = 86400000;
const ago = (d) => new Date(NOW - d * DAY).toISOString().replace(".000Z", "Z");
const TERMS = ["csv", "parser", "streaming", "rust"]; // 4 terms: 2 matched = 50%, 1 = 25%
const repo = (over = {}) => ({ id: 1, fullName: "acme/csvkit", url: "https://github.com/acme/csvkit", description: "csv parser", topics: [], license: "MIT", archived: false, fork: false, pushedAt: ago(10), openIssues: 3, defaultBranch: "main", ...over });
const hours = (n, h) => Array.from({ length: n }, () => h);
const facts = (over = {}) => ({ id: 1, fullName: "acme/csvkit", lastReleaseAt: null, contributors: { contributors: 5, bots: 0, commits: 40, atLeast: false }, response: { considered: 20, responded: 12, hours: hours(12, 10) }, ci: true, tests: true, treeTruncated: false, optin: { present: false }, apiCalls: 4, ...over });
const score = (r = repo(), f = facts(), policy = POLICY, terms = TERMS) => scoreCandidate({ repo: r, facts: f, terms, policy, now: NOW });
const verdict = (...a) => score(...a).verdict;

// ---- terms and overlap ----------------------------------------------------------------------------------------------------------------

test("extractTerms: lowercase words of three letters or more, stop words dropped, distinct, in order, at most eight", () => {
  assert.deepEqual(extractTerms("I want to build a Streaming CSV parser in Rust, and the CSV reader must be fast!"), ["streaming", "csv", "parser", "rust", "reader", "must", "fast"]);
  assert.deepEqual(extractTerms("a b to of it is 42 x2y oauth2"), ["oauth"]);
  assert.equal(extractTerms("one two three four five six seven eight nine ten eleven twelve").length, 8);
  for (const v of [undefined, null, 5, "", "   "]) assert.deepEqual(extractTerms(v), []);
  assert.deepEqual(extractTerms("x".repeat(60)), []);
});
test("overlap: whole words in the name, description or topics; a plural counts; a substring does not", () => {
  const o = overlap(["csv", "parser", "stream", "rust"], repo({ fullName: "acme/csv-kit", description: "Fast parsers", topics: ["streams", "data-tools"] }));
  assert.deepEqual([o.matched, o.of, o.fraction], [["csv", "parser", "stream"], 4, 0.75]);
  assert.deepEqual(overlap(["pars"], repo({ description: "parser" })).matched, [], "no substrings");
  assert.deepEqual(overlap(["csvs"], repo({ description: "a csv tool" })).matched, ["csvs"], "term with s, word without");
  assert.deepEqual(overlap([], repo()), { matched: [], of: 0, fraction: 0 });
  assert.equal(overlap(["x"], {}).fraction, 0);
});

// ---- policy ---------------------------------------------------------------------------------------------------------------------------

test("makePolicy: every threshold is in one frozen object; overrides are validated", () => {
  assert.ok(Object.isFrozen(POLICY));
  assert.equal(makePolicy({ maxAgeDays: 200 }).maxAgeDays, 200);
  assert.ok(Object.isFrozen(makePolicy()) && Object.isFrozen(makePolicy({ maxAgeDays: 5 })), "a policy cannot be edited after it is made");
  assert.equal(makePolicy().minContributors, 2);
  for (const bad of [{ nope: 1 }, { maxAgeDays: 0 }, { maxAgeDays: "365" }, { minContributors: NaN }, { contributeOverlap: 1.5 }, { closeOverlap: 0.6 }, { licenseOk: [] }, { licenseOk: ["MIT", "x y"] }, { licenseOk: "MIT" }, { maxSoftFailures: -1 }]) assert.throws(() => makePolicy(bad), Error, JSON.stringify(bad));
  assert.deepEqual(makePolicy({ licenseOk: ["MIT", "Apache-2.0"] }).licenseOk, ["MIT", "Apache-2.0"]);
});
test("changing a threshold changes the verdict at exactly the new boundary (one edit, one place)", () => {
  assert.equal(verdict(repo({ pushedAt: ago(200) })), "contribute");
  assert.equal(verdict(repo({ pushedAt: ago(200) }), facts(), makePolicy({ maxAgeDays: 199 })), "close");
  assert.equal(verdict(repo(), facts({ contributors: { contributors: 2, bots: 0, commits: 5, atLeast: false } }), makePolicy({ minContributors: 3 })), "close");
});

// ---- the boundaries -------------------------------------------------------------------------------------------------------------------

test("overlap boundaries: 50% contributes, just under is close, 25% is close, under 25% is no match", () => {
  const d = (n) => ["csv", "parser", "streaming", "rust"].slice(0, n).join(" ");
  assert.equal(verdict(repo({ description: d(2) })), "contribute");
  assert.equal(verdict(repo({ description: d(3) })), "contribute");
  assert.equal(verdict(repo({ description: d(1) })), "close");
  assert.equal(verdict(repo({ description: "unrelated" }), facts()), "no-match");
  assert.equal(verdict(repo({ description: d(2) }), facts(), POLICY, ["csv", "parser", "streaming", "rust", "extra"]), "close", "2 of 5 is 40%");
  assert.equal(verdict(repo({ description: d(2) }), facts(), POLICY, ["csv", "parser", "streaming"]), "contribute", "2 of 3 is above half");
});
test("age boundaries: 365 days passes, 366 is one soft failure (close), 730 is not skipped, 731 is skipped", () => {
  assert.equal(verdict(repo({ pushedAt: ago(365) })), "contribute");
  const old = score(repo({ pushedAt: ago(366) })); assert.equal(old.verdict, "close"); assert.match(old.failures.join(), /366 days/);
  assert.equal(verdict(repo({ pushedAt: ago(730) })), "close");
  const gone = score(repo({ pushedAt: ago(731) })); assert.equal(gone.verdict, "skip"); assert.match(gone.failures.join(), /731 days/);
});
test("contributors: the minimum passes, one below fails; a lower bound that falls short is unknown, never a failure", () => {
  const c = (n, atLeast = false) => facts({ contributors: { contributors: n, bots: 0, commits: n, atLeast } });
  assert.equal(verdict(repo(), c(2)), "contribute");
  const one = score(repo(), c(1)); assert.equal(one.verdict, "close"); assert.match(one.failures.join(), /1 contributor in the last year/);
  const bound = score(repo(), c(1, true)); assert.equal(bound.verdict, "close"); assert.deepEqual(bound.failures, []); assert.match(bound.unknowns.join(), /lower bound/);
  assert.equal(verdict(repo(), c(100, true)), "contribute", "a lower bound that already passes passes");
});
test("response: median and answer rate; fewer than 5 answered is unknown and does not block, a measured bad one does", () => {
  const r = (responded, h, considered = 20) => facts({ response: { considered, responded, hours: hours(responded, h) } });
  assert.equal(verdict(repo(), r(12, 336)), "contribute");
  assert.equal(verdict(repo(), r(12, 337)), "close");
  assert.equal(verdict(repo(), r(10, 10)), "contribute", "10 of 20 is exactly the minimum rate");
  assert.equal(verdict(repo(), r(9, 10)), "close", "9 of 20 is below it");
  const few = score(repo(), r(4, 10)); assert.equal(few.verdict, "contribute"); assert.match(few.unknowns.join(), /fewer than 5 answered/);
  const none = score(repo(), facts({ response: { considered: 20, responded: 0, hours: [] } })); assert.equal(none.verdict, "contribute");
  assert.equal(verdict(repo(), r(5, 10, 20)), "close", "5 answered of 20 is a 25% rate");
  assert.equal(verdict(repo(), facts({ response: { considered: 0, responded: 0, hours: [] } })), "contribute");
  const med = score(repo(), facts({ response: { considered: 6, responded: 6, hours: [1, 1, 1, 1000, 1000, 1000] } }));
  assert.equal(med.numbers.response.medianHours, 500.5);
});
test("soft failures: one is a close; two with a good match is a skip; two with a partial match is still close", () => {
  const twoBad = facts({ contributors: { contributors: 1, bots: 0, commits: 1, atLeast: false } });
  assert.equal(verdict(repo({ pushedAt: ago(400) }), twoBad), "skip");
  assert.equal(verdict(repo({ pushedAt: ago(400), description: "csv" }), twoBad), "close");
  assert.equal(verdict(repo({ pushedAt: ago(400) }), twoBad, makePolicy({ maxSoftFailures: 2 })), "close");
});
test("hard skips: archived, a license outside the list, and very old, whatever the match", () => {
  assert.equal(verdict(repo({ archived: true })), "skip");
  const lic = score(repo({ license: "GPL-3.0" }), facts(), makePolicy({ licenseOk: ["MIT", "Apache-2.0"] })); assert.equal(lic.verdict, "skip"); assert.match(lic.failures.join(), /GPL-3.0/);
  assert.equal(verdict(repo({ license: "MIT" }), facts(), makePolicy({ licenseOk: ["MIT"] })), "contribute");
  assert.equal(verdict(repo({ archived: true, description: "unrelated" })), "skip");
});

// ---- unknown is never good ------------------------------------------------------------------------------------------------------------

test("a candidate that was not read can be close at best, never contribute", () => {
  const s = score(repo(), null); assert.equal(s.verdict, "close"); assert.equal(s.read, false); assert.match(s.unknowns.join(), /contributors \(not read\)/);
  assert.equal(s.optin.status, "unknown");
});
test("no license, or one GitHub could not identify, blocks 'contribute' (it is unknown, not good); a license list does not rescue it", () => {
  for (const license of [null, "NOASSERTION"]) {
    const s = score(repo({ license })); assert.equal(s.verdict, "close", String(license)); assert.match(s.unknowns.join(), /license/);
    assert.equal(score(repo({ license }), facts(), makePolicy({ licenseOk: ["MIT"] })).verdict, "close", `${license} with a list`);
  }
});
test("every missing number blocks 'contribute' (except the response time, which is advisory) and none is counted as a failure", () => {
  const cases = { "no contributors": facts({ contributors: null }), "no facts": null };
  for (const [name, f] of Object.entries(cases)) { const s = score(repo(), f); assert.notEqual(s.verdict, "contribute", name); assert.deepEqual(s.failures, [], name); }
  const s = score(repo({ pushedAt: "nonsense" })); assert.notEqual(s.verdict, "contribute"); assert.match(s.unknowns.join(), /last push date/); assert.equal(s.numbers.ageDays, null);
});

// ---- opt-in ---------------------------------------------------------------------------------------------------------------------------

test("opt-in is reported plainly and never changes the verdict; paused or invalid is not an invitation", () => {
  const line = (optin) => score(repo(), facts({ optin })).optin;
  assert.equal(line({ present: false }).status, "none"); assert.match(line({ present: false }).text, /has not asked for AI contributions/);
  const yes = line({ present: true, valid: true, paused: false, intervalHours: 48, contact: "@maintainer", reviewBy: "2027-01-01" });
  assert.equal(yes.status, "yes"); assert.match(yes.text, /interval 48 hours, contact @maintainer/);
  assert.match(line({ present: true, valid: true, paused: true, intervalHours: 48, contact: "@m", reviewBy: "2027-01-01" }).text, /PAUSED: do not send/);
  assert.match(line({ present: true, valid: false, errors: ["review_by: the opt-in has expired"] }).text, /not valid or expired.*treat as not opted in/);
  assert.equal(verdict(repo(), facts({ optin: { present: true, valid: true, paused: true, intervalHours: 24, contact: "@m", reviewBy: "2027-01-01" } })), "contribute");
});

// ---- ranking and purity ---------------------------------------------------------------------------------------------------------------

test("rank: contribute before close before skip; opted in first; then overlap, recency, name; and it does not mutate its input", () => {
  const mk = (name, over, f) => scoreCandidate({ repo: repo({ fullName: name, url: `https://github.com/${name}`, ...over }), facts: f ?? facts(), terms: TERMS, policy: POLICY, now: NOW });
  const optedIn = facts({ optin: { present: true, valid: true, paused: false, intervalHours: 24, contact: "@m", reviewBy: "2027-01-01" } });
  const list = [mk("z/skip", { archived: true }), mk("b/close", { description: "csv" }), mk("a/plain", {}), mk("c/optin", {}, optedIn), mk("d/more", { description: "csv parser streaming" }), mk("e/newer", { pushedAt: ago(1) }), mk("a/same", {})];
  const copy = JSON.stringify(list);
  assert.deepEqual(rank(list).map((c) => c.fullName), ["c/optin", "d/more", "e/newer", "a/plain", "a/same", "b/close", "z/skip"]);
  assert.equal(JSON.stringify(list), copy);
});
test("pure: the same input gives the same output, and inputs may be frozen", () => {
  const deep = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deep(v); return Object.freeze(o); };
  const r = deep(repo()), f = deep(facts()), t = deep([...TERMS]);
  const a = scoreCandidate({ repo: r, facts: f, terms: t, policy: POLICY, now: NOW }), b = scoreCandidate({ repo: r, facts: f, terms: t, policy: POLICY, now: NOW });
  assert.deepEqual(a, b);
  assert.throws(() => scoreCandidate({ repo: r, facts: f, terms: t }), /now/);
  assert.throws(() => scoreCandidate({ repo: r, facts: f, terms: t, now: "today" }), /now/);
});

// ---- the report -----------------------------------------------------------------------------------------------------------------------

test("formatCandidate: the numbers line comes before the verdict line, and a missing number reads 'unknown'", () => {
  const text = formatCandidate(score(repo({ description: "csv parser" }), facts({ response: { considered: 20, responded: 3, hours: [1, 2, 3] }, tests: null, treeTruncated: true })), 1);
  const lines = text.split("\n");
  assert.match(lines[0], /^1\. acme\/csvkit {2}https:\/\/github\.com\/acme\/csvkit$/);
  assert.match(lines[1], /^ {3}numbers: MIT · pushed 2026-10-03 \(10d ago\) · 5 contributors\/yr · first reply median 2h \(3 of 20 answered\) · release none on GitHub · CI yes · tests unknown · overlap 50% \(csv, parser of 4 terms\)$/);
  assert.match(lines[2], /^ {3}verdict: contribute$/);
  assert.ok(lines.findIndex((l) => l.includes("numbers:")) < lines.findIndex((l) => l.includes("verdict:")));
  assert.match(lines[3], /unknown: first response time \(fewer than 5 answered\)/);
  assert.match(text, /opted in to Common AI: no \(no opt-in file/);
});
test("formatCandidate: failures are printed with their numbers; a lower bound shows a plus sign; no license says so", () => {
  const text = formatCandidate(score(repo({ license: null, pushedAt: ago(400) }), facts({ contributors: { contributors: 100, bots: 0, commits: 100, atLeast: true } })), 2);
  assert.match(text, /no license detected · pushed 2025-09-08 \(400d ago\) · 100\+ contributors\/yr/);
  assert.match(text, /verdict: close — last push 400 days ago \(limit 365\)/);
  assert.match(text, /unknown: license \(none detected\)/);
});
test("formatCandidate: text is cleaned again, so a caller that forgot cannot print an escape sequence", () => {
  const ESC = String.fromCharCode(27);
  const text = formatCandidate(score(repo({ fullName: "acme/x", description: `${ESC}[31mcsv parser\u202E`, license: `MIT${ESC}[0m` })), 1);
  assert.ok(!text.includes(ESC) && !text.includes("\u202E"), JSON.stringify(text));
  const named = formatCandidate(score(repo({ fullName: `acme/${ESC}[2Jx`, url: `https://github.com/${ESC}]0;t\u0007y` })), 1);
  assert.ok(!named.includes(ESC) && !named.includes("\u0007"), JSON.stringify(named));
});
test("formatReport: header, partial label, nothing-found line, honesty lines and the searches that ran", () => {
  const none = formatReport({ asOf: "2026-10-13T08:00Z", searches: ["q1", "q2"], candidates: [score(repo({ description: "unrelated" }))], notRead: 0 });
  assert.match(none.split("\n")[0], /^prior-art: 2 searches, 1 candidate scored {2}as of 2026-10-13T08:00Z$/);
  assert.match(none, /Nothing decent found\./); assert.match(none, /does not prove nothing better exists/); assert.match(none, /not a promise the project wants it/); assert.match(none, /Searches: q1 \| q2/);
  const some = formatReport({ asOf: "t", searches: ["q"], candidates: [score(repo()), score(repo({ fullName: "old/one", url: "https://github.com/old/one", archived: true }))], notRead: 2, partial: "GitHub request failed (HTTP 403)", found: 431 });
  assert.match(some.split("\n")[0], /2 candidates scored, 2 not read \(GitHub reports 431 matching repositories in all\) {3}\[PARTIAL\] {2}as of t$/);
  assert.match(some, /stopped early: GitHub request failed \(HTTP 403\)\. The result below is incomplete\./);
  assert.match(some, /1\. acme\/csvkit/); assert.match(some, /Skipped \(1\): old\/one \(archived\)/); assert.ok(!some.includes("Nothing decent found"));
});
test("formatReport never lists a skip or a no-match as a recommendation", () => {
  const out = formatReport({ asOf: "t", searches: ["q"], candidates: [score(repo({ archived: true })), score(repo({ description: "unrelated", fullName: "n/m", url: "https://github.com/n/m" }))] });
  assert.ok(!/^\d+\. /m.test(out)); assert.match(out, /Nothing decent found\./);
});
