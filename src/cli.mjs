#!/usr/bin/env node
/**
 *   node src/cli.mjs status            spend and STOP state
 *   node src/cli.mjs stop "reason"     trip the kill switch
 *   node src/cli.mjs clear-stop --yes  a human clears it
 *   node src/cli.mjs dry-run <issues.json>   run the loop with a STUB agent (no model, no network)
 *   node src/cli.mjs run-one <issues.json> <issueNumber> --repo <dir> --model <ollama-model> [--host URL] [--no-verify]
 *       ONE issue, a LOCAL Ollama model ($0). Writes the one allowed file into --repo's working tree and runs the
 *       project's own tsc + vitest on it. Never commits, pushes or opens a PR.
 * State lives in $COMMON_CONTRIBUTIONS_HOME (default ~/.divinci/common-contributions).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { Budget, LOCAL_MODEL_PRICE } from "./budget.mjs";
import { KillSwitch } from "./killswitch.mjs";
import { runLoop, runTask } from "./runner.mjs";
import { BudgetExceededError } from "./budget.mjs";
import { StopRequestedError } from "./killswitch.mjs";
import { selectRunnableTasks } from "./scope.mjs";
import { makeOllamaAgent } from "./adapters/ollama.mjs";
import { applyFiles, runChecked } from "./verify.mjs";

const stateDir = process.env.COMMON_CONTRIBUTIONS_HOME || join(homedir(), ".divinci", "common-contributions");
const kill = new KillSwitch({ stateDir });
const budget = new Budget({
  ledgerFile: join(stateDir, "ledger.jsonl"),
  maxUsdPerDay: Number(process.env.CC_MAX_USD_PER_DAY ?? 3),
  maxUsdTotal: Number(process.env.CC_MAX_USD_TOTAL ?? 15),
  prices: { "local:stub": LOCAL_MODEL_PRICE },
});

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "status") {
  console.warn(JSON.stringify({ stateDir, stopped: kill.isStopped(), reason: kill.reason(), spentUsd: budget.spent() }, null, 2));
} else if (cmd === "stop") {
  try { kill.trip(rest.join(" ") || "manual stop"); } catch { console.warn(`stopped: ${kill.file}`); }
} else if (cmd === "clear-stop") {
  if (!rest.includes("--yes")) { console.error("refusing: pass --yes (a human clears the kill switch)"); process.exit(2); }
  rmSync(kill.file, { force: true });
  console.warn("cleared");
} else if (cmd === "dry-run") {
  const issues = JSON.parse(readFileSync(rest[0], "utf8"));
  const tasks = selectRunnableTasks(issues);
  // The STUB agent: writes a placeholder into the one allowed file. Proves the loop, never calls a model.
  const agent = async ({ task }) => ({
    text: `stub run for #${task.number}`,
    files: { [task.allowed[0]]: "// stub\n" },
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const outcomes = await runLoop({
    tasks, agent, budget, kill, model: "local:stub",
    limits: { maxInputTokens: 1000, maxOutputTokens: 1000 },
    allowlist: ["github.com", "api.github.com"],
  });
  console.warn(JSON.stringify(outcomes, null, 2));
} else if (cmd === "run-one") {
  const [issuesFile, numberArg, ...flags] = rest;
  const flag = (name, dflt) => { const i = flags.indexOf(name); return i === -1 ? dflt : flags[i + 1]; };
  const repo = flag("--repo");
  const modelName = flag("--model");
  const host = flag("--host", "http://127.0.0.1:11434");
  if (!issuesFile || !numberArg || !repo || !modelName) { console.error("usage: run-one <issues.json> <issueNumber> --repo <dir> --model <name>"); process.exit(2); }
  const hostName = new URL(host).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostName)) { console.error(`refusing: run-one is for a LOCAL model; host "${hostName}" is not loopback`); process.exit(2); }

  const task = selectRunnableTasks(JSON.parse(readFileSync(issuesFile, "utf8"))).find((t) => String(t.number) === String(numberArg));
  if (!task) { console.error(`issue #${numberArg} is not runnable (needs the agent-ready label and a parseable one-file scope)`); process.exit(2); }

  // Context the model gets: the source file(s) the issue names, and one small existing test as a style example.
  const named = [...String(task.body).matchAll(/`([^`]+\.ts)`/g)].map((m) => m[1]).filter((p) => !p.endsWith(".test.ts") && existsSync(join(repo, p)));
  const sourceFiles = Object.fromEntries(named.map((p) => [p, readFileSync(join(repo, p), "utf8").slice(0, 20000)]));
  const dir = join(repo, dirname(task.allowed[0]));
  const sibling = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)).filter((f) => statSync(f).size < 4000).sort()[0] : undefined;
  const styleExample = sibling ? readFileSync(sibling, "utf8").slice(0, 3000) : "";

  const model = `ollama:${modelName}`;
  const localBudget = new Budget({ ledgerFile: join(stateDir, "ledger.jsonl"), maxUsdPerDay: 0, maxUsdTotal: 0, prices: { [model]: LOCAL_MODEL_PRICE } });
  const agent = makeOllamaAgent({ host, sourceFiles, styleExample, modelName });
  const report = { issue: task.number, model: modelName };
  let result;
  try {
    result = await runTask({
      task, agent, budget: localBudget, kill, model,
      limits: { maxInputTokens: 12000, maxOutputTokens: 2500 },
      allowlist: [hostName],
    });
    report.outcome = "ok";
  } catch (e) {
    report.outcome = e instanceof StopRequestedError ? "stopped" : e instanceof BudgetExceededError ? "budget-stop" : "failed";
    report.reason = e instanceof Error ? e.message : String(e);
  }
  if (result) {
    const files = Object.keys(result.files);
    if (files.length === 0) {
      report.outcome = "no-file";
      report.reason = "the model returned no fenced code block";
    } else {
      report.wrote = applyFiles({ root: repo, files: result.files, allowed: task.allowed });
      if (!flags.includes("--no-verify")) {
        const cwd = join(repo, "orchestrator");
        const tsc = runChecked({ cwd, command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
        const vt = runChecked({ cwd, command: "npx", args: ["--no-install", "vitest", "run", task.allowed[0].replace(/^orchestrator\//, "")] });
        report.tsc = { ok: tsc.ok, tail: (tsc.stdout + tsc.stderr).split("\n").slice(-12).join("\n") };
        report.vitest = { ok: vt.ok, tail: (vt.stdout + vt.stderr).split("\n").slice(-20).join("\n") };
      }
    }
  }
  console.warn(JSON.stringify(report, null, 2));
} else {
  console.error("usage: status | stop [reason] | clear-stop --yes | dry-run <issues.json>");
  process.exit(2);
}
