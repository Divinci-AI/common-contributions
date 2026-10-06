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
