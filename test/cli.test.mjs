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
