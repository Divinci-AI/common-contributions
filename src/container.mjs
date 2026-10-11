/**
 * Running model-written code in a container (design: S3b). Three rules:
 *  1. The container that is INSPECTED is the container that RUNS: `docker create`, `docker inspect <id>`, `docker start -a <id>`.
 *  2. Any surprise in the inspect output refuses the run (fail closed). There is no host fallback.
 *  3. The host, not the container, enforces the wall-clock limit: `docker kill`, then `docker rm -f`, by name.
 */
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export const LIMITS = Object.freeze({ memoryBytes: 1024 ** 3, pids: 128, cpuNano: 1_000_000_000, nofile: 256, fsizeBytes: 50_000_000, shmBytes: 16 * 1024 ** 2, timeoutMs: 120_000, maxOutputBytes: 1_000_000 });
export const USER = "65532:65532";

/** Env passed to docker itself: nothing from the caller, so DOCKER_HOST / DOCKER_CONTEXT cannot redirect us to another daemon. */
export const dockerEnv = (extra = {}) => ({ PATH: "/usr/bin:/bin", ...extra });

/** argv for `docker create`. Pure. `image` must be an image ID or digest (never a tag): runs never pull. */
const PLAIN_REL = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const badPythonPath = (p) => p !== "" && (typeof p !== "string" || !PLAIN_REL.test(p) || p.split("/").includes("..") || p.startsWith("-"));

