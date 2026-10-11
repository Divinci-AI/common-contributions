#!/usr/bin/env node
/**
 *   node src/cli.mjs status            spend and STOP state
 *   node src/cli.mjs stop "reason"     trip the kill switch
 *   node src/cli.mjs clear-stop --yes  a human clears it
 *   node src/cli.mjs dry-run <issues.json>   run the loop with a STUB agent (no model, no network)
 *   node src/cli.mjs run-one <issues.json> <issueNumber> --repo <dir> --model <ollama-model> [--host URL] [--no-verify | --container-image <id> [--docker /abs/docker] [--runtime-pin file] | --allow-host-execution]
 *       (--reply-file F [--tokens in,out]: replay an already-written reply through the same checks; --print-prompt: show the prompt)
 *       ONE issue, a LOCAL Ollama model ($0). Checks the one allowed file (written into --repo's working tree only with --apply; --out DIR writes it elsewhere) and runs the
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
import { readRuntime, LIMITS } from "./container.mjs";
import { buildDepImage, buildPyDepImage } from "./depimage.mjs";
import { pinRequirements } from "./hashpin.mjs";
import { writeFileSync as writeFile } from "node:fs";
import { copySource, copyFromGit, resolveBase, attributeProblems, baseModeProblems } from "./sourcecopy.mjs";
import { resolveProfile, testRelative } from "./profile.mjs";
import { runProfileChecks } from "./verifier.mjs";
import { buildRecord, verifyRecord, harnessIdentity, issueHash, loadOrCreateKey } from "./record.mjs";
import { loadPin, qualifyRuntime, parseTap } from "./pin.mjs";
import { cleanup } from "./hygiene.mjs";
import { parseOptIn } from "./optin.mjs";
import { createGh, ghRunner } from "./ghclient.mjs";
import { dryRun, publish, ghWriter, readLedger, certifyAfterReview } from "./execute.mjs";
import { DCO_TEXT, DCO_WARNING, CLA_WARNING } from "./legal.mjs";
import { openSync as fsOpen, writeSync as fsWrite, closeSync as fsClose } from "node:fs";
import { ttyAsk, escapeForTerminal } from "./tty.mjs";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rmSync as rmTree } from "node:fs";
import { spawnSync } from "node:child_process";

// Until the container verifier exists, running model-written code is a host execution. It is refused unless a person says so, every time.
const HOST_FLAG = "--allow-host-execution";
const HOST_REFUSAL = `refusing to run model-written code on this machine without a container. Pass --container-image <image id> (see build-deps), or ${HOST_FLAG} to run it on the host anyway, or --no-verify to skip verification.`;

const CONTAINER_FLAG = "--container-image";
const dockerPath = (flagsArr) => { const i = flagsArr.indexOf("--docker"); return i !== -1 ? flagsArr[i + 1] : spawnSync("/usr/bin/which", ["docker"], { encoding: "utf8" }).stdout.trim(); };
const pinFor = (flagsArr) => { const i = flagsArr.indexOf("--runtime-pin"); return loadPin(i !== -1 ? flagsArr[i + 1] : join(stateDir, "runtime-pin.json")); };
/** Model output is NOT written to the working tree unless --apply is passed (Michael confirmed 2026-10-11). --out writes it to a directory instead. */
export const LIVE_WRITE_DEFAULT = false;

