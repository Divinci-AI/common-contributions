import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createGh } from "../src/ghclient.mjs";
import { dryRun, publish, ghWriter, COOLDOWN_MS, readLedger } from "../src/execute.mjs";
import { buildRecord, issueHash } from "../src/record.mjs";
import { tmp } from "./helpers.mjs";
import { defaultWorld, fakeRunner } from "./fakegh.mjs";

const KEY = "k".repeat(64), TREE = "t".repeat(64);
const SPEC = { version: 1, opt_in: true, contact: "@maintainer", policy_url: "https://example.org/ai", review_by: "2027-04-01", label_applied_by: ["maintainer"], first_time_contributors: "allowed", allowed_paths: ["tests/**"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes" }, certification: { dco: "none", cla: "none" } };
const USER = { login: "alice", id: 21, name: "Alice Example", email: "alice@example.org" };
const SENTENCE = "I read every line of the change for issue 7: it adds one test for the empty list case.";
const DESC = "I added a test for the empty list case because the helper had none.";

function scene({ spec = SPEC, world: wmod } = {}) {
  const dir = tmp(); const g = (...a) => spawnSync("/usr/bin/git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q"); mkdirSync(join(dir, "tests"), { recursive: true }); writeFileSync(join(dir, "tests/old.test.ts"), "a\n"); g("add", "."); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").stdout.trim();
  const bare = tmp(); spawnSync("/usr/bin/git", ["init", "-q", "--bare", bare]);
  const w = defaultWorld(); w.optin = { content: JSON.stringify(spec) };
  w.pushedSha = () => { const r = spawnSync("/usr/bin/git", ["--git-dir", bare, "for-each-ref", "--format=%(objectname)", "refs/heads/agent/"], { encoding: "utf8" }); return r.stdout.trim() || null; };
  wmod?.(w);
  const record = buildRecord({ harness: { commit: "h".repeat(40), dirty: false, srcTreeHash: TREE }, project: { dir: "r" }, origin: "github.com/acme/widgets", issue: { number: 7, sha256: issueHash(w.issue.title, w.issue.body) }, model: "claude-code:opus", base, source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files: { "tests/new.test.ts": "export {}\n" }, checks: [{ name: "t", status: 0 }], key: KEY });
  const state = tmp();
  const common = { gh: createGh(fakeRunner(w)), write: ghWriter(fakeRunner(w)), record, key: KEY, reviewedTrees: [TREE], target: "acme/widgets", issueNumber: 7, user: USER, repoDir: dir, ledger: [], flags: {}, descriptionText: DESC, sentence: SENTENCE, pendingDir: join(state, "pending"), ledgerFile: join(state, "published.jsonl"), pushUrlFor: () => bare, sleep: async () => {}, now: Date.now() + 60e3 };
  return { w, dir, bare, state, common, g };
}
const answers = (...a) => { const q = [...a]; return () => q.shift(); };
const GOOD = (repo = "acme/widgets") => answers(repo, "", "yes");

test("dry run: plans, builds the exact commit and texts, prints a token, and writes NOTHING to GitHub or the remote", () => {
  const s = scene();
  const r = dryRun(s.common);
  assert.equal(r.phase, "dry-run", JSON.stringify(r.plan.checks.filter((c) => !c.ok)));
  assert.match(r.texts.token, /^[a-f0-9]{32}$/); assert.equal(r.texts.branch, "agent/7-test-add-coverage");
  assert.match(r.texts.body, /AI assistance: yes/); assert.match(r.texts.body, /<!-- common-ai run=/);
  assert.equal(s.w.writes.length, 0, "no POST or PATCH");
  assert.equal(s.w.pushedSha(), null, "nothing pushed");
  assert.deepEqual(readdirSync(s.common.pendingDir), [r.texts.token]);
});
test("the dry run's token is the same every time for the same state (so the real publish can match it)", () => {
  const s = scene(); assert.equal(dryRun(s.common).texts.token, dryRun(s.common).texts.token);
});

async function approved(s, over = {}) {
  const d = dryRun(s.common);
  return publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000, ...over });
}

test("real publish: fork, push the approved commit, open the PR, verify, record in the ledger", async () => {
  const s = scene();
  const d = dryRun(s.common);
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "published", r.error ?? JSON.stringify(r.plan?.checks?.filter((c) => !c.ok)));
  assert.equal(s.w.pushedSha(), d.texts.commitSha, "the remote branch is the approved commit");
  assert.deepEqual(s.w.writes.map((x) => `${x.method} ${x.path.replace(/\d+/g, "N")}`), ["POST /repositories/N/forks", "POST /repositories/N/pulls"]);
  const pr = s.w.writes[1].fields; assert.equal(pr.head, "alice:agent/7-test-add-coverage"); assert.equal(pr.base, "main"); assert.equal(pr.title, d.texts.title); assert.equal(pr.body, d.texts.body);
  const led = readLedger(s.common.ledgerFile); assert.equal(led.length, 1); assert.deepEqual([led[0].repoId, led[0].userId, led[0].commitSha], [1001, 21, d.texts.commitSha]);
});

