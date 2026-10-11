import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.mjs";
import { depSha } from "../src/depimage.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
let server, port, requests, reply;

before(async () => {
  requests = [];
  reply = { message: { content: "```ts\nimport { it } from \"vitest\";\nit(\"x\", () => {});\n```" }, prompt_eval_count: 40, eval_count: 20 };
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

function fixture() {
  const repo = tmp();
  mkdirSync(join(repo, "orchestrator/src"), { recursive: true });
  writeFileSync(join(repo, "orchestrator/src/provenance.ts"), "export const SOURCES = [\"direct\"];\n");
  writeFileSync(join(repo, "orchestrator/src/other.test.ts"), "import { it } from \"vitest\";\nit(\"s\", () => {});\n");
  const issues = join(tmp(), "issues.json");
  const body = "## What\nx\n\n## Done when (one file: `orchestrator/src/provenance.test.ts`)\n- covers `orchestrator/src/provenance.ts`\n";
  writeFileSync(issues, JSON.stringify([
    { number: 23, title: "test: provenance", labels: [{ name: "agent-ready" }], body },
    { number: 99, title: "no label", labels: [], body },
  ]));
  return { repo, issues };
}

// ASYNC spawn: the mock server runs in THIS process, so a synchronous spawn would block the very event loop it needs.
const cli = (args, home, extraEnv = {}) =>
  new Promise((resolve) => {
    // HOME and XDG_STATE_HOME point at scratch too: if the override were ever ignored, the CLI would write under THIS scratch home, never the
    // real default directory (a mutation run once did exactly that, leaving a STOP file and ledger entries in a person's real state).
    const scratchHome = tmp();
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: scratchHome, XDG_STATE_HOME: join(scratchHome, "state"), COMMON_CONTRIBUTIONS_HOME: home, ...extraEnv } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
const report = (r) => JSON.parse(r.stderr.slice(r.stderr.indexOf("{")));

test("run-one: a local model's file is validated, written into the repo, and nothing is committed", async () => {
  const { repo, issues } = fixture();
  requests.length = 0;
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "mock-model", "--host", `http://127.0.0.1:${port}`, "--no-verify", "--apply"], tmp());
  assert.equal(r.status, 0, r.stderr);
  const rep = report(r);
  assert.equal(rep.outcome, "ok");
  assert.deepEqual(rep.wrote, ["orchestrator/src/provenance.test.ts"]);
  assert.match(readFileSync(join(repo, "orchestrator/src/provenance.test.ts"), "utf8"), /from "vitest"/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/chat");
  assert.equal(requests[0].body.model, "mock-model", "Ollama must get the bare model name, not the ledger key");
  assert.match(requests[0].body.messages[1].content, /export const SOURCES/, "the named source file is in the prompt");
  assert.ok(!existsSync(join(repo, ".git")), "the harness never touches git");
});

test("run-one refuses a non-loopback host and contacts nothing", async () => {
  const { repo, issues } = fixture();
  requests.length = 0;
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", "http://example.com:11434", "--no-verify"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not loopback/);
  assert.equal(requests.length, 0);
});

test("run-one refuses an issue without the agent-ready label", async () => {
  const { repo, issues } = fixture();
  const r = await cli(["run-one", issues, "99", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--no-verify"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not runnable/);
});

test("run-one: a reply with no code block writes nothing", async () => {
  const { repo, issues } = fixture();
  const saved = reply;
  reply = { message: { content: "I cannot do that." }, prompt_eval_count: 5, eval_count: 5 };
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--no-verify"], tmp());
  reply = saved;
  assert.equal(report(r).outcome, "no-file");
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")));
});

test("run-one: with STOP present the model is never called", async () => {
  const { repo, issues } = fixture();
  const home = tmp();
  assert.equal((await cli(["stop", "drill"], home)).status, 0);
  requests.length = 0;
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--no-verify"], home);
  assert.equal(report(r).outcome, "stopped");
  assert.equal(requests.length, 0);
});

test("run-one: a model reply containing a secret-shaped string trips STOP and writes nothing", async () => {
  const { repo, issues } = fixture();
  const home = tmp();
  const saved = reply;
  const fake = "gh" + "p_" + "a1B2c3D4e5".repeat(4);
  reply = { message: { content: "```ts\nconst t = \"" + fake + "\";\n```" }, prompt_eval_count: 5, eval_count: 5 };
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--no-verify"], home);
  reply = saved;
  assert.equal(report(r).outcome, "stopped");
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")));
  assert.equal(JSON.parse((await cli(["status"], home)).stderr).stopped, true);
});

// ── replay mode: an already-written reply (e.g. a Claude Code subagent's) goes through the same checks ──
const REPLY = "```ts\nimport { it } from \"vitest\";\nit(\"ok\", () => {});\n```";
const replyFile = (text) => { const f = join(tmp(), "reply.txt"); writeFileSync(f, text); return f; };
const replayArgs = (issues, repo, reply, extra = []) => ["run-one", issues, "23", "--repo", repo, "--model", "sonnet", "--reply-file", reply, ...extra, "--no-verify"];

test("replay: a clean reply is validated and written, with no network at all", async () => {
  const { repo, issues } = fixture();
  requests.length = 0;
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "0", "--tokens", "1200,300", "--apply"]), tmp());
  const rep = report(r);
  assert.equal(rep.outcome, "ok");
  assert.deepEqual(rep.wrote, ["orchestrator/src/provenance.test.ts"]);
  assert.equal(requests.length, 0);
});

test("replay: ANY reported tool use refuses the run and trips STOP; nothing is written", async () => {
  const { repo, issues } = fixture();
  const home = tmp();
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "2"]), home);
  assert.equal(report(r).outcome, "stopped");
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")));
  assert.equal(JSON.parse((await cli(["status"], home)).stderr).stopped, true);
});

