#!/usr/bin/env node
/**
 *   node src/cli.mjs status            spend and STOP state
 *   node src/cli.mjs stop "reason"     trip the kill switch
 *   node src/cli.mjs clear-stop --yes  a human clears it
 *   node src/cli.mjs dry-run <issues.json>   run the loop with a STUB agent (no model, no network)
 *   node src/cli.mjs run-one <issues.json> <issueNumber> --repo <dir> --model <ollama-model> [--host URL] [--no-verify | --container-image <id> [--docker /abs/docker] [--runtime-pin file] | --allow-host-execution]
 *       (--reply-file F [--tokens in,out]: replay an already-written reply through the same checks; --print-prompt: show the prompt)
 *       ONE issue, a LOCAL Ollama model ($0). Writes the one allowed file into --repo's working tree and runs the
 *       project's own tsc + vitest on it. Never commits, pushes or opens a PR.
 * State lives in $COMMON_CONTRIBUTIONS_HOME (default ~/.local/state/common-ai; see paths.mjs).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { Budget, LOCAL_MODEL_PRICE } from "./budget.mjs";
import { WORKERS_AI_PRICES, makeWorkersAiAgent } from "./adapters/workersai.mjs";
import { defaultStateDir } from "./paths.mjs";
import { KillSwitch } from "./killswitch.mjs";
import { runLoop, runTask } from "./runner.mjs";
import { BudgetExceededError } from "./budget.mjs";
import { StopRequestedError } from "./killswitch.mjs";
import { selectRunnableTasks } from "./scope.mjs";
import { buildMessages, makeOllamaAgent } from "./adapters/ollama.mjs";
import { makeReplayAgent } from "./adapters/replay.mjs";
import { applyFiles, runChecked } from "./verify.mjs";
import { coverageReport, unacknowledgedTests } from "./coverage.mjs";
import { runMutations } from "./mutate.mjs";
import { runContained, readRuntime } from "./container.mjs";
import { buildDepImage } from "./depimage.mjs";
import { writeFileSync as writeFile } from "node:fs";
import { copySource } from "./sourcecopy.mjs";
import { randomBytes } from "node:crypto";
import { rmSync as rmTree } from "node:fs";
import { spawnSync } from "node:child_process";

// Until the container verifier exists, running model-written code is a host execution. It is refused unless a person says so, every time.
const HOST_FLAG = "--allow-host-execution";
const HOST_REFUSAL = `refusing to run model-written code on this machine without a container. Pass --container-image <image id> (see build-deps), or ${HOST_FLAG} to run it on the host anyway, or --no-verify to skip verification.`;

const CONTAINER_FLAG = "--container-image";
/** Run a command in the container on a per-run copy of the source. Returns {ok, tail, ...} or {refused}. */
function containerCheck({ flagsArr, srcDir, subdir, cmd }) {
  const at = (n) => { const i = flagsArr.indexOf(n); return i === -1 ? undefined : flagsArr[i + 1]; };
  const image = at(CONTAINER_FLAG);
  const docker = at("--docker") ?? spawnSync("/usr/bin/which", ["docker"], { encoding: "utf8" }).stdout.trim();
  const pinFile = at("--runtime-pin");
  const pin = pinFile ? JSON.parse(readFileSync(pinFile, "utf8")) : undefined;
  const r = runContained({ docker, image, srcDir, subdir, cmd, runId: randomBytes(6).toString("hex"), pin });
  if (!r.ran) return { ran: false, ok: false, refused: r.refused, tail: r.refused };
  return { ran: true, ok: r.ok, timedOut: r.timedOut, tail: (r.stdout + r.stderr).split("\n").slice(-20).join("\n") };
}

