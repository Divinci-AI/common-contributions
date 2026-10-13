import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { tmp } from "./helpers.mjs";
import { crossRef } from "./fakegh.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const FAKEGH = pathToFileURL(fileURLToPath(new URL("./fakegh.mjs", import.meta.url))).href;
const PR = (n, state, o = {}) => crossRef(n, state, o);

function setup(timeline) {
  const gh = join(tmp(), "gh");
  writeFileSync(gh, `#!${process.execPath}\nimport { defaultWorld, fakeRunner } from ${JSON.stringify(FAKEGH)};\nconst w = defaultWorld(); w.timeline = ${JSON.stringify(timeline)};\nconst r = fakeRunner(w)(process.argv.slice(2));\nprocess.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);\n`);
  chmodSync(gh, 0o755);
  const issues = join(tmp(), "issues.json");
  writeFileSync(issues, JSON.stringify([{ number: 7, title: "t", labels: [{ name: "agent-ready" }], body: "## Done when (one file: `tests/a.test.ts`)\n- covers `src/a.ts`\n" }]));
  return { gh, issues, home: tmp(), repo: tmp() };
}
const run = (s, extra, provider = []) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, "run-one", s.issues, "7", "--repo", s.repo, "--model", "m", ...provider, ...extra], { env: { PATH: "/usr/bin:/bin", HOME: s.home, XDG_STATE_HOME: join(s.home, "state"), COMMON_CONTRIBUTIONS_HOME: s.home } });
  let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("close", (status) => resolve({ status, err }));
});

test("run-one: an open pull request that mentions the issue stops the run before anything is spent", async () => {
  const s = setup([PR(40, "open")]);
  const r = await run(s, ["--github", "acme/widgets", "--gh", s.gh]);
  assert.equal(r.status, 2);
  assert.match(r.err, /prior work: pull requests already mention #7/); assert.match(r.err, /#40 open by bob/); assert.match(r.err, /--ignore-prior-work/);
});
test("run-one: --ignore-prior-work goes on (and then meets the next check, not this one)", async () => {
  const s = setup([PR(40, "open")]);
  const r = await run(s, ["--github", "acme/widgets", "--gh", s.gh, "--ignore-prior-work"]);
  assert.match(r.err, /names no existing source module/); assert.doesNotMatch(r.err, /refusing: read those first/);
});
test("run-one: no prior work found says so; a closed PR is only a note", async () => {
  const s = setup([PR(41, "closed")]);
  const r = await run(s, ["--github", "acme/widgets", "--gh", s.gh]);
  assert.match(r.err, /note: closed \(not merged\)/); assert.match(r.err, /prior work: none found/);
});
test("run-one: a GitHub error refuses (never reads as 'none found'); without --github it warns, and a hosted run refuses", async () => {
  const bad = setup([]); const r1 = await run(bad, ["--github", "other/missing", "--gh", bad.gh]);
  assert.equal(r1.status, 2); assert.match(r1.err, /could not look for earlier work/);
  const none = setup([]); const r2 = await run(none, []);
  assert.match(r2.err, /warning: prior-work check skipped/);
  const r3 = await run(none, [], ["--provider", "workers-ai"]);
  assert.equal(r3.status, 2); assert.match(r3.err, /hosted run spends money, so it needs the prior-work check/);
});

test("run-one: a hostile title is escaped on screen; a mention from another repository is a note, not a stop", async () => {
  const s = setup([PR(40, "open", { title: "ok\u001b]0;pwned\u0007\u202e" }), PR(41, "open", { repoId: 9999 })]);
  const r = await run(s, ["--github", "acme/widgets", "--gh", s.gh]);
  assert.equal(r.status, 2); assert.doesNotMatch(r.err, /[\u001b\u0007\u202e]/); assert.match(r.err, /\\u\{1b\}/);
  const t = setup([PR(41, "open", { repoId: 9999 })]);
  const q = await run(t, ["--github", "acme/widgets", "--gh", t.gh]);
  assert.match(q.err, /other repositories mention #7 \(not blocking\)/); assert.match(q.err, /prior work: none found/);
});

test("run-one: --no-prior-work-check lets a hosted run past the missing check (it then meets the next refusal: no credentials)", async () => {
  const s = setup([]);
  const r = await run(s, ["--no-prior-work-check"], ["--provider", "workers-ai"]);
  assert.doesNotMatch(r.err, /hosted run spends money/); assert.match(r.err, /warning: prior-work check skipped/);
});
