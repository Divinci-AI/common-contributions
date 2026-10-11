/**
 * End to end through the real CLI, real docker, a real dependency image and a real project: `run-one` with a replayed reply.
 * Needs (all gated, the test skips without them; see docs):
 *   CC_NODE_IMAGE  image id from `build-deps` for the project   CC_E2E_REPO  a git clone of the project (orchestrator/ layout)
 *   CC_PIN         a runtime-pin.json written by `pin-runtime`  CC_E2E_DOCKER  absolute docker path (optional)
 * GREEN: hostile probes run in the container and every attack fails with the errno that names the container's guard.
 * RED: the same probes with --allow-host-execution on a throwaway copy, CANARIES ONLY (fake key, loopback listener, 200 short sleeps, a file in the copy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "./helpers.mjs";
import { publishProblems, loadOrCreateKey } from "../src/record.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const { CC_NODE_IMAGE: IMAGE, CC_E2E_REPO: REPO, CC_PIN: PIN } = process.env;
const DOCKER = process.env.CC_E2E_DOCKER ?? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/OrbStack.app/Contents/MacOS/xbin/docker"].find((p) => existsSync(p));
const skip = !IMAGE || !REPO || !PIN || !DOCKER ? "CC_NODE_IMAGE, CC_E2E_REPO, CC_PIN or docker missing" : false;

const run = (args, home) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, XDG_STATE_HOME: join(home, "s"), COMMON_CONTRIBUTIONS_HOME: join(home, "state") } });
  let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d)); c.on("close", (code) => resolve({ status: code, out, err }));
});
const report = (r) => JSON.parse(r.err.slice(r.err.indexOf("{")));

function task(testFile, extraBody = "") {
  const issues = join(tmp(), "issues.json");
  const body = `## What\nx\nExisting tests: \`review-board.test.ts\` cover the board helpers; they do not cover this probe.\n${extraBody}\n## Done when (one file: \`orchestrator/src/${testFile}\`)\n- covers \`orchestrator/src/review-board.ts\`\n`;
  writeFileSync(issues, JSON.stringify([{ number: 7, title: "probe", labels: [{ name: "agent-ready" }], body }]));
  return issues;
}
const reply = (code) => { const f = join(tmp(), "reply.md"); writeFileSync(f, "```ts\n" + code + "\n```\n"); return f; };

const BENIGN = `import { it, expect } from "vitest";\nit("adds", () => { expect(1 + 1).toBe(2); });\n`;

const hostile = ({ canaryKey, port }) => `import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
// Each probe PASSES only if the attack FAILED. On the host the attack succeeds, so the probe fails: that is the red run.
describe("hostile probes", () => {
  it("cannot read a planted key", () => { expect(() => fs.readFileSync(${JSON.stringify(canaryKey)}, "utf8")).toThrow(); });
  it("cannot see the host's home or volumes", () => { expect(fs.existsSync("/Users") || fs.existsSync("/Volumes")).toBe(false); });
  it("cannot see the docker socket", () => { expect(fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock")).toBe(false); });
  it("cannot write next to the source", () => { let c: unknown; try { fs.writeFileSync("../planted.txt", "x"); } catch (e) { c = code(e); } expect(c).toBe("EROFS"); });
  it("has no route to the internet (ENETUNREACH)", async () => {
    const c = await new Promise((res) => { const s = net.connect({ host: "1.1.1.1", port: 443 }); s.setTimeout(3000, () => { s.destroy(); res("timeout"); }); s.on("connect", () => { s.destroy(); res("connected"); }); s.on("error", (e) => res(code(e))); });
    expect(c).toBe("ENETUNREACH");
  });
  it("cannot reach a canary listener on the host loopback", async () => {
    const c = await new Promise((res) => { const s = net.connect({ host: "127.0.0.1", port: ${port} }); s.setTimeout(3000, () => { s.destroy(); res("timeout"); }); s.on("connect", () => { s.destroy(); res("connected"); }); s.on("error", (e) => res(code(e))); });
    expect(c).not.toBe("connected");
  });
  it("cannot spawn past the pids limit (200 short sleeps)", async () => {
    const results = await Promise.all(Array.from({ length: 200 }, () => new Promise((res) => { const p = spawn("sleep", ["2"]); p.on("error", () => res("failed")); p.on("spawn", () => res("ok")); })));
    expect(results.includes("failed")).toBe(true);
  });
});
`;

async function withCanaries(fn) {
  const dir = join("/tmp", `cc-canary-${process.pid}`); mkdirSync(dir, { recursive: true });
  const canaryKey = join(dir, "id_fake"); writeFileSync(canaryKey, "FAKE-KEY-CANARY\n");
  let hits = 0; const srv = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn({ canaryKey, port: srv.address().port, hits: () => hits }); } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("run-one in a container: a benign reply is checked in the container, recorded, and the live checkout is untouched", { skip }, async () => {
  const out = join(tmp(), "out"); const home = tmp();
  const r = await run(["run-one", task("cc-smoke.test.ts"), "7", "--repo", REPO, "--model", "m", "--reply-file", reply(BENIGN), "--tool-uses", "0", "--container-image", IMAGE, "--docker", DOCKER, "--runtime-pin", PIN, "--no-apply", "--out", out], home);
  const rep = report(r);
  assert.equal(rep.verify.ran, true, JSON.stringify(rep.verify));
  assert.equal(rep.tsc.ok, true, rep.tsc?.tail); assert.equal(rep.vitest.ok, true, rep.vitest?.tail);
  assert.ok(!existsSync(join(REPO, "orchestrator/src/cc-smoke.test.ts")), "--no-apply: the live checkout is not written");
  const rec = JSON.parse(readFileSync(rep.record, "utf8"));
  const problems = publishProblems(rec, { key: loadOrCreateKey(join(home, "state"), { create: false }), reviewedTrees: [rec.harness.srcTreeHash] });
  // While the harness itself has uncommitted edits the record correctly says so; everything else must be clean.
  assert.deepEqual(problems.filter((x) => !/uncommitted changes/.test(x)), [], "a green containerised run from a recorded commit is publishable");
  assert.equal(problems.length === 0, rec.harness.dirty === false);
  assert.equal(spawnSync(process.execPath, [CLI, "verify-record", rep.record, "--tree", out], { encoding: "utf8" }).status, 0);
});

test("hostile probes: GREEN in the container (every attack fails), RED on the host (canaries only)", { skip }, async () => {
  await withCanaries(async (c) => {
    const code = hostile(c);
    const home = tmp(), out = join(tmp(), "out");
    const green = report(await run(["run-one", task("cc-hostile.test.ts"), "7", "--repo", REPO, "--model", "m", "--reply-file", reply(code), "--tool-uses", "0", "--container-image", IMAGE, "--docker", DOCKER, "--runtime-pin", PIN, "--no-apply", "--out", out], home));
    assert.equal(green.verify.ran, true, JSON.stringify(green.verify));
    assert.equal(green.vitest.ok, true, green.vitest?.tail);
    assert.match(green.vitest.tail, /7 passed/);
    assert.equal(c.hits(), 0, "the host canary listener was never reached from the container");
    assert.ok(!existsSync(join(REPO, "planted.txt")) && !existsSync(join(REPO, "orchestrator/planted.txt")));

    // RED: the same probes on the host, in a throwaway copy of the project, canaries only.
    const copy = join(tmp(), "repo"); cpSync(REPO, copy, { recursive: true });
    const red = report(await run(["run-one", task("cc-hostile.test.ts"), "7", "--repo", copy, "--model", "m", "--reply-file", reply(code), "--tool-uses", "0", "--allow-host-execution"], tmp()));
    assert.equal(red.verify.ran, true);
    assert.equal(red.vitest.ok, false, "the probes must FAIL on the host, or they prove nothing");
    assert.ok(c.hits() > 0, "RED: the loopback canary was reached from the host run");
    assert.ok(existsSync(join(copy, "planted.txt")), "RED: the write next to the source succeeded on the host");
  });
});
