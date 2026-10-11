import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanTitle, cleanDescription, cleanSentence, buildCommitMessage, buildPrBody, branchName, buildCommit, approvalToken } from "../src/publisher.mjs";
import { isAgentBranch } from "../src/scope.mjs";
import { gitBlobId } from "../src/record.mjs";
import { MARKER_PREFIX } from "../src/publish.mjs";
import { tmp } from "./helpers.mjs";

const ch = (...c) => String.fromCharCode(...c);
const SPEC = (o = {}) => ({ disclosure: { mechanism: "pr_body", text: "AI assistance: yes" }, certification: { dco: "none", cla: "none" }, ...o });
const USER = { login: "alice", id: 1, name: "Alice Example", email: "alice@example.org" };

test("titles: ordinary ones pass; hidden characters, links, markup, mentions and length are refused", () => {
  assert.equal(cleanTitle("  test:   add   coverage "), "test: add coverage"); assert.equal(cleanTitle("test: C# parser handles empty input"), "test: C# parser handles empty input", "# not followed by a number is ordinary text");
  for (const bad of ["", "a".repeat(121), "x" + ch(0x202e) + "y", "see https://x.org", "a@b", "<b>x</b>", "`x`", "[x](y)", "x" + ch(0x200b), "Closes #1, see torvalds/linux#1", "fixes #12", "resolved #3", "torvalds/linux#5", "see #77"]) assert.throws(() => cleanTitle(bad), undefined, JSON.stringify(bad));
});
test("descriptions must be human text without mentions, images or hidden characters", () => {
  assert.equal(cleanDescription("  I added a test for the empty case because the helper had none.  ", 7), "I added a test for the empty case because the helper had none.");
  for (const bad of ["short", "x".repeat(5001), "this is long enough and closes #7 when it merges ok", "long enough text that fixes torvalds/linux#1 somehow", "long enough and mentions #8 which is another issue", "long enough with <img src=x> tracking pixel", "long enough with <!-- common-ai run=1 --> forged marker", "this is long enough but mentions @someone here", "long enough ![img](x) text here ok", "long enough text" + ch(0x202e) + " here ok", undefined]) assert.throws(() => cleanDescription(bad, 7), undefined, String(bad).slice(0, 30));
  assert.ok(cleanDescription("I added a test for issue #7: the empty list case, which had none before.", 7), "the issue it is for may be named");
});
test("the sentence must be free-form, mention the issue number, and be plain", () => {
  assert.ok(cleanSentence("I read every line of the change for issue 7 and it adds one test for the empty list.", 7));
  for (const bad of ["too short for 7", "I read every line and it adds one test for the empty list without a number.", "I read every line of issue 7 and see https://x.org for how it works fine", "I read all of issue 17 and the change adds one test for empties", "x".repeat(401)]) assert.throws(() => cleanSentence(bad, 7), undefined, bad.slice(0, 30));
});
test("branch names are agent/<issue>-<slug> and always valid", () => {
  for (const t of ["test: add coverage", "!!!", "A".repeat(200), "../../etc", "x" + ch(0x202e), ""]) { const b = branchName(7, t); assert.ok(isAgentBranch(b), b); assert.ok(b.length < 60); }
  assert.equal(branchName(7, "test: add coverage"), "agent/7-test-add-coverage");
});
test("commit message: trailers follow the project's rules and the tool never signs unless told", () => {
  const m = (spec, flags) => buildCommitMessage({ title: "test: x", issueNumber: 7, spec, flags, user: USER, model: "claude-code:opus" });
  assert.equal(m(SPEC(), {}), "test: x\n\nRefs #7\n");
  assert.match(m(SPEC({ disclosure: { mechanism: "commit_trailer" } }), {}), /\nAssisted-by: Common-Contributions\/claude-code:opus\n/);
  const dco = SPEC({ certification: { dco: "signed-off-by", cla: "none" } });
  assert.ok(!/Signed-off-by/.test(m(dco, {})), "no sign-off without the human's flag");
  const signed = m(dco, { certifyDco: true });
  assert.match(signed, /Assisted-by:/); assert.match(signed, /Signed-off-by: Alice Example <alice@example.org>/);
  assert.throws(() => buildCommitMessage({ title: "t", issueNumber: 7, spec: dco, flags: { certifyDco: true }, user: { ...USER, name: "Eve <x@y>" }, model: "m" }));
  assert.throws(() => buildCommitMessage({ title: "t", issueNumber: 7, spec: dco, flags: { certifyDco: true }, user: { ...USER, email: "nope" }, model: "m" }));
  assert.ok(!/[\r]|Co-authored/.test(m(SPEC(), {})));
});
test("PR body: the human's text, the project's disclosure line, the issue ref, the note, the marker; no links", () => {
  const record = { recordSha: "r".repeat(64), harness: { commit: "h".repeat(40) } };
  const body = buildPrBody({ description: "I added a test for the empty case because the helper had none.", spec: SPEC(), issueNumber: 7, record, sentence: "I read it for issue 7.", specBlobSha: "s".repeat(40) });
  assert.match(body, /AI assistance: yes/); assert.match(body, /Refs #7/); assert.match(body, /Submitter's note: I read it for issue 7\./);
  assert.match(body, new RegExp(`<!-- ${MARKER_PREFIX} run=${"r".repeat(64)} harness=${"h".repeat(40)} spec=${"s".repeat(40)} -->`));
  assert.ok(!/https?:\/\//.test(body), "no links in the body the tool adds");
  assert.ok(!/AI assistance: yes/.test(buildPrBody({ description: "I added a test for the empty case because the helper had none.", spec: SPEC({ disclosure: { mechanism: "commit_trailer" } }), issueNumber: 7, record, sentence: "x issue 7", specBlobSha: "s".repeat(40) })));
});

function repo() {
  const dir = tmp(); const gg = (...a) => spawnSync("/usr/bin/git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: dir, encoding: "utf8" });
  gg("init", "-q"); mkdirSync(join(dir, "tests"), { recursive: true }); writeFileSync(join(dir, "tests/old.test.ts"), "a\nb\n"); writeFileSync(join(dir, "README.md"), "hi\n"); gg("add", "."); gg("commit", "-qm", "base");
  return { dir, gg, base: gg("rev-parse", "HEAD").stdout.trim() };
}
const WHEN = "2026-10-11T10:00:00Z";
const AUTHOR = { name: "Alice Example", email: "alice@example.org" };

test("the commit is rebuilt from base + recorded bytes: right tree, parent, author, dates, and deterministic", () => {
  const { dir, gg, base } = repo();
  const files = { "tests/new.test.ts": "export {}\n", "tests/old.test.ts": "a\nB\n" };
  const a = buildCommit({ repoDir: dir, base, files, message: "test: x\n\nRefs #7\n", author: AUTHOR, when: WHEN });
  const b = buildCommit({ repoDir: dir, base, files, message: "test: x\n\nRefs #7\n", author: AUTHOR, when: WHEN });
  assert.equal(a.sha, b.sha, "deterministic: dry run and real publish give the same commit");
  assert.match(gg("cat-file", "-p", a.sha).stdout, new RegExp(`parent ${base}\\nauthor Alice Example <alice@example.org> ${Date.parse(WHEN) / 1000} \\+0000\\ncommitter Alice Example <alice@example.org> ${Date.parse(WHEN) / 1000} \\+0000`));
  assert.equal(gg("rev-parse", `${a.sha}:tests/new.test.ts`).stdout.trim(), gitBlobId("export {}\n"));
  assert.equal(gg("rev-parse", `${a.sha}:tests/old.test.ts`).stdout.trim(), gitBlobId("a\nB\n"));
  assert.equal(gg("rev-parse", `${a.sha}:README.md`).stdout.trim(), gg("rev-parse", `${base}:README.md`).stdout.trim(), "untouched files come from the base");
  assert.notEqual(buildCommit({ repoDir: dir, base, files, message: "other\n", author: AUTHOR, when: WHEN }).sha, a.sha);
});
test("building the commit ignores the working tree and leaves HEAD, the index and the tree alone", () => {
  const { dir, gg, base } = repo();
  writeFileSync(join(dir, "README.md"), "LOCAL EDIT\n"); writeFileSync(join(dir, "untracked.txt"), "x"); gg("add", "README.md");
  const before = [gg("status", "--porcelain").stdout, gg("rev-parse", "HEAD").stdout, gg("ls-files", "-s").stdout];
  const c = buildCommit({ repoDir: dir, base, files: { "tests/new.test.ts": "export {}\n" }, message: "m\n", author: AUTHOR, when: WHEN });
  assert.deepEqual([gg("status", "--porcelain").stdout, gg("rev-parse", "HEAD").stdout, gg("ls-files", "-s").stdout], before);
  assert.equal(gg("show", `${c.sha}:README.md`).stdout, "hi\n", "the local edit is not in the commit");
  assert.ok(!gg("ls-tree", "-r", "--name-only", c.sha).stdout.includes("untracked.txt"));
  assert.ok(!existsSync(join(dir, "tests/new.test.ts")), "nothing was written to the working tree");
});
test("a base that is not in the repository fails instead of committing something else", () => {
  const { dir } = repo();
  assert.throws(() => buildCommit({ repoDir: dir, base: "0".repeat(40), files: { "a.ts": "x" }, message: "m\n", author: AUTHOR, when: WHEN }), /git read-tree failed/);
});

test("the approval token changes with every bound value", () => {
  const bound = { repoId: 1, ownerId: 2, base: "b", head: "h", specBlobSha: "s", recordSha: "r", issueNumber: 7, user: { login: "alice", id: 1, name: "A", email: "a@x.org" }, specCommit: "c" };
  const base = { bound, commitSha: "c1", title: "t", body: "b", branch: "agent/7-x", sentence: "I read it for issue 7 and it adds a test" };
  const t0 = approvalToken(base);
  assert.equal(approvalToken(structuredClone(base)), t0, "stable");
  const variants = [
    { bound: { ...bound, repoId: 2 } }, { bound: { ...bound, ownerId: 3 } }, { bound: { ...bound, base: "b2" } }, { bound: { ...bound, head: "h2" } }, { bound: { ...bound, specBlobSha: "s2" } },
    { bound: { ...bound, recordSha: "r2" } }, { bound: { ...bound, issueNumber: 8 } }, { bound: { ...bound, user: { ...bound.user, email: "e@x.org" } } }, { bound: { ...bound, user: { ...bound.user, id: 2 } } },
    { commitSha: "c2" }, { title: "t2" }, { body: "b2" }, { branch: "agent/8-x" }, { sentence: "I read a different thing for issue 7 and it adds a test" },
  ];
  for (const v of variants) assert.notEqual(approvalToken({ ...base, ...v }), t0, JSON.stringify(Object.keys(v)) + JSON.stringify(v).slice(0, 60));
  assert.match(t0, /^[a-f0-9]{32}$/);
});

test("the parent is the RECORDED base even when the local HEAD has moved on", () => {
  const { dir, gg, base } = repo();
  writeFileSync(join(dir, "README.md"), "moved\n"); gg("commit", "-qam", "later local commit");
  assert.notEqual(gg("rev-parse", "HEAD").stdout.trim(), base);
  const c = buildCommit({ repoDir: dir, base, files: { "tests/new.test.ts": "export {}\n" }, message: "m\n", author: AUTHOR, when: WHEN });
  assert.match(gg("cat-file", "-p", c.sha).stdout, new RegExp(`parent ${base}\\n`));
  assert.equal(gg("show", `${c.sha}:README.md`).stdout, "hi\n", "the later local commit is not in it");
});
