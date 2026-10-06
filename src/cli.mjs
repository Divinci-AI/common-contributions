#!/usr/bin/env node
/**
 *   node src/cli.mjs status            spend and STOP state
 *   node src/cli.mjs stop "reason"     trip the kill switch
 *   node src/cli.mjs clear-stop --yes  a human clears it
 *   node src/cli.mjs dry-run <issues.json>   run the loop with a STUB agent (no model, no network)
 * State lives in $COMMON_CONTRIBUTIONS_HOME (default ~/.divinci/common-contributions).
 */
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Budget, LOCAL_MODEL_PRICE } from "./budget.mjs";
import { KillSwitch } from "./killswitch.mjs";
import { runLoop } from "./runner.mjs";
import { selectRunnableTasks } from "./scope.mjs";

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
} else {
  console.error("usage: status | stop [reason] | clear-stop --yes | dry-run <issues.json>");
  process.exit(2);
}
