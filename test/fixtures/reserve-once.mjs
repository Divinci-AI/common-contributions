// Child process for the concurrency test: wait for the start flag, try ONE reservation, print "ok" or "refused".
// argv: budgetModulePath ledgerFile goFile worstTokens
import { existsSync } from "node:fs";
const [, , modPath, ledgerFile, goFile, tokens] = process.argv;
const { Budget, BudgetExceededError } = await import(modPath);
const b = new Budget({
  ledgerFile,
  maxUsdPerDay: 1,
  maxUsdTotal: 10,
  prices: { m: { input: 1, output: 0 } }, // $1 per 1M input tokens
});
while (!existsSync(goFile)) { /* spin: both children release at the same instant */ }
try {
  b.reserve("m", Number(tokens), 0); // 600_000 tokens => $0.60; two of them cannot both fit in $1.00/day
  console.log("ok");
} catch (e) {
  console.log(e instanceof BudgetExceededError ? "refused" : `error:${e.message}`);
}
