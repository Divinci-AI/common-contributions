import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedPaths, diffScopeViolations, isAgentBranch, isOptedIn, isSafeRelativePath, selectRunnableTasks } from "../src/scope.mjs";

const BODY = (paths) => `## What\nx\n\n## Done when (one file: ${paths})\n- thing\n`;

test("opt-in is by the agent-ready label, as a name string or a label object", () => {
  assert.ok(isOptedIn({ labels: ["agent-ready"] }));
  assert.ok(isOptedIn({ labels: [{ name: "agent-ready" }] }));
  assert.ok(!isOptedIn({ labels: [{ name: "bug" }] }));
  assert.ok(!isOptedIn({}));
});

test("allowedPaths reads the backticked path from the Done-when heading", () => {
  assert.deepEqual(allowedPaths(BODY("`orchestrator/src/provenance.test.ts`")), ["orchestrator/src/provenance.test.ts"]);
});

test("if nothing can be parsed, the task is NOT runnable (no allowed paths)", () => {
  assert.deepEqual(allowedPaths("just do whatever"), []);
  assert.deepEqual(allowedPaths(undefined), []);
});

test("unsafe paths are dropped: absolute, parent-relative, backslash, scheme", () => {
  assert.deepEqual(allowedPaths(BODY("`/etc/passwd` `../x` `a\\b` `file:///x` `ok/y.ts`")), ["ok/y.ts"]);
  assert.ok(!isSafeRelativePath(""));
  assert.ok(!isSafeRelativePath(undefined));
});

test("diffScopeViolations returns exactly the files outside the allowed set", () => {
  assert.deepEqual(diffScopeViolations(["a.ts"], ["a.ts"]), []);
  assert.deepEqual(diffScopeViolations(["a.ts", "src/x.ts", ".github/w.yml"], ["a.ts"]), ["src/x.ts", ".github/w.yml"]);
});

test("the agent may publish only to agent/* branches, never main, master, preview, or tricks", () => {
  assert.ok(isAgentBranch("agent/issue-23"));
  for (const bad of ["main", "master", "preview", "agent/main", "agent/..", "agent/a..b", "agent/x.lock", "agent/", "feature/x", "", undefined]) {
    assert.ok(!isAgentBranch(bad), String(bad));
  }
});

test("selectRunnableTasks needs BOTH the label and a parseable scope", () => {
  const issues = [
    { number: 1, title: "ok", labels: ["agent-ready"], body: BODY("`t/a.test.ts`") },
    { number: 2, title: "no label", labels: [], body: BODY("`t/b.test.ts`") },
    { number: 3, title: "no scope", labels: ["agent-ready"], body: "do it" },
  ];
  assert.deepEqual(selectRunnableTasks(issues).map((t) => t.number), [1]);
});

import { isConfigFile } from "../src/scope.mjs";
test("an issue cannot make a dependency or config file writable: allowedPaths drops it", () => {
  const body = "## Done when (one file: `package.json`, `orchestrator/vitest.config.ts`, `orchestrator/src/a.test.ts`)\n";
  assert.deepEqual(allowedPaths(body), ["orchestrator/src/a.test.ts"]);
  assert.ok(isConfigFile("x/tsconfig.json") && !isConfigFile("x/src/tsconfig-notes.test.ts"));
});
