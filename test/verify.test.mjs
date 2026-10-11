import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFiles, runChecked, writeNoFollow } from "../src/verify.mjs";
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

import { symlinkSync, mkdirSync as mk, existsSync as ex, readFileSync as rf, writeFileSync as wf } from "node:fs";
import { join as j } from "node:path";
import { tmp as t2 } from "./helpers.mjs";

test("applyFiles refuses to write through a symlinked directory that points outside the root, and writes nothing there", () => {
  const root = t2(), outside = t2();
  symlinkSync(outside, j(root, "link"));
  assert.throws(() => applyFiles({ root, files: { "link/x.test.ts": "pwn" }, allowed: ["link/x.test.ts"] }), /symbolic link/);
  assert.ok(!ex(j(outside, "x.test.ts")));
});

test("applyFiles refuses to overwrite an existing symlink file (it would write to the link's target)", () => {
  const root = t2(), outside = t2();
  wf(j(outside, "secret.txt"), "keep");
  mk(j(root, "a"));
  symlinkSync(j(outside, "secret.txt"), j(root, "a/x.test.ts"));
  assert.throws(() => applyFiles({ root, files: { "a/x.test.ts": "pwn" }, allowed: ["a/x.test.ts"] }), /symbolic link/);
  assert.equal(rf(j(outside, "secret.txt"), "utf8"), "keep");
});

test("applyFiles refuses dependency and config files even when the issue 'allows' them", () => {
  const root = t2();
  for (const f of ["package.json", "orchestrator/package-lock.json", ".npmrc", "orchestrator/vitest.config.ts", "tsconfig.base.json", "tests/conftest.py"]) {
    assert.throws(() => applyFiles({ root, files: { [f]: "x" }, allowed: [f] }), /dependency or config/, f);
  }
  assert.ok(applyFiles({ root, files: { "src/a.test.ts": "x" }, allowed: ["src/a.test.ts"] }).length === 1);
});

test("writeNoFollow refuses a symlink at the final component even if an earlier check was raced (O_NOFOLLOW on its own)", () => {
  const dir = t2(), outside = t2();
  wf(j(outside, "t.txt"), "keep");
  symlinkSync(j(outside, "t.txt"), j(dir, "l"));
  assert.throws(() => writeNoFollow(j(dir, "l"), "pwn"), /ELOOP|symbolic|too many/i);
  assert.equal(rf(j(outside, "t.txt"), "utf8"), "keep");
});
