import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.mjs";

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
const cli = (args, home) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, COMMON_CONTRIBUTIONS_HOME: home } });
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
  const r = await cli(["run-one", issues, "23", "--repo", repo, "--model", "mock-model", "--host", `http://127.0.0.1:${port}`, "--no-verify"], tmp());
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
  const r = await cli(replayArgs(issues, repo, replyFile(REPLY), ["--tool-uses", "0", "--tokens", "1200,300"]), tmp());
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
  assert.match(r.stderr, /already import a module this issue names/);
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
