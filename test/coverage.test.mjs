import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coverageReport, exportedNames, importsModule, listTestFiles, unacknowledgedTests } from "../src/coverage.mjs";
import { tmp } from "./helpers.mjs";

const repo = () => {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  writeFileSync(join(root, "src/prov.ts"), "export const SOURCES = [];\nexport function isSource(v) { return 1; }\nexport function inferSource() {}\nexport type T = string;\nexport interface I {}\n");
  return root;
};

test("exportedNames lists values, not types or interfaces, and handles export { a as b }", () => {
  assert.deepEqual(exportedNames("export const A = 1;\nexport async function b() {}\nexport class C {}\nexport type T = 1;\nexport interface I {}\nexport { d, e as f };").sort(), ["A", "C", "b", "d", "f"]);
});

test("importsModule matches relative specifiers with or without extension, any quote, and rejects lookalikes", () => {
  assert.ok(importsModule('import { x } from "./prov.js";', "prov"));
  assert.ok(importsModule("import { x } from '../src/prov';", "prov"));
  assert.ok(importsModule('const m = await import("./prov.ts");', "prov"));
  assert.ok(!importsModule('import { x } from "./provenance.js";', "prov"), "a longer name is a different module");
  assert.ok(!importsModule('import { x } from "prov";', "prov"), "a bare package name is not our module");
  assert.ok(!importsModule("// see ./prov.js for details", "prov"));
});

test("a test that imports the module counts; names are matched only inside those files", () => {
  const root = repo();
  writeFileSync(join(root, "src/a.test.ts"), 'import { isSource } from "./prov.js";\nit("x", () => isSource(1));');
  writeFileSync(join(root, "src/unrelated.test.ts"), 'it("inferSource is just a word here", () => {});'); // mentions a name but does NOT import
  const rep = coverageReport({ root, modulePath: "src/prov.ts" });
  assert.deepEqual(rep.referencingTests, ["src/a.test.ts"]);
  const by = Object.fromEntries(rep.exports.map((e) => [e.name, e.referencedIn]));
  assert.deepEqual(by.isSource, ["src/a.test.ts"]);
  assert.deepEqual(by.inferSource, []);
  assert.deepEqual(by.SOURCES, []);
});

test("the module's own would-be test file is excluded, and node_modules is never scanned", () => {
  const root = repo();
  writeFileSync(join(root, "src/prov.test.ts"), 'import { isSource } from "./prov.js";');
  writeFileSync(join(root, "node_modules/x/n.test.ts"), 'import { isSource } from "./prov.js";');
  const rep = coverageReport({ root, modulePath: "src/prov.ts", allowed: ["src/prov.test.ts"] });
  assert.deepEqual(rep.referencingTests, []);
  assert.ok(!listTestFiles(root).some((f) => f.includes("node_modules")));
});

test("an untested module yields no referencing tests", () => {
  assert.deepEqual(coverageReport({ root: repo(), modulePath: "src/prov.ts" }).referencingTests, []);
});

test("unacknowledgedTests: an issue must NAME every existing test that imports the module", () => {
  const rep = { referencingTests: ["orchestrator/src/source-yield.test.ts", "orchestrator/src/other.test.ts"] };
  assert.deepEqual(unacknowledgedTests(rep, "no mention at all"), rep.referencingTests);
  assert.deepEqual(unacknowledgedTests(rep, "Existing: `source-yield.test.ts` covers X."), ["orchestrator/src/other.test.ts"]);
  assert.deepEqual(unacknowledgedTests(rep, "see orchestrator/src/source-yield.test.ts and other.test.ts"), []);
  assert.deepEqual(unacknowledgedTests({ referencingTests: [] }, ""), []);
});

// ---- indirect coverage: a test that reaches the module only THROUGH other files (fixtures, an index, a package __init__) ----
// Found on a real project: a spec covering 98% of attributes.ts imports only a fixtures file, which loads the index, which loads
// attributes.ts. The gate reported "no tests", which is the exact mistake it exists to prevent (an issue filed for a module that
// already has tests). A test counts as INDIRECT when it reaches the module by relative imports AND uses an export in call or
// member form (a common word in a comment must not count).
import { exportedNamesPython, importGraphReach, INDIRECT_ASK } from "../src/coverage.mjs";

