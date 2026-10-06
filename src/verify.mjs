/**
 * Applying and checking an agent's output. The harness — not the model — writes files and runs the project's own
 * checks, in a scrubbed environment, inside one working directory it was told about.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { buildSandboxEnv } from "./secrets.mjs";
import { diffScopeViolations } from "./scope.mjs";

/** Write the files, refusing anything outside the allowed set or resolving outside `root`. Returns written paths. */
export function applyFiles({ root, files, allowed }) {
  const bad = diffScopeViolations(Object.keys(files), allowed);
  if (bad.length > 0) throw new Error(`refusing to write files outside scope: ${bad.join(", ")}`);
  const absRoot = resolve(root);
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) throw new Error(`refusing to write outside the working directory: ${rel}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    written.push(rel);
  }
  return written;
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
