import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPriorArt, parseArgs, readOnly, rarest, fitTerms, MAX_SEARCHES } from "../src/priorartcmd.mjs";
import { GhError } from "../src/ghclient.mjs";
import { defaultWorld, fakeRunner } from "./fakegh.mjs";

const NOW = Date.parse("2026-10-13T08:00:00Z");
const GH = "/usr/bin/fake-gh";
const sha = (i) => i.toString(16).padStart(40, "0");
const item = (id, full, description, over = {}) => ({ id, full_name: full, html_url: `https://github.com/${full}`, description, topics: ["csv", "parser"], license: { spdx_id: "MIT" }, archived: false, fork: false, private: false, pushed_at: "2026-09-30T10:00:00Z", open_issues_count: 12, default_branch: "main", ...over });
const reply = (created, login) => ({ createdAt: created, author: { login, __typename: "User" } });
const answered = (n) => Array.from({ length: n }, (_, i) => ({ __typename: "Issue", createdAt: `2026-09-0${i + 1}T00:00:00Z`, author: { login: "alice", __typename: "User" }, comments: { nodes: [reply(`2026-09-0${i + 1}T04:00:00Z`, "maint")] } }));
const healthy = { release: { published_at: "2026-08-01T00:00:00Z" }, recentCommits: [1, 2, 3].map((i) => ({ sha: sha(i), author: { id: i, type: "User" }, commit: { author: { email: `p${i}@x.org` } } })), searchNodes: answered(8), tree: { truncated: false, tree: [{ path: "test", type: "tree" }, { path: ".github/workflows/ci.yml", type: "blob" }] } };

/** A world where the per-repository answers depend on which repository is asked about (the fake answers for only one at a time). */
function build(items, data = {}, mod) {
  const w = defaultWorld();
  w.repoSearch = { total_count: items.length, incomplete_results: false, items };
  mod?.(w);
  const fake = fakeRunner(w), byId = {}, byName = {};
  for (const it of items) { const d = data[it.id] ?? healthy; byId[it.id] = { id: it.id, full: it.full_name, d }; byName[it.full_name] = byId[it.id]; }
  const run = (args) => {
    const joined = args.join(" ");
    const m = /\/repositories\/(\d+)\//.exec(joined), g = /repo:([\w.-]+\/[\w.-]+)/.exec(joined);
    const spec = (m && byId[m[1]]) || (g && byName[g[1]]);
    if (spec) Object.assign(w, { release: null, recentCommits: [], tree: null, searchNodes: [] }, spec.d, { repo: { ...w.repo, id: spec.id, full_name: spec.full } });
    return fake(args);
  };
  return { w, run };
}
const go = (argv, b) => runPriorArt(argv, { run: b.run, now: NOW });
const D = "streaming csv parser";
const A = (extra = []) => [D, "--gh", GH, ...extra];
const searchCalls = (w) => w.calls.filter((c) => c.includes("/search/repositories")).length;

const THREE = [
  item(5001, "acme/csvkit", "Fast streaming CSV parser"),
  item(5002, "acme/tabular", "Parser for tables", { topics: ["tables"] }),   // 1 of 3 terms -> 33% -> close
  item(5003, "acme/unrelated", "A todo list app", { topics: [] }),             // no match: never read
  item(5004, "acme/oldcsv", "Streaming CSV parser", { archived: true }),       // skipped: never read
];

// ---- the happy path ------------------------------------------------------------------------------------------------------------------

