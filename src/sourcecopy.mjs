/**
 * A per-run copy of the project source, so model-written files never land in the live checkout and the host's own
 * node_modules (host-built binaries, a different dependency tree than the lockfile's) never reaches the container.
 * Skips: node_modules, .git, env files, key-looking files, and every symlink (a link could point out of the tree).
 */
import { cpSync, lstatSync, mkdtempSync, realpathSync } from "node:fs";
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
