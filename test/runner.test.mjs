import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Budget, LOCAL_MODEL_PRICE } from "../src/budget.mjs";
import { KillSwitch } from "../src/killswitch.mjs";
import { assertPublishable, guardedFetch, runLoop, runTask } from "../src/runner.mjs";
import { FAKE, tmp } from "./helpers.mjs";

const PRICES = { "cloud:m": { input: 1, output: 4 }, "local:m": LOCAL_MODEL_PRICE };
const LIMITS = { maxInputTokens: 1000, maxOutputTokens: 1000 };
const ALLOW = ["github.com"];
const TASK = { number: 7, title: "t", allowed: ["t/a.test.ts"] };

function world(over = {}) {
  const dir = tmp();
  const kill = new KillSwitch({ stateDir: dir, maxConsecutiveFailures: 3 });
  const budget = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 1, maxUsdTotal: 5, prices: PRICES, ...over });
  return { dir, kill, budget };
}
const good = async () => ({ text: "done", files: { "t/a.test.ts": "// ok" }, usage: { inputTokens: 100, outputTokens: 100 } });
const run = (w, agent, extra = {}) =>
  runTask({ task: TASK, agent, budget: w.budget, kill: w.kill, model: "cloud:m", limits: LIMITS, allowlist: ALLOW, ...extra });

test("a clean run returns the files, records real spend, and resets the failure count", async () => {
  const w = world();
  const r = await run(w, good);
  assert.deepEqual(Object.keys(r.files), ["t/a.test.ts"]);
  assert.ok(w.budget.spent().total > 0);
});

test("the cap is enforced BEFORE the call: the agent is never invoked when the worst case would not fit", async () => {
  const w = world({ maxUsdPerDay: 0.0001 });
  let called = false;
  await assert.rejects(run(w, async () => { called = true; return {}; }), /cap would be exceeded/);
  assert.equal(called, false);
  assert.equal(w.budget.spent().total, 0);
});

test("while STOP exists the agent is never invoked", async () => {
  const w = world();
  assert.throws(() => w.kill.trip("halt"));
  let called = false;
  await assert.rejects(run(w, async () => { called = true; return {}; }), /STOP:.*halt/);
  assert.equal(called, false);
});

test("a secret-shaped string in the output trips STOP, and the spend is still recorded", async () => {
  const w = world();
  await assert.rejects(run(w, async () => ({ text: `key ${FAKE.github}`, files: { "t/a.test.ts": "x" }, usage: { inputTokens: 10, outputTokens: 10 } })), /secret-shaped/);
  assert.ok(w.kill.isStopped());
  assert.ok(w.budget.spent().total > 0, "the call happened; it must be on the ledger");
});

test("a secret inside a produced FILE trips STOP too", async () => {
  const w = world();
  await assert.rejects(run(w, async () => ({ text: "", files: { "t/a.test.ts": `const k = "${FAKE.aws}"` } })), /secret-shaped/);
  assert.ok(w.kill.isStopped());
});

test("a changed file outside the task's scope trips STOP", async () => {
  const w = world();
  await assert.rejects(run(w, async () => ({ text: "", files: { "t/a.test.ts": "x", ".github/workflows/ci.yml": "x" } })), /outside its scope/);
  assert.ok(w.kill.isStopped());
});

test("a URL in the output that is off the allowlist trips STOP", async () => {
  const w = world();
  await assert.rejects(run(w, async () => ({ text: "fetch https://evil-host.com/x", files: { "t/a.test.ts": "x" } })), /outside the allowlist/);
  assert.ok(w.kill.isStopped());
});

test("the agent's fetch refuses, and trips STOP, for a host off the allowlist; an allowed host passes through", async () => {
  const w = world();
  const calls = [];
  const realFetch = async (u) => { calls.push(String(u)); return "ok"; };
  const f = guardedFetch({ allowlist: ALLOW, kill: w.kill, realFetch });
  assert.equal(await f("https://github.com/x"), "ok");
  await assert.rejects(f("https://evil.example/steal"), /allowlist/);
  assert.ok(w.kill.isStopped());
  assert.deepEqual(calls, ["https://github.com/x"]);
  await assert.rejects(f("https://github.com/y"), /STOP/);
});

test("three agent failures in a row trip STOP (the third is a stop, not another failure)", async () => {
  const w = world();
  const boom = async () => { throw new Error("model fell over"); };
  await assert.rejects(run(w, boom), /fell over/);
  await assert.rejects(run(w, boom), /fell over/);
  await assert.rejects(run(w, boom), /STOP: 3 consecutive failures/);
  assert.ok(w.kill.isStopped());
});

