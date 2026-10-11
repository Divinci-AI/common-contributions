/**
 * A per-run copy of the project source, so model-written files never land in the live checkout and the host's own
 * node_modules (host-built binaries, a different dependency tree than the lockfile's) never reaches the container.
 * Skips: node_modules, .git, env files, key-looking files, and every symlink (a link could point out of the tree).
 */
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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
 * The source at a recorded commit, exactly as the commit's tree has it: no local edits, no untracked files, and NOT passed through
 * `git archive` (which honours the repo's own export-ignore / export-subst) or `checkout-index` (which applies eol and filter conversions).
 * Reads the tree with ls-tree and the blobs with one `cat-file --batch`, byte for byte. Returns {dir, base}; the caller removes dir.
 * Symlinks are recreated as symlinks (they point inside a read-only container); submodules (gitlinks) are skipped.
 */
export function copyFromGit(repo, base, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const ls = run(GIT, ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", base]);
  if (ls.status !== 0) throw new Error(`git ls-tree failed: ${(ls.stderr || "").trim().slice(0, 200)}`);
  const entries = ls.stdout.split("\0").filter(Boolean).map((l) => { const m = l.match(/^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/); if (!m) throw new Error("unparseable ls-tree line"); return { mode: m[1], type: m[2], sha: m[3], path: m[4] }; });
  for (const e of entries) {
    const parts = e.path.split("/");
    if (e.path.startsWith("/") || parts.some((x) => x === ".." || x === "." || x === "" || x === ".git") || /\0/.test(e.path)) throw new Error(`refusing unsafe path in the tree: ${JSON.stringify(e.path)}`);
  }
  const blobs = entries.filter((e) => e.type === "blob");
  const cat = spawnSync(GIT, ["-C", repo, "cat-file", "--batch"], { env: gitEnv, input: blobs.map((e) => e.sha).join("\n") + "\n", maxBuffer: maxBytes });
  if (cat.status !== 0) throw new Error(`git cat-file failed: ${String(cat.stderr).slice(0, 200)}`);
  const out = cat.stdout; let off = 0;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cc-src-"));
  try {
    for (const e of blobs) {
      const nl = out.indexOf(10, off);
      const [sha, type, size] = out.slice(off, nl).toString("utf8").split(" ");
      if (sha !== e.sha || type !== "blob") throw new Error("cat-file out of step");
      const content = out.subarray(nl + 1, nl + 1 + Number(size));
      off = nl + 1 + Number(size) + 1;
      const abs = join(dir, e.path);
      mkdirSync(dirname(abs), { recursive: true });
      if (e.mode === "120000") symlinkSync(content.toString("utf8"), abs);
      else writeFileSync(abs, content, { mode: e.mode === "100755" ? 0o755 : 0o644 });
    }
  } catch (err) { rmSync(dir, { recursive: true, force: true }); throw err; }
  return { dir, base };
}

/** Paths the model touched that are a symlink, a submodule, or executable in the BASE tree: the recorded mode (100644) would change them. */
export function baseModeProblems(repo, base, paths) {
  const bad = [];
  for (const path of paths) {
    const r = run(GIT, ["-C", repo, "ls-tree", base, "--", path]);
    if (r.status !== 0) { bad.push(`${path}: git ls-tree failed`); continue; }
    const m = r.stdout.trim().match(/^(\d+) (\w+) /);
    if (m && m[1] !== "100644") bad.push(`${path}: is mode ${m[1]} in the base commit; only plain files (100644) can be replaced`);
  }
  return bad;
}

/** Attributes that would make `git add` change the bytes we checked. Returns problems (empty = the bytes survive `git add`). */
export function attributeProblems(repo, files, base) {
  const bad = [];
  for (const [path, content] of Object.entries(files)) {
    const r = run(GIT, ["-C", repo, "check-attr", `--source=${base}`, "filter", "ident", "working-tree-encoding", "eol", "text", "--", path]);
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