test("replay: not saying how many tools were used is refused", async () => {
  const { repo, issues } = fixture();
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY)), tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--tool-uses/);
});

test("replay: a reply with a secret-shaped string trips STOP and writes nothing", async () => {
  const { repo, issues } = fixture();
  const fake = "gh" + "p_" + "a1B2c3D4e5".repeat(4);
  const r = await cli(replayArgs(issues, repo, replyFile("```ts\nconst t = \"" + fake + "\";\n```"), ["--tool-uses", "0"]), tmp());
  assert.equal(report(r).outcome, "stopped");
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")));
});

test("replay: a reply whose code block is missing writes nothing", async () => {
  const { repo, issues } = fixture();
  const r = await cli(replayArgs(issues, repo, replyFile("I could not."), ["--tool-uses", "0"]), tmp());
  assert.equal(report(r).outcome, "no-file");
});

test("--print-prompt shows exactly the prompt, names the one allowed file, and sends nothing", async () => {
  const { repo, issues } = fixture();
  requests.length = 0;
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--print-prompt"], tmp());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[system\]/);
  assert.match(r.stdout, /You may write ONLY this file: orchestrator\/src\/provenance\.test\.ts/);
  assert.match(r.stdout, /export const SOURCES/);
  assert.equal(requests.length, 0);
});

// ── coverage gate ──
function fixtureWithExistingTest(issueMentionsIt) {
  const { repo } = fixture();
  writeFileSync(join(repo, "orchestrator/src/source-yield.test.ts"), 'import { isSource } from "./provenance.js";\nit("covers isSource", () => { isSource("x"); });\n');
  const body = "## What\nx\n" + (issueMentionsIt ? "Existing tests: `source-yield.test.ts` cover isSource; they do not cover isInferred.\n" : "") +
    "\n## Done when (one file: `orchestrator/src/provenance.test.ts`)\n- covers `orchestrator/src/provenance.ts`\n";
  const issues = join(tmp(), "issues.json");
  writeFileSync(issues, JSON.stringify([{ number: 23, title: "t", labels: [{ name: "agent-ready" }], body }]));
  return { repo, issues };
}

test("coverage gate: run-one REFUSES when an existing test imports the module and the issue does not name it", async () => {
  const { repo, issues } = fixtureWithExistingTest(false);
  requests.length = 0;
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--no-verify"], tmp());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already cover a module this issue names/);
  assert.match(r.stderr, /source-yield\.test\.ts/);
  assert.equal(requests.length, 0, "the model must not be called");
});

test("coverage gate: the refusal also applies to --print-prompt and replay (no side door)", async () => {
  const { repo, issues } = fixtureWithExistingTest(false);
  const a = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--print-prompt"], tmp());
  assert.equal(a.status, 2);
  const b = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "0"]), tmp());
  assert.equal(b.status, 2);
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")));
});

test("coverage gate: once the issue names the existing test, the run proceeds and the prompt CARRIES that test", async () => {
  const { repo, issues } = fixtureWithExistingTest(true);
  const p = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--print-prompt"], tmp());
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /ALREADY cover this module/);
  assert.match(p.stdout, /covers isSource/);
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "0"]), tmp());
  assert.equal(report(r).outcome, "ok");
});

test("coverage command reports the importing tests and which exports they reference", async () => {
  const { repo } = fixtureWithExistingTest(true);
  const r = await cli(["coverage", "--repo", repo, "--module", "orchestrator/src/provenance.ts"], tmp());
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.referencingTests, ["orchestrator/src/source-yield.test.ts"]);
  assert.deepEqual(rep.exports.find((e) => e.name === "SOURCES").referencedIn, []);
});

