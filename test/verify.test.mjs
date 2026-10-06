import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFiles, runChecked } from "../src/verify.mjs";
import { tmp } from "./helpers.mjs";

test("applyFiles writes the allowed file under the root and returns its path", () => {
  const root = tmp();
  const w = applyFiles({ root, files: { "a/b.test.ts": "x" }, allowed: ["a/b.test.ts"] });
  assert.deepEqual(w, ["a/b.test.ts"]);
  assert.equal(readFileSync(join(root, "a/b.test.ts"), "utf8"), "x");
});

test("applyFiles refuses a file outside the allowed set, and writes NOTHING", () => {
  const root = tmp();
  assert.throws(() => applyFiles({ root, files: { "a.ts": "1", "evil.ts": "2" }, allowed: ["a.ts"] }), /outside scope/);
  assert.ok(!existsSync(join(root, "a.ts")), "a partial write happened");
});

test("applyFiles refuses a path that resolves outside the root even if it is 'allowed'", () => {
  const root = tmp();
  assert.throws(() => applyFiles({ root, files: { "../escape.txt": "x" }, allowed: ["../escape.txt"] }), /outside the working directory/);
});

test("runChecked runs with the sandbox env: no tokens, a scratch HOME", () => {
  const env = { PATH: process.env.PATH, HOME: "/Users/real", GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k" };
  const r = runChecked({ cwd: tmp(), command: process.execPath, args: ["-e", "console.log(JSON.stringify({ k: Object.keys(process.env), h: process.env.HOME }))"], env });
  assert.ok(r.ok);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.k.includes("GITHUB_TOKEN"));
  assert.ok(!out.k.includes("ANTHROPIC_API_KEY"));
  assert.notEqual(out.h, "/Users/real");
});

test("runChecked reports a failing command without throwing", () => {
  const r = runChecked({ cwd: tmp(), command: process.execPath, args: ["-e", "process.exit(3)"] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
});
