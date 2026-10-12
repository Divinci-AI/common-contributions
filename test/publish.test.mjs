import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createGh } from "../src/ghclient.mjs";
import { planPublish, scanAdded, diffAgainstBase, isTestOrDocPath, MARKER_PREFIX } from "../src/publish.mjs";
import { parseOptIn } from "../src/optin.mjs";
import { buildRecord, issueHash } from "../src/record.mjs";
import { tmp } from "./helpers.mjs";
import { defaultWorld, fakeRunner } from "./fakegh.mjs";

const KEY = "k".repeat(64), TREE = "t".repeat(64);
const NOW = Date.parse("2026-10-11T12:00:00Z");
const SPEC = { version: 1, opt_in: true, min_hours_between_prs: 24, contact: "@maintainer", policy_url: "https://example.org/ai", review_by: "2027-04-01", label_applied_by: ["maintainer"], first_time_contributors: "allowed", allowed_paths: ["tests/**", "docs/**"], forbidden_paths: ["tests/secret/**"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes" }, certification: { dco: "none", cla: "none" } };

function localRepo() {
  const dir = tmp(); const g = (...a) => spawnSync("/usr/bin/git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q"); mkdirSync(join(dir, "tests"), { recursive: true }); writeFileSync(join(dir, "tests/old.test.ts"), "a\nb\nc\n"); g("add", "."); g("commit", "-qm", "base");
  return { dir, base: g("rev-parse", "HEAD").stdout.trim() };
}

function scene({ spec = SPEC, files = { "tests/new.test.ts": "export {}\n" }, world: wmod, rec: rmod } = {}) {
  const { dir, base } = localRepo();
  const w = defaultWorld();
  w.optin = { content: JSON.stringify(spec) };
  const record = buildRecord({ harness: { commit: "h", dirty: false, srcTreeHash: TREE }, project: { dir: "r" }, origin: "github.com/acme/widgets", issue: { number: 7, sha256: issueHash(w.issue.title, w.issue.body) }, base, source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files, checks: [{ name: "t", status: 0 }], key: KEY, ...(rmod ?? {}) });
  wmod?.(w);
  return { w, dir, record };
}
function plan(opts = {}) {
  const s = scene(opts);
  const out = planPublish({ gh: createGh(fakeRunner(s.w)), record: s.record, key: KEY, reviewedTrees: [TREE], target: "acme/widgets", issueNumber: 7, user: opts.user ?? { login: "alice", id: 21, name: "Alice", email: "a@example.org" }, repoDir: s.dir, ledger: opts.ledger ?? [], now: opts.now ?? Date.now() + 60e3, flags: opts.flags });
  return { out, s };
}
const failed = (out) => out.checks.filter((c) => !c.ok).map((c) => c.name);

test("a clean scene passes every check and binds the values the approval will cover", () => {
  const { out, s } = plan();
  assert.deepEqual(failed(out), [], JSON.stringify(out.checks.filter((c) => !c.ok)));
  assert.equal(out.ok, true);
  assert.equal(out.bound.repoId, 1001); assert.equal(out.bound.head, s.w.head); assert.equal(out.bound.specBlobSha, "d".repeat(40)); assert.equal(out.bound.recordSha, s.record.recordSha);
  assert.equal(out.diff.added, 1);
});

const cases = {
  "record from a host run": [{ rec: { container: false } }, /publishable/],
  "record for another issue": [{ rec: { issue: { number: 8, sha256: "x".repeat(64) } } }, /for this issue/],
  "archived repo": [{ world: (w) => (w.repo.archived = true) }, /can receive/],
  "private repo": [{ world: (w) => (w.repo.private = true) }, /can receive/],
  "a fork": [{ world: (w) => (w.repo.fork = true) }, /can receive/],
  "record from another repository": [{ rec: { origin: "github.com/evil/widgets" } }, /came from this repository/],
  "base is not an ancestor (behind)": [{ world: (w) => (w.compare = { status: "behind", files: [] }) }, /ancestor/],
  "base diverged": [{ world: (w) => (w.compare = { status: "diverged", files: [] }) }, /ancestor/],
  "the recorded path changed upstream": [{ world: (w) => (w.compare = { status: "ahead", files: [{ filename: "tests/new.test.ts" }] }) }, /depends on changed/],
  "a lock file changed upstream": [{ world: (w) => (w.compare = { status: "ahead", files: [{ filename: "package-lock.json" }] }) }, /depends on changed/],
  "no opt-in file": [{ world: (w) => (w.optin = null) }, /read the opt-in file/],
  "opt-in file invalid": [{ world: (w) => (w.optin = { content: '{"opt_in":false}' }) }, /opt-in file is valid/],
  "opt-in file is a symlink": [{ world: (w) => (w.optin.type = "symlink") }, /read the opt-in file/],
  "paused": [{ spec: { ...SPEC, paused: true } }, /not paused/],
  "expired": [{ spec: { ...SPEC, review_by: "2026-10-01" } }, /opt-in file is valid/],
  "a listed maintainer is a bot": [{ world: (w) => (w.users.maintainer.type = "Bot") }, /are people/],
  "issue closed": [{ world: (w) => (w.issue.state = "closed") }, /open and is an issue/],
  "the issue is a pull request": [{ world: (w) => (w.issue.pull_request = {}) }, /open and is an issue/],
  "issue moved to another repository": [{ world: (w) => (w.issue.repository_url = "https://api.github.com/repos/other/place") }, /belongs to this repository/],
  "issue text changed": [{ world: (w) => (w.issue.body = "changed after the run") }, /text is what the run saw/],
  "no task label": [{ world: (w) => (w.issue.labels = []) }, /task label/],
  "a blocked label": [{ spec: { ...SPEC, label_blocklist: ["good first issue"] }, world: (w) => w.issue.labels.push({ name: "good first issue" }) }, /blocked label/],
  "labelled by a stranger": [{ world: (w) => (w.events[0].actor = { id: 99, login: "stranger", type: "User" }) }, /applied by a listed maintainer/],
  "labelled by a bot": [{ world: (w) => (w.events[0].actor = { id: 11, login: "x[bot]", type: "Bot" }) }, /applied by a listed maintainer/],
  "label removed after being applied": [{ world: (w) => w.events.push({ event: "unlabeled", label: { name: "agent-ready" }, actor: { id: 11 }, created_at: "2026-09-04T00:00:00Z" }) }, /applied by a listed maintainer/],
  "label applied before the issue existed": [{ world: (w) => (w.events[0].created_at = "2026-09-01T00:00:00Z") }, /applied by a listed maintainer/],
  "no label event at all": [{ world: (w) => (w.events = []) }, /applied by a listed maintainer/],
  "issue edited after the label": [{ world: (w) => (w.lastEditedAt = "2026-09-05T00:00:00Z") }, /not edited after/],
  "claim required but not assigned": [{ spec: { ...SPEC, claim_required: true } }, /assigned to you/],
  "first-time contributor not allowed": [{ spec: { ...SPEC, first_time_contributors: "not_allowed" } }, /merged PR/],
  "a tool-forbidden path": [{ spec: { ...SPEC, allowed_paths: [] }, files: { ".github/workflows/x.yml": "x\n" } }, /tool-forbidden/],
  "a CODEOWNERS file": [{ spec: { ...SPEC, allowed_paths: [] }, files: { "docs/CODEOWNERS": "* @me\n" } }, /tool-forbidden/],
  "a path the project forbids": [{ files: { "tests/secret/a.test.ts": "x\n" } }, /project forbids/],
  "a path outside the allowed list": [{ files: { "src/a.ts": "x\n" } }, /allowed by the project/],
  "safety-critical outside tests and docs": [{ spec: { ...SPEC, safety_critical: true }, files: { "src/a.ts": "x\n" } }, /safety-critical/],
  "diff too large": [{ spec: { ...SPEC, max_diff_lines: 3 }, files: { "tests/n.test.ts": "1\n2\n3\n4\n" } }, /small enough/],
  "diff over the tool ceiling": [{ spec: { ...SPEC, max_diff_lines: 2000 }, files: { "tests/n.test.ts": "x\n".repeat(401) } }, /small enough/],
  "changelog required but absent": [{ spec: { ...SPEC, allowed_paths: [], changelog: { required: true, path: "changelog/{issue}.{type}.rst" } } }, /changelog/],
  "hidden characters": [{ files: { "tests/n.test.ts": "// a" + String.fromCharCode(0x202e) + "b\n" } }, /hidden characters/],
  "flagged code": [{ files: { "tests/n.test.ts": "const k = process.env.SECRET;\n" } }, /reads the environment/],
  "an open agent PR from the same user": [{ world: (w) => w.pulls.push({ number: 1, head: { ref: "agent/3-x", repo: { id: 5 } }, user: { id: 21, login: "alice" }, body: "" }) }, /no other open agent PR|open agent PR limit/],
  "own open agent PR even when the project allows several": [{ spec: { ...SPEC, max_open_agent_prs: 5 }, world: (w) => w.pulls.push({ number: 1, head: { ref: "agent/3-x", repo: { id: 5 } }, user: { id: 21, login: "alice" }, body: "Refs #3" }) }, /no other open agent PR/],
  "the tool ceiling beats a generous project limit": [{ spec: { ...SPEC, max_open_agent_prs: 10 }, world: (w) => w.pulls.push(...[1, 2, 3].map((n) => ({ number: n, head: { ref: "agent/" + n, repo: { id: 5 } }, user: { id: 50 + n, login: "u" + n }, body: "Refs #" + n }))) }, /open agent PR limit/],
  "project at its limit": [{ world: (w) => w.pulls.push({ number: 1, head: { ref: "agent/3-x", repo: { id: 5 } }, user: { id: 50, login: "bob" }, body: "" }) }, /open agent PR limit/],
  "another PR targets this issue": [{ spec: { ...SPEC, max_open_agent_prs: 5 }, world: (w) => w.pulls.push({ number: 1, head: { ref: "agent/3-x", repo: { id: 5 } }, user: { id: 50, login: "bob" }, body: "Refs #7\n" }) }, /targets this issue/],
  "our marker without an agent branch": [{ world: (w) => w.pulls.push({ number: 1, head: { ref: "fix", repo: { id: 5 } }, user: { id: 50, login: "bob" }, body: `x <!-- ${MARKER_PREFIX} run=1 -->` }) }, /open agent PR limit/],
  "search says the project is full": [{ world: (w) => (w.searchTotal = 1) }, /search finds/],
  "search fails": [{ world: (w) => (w.fail["/search/"] = 500) }, /search for agent pull requests/],
  "pulls cannot be counted": [{ world: (w) => (w.pulls = Array.from({ length: 501 }, (_, i) => ({ number: i, head: { ref: "x" }, user: {}, body: "" }))) }, /could be counted/],
  "published here in the last 24h": [{ ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 3600e3 }] }, /last 24 hours/],
  "an earlier PR has had changes requested for over a week with no reply": [{ ledger: [{ repoId: 3000, userId: 21, at: Date.now() - 20 * 86400e3, number: 9 }], world: (w) => (w.earlier = { "3000/9": { pr: { state: "open", updated_at: "2026-09-20T00:00:00Z" }, reviews: [{ state: "CHANGES_REQUESTED", submitted_at: "2026-09-20T00:00:00Z", user: { login: "m" } }] } }) }, /waiting on you/],
  "renamed after the label": [{ world: (w) => w.events.push({ event: "renamed", rename: { from: "a", to: "b" }, actor: { id: 21, login: "alice", type: "User" }, created_at: "2026-09-10T00:00:00Z" }) }, /renamed after/],
  "safety-critical but allowed_paths names source": [{ spec: { ...SPEC, safety_critical: true, allowed_paths: ["src/**"] }, files: { "src/a.ts": "x\n" } }, /tests and documentation only/],
  "forbidden path in a different case": [{ files: { "tests/Secret/a.test.ts": "x\n" } }, /forbids/],
  "the owner changed since the last publish here": [{ ledger: [{ repoId: 1001, ownerId: 5, userId: 21, at: Date.now() - 3 * 86400e3 }] }, /owner is unchanged/],
  "a path with an escape character": [{ files: { ["tests/a" + String.fromCharCode(0x1b) + "[1mB.test.ts"]: "x\n" } }, /hidden characters|path/],
  "a path that is not NFC": [{ files: { ["tests/cafe" + String.fromCharCode(0x301) + ".test.ts"]: "x\n" } }, /NFC|hidden/],
  "a file with a NUL byte": [{ files: { "tests/a.test.ts": "x" + String.fromCharCode(0) + "y\n" } }, /not valid text|binary/],
  "a file with replacement characters": [{ files: { "tests/a.test.ts": "x" + String.fromCharCode(0xfffd) + "y\n" } }, /not valid text/],
  "a 48h-old publish with a 168h interval (longer than the 24h window)": [{ spec: { ...SPEC, min_hours_between_prs: 168 }, ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 48 * 3600e3 }] }, /last 168 hours.*earliest is/],
  "a publish 2h ago with a 6h interval": [{ spec: { ...SPEC, min_hours_between_prs: 6 }, ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 2 * 3600e3 }] }, /last 6 hours/],
  "a ledger entry for this project with no usable time": [{ ledger: [{ repoId: 1001, userId: 21, at: "yesterday" }] }, /no usable time/],
  "a ledger entry dated in the future": [{ ledger: [{ repoId: 1001, userId: 21, at: Date.now() + 5 * 3600e3 }] }, /last 24 hours/],
  "the newest of several entries counts, not the last line": [{ ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 3600e3 }, { repoId: 1001, userId: 21, at: Date.now() - 90 * 3600e3 }] }, /last 24 hours/],
  "daily limit": [{ ledger: [1, 2, 3].map((i) => ({ repoId: 2000 + i, userId: 21, at: Date.now() - 3600e3 })) }, /daily limit/],
  "CLA required, not acknowledged": [{ spec: { ...SPEC, certification: { dco: "none", cla: "individual" } } }, /CLA acknowledged/],
  "DCO required, not certified": [{ spec: { ...SPEC, certification: { dco: "signed-off-by", cla: "none" } } }, /DCO certification/],
  "GitHub down while reading the issue": [{ world: (w) => (w.fail["/issues/7"] = 502) }, /read the issue/],
};
for (const [name, [opts, re]] of Object.entries(cases)) {
  test(`refused: ${name}`, () => {
    const { out } = plan(opts);
    assert.equal(out.ok, false, name);
    assert.match(out.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | "), re);
  });
}

test("the interval allows a publish at or after the interval, to this project only", () => {
  const H = 3600e3;
  assert.equal(plan({ spec: { ...SPEC, min_hours_between_prs: 6 }, ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 6 * H - 1000 }] }).out.ok, true);
  assert.equal(plan({ spec: { ...SPEC, min_hours_between_prs: 168 }, ledger: [{ repoId: 1001, userId: 21, at: Date.now() - 169 * H }] }).out.ok, true);
  assert.equal(plan({ ledger: [{ repoId: 4242, userId: 21, at: Date.now() - H }] }).out.ok, true, "another project's publish does not block this one (the daily cap still counts it)");
  assert.equal(plan({ ledger: [{ repoId: 1001, userId: 99, at: Date.now() - H }] }).out.ok, true, "another user's entry is not ours");
});