const put = (root, rel, text) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
const jsRepo = () => {
  const root = tmp();
  put(root, "src/api/attributes.ts", "export function attr(name) {}\nexport function prop(name) {}\nexport function removeAttr(n) {}\nexport const NOTHING = 0;\n");
  put(root, "src/static.ts", "export * from './api/attributes.js';\n");
  put(root, "src/index.ts", "export { load } from './static.js';\nimport './api/attributes.js';\n");
  put(root, "src/__fixtures__/fixtures.ts", "import { load } from '../index.js';\nexport const $ = load('<p>');\n");
  return root;
};

test("a spec that reaches the module only through a fixtures file and an index is INDIRECT coverage", () => {
  const root = jsRepo();
  put(root, "src/api/attributes.spec.ts", "import { $ } from '../__fixtures__/fixtures.js';\nit('x', () => { $('p').attr('a'); $('p').prop('b'); });");
  const rep = coverageReport({ root, modulePath: "src/api/attributes.ts" });
  assert.deepEqual(rep.referencingTests, [], "it does not import the module directly");
  assert.equal(rep.indirectTests.length, 1);
  assert.equal(rep.indirectTests[0].test, "src/api/attributes.spec.ts");
  assert.deepEqual(rep.indirectTests[0].names.sort(), ["attr", "prop"]);
  assert.ok(rep.indirectTests[0].via.includes("src/index.ts"), "the chain is shown");
  const by = Object.fromEntries(rep.exports.map((e) => [e.name, e.referencedIn]));
  assert.deepEqual(by.attr, ["src/api/attributes.spec.ts"]);
  assert.deepEqual(by.removeAttr, [], "an export the spec never calls is not claimed");
});
test("reaching the module without using any of its exports in call or member form is not coverage", () => {
  const root = jsRepo();
  put(root, "src/api/other.spec.ts", "import { $ } from '../__fixtures__/fixtures.js';\n// attr is mentioned in a comment only\nit('y', () => { $('p'); });");
  assert.deepEqual(coverageReport({ root, modulePath: "src/api/attributes.ts" }).indirectTests, []);
});
test("a test that cannot reach the module is never reported, even if it calls a method of the same name", () => {
  const root = jsRepo();
  put(root, "src/lonely.spec.ts", "import { thing } from './lonely-helper.js';\nit('z', () => { thing.attr('a'); });");
  put(root, "src/lonely-helper.ts", "export const thing = { attr() {} };\n");
  const rep = coverageReport({ root, modulePath: "src/api/attributes.ts" });
  assert.deepEqual(rep.indirectTests, []); assert.deepEqual(rep.referencingTests, []);
});
test("a direct importer stays in referencingTests and is not repeated as indirect", () => {
  const root = jsRepo();
  put(root, "src/api/direct.spec.ts", "import { attr } from './attributes.js';\nit('d', () => attr('a'));");
  const rep = coverageReport({ root, modulePath: "src/api/attributes.ts" });
  assert.deepEqual(rep.referencingTests, ["src/api/direct.spec.ts"]);
  assert.deepEqual(rep.indirectTests, []);
});
test("import cycles terminate; .js specifiers resolve to .ts; directory indexes resolve", () => {
  const root = tmp();
  put(root, "src/m.ts", "export function run() {}\n");
  put(root, "src/lib/index.ts", "export { run } from '../m.js';\nimport '../lib2/index.js';\n");
  put(root, "src/lib2/index.ts", "import '../lib/index.js';\n");
  put(root, "src/t.test.ts", "import '../src/lib';\nrun();\nit('c', () => run());");
  const rep = coverageReport({ root, modulePath: "src/m.ts" });
  assert.deepEqual(rep.indirectTests.map((t) => t.test), ["src/t.test.ts"]);
});
test("node_modules is never followed", () => {
  const root = jsRepo();
  put(root, "node_modules/pkg/index.ts", "import '../../src/api/attributes.js';\nexport const z = 1;\n");
  put(root, "src/n.spec.ts", "import 'pkg';\nimport '../node_modules/pkg/index.js';\nit('n', () => attr('a'));");
  assert.deepEqual(coverageReport({ root, modulePath: "src/api/attributes.ts" }).indirectTests, []);
});
test("the reach is bounded: a chain deeper than the limit is not followed", () => {
  const root = tmp();
  put(root, "src/m.ts", "export function deepfn() {}\n");
  let prev = "m";
  for (let i = 0; i < 12; i++) { put(root, `src/c${i}.ts`, `import './${prev}.js';\n`); prev = `c${i}`; }
  put(root, "src/t.spec.ts", `import './${prev}.js';\nit('t', () => deepfn());`);
  assert.deepEqual(coverageReport({ root, modulePath: "src/m.ts" }).indirectTests, []);
  assert.equal(importGraphReach.MAX_DEPTH, 8);
});
test("unacknowledgedTests also asks the issue to name INDIRECT tests", () => {
  const rep = { referencingTests: ["a.test.ts"], indirectTests: [{ test: "src/api/attributes.spec.ts", names: ["attr"], via: [] }] };
  assert.deepEqual(unacknowledgedTests(rep, "see a.test.ts"), ["src/api/attributes.spec.ts"]);
  assert.deepEqual(unacknowledgedTests(rep, "a.test.ts and attributes.spec.ts exist"), []);
  assert.deepEqual(unacknowledgedTests({ referencingTests: [] }, ""), [], "an older report with no indirectTests still works");
});
// An index or core file reaches everything, and common method names (format, first, round) appear in dozens of unrelated tests. The
// report lists them all, but the issue is only asked to name the STRONGEST few (most distinct exports used, at least two), so the
// gate cannot demand a list of forty files. When nothing reaches two names, the single strongest still has to be named.
const ind = (test, n) => ({ test, names: Array.from({ length: n }, (_, i) => `n${i}`), via: [] });
test("indirect tests: only the strongest few (at least two names) must be named, strongest first, ties by path", () => {
  const rep = { referencingTests: [], indirectTests: [ind("z.spec.ts", 2), ind("a.spec.ts", 2), ind("m.spec.ts", 5), ind("b.spec.ts", 3), ind("weak.spec.ts", 1), ind("c.spec.ts", 2)] };
  assert.deepEqual(unacknowledgedTests(rep, ""), ["m.spec.ts", "b.spec.ts", "a.spec.ts"]);
  assert.equal(INDIRECT_ASK, 3);
});
test("indirect tests: with no test reaching two names, the single strongest is still required", () => {
  const rep = { referencingTests: [], indirectTests: [ind("b.spec.ts", 1), ind("a.spec.ts", 1)] };
  assert.deepEqual(unacknowledgedTests(rep, ""), ["a.spec.ts"]);
  assert.deepEqual(unacknowledgedTests(rep, "a.spec.ts covers it"), []);
});
test("direct importers are always required, however many indirect ones there are", () => {
  const rep = { referencingTests: ["x.test.ts", "y.test.ts"], indirectTests: [ind("m.spec.ts", 5)] };
  assert.deepEqual(unacknowledgedTests(rep, ""), ["x.test.ts", "y.test.ts", "m.spec.ts"]);
});

