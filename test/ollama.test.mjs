import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Budget, LOCAL_MODEL_PRICE } from "../src/budget.mjs";
import { KillSwitch } from "../src/killswitch.mjs";
import { runTask } from "../src/runner.mjs";
import { buildMessages, extractCodeBlock, makeOllamaAgent } from "../src/adapters/ollama.mjs";
import { tmp } from "./helpers.mjs";

const TASK = { number: 23, title: "test: add provenance.test.ts", body: "## Done when (one file: `t/provenance.test.ts`)", allowed: ["t/provenance.test.ts"] };
const LIMITS = { maxInputTokens: 8000, maxOutputTokens: 1500 };
const SRC = { "t/provenance.ts": "export const x = 1;" };
const CODE = "```ts\nimport { it } from \"vitest\";\nit(\"x\", () => {});\n```";

const fakeFetch = (body, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok, status, json: async () => body }; };
  f.calls = calls;
  return f;
};
const agent = () => makeOllamaAgent({ sourceFiles: SRC, styleExample: "// style" });

test("extractCodeBlock takes the first fenced block, with or without a language tag", () => {
  assert.equal(extractCodeBlock("blah\n```ts\nconst a = 1;\n```\nmore"), "const a = 1;\n");
  assert.equal(extractCodeBlock("```\nplain\n```"), "plain\n");
  assert.equal(extractCodeBlock("no fence here"), null);
  assert.equal(extractCodeBlock(undefined), null);
});

test("the request is non-streaming, deterministic, capped by the output limit, and goes to /api/chat", async () => {
  const f = fakeFetch({ message: { content: CODE }, prompt_eval_count: 11, eval_count: 7 });
  await agent()({ task: TASK, model: "gemma4:e2b", limits: LIMITS, fetch: f });
  const c = f.calls[0];
  assert.equal(c.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(c.body.model, "gemma4:e2b");
  assert.equal(c.body.stream, false);
  assert.equal(c.body.options.temperature, 0);
  assert.equal(c.body.options.num_predict, LIMITS.maxOutputTokens);
});

test("usage is MEASURED from Ollama's counters", async () => {
  const f = fakeFetch({ message: { content: CODE }, prompt_eval_count: 123, eval_count: 45 });
  const r = await agent()({ task: TASK, model: "m", limits: LIMITS, fetch: f });
  assert.deepEqual(r.usage, { inputTokens: 123, outputTokens: 45 });
});

test("missing counters leave usage UNDEFINED (so the runner charges the worst case, never zero)", async () => {
  const f = fakeFetch({ message: { content: CODE } });
  const r = await agent()({ task: TASK, model: "m", limits: LIMITS, fetch: f });
  assert.equal(r.usage, undefined);
});

test("the extracted code becomes the one allowed file; no fence means no files", async () => {
  const r = await agent()({ task: TASK, model: "m", limits: LIMITS, fetch: fakeFetch({ message: { content: CODE }, prompt_eval_count: 1, eval_count: 1 }) });
  assert.deepEqual(Object.keys(r.files), ["t/provenance.test.ts"]);
  assert.match(r.files["t/provenance.test.ts"], /from "vitest"/);
  const none = await agent()({ task: TASK, model: "m", limits: LIMITS, fetch: fakeFetch({ message: { content: "sorry" }, prompt_eval_count: 1, eval_count: 1 }) });
  assert.deepEqual(none.files, {});
});

test("a non-OK answer is an error (it counts toward the failure limit)", async () => {
  await assert.rejects(agent()({ task: TASK, model: "m", limits: LIMITS, fetch: fakeFetch({}, { ok: false, status: 500 }) }), /HTTP 500/);
});

test("the prompt names the ONE allowed file and carries the source and the rules", () => {
  const m = buildMessages({ task: TASK, sourceFiles: SRC, styleExample: "// style" });
  assert.equal(m[0].role, "system");
  assert.match(m[0].content, /ONE test file/);
  assert.match(m[1].content, /You may write ONLY this file: t\/provenance\.test\.ts/);
  assert.match(m[1].content, /export const x = 1;/);
});

test("through the runner: a local run costs $0 and returns the file", async () => {
  const dir = tmp();
  const kill = new KillSwitch({ stateDir: dir });
  const budget = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 0, maxUsdTotal: 0, prices: { "ollama:m": LOCAL_MODEL_PRICE } });
  const f = fakeFetch({ message: { content: CODE }, prompt_eval_count: 5, eval_count: 5 });
  const r = await runTask({ task: TASK, agent: agent(), budget, kill, model: "ollama:m", limits: LIMITS, allowlist: ["127.0.0.1"], realFetch: f });
  assert.equal(r.usd, 0);
  assert.deepEqual(Object.keys(r.files), ["t/provenance.test.ts"]);
});

test("through the runner: an Ollama host off the allowlist trips STOP and nothing is sent", async () => {
  const dir = tmp();
  const kill = new KillSwitch({ stateDir: dir });
  const budget = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 1, maxUsdTotal: 1, prices: { "ollama:m": LOCAL_MODEL_PRICE } });
  const f = fakeFetch({ message: { content: CODE } });
  const evil = makeOllamaAgent({ host: "http://evil.example:11434", sourceFiles: SRC, styleExample: "" });
  await assert.rejects(runTask({ task: TASK, agent: evil, budget, kill, model: "ollama:m", limits: LIMITS, allowlist: ["127.0.0.1"], realFetch: f }), /allowlist/);
  assert.ok(kill.isStopped());
  assert.equal(f.calls.length, 0);
});

test("existing tests that already cover the module are IN the prompt the live adapter sends (they were silently dropped before)", async () => {
  const f = fakeFetch({ message: { content: CODE }, prompt_eval_count: 1, eval_count: 1 });
  const a = makeOllamaAgent({ sourceFiles: SRC, styleExample: "// style", existingTests: { "t/already.test.ts": "it('covered', () => {});" } });
  await a({ task: TASK, model: "m", limits: LIMITS, fetch: f });
  const sent = f.calls[0].body.messages.map((m) => m.content).join("\n");
  assert.match(sent, /t\/already\.test\.ts/);
  assert.match(sent, /do not duplicate them/);
});
