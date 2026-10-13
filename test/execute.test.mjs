import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createGh } from "../src/ghclient.mjs";
import { dryRun, publish, ghWriter, readLedger, certifyAfterReview, reviewText } from "../src/execute.mjs";
import { buildRecord, issueHash } from "../src/record.mjs";
import { tmp } from "./helpers.mjs";
import { defaultWorld, fakeRunner } from "./fakegh.mjs";

const KEY = "k".repeat(64), TREE = "t".repeat(64);
const SPEC = { version: 1, opt_in: true, min_hours_between_prs: 24, contact: "@maintainer", policy_url: "https://example.org/ai", review_by: "2027-04-01", label_applied_by: ["maintainer"], first_time_contributors: "allowed", allowed_paths: ["tests/**"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes" }, certification: { dco: "none", cla: "none" } };
const USER = { login: "alice", id: 21, name: "Alice Example", email: "alice@example.org" };
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
  const common = { gh: createGh(fakeRunner(w)), write: ghWriter(fakeRunner(w)), record, key: KEY, reviewedTrees: [TREE], target: "acme/widgets", issueNumber: 7, user: USER, repoDir: dir, ledger: [], flags: {}, descriptionText: DESC, ledgerFile: join(state, "published.jsonl"), pushUrlFor: () => bare, sleep: async () => {}, now: Date.now() + 60e3 };
  return { w, dir, bare, state, common, g };
}

test("dry run: plans, builds the exact commit and texts, and writes NOTHING to GitHub, the remote or the state directory", () => {
  const s = scene();
  const r = dryRun(s.common);
  assert.equal(r.phase, "dry-run", JSON.stringify(r.plan.checks.filter((c) => !c.ok)));
  assert.equal(r.plan.info.intervalHours, 24);
  assert.match(reviewText(r), /Interval in force between our pull requests to this project: 24 hours/);
  assert.match(r.texts.token, /^[a-f0-9]{32}$/); assert.equal(r.texts.branch, "agent/7-test-add-coverage");
  assert.match(r.texts.body, /AI assistance: yes/); assert.match(r.texts.body, /<!-- common-ai run=/);
  assert.equal(s.w.writes.length, 0, "no POST or PATCH");
  assert.equal(s.w.pushedSha(), null, "nothing pushed");
  assert.deepEqual(readdirSync(s.state), [], "nothing written to the state directory either");
});
test("the plan's token is the same every time for the same state (so the checks before fork, push and PR can compare)", () => {
  const s = scene(); assert.equal(dryRun(s.common).texts.token, dryRun(s.common).texts.token);
});

test("publish: one step, no waiting: fork, push the planned commit, open the PR, verify, record in the ledger", async () => {
  const s = scene();
  const d = dryRun(s.common);
  const r = await publish(s.common);
  assert.equal(r.phase, "published", r.error ?? JSON.stringify(r.plan?.checks?.filter((c) => !c.ok)));
  assert.equal(s.w.pushedSha(), d.texts.commitSha, "the remote branch is the planned commit");
  assert.deepEqual(s.w.writes.map((x) => `${x.method} ${x.path.replace(/\d+/g, "N")}`), ["POST /repositories/N/forks", "POST /repositories/N/pulls"]);
  const pr = s.w.writes[1].fields; assert.equal(pr.head, "alice:agent/7-test-add-coverage"); assert.equal(pr.base, "main"); assert.equal(pr.title, d.texts.title); assert.equal(pr.body, d.texts.body);
  const led = readLedger(s.common.ledgerFile); assert.equal(led.length, 1); assert.deepEqual([led[0].repoId, led[0].userId, led[0].commitSha], [1001, 21, d.texts.commitSha]);
});

test("the project is paused: refused before anything is written", async () => {
  const s = scene();
  s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) };
  const r = await publish({ ...s.common });
  assert.equal(r.phase, "refused"); assert.equal(s.w.writes.length, 0);
});
test("the spec changes after the fork exists but before the push: aborted, nothing pushed, no PR", async () => {
  const s = scene();
  s.w.onFork = () => (s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) });
  const r = await publish({ ...s.common });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before pushing/); assert.equal(s.w.pushedSha(), null); assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")));
});
test("the maintainers' label is removed after the push but before the PR: aborted, the PR is never opened", async () => {
  const s = scene(); const d = dryRun(s.common);
  s.w.onRef = () => (s.w.events = []);
  const r = await publish({ ...s.common });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before opening the pull request/);
  assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")), "no PR POST");
});
test("a fork that is not a fork of the target is not pushed to", async () => {
  const s = scene({ world: (w) => (w.forkSourceId = 999) }); const d = dryRun(s.common);
  const r = await publish({ ...s.common });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /not a fork of the target/); assert.equal(s.w.pushedSha(), null);
});
test("a failing push aborts without opening a PR", async () => {
  const s = scene(); const d = dryRun(s.common);
  const r = await publish({ ...s.common, pushUrlFor: () => "/nonexistent/repo.git" });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /git push failed/); assert.ok(!s.w.writes.some((x) => x.path.endsWith("/pulls")));
});
test("a PR that comes back with a different head, title or body is closed and reported", async () => {
  for (const mod of [(w) => (w.prHeadSha = "f".repeat(40)), (w) => (w.prTitle = "something else"), (w) => (w.prBody = "edited by someone")]) {
    const s = scene({ world: mod }); const d = dryRun(s.common);
    const r = await publish({ ...s.common });
    assert.equal(r.phase, "aborted"); assert.match(r.error, /it was closed/); assert.equal(s.w.prClosed, true); assert.equal(readLedger(s.common.ledgerFile).length, 0);
  }
});
test("a missing human description stops at the dry run", () => {
  const s = scene();
  assert.equal(dryRun({ ...s.common, descriptionText: "" }).phase, "refused");
  assert.equal(s.w.writes.length, 0);
});