// ---- Python ----
const pyRepo = () => {
  const root = tmp();
  put(root, "src/attr/__init__.py", "from ._funcs import asdict, assoc\nfrom . import validators\n__all__ = ['asdict']\n");
  put(root, "src/attr/_funcs.py", "def asdict(inst):\n    return {}\ndef assoc(inst):\n    return inst\nclass Helper:\n    pass\nLIMIT = 3\ndef _private():\n    pass\n");
  put(root, "src/attr/validators.py", "def instance_of(t):\n    return t\n");
  put(root, "toolz/__init__.py", "from .itertoolz import *\n");
  put(root, "toolz/itertoolz.py", "def remove(pred, seq):\n    return seq\ndef groupby(key, seq):\n    return {}\n");
  return root;
};
test("python: exported names are top-level def/class/CONSTANT without a leading underscore", () => {
  assert.deepEqual(exportedNamesPython("def a():\n  pass\nclass B:\n  def method(self): pass\nC = 1\n_D = 2\ndef _e(): pass\nasync def f(): pass\n").sort(), ["B", "C", "a", "f"]);
});
test("python: a test importing the module by dotted path is a direct importer", () => {
  const root = pyRepo();
  put(root, "tests/test_it.py", "from toolz.itertoolz import remove\ndef test_x():\n    assert remove(1, [])\n");
  const rep = coverageReport({ root, modulePath: "toolz/itertoolz.py" });
  assert.deepEqual(rep.referencingTests, ["tests/test_it.py"]);
});
test("python: `from pkg import submodule` and `import pkg.sub` reach the submodule directly", () => {
  const root = pyRepo();
  put(root, "tests/test_v.py", "from attr import validators\ndef test_x():\n    validators.instance_of(int)\n");
  assert.deepEqual(coverageReport({ root, modulePath: "src/attr/validators.py" }).referencingTests, ["tests/test_v.py"]);
  put(root, "tests/test_w.py", "import attr.validators\ndef test_y():\n    attr.validators.instance_of(int)\n");
  assert.ok(coverageReport({ root, modulePath: "src/attr/validators.py" }).referencingTests.includes("tests/test_w.py"));
});
test("python: a test that uses a re-export through the package __init__ is INDIRECT, found in a src/ layout", () => {
  const root = pyRepo();
  put(root, "tests/test_funcs.py", "import attr\nfrom attr import asdict\ndef test_a():\n    assert asdict(1) == {}\n    attr.assoc(1)\n");
  const rep = coverageReport({ root, modulePath: "src/attr/_funcs.py" });
  assert.deepEqual(rep.referencingTests, []);
  assert.equal(rep.indirectTests.length, 1);
  assert.deepEqual(rep.indirectTests[0].names.sort(), ["asdict", "assoc"]);
  assert.ok(rep.indirectTests[0].via.includes("src/attr/__init__.py"));
});
test("python: a star re-export is followed", () => {
  const root = pyRepo();
  put(root, "tests/test_star.py", "import toolz\ndef test_s():\n    toolz.groupby(len, [])\n");
  const rep = coverageReport({ root, modulePath: "toolz/itertoolz.py" });
  assert.deepEqual(rep.indirectTests.map((t) => t.test), ["tests/test_star.py"]);
});
test("python: only test_*.py and *_test.py are tests; __pycache__ and virtualenvs are skipped", () => {
  const root = pyRepo();
  put(root, "tests/helper.py", "from toolz.itertoolz import remove\nremove(1, [])\n");
  put(root, "tests/other_test.py", "from toolz.itertoolz import remove\nremove(1, [])\n");
  put(root, ".venv/lib/test_x.py", "from toolz.itertoolz import remove\n");
  put(root, "tests/__pycache__/test_c.py", "from toolz.itertoolz import remove\n");
  assert.deepEqual(coverageReport({ root, modulePath: "toolz/itertoolz.py" }).referencingTests, ["tests/other_test.py"]);
});
test("python: a test that reaches the package but calls nothing from the module is not coverage", () => {
  const root = pyRepo();
  put(root, "tests/test_none.py", "import attr\ndef test_n():\n    assert attr is not None\n");
  assert.deepEqual(coverageReport({ root, modulePath: "src/attr/_funcs.py" }).indirectTests, []);
});

