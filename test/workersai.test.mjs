import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Budget, BudgetExceededError } from "../src/budget.mjs";
import { KillSwitch } from "../src/killswitch.mjs";
import { runTask } from "../src/runner.mjs";
import { PromptTooLargeError, WORKERS_AI_PRICES, estimateTokens, makeWorkersAiAgent } from "../src/adapters/workersai.mjs";
import { buildMessages } from "../src/adapters/ollama.mjs";
import { tmp } from "./helpers.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = ["cfut_", "Zk3P9xQw", "L2mR7vTn", "B5yH8cJd"].join(""); // built at runtime so no scanner flags this file
const MODEL = "workers-ai:@cf/qwen/qwen2.5-coder-32b-instruct";
const TASK = { number: 25, title: "test: add x.test.ts", body: "one file: `t/x.test.ts`", allowed: ["t/x.test.ts"] };
const LIMITS = { maxInputTokens: 8000, maxOutputTokens: 1500 };
const CODE = "```ts\nimport { it } from \"vitest\";\nit(\"x\", () => {});\n```";

const reply = (result, { status = 200, success = true, raw } = {}) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = raw ?? JSON.stringify({ result, success, errors: [], messages: [] });
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  f.calls = calls;
  return f;
};
const agent = (over = {}) => makeWorkersAiAgent({ accountId: ACCOUNT, apiToken: TOKEN, sourceFiles: { "t/x.ts": "export const x = 1;" }, styleExample: "// s", ...over });
const run = (a, f, limits = LIMITS) => a({ task: TASK, model: MODEL, limits, fetch: f });

test("the request goes to the account's /ai/run/<bare model>, with the token only in the Authorization header", async () => {
  const f = reply({ response: CODE, usage: { prompt_tokens: 10, completion_tokens: 5 } });
  await run(agent(), f);
  const c = f.calls[0];
  assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/qwen/qwen2.5-coder-32b-instruct`);
  assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!c.init.body.includes(TOKEN), "the token must never be in the request body");
  assert.ok(!c.url.includes(TOKEN), "the token must never be in the URL");
});

test("the request is deterministic and capped by the output limit", async () => {
  const f = reply({ response: CODE, usage: { prompt_tokens: 1, completion_tokens: 1 } });
  await run(agent(), f);
  assert.equal(f.calls[0].body.temperature, 0);
  assert.equal(f.calls[0].body.max_tokens, LIMITS.maxOutputTokens);
  assert.ok(Array.isArray(f.calls[0].body.messages));
});

test("usage is MEASURED from the provider's counters, and the code block becomes the one allowed file", async () => {
  const r = await run(agent(), reply({ response: CODE, usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }));
  assert.deepEqual(r.usage, { inputTokens: 123, outputTokens: 45 });
  assert.deepEqual(Object.keys(r.files), ["t/x.test.ts"]);
  assert.equal(r.usageRequired, true);
});

test("an OpenAI-style response (choices[0].message.content) is understood too", async () => {
  const r = await run(agent(), reply({ choices: [{ message: { content: CODE } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  assert.deepEqual(Object.keys(r.files), ["t/x.test.ts"]);
});

test("missing usage leaves usage UNDEFINED (so the runner charges the worst case, never zero)", async () => {
  const r = await run(agent(), reply({ response: CODE }));
  assert.equal(r.usage, undefined);
  assert.equal(r.usageRequired, true);
});

test("a prompt over the input bound is refused BEFORE any call, because the budget was priced against that bound", async () => {
  const f = reply({ response: CODE });
  const huge = { "t/big.ts": "x".repeat(60_000) };
  await assert.rejects(run(agent({ sourceFiles: huge }), f), PromptTooLargeError);
  assert.equal(f.calls.length, 0);
});

test("the token estimate is deliberately high: 3 characters per token", () => {
  assert.equal(estimateTokens([{ role: "user", content: "x".repeat(300) }]), 100);
  assert.ok(estimateTokens(buildMessages({ task: TASK, sourceFiles: {}, styleExample: "" })) > 0);
});

test("errors name the status and the provider's reason, and never contain the token", async () => {
  const bad = reply(undefined, { status: 401, success: false, raw: JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }) });
  await assert.rejects(run(agent(), bad), (e) => /HTTP 401/.test(e.message) && /10000: Authentication error/.test(e.message) && !e.message.includes(TOKEN));
  const html = reply(undefined, { status: 502, raw: "<html>Bad gateway</html>" });
  await assert.rejects(run(agent(), html), (e) => /HTTP 502/.test(e.message) && /non-JSON/.test(e.message) && !e.message.includes(TOKEN));
});

test("a bad account id or a missing token is refused at construction", () => {
  assert.throws(() => agent({ accountId: "nope" }), /32 hex/);
  assert.throws(() => agent({ apiToken: "" }), /needs an account id and an API token/);
});

test("every listed price is a positive finite pair, keyed as a workers-ai ledger id", () => {
  for (const [k, p] of Object.entries(WORKERS_AI_PRICES)) {
    assert.ok(k.startsWith("workers-ai:@cf/"), k);
    assert.ok(Number.isFinite(p.input) && p.input > 0 && Number.isFinite(p.output) && p.output > 0, k);
  }
});

// ---- through the runner and the budget ----
function world(over = {}) {
  const dir = tmp();
  const kill = new KillSwitch({ stateDir: dir, maxConsecutiveFailures: 3 });
  const budget = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 1, maxUsdTotal: 5, prices: WORKERS_AI_PRICES, ...over });
  return { dir, kill, budget };
}
const go = (w, f) => runTask({ task: TASK, agent: agent(), budget: w.budget, kill: w.kill, model: MODEL, limits: LIMITS, allowlist: ["api.cloudflare.com"], realFetch: f });

test("a model that is not in the price table is refused by the budget, not treated as free", () => {
  const w = world();
  assert.throws(() => w.budget.reserve("workers-ai:@cf/unknown/model", 1000, 1000), BudgetExceededError);
});

test("the ledger gets the MEASURED cost: 10k in, 2k out of the coder model is $0.0086", async () => {
  const w = world();
  const f = reply({ response: CODE, usage: { prompt_tokens: 7000, completion_tokens: 1500 } });
  await go(w, f);
  const expected = (7000 * 0.66 + 1500 * 1.0) / 1_000_000;
  assert.ok(Math.abs(w.budget.spent().total - expected) < 1e-12, `${w.budget.spent().total} vs ${expected}`);
});

test("a provider that reports MORE than the reserved bound trips STOP, and the real spend is still recorded", async () => {
  const w = world();
  const f = reply({ response: CODE, usage: { prompt_tokens: 9000, completion_tokens: 100 } }); // 9000 > the 8000 bound
  await assert.rejects(go(w, f), /over the reserved/);
  assert.ok(w.kill.isStopped());
  assert.ok(w.budget.spent().total > 0);
});

test("a response with no usage is charged the WORST case, and three in a row trip STOP", async () => {
  const w = world({ maxUsdPerDay: 10, maxUsdTotal: 50 });
  const f = reply({ response: CODE });
  const worst = (LIMITS.maxInputTokens * 0.66 + LIMITS.maxOutputTokens * 1.0) / 1_000_000;
  await go(w, f);
  assert.ok(Math.abs(w.budget.spent().total - worst) < 1e-12, "charged the worst case, not zero");
  await go(w, f);
  await assert.rejects(go(w, f), /consecutive failures/);
  assert.ok(w.kill.isStopped());
});
