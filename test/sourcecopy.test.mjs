import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copySource } from "../src/sourcecopy.mjs";
import { tmp } from "./helpers.mjs";

test("the copy has the source but not node_modules, .git, env files, keys or symlinks", () => {
  const repo = tmp();
  mkdirSync(join(repo, "orchestrator/src"), { recursive: true });
  mkdirSync(join(repo, "orchestrator/node_modules/x"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, "orchestrator/src/a.ts"), "export {}");
  writeFileSync(join(repo, "orchestrator/node_modules/x/i.js"), "x");
  writeFileSync(join(repo, ".git/config"), "x");
  writeFileSync(join(repo, ".env"), "K=v");
  writeFileSync(join(repo, ".env.local"), "K=v");
  writeFileSync(join(repo, "deploy.pem"), "x");
  writeFileSync(join(repo, ".npmrc"), "//registry:_authToken=x");
  symlinkSync("/etc/passwd", join(repo, "link.txt"));
  symlinkSync("/etc", join(repo, "linkdir"));
  const dest = copySource(repo);
  try {
    assert.ok(existsSync(join(dest, "orchestrator/src/a.ts")));
    for (const gone of ["orchestrator/node_modules", ".git", ".env", ".env.local", "deploy.pem", ".npmrc", "link.txt", "linkdir"]) assert.equal(existsSync(join(dest, gone)), false, gone);
  } finally { rmSync(dest, { recursive: true, force: true }); }
});
