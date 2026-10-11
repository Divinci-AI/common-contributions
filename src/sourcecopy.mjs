/**
 * A per-run copy of the project source, so model-written files never land in the live checkout and the host's own
 * node_modules (host-built binaries, a different dependency tree than the lockfile's) never reaches the container.
 * Skips: node_modules, .git, env files, key-looking files, and every symlink (a link could point out of the tree).
 */
import { cpSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", ".next", "dist"]);
const SKIP_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.npmrc|\.netrc)$/i;

export const keepPath = (src) => {
  const name = basename(src);
  let st;
  try { st = lstatSync(src); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  if (st.isDirectory()) return !SKIP_DIRS.has(name);
  return st.isFile() && !SKIP_FILE.test(name);
};

/** Returns the absolute path of the copy (caller removes it). */
export function copySource(repo) {
  const dest = mkdtempSync(join(realpathSync(tmpdir()), "cc-src-"));
  cpSync(repo, dest, { recursive: true, filter: keepPath, dereference: false });
  return dest;
}

/** Would the copy leave this relative path out? `applyFiles` refuses such paths, so a file can never be written live but absent from what was checked. */
export function skippedByCopy(rel) {
  const parts = rel.split("/").filter(Boolean);
  return parts.some((seg, i) => (i < parts.length - 1 ? SKIP_DIRS.has(seg) : SKIP_DIRS.has(seg) || SKIP_FILE.test(seg)));
}

const GIT = "/usr/bin/git", TAR = "/usr/bin/tar";
const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { env: gitEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

/** The commit sha HEAD (or `ref`) names in `repo`, or null if `repo` is not a git repository. */
export function resolveBase(repo, ref = "HEAD") {
  const r = run(GIT, ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`]);
  return r.status === 0 && /^[a-f0-9]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/**
 * The source at a recorded commit, exactly as upstream has it: no local edits, no untracked files. Returns {dir, base}; the caller removes dir.
 * `git archive` then `tar` (no pipe, no shell). bsdtar refuses absolute and `..` entries.
 */
export function copyFromGit(repo, base) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cc-src-"));
  const tarball = join(dir, ".archive.tar");
  const a = run(GIT, ["-C", repo, "archive", "--format=tar", "-o", tarball, base]);
  if (a.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`git archive failed: ${(a.stderr || "").trim().slice(0, 200)}`); }
  const x = run(TAR, ["-xf", tarball, "-C", dir, "--no-same-owner"]);
  rmSync(tarball, { force: true });
  if (x.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`tar failed: ${(x.stderr || "").trim().slice(0, 200)}`); }
  return { dir, base };
}

/** Attributes that would make `git add` change the bytes we checked. Returns problems (empty = the bytes survive `git add`). */
export function attributeProblems(repo, files) {
  const bad = [];
  for (const [path, content] of Object.entries(files)) {
    const r = run(GIT, ["-C", repo, "check-attr", "filter", "ident", "working-tree-encoding", "eol", "text", "--", path]);
    if (r.status !== 0) { bad.push(`${path}: git check-attr failed`); continue; }
    for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
      const m = line.match(/^(.*): (filter|ident|working-tree-encoding|eol|text): (.*)$/);
      if (!m) continue;
      const [, , attr, value] = m;
      if (value === "unspecified") continue;
      if (["filter", "ident", "working-tree-encoding"].includes(attr)) bad.push(`${path}: git attribute ${attr}=${value} would change the bytes on add`);
      else if (/\r/.test(content)) bad.push(`${path}: contains CR and git attribute ${attr}=${value} normalises line endings`);
    }
  }
  return bad;
}
