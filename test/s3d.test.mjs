import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROFILES, validateProfile, resolveProfile, testRelative, expandChecks } from "../src/profile.mjs";
import { buildRecord, verifyRecord, publishProblems, gitBlobId, sha256 } from "../src/record.mjs";
import { qualifyRuntime, loadPin, parseTap, MIN_ESCAPE_PASS } from "../src/pin.mjs";
import { skippedByCopy, copyFromGit, resolveBase, attributeProblems } from "../src/sourcecopy.mjs";
import { applyFiles } from "../src/verify.mjs";
import { cleanup } from "../src/hygiene.mjs";
import { tmp } from "./helpers.mjs";

// ---- profiles
test("the shipped profiles are valid", () => { for (const p of Object.values(PROFILES)) assert.deepEqual(validateProfile(p), []); });
const badProfile = {
  "a shell executable": (p) => (p.checks[0].argv = ["sh", "-c", "curl x | sh"]),
  "a path outside .bin": (p) => (p.checks[0].argv = ["/usr/bin/curl", "x"]),
  "an unknown placeholder": (p) => p.checks[1].argv.push("{secret}"),
  "a NUL in argv": (p) => p.checks[0].argv.push("a\0b"),
  "subdir escaping": (p) => (p.subdir = "../x"),
  "absolute subdir": (p) => (p.subdir = "/etc"),
  "unknown testCheck": (p) => (p.testCheck = "nope"),
  "duplicate check name": (p) => (p.checks[1].name = "tsc"),
  "no checks": (p) => (p.checks = []),
};
for (const [name, fn] of Object.entries(badProfile)) test(`profile refused: ${name}`, () => { const p = structuredClone(PROFILES.node); fn(p); assert.ok(validateProfile(p).length > 0); });
test("test paths: plain, inside the subdir, never an option or traversal", () => {
  assert.equal(testRelative(PROFILES.node, "orchestrator/src/a.test.ts"), "src/a.test.ts");
  for (const bad of ["../x.ts", "orchestrator/../x.ts", "src/a.test.ts", "-rf", "orchestrator/a b.ts", "orchestrator/$(x).ts"]) assert.throws(() => testRelative(PROFILES.node, bad), /test path/);
  assert.deepEqual(expandChecks(PROFILES.python, "t/test_a.py")[0].argv.slice(-1), ["t/test_a.py"]);
});
test("a profile file is validated like a built-in", () => {
  const f = join(tmp(), "p.json"); writeFileSync(f, JSON.stringify({ ...PROFILES.node, checks: [{ name: "x", argv: ["bash", "-c", "id"] }], testCheck: "x" }));
  assert.throws(() => resolveProfile(f), /profile refused/);
});

// ---- run record
const rec = (over = {}) => buildRecord({ harness: { commit: "h" }, project: { dir: "p" }, base: "a".repeat(40), source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files: { "src/a.test.ts": "export {}\n" }, checks: [{ name: "tsc", status: 0 }], ...over });
test("git blob ids match git's own", () => {
  const dir = tmp(); spawnSync("/usr/bin/git", ["init", "-q"], { cwd: dir }); writeFileSync(join(dir, "f"), "hello\n");
  const r = spawnSync("/usr/bin/git", ["hash-object", "f"], { cwd: dir, encoding: "utf8" });
  assert.equal(gitBlobId("hello\n"), r.stdout.trim());
});
test("a consistent record verifies, and any edit is caught", () => {
  assert.deepEqual(verifyRecord(rec()), []);
  const a = rec(); a.files["src/a.test.ts"].content = "evil\n"; assert.ok(verifyRecord(a).length > 0);
  const b = rec(); b.base = "b".repeat(40); assert.match(verifyRecord(b).join(), /edited after/);
  const c = rec(); c.files["src/a.test.ts"].sha256 = sha256("evil\n"); assert.ok(verifyRecord(c).length > 0);
});
test("with a tree, the files on disk must equal what was checked", () => {
  const dir = tmp(); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src/a.test.ts"), "export {}\n");
  assert.deepEqual(verifyRecord(rec(), { treeDir: dir }), []);
  writeFileSync(join(dir, "src/a.test.ts"), "export {} // changed\n");
  assert.match(verifyRecord(rec(), { treeDir: dir }).join(), /differs from what was checked/);
  assert.match(verifyRecord(rec(), { treeDir: tmp() }).join(), /missing/);
});
test("publishable only when containerised, from a recorded commit, escape-qualified, dep-matched and green", () => {
  assert.deepEqual(publishProblems(rec()), []);
  const cases = { "host run": { container: false }, "worktree copy": { source: "working-tree-copy" }, "no base": { base: null }, "no pin": { pin: null }, "failed escape suite": { pin: { escapeSuite: { fail: 1 } } }, "dep mismatch": { dep: { matched: false } }, "a failing check": { checks: [{ name: "t", status: 1 }] }, "a timeout": { checks: [{ name: "t", status: 0, timedOut: true }] }, "no checks": { checks: [] } };
  for (const [n, o] of Object.entries(cases)) assert.ok(publishProblems(rec(o)).length > 0, n);
});

