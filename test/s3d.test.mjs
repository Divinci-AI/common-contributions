import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROFILES, validateProfile, resolveProfile, testRelative, expandChecks } from "../src/profile.mjs";
import { buildRecord, verifyRecord, publishProblems, gitBlobId, sha256, harnessIdentity, issueHash, loadOrCreateKey } from "../src/record.mjs";
import { qualifyRuntime, loadPin, parseTap, MIN_ESCAPE_PASS } from "../src/pin.mjs";
import { skippedByCopy, copyFromGit, resolveBase, attributeProblems, baseModeProblems } from "../src/sourcecopy.mjs";
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
const KEY = "k".repeat(64);
const TREE = "t".repeat(64);
const rec = (over = {}) => buildRecord({ harness: { commit: "h", dirty: false, srcTreeHash: TREE }, project: { dir: "p" }, origin: "github.com/o/r", issue: { number: 7, sha256: issueHash("t", "b") }, base: "a".repeat(40), source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files: { "src/a.test.ts": "export {}\n" }, checks: [{ name: "tsc", status: 0 }], key: KEY, ...over });
const OPTS = { key: KEY, reviewedTrees: [TREE] };
test("git blob ids match git's own", () => {
  const dir = tmp(); spawnSync("/usr/bin/git", ["init", "-q"], { cwd: dir }); writeFileSync(join(dir, "f"), "hello\n");
  const r = spawnSync("/usr/bin/git", ["hash-object", "f"], { cwd: dir, encoding: "utf8" });
  assert.equal(gitBlobId("hello\n"), r.stdout.trim());
});
test("a consistent record verifies, and any edit is caught", () => {
  assert.deepEqual(verifyRecord(rec(), { key: KEY }), []);
  const a = rec(); a.files["src/a.test.ts"].content = "evil\n"; assert.ok(verifyRecord(a).length > 0);
  const b = rec(); b.base = "b".repeat(40); assert.match(verifyRecord(b).join(), /edited after/);
  const c = rec(); c.files["src/a.test.ts"].sha256 = sha256("evil\n"); assert.ok(verifyRecord(c).length > 0);
});
test("the MAC stops a hand-edited record that was re-hashed, and a record from another install", () => {
  const forged = rec(); forged.files["src/a.test.ts"] = { ...forged.files["src/a.test.ts"], content: "evil\n", sha256: sha256("evil\n"), blob: gitBlobId("evil\n") };
  const { recordSha: _drop, mac: _m, ...body } = forged; // an editor who recomputes recordSha still has no key
  const reh = buildRecord({ ...forged, files: { "src/a.test.ts": "evil\n" }, key: undefined });
  assert.match(verifyRecord(reh, { key: KEY }).join(), /MAC/);
  assert.match(verifyRecord(rec(), { key: "x".repeat(64) }).join(), /MAC/);
});
test("with a tree, the files on disk must equal what was checked", () => {
  const dir = tmp(); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src/a.test.ts"), "export {}\n");
  assert.deepEqual(verifyRecord(rec(), { treeDir: dir }), []);
  writeFileSync(join(dir, "src/a.test.ts"), "export {} // changed\n");
  assert.match(verifyRecord(rec(), { treeDir: dir }).join(), /differs from what was checked/);
  assert.match(verifyRecord(rec(), { treeDir: tmp() }).join(), /missing/);
});
test("publishable only when containerised, from a recorded commit, escape-qualified, dep-matched, green, fresh, MAC-valid, from reviewed harness source and bound to an issue", () => {
  assert.deepEqual(publishProblems(rec(), OPTS), []);
  const cases = {
    "host run": { container: false }, "worktree copy": { source: "working-tree-copy" }, "no base": { base: null }, "no pin": { pin: null },
    "failed escape suite": { pin: { escapeSuite: { fail: 1 } } }, "dep mismatch": { dep: { matched: false } }, "a failing check": { checks: [{ name: "t", status: 1 }] },
    "a timeout": { checks: [{ name: "t", status: 0, timedOut: true }] }, "no checks": { checks: [] },
    "dirty harness": { harness: { commit: "h", dirty: true, srcTreeHash: TREE } }, "unknown dirty state": { harness: { commit: "h", dirty: null, srcTreeHash: TREE } },
    "unreviewed harness source": { harness: { commit: "h", dirty: false, srcTreeHash: "u".repeat(64) } }, "no issue binding": { issue: null }, "no origin": { origin: null },
    "no MAC": { key: undefined },
  };
  for (const [n, o] of Object.entries(cases)) assert.ok(publishProblems(rec(o), OPTS).length > 0, n);
  assert.ok(publishProblems(rec(), { ...OPTS, now: Date.now() + 25 * 3600 * 1000 }).length > 0, "older than 24 h");
  assert.ok(publishProblems(rec(), { ...OPTS, now: Date.now() - 3600 * 1000 }).length > 0, "from the future");
  assert.ok(publishProblems(rec(), { reviewedTrees: [TREE] }).length > 0, "no install key");
});
test("harnessIdentity: a dirty src/ and a changed src/ are visible", () => {
  const { dir, g } = gitRepo(); mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src/x.mjs"), "1\n"); g("add", "-A"); g("commit", "-qm", "x");
  const a = harnessIdentity(dir); assert.equal(a.dirty, false); assert.match(a.commit, /^[a-f0-9]{40}$/);
  writeFileSync(join(dir, "src/x.mjs"), "2\n");
  const b = harnessIdentity(dir); assert.equal(b.dirty, true); assert.notEqual(a.srcTreeHash, b.srcTreeHash);
  assert.equal(harnessIdentity(dir).srcTreeHash, b.srcTreeHash, "stable");
});
test("the install key is created once, 0600, and reused", () => {
  const d = tmp(); assert.equal(loadOrCreateKey(d, { create: false }), null);
  const k = loadOrCreateKey(d); assert.match(k, /^[a-f0-9]{64}$/); assert.equal(loadOrCreateKey(d), k);
  assert.equal(statSync(join(d, "record.key")).mode & 0o777, 0o600);
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
test("git attributes (read from the BASE commit) that would change the bytes on add are refused", () => {
  const { dir, g } = gitRepo();
  writeFileSync(join(dir, ".gitattributes"), "*.ts filter=lfs\n*.py text eol=lf\n"); g("add", "."); g("commit", "-qm", "attrs");
  const base = resolveBase(dir);
  assert.match(attributeProblems(dir, { "src/b.ts": "x" }, base).join(), /filter=lfs/);
  assert.deepEqual(attributeProblems(dir, { "src/b.py": "x\n" }, base), []);
  assert.match(attributeProblems(dir, { "src/b.py": "x\r\n" }, base).join(), /contains CR/);
  assert.deepEqual(attributeProblems(dir, { "src/b.txt": "x\r\n" }, base), []);
  // An uncommitted edit to .gitattributes in the working tree is not what upstream has: it must not change the answer.
  writeFileSync(join(dir, ".gitattributes"), "");
  assert.match(attributeProblems(dir, { "src/b.ts": "x" }, base).join(), /filter=lfs/);
});

test("the copy is the tree byte for byte: export-ignore, export-subst, CRLF, modes and symlinks all survive", () => {
  const { dir, g } = gitRepo();
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests/a.test.ts"), "t\n");
  writeFileSync(join(dir, "ver.txt"), "$Format:%H$\n");
  writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("src/a.ts", join(dir, "link.ts"));
  writeFileSync(join(dir, ".gitattributes"), "tests export-ignore\nver.txt export-subst\ncrlf.txt text eol=lf\n");
  g("add", "-A"); g("commit", "-qm", "x");
  const base = resolveBase(dir);
  const { dir: copy } = copyFromGit(dir, base);
  assert.ok(existsSync(join(copy, "tests/a.test.ts")), "export-ignore does not remove files from the checked copy");
  assert.equal(readFileSync(join(copy, "ver.txt"), "utf8"), "$Format:%H$\n", "export-subst is not applied");
  // `git add` normalised the CRLF to LF into the blob (text eol=lf); the copy must be that blob, not a re-converted checkout.
  assert.equal(readFileSync(join(copy, "crlf.txt"), "utf8"), "a\nb\n", "the blob, byte for byte");
  assert.equal(statSync(join(copy, "run.sh")).mode & 0o111, 0o111);
  assert.equal(lstatSync(join(copy, "link.ts")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(copy, "src/a.ts"), "utf8"), "committed\n");
});

test("paths whose base mode is not a plain file are refused", () => {
  const { dir, g } = gitRepo();
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 }); symlinkSync("src/a.ts", join(dir, "link.ts")); g("add", "-A"); g("commit", "-qm", "m");
  const base = resolveBase(dir);
  assert.deepEqual(baseModeProblems(dir, base, ["src/a.ts", "src/new.ts"]), []);
  assert.match(baseModeProblems(dir, base, ["run.sh"]).join(), /100755/);
  assert.match(baseModeProblems(dir, base, ["link.ts"]).join(), /120000/);
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
