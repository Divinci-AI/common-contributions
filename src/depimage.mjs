/**
 * Stage A of the container verifier: the dependency image. This is the ONE step that has network access, so it is narrow:
 *  - only package.json + package-lock.json go into the build context (never the project's source or its scripts);
 *  - the lockfile must pin every package to the public npm registry with an integrity hash (no git, file, link, tarball or http deps);
 *  - `npm ci --ignore-scripts`: no dependency's install script runs, here or later;
 *  - the base image is named by digest.
 * Hostile dependency CODE is Stage B's problem (no network, read-only, capped). Residual trust: the npm registry, the base image, BuildKit's cache.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerEnv } from "./container.mjs";

export const DEPS_DIR = "/work/node_modules";
export const REGISTRY = "https://registry.npmjs.org/";

/** Problems with a package-lock.json (lockfileVersion 2/3) that make it unsafe to install without network review. Empty = fine. */
export function checkLockfile(lock) {
  const p = [];
  if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object") return ["not a lockfileVersion 2/3 package-lock.json"];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (pkg.link) { p.push(`${path}: link dependency`); continue; }
    if (pkg.bundled || pkg.inBundle) continue; // shipped inside another package's tarball, which is itself checked
    if (typeof pkg.resolved !== "string" || !pkg.resolved.startsWith(REGISTRY)) { p.push(`${path}: not from ${REGISTRY} (${String(pkg.resolved).slice(0, 60)})`); continue; }
    if (typeof pkg.integrity !== "string" || !/^sha(256|384|512)-/.test(pkg.integrity)) p.push(`${path}: no integrity hash`);
  }
  return p;
}

const sh = (docker, args, opts = {}) => spawnSync(docker, args, { env: dockerEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...opts });

export const dockerfile = (baseDigest) => `FROM ${baseDigest}
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier && rm -rf /root/.npm
`;

/**
 * Build the dependency image for one project. Returns {ok, image(id), lockSha} or {ok:false, refused}.
 * `baseDigest` is like node@sha256:<64 hex>. Uses --no-cache so a poisoned layer cache cannot stand in for the lockfile.
 */
export function buildDepImage({ docker, projectDir, baseDigest, noCache = true }) {
  if (!/^[a-z0-9._\/-]+@sha256:[a-f0-9]{64}$/.test(baseDigest)) return { ok: false, refused: "base image must be named by digest" };
  let lockText, lock;
  try { lockText = readFileSync(join(projectDir, "package-lock.json"), "utf8"); lock = JSON.parse(lockText); } catch (e) { return { ok: false, refused: `cannot read package-lock.json: ${e.message}` }; }
  const bad = checkLockfile(lock);
  if (bad.length > 0) return { ok: false, refused: `lockfile refused: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}` };
  const ctx = mkdtempSync(join(tmpdir(), "cc-deps-"));
  try {
    writeFileSync(join(ctx, "package.json"), readFileSync(join(projectDir, "package.json")));
    writeFileSync(join(ctx, "package-lock.json"), lockText);
    writeFileSync(join(ctx, "Dockerfile"), dockerfile(baseDigest));
    const lockSha = createHash("sha256").update(lockText).digest("hex").slice(0, 12);
    const r = sh(docker, ["build", ...(noCache ? ["--no-cache"] : []), "-q", "--label", `cc.lock=${lockSha}`, ctx]);
    if (r.status !== 0) return { ok: false, refused: `docker build failed: ${(r.stderr || "").trim().slice(-400)}` };
    return { ok: true, image: r.stdout.trim(), lockSha };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}