test("the project pauses right after the plan is made (before the first write): caught before the fork", async () => {
  const s = scene(); let n = 0;
  const flags = () => { if (++n === 1) s.w.optin = { content: JSON.stringify({ ...SPEC, paused: true }) }; return {}; };
  const r = await publish({ ...s.common, flags });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before forking/); assert.equal(s.w.writes.length, 0);
});
test("upstream moves on without blocking anything: the token still changes, so the publish stops", async () => {
  const s = scene();
  s.w.onFork = () => (s.w.head = "e".repeat(40)); // compare still says ahead, no relevant file changed
  const r = await publish({ ...s.common });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /token differs/); assert.equal(s.w.pushedSha(), null);
});
for (const [name, mod, re] of [
  ["the fork is not marked as a fork", (w) => (w.forkFlag = false), /not a fork of the target/],
  ["the fork belongs to someone else", (w) => (w.forkOwner = "mallory"), /not a fork of the target/],
  ["the pushed branch points somewhere else", (w) => (w.refSha = "9".repeat(40)), /does not point at the planned commit/],
  ["the PR comes back closed", (w) => (w.prState = "closed"), /it is not open/],
]) {
  test(`aborted: ${name}`, async () => {
    const s = scene({ world: mod }); const d = dryRun(s.common);
    const r = await publish({ ...s.common });
    assert.equal(r.phase, "aborted"); assert.match(r.error, re); assert.equal(readLedger(s.common.ledgerFile).length, 0);
  });
}

test("the review text shows the contact, the author, the certifications and the whole diff; a dry run says it asked nothing", async () => {
  const s = scene(); const d = dryRun(s.common); const shown = reviewText(d);
  assert.match(shown, /acme\/widgets/); assert.match(shown, /Project contact: @maintainer/); assert.match(shown, /Alice Example <alice@example\.org>/);
  assert.match(shown, /--- diff \(1 changed lines\) ---/); assert.match(shown, /\+export \{\}/); assert.match(shown, /Certifications given: CLA no, DCO sign-off no/); assert.match(shown, /AI assistance: yes/);
  assert.match(reviewText(d, { dry: true }), /Dry run: no certification was asked and nothing will be changed/);
  assert.doesNotMatch(reviewText(d, { dry: true }), /Certifications given/);
  const r = await publish(s.common);
  assert.equal(readLedger(s.common.ledgerFile)[0]?.ownerId, 7, "the owner at publish time is remembered");
});
test("certifications are asked AFTER the review text is shown, and a plan that fails for other reasons never asks", () => {
  const s = scene({ spec: { ...SPEC, certification: { dco: "signed-off-by", cla: "individual" } } });
  const order = [];
  const { flags } = certifyAfterReview({ ...s.common, flags: undefined }, { display: (t) => { order.push("display"); assert.match(t, /--- diff/); }, askCertifications: ({ spec }) => { order.push("ask"); assert.equal(spec.certification.dco, "signed-off-by"); return { claSigned: true, certifyDco: true }; } });
  assert.deepEqual(order, ["display", "ask"]); assert.deepEqual(flags, { claSigned: true, certifyDco: true });
  const bad = scene({ world: (w) => (w.repo.archived = true) });
  let asked = false;
  const r = certifyAfterReview({ ...bad.common, flags: undefined }, { display: () => {}, askCertifications: () => { asked = true; return {}; } });
  assert.ok(r.refused); assert.equal(asked, false);
  // The answers then reach the real plan and the token: a "no" refuses, a "yes" changes the token.
  const yes = dryRun({ ...s.common, flags: { claSigned: true, certifyDco: true } }), no = dryRun({ ...s.common, flags: { claSigned: false, certifyDco: true } });
  assert.equal(yes.phase, "dry-run"); assert.equal(no.phase, "refused");
  assert.notEqual(yes.texts.token, dryRun({ ...s.common, flags: { claSigned: true, certifyDco: true }, descriptionText: DESC + " Again." }).texts.token);
});

test("certification answers given as a callback reach the commit: Signed-off-by is in the commit that is published", () => {
  const s = scene({ spec: { ...SPEC, certification: { dco: "signed-off-by", cla: "none" } } });
  const d = dryRun({ ...s.common, flags: () => ({ certifyDco: true }) });
  assert.equal(d.phase, "dry-run");
  assert.match(d.texts.message, /^Signed-off-by: Alice Example <alice@example\.org>$/m);
  const n = dryRun({ ...s.common, flags: { certifyDco: true } });
  assert.equal(n.texts.commitSha, d.texts.commitSha, "callback and plain object give the same commit");
});

