import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, runMutations, validateMutations } from "../src/mutate.mjs";
import { tmp } from "./helpers.mjs";

const SRC = 'export const f = (x) => x > 1;\nexport const g = (x) => x === "a";\n';
function setup() {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/m.js"), SRC);
  return root;
}
// A fake "test run": passes only while f(2) is true and g("a") is true.
const fakeRun = (root) => () => {
  const t = readFileSync(join(root, "src/m.js"), "utf8");
  if (/\(\(/.test(t)) return { ok: false, output: "SyntaxError: Unexpected token" };
  const f = t.includes("x > 1");
  const g = t.includes('x === "a"');
  return f && g ? { ok: true, output: "" } : { ok: false, output: `AssertionError: expected true` };
};

test("classify separates a behavioural failure from a mutant that does not build", () => {
  assert.equal(classify({ ok: true, output: "" }), "survived");
  assert.equal(classify({ ok: false, output: "AssertionError: expected 1 to be 2" }), "caught");
  assert.equal(classify({ ok: false, output: "Transform failed with 1 error: Unexpected token" }), "broke-build");
  assert.equal(classify({ ok: false, output: "src/x.ts(3,1): error TS2304: Cannot find name" }), "broke-build");
});

test("caught, survived, broke-build and skipped are reported separately, and the file is restored byte-identical", () => {
  const root = setup();
  const res = runMutations({
    root, sourcePath: "src/m.js", runTest: fakeRun(root),
    mutations: [
      { id: "flip-f", old: "x > 1", new: "x < 1" },
      { id: "narrow-g", old: 'x === "a"', new: 'x === "a" /* harmless */' }, // test cannot tell: survives
      { id: "syntax", old: "x > 1", new: "((x > 1" },
      { id: "absent", old: "nope", new: "z" },
    ],
  });
  const by = Object.fromEntries(res.results.map((r) => [r.id, r.outcome]));
  assert.deepEqual(by, { "flip-f": "caught", "narrow-g": "survived", syntax: "broke-build", absent: "skipped" });
  assert.equal(res.caught, 1);
  assert.equal(res.survived, 1);
  assert.equal(res.brokeBuild, 1);
  assert.equal(res.skipped, 1);
  assert.ok(res.restored);
  assert.equal(readFileSync(join(root, "src/m.js"), "utf8"), SRC);
});

test("a pattern that occurs more than once is skipped, never guessed at", () => {
  const root = setup();
  const res = runMutations({ root, sourcePath: "src/m.js", runTest: fakeRun(root), mutations: [{ id: "dup", old: "x", new: "y" }] });
  assert.equal(res.results[0].outcome, "skipped");
  assert.match(res.results[0].reason, /\d+ times/);
});

test("refuses to run if the test already fails on the UNMUTATED source", () => {
  const root = setup();
  assert.throws(() => runMutations({ root, sourcePath: "src/m.js", runTest: () => ({ ok: false, output: "x" }), mutations: [{ id: "a", old: "x > 1", new: "x < 1" }] }), /UNMUTATED/);
  assert.equal(readFileSync(join(root, "src/m.js"), "utf8"), SRC);
});

test("the source is restored even if the test runner throws mid-mutation", () => {
  const root = setup();
  let n = 0;
  const boom = () => { n += 1; if (n === 2) throw new Error("runner exploded"); return { ok: true, output: "" }; };
  assert.throws(() => runMutations({ root, sourcePath: "src/m.js", runTest: boom, mutations: [{ id: "a", old: "x > 1", new: "x < 1" }] }), /exploded/);
  assert.equal(readFileSync(join(root, "src/m.js"), "utf8"), SRC);
});

test("validateMutations rejects malformed, no-op and duplicate entries", () => {
  assert.throws(() => validateMutations({}), /array/);
  assert.throws(() => validateMutations([{ id: "a", old: "x" }]), /bad mutation/);
  assert.throws(() => validateMutations([{ id: "a", old: "x", new: "x" }]), /identical/);
  assert.throws(() => validateMutations([{ id: "a", old: "x", new: "y" }, { id: "a", old: "p", new: "q" }]), /duplicate/);
  assert.equal(validateMutations([{ id: "a", old: "x", new: "y" }]).length, 1);
});

test("classify: a Python mutant that breaks the module at import or collection is broke-build, not caught", () => {
  for (const out of [
    "E   IndentationError: unexpected indent",
    "E   SyntaxError: invalid syntax",
    "E   TabError: inconsistent use of tabs and spaces in indentation",
    "ERROR tests/test_a.py - ImportError: cannot import name 'x' from 'pkg'",
    "!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!",
    "!!!!!!!!!! Interrupted: 3 errors during collection !!!!!!!!!!",
    "ERROR collecting tests/test_a.py",
  ]) assert.equal(classify({ ok: false, output: out }), "broke-build", out);
});
test("classify: an ordinary Python test failure is still caught", () => {
  assert.equal(classify({ ok: false, output: "FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed, 3 passed" }), "caught");
  assert.equal(classify({ ok: false, output: "E   NameError: name 'y' is not defined\n1 failed" }), "caught");
});

// A file rewritten IN PLACE can be read stale by a container through a bind mount (the size attribute is cached): a longer
// mutant is seen truncated and misreported as a build break. Found on a real run (toolz). Each mutant is therefore written to
// a NEW file and renamed over the source, and the restore is done the same way. A hard link to the original inode tells the
// two apart: an in-place write changes what the link sees, a rename does not.
test("a mutant is swapped in as a NEW file, never written in place", () => {
  const root = setup();
  const abs = join(root, "src/m.js");
  linkSync(abs, join(root, "src/m.keep"));
  const seen = [];
  const out = runMutations({
    root, sourcePath: "src/m.js",
    mutations: [{ id: "a", old: "x > 1", new: "x >= 1" }, { id: "b", old: 'x === "a"', new: 'x !== "a"' }],
    runTest: () => { seen.push({ mutated: readFileSync(abs, "utf8"), link: readFileSync(join(root, "src/m.keep"), "utf8") }); return fakeRun(root)(); },
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[1].mutated.includes("x >= 1"), true, "the mutant was in place for the run");
  for (const s of seen) assert.equal(s.link, SRC, "the original inode was never written to");
  assert.equal(out.restored, true);
  assert.equal(readFileSync(abs, "utf8"), SRC);
});
test("a stray temporary file is never left behind", () => {
  const root = setup();
  runMutations({ root, sourcePath: "src/m.js", mutations: [{ id: "a", old: "x > 1", new: "x >= 1" }], runTest: fakeRun(root) });
  assert.deepEqual(readdirSync(join(root, "src")).sort(), ["m.js"]);
});

test("the source file keeps its permissions through the swap and the restore", () => {
  const root = setup();
  const abs = join(root, "src/m.js");
  chmodSync(abs, 0o755);
  let modeDuring;
  runMutations({ root, sourcePath: "src/m.js", mutations: [{ id: "a", old: "x > 1", new: "x >= 1" }], runTest: () => { modeDuring = statSync(abs).mode & 0o777; return fakeRun(root)(); } });
  assert.equal(modeDuring, 0o755);
  assert.equal(statSync(abs).mode & 0o777, 0o755);
});
test("a symlinked source is refused rather than replaced by a plain file", () => {
  const root = setup();
  symlinkSync(join(root, "src/m.js"), join(root, "src/link.js"));
  assert.throws(() => runMutations({ root, sourcePath: "src/link.js", mutations: [{ id: "a", old: "x > 1", new: "x >= 1" }], runTest: fakeRun(root) }), /symlink/);
  assert.equal(readFileSync(join(root, "src/m.js"), "utf8"), SRC);
});
