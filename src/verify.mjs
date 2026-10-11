/**
 * Applying and checking an agent's output. The harness — not the model — writes files and runs the project's own
 * checks, in a scrubbed environment, inside one working directory it was told about.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { buildSandboxEnv } from "./secrets.mjs";
import { diffScopeViolations, isConfigFile } from "./scope.mjs";

/** Write the files, refusing anything outside the allowed set or resolving outside `root`. Returns written paths. */
export function applyFiles({ root, files, allowed }) {
  const bad = diffScopeViolations(Object.keys(files), allowed);
  if (bad.length > 0) throw new Error(`refusing to write files outside scope: ${bad.join(", ")}`);
  const configTouched = Object.keys(files).filter(isConfigFile);
  if (configTouched.length > 0) throw new Error(`refusing to write dependency or config files: ${configTouched.join(", ")}`);
  const absRoot = resolve(root);
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) throw new Error(`refusing to write outside the working directory: ${rel}`);
    refuseSymlinkOnPath(absRoot, abs);
    mkdirSync(dirname(abs), { recursive: true });
    // O_NOFOLLOW: a link swapped in after the check above still cannot be written through.
    writeNoFollow(abs, content);
    written.push(rel);
  }
  return written;
}

/** Create/overwrite a file, failing (ELOOP) if the final component is a symbolic link. */
export function writeNoFollow(abs, content) {
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

/** Refuse if any existing component between root and the target (target included) is a symbolic link. */
function refuseSymlinkOnPath(absRoot, abs) {
  let cur = absRoot;
  for (const part of abs.slice(absRoot.length).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (st.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${cur.slice(absRoot.length + 1)}`);
  }
}

/** Run one command with the sandbox environment (allowlisted vars, scratch HOME). Never throws on a non-zero exit. */
export function runChecked({ cwd, command, args, timeoutMs = 180_000, env = process.env }) {
  const home = mkdtempSync(join(tmpdir(), "cc-home-"));
  const r = spawnSync(command, args, {
    cwd,
    env: buildSandboxEnv(env, { home }),
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { ok: r.status === 0, status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