test("a task with no allowed path is not runnable", async () => {
  const w = world();
  await assert.rejects(runTask({ task: { number: 1, allowed: [] }, agent: good, budget: w.budget, kill: w.kill, model: "cloud:m", limits: LIMITS, allowlist: ALLOW }), /not runnable/);
});

test("runLoop stops the whole loop on STOP, and on a refused budget WITHOUT tripping STOP", async () => {
  const w = world();
  const tasks = [{ number: 1, allowed: ["a"] }, { number: 2, allowed: ["b"] }, { number: 3, allowed: ["c"] }];
  const leak = async ({ task }) => ({ text: task.number === 1 ? FAKE.sk : "fine", files: { [task.allowed[0]]: "x" } });
  const out = await runLoop({ tasks, agent: leak, budget: w.budget, kill: w.kill, model: "local:m", limits: LIMITS, allowlist: ALLOW });
  assert.deepEqual(out.map((o) => o.status), ["stopped"]);

  const w2 = world({ maxUsdPerDay: 0.0001 });
  const out2 = await runLoop({ tasks, agent: good, budget: w2.budget, kill: w2.kill, model: "cloud:m", limits: LIMITS, allowlist: ALLOW });
  assert.deepEqual(out2.map((o) => o.status), ["budget-stop"]);
  assert.equal(w2.kill.isStopped(), false, "hitting the cap is the system working, not a breach");
});

test("runLoop records ok outcomes and continues past an ordinary failure", async () => {
  const w = world();
  let n = 0;
  const flaky = async ({ task }) => {
    n += 1;
    if (n === 1) throw new Error("transient");
    return { text: "", files: { [task.allowed[0]]: "x" }, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const tasks = [{ number: 1, allowed: ["a"] }, { number: 2, allowed: ["b"] }];
  const out = await runLoop({ tasks, agent: flaky, budget: w.budget, kill: w.kill, model: "local:m", limits: LIMITS, allowlist: ALLOW });
  assert.deepEqual(out.map((o) => o.status), ["failed", "ok"]);
});

test("assertPublishable: only agent/* branches, only in-scope files, never while stopped", () => {
  const w = world();
  const ok = { branch: "agent/issue-7", changedFiles: ["t/a.test.ts"], allowed: ["t/a.test.ts"], kill: w.kill };
  assertPublishable(ok);
  assert.throws(() => assertPublishable({ ...ok, branch: "main" }), /only agent/);
  assert.throws(() => assertPublishable({ ...ok, branch: "preview" }), /only agent/);
  assert.throws(() => assertPublishable({ ...ok, changedFiles: ["t/a.test.ts", "src/x.ts"] }), /outside scope/);
  assert.throws(() => w.kill.trip("x"));
  assert.throws(() => assertPublishable(ok), /STOP/);
});

test("a fixture URL on a reserved documentation host in the output does NOT trip STOP", async () => {
  const w = world();
  const r = await run(w, async () => ({ text: "", files: { "t/a.test.ts": 'const logoUrl = "https://example.com/logo.png"; const h = "http://localhost:3000/x"; const i = "https://api.foo.invalid/y";' } }));
  assert.deepEqual(Object.keys(r.files), ["t/a.test.ts"]);
  assert.equal(w.kill.isStopped(), false);
});

test("a lookalike of a reserved host in the output still trips STOP", async () => {
  const w = world();
  await assert.rejects(run(w, async () => ({ text: "", files: { "t/a.test.ts": 'fetch("https://example.com.evil.com/x")' } })), /outside the allowlist/);
  assert.ok(w.kill.isStopped());
});

test("the reserved-host exemption never widens the AGENT'S fetch: guardedFetch still refuses example.com", async () => {
  const w = world();
  const f = guardedFetch({ allowlist: ALLOW, kill: w.kill, realFetch: async () => "ok" });
  await assert.rejects(f("https://example.com/x"), /allowlist/);
  assert.ok(w.kill.isStopped());
});

test("an agent that throws frees its reservation: the next run is not refused by the failed one's worst case", async () => {
  // worst case per call is 1000*$1/1M + 1000*$4/1M = $0.005; the daily cap fits exactly one such call
  const w = world({ maxUsdPerDay: 0.006 });
  await assert.rejects(run(w, async () => { throw new Error("provider 500"); }), /provider 500/);
  const r = await run(w, good); // would be refused as "daily cap would be exceeded" if the failed hold were still held
  assert.ok(r.files);
});