export function buildCreateArgs({ image, name, runId, srcDir, cmd, limits = LIMITS, subdir = "", pythonPath = "" }) {
  if (badPythonPath(pythonPath)) throw new Error("pythonPath must be a plain relative path");
  if (subdir && (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(subdir) || subdir.split("/").includes(".."))) throw new Error("subdir must be a plain relative path");
  if (!/^(sha256:)?[a-f0-9]{12,64}$|@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("image must be an image id or digest, not a tag");
  if (!isAbsolute(srcDir)) throw new Error("srcDir must be absolute");
  if (/[:,]/.test(srcDir)) throw new Error("srcDir may not contain ':' or ','");
  return [
    "create", "--name", name, "--label", `cc.run=${runId}`, "--pull", "never",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", USER,
    "--pids-limit", String(limits.pids), "--memory", String(limits.memoryBytes), "--memory-swap", String(limits.memoryBytes),
    "--cpus", String(limits.cpuNano / 1e9), "--ulimit", `nofile=${limits.nofile}`, "--ulimit", `fsize=${limits.fsizeBytes}`,
    "--ipc", "none", "--shm-size", String(limits.shmBytes), "--init", "--log-driver", "none",
    "--tmpfs", "/tmp:rw,nosuid,size=64m", "--tmpfs", "/work/out:rw,nosuid,size=64m",
    "--mount", `type=bind,source=${srcDir},target=/work/src,readonly`,
    "--workdir", subdir ? `/work/src/${subdir}` : "/work/src", "--env", "CI=1", "--env", "HOME=/tmp",
    ...(pythonPath ? ["--env", `PYTHONPATH=/work/src/${pythonPath}`] : []),
    image, ...cmd,
  ];
}

/** Compare the inspect output of the CREATED container with what we asked for. Returns the list of problems (empty = fine). */
export function checkInspect(i, { image, srcDir, limits = LIMITS, pythonPath = "" }) {
  const p = [];
  const h = i?.HostConfig ?? {}, c = i?.Config ?? {};
  const want = (cond, msg) => { if (!cond) p.push(msg); };
  want(i && typeof i === "object", "no inspect output");
  want(h.NetworkMode === "none", `NetworkMode is ${h.NetworkMode}, want none`);
  want(h.ReadonlyRootfs === true, "root filesystem is not read-only");
  want(h.Privileged === false, "container is privileged");
  want(Array.isArray(h.CapDrop) && h.CapDrop.map((x) => x.toUpperCase()).includes("ALL"), "capabilities are not dropped");
  want(!h.CapAdd?.length, `capabilities added: ${h.CapAdd}`);
  want((h.SecurityOpt ?? []).some((s) => s === "no-new-privileges" || s === "no-new-privileges:true"), "no-new-privileges is not set");
  want(!(h.SecurityOpt ?? []).some((s) => /unconfined/.test(s)), "a security profile is unconfined");
  want(!h.PidMode, `PidMode is ${h.PidMode}`);
  want(h.IpcMode === "none", `IpcMode is ${h.IpcMode}, want none`);
  want(!h.UTSMode, `UTSMode is ${h.UTSMode}`);
  want(!h.Devices?.length, "devices are attached");
  want(!h.Sysctls || Object.keys(h.Sysctls).length === 0, "sysctls are set");
  want(!h.ExtraHosts?.length, "extra hosts are set");
  want(!h.Dns?.length, "dns is set");
  want(h.PidsLimit === limits.pids, `PidsLimit is ${h.PidsLimit}`);
  want(h.Memory === limits.memoryBytes && h.MemorySwap === limits.memoryBytes, "memory/swap limits are wrong");
  want(h.ShmSize === limits.shmBytes, `ShmSize is ${h.ShmSize}`);
  want(h.Init === true, "no init process (zombies would eat the pids limit)");
  want(h.LogConfig?.Type === "none", `log driver is ${h.LogConfig?.Type}, want none (a flood would fill the VM disk)`);
  want(c.User === USER, `User is "${c.User}", want ${USER}`);
  want(i?.Image === image || i?.Image?.replace(/^sha256:/, "").startsWith(image.replace(/^sha256:/, "").slice(0, 12)), "image is not the expected one");
  const tmpfs = Object.keys(h.Tmpfs ?? {}).sort().join(",");
  want(tmpfs === "/tmp,/work/out", `tmpfs mounts are ${tmpfs}`);
  const mounts = i?.Mounts ?? [];
  want(mounts.length === 1 && mounts[0].Source === srcDir && mounts[0].Destination === "/work/src" && mounts[0].RW === false, "mounts are not exactly the read-only source");
  want(c.WorkingDir === "/work/src" || /^\/work\/src\/[A-Za-z0-9._\/-]+$/.test(c.WorkingDir ?? "") && !c.WorkingDir.split("/").includes(".."), `working dir is ${c.WorkingDir}`);
  want(!mounts.some((m) => /docker\.sock/.test(m.Source ?? "")), "the docker socket is mounted");
  const env = (c.Env ?? []).filter((e) => !/^(PATH|HOSTNAME|NODE_VERSION|YARN_VERSION|PYTHON_VERSION|PYTHON_SHA256|GPG_KEY)=/.test(e) && e !== "LANG=C.UTF-8").sort();
  const wantEnv = ["CI=1", "HOME=/tmp", ...(pythonPath ? [`PYTHONPATH=/work/src/${pythonPath}`] : [])].sort();
  want(JSON.stringify(env) === JSON.stringify(wantEnv), `environment is ${JSON.stringify(env)}`);
  return p;
}

const sh = (docker, args, opts = {}) => spawnSync(docker, args, { env: dockerEnv(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...opts });

/** What the daemon actually is. The pin is the FULL kernel string (it carries the OrbStack build suffix) and the engine version. */
export function readRuntime(docker) {
  const r = sh(docker, ["info", "--format", "{{.ServerVersion}}|{{.KernelVersion}}|{{.OperatingSystem}}"]);
  const [engine, kernel, os] = (r.stdout || "").trim().split("|");
  return { engine, kernel, os };
}
export const runtimeMismatch = (actual, pin) => (pin && ["engine", "kernel", "os"].filter((k) => actual?.[k] !== pin[k]).map((k) => `${k}: ${actual?.[k]} != pinned ${pin[k]}`)) || [];

/**
 * Create, inspect, check, start, reap. Never throws for a failing command; returns {refused} when preflight fails.
 * `docker` must be an absolute path (a shim earlier on PATH cannot stand in for it).
 */
export function runContained({ docker, image, srcDir, cmd, runId, limits = LIMITS, createArgsOverride, pin, subdir = "", pythonPath = "" }) {
  if (!isAbsolute(docker)) throw new Error("docker must be an absolute path");
  if (pin) {
    const actual = readRuntime(docker);
    const bad = runtimeMismatch(actual, pin);
    if (bad.length > 0) return { ran: false, refused: `runtime differs from the tested one (${bad.join("; ")}); the boundary was only tested on the pinned runtime`, runtime: actual };
  }
  const name = `cc-${runId}`;
  const args = buildCreateArgs({ image, name, runId, srcDir, cmd, limits, subdir, pythonPath });
  const created = sh(docker, createArgsOverride ? createArgsOverride(args) : args);
  if (created.status !== 0) return { ran: false, refused: `docker create failed: ${(created.stderr || "").trim().slice(0, 300)}` };
  const reap = () => { sh(docker, ["kill", name]); sh(docker, ["rm", "-fv", name]); };
  try {
    const ins = sh(docker, ["inspect", name]);
    let parsed;
    try { parsed = JSON.parse(ins.stdout)[0]; } catch { parsed = undefined; }
    const problems = checkInspect(parsed, { image, srcDir, limits, pythonPath });
    if (problems.length > 0) return { ran: false, refused: `preflight failed: ${problems.join("; ")}` };
    const r = sh(docker, ["start", "-a", name], { timeout: limits.timeoutMs, maxBuffer: limits.maxOutputBytes });
    const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    return { ran: true, runtime: pin ? readRuntime(docker) : undefined, ok: r.status === 0 && !timedOut, status: r.status, timedOut, outputTruncated: r.error?.code === "ENOBUFS", stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    reap();
  }
}
