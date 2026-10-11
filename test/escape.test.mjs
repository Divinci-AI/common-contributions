/**
 * Escape tests against a REAL container runtime, canaries only (never the real ~/.ssh, never a fork bomb).
 * Each probe prints RAN:<name> first, so a green result cannot mean "the probe never ran". For every escape there is a RED run
 * (a deliberately weakened container, built here with raw docker, never through the production runner) in which the canary IS
 * reached, and a GREEN run through runContained in which it is not. Skipped when docker or the test image is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCreateArgs, dockerEnv, runContained, LIMITS } from "../src/container.mjs";
import { tmp } from "./helpers.mjs";

const DOCKER = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find((p) => existsSync(p));
const imageId = () => (DOCKER ? spawnSync(DOCKER, ["image", "inspect", "alpine:3.20", "--format", "{{.Id}}"], { env: dockerEnv(), encoding: "utf8" }).stdout.trim().replace(/^sha256:/, "") : "");
const IMAGE = imageId();
const skip = !DOCKER || !IMAGE ? "docker or alpine:3.20 not available" : false;
const SRC = () => { const d = tmp(); writeFileSync(join(d, "f.txt"), "hi"); return d; };
const sh = (script) => ["sh", "-c", script];
let n = 0;
const rid = () => `esc${process.pid}x${++n}`;

/** RED helper: build the production args, apply a weakening, run with raw docker and no preflight. */
function runWeakened({ srcDir, script, weaken }) {
  const name = `cc-${rid()}`;
  const args = weaken(buildCreateArgs({ image: IMAGE, name, runId: name, srcDir, cmd: sh(script) }));
  const c = spawnSync(DOCKER, args, { env: dockerEnv(), encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(DOCKER, ["start", "-a", name], { env: dockerEnv(), encoding: "utf8", timeout: 60_000 });
  spawnSync(DOCKER, ["rm", "-f", name], { env: dockerEnv() });
  return { stdout: r.stdout ?? "", status: r.status };
}
const green = (srcDir, script, extra = {}) => runContained({ docker: DOCKER, image: IMAGE, srcDir, cmd: sh(script), runId: rid(), ...extra });
const swap = (args, from, to) => { const a = [...args]; const i = a.indexOf(from); a[i + 1] = to; return a; };

test("the toolchain-free smoke: runs as non-root and sees only the read-only source", { skip }, () => {
  const r = green(SRC(), "echo RAN:smoke; id -u; cat /work/src/f.txt");
  assert.ok(r.ran, r.refused); assert.match(r.stdout, /RAN:smoke\n65532\nhi/);
});

test("preflight refuses a weakened container on a REAL runtime, before it starts", { skip }, () => {
  const r = green(SRC(), "echo SHOULD-NOT-RUN", { createArgsOverride: (a) => swap(a, "--network", "bridge") });
  assert.equal(r.ran, false); assert.match(r.refused, /NetworkMode/);
});

test("network: a sibling container's listener is reached with a network (RED) and never under --network none (GREEN)", { skip }, () => {
  // RED cannot use a HOST listener on this machine: even a networked container timed out reaching one (measured 2026-10-10, OrbStack + WARP),
  // so a host-reachability canary would be green for the wrong reason. A listener in a sibling container on the same bridge is reachable.
  const sib = `cc-sib${process.pid}`;
  const d = (...a) => spawnSync(DOCKER, a, { env: dockerEnv(), encoding: "utf8" });
  d("rm", "-f", sib);
  try {
    assert.equal(d("run", "-d", "--name", sib, "alpine:3.20", "sh", "-c", "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\nCANARY-REPLY' | nc -l -p 8080; done").status, 0);
    const ip = d("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", sib).stdout.trim();
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    const probe = (host) => `echo RAN:net; wget -T4 -qO- http://${host}:8080/ 2>&1; echo RESULT:$?`;
    const red = runWeakened({ srcDir: SRC(), script: probe(ip), weaken: (a) => swap(a, "--network", "bridge") });
    assert.match(red.stdout, /RAN:net[\s\S]*CANARY-REPLY|RAN:net[\s\S]*RESULT:0/, `RED: the weakened container must reach the listener at ${ip}: ${red.stdout}`);
    for (const host of [ip, "host.docker.internal", "192.168.215.2", "172.17.0.1", "127.0.0.1", "1.1.1.1"]) {
      const g = green(SRC(), probe(host));
      assert.ok(g.ran, g.refused); assert.match(g.stdout, /RAN:net/);
      assert.doesNotMatch(g.stdout, /CANARY-REPLY|RESULT:0/, `${host} must not connect`);
    }
  } finally { d("rm", "-f", sib); }
});

test("source is read-only: writable with a rw mount (RED), refused through the runner (GREEN)", { skip }, () => {
  const probe = "echo RAN:write; touch /work/src/pwn && echo WROTE || echo REFUSED";
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => a.map((x) => x.replace(",readonly", "")) });
  assert.match(red.stdout, /RAN:write\nWROTE/);
  const g = green(SRC(), probe); assert.match(g.stdout, /RAN:write\nREFUSED/);
});