test("the depth bound is exact: a chain of MAX_DEPTH imports is found, one more is not", () => {
  for (const [links, expectFound] of [[importGraphReach.MAX_DEPTH, true], [importGraphReach.MAX_DEPTH + 1, false]]) {
    const root = tmp();
    put(root, "src/m.ts", "export function boundfn() {}\n");
    let prev = "m";
    for (let i = 0; i < links - 1; i++) { put(root, `src/c${i}.ts`, `import './${prev}.js';\n`); prev = `c${i}`; }
    put(root, "src/t.spec.ts", `import './${prev}.js';\nit('t', () => boundfn());`);
    assert.equal(coverageReport({ root, modulePath: "src/m.ts" }).indirectTests.length, expectFound ? 1 : 0, `${links} imports`);
  }
});
test("the file bound stops a runaway walk", () => {
  const root = tmp();
  put(root, "src/m.ts", "export function runfn() {}\n");
  put(root, "src/hub.ts", Array.from({ length: 30 }, (_, i) => `import './leaf${i}.js';`).join("\n") + "\nimport './m.js';\n");
  for (let i = 0; i < 30; i++) put(root, `src/leaf${i}.ts`, "export const x = 1;\n");
  put(root, "src/t.spec.ts", "import './hub.js';\nit('t', () => runfn());");
  const saved = importGraphReach.MAX_FILES;
  try {
    assert.equal(coverageReport({ root, modulePath: "src/m.ts" }).indirectTests.length, 1);
    importGraphReach.MAX_FILES = 5;
    assert.equal(coverageReport({ root, modulePath: "src/m.ts" }).indirectTests.length, 0);
  } finally { importGraphReach.MAX_FILES = saved; }
});
test("a // or /* */ comment, or a # comment in Python, that merely shows a call does not count as use", () => {
  const root = jsRepo();
  put(root, "src/api/c.spec.ts", "import { $ } from '../__fixtures__/fixtures.js';\n// $('p').attr('a');\n/* x.prop('b') */\nit('c', () => { $('p'); });");
  assert.deepEqual(coverageReport({ root, modulePath: "src/api/attributes.ts" }).indirectTests, []);
  const py = pyRepo();
  put(py, "tests/test_c.py", "import attr\n# attr.assoc(1)\ndef test_c():\n    pass\n");
  assert.deepEqual(coverageReport({ root: py, modulePath: "src/attr/_funcs.py" }).indirectTests, []);
});
test("python: a relative import inside a test package reaches the module", () => {
  const root = pyRepo();
  put(root, "src/attr/__init__.py", "from ._funcs import asdict\n");
  put(root, "src/attr/tests/__init__.py", "");
  put(root, "src/attr/tests/test_rel.py", "from .. import asdict\nfrom .. import _funcs\ndef test_r():\n    asdict(1)\n");
  const rep = coverageReport({ root, modulePath: "src/attr/_funcs.py" });
  assert.ok(rep.referencingTests.includes("src/attr/tests/test_rel.py"), "`from .. import _funcs` imports the submodule directly");
});
test("python: a package directory named like a skipped one (venv) is never followed", () => {
  const root = pyRepo();
  put(root, "venv/__init__.py", "from toolz.itertoolz import remove\n");
  put(root, "tests/test_v.py", "import venv\ndef test_v():\n    venv.remove(1, [])\n");
  assert.deepEqual(coverageReport({ root, modulePath: "toolz/itertoolz.py" }).indirectTests, []);
});
test("a bare word that is not a call or a member access is not use (a local variable named like an export)", () => {
  const root = jsRepo();
  put(root, "src/api/v.spec.ts", "import { $ } from '../__fixtures__/fixtures.js';\nit('v', () => { const attr = 1; expect(attr).toBe(1); $('p'); });");
  assert.deepEqual(coverageReport({ root, modulePath: "src/api/attributes.ts" }).indirectTests, []);
});
test("python: importing a submodule also runs the package __init__, which can reach the module", () => {
  const root = tmp();
  put(root, "pk/__init__.py", "from .core import fn\n");
  put(root, "pk/core.py", "def fn():\n    return 1\n");
  put(root, "pk/sub.py", "X = 1\n");
  put(root, "tests/test_s.py", "import pk.sub\ndef test_s():\n    pk.fn()\n");
  const rep = coverageReport({ root, modulePath: "pk/core.py" });
  assert.deepEqual(rep.indirectTests.map((t) => t.test), ["tests/test_s.py"]);
  assert.ok(rep.indirectTests[0].via.includes("pk/__init__.py"));
});
test("python: `from .. import name` climbs one package level and reaches the re-export", () => {
  const root = pyRepo();
  put(root, "src/attr/__init__.py", "from ._funcs import asdict\n");
  put(root, "src/attr/tests/__init__.py", "");
  put(root, "src/attr/tests/test_rel2.py", "from .. import asdict\ndef test_r():\n    asdict(1)\n");
  const rep = coverageReport({ root, modulePath: "src/attr/_funcs.py" });
  assert.deepEqual(rep.indirectTests.map((t) => t.test), ["src/attr/tests/test_rel2.py"]);
  assert.ok(rep.indirectTests[0].via.includes("src/attr/__init__.py"));
});