// S3a: verification executes model-written code, so without a container it must not run on the host unless a person opts in.
function fakeNpx() {
  const bin = tmp(), marker = join(tmp(), "npx-ran");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}:${process.env.PATH}` }, marker };
}

test("run-one: with no container runner, verification is REFUSED and nothing is executed on the host", async () => {
  const { repo, issues } = fixture();
  const { env, marker } = fakeNpx();
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`], tmp(), env);
  const rep = report(r);
  assert.equal(rep.verify.ran, false);
  assert.match(rep.verify.refused, /without a container/);
  assert.equal(rep.tsc, undefined);
  assert.ok(!existsSync(marker), "npx must not have been spawned");
});

test("run-one: --allow-host-execution is the only way to verify on the host, and the report says so", async () => {
  const { repo, issues } = fixture();
  const { env, marker } = fakeNpx();
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--allow-host-execution"], tmp(), env);
  const rep = report(r);
  assert.equal(rep.verify.ran, true);
  assert.match(rep.verify.where, /host/);
  assert.ok(existsSync(marker), "the opt-in does run the checks");
  assert.ok(existsSync(join(repo, "orchestrator/src/provenance.test.ts")), "host verification checks the file it just wrote, even without --apply");
});

test("mutate: refuses to run model-written code on the host without the explicit flag", async () => {
  const { repo } = fixture();
  const { env, marker } = fakeNpx();
  const muts = join(tmp(), "m.json");
  writeFileSync(muts, "[]");
  const r = await cli(["mutate", "--repo", repo, "--source", "orchestrator/src/provenance.ts", "--test", "orchestrator/src/other.test.ts", "--mutations", muts, "--cwd", "orchestrator"], tmp(), env);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /without a container/);
  assert.ok(!existsSync(marker));
});

// Container verification: every refusal happens BEFORE anything runs, and nothing falls back to the host toolchain.
function containerSetup({ label, pin = true }) {
  const { repo, issues } = fixture();
  const lock = '{"lockfileVersion":3,"packages":{}}';
  writeFileSync(join(repo, "orchestrator/package-lock.json"), lock);
  const { env, marker } = fakeNpx();
  const dbin = tmp(), argvFile = join(tmp(), "argv"), docker = join(dbin, "docker");
  writeFileSync(docker, `#!/bin/sh\ncase "$1" in\n info) echo "e|k|o";;\n image) echo "${label ?? depSha(lock)}";;\n *) echo "$@" >> "${argvFile}"; exit 1;;\nesac\n`, { mode: 0o755 });
  const pinFile = join(tmp(), "runtime-pin.json");
  if (pin) writeFileSync(pinFile, JSON.stringify({ engine: "e", kernel: "k", os: "o" }));
  const args = ["run-one", issues, "23", "--repo", repo, "--model", "m", "--host", `http://127.0.0.1:${port}`, "--container-image", "sha256:" + "a".repeat(64), "--docker", docker, "--runtime-pin", pinFile];
  return { args, env, marker, argvFile, repo };
}

test("run-one in a container: a missing runtime pin refuses before docker is called", async () => {
  const c = containerSetup({ pin: false });
  const rep = report(await cli(c.args, tmp(), c.env));
  assert.equal(rep.verify.ran, false);
  assert.match(rep.verify.refused, /no runtime pin/);
  assert.ok(!existsSync(c.argvFile) && !existsSync(c.marker));
});

test("run-one in a container: a dependency image built from a different lock file is refused", async () => {
  const c = containerSetup({ label: "000000000000" });
  const rep = report(await cli(c.args, tmp(), c.env));
  assert.equal(rep.verify.ran, false);
  assert.match(rep.verify.refused, /does not match the project/);
  assert.ok(!existsSync(c.argvFile) && !existsSync(c.marker), "nothing was created or run");
});

test("run-one in a container: a failing docker refuses rather than falling back; the live checkout is never mounted", async () => {
  const c = containerSetup({});
  const rep = report(await cli(c.args, tmp(), c.env));
  assert.equal(rep.verify.ran, false);
  assert.match(rep.verify.refused, /docker create failed/);
  assert.ok(!existsSync(c.marker), "npx must not have been spawned");
  const argv = readFileSync(c.argvFile, "utf8");
  assert.match(argv, /--network none/);
  assert.ok(!argv.includes(c.repo), "only a per-run copy is mounted");
});

test("the live-write default is pinned OFF (Michael confirmed 2026-10-11: model output is not written to the working tree unless --apply)", () => {
  assert.match(readFileSync(CLI, "utf8"), /export const LIVE_WRITE_DEFAULT = false;/);
});