test("the screen before the certification says nothing was certified yet and names what will be asked; a dry run names what the project requires", () => {
  const s = scene({ spec: { ...SPEC, certification: { dco: "signed-off-by", cla: "individual" } } });
  const { flags } = certifyAfterReview({ ...s.common, flags: undefined }, { display: (t) => { assert.match(t, /Certifications you will be asked for next \(typed by you\): individual CLA and DCO sign-off/); assert.match(t, /Nothing has been certified yet/); assert.doesNotMatch(t, /Certifications given/); }, askCertifications: ({ text }) => { assert.match(text, /Nothing has been certified yet/); return { claSigned: true, certifyDco: true }; } });
  assert.deepEqual(flags, { claSigned: true, certifyDco: true });
  const d = dryRun({ ...s.common, flags: { claSigned: true, certifyDco: true } });
  assert.match(reviewText(d, { dry: true }), /Certifications this project requires, asked when you publish: individual CLA and DCO sign-off/);
});

test("flagged code and no --allow-flagged-code: nobody is asked to certify and nothing is written", async () => {
  const s = scene();
  s.common.record = buildRecord({ harness: { commit: "h".repeat(40), dirty: false, srcTreeHash: TREE }, project: { dir: "r" }, origin: "github.com/acme/widgets", issue: { number: 7, sha256: issueHash(s.w.issue.title, s.w.issue.body) }, model: "m", base: s.common.record.base, source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files: { "tests/new.test.ts": "export const k = process.env.SECRET;\n" }, checks: [{ name: "t", status: 0 }], key: KEY });
  let asked = false;
  const r = certifyAfterReview({ ...s.common, flags: undefined }, { display: () => {}, askCertifications: () => { asked = true; return {}; }, allowFlaggedCode: false });
  assert.ok(r.refused, "the provisional plan uses the real flag, so a publish that would be refused never reaches the question"); assert.equal(asked, false);
  assert.ok(r.refused.plan.checks.some((c) => !c.ok && /environment, uses the network/.test(c.name)));
  const p = await publish({ ...s.common, flags: { allowFlaggedCode: false } });
  assert.equal(p.phase, "refused"); assert.equal(s.w.writes.length, 0);
  const ok = await publish({ ...s.common, flags: { allowFlaggedCode: true } });
  assert.equal(ok.phase, "published", ok.error);
});

test("what the person was shown must be what is published: the diff or the project's file changing after the screen refuses with zero writes", async () => {
  const s = scene();
  const { expect } = certifyAfterReview({ ...s.common, flags: undefined }, { display: () => {}, askCertifications: () => ({}) });
  assert.ok(expect.specBlobSha && expect.patch);
  const fileChanged = await publish({ ...s.common, expect: { ...expect, specBlobSha: "0".repeat(40) } });
  assert.equal(fileChanged.phase, "refused"); assert.ok(fileChanged.plan.checks.some((c) => c.name === "what you were shown" && !c.ok));
  const diffChanged = await publish({ ...s.common, expect: { ...expect, patch: expect.patch + "x" } });
  assert.equal(diffChanged.phase, "refused"); assert.equal(s.w.writes.length, 0);
  const fine = await publish({ ...s.common, expect });
  assert.equal(fine.phase, "published", fine.error);
});

test("another publish by the same person wrote the ledger after this run's plan: the next re-check sees it and nothing is opened", async () => {
  const s = scene(); let n = 0;
  const entry = { repoId: 1001, userId: 21, at: s.common.now - 1000 };
  const ledgerFn = () => (++n === 1 ? [] : [entry]); // the first plan sees an empty ledger, the re-check before forking sees the other run's entry
  const r = await publish({ ...s.common, ledgerFn });
  assert.equal(r.phase, "aborted"); assert.match(r.error, /before forking/); assert.equal(s.w.writes.length, 0);
});
test("one publish at a time: a held lock refuses with zero writes and is left alone; a finished publish releases it; a stale lock is ignored", async () => {
  const s = scene(); const lockFile = join(s.state, "publish.lock");
  writeFileSync(lockFile, "999\n");
  const held = await publish({ ...s.common, lockFile });
  assert.equal(held.phase, "refused"); assert.ok(held.plan.checks.some((c) => c.name === "no other publish is running" && !c.ok));
  assert.equal(s.w.writes.length, 0); assert.ok(existsSync(lockFile), "the other run's lock is not removed by the refused run");
  const old = new Date(Date.now() - 20 * 60e3); utimesSync(lockFile, old, old);
  const done = await publish({ ...s.common, lockFile });
  assert.equal(done.phase, "published", done.error); assert.ok(!existsSync(lockFile), "released when finished");
  const s2 = scene(); const failing = await publish({ ...s2.common, lockFile: join(s2.state, "l"), pushUrlFor: () => "/nonexistent/repo.git" });
  assert.equal(failing.phase, "aborted"); assert.ok(!existsSync(join(s2.state, "l")), "released even when the publish aborts");
});
