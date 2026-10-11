/**
 * The run record: what was checked, where, and the exact bytes. It is SELF-REPORTED (it is made by the tool, on the user's machine) and says so.
 * It exists so the publisher can refuse anything that is not what was checked, and so a maintainer can re-run the same recipe.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/** The id git gives a file's content (what `git hash-object` prints). */
export const gitBlobId = (content) => { const b = Buffer.from(content); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function fileEntries(files) {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, sha256: sha256(content), blob: gitBlobId(content), mode: "100644" }]));
}

export function buildRecord({ harness, project, base, source, container, runtime, pin, image, dep, limits, files, checks, ledger, profile }) {
  const body = {
    schema: 1, selfReported: true, createdAt: new Date().toISOString(),
    harness, project, base, source, container, runtime, pin, image, dep, limits, profile,
    files: fileEntries(files), checks, ledger,
  };
  return { ...body, recordSha: sha256(canonical(body)) };
}

/** Internal consistency (and, with `treeDir`, equality with the files on disk). Returns problems; empty = consistent. */
export function verifyRecord(rec, { treeDir } = {}) {
  const p = [];
  if (!rec || rec.schema !== 1 || typeof rec.files !== "object") return ["not a run record"];
  const { recordSha, ...body } = rec;
  if (sha256(canonical(body)) !== recordSha) p.push("record was edited after it was written (recordSha differs)");
  for (const [path, f] of Object.entries(rec.files)) {
    if (sha256(f.content) !== f.sha256) p.push(`${path}: content does not match its sha256`);
    if (gitBlobId(f.content) !== f.blob) p.push(`${path}: content does not match its git blob id`);
    if (treeDir) {
      const abs = join(treeDir, path);
      if (!existsSync(abs)) p.push(`${path}: missing from ${treeDir}`);
      else if (readFileSync(abs, "utf8") !== f.content) p.push(`${path}: differs from what was checked`);
    }
  }
  return p;
}

/** Is this record fit to be published from? (The publisher applies this; it is here so the rule has one home and a test.) */
export function publishProblems(rec) {
  const p = verifyRecord(rec);
  if (rec?.container !== true) p.push("the checks did not run in a container");
  if (rec?.source !== "git-archive" || !/^[a-f0-9]{40}$/.test(rec?.base ?? "")) p.push("the source was not a recorded git commit");
  if (!rec?.pin?.escapeSuite || rec.pin.escapeSuite.fail !== 0) p.push("no passing escape suite is recorded for the runtime");
  if (!rec?.dep?.matched) p.push("the dependency image was not matched to the project's lock file");
  if (!Array.isArray(rec?.checks) || rec.checks.length === 0 || rec.checks.some((c) => c.status !== 0 || c.timedOut)) p.push("a check did not exit 0");
  return p;
}
