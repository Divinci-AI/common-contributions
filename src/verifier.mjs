/** Run a profile's checks in the container against a prepared source dir. Never falls back to the host. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runContained, dockerEnv } from "./container.mjs";
import { depSha } from "./depimage.mjs";
import { expandChecks, testRelative } from "./profile.mjs";

export function imageLabel(docker, image, label) {
  const r = spawnSync(docker, ["image", "inspect", "--format", `{{index .Config.Labels "${label}"}}`, image], { env: dockerEnv(), encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The dependency image must have been built from THIS dependency file. Returns {matched, expected, actual}. */
export function matchDepImage({ docker, image, srcDir, profile }) {
  const f = join(srcDir, profile.subdir, profile.depFile);
  if (!existsSync(f)) return { matched: false, reason: `${join(profile.subdir, profile.depFile)} is not in the source` };
  const expected = depSha(readFileSync(f, "utf8"));
  const actual = imageLabel(docker, image, profile.depLabel);
  return { matched: actual === expected, expected, actual, reason: actual === expected ? undefined : `image label ${profile.depLabel} is ${actual ?? "missing"}, the source's dependency file hashes to ${expected}` };
}

export function runProfileChecks({ docker, image, pin, srcDir, profile, testPath, only }) {
  const testRel = testRelative(profile, testPath);
  const dep = matchDepImage({ docker, image, srcDir, profile });
  if (!dep.matched) return { ran: false, refused: `dependency image does not match the project: ${dep.reason}`, dep };
  const out = [];
  const runId = randomBytes(6).toString("hex");
  for (const c of expandChecks(profile, testRel).filter((x) => !only || x.name === only)) {
    const r = runContained({ docker, image, srcDir, subdir: profile.subdir, cmd: c.argv, runId: `${runId}-${c.name}`, pin });
    if (!r.ran) return { ran: false, refused: r.refused, dep, checks: out };
    out.push({ name: c.name, argv: c.argv, status: r.status, ok: r.ok, timedOut: r.timedOut, tail: (r.stdout + r.stderr).split("\n").slice(-20).join("\n") });
  }
  return { ran: true, dep, checks: out, runtime: pin };
}