test("a normal run: one search for a short description, reads only what could matter, verdicts and the standing caveats are printed", () => {
  const b = build(THREE);
  const r = go(A(), b);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /prior-art: 1 search, 4 candidates scored/);
  assert.match(r.stdout, /1\. acme\/csvkit/);
  assert.match(r.stdout, /verdict: contribute/);
  assert.match(r.stdout, /verdict: close/);
  assert.match(r.stdout, /Skipped \(1\): acme\/oldcsv \(archived\)/);
  assert.match(r.stdout, /does not prove nothing better exists/);
  assert.match(r.stdout, /not a promise the project wants it/);
  assert.doesNotMatch(r.stdout, /PARTIAL/);
  assert.equal(searchCalls(b.w), 1);
  assert.match(r.stdout, /as of 2026-10-13T08:00Z\n/);
  assert.ok(b.w.calls.some((c) => c.includes("/commits?since=2025-10-13T08%3A00%3A00Z")), "contributors are counted over the last 365 days");
  assert.match(r.stdout, /^matched on: streaming, csv, parser$/m);
  assert.ok(!b.w.calls.some((c) => c.includes("/repositories/5003/") || c.includes("/repositories/5004/") || c.includes("acme/unrelated") || c.includes("acme/oldcsv")), "unrelated and archived candidates cost no reads");
});

test("every call is a read: no -X, no body, no mutation, nothing recorded as a write", () => {
  const b = build(THREE);
  go(A(), b);
  assert.deepEqual(b.w.writes, []);
  for (const c of b.w.calls) assert.ok(!/(^| )-X /.test(c) && !/--input|--method| -F /.test(c) && !/\bmutation\b/i.test(c), c);
  assert.ok(b.w.calls.every((c) => c.startsWith("api ")));
});

test("an 8-word description makes three searches (all, first four, the three rarest); a 3-word one makes one; never more than six", () => {
  const long = ["fast streaming csv parser written in rust with schema validation", "--gh", GH];
  const b = build(THREE);
  const r = go(long, b);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(searchCalls(b.w), 3);
  assert.equal((r.stdout.match(/Searches: (.*)$/m)[1].split(" | ")).length, 3);
  assert.equal(MAX_SEARCHES, 6);
});

test("reads per candidate stay within the cap, and --limit bounds how many candidates are read (the rest are counted, not dropped)", () => {
  const many = Array.from({ length: 6 }, (_, i) => item(6000 + i, `acme/csv${i}`, "Streaming CSV parser"));
  const b = build(many);
  const r = go(A(["--limit", "2"]), b);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 candidates scored, 4 not read/);
  const reads = b.w.calls.filter((c) => !c.includes("/search/repositories")).length;
  assert.ok(reads <= 2 * 5, `${reads} reads`);
  assert.equal((r.stdout.match(/^\d+\. /gm) ?? []).length, 2);
});

test("a nothing-found run says so, lists what was searched, and ends with the caveat", () => {
  const b = build([]);
  const r = go(A(), b);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Nothing decent found\.$/m);
  assert.match(r.stdout, /Searches: streaming csv parser in:name,description,topics is:public archived:false fork:false/);
  assert.match(r.stdout, /does not prove nothing better exists/);
});

test("--language and --license-ok reach the search and the verdict", () => {
  const b = build([item(5001, "acme/csvkit", "Fast streaming CSV parser", { license: { spdx_id: "GPL-3.0" } })]);
  const r = go(A(["--language", "Rust", "--license-ok", "MIT,Apache-2.0"]), b);
  assert.ok(b.w.calls.some((c) => c.includes("language%3ARust")));
  assert.match(r.stdout, /Skipped \(1\): acme\/csvkit \(license GPL-3\.0 is outside your list\)/);
});

test("--json prints the same facts as one JSON document with the numbers and verdicts", () => {
  const r = go(A(["--json"]), build(THREE));
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ["asOf", "terms", "termsDropped", "searches", "partial", "notRead", "found", "unread", "candidates", "caveats"]);
  assert.deepEqual(j.terms, ["streaming", "csv", "parser"]);
  assert.equal(j.partial, null);
  assert.equal(j.candidates[0].fullName, "acme/csvkit");
  assert.equal(j.candidates[0].verdict, "contribute");
  assert.equal(j.candidates[0].numbers.contributors.count, 3);
});