test("planPublish itself refuses a spec whose interval is missing or out of range (even if the parser were bypassed)", () => {
  for (const bad of [undefined, null, 5, 0, 721, 7.5, "24", NaN, Infinity]) {
    const s = scene();
    const out = planPublish({ gh: createGh(fakeRunner(s.w)), record: s.record, key: KEY, reviewedTrees: [TREE], target: "acme/widgets", issueNumber: 7, user: { login: "alice", id: 21, name: "Alice", email: "a@b.c" }, repoDir: s.dir, ledger: [],
      parse: (bytes, opts) => { const r = parseOptIn(bytes, opts); return r.ok ? { ...r, value: { ...r.value, min_hours_between_prs: bad } } : r; } });
    assert.equal(out.ok, false, String(bad));
    assert.match(out.checks.filter((c) => !c.ok).map((c) => c.detail).join("|"), /missing or out of range/, String(bad));
  }
});

test("the interval boundary: blocked one millisecond before it, allowed exactly at it", () => {
  const now = Date.now() + 60e3, H = 3600e3, spec = { ...SPEC, min_hours_between_prs: 6 };
  assert.equal(plan({ spec, now, ledger: [{ repoId: 1001, userId: 21, at: now - 6 * H + 1 }] }).out.ok, false);
  assert.equal(plan({ spec, now, ledger: [{ repoId: 1001, userId: 21, at: now - 6 * H }] }).out.ok, true);
});

