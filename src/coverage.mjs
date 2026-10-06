/**
 * Pre-filing / pre-run coverage check. Written in Node on purpose: a shell grep failed here once (BSD vs GNU regex) and
 * silently reported "no tests", which is how an issue got filed for a module that already had tests.
 *
 * A test file "covers" a module if it IMPORTS it (any relative specifier ending in the module's basename). Exports are
 * then matched by name only inside those files, so a common word elsewhere cannot count as coverage.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "runs"]);
const TEST_FILE = /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs|tsx)$/;

export function listTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (TEST_FILE.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Exported VALUE names (functions, consts, classes, `export { a, b }`). Types and interfaces are not behaviour. */
export function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("type ")) names.add(name);
    }
  }
  return [...names];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True if the test text imports/requires a relative specifier ending in the module basename. */
export function importsModule(testText, moduleBase) {
  const spec = new RegExp(`["'\`](?:\\.{1,2}/)[^"'\`]*?\\b${escapeRe(moduleBase)}(?:\\.(?:js|ts|mts|cts|mjs|cjs))?["'\`]`);
  return spec.test(testText);
}

/**
 * @returns {{ module: string, exports: Array<{name:string, referencedIn:string[]}>, referencingTests: string[] }}
 * `modulePath` is relative to `root`. The module's own would-be test file (`allowed`) is excluded.
 */
export function coverageReport({ root, modulePath, allowed = [] }) {
  const source = readFileSync(join(root, modulePath), "utf8");
  const base = basename(modulePath).replace(/\.[^.]+$/, "");
  const names = exportedNames(source);
  const skip = new Set(allowed.map((p) => join(root, p)));
  const referencing = [];
  const texts = new Map();
  for (const file of listTestFiles(root)) {
    if (skip.has(file)) continue;
    const text = readFileSync(file, "utf8");
    if (importsModule(text, base)) {
      referencing.push(relative(root, file));
      texts.set(relative(root, file), text);
    }
  }
  const exports = names.map((name) => ({
    name,
    referencedIn: referencing.filter((f) => new RegExp(`\\b${escapeRe(name)}\\b`).test(texts.get(f))),
  }));
  return { module: modulePath, exports, referencingTests: referencing };
}

/**
 * The gate: every existing test that imports the module must be NAMED in the issue body (path or basename), proving
 * whoever wrote the issue looked. Returns the unacknowledged test paths; empty means the issue may run.
 */
export function unacknowledgedTests(report, issueBody) {
  const body = String(issueBody ?? "");
  return report.referencingTests.filter((f) => !body.includes(f) && !body.includes(basename(f)));
}
