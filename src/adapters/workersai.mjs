/**
 * Cloudflare Workers AI adapter: a HOSTED model, billed per token to whoever owns the API token.
 * The agent function the runner expects: ({ task, model, limits, fetch }) -> { text, files, usage, usageRequired }
 *
 * - The request goes through the runner's GUARDED fetch, so the allowlist (api.cloudflare.com) is enforced for it too.
 * - Workers AI has no per-key hard spend limit, so the cap lives in budget.mjs. That cap is only as good as the INPUT bound:
 *   the worst case is priced from limits.maxInputTokens, so an over-long prompt is refused here BEFORE the call.
 * - Token usage is MEASURED from the provider's own `usage` object. If it is missing, `usage` stays undefined and the runner charges
 *   the WORST CASE (never zero) and counts the call as a failure, so three in a row trip STOP. `usageRequired` tells it to.
 * - The token is held in a closure. It is never put in a prompt, an error message, or a log line.
 * - The model gets no tools and no shell: it returns text, the harness writes the one allowed file (verify.mjs).
 */
import { buildMessages, extractCodeBlock } from "./ollama.mjs";

/**
 * USD per 1M tokens, from https://developers.cloudflare.com/workers-ai/platform/pricing/ (page last updated 2026-10-01).
 * The free daily allocation (10,000 neurons) is IGNORED on purpose: every token is priced as billed, which can only over-count.
 * Keys are ledger ids: "workers-ai:" + the model name. A model not listed here is refused by Budget.priceFor.
 */
export const WORKERS_AI_PRICES = Object.freeze({
  "workers-ai:@cf/qwen/qwen2.5-coder-32b-instruct": { input: 0.66, output: 1.0 },
  "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "workers-ai:@cf/deepseek-ai/deepseek-v4-flash-0731": { input: 0.44, output: 1.32 }, // cached-input discount ignored: over-counts
  "workers-ai:@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
});

export class PromptTooLargeError extends Error {
  constructor(estimated, limit) {
    super(`prompt is about ${estimated} tokens, over the ${limit}-token input bound the budget was reserved against; refusing before the call`);
    this.name = "PromptTooLargeError";
  }
}

/** A deliberately HIGH estimate (3 characters per token): source code tokenises at roughly 3 to 4. */
export const estimateTokens = (messages) => Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3);

const bareModel = (ledgerId) => ledgerId.replace(/^workers-ai:/, "");

export function makeWorkersAiAgent({ accountId, apiToken, sourceFiles, styleExample, existingTests }) {
  if (!accountId || !apiToken) throw new Error("workers-ai needs an account id and an API token");
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error("the Cloudflare account id should be 32 hex characters");
  return async function workersAiAgent({ task, model, limits, fetch }) {
    const messages = buildMessages({ task, sourceFiles, styleExample, existingTests });
    const estimated = estimateTokens(messages);
    if (estimated > limits.maxInputTokens) throw new PromptTooLargeError(estimated, limits.maxInputTokens);

    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${bareModel(model)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ messages, max_tokens: limits.maxOutputTokens, temperature: 0 }),
    });
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`workers-ai answered HTTP ${res.status} with a non-JSON body: ${raw.slice(0, 200)}`);
    }
    if (!res.ok || body?.success === false) {
      const why = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || raw.slice(0, 200);
      throw new Error(`workers-ai answered HTTP ${res.status}: ${why}`);
    }
    const result = body?.result ?? {};
    const text = result.response ?? result.choices?.[0]?.message?.content ?? "";
    const u = result.usage;
    const measured =
      Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens)
        ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
        : undefined;
    const code = extractCodeBlock(text);
    return { text, files: code ? { [task.allowed[0]]: code } : {}, usage: measured, usageRequired: true };
  };
}