// ---- pin
test("the pin is written only when the escape suite is green and big enough", () => {
  const docker = join(tmp(), "docker"); writeFileSync(docker, '#!/bin/sh\necho "e|k|o"\n', { mode: 0o755 });
  const out = join(tmp(), "pin.json");
  assert.equal(qualifyRuntime({ docker, runSuite: () => ({ pass: 20, fail: 1, skipped: 0 }), out }).ok, false);
  assert.equal(qualifyRuntime({ docker, runSuite: () => ({ pass: MIN_ESCAPE_PASS - 1, fail: 0, skipped: 0 }), out }).ok, false);
  assert.equal(qualifyRuntime({ docker, runSuite: () => ({ pass: NaN, fail: NaN, skipped: 0 }), out }).ok, false, "unparseable output fails closed");
  assert.ok(!existsSync(out));
  const q = qualifyRuntime({ docker, runSuite: () => ({ pass: 15, fail: 0, skipped: 1 }), out });
  assert.equal(q.ok, true);
  assert.deepEqual(loadPin(out).escapeSuite, { pass: 15, fail: 0, skipped: 1 });
});
test("a missing or incomplete pin refuses", () => {
  assert.throws(() => loadPin(join(tmp(), "none.json")), /no runtime pin/);
  const f = join(tmp(), "p.json"); writeFileSync(f, '{"engine":"e"}'); assert.throws(() => loadPin(f), /incomplete/);
});
test("TAP summary parsing", () => assert.deepEqual(parseTap("# tests 3\n# pass 2\n# fail 1\n# skipped 0\n"), { pass: 2, fail: 1, skipped: 0 }));

// ---- one filter for apply and copy
test("applyFiles refuses paths the verified copy would leave out", () => {
  for (const p of [".env", "src/.env.local", "dist/a.test.ts", "a/node_modules/x.test.ts", "id_rsa", "key.pem", ".npmrc"]) {
    assert.equal(skippedByCopy(p), true, p);
    assert.throws(() => applyFiles({ root: tmp(), files: { [p]: "x" }, allowed: [p] }), /refusing/);
  }
  assert.equal(skippedByCopy("src/a.test.ts"), false);
});

// ---- source from a recorded commit
function gitRepo() {
  const dir = tmp(); const g = (...a) => spawnSync("/usr/bin/git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q"); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src/a.ts"), "committed\n"); g("add", "."); g("commit", "-qm", "c");
  return { dir, g };
}
test("the copy is the recorded commit, not the working tree", () => {
  const { dir } = gitRepo(); const base = resolveBase(dir);
  writeFileSync(join(dir, "src/a.ts"), "LOCAL EDIT\n"); writeFileSync(join(dir, "untracked.txt"), "x");
  const { dir: copy } = copyFromGit(dir, base);
  assert.equal(readFileSync(join(copy, "src/a.ts"), "utf8"), "committed\n");
  assert.ok(!existsSync(join(copy, "untracked.txt")));
  assert.equal(resolveBase(tmp()), null, "not a git repo");
});
test("git attributes that would change the bytes on add are refused", () => {
  const { dir } = gitRepo();
  writeFileSync(join(dir, ".gitattributes"), "*.ts filter=lfs\n*.py text eol=lf\n");
  assert.match(attributeProblems(dir, { "src/b.ts": "x" }).join(), /filter=lfs/);
  assert.deepEqual(attributeProblems(dir, { "src/b.py": "x\n" }), []);
  assert.match(attributeProblems(dir, { "src/b.py": "x\r\n" }).join(), /contains CR/);
  assert.deepEqual(attributeProblems(dir, { "src/b.txt": "x\r\n" }), []);
});

// ---- hygiene
test("cleanup removes only labelled containers and never prunes", () => {
  const log = join(tmp(), "log"), docker = join(tmp(), "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in ps) echo abc123def456;; images) echo 0123456789ab;; esac\n`, { mode: 0o755 });
  assert.deepEqual(cleanup({ docker, images: true }), { containers: 1, images: 1 });
  const lines = readFileSync(log, "utf8");
  assert.match(lines, /ps -aq --filter label=cc\.run/);
  assert.match(lines, /rm -fv abc123def456/);
  assert.match(lines, /images -q --filter label=cc\.lock/);
  assert.ok(!/prune/.test(lines));
  assert.deepEqual(cleanup({ docker }), { containers: 1, images: 0 });
});

// ---- verifier: the dependency image must come from THIS project's dependency file
import { matchDepImage, runProfileChecks } from "../src/verifier.mjs";
import { depSha } from "../src/depimage.mjs";
function fakeDocker(label) { const f = join(tmp(), "docker"); writeFileSync(f, `#!/bin/sh\nif [ "$1" = image ]; then echo "${label}"; exit 0; fi\nexit 1\n`, { mode: 0o755 }); return f; }
test("verifier: matches only when the image label equals the hash of the project's dependency file", () => {
  const src = tmp(); mkdirSync(join(src, "orchestrator"), { recursive: true }); writeFileSync(join(src, "orchestrator/package-lock.json"), "LOCK");
  assert.equal(matchDepImage({ docker: fakeDocker(depSha("LOCK")), image: "x", srcDir: src, profile: PROFILES.node }).matched, true);
  assert.equal(matchDepImage({ docker: fakeDocker("deadbeefdead"), image: "x", srcDir: src, profile: PROFILES.node }).matched, false);
  assert.equal(matchDepImage({ docker: fakeDocker(""), image: "x", srcDir: src, profile: PROFILES.node }).matched, false, "an image with no label never matches");
  assert.equal(matchDepImage({ docker: fakeDocker(depSha("LOCK")), image: "x", srcDir: tmp(), profile: PROFILES.node }).matched, false, "no dependency file in the source");
});
test("verifier: a mismatch refuses before any container is created", () => {
  const src = tmp(); mkdirSync(join(src, "orchestrator"), { recursive: true }); writeFileSync(join(src, "orchestrator/package-lock.json"), "LOCK");
  const r = runProfileChecks({ docker: fakeDocker("deadbeefdead"), image: "x", pin: {}, srcDir: src, profile: PROFILES.node, testPath: "orchestrator/src/a.test.ts" });
  assert.equal(r.ran, false); assert.match(r.refused, /does not match the project/);
});
