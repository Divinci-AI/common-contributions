/**
 * Mutation runner. The mutations are written by SOMEONE OTHER than the author of the test (a second model, a human, a
 * tool) — a test author's own mutations only prove the cases it already thought of.
 *
 * A mutation is { id, old, new, kind? }: `old` must occur EXACTLY ONCE in the source (anything else is skipped, not
 * guessed at). The original bytes are restored in a finally block, always.
 *
 * Outcomes: caught (the test failed for a behavioural reason) · survived (the test still passed — a gap) ·
 * broke-build (the mutant did not even parse/compile: NOT counted as caught, it proves nothing about the test) ·
 * skipped (pattern not found exactly once).
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILD_BREAK = /SyntaxError|IndentationError|TabError|ImportError|errors? during collection|ERROR collecting|Transform failed|Unexpected token|Expected [^\n]*but found|error TS\d+|Cannot find module/i;

export function classify({ ok, output }) {
  if (ok) return "survived";
  return BUILD_BREAK.test(output ?? "") ? "broke-build" : "caught";
}

export function validateMutations(list) {
  if (!Array.isArray(list)) throw new Error("mutations must be an array");
  const seen = new Set();
  for (const m of list) {
    if (typeof m?.id !== "string" || typeof m?.old !== "string" || typeof m?.new !== "string") throw new Error(`bad mutation: ${JSON.stringify(m)?.slice(0, 80)}`);
    if (m.old === m.new) throw new Error(`mutation ${m.id}: old and new are identical`);
    if (seen.has(m.id)) throw new Error(`duplicate mutation id ${m.id}`);
    seen.add(m.id);
  }
  return list;
}

/**
 * Swap a file's contents by writing a NEW file and renaming it over the old one (never an in-place write). A container that
 * bind-mounts the directory can otherwise read the old size/contents of a file rewritten in place: a longer mutant arrives
 * truncated and is misreported as a build break.
 */
function replaceFile(abs, bytes) {
  // The temp name is random, so a link planted at a predictable `<file>.cc-swap` can never redirect this write.
  const tmp = `${abs}.cc-swap-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, bytes, { mode: statSync(abs).mode & 0o7777 });
  renameSync(tmp, abs);
}

/** @param {{ root: string, sourcePath: string, mutations: Array<{id:string,old:string,new:string,kind?:string}>, runTest: () => {ok:boolean, output:string} }} o */
export function runMutations({ root, sourcePath, mutations, runTest }) {
  validateMutations(mutations);
  const abs = join(root, sourcePath);
  if (lstatSync(abs).isSymbolicLink()) throw new Error(`${sourcePath} is a symlink; refusing to replace it with a regular file`);
  const original = readFileSync(abs); // bytes, not text: restoration must be byte-identical
  const text = original.toString("utf8");

  const base = runTest();
  if (!base.ok) throw new Error("the test does not pass on the UNMUTATED source; refusing to run mutations");

  const results = [];
  try {
    for (const m of mutations) {
      const count = text.split(m.old).length - 1;
      if (count !== 1) {
        results.push({ id: m.id, kind: m.kind, outcome: "skipped", reason: `pattern occurs ${count} times (need exactly 1)` });
        continue;
      }
      // Every mutant is built from the ORIGINAL text, and the outer finally restores the bytes, so a runner that
      // throws mid-mutation still leaves the source intact.
      replaceFile(abs, text.replace(m.old, () => m.new));
      results.push({ id: m.id, kind: m.kind, outcome: classify(runTest()) });
    }
  } finally {
    replaceFile(abs, original);
  }
  const tally = (o) => results.filter((r) => r.outcome === o).length;
  return { results, caught: tally("caught"), survived: tally("survived"), brokeBuild: tally("broke-build"), skipped: tally("skipped"), restored: Buffer.compare(readFileSync(abs), original) === 0 };
}
