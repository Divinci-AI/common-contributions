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

/** The short hash stamped on a dependency image (label) and recomputed from the project at run time. */
export const depSha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

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
    const lockSha = depSha(lockText);
    const r = sh(docker, ["build", ...(noCache ? ["--no-cache"] : []), "-q", "--label", `cc.lock=${lockSha}`, "-t", `cc-deps:node-${lockSha}`, ctx]);
    if (r.status !== 0) return { ok: false, refused: `docker build failed: ${(r.stderr || "").trim().slice(-400)}` };
    return { ok: true, image: r.stdout.trim(), lockSha };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

// ---- Python: same idea, pip instead of npm -------------------------------------------------------------------------------------------

const REQ = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._-]+\])?==([A-Za-z0-9._+!-]+)(\s*;[^#]*?)?((?:\s+--hash=sha256:[a-f0-9]{64})+)\s*$/;

/** Problems with a hashed requirements.txt. Every line must be name==version with sha256 hashes; no URLs, VCS, paths, includes or alternate indexes. */
export function checkRequirements(text) {
  if (typeof text !== "string") return ["requirements are not text"];
  const p = [];
  const joined = text.replace(/\\\r?\n/g, " ");
  let n = 0;
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    n++;
    if (/^-/.test(line)) { p.push(`option line refused: ${line.slice(0, 40)}`); continue; }
    if (/:\/\/|@|git\+|file:|\.\.|\/|\\/.test(line.replace(/--hash=sha256:[a-f0-9]{64}/g, ""))) { p.push(`not a plain registry pin: ${line.slice(0, 50)}`); continue; }
    if (!REQ.test(line)) p.push(`needs name==version and --hash=sha256:...: ${line.slice(0, 50)}`);
  }
  if (n === 0) p.push("no requirements");
  return p;
}

export const pyDockerfile = (baseDigest) => `FROM ${baseDigest}
WORKDIR /work
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes --only-binary :all: --no-deps --disable-pip-version-check -r requirements.txt && rm -f requirements.txt
`;

/** Python twin of buildDepImage. Installs into the image's own site-packages; wheels only (a source build would run setup.py). */
export function buildPyDepImage({ docker, projectDir, baseDigest, noCache = true }) {
  if (!/^[a-z0-9._\/-]+@sha256:[a-f0-9]{64}$/.test(baseDigest)) return { ok: false, refused: "base image must be named by digest" };
  let text;
  try { text = readFileSync(join(projectDir, "requirements.txt"), "utf8"); } catch (e) { return { ok: false, refused: `cannot read requirements.txt: ${e.message}` }; }
  const bad = checkRequirements(text);
  if (bad.length > 0) return { ok: false, refused: `requirements refused: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}` };
  const ctx = mkdtempSync(join(tmpdir(), "cc-pydeps-"));
  try {
    writeFileSync(join(ctx, "requirements.txt"), text);
    writeFileSync(join(ctx, "Dockerfile"), pyDockerfile(baseDigest));
    const sha = depSha(text);
    const r = sh(docker, ["build", ...(noCache ? ["--no-cache"] : []), "-q", "--label", `cc.requirements=${sha}`, "-t", `cc-deps:py-${sha}`, ctx]);
    if (r.status !== 0) return { ok: false, refused: `docker build failed: ${(r.stderr || "").trim().slice(-400)}` };
    return { ok: true, image: r.stdout.trim(), lockSha: sha };
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}