test("acknowledged CLA/DCO and reviewed flagged code pass", () => {
  assert.equal(plan({ spec: { ...SPEC, certification: { dco: "signed-off-by", cla: "individual" } }, flags: { claSigned: true, certifyDco: true } }).out.ok, true);
  assert.equal(plan({ files: { "tests/n.test.ts": "const k = process.env.X;\n" }, flags: { allowFlaggedCode: true } }).out.ok, true);
});
test("a merged PR satisfies first_time_contributors: not_allowed", () => {
  const { out } = plan({ spec: { ...SPEC, first_time_contributors: "not_allowed" }, world: (w) => (w.closedIssuesByCreator.alice = [{ pull_request: { merged_at: "2026-01-01" } }]) });
  assert.equal(out.ok, true, JSON.stringify(failed(out)));
});
test("an assigned issue satisfies claim_required", () => {
  assert.equal(plan({ spec: { ...SPEC, claim_required: true }, world: (w) => (w.issue.assignees = [{ login: "Alice" }]) }).out.ok, true);
});
test("a spec last changed by someone who is not the contact warns", () => {
  const { out } = plan({ world: (w) => (w.optinCommit.authorLogin = "random") });
  assert.equal(out.ok, true); assert.match(out.warnings.join(), /not the listed contact/);
});
test("scanAdded flags env, process, network, eval and outside reads", () => {
  for (const line of ["process.env.X", "os.environ['X']", "child_process", "subprocess.run(x)", "fetch('x')", "import socket", "eval(x)", "open('/etc/passwd')", "readFileSync('/etc/x')", "../../x"]) assert.ok(scanAdded({ f: line }).length > 0, line);
  assert.deepEqual(scanAdded({ f: "expect(add(1, 2)).toBe(3);" }), []);
});
test("diffAgainstBase counts against the BASE commit, not the working tree", () => {
  const { dir, base } = localRepo();
  writeFileSync(join(dir, "tests/old.test.ts"), "LOCAL EDIT\n");
  const d = diffAgainstBase(dir, base, { "tests/old.test.ts": "a\nb\nC\n", "tests/new.test.ts": "1\n2\n" });
  assert.deepEqual([d.added, d.deleted], [1 + 2, 1]);
  assert.match(d.patch, /a\/tests\/old\.test\.ts/); assert.ok(!d.patch.includes("LOCAL EDIT"));
});