// ---- when GitHub says no -------------------------------------------------------------------------------------------------------------

test("a rate limit while reading stops the run: PARTIAL, exit 3, what was read is still shown, the rest is counted as not read", () => {
  const items = [item(5001, "acme/csvkit", "Fast streaming CSV parser"), item(5002, "acme/csvtwo", "Streaming CSV parser", { pushed_at: "2026-09-01T10:00:00Z" }), item(5003, "acme/csvthree", "Streaming CSV parser", { pushed_at: "2026-08-01T10:00:00Z" })];
  const b = build(items, {}, (w) => (w.fail["/repositories/5002/"] = 403));
  const r = go(A(), b);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /\[PARTIAL\]/);
  assert.match(r.stdout, /stopped early: reading acme\/csvtwo: .*HTTP 403\).*probably a rate limit/);
  assert.match(r.stdout, /1\. acme\/csvkit/);
  assert.match(r.stdout, /2 not read/);
  assert.ok(!b.w.calls.some((c) => c.includes("/repositories/5003/")), "nothing is read after the stop");
});

test("if the first search fails there is NO report (an empty result would read as 'nothing exists'): exit 1 with the reason", () => {
  const b = build(THREE, {}, (w) => (w.fail["/search/repositories"] = 403));
  const r = go(A(), b);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /could not search GitHub/);
  assert.doesNotMatch(r.stderr + r.stdout, /Nothing decent found/);
});

test("an incomplete (timed out) search is treated like a failure, not a short answer", () => {
  const b = build(THREE, {}, (w) => (w.repoSearch.incomplete_results = true));
  const r = go(A(), b);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /incomplete/);
});

test("a later search failing keeps the earlier results and says PARTIAL; a partial run with nothing shown does not say 'nothing found' flatly", () => {
  const long = ["fast streaming csv parser written in rust with schema validation", "--gh", GH];
  const b = build(THREE);
  let n = 0;
  const run = (args) => (args.some((a) => a.startsWith("/search/repositories")) && ++n === 2 ? { status: 1, stdout: "", stderr: "gh: error (HTTP 429)" } : b.run(args));
  const r = runPriorArt(long, { run, now: NOW });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /\[PARTIAL\]/);
  const empty = build(THREE, { 5001: healthy, 5002: healthy }, (w) => (w.fail["/repositories/"] = 500));
  const r2 = go(A(), empty);
  assert.equal(r2.code, 3);
  assert.match(r2.stdout, /No candidate details were read, so nothing could be judged\./);
  assert.match(r2.stdout, /Found but not read: acme\/csvkit, acme\/tabular/);
  assert.match(r2.stdout, /not read/);
});

// ---- arguments -----------------------------------------------------------------------------------------------------------------------

test("bad arguments are refused before any call is made, with the usage text", () => {
  const long = "word ".repeat(500);
  const bad = {
    "no arguments": [], "no description": ["--gh", GH], "two descriptions": ["csv parser", "rust tool", "--gh", GH], "unknown flag alone": [D, "--gh", GH, "--token"], "empty description": ["   ", "--gh", GH], "too long": [long, "--gh", GH],
    "no gh": [D], "relative gh": [D, "--gh", "gh"], "gh without a value": [D, "--gh"], "unknown flag": [D, "--gh", GH, "--token", "x"], "flag twice": [D, "--gh", GH, "--limit", "3", "--limit", "4"],
    "limit 0": A(["--limit", "0"]), "limit 11": A(["--limit", "11"]), "limit text": A(["--limit", "ten"]), "limit decimal": A(["--limit", "2.5"]), "age zero": A(["--max-age-days", "0"]),
    "age text": A(["--max-age-days", "a year"]), "contributors zero": A(["--min-contributors", "0"]), "license with a space": A(["--license-ok", "MIT, Apache"]), "license empty": A(["--license-ok", ""]),
    "no searchable words": ["a an of to", "--gh", GH],
  };
  for (const [name, argv] of Object.entries(bad)) {
    const b = build(THREE);
    const r = go(argv, b);
    assert.equal(r.code, 2, name);
    assert.equal(r.stdout, "", name);
    assert.match(r.stderr, /usage: prior-art/, name);
    assert.equal(b.w.calls.length, 0, `${name}: no call`);
  }
  // The specific reasons (a check that is masked by a later one would otherwise go unnoticed).
  const why = (argv, re) => assert.match(go(argv, build(THREE)).stderr, re);
  why(["   ", "--gh", GH], /the description is empty/);
  why(["word ".repeat(500), "--gh", GH], /longer than 2000 characters/);
  why(["csv parser", "rust tool", "--gh", GH], /ONE quoted argument/);
  why([D, "--gh", GH, "--token"], /unknown option: --token/);
});

