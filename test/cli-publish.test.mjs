import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { buildRecord, issueHash, loadOrCreateKey } from "../src/record.mjs";
import { defaultWorld } from "./fakegh.mjs";
import { tmp } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const FAKEGH = pathToFileURL(fileURLToPath(new URL("./fakegh.mjs", import.meta.url))).href;
const TREES = JSON.parse(readFileSync(fileURLToPath(new URL("../reviewed-harness-trees.json", import.meta.url)), "utf8")).trees;
const SPEC = { version: 1, opt_in: true, min_hours_between_prs: 24, contact: "@maintainer", policy_url: "https://example.org/ai", review_by: new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10), label_applied_by: ["maintainer"], first_time_contributors: "allowed", allowed_paths: ["tests/**"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes" }, certification: { dco: "none", cla: "none" } };

function setup(spec) {
  const home = tmp(), dir = tmp();
  const g = (...a) => spawnSync("/usr/bin/git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q"); mkdirSync(join(dir, "tests"), { recursive: true }); writeFileSync(join(dir, "tests/old.test.ts"), "a\n"); g("add", "."); g("commit", "-qm", "base");
  g("config", "user.name", "Alice Example"); g("config", "user.email", "alice@example.org");
  const base = g("rev-parse", "HEAD").stdout.trim();
  const w = defaultWorld();
  const record = buildRecord({ harness: { commit: "h".repeat(40), dirty: false, srcTreeHash: TREES.at(-1) }, project: { dir: "r" }, origin: "github.com/acme/widgets", issue: { number: 7, sha256: issueHash(w.issue.title, w.issue.body) }, model: "claude-code:opus", base, source: "git-archive", container: true, pin: { escapeSuite: { pass: 15, fail: 0, skipped: 0 } }, image: "sha256:x", dep: { matched: true }, limits: {}, files: { "tests/new.test.ts": "export {}\n" }, checks: [{ name: "t", status: 0 }], key: loadOrCreateKey(home) });
  const recordFile = join(dir, "..", `rec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`); writeFileSync(recordFile, JSON.stringify(record));
  const desc = join(dir, "..", `desc-${Math.random().toString(36).slice(2)}.md`); writeFileSync(desc, "I added a test for the empty list case because the helper had none.");
  const gh = join(tmp(), "gh");
  writeFileSync(gh, `#!${process.execPath}\nimport { defaultWorld, fakeRunner } from ${JSON.stringify(FAKEGH)};\nconst w = defaultWorld(); w.optin = { content: ${JSON.stringify(JSON.stringify(spec))} };\nconst r = fakeRunner(w)(process.argv.slice(2));\nprocess.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);\n`);
  chmodSync(gh, 0o755);
  return { home, dir, recordFile, desc, gh };
}
// detached = a new session = NO controlling terminal, so /dev/tty cannot be opened even when the tests are run from a terminal.
const run = (args, home) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), COMMON_CONTRIBUTIONS_HOME: home } });
  let stdout = "", stderr = ""; child.stdout.on("data", (c) => (stdout += c)); child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const args = (s) => ["publish", "--dry-run", "--record", s.recordFile, "--repo", "acme/widgets", "--issue", "7", "--clone", s.dir, "--description-file", s.desc, "--gh", s.gh];

test("publish --dry-run works with NO terminal: every check, the whole review, nothing changed, exit 0", async () => {
  const s = setup(SPEC);
  const r = await run(args(s), s.home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /ok   issue carries the task label/); assert.doesNotMatch(r.stdout, /FAIL/);
  assert.match(r.stdout, /Repository: acme\/widgets/); assert.match(r.stdout, /--- diff \(1 changed lines\) ---/); assert.match(r.stdout, /Alice Example <alice@example\.org>/);
  assert.match(r.stdout, /Dry run: no certification was asked and nothing will be changed/); assert.match(r.stdout, /DRY RUN: nothing was changed\./);
  assert.doesNotMatch(r.stdout + r.stderr, /published\./);
});
test("publish --dry-run for a project that requires a CLA and DCO names them and still needs no terminal", async () => {
  const s = setup({ ...SPEC, certification: { dco: "signed-off-by", cla: "individual" } });
  const r = await run(args(s), s.home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Certifications this project requires, asked when you publish: individual CLA and DCO sign-off/);
});
test("a real publish for a project that requires a certification, with no terminal, stops at the question and changes nothing", async () => {
  const s = setup({ ...SPEC, certification: { dco: "signed-off-by", cla: "none" } });
  const r = await run(args(s).filter((a) => a !== "--dry-run"), s.home);
  assert.equal(r.status, 2); assert.match(r.stderr, /requires a certification|no terminal available/); assert.doesNotMatch(r.stdout + r.stderr, /published\./);
});