test("mutate in a container: a refusal ABORTS the run (it must never be counted as a caught mutant)", async () => {
  const c = containerSetup({ pin: false });
  const muts = join(tmp(), "m.json");
  writeFileSync(muts, JSON.stringify([{ id: "m1", old: "[\"direct\"]", new: "[]" }]));
  const dockerArg = c.args[c.args.indexOf("--docker") + 1], pinArg = c.args[c.args.indexOf("--runtime-pin") + 1];
  const r = await cli(["mutate", "--repo", c.repo, "--source", "orchestrator/src/provenance.ts", "--test", "orchestrator/src/other.test.ts", "--mutations", muts, "--container-image", "sha256:" + "a".repeat(64), "--docker", dockerArg, "--runtime-pin", pinArg], tmp(), c.env);
  assert.notEqual(r.status, 0);
  assert.ok(!/"caught"/.test(r.stdout + r.stderr), "no mutant may be reported caught when the container run was refused");
  assert.match(r.stderr, /no runtime pin|container run refused/);
});

test("mutate in a container: a dependency-image mismatch aborts with the refusal, never as a caught mutant", async () => {
  const c = containerSetup({ label: "000000000000" });
  const muts = join(tmp(), "m.json");
  writeFileSync(muts, JSON.stringify([{ id: "m1", old: "[\"direct\"]", new: "[]" }]));
  const a = (n) => c.args[c.args.indexOf(n) + 1];
  const r = await cli(["mutate", "--repo", c.repo, "--source", "orchestrator/src/provenance.ts", "--test", "orchestrator/src/other.test.ts", "--mutations", muts, "--container-image", "sha256:" + "a".repeat(64), "--docker", a("--docker"), "--runtime-pin", a("--runtime-pin")], tmp(), c.env);
  assert.notEqual(r.status, 0);
  assert.ok(!/"caught"/.test(r.stdout + r.stderr));
  assert.match(r.stderr, /container run refused: dependency image does not match/);
});

test("run-one: without --apply the working tree is not written; --out gets the files", async () => {
  const { repo, issues } = fixture();
  const out = join(tmp(), "out");
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "0", "--tokens", "1200,300", "--out", out]), tmp());
  const rep = report(r);
  assert.equal(rep.outcome, "ok");
  assert.equal(rep.wrote, undefined);
  assert.ok(!existsSync(join(repo, "orchestrator/src/provenance.test.ts")), "the working tree is untouched");
  assert.ok(existsSync(join(out, "orchestrator/src/provenance.test.ts")));
});

test("optin-check: a valid file is described, an invalid one is refused with reasons, and nothing is contacted", async () => {
  const dir = tmp(), f = join(dir, "a.json"), g = join(dir, "b.json");
  const soon = new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10);
  writeFileSync(f, JSON.stringify({ version: 1, opt_in: true, contact: "@m", policy_url: "https://example.org/p", review_by: soon, label_applied_by: ["m"], disclosure: { mechanism: "commit_trailer" }, certification: { dco: "none", cla: "none" } }));
  writeFileSync(g, '{"version":1,"opt_in":true,"opt_in":false}');
  const ok = await cli(["optin-check", f], tmp()); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /valid/);
  const no = await cli(["optin-check", g], tmp()); assert.equal(no.status, 2); assert.match(no.stderr, /duplicate key/);
});

test("publish: refuses without the pieces it needs, and never prompts or contacts GitHub on a bad invocation", async () => {
  const r = await cli(["publish", "--repo", "acme/widgets"], tmp());
  assert.equal(r.status, 2); assert.match(r.stderr, /usage: publish/);
  const dir = tmp(), rec = join(dir, "r.json"); writeFileSync(rec, "{}"); writeFileSync(join(dir, "d.md"), "x");
  const r2 = await cli(["publish", "--record", rec, "--repo", "acme/widgets", "--issue", "7", "--clone", dir, "--description-file", join(dir, "d.md")], tmp());
  assert.equal(r2.status, 2); assert.match(r2.stderr, /no install key/);
});

test("run-one --task-label: a project's own label selects the task; the default stays agent-ready", async () => {
  const { repo } = fixture();
  const body = "## What\nx\n\n## Done when (one file: `orchestrator/src/provenance.test.ts`)\n- covers `orchestrator/src/provenance.ts`\n";
  const issues = join(tmp(), "issues.json");
  writeFileSync(issues, JSON.stringify([{ number: 23, title: "t", labels: [{ name: "help wanted (ai ok)" }], body }]));
  const none = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--print-prompt"], tmp());
  assert.equal(none.status, 2);
  const yes = await cli(["run-one", issues, "23", "--repo", repo, "--model", "m", "--print-prompt", "--task-label", "help wanted (ai ok)"], tmp());
  assert.equal(yes.status, 0, yes.stderr);
});

test("legal certifications and the flagged-code acknowledgement are never command-line flags", () => {
  const src = readFileSync(CLI, "utf8");
  for (const f of ["--cla-signed", "--certify-dco", "--allow-flagged-code"]) assert.ok(!src.includes(f), `${f} must not be an argv flag`);
  assert.match(src, /ttyAsk\(`[^`]*I certify/);
});
