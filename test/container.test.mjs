import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildCreateArgs, checkInspect, dockerEnv, runContained, LIMITS, USER } from "../src/container.mjs";
import { tmp } from "./helpers.mjs";

const IMAGE = "sha256:" + "a".repeat(64);
const SRC = "/private/tmp/cc-src";
const good = () => ({
  Image: IMAGE,
  HostConfig: {
    NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"],
    PidMode: "", IpcMode: "none", UTSMode: "", Devices: [], Sysctls: null, ExtraHosts: null, Dns: [],
    PidsLimit: LIMITS.pids, Memory: LIMITS.memoryBytes, MemorySwap: LIMITS.memoryBytes, ShmSize: LIMITS.shmBytes,
    Tmpfs: { "/tmp": "rw,nosuid,size=64m", "/work/out": "rw,nosuid,size=64m" },
  },
  Config: { User: USER, Env: ["CI=1", "HOME=/tmp", "PATH=/usr/bin"] },
  Mounts: [{ Source: SRC, Destination: "/work/src", RW: false }],
});
const ctx = { image: IMAGE, srcDir: SRC };

test("the expected inspect output passes", () => assert.deepEqual(checkInspect(good(), ctx), []));

// One mutation per setting: weaken it and the preflight must name it.
const weaken = {
  "network": (i) => (i.HostConfig.NetworkMode = "bridge"),
  "writable root": (i) => (i.HostConfig.ReadonlyRootfs = false),
  "privileged": (i) => (i.HostConfig.Privileged = true),
  "caps not dropped": (i) => (i.HostConfig.CapDrop = []),
  "cap added": (i) => (i.HostConfig.CapAdd = ["SYS_ADMIN"]),
  "no-new-privileges missing": (i) => (i.HostConfig.SecurityOpt = []),
  "seccomp unconfined": (i) => (i.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]),
  "host pid": (i) => (i.HostConfig.PidMode = "host"),
  "host ipc": (i) => (i.HostConfig.IpcMode = "host"),
  "host uts": (i) => (i.HostConfig.UTSMode = "host"),
  "device": (i) => (i.HostConfig.Devices = [{ PathOnHost: "/dev/fuse" }]),
  "sysctl": (i) => (i.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }),
  "extra host": (i) => (i.HostConfig.ExtraHosts = ["x:1.2.3.4"]),
  "dns": (i) => (i.HostConfig.Dns = ["8.8.8.8"]),
  "no pids limit": (i) => (i.HostConfig.PidsLimit = 0),
  "swap allowed": (i) => (i.HostConfig.MemorySwap = LIMITS.memoryBytes * 2),
  "big shm": (i) => (i.HostConfig.ShmSize = 6 * 1024 ** 3),
  "root user": (i) => (i.Config.User = ""),
  "other image": (i) => (i.Image = "sha256:" + "b".repeat(64)),
  "extra tmpfs": (i) => (i.HostConfig.Tmpfs["/mnt"] = "rw"),
  "extra mount": (i) => i.Mounts.push({ Source: "/Users/x", Destination: "/h", RW: true }),
  "writable source": (i) => (i.Mounts[0].RW = true),
  "docker socket": (i) => (i.Mounts[0].Source = "/var/run/docker.sock"),
  "extra env": (i) => i.Config.Env.push("AWS_SECRET_ACCESS_KEY=x"),
};
for (const [name, mutate] of Object.entries(weaken)) {
  test(`preflight refuses: ${name}`, () => {
    const i = good(); mutate(i);
    assert.ok(checkInspect(i, ctx).length > 0, `${name} was not detected`);
  });
}
test("preflight refuses missing or garbage inspect output", () => {
  assert.ok(checkInspect(undefined, ctx).length > 0);
  assert.ok(checkInspect({}, ctx).length > 0);
});

test("create args: tags, relative paths and mount-injecting paths are refused", () => {
  const base = { name: "n", runId: "r", cmd: ["true"] };
  assert.throws(() => buildCreateArgs({ ...base, image: "node:22", srcDir: SRC }), /not a tag/);
  assert.throws(() => buildCreateArgs({ ...base, image: IMAGE, srcDir: "rel" }), /absolute/);
  assert.throws(() => buildCreateArgs({ ...base, image: IMAGE, srcDir: "/a,source=/Users" }), /':' or ','/);
  const a = buildCreateArgs({ ...base, image: IMAGE, srcDir: SRC });
  for (const f of ["--network", "none", "--read-only", "--cap-drop", "ALL", "--pull", "never", "--ipc"]) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /docker\.sock|privileged/.test(x)));
});

test("docker's own environment carries nothing from the caller (no DOCKER_HOST redirect)", () => {
  assert.deepEqual(Object.keys(dockerEnv()), ["PATH"]);
});

// A fake docker: records calls, prints configurable inspect JSON, can hang on `start`.
function fakeDocker({ inspect, startScript = "echo hello; exit 0", createStatus = 0 }) {
  const dir = tmp(), log = join(dir, "calls"), insp = join(dir, "inspect.json"), bin = join(dir, "docker");
  writeFileSync(insp, JSON.stringify([inspect]));
  writeFileSync(bin, `#!/bin/sh
echo "$1" >> "${log}"
case "$1" in
  create) exit ${createStatus};;
  inspect) cat "${insp}";;
  start) ${startScript};;
  kill|rm) exit 0;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("a forged-good inspect lets the run start; the container is always reaped", () => {
  const f = fakeDocker({ inspect: good() });
  const r = runContained({ docker: f.bin, image: IMAGE, srcDir: SRC, cmd: ["true"], runId: "t1" });
  assert.equal(r.ran, true); assert.equal(r.ok, true); assert.match(r.stdout, /hello/);
  assert.deepEqual(f.calls(), ["create", "inspect", "start", "kill", "rm"]);
});

test("a weakened container is refused BEFORE start, and still reaped", () => {
  const bad = good(); bad.HostConfig.NetworkMode = "bridge";
  const f = fakeDocker({ inspect: bad });
  const r = runContained({ docker: f.bin, image: IMAGE, srcDir: SRC, cmd: ["true"], runId: "t2" });
  assert.equal(r.ran, false); assert.match(r.refused, /NetworkMode/);
  assert.ok(!f.calls().includes("start"), "start must never be called");
  assert.deepEqual(f.calls().slice(-2), ["kill", "rm"]);
});

test("a hung container is killed by the host at the deadline and reaped", () => {
  const f = fakeDocker({ inspect: good(), startScript: "sleep 30" });
  const t0 = Date.now();
  const r = runContained({ docker: f.bin, image: IMAGE, srcDir: SRC, cmd: ["true"], runId: "t3", limits: { ...LIMITS, timeoutMs: 400 } });
  assert.equal(r.timedOut, true); assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(f.calls().slice(-2), ["kill", "rm"]);
});

test("docker create failing, or a relative docker path, runs nothing", () => {
  const f = fakeDocker({ inspect: good(), createStatus: 1 });
  assert.equal(runContained({ docker: f.bin, image: IMAGE, srcDir: SRC, cmd: ["true"], runId: "t4" }).ran, false);
  assert.throws(() => runContained({ docker: "docker", image: IMAGE, srcDir: SRC, cmd: ["true"], runId: "t5" }), /absolute/);
});
