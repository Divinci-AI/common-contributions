/**
 * Ollama adapter: a local model, $0. The agent function the runner expects:
 *   ({ task, model, limits, fetch }) -> { text, files, usage }
 *
 * - The request goes through the runner's GUARDED fetch, so the allowlist (127.0.0.1) is enforced for it too.
 * - Token usage is MEASURED from Ollama's own counters (prompt_eval_count / eval_count). If they are missing,
 *   `usage` is left undefined and the runner falls back to the WORST CASE — never to zero.
 * - The model returns the file as text; this adapter extracts it. The model gets no tools and no shell, so it can
 *   neither run commands nor write anywhere: the harness writes the one allowed file itself (see verify.mjs).
 */
export const SYSTEM_PROMPT = [
  "You write ONE test file for an open-source TypeScript repo, as an AI agent. A human will review it.",
  "Rules: output exactly one fenced code block (```ts ... ```) containing the COMPLETE file, and nothing else of substance.",
  "Use only vitest (`import { describe, it, expect } from \"vitest\"`). Tests must run offline with no network and no credentials.",
  "Import the module under test with a relative path exactly as shown in the style example. Do not invent exports:",
  "only test functions that appear in the provided source. If the source disagrees with its own comments, test what the",
  "code does and add a comment `// NOTE: code disagrees with its comment` rather than guessing.",
  "Never include secrets, URLs, or file paths outside the repo.",
].join("\n");

export function buildMessages({ task, sourceFiles, styleExample }) {
  const sources = Object.entries(sourceFiles)
    .map(([path, text]) => `### ${path}\n\`\`\`ts\n${text}\n\`\`\``)
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Task (GitHub issue #${task.number}): ${task.title}`,
        "",
        task.body ?? "",
        "",
        `You may write ONLY this file: ${task.allowed.join(", ")}`,
        "",
        "Source under test:",
        sources,
        "",
        "Style example (an existing test in this repo):",
        "```ts",
        styleExample,
        "```",
      ].join("\n"),
    },
  ];
}

/** The first fenced code block, or null. Language tag optional. */
export function extractCodeBlock(text) {
  const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(String(text ?? ""));
  return m ? m[1].replace(/\s+$/, "") + "\n" : null;
}

export function makeOllamaAgent({ host = "http://127.0.0.1:11434", sourceFiles, styleExample, modelName }) {
  return async function ollamaAgent({ task, model, limits, fetch }) {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // `model` is the ledger/price key (e.g. "ollama:gemma4:e2b"); Ollama wants the bare name.
        model: modelName ?? model,
        stream: false,
        options: { temperature: 0, num_predict: limits.maxOutputTokens },
        messages: buildMessages({ task, sourceFiles, styleExample }),
      }),
    });
    if (!res.ok) throw new Error(`ollama answered HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.message?.content ?? "";
    const code = extractCodeBlock(text);
    const measured =
      Number.isFinite(body?.prompt_eval_count) && Number.isFinite(body?.eval_count)
        ? { inputTokens: body.prompt_eval_count, outputTokens: body.eval_count }
        : undefined;
    return { text, files: code ? { [task.allowed[0]]: code } : {}, usage: measured };
  };
}
