/**
 * The run record: what was checked, where, and the exact bytes. It is SELF-REPORTED (it is made by the tool, on the user's machine) and says so.
 * It exists so the publisher can refuse anything that is not what was checked, and so a maintainer can re-run the same recipe.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/** The id git gives a file's content (what `git hash-object` prints). */
export const gitBlobId = (content) => { const b = Buffer.from(content); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function fileEntries(files) {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, sha256: sha256(content), blob: gitBlobId(content), mode: "100644" }]));
}

/** The install's record key: random, 0600, created once. It stops hand-edited records; it does not stop a modified harness (which can read it). */
export function loadOrCreateKey(stateDir, { create = true } = {}) {
  const f = join(stateDir, "record.key");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  if (!create) return null;
  mkdirSync(dirname(f), { recursive: true });
  const k = randomBytes(32).toString("hex");
  writeFileSync(f, k + "\n", { mode: 0o600 });
  return k;
}
const mac = (key, recordSha) => createHmac("sha256", key).update(recordSha).digest("hex");

/** Who is running: the harness commit (null without .git), whether src/ has uncommitted changes, and a hash of src/ itself. */
export function harnessIdentity(harnessDir) {
  const git = (...a) => spawnSync("/usr/bin/git", ["-C", harnessDir, ...a], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  const st = git("status", "--porcelain", "--", "src");
  const files = [];
  const walk = (d, rel = "") => { for (const e of readdirSync(join(d, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(d, r); else if (e.isFile()) files.push(r); } };
  walk(join(harnessDir, "src"));
  const srcTreeHash = sha256(files.map((r) => `${r}\0${sha256(readFileSync(join(harnessDir, "src", r)))}`).join("\n"));
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: st.status === 0 ? st.stdout.trim() !== "" : null, srcTreeHash };
}

export const issueHash = (title, body) => sha256(`${title}\n${body}`);

export function buildRecord({ harness, project, origin, issue, model, base, source, container, runtime, pin, image, dep, limits, files, checks, ledger, profile, key }) {
  const body = {
    schema: 2, selfReported: true, createdAt: new Date().toISOString(),
    harness, project, origin, issue, model, base, source, container, runtime, pin, image, dep, limits, profile,
    files: fileEntries(files), checks, ledger,
  };
  const recordSha = sha256(canonical(body));
  return { ...body, recordSha, ...(key ? { mac: mac(key, recordSha) } : {}) };
}

/** Internal consistency (and, with `treeDir`, equality with the files on disk). Returns problems; empty = consistent. */
export function verifyRecord(rec, { treeDir, key } = {}) {
  const p = [];
  if (!rec || rec.schema !== 2 || typeof rec.files !== "object" || rec.files === null || typeof rec.recordSha !== "string") return ["not a run record"];
  const { recordSha, mac: m, ...body } = rec;
  if (sha256(canonical(body)) !== recordSha) p.push("record was edited after it was written (recordSha differs)");
  if (key) {
    const want = Buffer.from(mac(key, recordSha)), got = Buffer.from(String(m ?? ""));
    if (!m || want.length !== got.length || !timingSafeEqual(want, got)) p.push("record MAC is missing or wrong: it was not written by this install");
  }
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

/**
 * Is this record fit to be published from? The publisher applies this; it lives here so the rule has one home and a test.
 * `key` is required (a record that cannot be MAC-checked is not publishable); `reviewedTrees` is the list of src/ tree hashes shipped as reviewed
 * (a consistency check against dev builds and edited copies, NOT security: a modified harness can skip it).
 */
export function publishProblems(rec, { key, reviewedTrees = [], now = Date.now(), maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (!key) return ["no install key: cannot check that this install wrote the record"];
  const p = verifyRecord(rec, { key });
  if (rec?.container !== true) p.push("the checks did not run in a container");
  if (rec?.source !== "git-archive" || !/^[a-f0-9]{40}$/.test(rec?.base ?? "")) p.push("the source was not a recorded git commit");
  if (!rec?.pin?.escapeSuite || rec.pin.escapeSuite.fail !== 0) p.push("no passing escape suite is recorded for the runtime");
  if (!rec?.dep?.matched) p.push("the dependency image was not matched to the project's lock file");
  if (!Array.isArray(rec?.checks) || rec.checks.length === 0 || rec.checks.some((c) => c.status !== 0 || c.timedOut)) p.push("a check did not exit 0");
  if (rec?.harness?.dirty !== false) p.push("the harness had uncommitted changes in src/ (or its state could not be read) when the record was made");
  if (!rec?.harness?.srcTreeHash || !reviewedTrees.includes(rec.harness.srcTreeHash)) p.push("the harness src/ is not one of the reviewed versions");
  if (!rec?.issue?.sha256 || !Number.isInteger(rec?.issue?.number)) p.push("the record does not bind the issue text");
  if (typeof rec?.origin !== "string" || !rec.origin) p.push("the record does not name the repository's origin");
  const age = now - Date.parse(rec?.createdAt);
  if (!(age >= 0 && age < maxAgeMs)) p.push("the record is older than 24 hours (or from the future); re-run");
  return p;
}