test("a canary key outside the source is unreadable (GREEN); a bind mount of it is readable (RED)", { skip }, () => {
  const home = tmp(); mkdirSync(join(home, ".ssh")); writeFileSync(join(home, ".ssh/id_canary"), "CANARY-KEY-123");
  const probe = `echo RAN:key; cat ${home}/.ssh/id_canary 2>&1; cat /Users/*/.ssh/* 2>&1 | head -1; ls /Users /Volumes 2>&1 | head -2`;
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => { const i = a.indexOf("--workdir"); return [...a.slice(0, i), "--mount", `type=bind,source=${home},target=${home},readonly`, ...a.slice(i)]; } });
  assert.match(red.stdout, /CANARY-KEY-123/, "RED: with the mount the canary is read");
  const g = green(SRC(), probe);
  assert.match(g.stdout, /RAN:key/); assert.doesNotMatch(g.stdout, /CANARY-KEY-123/); assert.match(g.stdout, /No such file/);
});

test("a host environment secret does not reach the container (GREEN); an --env pass-through does (RED)", { skip }, () => {
  const probe = "echo RAN:env; printenv | grep -c CANARY_SECRET";
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => { const i = a.indexOf("--workdir"); return [...a.slice(0, i), "--env", "CANARY_SECRET=s3cr3t", ...a.slice(i)]; } });
  assert.match(red.stdout, /RAN:env\n1/);
  const prev = process.env.CANARY_SECRET; process.env.CANARY_SECRET = "s3cr3t";
  try { const g = green(SRC(), probe); assert.match(g.stdout, /RAN:env\n0/); } finally { if (prev === undefined) delete process.env.CANARY_SECRET; else process.env.CANARY_SECRET = prev; }
});

test("the container runtime socket is not reachable (GREEN); mounting it exposes it (RED)", { skip }, () => {
  const sock = "/var/run/docker.sock";
  const probe = `echo RAN:sock; test -S ${sock} && echo SOCKET || echo NOSOCKET`;
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => { const i = a.indexOf("--workdir"); return [...a.slice(0, i), "-v", `${sock}:${sock}`, ...a.slice(i)]; } });
  assert.match(red.stdout, /RAN:sock\nSOCKET/);
  assert.match(green(SRC(), probe).stdout, /RAN:sock\nNOSOCKET/);
});

test("process limit: 400 background processes start with no limit (RED) and are capped at the pids limit (GREEN)", { skip }, () => {
  // The spawner runs in a subshell and the count is a shell glob over /proc: at the limit forks fail, and a failed fork kills only the subshell.
  const probe = "echo RAN:pids; ( i=0; while [ $i -lt 400 ]; do sleep 20 2>/dev/null & i=$((i+1)); done ) 2>/dev/null; set -- /proc/[0-9]*; echo COUNT:$#";
  const count = (s) => Number(/COUNT:(\d+)/.exec(s)?.[1] ?? NaN);
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => swap(a, "--pids-limit", "-1") });
  assert.ok(count(red.stdout) > LIMITS.pids + 50, `RED should exceed the limit, got ${count(red.stdout)}`);
  const g = green(SRC(), probe);
  assert.match(g.stdout, /RAN:pids/); assert.ok(count(g.stdout) <= LIMITS.pids, `GREEN count ${count(g.stdout)}`);
});

test("a process that ignores SIGTERM is killed at the deadline and the container is reaped", { skip }, () => {
  const id = rid();
  const g = runContained({ docker: DOCKER, image: IMAGE, srcDir: SRC(), cmd: sh("echo RAN:term; trap '' TERM; sleep 120"), runId: id, limits: { ...LIMITS, timeoutMs: 3000 } });
  assert.equal(g.timedOut, true);
  const ps = spawnSync(DOCKER, ["ps", "-a", "--filter", `name=cc-${id}`, "--format", "{{.Names}}"], { env: dockerEnv(), encoding: "utf8" }).stdout.trim();
  assert.equal(ps, "", "the container must be gone");
});