/** The repository's origin as "host/owner/name" for display and for the publisher to resolve; null if there is none. Credentials in a URL are dropped. */
const originOf = (repo) => {
  const r = spawnSync("/usr/bin/git", ["-C", repo, "remote", "get-url", "origin"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/^(?:https?:\/\/(?:[^@\/]*@)?|git@|ssh:\/\/git@)([^\/:]+)[\/:]([^\/]+\/[^\/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
};

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

  const task = selectRunnableTasks(JSON.parse(readFileSync(issuesFile, "utf8")), flag("--task-label", "agent-ready")).find((t) => String(t.number) === String(numberArg));
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
      // Host verification runs the project's tools on the working tree, so it cannot check a file that is not there: the host flag implies the write.
      const hostVerify = flags.includes(HOST_FLAG) && !flags.includes("--no-verify") && !flags.includes(CONTAINER_FLAG);
      const live = flags.includes("--apply") || hostVerify || (LIVE_WRITE_DEFAULT && !flags.includes("--no-apply"));
      if (live) report.wrote = applyFiles({ root: repo, files: result.files, allowed: task.allowed });
      if (flag("--out")) {
        mkdirSync(flag("--out"), { recursive: true });
        report.out = applyFiles({ root: flag("--out"), files: result.files, allowed: task.allowed });
      }
      if (!flags.includes("--no-verify") && flags.includes(CONTAINER_FLAG)) {
        let dir;
        try {
          const profile = resolveProfile(flag("--profile", "node"));
          const docker = dockerPath(flags), image = flag(CONTAINER_FLAG), pin = pinFor(flags);
          const base = resolveBase(repo, flag("--base", "HEAD"));
          let source;
          if (base) {
            // The source as upstream has it at a recorded commit (no local edits), plus exactly the model's files.
            const attr = [...attributeProblems(repo, result.files, base), ...baseModeProblems(repo, base, Object.keys(result.files))];
            if (attr.length > 0) throw new Error(`refusing: ${attr.join("; ")}`);
            ({ dir } = copyFromGit(repo, base));
            source = "git-archive";
          } else {
            dir = copySource(repo);
            source = "working-tree-copy (not publishable: no recorded commit)";
          }
          applyFiles({ root: dir, files: result.files, allowed: task.allowed });
          const v = runProfileChecks({ docker, image, pin, srcDir: dir, profile, testPath: task.allowed[0] });
          report.verify = { ran: v.ran, where: "container (no network, read-only source)", ...(v.refused ? { refused: v.refused } : {}) };
          for (const c of v.checks ?? []) report[c.name] = { ok: c.ok, tail: c.tail };
          const harnessDir = fileURLToPath(new URL("..", import.meta.url));
          const rec = buildRecord({
            harness: harnessIdentity(harnessDir), project: { dir: basename(repo) }, origin: originOf(repo), issue: { number: task.number, sha256: issueHash(task.title, task.body) }, model, key: loadOrCreateKey(stateDir), base, source, container: v.ran === true,
            runtime: v.runtime, pin, image, dep: v.dep, limits: LIMITS, profile: profile.language, files: result.files,
            checks: (v.checks ?? []).map((c) => ({ name: c.name, argv: c.argv, status: c.status, timedOut: c.timedOut, tail: c.tail })), ledger: report.ledger,
          });
          const recDir = flag("--out") ?? join(stateDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-issue${task.number}`);
          mkdirSync(recDir, { recursive: true });
          writeFile(join(recDir, "run-record.json"), JSON.stringify(rec, null, 2) + "\n");
          report.record = join(recDir, "run-record.json");
        } catch (e) {
          report.verify = { ran: false, refused: e instanceof Error ? e.message : String(e) };
        } finally { if (dir) rmTree(dir, { recursive: true, force: true }); }
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
  if (!project || !base) { console.error("usage: build-deps --project <dir with package.json + package-lock.json, or with --python a hashed requirements.txt> --base <name@sha256:digest> [--python] [--docker /abs/docker]"); process.exit(2); }
  const r = (rest.includes("--python") ? buildPyDepImage : buildDepImage)({ docker, projectDir: project, baseDigest: base });
  if (!r.ok) { console.error(r.refused); process.exit(2); }
  console.log(r.image);
} else if (cmd === "pin-requirements") {
  // Python hash-pin step: plain requirements in, hashed wheels-only requirements.txt out. Pip runs in a throwaway container; nothing from the project runs.
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const specFile = flag("--spec"), base = flag("--base"), out = flag("--out");
  const docker = dockerPath(rest);
  if (!specFile || !base || !out) { console.error("usage: pin-requirements --spec <plain requirements file> --base <name@sha256:digest> --out <requirements.txt to write> [--docker /abs/docker]"); process.exit(2); }
  const r = pinRequirements({ docker, baseDigest: base, specText: readFileSync(specFile, "utf8") });
  if (!r.ok) { console.error(r.refused); process.exit(2); }
  writeFile(out, r.requirements);
  console.log(`wrote ${out} (${r.requirements.trim().split("\n").length} pinned wheels)`);
} else if (cmd === "pin-runtime") {
  // Runs the escape tests on THIS runtime first; the pin is written only if they pass.
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const out = flag("--out") ?? join(stateDir, "runtime-pin.json");
  const docker = dockerPath(rest);
  const harnessDir = fileURLToPath(new URL("..", import.meta.url));
  const runSuite = () => {
    const r = spawnSync(process.execPath, ["--test", join(harnessDir, "test", "escape.test.mjs")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...(process.env.CC_PY_IMAGE ? { CC_PY_IMAGE: process.env.CC_PY_IMAGE } : {}) }, maxBuffer: 32 * 1024 * 1024, timeout: 900_000 });
    return parseTap(r.stdout ?? "");
  };
  const q = qualifyRuntime({ docker, runSuite, out, harness: { commit: resolveBase(harnessDir) } });
  if (!q.ok) { console.error(q.reason); process.exit(2); }
  console.log(`wrote ${out} (${q.pin.engine}, ${q.pin.kernel}); escape suite ${q.pin.escapeSuite.pass} passed, ${q.pin.escapeSuite.skipped} skipped`);
} else if (cmd === "verify-record") {
  const file = rest[0], ti = rest.indexOf("--tree");
  if (!file) { console.error("usage: verify-record <run-record.json> [--tree <dir>]  (with --tree: the files on disk must equal what was checked)"); process.exit(2); }
  const problems = verifyRecord(JSON.parse(readFileSync(file, "utf8")), { ...(ti === -1 ? {} : { treeDir: rest[ti + 1] }), key: loadOrCreateKey(stateDir, { create: false }) });
  if (problems.length > 0) { console.error(problems.join("\n")); process.exit(2); }
  console.log("record is consistent" + (ti === -1 ? "" : " and the tree matches it"));
} else if (cmd === "optin-check") {
  // For maintainers: is this file valid? Reads the file only; contacts nothing.
  if (!rest[0]) { console.error("usage: optin-check <.github/agent-contributions.json>"); process.exit(2); }
  const r = parseOptIn(readFileSync(rest[0]));
  if (!r.ok) { console.error(`refused:\n  ${r.errors.join("\n  ")}`); process.exit(2); }
  console.log(`valid (tasks need the "${r.value.task_label}" label applied by ${r.value.label_applied_by.join(", ")}; at most ${r.value.max_open_agent_prs} open PR(s), ${r.value.max_diff_lines} changed lines; ${r.value.paused ? "PAUSED" : "not paused"}; review by ${r.value.review_by})`);
} else if (cmd === "publish") {
  // Dry run unless --approve <token>. Reads GitHub through YOUR gh; confirmations come from /dev/tty.
  const flag = (n) => { const i = rest.indexOf(n); return i === -1 ? undefined : rest[i + 1]; };
  const need = (n) => { const v = flag(n); if (!v) { console.error(`usage: publish --record <run-record.json> --repo owner/name --issue N --clone <dir> --description-file <file> [--approve <token>] [--title T] [--gh /abs/gh]`); process.exit(2); } return v; };
  const recordFile = need("--record"), target = need("--repo"), issueNumber = Number(need("--issue")), clone = need("--clone"), descFile = need("--description-file");
  const harnessDir = fileURLToPath(new URL("..", import.meta.url));
  const ghPath = flag("--gh") ?? spawnSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).stdout.trim();
  try {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("--issue must be a number");
    const key = loadOrCreateKey(stateDir, { create: false });
    if (!key) throw new Error(`no install key at ${stateDir}: run-one on this machine creates it; a record from elsewhere cannot be published here`);
    const runner = ghRunner(ghPath);
    const gh = createGh(runner);
    const me = gh.get("/user");
    const gitCfg = (k) => spawnSync("/usr/bin/git", ["-C", clone, "config", "--get", k], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, encoding: "utf8" }).stdout.trim();
    const user = { login: me.login, id: me.id, name: gitCfg("user.name"), email: gitCfg("user.email") };
    if (!user.name || !user.email) throw new Error("set git user.name and user.email in the clone: they are published in the commit");
    const reviewedTrees = JSON.parse(readFileSync(join(harnessDir, "reviewed-harness-trees.json"), "utf8")).trees;
    const ledgerFile = join(stateDir, "published.jsonl");
    // Certifications are given ON THE TERMINAL, once per run, AFTER the review text is shown. They are never flags.
    const memo = {};
    const askCertifications = ({ spec, flagged }) => {
      const out = {};
      if (spec.certification.cla !== "none") { out.claSigned = ttyAsk(`\nThis project requires a ${spec.certification.cla} CLA.\n${CLA_WARNING}\nType "I have signed" to confirm: `) === "I have signed"; }
      if (spec.certification.dco === "signed-off-by") { out.certifyDco = ttyAsk(`\n${DCO_TEXT}\n\n${DCO_WARNING}\nType "I certify" to add Signed-off-by: ${user.name} <${user.email}>: `) === "I certify"; }
      if (flagged.length > 0) { out.allowFlaggedCode = ttyAsk(`\nThese added lines touch the environment, network or processes (listed above):\n  ${escapeForTerminal(flagged.slice(0, 30).join("\n  "))}\nType "I read them" to continue: `) === "I read them"; }
      return out;
    };
    const certify = () => memo.flags ?? {};
    const o = {
      gh, write: ghWriter(runner), record: JSON.parse(readFileSync(recordFile, "utf8")), key, reviewedTrees, target, issueNumber, user, repoDir: clone,
      ledger: readLedger(ledgerFile), flags: certify,
      descriptionText: readFileSync(descFile, "utf8"), titleOverride: flag("--title"), pendingDir: join(stateDir, "publish-pending"), ledgerFile,
      pushUrlFor: (fork) => `https://github.com/${fork}.git`, ask: ttyAsk, approve: flag("--approve"),
      display: (text) => { const fd = fsOpen("/dev/tty", "w"); try { fsWrite(fd, `\n${escapeForTerminal(text)}\n\n`); } finally { fsClose(fd); } },
    };
    const show = (r) => {
      for (const c of r.plan.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ": " + escapeForTerminal(c.detail)}`);
      for (const w of r.plan.warnings ?? []) console.log(`warn ${escapeForTerminal(w)}`);
    };
    const reviewed = certifyAfterReview({ ...o, flags: undefined }, { display: (t) => o.display(t), askCertifications });
    if (reviewed.refused) { show(reviewed.refused); console.error("\nrefused: nothing was changed."); process.exit(2); }
    memo.flags = reviewed.flags;
    if (!o.approve) {
      const r = dryRun(o);
      show(r);
      if (r.phase !== "dry-run") { console.error("\nrefused: nothing was changed."); process.exit(2); }
      console.log(`\nproject contact: ${escapeForTerminal(r.plan.info.contact)}   policy: ${escapeForTerminal(r.plan.info.policyUrl)}${r.plan.info.safetyCritical ? `\nSAFETY-CRITICAL: ${escapeForTerminal(r.plan.info.safetyReason ?? "")} (tests and documentation only)` : ""}\n--- diff (${r.plan.diff.total} changed lines) ---\n${escapeForTerminal(r.plan.diff.patch)}\n--- commit message ---\n${escapeForTerminal(r.texts.message)}\n--- PR title ---\n${escapeForTerminal(r.texts.title)}\n--- PR body ---\n${escapeForTerminal(r.texts.body)}\n--- author published in the commit: ${escapeForTerminal(user.name)} <${escapeForTerminal(user.email)}> ---`);
      console.log(`\nDRY RUN ONLY: nothing was changed on GitHub.\nTo publish, wait at least 10 minutes, re-read the above, then run the same command with:\n  --approve ${r.texts.token}\nYou will be asked one y/N question on the terminal.`);
    } else {
      const r = await publish(o);
      if (r.phase === "published") { console.log(r.log.join("\n")); console.log("published."); }
      else { show(r); console.error(r.error ? `\naborted: ${r.error}\n${(r.log ?? []).join("\n")}` : "\nrefused: nothing was changed."); process.exit(2); }
    }
  } catch (e) { console.error(`publish: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
} else if (cmd === "cleanup") {
  const r = cleanup({ docker: dockerPath(rest), images: rest.includes("--images") });
  console.log(JSON.stringify(r));
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
  // Mutation analysis is local, so it runs on a copy of the WORKING TREE (the test under analysis may not be committed yet).
  const copy = inContainer ? copySource(repo) : undefined;
  const root = copy ?? repo;
  const cwd = join(root, cwdRel);
  const testInCwd = test.startsWith(cwdRel + "/") ? test.slice(cwdRel.length + 1) : test;
  const runTest = () => {
    if (inContainer) {
      const profile = resolveProfile(flag("--profile") ?? "node");
      // A refusal must ABORT the run: if it came back as {ok:false} every mutant would be classified "caught".
      const v = runProfileChecks({ docker: dockerPath(rest), image: flag(CONTAINER_FLAG), pin: pinFor(rest), srcDir: copy, profile, testPath: test, only: profile.testCheck });
      if (!v.ran) throw new Error(`container run refused: ${v.refused}`);
      const c = v.checks[0];
      return { ok: c.ok, output: c.tail };
    }
    const r = runChecked({ cwd, command: "npx", args: ["--no-install", "vitest", "run", testInCwd] });
    return { ok: r.ok, output: r.stdout + r.stderr };
  };
  let out;
  try { out = runMutations({ root, sourcePath: source, mutations: JSON.parse(readFileSync(file, "utf8")), runTest }); } finally { if (copy) rmTree(copy, { recursive: true, force: true }); }
  console.warn(JSON.stringify(out, null, 2));
} else {
  console.error("usage: status | stop [reason] | clear-stop --yes | dry-run <issues.json> | run-one ... | build-deps ... | pin-requirements ... | pin-runtime ... | verify-record ... | optin-check ... | publish ... | cleanup ... | coverage ... | mutate ...");
  process.exit(2);
}