test("an earlier PR you have answered, closed, or that only just got feedback does not block", () => {
  const led = [{ repoId: 3000, userId: 21, at: Date.now() - 20 * 86400e3, number: 9 }];
  const ok = (earlier) => plan({ ledger: led, world: (w) => (w.earlier = { "3000/9": earlier }) }).out.ok;
  assert.equal(ok({ pr: { state: "open", updated_at: "2026-10-09T00:00:00Z" }, reviews: [{ state: "CHANGES_REQUESTED", submitted_at: "2026-09-20T00:00:00Z", user: { login: "m" } }] }), true, "answered since");
  assert.equal(ok({ pr: { state: "closed", updated_at: "2026-09-20T00:00:00Z" }, reviews: [{ state: "CHANGES_REQUESTED", submitted_at: "2026-09-20T00:00:00Z", user: { login: "m" } }] }), true, "closed");
  assert.equal(ok({ pr: { state: "open", updated_at: new Date(Date.now() - 86400e3).toISOString() }, reviews: [{ state: "CHANGES_REQUESTED", submitted_at: new Date(Date.now() - 86400e3).toISOString(), user: { login: "m" } }] }), true, "feedback is only a day old");
});

test("a safety-critical project accepts tests and docs by path, and only those", () => {
  const spec = { ...SPEC, safety_critical: true, allowed_paths: ["tests/**", "docs/**", "**"] };
  assert.equal(plan({ spec, files: { "tests/a.test.ts": "x\n", "docs/guide.md": "x\n" } }).out.ok, true);
  assert.equal(plan({ spec, files: { "lib/core.ts": "x\n" } }).out.ok, false);
  for (const p of ["tests/a.py", "src/__tests__/x.js", "a/b/c.test.ts", "a/b_test.go", "test_thing.py", "README.md", "docs/a.rst", "x/doc/y.txt"]) assert.equal(isTestOrDocPath(p), true, p);
  for (const p of ["src/core.ts", "lib/testing_utils.py", "contest/a.ts", "a.txt", "Makefile"]) assert.equal(isTestOrDocPath(p), false, p);
});
test("certifications come from a callback (the terminal), are asked once the spec and flagged lines are known, and are bound into the plan", () => {
  const seen = [];
  const spec = { ...SPEC, certification: { dco: "signed-off-by", cla: "individual" } };
  const asked = (answers) => plan({ spec, files: { "tests/n.test.ts": "const k = process.env.X;\n" }, flags: (ctx) => { seen.push(ctx); return answers; } }).out;
  const yes = asked({ claSigned: true, certifyDco: true, allowFlaggedCode: true });
  assert.equal(yes.ok, true); assert.deepEqual(yes.bound.ack, { cla: true, dco: true, flagged: true });
  assert.equal(seen[0].spec.certification.cla, "individual"); assert.match(seen[0].flagged[0], /reads the environment/);
  const no = asked({}); assert.equal(no.ok, false); assert.deepEqual(no.bound.ack, { cla: false, dco: false, flagged: false });
  assert.ok(no.checks.filter((c) => !c.ok).map((c) => c.name).join().match(/CLA acknowledged|DCO certification|no code that reads/));
});

test("a binary file in the record is refused, not counted as zero lines", () => {
  const { dir, base } = localRepo();
  assert.throws(() => diffAgainstBase(dir, base, { "tests/blob.bin": "\u0000\u0001\u0002binary" + "\u0000".repeat(50) }), /binary/);
});
