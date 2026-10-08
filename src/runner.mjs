/**
 * The loop. It owns every decision that must not be left to the model: whether to run, what a call may cost, what
 * the agent may reach, whether its output is safe, and whether its change stays inside the task's scope.
 * The agent is a plain async function — no model is wired in here.
 */
import { BudgetExceededError } from "./budget.mjs";
import { assertAllowedUrl, EgressDeniedError, hostOf, isReservedTestHost, urlsIn } from "./egress.mjs";
import { StopRequestedError } from "./killswitch.mjs";
import { diffScopeViolations, isAgentBranch } from "./scope.mjs";
import { scanAddedForEntropy, scanForSecrets } from "./secrets.mjs";

/** A fetch the agent can use that refuses (and trips STOP) for anything off the allowlist. */
export function guardedFetch({ allowlist, kill, realFetch = globalThis.fetch }) {
  return async (url, init) => {
    kill.check();
    try {
      assertAllowedUrl(String(url), allowlist);
    } catch (e) {
      if (e instanceof EgressDeniedError) kill.trip(`network call outside the allowlist: ${e.details.host ?? "unparseable URL"}`);
      throw e;
    }
    return realFetch(url, init);
  };
}

/**
 * @returns {Promise<{ files: Record<string,string>, usd: number }>}
 * Throws StopRequestedError (kill switch / egress / secret / scope), BudgetExceededError (refused before the call).
 */
export async function runTask({ task, agent, budget, kill, model, limits, allowlist, realFetch }) {
  kill.check();
  if (!task.allowed?.length) throw new Error(`task #${task.number} names no allowed path; not runnable`);

  const hold = budget.reserveHold(model, limits.maxInputTokens, limits.maxOutputTokens);

  let result;
  try {
    result = await agent({ task, model, limits, fetch: guardedFetch({ allowlist, kill, realFetch }) });
  } catch (e) {
    budget.release(hold.id); // the call failed: its reservation must not keep eating headroom
    if (e instanceof StopRequestedError) throw e;
    kill.noteFailure(`agent error on #${task.number}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  // The call happened: it goes on the ledger whatever we think of the output.
  const usd = budget.record(model, result.usage?.inputTokens ?? limits.maxInputTokens, result.usage?.outputTokens ?? limits.maxOutputTokens, hold.id);

  // The reservation was priced from the input and output bounds. A provider that reports MORE than that means the bound was wrong,
  // so the cap was not what it claimed: the spend is recorded (above), and everything stops until a person looks.
  if (result.usage && (result.usage.inputTokens > limits.maxInputTokens || result.usage.outputTokens > limits.maxOutputTokens)) {
    kill.trip(`#${task.number}: the provider reported ${result.usage.inputTokens} in / ${result.usage.outputTokens} out, over the reserved ${limits.maxInputTokens} / ${limits.maxOutputTokens}`);
  }
  // An adapter that must report usage and did not: the worst case was charged, and three of these in a row trip STOP.
  const unmeasured = Boolean(result.usageRequired && !result.usage);
  if (unmeasured) kill.noteFailure(`#${task.number}: the provider reported no token usage`);

  const files = result.files ?? {};
  const everything = [result.text ?? "", ...Object.values(files)].join("\n");

  if (scanForSecrets(everything).length > 0) kill.trip(`secret-shaped string in the output of #${task.number}`);
  // Prefix-less secrets: only what was ADDED counts (the reply text has no baseline; each file is compared with its original).
  const addedEntropy = [
    ...scanAddedForEntropy(result.text ?? ""),
    ...Object.entries(files).flatMap(([path, content]) => scanAddedForEntropy(content, task.baseFiles?.[path] ?? "")),
  ];
  if (addedEntropy.length > 0) kill.trip(`high-entropy string added in the output of #${task.number}`);

  for (const url of urlsIn(everything)) {
    // A reserved documentation/test host (example.com, *.invalid, localhost...) reaches nobody: a fixture, not a fetch.
    if (isReservedTestHost(hostOf(url))) continue;
    try {
      assertAllowedUrl(url, allowlist);
    } catch {
      // A URL in the output is not a request — but an agent steered into emitting one is worth a human look.
      kill.trip(`output of #${task.number} references a host outside the allowlist`);
    }
  }

  const violations = diffScopeViolations(Object.keys(files), task.allowed);
  if (violations.length > 0) kill.trip(`#${task.number} changed files outside its scope: ${violations.join(", ")}`);

  if (!unmeasured) kill.noteSuccess(); // an unmeasured call must not wipe the count that is about to trip STOP
  return { files, usd };
}

/** Refuse to publish anywhere but an agent/ branch, or with a changed file outside scope, or while stopped. */
export function assertPublishable({ branch, changedFiles, allowed, kill }) {
  kill.check();
  if (!isAgentBranch(branch)) throw new Error(`refusing to publish to "${branch}": only agent/* branches (never main/preview)`);
  const bad = diffScopeViolations(changedFiles, allowed);
  if (bad.length > 0) throw new Error(`refusing to publish: files outside scope: ${bad.join(", ")}`);
}

/** Run tasks in order. Stops the whole loop on STOP or a refused budget; records every outcome. */
export async function runLoop({ tasks, ...ctx }) {
  const outcomes = [];
  for (const task of tasks) {
    try {
      const r = await runTask({ task, ...ctx });
      outcomes.push({ number: task.number, status: "ok", usd: r.usd, files: Object.keys(r.files) });
    } catch (e) {
      if (e instanceof StopRequestedError) {
        outcomes.push({ number: task.number, status: "stopped", reason: e.reason });
        break;
      }
      if (e instanceof BudgetExceededError) {
        outcomes.push({ number: task.number, status: "budget-stop", reason: e.message });
        break;
      }
      outcomes.push({ number: task.number, status: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}