test("a stdout flood is cut off by the byte cap and the container is reaped", { skip }, () => {
  const id = rid();
  const g = runContained({ docker: DOCKER, image: IMAGE, srcDir: SRC(), cmd: sh("echo RAN:flood; yes AAAAAAAAAAAAAAAA | head -c 50000000"), runId: id, limits: { ...LIMITS, maxOutputBytes: 100_000, timeoutMs: 30_000 } });
  assert.ok(g.stdout.length <= 200_000, `kept ${g.stdout.length} bytes`);
  assert.equal(g.ok, false);
  assert.equal(spawnSync(DOCKER, ["ps", "-a", "--filter", `name=cc-${id}`, "--format", "{{.Names}}"], { env: dockerEnv(), encoding: "utf8" }).stdout.trim(), "");
});

test("memory: a 1.4 GB allocation survives a 3 GB limit (RED) and is killed by the 1 GB limit (GREEN)", { skip }, () => {
  const probe = "echo RAN:mem; x=$(head -c 1400000000 /dev/zero | tr '\\0' a); echo SURVIVED:${#x}";
  const red = runWeakened({ srcDir: SRC(), script: probe, weaken: (a) => swap(swap(a, "--memory", String(3 * 1024 ** 3)), "--memory-swap", String(3 * 1024 ** 3)) });
  assert.match(red.stdout, /SURVIVED:1400000000/);
  const g = green(SRC(), probe);
  assert.match(g.stdout, /RAN:mem/); assert.doesNotMatch(g.stdout, /SURVIVED/); assert.equal(g.ok, false);
});

import { readRuntime, runtimeMismatch } from "../src/container.mjs";

test("runtime pin on a REAL daemon: the recorded runtime passes, a doctored kernel string refuses", { skip }, () => {
  const actual = readRuntime(DOCKER);
  assert.match(actual.kernel, /orbstack/i, `unexpected runtime ${JSON.stringify(actual)}`);
  assert.deepEqual(runtimeMismatch(actual, actual), []);
  const ok = runContained({ docker: DOCKER, image: IMAGE, srcDir: SRC(), cmd: sh("echo RAN:pin"), runId: rid(), pin: actual });
  assert.equal(ok.ran, true, ok.refused); assert.deepEqual(ok.runtime, actual);
  const bad = runContained({ docker: DOCKER, image: IMAGE, srcDir: SRC(), cmd: sh("echo SHOULD-NOT-RUN"), runId: rid(), pin: { ...actual, kernel: actual.kernel + "-tampered" } });
  assert.equal(bad.ran, false); assert.match(bad.refused, /runtime differs/);
});

test("an image that declares VOLUME is refused: the anonymous volume is not on the mount allowlist", { skip }, () => {
  const dir = tmp(); writeFileSync(join(dir, "Dockerfile"), "FROM alpine:3.20\nVOLUME /data\n");
  const tag = `cc-vol-test:${process.pid}`;
  const b = spawnSync(DOCKER, ["build", "-q", "--no-cache", "-t", tag, dir], { env: dockerEnv(), encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const id = spawnSync(DOCKER, ["image", "inspect", tag, "--format", "{{.Id}}"], { env: dockerEnv(), encoding: "utf8" }).stdout.trim().replace(/^sha256:/, "");
  try {
    const r = runContained({ docker: DOCKER, image: id, srcDir: SRC(), cmd: sh("echo SHOULD-NOT-RUN"), runId: rid() });
    assert.equal(r.ran, false); assert.match(r.refused, /mounts are not exactly/);
  } finally { spawnSync(DOCKER, ["rmi", "-f", tag], { env: dockerEnv() });  }
});

test("many short-lived processes do not exhaust the pids limit (--init reaps them)", { skip }, () => {
  const probe = "echo RAN:zombies; i=0; while [ $i -lt 400 ]; do (sh -c 'exit 0' &) ; i=$((i+1)); done; sleep 1; set -- /proc/[0-9]*; echo COUNT:$#; echo DONE";
  const g = green(SRC(), probe);
  assert.match(g.stdout, /RAN:zombies/); assert.match(g.stdout, /DONE/);
  assert.ok(Number(/COUNT:(\d+)/.exec(g.stdout)?.[1]) < 30, g.stdout);
});