const stateDir = defaultStateDir();
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
  const replyFile = flag("--reply-file");
  const provider = flag("--provider", "ollama"); // "ollama" (local, $0) | "workers-ai" (hosted, capped by the ledger)
  if (!["ollama", "workers-ai"].includes(provider)) { console.error(`unknown --provider "${provider}"`); process.exit(2); }
  const hostName = new URL(host).hostname;
  // A replayed reply needs no network at all; a live local model must be loopback.
  if (!replyFile && provider === "ollama" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostName)) { console.error(`refusing: the ollama provider is for a LOCAL model; host "${hostName}" is not loopback`); process.exit(2); }

  const task = selectRunnableTasks(JSON.parse(readFileSync(issuesFile, "utf8"))).find((t) => String(t.number) === String(numberArg));
  if (!task) { console.error(`issue #${numberArg} is not runnable (needs the agent-ready label and a parseable one-file scope)`); process.exit(2); }

  // Context the model gets: the source file(s) the issue names, and one small existing test as a style example.
  const named = [...String(task.body).matchAll(/`([^`]+\.ts)`/g)].map((m) => m[1]).filter((p) => !p.endsWith(".test.ts") && existsSync(join(repo, p)));
  const sourceFiles = Object.fromEntries(named.map((p) => [p, readFileSync(join(repo, p), "utf8").slice(0, 20000)]));
  const dir = join(repo, dirname(task.allowed[0]));
  const sibling = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)).filter((f) => statSync(f).size < 4000).sort()[0] : undefined;
  const styleExample = sibling ? readFileSync(sibling, "utf8").slice(0, 3000) : "";

  // COVERAGE GATE: every existing test that already imports a module this issue names must be NAMED in the issue.
  // (An issue was once filed for a module that already had tests, because the check looked only for a sibling file.)
  const existingTests = {};
  const unacknowledged = [];
  for (const mod of named) {
    const rep = coverageReport({ root: repo, modulePath: mod, allowed: task.allowed });
    for (const f of unacknowledgedTests(rep, task.body)) unacknowledged.push(`${f} (covers ${mod})`);
    for (const f of rep.referencingTests.slice(0, 3)) existingTests[f] = readFileSync(join(repo, f), "utf8").slice(0, 6000);
  }
  if (unacknowledged.length > 0) {
    console.error(`refusing: existing tests already import a module this issue names, and the issue does not mention them:\n  ${unacknowledged.join("\n  ")}\nName them in the issue (and say what they do not cover), then re-run.`);
    process.exit(2);
  }

  if (flags.includes("--print-prompt")) {
    // Exactly what a live model would be sent — for handing to an agent that is not behind the Ollama adapter.
    const m = buildMessages({ task, sourceFiles, styleExample, existingTests });
    console.log(m.map((x) => `[${x.role}]\n${x.content}`).join("\n\n"));
    process.exit(0);
  }

  const hosted = provider === "workers-ai" && !replyFile;
  const model = replyFile ? `claude-code:${modelName}` : hosted ? `workers-ai:${modelName}` : `ollama:${modelName}`;
  // Local and replayed runs cost $0 and are never refused by the cap. A hosted run is priced from the published table and capped by the
  // same caps as everything else (CC_MAX_USD_PER_DAY default 3, CC_MAX_USD_TOTAL default 15) against the SAME ledger file.
  const localBudget = new Budget({
    ledgerFile: join(stateDir, "ledger.jsonl"),
    maxUsdPerDay: hosted ? Number(process.env.CC_MAX_USD_PER_DAY ?? 3) : 0,
    maxUsdTotal: hosted ? Number(process.env.CC_MAX_USD_TOTAL ?? 15) : 0,
    prices: hosted ? WORKERS_AI_PRICES : { [model]: LOCAL_MODEL_PRICE },
  });
  // A replayed reply came from an agent that had tools. The design is "text in, text out": if it reports ANY tool
  // use, the run is refused and STOP is tripped — we cannot vouch for what a tool-using agent did to the machine.
  const toolUses = flag("--tool-uses");
  if (replyFile && toolUses !== undefined && Number(toolUses) !== 0) {
    try { kill.trip(`replayed agent reported ${toolUses} tool use(s); text-only is required`); } catch (e) { console.warn(JSON.stringify({ issue: task.number, model: modelName, outcome: "stopped", reason: e.message }, null, 2)); }
    process.exit(0);
  }
  if (replyFile && toolUses === undefined) { console.error("refusing: a replayed reply must say how many tools the agent used (--tool-uses N)"); process.exit(2); }
  const tokens = flag("--tokens"); // "in,out" as reported by the caller for a replayed reply (informational; $0)
  const reported = tokens ? { inputTokens: Number(tokens.split(",")[0]), outputTokens: Number(tokens.split(",")[1]) } : undefined;
  // The account id and token come from the environment (e.g. `infisical run`); only these two are read, and neither is ever printed.
  const accountId = process.env.CC_WORKERS_AI_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CC_WORKERS_AI_TOKEN ?? process.env.CLOUDFLARE_WORKER_AI_KEY;
  if (hosted && (!accountId || !apiToken)) { console.error("refusing: the workers-ai provider needs CC_WORKERS_AI_ACCOUNT_ID and CC_WORKERS_AI_TOKEN (or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKER_AI_KEY) in the environment"); process.exit(2); }
  const agent = replyFile
    ? makeReplayAgent({ replyText: readFileSync(replyFile, "utf8"), usage: reported })
    : hosted
      ? makeWorkersAiAgent({ accountId, apiToken, sourceFiles, styleExample, existingTests })
      : makeOllamaAgent({ host, sourceFiles, styleExample, modelName, existingTests });
  const report = { issue: task.number, model: modelName };
  let result;
  try {
    // The files as they are now, so the entropy scan judges only what the agent adds.
    const baseFiles = Object.fromEntries(task.allowed.filter((p) => existsSync(join(repo, p))).map((p) => [p, readFileSync(join(repo, p), "utf8")]));
    result = await runTask({
      task: { ...task, baseFiles }, agent, budget: localBudget, kill, model,
      limits: { maxInputTokens: 12000, maxOutputTokens: 2500 },
      allowlist: replyFile ? [] : hosted ? ["api.cloudflare.com"] : [hostName],
    });
    report.outcome = "ok";
    report.provider = hosted ? "workers-ai" : replyFile ? "replay" : "ollama";
    report.usd = result.usd;
    report.ledger = localBudget.spent();
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
      if (!flags.includes("--no-verify") && flags.includes(CONTAINER_FLAG)) {
        const copy = copySource(repo); // after applyFiles, so the copy holds the model's file; the live checkout is not mounted
        try {
          const rel = task.allowed[0].replace(/^orchestrator\//, "");
          const tsc = containerCheck({ flagsArr: flags, srcDir: copy, subdir: "orchestrator", cmd: ["/work/node_modules/.bin/tsc", "--noEmit"] });
          const vt = containerCheck({ flagsArr: flags, srcDir: copy, subdir: "orchestrator", cmd: ["/work/node_modules/.bin/vitest", "run", "--configLoader", "runner", rel] });
          report.verify = { ran: tsc.ran && vt.ran, where: "container (no network, read-only source)", ...(tsc.refused || vt.refused ? { refused: tsc.refused ?? vt.refused } : {}) };
          report.tsc = { ok: tsc.ok, tail: tsc.tail };
          report.vitest = { ok: vt.ok, tail: vt.tail };
        } finally { rmTree(copy, { recursive: true, force: true }); }
      } else if (!flags.includes("--no-verify") && !flags.includes(HOST_FLAG)) {
        report.verify = { ran: false, refused: HOST_REFUSAL };
      } else if (!flags.includes("--no-verify")) {
        report.verify = { ran: true, where: "host (no container)" };
        const cwd = join(repo, "orchestrator");
        const tsc = runChecked({ cwd, command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
        const vt = runChecked({ cwd, command: "npx", args: ["--no-install", "vitest", "run", task.allowed[0].replace(/^orchestrator\//, "")] });
        report.tsc = { ok: tsc.ok, tail: (tsc.stdout + tsc.stderr).split("\n").slice(-12).join("\n") };
        report.vitest = { ok: vt.ok, tail: (vt.stdout + vt.stderr).split("\n").slice(-20).join("\n") };
      }
    }
  }
  console.warn(JSON.stringify(report, null, 2));
} else if (cmd === "build-deps") {
  // Stage A: the only step with network access. Prints the image id to pass as --container-image.
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const project = flag("--project"), base = flag("--base");
  const docker = flag("--docker") ?? spawnSync("/usr/bin/which", ["docker"], { encoding: "utf8" }).stdout.trim();
  if (!project || !base) { console.error("usage: build-deps --project <dir with package.json + package-lock.json> --base <name@sha256:digest> [--docker /abs/docker]"); process.exit(2); }
  const r = buildDepImage({ docker, projectDir: project, baseDigest: base });
  if (!r.ok) { console.error(r.refused); process.exit(2); }
  console.log(r.image);
} else if (cmd === "pin-runtime") {
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const out = flag("--out");
  const docker = flag("--docker") ?? spawnSync("/usr/bin/which", ["docker"], { encoding: "utf8" }).stdout.trim();
  if (!out) { console.error("usage: pin-runtime --out runtime-pin.json [--docker /abs/docker]  (run the escape tests first; the pin says which runtime they passed on)"); process.exit(2); }
  writeFile(out, JSON.stringify(readRuntime(docker), null, 2) + "\n");
  console.log(`wrote ${out}`);
} else if (cmd === "coverage") {
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const repo = flag("--repo"), mod = flag("--module");
  if (!repo || !mod) { console.error("usage: coverage --repo <dir> --module <path/to/source.ts>"); process.exit(2); }
  console.log(JSON.stringify(coverageReport({ root: repo, modulePath: mod }), null, 2));
} else if (cmd === "mutate") {
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const repo = flag("--repo"), source = flag("--source"), test = flag("--test"), file = flag("--mutations"), cwdRel = flag("--cwd") ?? ".";
  if (!repo || !source || !test || !file) { console.error("usage: mutate --repo <dir> --source <path> --test <path> --mutations <file.json> [--cwd <subdir>]"); process.exit(2); }
  const inContainer = rest.includes(CONTAINER_FLAG);
  if (!inContainer && !rest.includes(HOST_FLAG)) { console.error(HOST_REFUSAL); process.exit(2); }
  const copy = inContainer ? copySource(repo) : undefined;
  const root = copy ?? repo;
  const cwd = join(root, cwdRel);
  const testInCwd = test.startsWith(cwdRel + "/") ? test.slice(cwdRel.length + 1) : test;
  const runTest = () => {
    if (inContainer) {
      const c = containerCheck({ flagsArr: rest, srcDir: copy, subdir: cwdRel === "." ? "" : cwdRel, cmd: ["/work/node_modules/.bin/vitest", "run", "--configLoader", "runner", testInCwd] });
      return { ok: c.ok, output: c.tail ?? "" };
    }
    const r = runChecked({ cwd, command: "npx", args: ["--no-install", "vitest", "run", testInCwd] });
    return { ok: r.ok, output: r.stdout + r.stderr };
  };
  let out;
  try { out = runMutations({ root, sourcePath: source, mutations: JSON.parse(readFileSync(file, "utf8")), runTest }); } finally { if (copy) rmTree(copy, { recursive: true, force: true }); }
  console.warn(JSON.stringify(out, null, 2));
} else {
  console.error("usage: status | stop [reason] | clear-stop --yes | dry-run <issues.json> | run-one ... | build-deps ... | pin-runtime ... | coverage ... | mutate ...");
  process.exit(2);
}