// ── "could not look" must never read as "no test covers it" ──
test("a file too large to read is reported as an incomplete search, not silently skipped", async () => {
  const { importGraphReach } = await import("../src/coverage.mjs");
  const root = repo();
  writeFileSync(join(root, "src/barrel.ts"), 'export * from "./prov.js";\n' + "// padding\n".repeat(200));
  writeFileSync(join(root, "src/a.test.ts"), 'import { isSource } from "./barrel.js";\nisSource(1);\n');
  const saved = importGraphReach.MAX_BYTES;
  try {
    importGraphReach.MAX_BYTES = 100;
    const rep = coverageReport({ root, modulePath: "src/prov.ts" });
    assert.ok(rep.incomplete.some((m) => /barrel\.ts is larger than 100 bytes/.test(m)), JSON.stringify(rep.incomplete));
  } finally { importGraphReach.MAX_BYTES = saved; }
  assert.deepEqual(coverageReport({ root, modulePath: "src/prov.ts" }).incomplete, []);
});
test("hitting the file limit of the import search is reported as an incomplete search", async () => {
  const { importGraphReach } = await import("../src/coverage.mjs");
  const root = repo();
  writeFileSync(join(root, "src/a.test.ts"), 'import "./b.js";\nimport "./c.js";\nimport "./d.js";\n');
  for (const n of ["b", "c", "d"]) writeFileSync(join(root, `src/${n}.ts`), "export const x = 1;\n");
  const saved = importGraphReach.MAX_FILES;
  try {
    importGraphReach.MAX_FILES = 2;
    const rep = coverageReport({ root, modulePath: "src/prov.ts" });
    assert.ok(rep.incomplete.some((m) => /hit the limit of 2 files/.test(m)), JSON.stringify(rep.incomplete));
  } finally { importGraphReach.MAX_FILES = saved; }
});