test("parseArgs: flags that take a value never swallow the next flag; --json takes none", () => {
  assert.throws(() => parseArgs([D, "--gh", "--json"]), /needs a value/);
  const a = parseArgs([D, "--gh", GH, "--json", "--limit", "3", "--min-contributors", "4", "--max-age-days", "200", "--license-ok", "MIT,Apache-2.0"]);
  assert.deepEqual([a.json, a.limit, a.policy.minContributors, a.policy.maxAgeDays, a.policy.licenseOk], [true, 3, 4, 200, ["MIT", "Apache-2.0"]]);
  assert.equal(parseArgs([D, "--gh", GH]).limit, 10);
});

// ---- hostile text --------------------------------------------------------------------------------------------------------------------

test("text from GitHub is cleaned: no escape sequence, bidi override or zero-width character reaches stdout, in either form", () => {
  const evil = "Fast streaming CSV parser \u001b[31mRED\u001b[0m \u202eevil\u202c a\u200bb \u001b]0;title\u0007";
  const hostile = [item(5001, "acme/csvkit", evil, { topics: ["csv", "parser", "\u001b[2Jwipe"] })];
  for (const argv of [A(), A(["--json"])]) {
    const out = go(argv, build(hostile)).stdout;
    assert.ok(!/[\u001b\u0007\u202a-\u202e\u2066-\u2069\u200b-\u200f]/.test(out), "hidden characters leaked");
    assert.match(out, /acme\/csvkit/);
  }
});

// ---- the read-only wrapper -----------------------------------------------------------------------------------------------------------

test("readOnly is an ALLOWLIST: exactly the two read shapes ghsearch builds get through, everything else is refused before it runs", () => {
  const seen = [];
  const run = readOnly((a) => (seen.push(a), { status: 0, stdout: "{}", stderr: "" }));
  const H = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
  run(["api", ...H, "/search/repositories?q=csv%20parser%20in%3Aname&per_page=10"]);
  run(["api", "graphql", "-f", "query=query($q:String!){search(query:$q,type:ISSUE,first:5){nodes{__typename}}}", "-f", "q=repo:a/b is:closed sort:updated-desc"]);
  assert.equal(seen.length, 2);
  const q = "query=query($q:String!){search(query:$q,type:ISSUE,first:5){nodes{__typename}}}", gq = "q=repo:a/b is:closed sort:updated-desc";
  const bad = [
    ["api", "-X", "POST", "/x"], ["api", "-XDELETE", "/x"], ["api", "--method", "PUT", "/x"], ["api", "--method=PATCH", "/x"], ["repo", "fork", "a/b"], ["issue", "create"], [], "api", ["api", 5],
    ["api", ...H, "/repos/o/r/issues", "-f", "title=x"], ["api", "/repos/o/r/issues", "-f", "title=x", "-f", "body=y"], ["api", "-ftitle=x", "/x"], ["api", "--raw-field=title=x", "/x"], ["api", "-Ffoo=bar", "/x"],
    ["api", "--field=x=1", "/x"], ["api", "--input=f", "/x"], ["api", "--input", "f", ...H, "/x"], ["api", ...H, "/x", "--paginate"], ["api", ...H, "/x", "--cache", "1h"], ["api", "--paginate", ...H, "/x"],
    ["api", ...H, "https://evil.example/x"], ["api", ...H, "/x y"], ["api", ...H, "x"], ["api", "-H", "Accept: x", "-H", "Y: z", "/x"], ["api", ...H],
    ["api", "graphql", "-f", "query=mutation { addStar(input:{starrableId:\"x\"}) { clientMutationId } }", "-f", gq], ["api", "graphql", "-f", q, "-f", gq, "-f", "extra=1"], ["api", "graphql", "-f", q, "-F", gq],
    ["api", "graphql", "-f", "query=query { viewer { login } } mutation { x }", "-f", gq], ["api", "graphql", "-f", q, "-f", "q=org:evil is:closed"], ["api", "graphql", "-f", q, "-f", "q=repo:a/b is:closed sort:updated-desc is:private"],
  ];
  for (const b of bad) assert.throws(() => run(b), GhError, JSON.stringify(b));
  assert.equal(seen.length, 2, "a refused call never reached the runner");
});

