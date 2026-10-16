/**
 * The model-assisted matcher's edge (Goal 4, M3): the ONE place that talks to a model. Local Ollama on this machine only (D-M5: a hosted matcher is
 * never built into this command; it would be its own opt-in step). Everything here is soft: a failure is "unavailable", never a score.
 *   describeSend  -> the exact text that will be sent (printed BEFORE any call; --dry-run-matcher prints it and stops)
 *   makeOllamaAsk -> an async `ask(task)` with a timeout, a loopback-only host and a validated reply
 *   matchCandidates -> { answers, unavailable, stopped } for the candidates to ask about
 */
import { buildTask, parseChoice, DEFAULT_VARIANT } from "./matcher.mjs";
import { clean } from "./ghsearch.mjs";

export const DEFAULT_HOST = "http://127.0.0.1:11434";
export const ASK_TIMEOUT_MS = 60000;
export const TOTAL_BUDGET_MS = 300000; // the whole matcher gets five minutes; what is not answered by then is unavailable
export const STOP_AFTER_FAILURES = 3; // this many failures in a row and the rest are not asked: a model that is down will not answer the next one either

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The host if it is plain http(s) on this machine, else null. A model name is also checked: it ends up in a request body, not a path, but it is printed. */
export function loopbackHost(host) {
  try {
    const u = new URL(host);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.has(u.hostname) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}
export const validModel = (m) => typeof m === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/.test(m);

/** What would be sent, for display: the destination and, per candidate, the exact system text and prompt. Nothing is sent by calling this. */
export function describeSend({ description, candidates, model, host, variant = DEFAULT_VARIANT }) {
  const out = [`matcher: ${candidates.length} question${candidates.length === 1 ? "" : "s"} to the model "${model}" at ${host} (this machine). Your description and each candidate's public name, description and topics are sent; nothing else, and nothing leaves this machine.`];
  candidates.forEach((c, i) => {
    const t = buildTask(description, c, { variant });
    out.push("", `--- question ${i + 1} of ${candidates.length} (${clean(c.fullName, 120)}) ---`, `system: ${t.system}`, t.prompt);
  });
  return out.join("\n");
}

/** `fetchImpl` is injectable for tests. The reply must be JSON with a string `response`; anything else throws and becomes "unavailable". */
export function makeOllamaAsk({ host, model, fetchImpl = globalThis.fetch, timeoutMs = ASK_TIMEOUT_MS }) {
  const base = loopbackHost(host);
  if (!base) throw new Error("the matcher only talks to a model on this machine (a loopback address)");
  if (!validModel(model)) throw new Error("not a model name");
  return async function ask(task) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: ctl.signal, body: JSON.stringify({ model, system: task.system, prompt: task.prompt, stream: false, think: false, options: { temperature: 0, num_predict: 8 } }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(await r.text());
      if (typeof j?.response !== "string") throw new Error("no text in the reply");
      return j.response;
    } finally { clearTimeout(timer); }
  };
}

/** The model's version for the "model opinion (name, version)" label: the digest Ollama lists for it, or null. Never throws. */
export async function modelVersion({ host, model, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  const base = loopbackHost(host);
  if (!base) return null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${base}/api/tags`, { redirect: "error", signal: ctl.signal });
    if (!r.ok) return null;
    const j = JSON.parse(await r.text());
    const m = Array.isArray(j?.models) ? j.models.find((x) => x?.name === model || x?.model === model) : null;
    return typeof m?.digest === "string" && /^[0-9a-f]{12,128}$/.test(m.digest) ? m.digest.slice(0, 12) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Ask about each candidate in turn. Returns { answers: fullName -> "yes"|"partly"|"no", unavailable: [fullName], stopped: bool }.
 * A throw, a timeout or an answer that is not a single listed letter makes THAT candidate unavailable. After STOP_AFTER_FAILURES in a row the rest are
 * not asked (and are unavailable). A candidate is never given an answer the model did not give.
 */
export async function matchCandidates({ description, candidates, ask, variant = DEFAULT_VARIANT, budgetMs = TOTAL_BUDGET_MS, clock = Date.now }) {
  const answers = {}, unavailable = [], deadline = clock() + budgetMs;
  let streak = 0, stopped = false;
  for (const c of candidates) {
    if (!stopped && clock() > deadline) stopped = true;
    if (stopped) { unavailable.push(c.fullName); continue; }
    let label = null, failed = false;
    try { label = parseChoice(await ask(buildTask(description, c, { variant }))); } catch { failed = true; }
    if (label) { answers[c.fullName] = label; streak = 0; continue; }
    unavailable.push(c.fullName);
    if (!failed) { streak = 0; continue; } // an unreadable answer is the model replying; only a call that FAILED counts toward "the model is down"
    if (++streak >= STOP_AFTER_FAILURES) stopped = true;
  }
  return { answers, unavailable, stopped };
}