const refusals = {
  "a wrong token": [(s, d) => ({ approve: "0".repeat(32) }), /token does not match/],
  "no token": [() => ({ approve: undefined }), /token does not match/],
  "no dry run on record": [(s, d) => { for (const f of readdirSync(s.common.pendingDir)) spawnSync("/bin/rm", [join(s.common.pendingDir, f)]); return {}; }, /no dry run/],
  "the cool-down has not passed": [(s) => ({ now: s.common.now + 1000 }), /wait \d+ more minute/],
  "the repository name typed wrong": [() => ({ ask: answers("acme/other", "", "yes") }), /repository name/],
  "the sentence retyped differently": [() => ({ ask: answers("acme/widgets", "I read a completely different thing for issue 7 and it does something else.", "yes") }), /sentence differs/],
  "not confirmed": [() => ({ ask: answers("acme/widgets", "", "no") }), /not confirmed/],
};
for (const [name, [fn, re]] of Object.entries(refusals)) {
  test(`real publish refused: ${name}; nothing is written`, async () => {
    const s = scene(); const d = dryRun(s.common);
    const extra = fn(s, d);
    const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000, ...extra });
    assert.equal(r.phase, "refused"); assert.match(r.plan.checks.filter((c) => !c.ok).map((c) => c.detail).join(" | "), re);
    assert.equal(s.w.writes.length, 0); assert.equal(s.w.pushedSha(), null); assert.equal(readLedger(s.common.ledgerFile).length, 0);
  });
}

test("the state changes between the dry run and the real publish (the project pauses): refused before anything is written", async () => {
  const s = scene(); const d = dryRun(s.common);
  s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) };
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "refused"); assert.equal(s.w.writes.length, 0);
});
test("the spec changes after the fork exists but before the push: aborted, nothing pushed, no PR", async () => {
  const s = scene(); const d = dryRun(s.common);
  s.w.onFork = () => (s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) });
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before pushing/); assert.equal(s.w.pushedSha(), null); assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")));
});
test("the maintainers' label is removed after the push but before the PR: aborted, the PR is never opened", async () => {
  const s = scene(); const d = dryRun(s.common);
  s.w.onRef = () => (s.w.events = []);
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before opening the pull request/);
  assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")), "no PR POST");
});
test("a fork that is not a fork of the target is not pushed to", async () => {
  const s = scene({ world: (w) => (w.forkSourceId = 999) }); const d = dryRun(s.common);
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /not a fork of the target/); assert.equal(s.w.pushedSha(), null);
});
test("a failing push aborts without opening a PR", async () => {
  const s = scene(); const d = dryRun(s.common);
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000, pushUrlFor: () => "/nonexistent/repo.git" });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /git push failed/); assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")));
});
test("a PR that comes back with a different head, title or body is closed and reported", async () => {
  for (const mod of [(w) => (w.prHeadSha = "f".repeat(40)), (w) => (w.prTitle = "something else"), (w) => (w.prBody = "edited by someone")]) {
    const s = scene({ world: mod }); const d = dryRun(s.common);
    const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
    assert.equal(r.phase, "aborted"); assert.match(r.error, /it was closed/); assert.equal(s.w.prClosed, true); assert.equal(readLedger(s.common.ledgerFile).length, 0);
  }
});
test("a missing human description or a sentence without the issue number stops at the dry run", () => {
  const s = scene();
  assert.equal(dryRun({ ...s.common, descriptionText: "" }).phase, "refused");
  assert.equal(dryRun({ ...s.common, sentence: "I read it all and it is fine and good and tidy and short." }).phase, "refused");
  assert.equal(s.w.writes.length, 0);
});

test("the state changes while the human is typing the confirmations: caught before the fork", async () => {
  const s = scene(); const d = dryRun(s.common);
  let n = 0; const ask = (q) => { if (++n === 1) s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) }; return [s.common.target, "", "yes"][n - 1]; };
  const r = await publish({ ...s.common, approve: d.texts.token, ask, now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before forking/); assert.equal(s.w.writes.length, 0);
});
test("upstream moves on without blocking anything: the token still changes, so the publish stops", async () => {
  const s = scene(); const d = dryRun(s.common);
  s.w.onFork = () => (s.w.head = "e".repeat(40)); // compare still says ahead, no relevant file changed
  const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /token differs/); assert.equal(s.w.pushedSha(), null);
});
for (const [name, mod, re] of [
  ["the fork is not marked as a fork", (w) => (w.forkFlag = false), /not a fork of the target/],
  ["the fork belongs to someone else", (w) => (w.forkOwner = "mallory"), /not a fork of the target/],
  ["the pushed branch points somewhere else", (w) => (w.refSha = "9".repeat(40)), /does not point at the approved commit/],
  ["the PR comes back closed", (w) => (w.prState = "closed"), /it is not open/],
]) {
  test(`aborted: ${name}`, async () => {
    const s = scene({ world: mod }); const d = dryRun(s.common);
    const r = await publish({ ...s.common, approve: d.texts.token, ask: GOOD(), now: s.common.now + COOLDOWN_MS + 1000 });
    assert.equal(r.phase, "aborted"); assert.match(r.error, re); assert.equal(readLedger(s.common.ledgerFile).length, 0);
  });
}

test("before the confirmations, the person's terminal is shown the contact, the author, the certifications and the whole diff", async () => {
  const s = scene(); const d = dryRun(s.common); let shown = "", order = [];
  const r = await publish({ ...s.common, approve: d.texts.token, now: s.common.now + COOLDOWN_MS + 1000, display: (t) => { shown = t; order.push("display"); }, ask: (() => { const g = GOOD(); return (q) => { order.push("ask"); return g(q); }; })() });
  assert.equal(order[0], "display", "shown before the first question");
  assert.match(shown, /acme\/widgets/); assert.match(shown, /Project contact: @maintainer/); assert.match(shown, /Alice Example <alice@example\.org>/);
  assert.match(shown, /--- diff \(1 changed lines\) ---/); assert.match(shown, /\+export \{\}/); assert.match(shown, /Certifications given: CLA no, DCO sign-off no/); assert.match(shown, /AI assistance: yes/);
  assert.equal(readLedger(s.common.ledgerFile)[0]?.ownerId, 7, "the owner at publish time is remembered");
});