test("runPriorArt really wraps the runner in readOnly (the wiring cannot be seen from outside, so it is pinned in the source)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/priorartcmd.mjs", import.meta.url)), "utf8");
  assert.match(src, /createSearch\(readOnly\(run\)\)/);
  assert.equal((src.match(/createSearch\(/g) ?? []).length, 1);
});

test("rarest: the terms with the fewest hits among the candidates seen; ties go to the longer word, then to order", () => {
  const repos = [{ fullName: "a/b", description: "csv parser", topics: [] }, { fullName: "c/d", description: "csv tools", topics: [] }];
  assert.deepEqual(rarest(["csv", "parser", "streaming", "tools", "rust"], repos, 3), ["streaming", "rust", "parser"]);
  assert.deepEqual(rarest(["aa1", "bbbb", "cc"], [], 2), ["bbbb", "aa1"]);
});

// ---- the real entry point: no state, no terminal -------------------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
function stubGh(dir, body) { const p = join(dir, "gh"); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; }

test("through cli.mjs: works with no terminal and no input, creates no state directory, prints a report", () => {
  const dir = mkdtempSync(join(tmpdir(), "priorart-"));
  const home = join(dir, "state-that-must-not-appear");
  const gh = stubGh(dir, `echo '{"total_count":0,"incomplete_results":false,"items":[]}'`);
  const r = spawnSync(process.execPath, [CLI, "prior-art", D, "--gh", gh], { env: { PATH: "/usr/bin:/bin", HOME: dir, COMMON_CONTRIBUTIONS_HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing decent found\./);
  assert.equal(existsSync(home), false, "prior-art must not create the state directory");
});

test("through cli.mjs: a bad --gh or a failing gh gives the documented exit codes, still without state", () => {
  const dir = mkdtempSync(join(tmpdir(), "priorart-"));
  const home = join(dir, "state-that-must-not-appear");
  const env = { PATH: "/usr/bin:/bin", HOME: dir, COMMON_CONTRIBUTIONS_HOME: home };
  const rel = spawnSync(process.execPath, [CLI, "prior-art", D, "--gh", "gh"], { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(rel.status, 2);
  const bad = stubGh(dir, `echo "gh: error (HTTP 403)" >&2; exit 1`);
  const fail = spawnSync(process.execPath, [CLI, "prior-art", D, "--gh", bad], { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /could not search GitHub/);
  assert.equal(existsSync(home), false);
});

test("the search cap is enforced: past it the run stops PARTIAL, and what was found before is kept", () => {
  const long = ["fast streaming csv parser written in rust with schema validation", "--gh", GH];
  const b = build(THREE);
  const r = runPriorArt(long, { run: b.run, now: NOW, maxSearches: 1 });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /\[PARTIAL\]/); assert.match(r.stdout, /more than 1 searches/);
  assert.equal(searchCalls(b.w), 1);
});

test("a description with more than eight searchable words says how many were not used", () => {
  const b = build(THREE);
  const r = go(["alpha bravo charlie delta echo foxtrot golf hotel india juliet", "--gh", GH], b);
  assert.match(r.stdout, /^matched on: alpha, bravo, charlie, delta, echo, foxtrot, golf, hotel \(2 more words in your description were not used\)$/m);
  assert.equal(JSON.parse(go(["alpha bravo charlie delta echo foxtrot golf hotel india juliet", "--gh", GH, "--json"], build(THREE)).stdout).termsDropped, 2);
});

test("a gh that fails with text containing escape sequences cannot put them on the screen", () => {
  const run = () => ({ status: 1, stdout: "", stderr: "\u001b[31mHTTP 403\u001b[0m \u202e" });
  const r = runPriorArt(A(), { run, now: NOW });
  assert.equal(r.code, 1);
  assert.ok(!/[\u001b\u202e]/.test(r.stderr), JSON.stringify(r.stderr));
});

test("--json on a partial run still exits 3 and carries the reason", () => {
  const items = [item(5001, "acme/csvkit", "Fast streaming CSV parser")];
  const r = go(A(["--json"]), build(items, {}, (w) => (w.fail["/repositories/5001/"] = 403)));
  assert.equal(r.code, 3);
  assert.match(JSON.parse(r.stdout).partial, /HTTP 403/);
});

test("a GitHub error's text is cleaned before it is shown; a bug (not a GitHub error) is NOT swallowed into a report", () => {
  const hostile = () => { throw new GhError("\u001b[31mbad\u202e news"); };
  const r = runPriorArt(A(), { run: hostile, now: NOW });
  assert.equal(r.code, 1);
  assert.ok(!/[\u001b\u202e]/.test(r.stderr), JSON.stringify(r.stderr));
  assert.throws(() => runPriorArt(A(), { run: () => { throw new TypeError("boom"); }, now: NOW }), TypeError);
});

// ---- Q5, end to end -----------------------------------------------------------------------------------------------------------------

const inDays = (n) => new Date(Date.parse(NOW_ISO) + n * 86400000).toISOString().slice(0, 10);
const NOW_ISO = "2026-10-13T08:00:00Z";
const goodOptin = (over = {}) => ({ version: 1, opt_in: true, contact: "@maintainer", policy_url: "https://example.org/contributing/ai", review_by: inDays(100), label_applied_by: ["maintainer"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes (tool: Common Contributions)" }, certification: { dco: "none", cla: "none" }, min_hours_between_prs: 48, ...over });
const optedTree = { truncated: false, tree: [{ path: "test", type: "tree" }, { path: ".github/workflows/ci.yml", type: "blob" }, { path: ".github/agent-contributions.json", type: "blob" }] };

test("a project with a valid opt-in file gets the exact run-one line (printed, never run); a paused one and one without do not", () => {
  const items = [item(5001, "acme/csvkit", "Fast streaming CSV parser"), item(5002, "acme/csvpaused", "Streaming CSV parser", { pushed_at: "2026-09-29T10:00:00Z" }), item(5003, "acme/csvplain", "Streaming CSV parser", { pushed_at: "2026-09-28T10:00:00Z" })];
  const data = { 5001: { ...healthy, tree: optedTree, optin: { content: JSON.stringify(goodOptin()) } }, 5002: { ...healthy, tree: optedTree, optin: { content: JSON.stringify(goodOptin({ paused: true })) } }, 5003: healthy };
  const b = build(items, data);
  const r = go(A(), b);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n").filter((l) => l.includes("run-one"));
  assert.deepEqual(lines, [`   node src/cli.mjs run-one ISSUES_JSON ISSUE_NUMBER --repo YOUR_CLONE_OF_CSVKIT --model OLLAMA_MODEL --github acme/csvkit --gh ${GH}`]);
  assert.match(r.stdout, /opted in to Common AI: yes \(interval 48 hours, contact @maintainer/);
  assert.match(r.stdout, /PAUSED: do not send AI contributions here/);
  assert.deepEqual(b.w.writes, []);
  const j = JSON.parse(go(A(["--json"]), build(items, data)).stdout);
  assert.deepEqual(j.candidates.map((c) => [c.fullName, c.runOne !== null]), [["acme/csvkit", true], ["acme/csvpaused", false], ["acme/csvplain", false]]);
});

// ---- findings from the Opus 5.5 and Hermes code reviews (Q6, 2026-10-15) ------------------------------------------------------------------

test("the run-one line uses plain CAPITAL words, never <brackets> (a shell reads those as redirections), and is printed exactly or not at all", () => {
  const items = [item(5001, "acme/csvkit", "Fast streaming CSV parser")];
  const b = build(items, { 5001: { ...healthy, tree: optedTree, optin: { content: JSON.stringify(goodOptin()) } } });
  const out = go(["streaming csv parser", "--gh", "/opt/my  tools/gh"], b).stdout;
  assert.ok(!out.includes("run-one"), "a gh path that clean() would alter (two spaces) gives no line rather than an altered one");
  const ok = go(A(), build(items, { 5001: { ...healthy, tree: optedTree, optin: { content: JSON.stringify(goodOptin()) } } })).stdout;
  assert.ok(ok.includes("run-one") && !/[<>]/.test(ok.split("\n").filter((l) => l.includes("run-one") || l.includes("to start")).join("\n")));
});

test("the report shows how many repositories GitHub matched and names the candidates it found but did not read", () => {
  const many = Array.from({ length: 6 }, (_, i) => item(6000 + i, `acme/csv${i}`, "Streaming CSV parser"));
  const b = build(many, {}, (w) => (w.repoSearch.total_count = 431));
  const r = go(A(["--limit", "2"]), b);
  assert.match(r.stdout, /the broadest search matched 431 repositories on GitHub; only the top results of each search were looked at/);
  assert.match(r.stdout, /Found but not read: acme\/csv\d(, acme\/csv\d){3}$/m);
  assert.equal(JSON.parse(go(A(["--limit", "2", "--json"]), build(many, {}, (w) => (w.repoSearch.total_count = 431))).stdout).found, 431);
});

test("--json carries both standing caveats, like the text report", () => {
  const j = JSON.parse(go(A(["--json"]), build(THREE)).stdout);
  assert.equal(j.caveats.length, 2);
  assert.match(j.caveats.join(" "), /does not prove nothing better exists/); assert.match(j.caveats.join(" "), /not a promise the project wants it/);
});

test("a very long description cannot make a search the 256-character limit would refuse: trailing words are dropped to fit", () => {
  const words = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(40));
  assert.ok(fitTerms(words).join(" ").length <= 250); assert.equal(fitTerms(words).length, 6);
  assert.deepEqual(fitTerms(["csv", "parser"]), ["csv", "parser"]);
  assert.deepEqual(fitTerms(["x".repeat(300)]).length, 1, "a single word is never emptied");
  const b = build(THREE);
  go([words.join(" "), "--gh", GH], b);
  assert.ok(b.w.calls.filter((c) => c.includes("/search/repositories")).every((c) => decodeURIComponent(c.split("q=")[1].split("&")[0]).split(" in:")[0].length <= 250));
});

test("a fork that slips through the search is skipped, not recommended", () => {
  const r = go(A(), build([item(5001, "acme/csvkit", "Fast streaming CSV parser", { fork: true })]));
  assert.match(r.stdout, /Skipped \(1\): acme\/csvkit \(a fork/);
});
