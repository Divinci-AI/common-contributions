/**
 * Pre-filing / pre-run coverage check. Written in Node on purpose: a shell grep failed here once (BSD vs GNU regex) and
 * silently reported "no tests", which is how an issue got filed for a module that already had tests.
 *
 * A test file "covers" a module in one of two ways, and exports are matched by name only inside those files, so a common word
 * elsewhere cannot count as coverage:
 *  - DIRECT: it imports the module (a relative specifier ending in the module's basename, or, resolved, the module's own file).
 *  - INDIRECT: it reaches the module only THROUGH other files (a fixtures file, an index, a package __init__) by relative or
 *    in-repo imports, AND it uses an export of the module in call or member form. Found on a real project: a spec covering 98%
 *    of a module imported only a fixtures file, so a direct-only gate reported "no tests" for a module that already had them.
 *    Reaching is bounded (importGraphReach) so an index that imports everything cannot drag in a whole repository's tests
 *    without evidence of use.
 * JavaScript/TypeScript and Python are understood; anything else gets the direct check only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "runs", "__pycache__", ".venv", "venv", ".tox", "site-packages", ".mypy_cache", ".pytest_cache"]);
const TEST_FILE = /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs|tsx)$|^(test_.*|.*_test)\.py$/;

/** Bounds on following imports. Exported so a test can pin them. */
export const importGraphReach = { MAX_DEPTH: 8, MAX_FILES: 3000, MAX_BYTES: 2_000_000 };

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

/** Top-level Python names: def, async def, class and CONSTANT assignments, without a leading underscore. */
export function exportedNamesPython(source) {
  const names = new Set();
  for (const m of source.matchAll(/^(?:async\s+def|def|class)\s+([A-Za-z][\w]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^([A-Za-z][\w]*)\s*(?::[^=\n]+)?=(?!=)/gm)) names.add(m[1]);
  return [...names];
}

// ---- import graph ---------------------------------------------------------------------------------------------------------

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const insideSkipped = (p, root) => relative(root, p).split(sep).some((seg) => SKIP_DIRS.has(seg));
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Relative specifier -> an existing file under root, or undefined. `./x.js` may mean `./x.ts`; a directory means its index. */
function resolveJs(fromFile, spec, root) {
  const base = resolve(dirname(fromFile), spec);
  const swap = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] }[extname(base)] ?? [];
  const stem = extname(base) && swap.length ? base.slice(0, -extname(base).length) : undefined;
  const candidates = [...(stem ? swap.map((e) => stem + e) : []), base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => join(base, "index" + e))];
  for (const c of candidates) if (isFile(c) && !insideSkipped(c, root)) return c;
  return undefined;
}

function jsImports(text) {
  const out = new Set();
  for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s*["']([^"']+)["']/g])
    for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out].filter((x) => x.startsWith("."));
}

/** A dotted Python module under one directory: a.b -> a/b.py or a/b/__init__.py. */
function pyModuleFile(dir, dotted, root) {
  const rel = dotted.split(".").filter(Boolean).join("/");
  for (const c of [join(dir, rel + ".py"), join(dir, rel, "__init__.py")]) if (isFile(c) && !insideSkipped(c, root)) return c;
  return undefined;
}

function pyEdges(file, text, root) {
  const out = new Set();
  const roots = [root, join(root, "src")];
  const add = (f) => { if (f && f !== file) out.add(f); };
  const resolveAbs = (dotted) => { for (const r of roots) { const f = pyModuleFile(r, dotted, root); if (f) return f; } return undefined; };
  const resolveFrom = (dots, dotted) => {
    if (!dots) return resolveAbs(dotted);
    let dir = dirname(file);
    for (let i = 1; i < dots.length; i++) dir = dirname(dir);
    return dotted ? pyModuleFile(dir, dotted, root) : (isFile(join(dir, "__init__.py")) ? join(dir, "__init__.py") : undefined);
  };
  const baseDirOf = (dots) => { let dir = dirname(file); for (let i = 1; i < dots.length; i++) dir = dirname(dir); return dir; };
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const [, dots, dotted, rawNames] = m;
    add(resolveFrom(dots, dotted));
    const names = rawNames.replace(/[()]/g, " ").replace(/#[^\n]*/g, " ").split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^\w+$/.test(n));
    for (const n of names) {
      // `from pkg import submodule` imports the submodule file
      const sub = dots ? pyModuleFile(dotted ? join(baseDirOf(dots), ...dotted.split(".")) : baseDirOf(dots), n, root) : resolveAbs(dotted ? `${dotted}.${n}` : n);
      add(sub);
    }
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of m[1].split(",")) {
      const dotted = part.trim().split(/\s+as\s+/)[0].trim();
      if (!/^[\w.]+$/.test(dotted)) continue;
      const segs = dotted.split(".");
      for (let k = 1; k <= segs.length; k++) add(resolveAbs(segs.slice(0, k).join(".")));
    }
  }
  return [...out];
}

function stripComments(text, lang) {
  return lang === "py" ? text.replace(/#[^\n]*/g, "") : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Call or member form of any of `names` in `text`, so a common word in prose or a comment does not count. */
function usedNames(text, names, lang) {
  const t = stripComments(text, lang);
  return names.filter((n) => new RegExp(`(?:\\.\\s*${escapeRe(n)}\\b|(?<![\\w$.])${escapeRe(n)}\\s*\\()`).test(t));
}

/**
 * @returns {{ module: string, exports: Array<{name:string, referencedIn:string[]}>, referencingTests: string[], indirectTests: Array<{test:string, names:string[], via:string[]}> }}
 * `modulePath` is relative to `root`. The module's own would-be test file (`allowed`) is excluded.
 */
export function coverageReport({ root, modulePath, allowed = [] }) {
  const source = readFileSync(join(root, modulePath), "utf8");
  const lang = modulePath.endsWith(".py") ? "py" : "js";
  const base = basename(modulePath).replace(/\.[^.]+$/, "");
  const names = lang === "py" ? exportedNamesPython(source) : exportedNames(source);
  const target = resolve(root, modulePath);
  const skip = new Set(allowed.map((p) => join(root, p)));

  const textOf = new Map();
  const read = (f) => {
    if (!textOf.has(f)) { try { textOf.set(f, statSync(f).size <= importGraphReach.MAX_BYTES ? readFileSync(f, "utf8") : ""); } catch { textOf.set(f, ""); } }
    return textOf.get(f);
  };
  const edgeMemo = new Map();
  const edges = (f) => {
    if (!edgeMemo.has(f)) {
      const t = read(f);
      edgeMemo.set(f, f.endsWith(".py") ? pyEdges(f, t, root) : jsImports(t).map((sp) => resolveJs(f, sp, root)).filter(Boolean));
    }
    return edgeMemo.get(f);
  };
  /** Breadth-first from a test file. Returns the chain of files to the target, or undefined. */
  const chainTo = (start) => {
    const parent = new Map([[start, undefined]]);
    let frontier = [start], depth = 0, seen = 1;
    while (frontier.length > 0 && depth < importGraphReach.MAX_DEPTH) {
      const next = [];
      for (const f of frontier) for (const e of edges(f)) {
        if (parent.has(e)) continue;
        parent.set(e, f);
        if (e === target) { const chain = []; for (let c = f; c !== undefined; c = parent.get(c)) chain.unshift(c); return chain; }
        if (++seen > importGraphReach.MAX_FILES) return undefined;
        next.push(e);
      }
      frontier = next; depth++;
    }
    return undefined;
  };

  const referencing = [], indirect = [];
  const directTexts = new Map();
  for (const file of listTestFiles(root)) {
    if (skip.has(file)) continue;
    const text = read(file);
    const rel = relative(root, file);
    const direct = (lang === "js" && !file.endsWith(".py") && importsModule(text, base)) || edges(file).includes(target);
    if (direct) { referencing.push(rel); directTexts.set(rel, text); continue; }
    const chain = chainTo(file);
    if (!chain) continue;
    const used = usedNames(text, names, lang);
    if (used.length > 0) indirect.push({ test: rel, names: used, via: chain.slice(1).map((c) => relative(root, c)) });
  }
  const exports = names.map((name) => ({
    name,
    referencedIn: [
      ...referencing.filter((f) => new RegExp(`\\b${escapeRe(name)}\\b`).test(directTexts.get(f))),
      ...indirect.filter((t) => t.names.includes(name)).map((t) => t.test),
    ],
  }));
  return { module: modulePath, exports, referencingTests: referencing, indirectTests: indirect };
}

/**
 * The gate: every existing test that imports the module, or reaches it and uses it, must be NAMED in the issue body (path or
 * basename), proving whoever wrote the issue looked. Returns the unacknowledged test paths; empty means the issue may run.
 */
export const INDIRECT_ASK = 3;

/** The indirect tests an issue must name: the strongest few (most distinct exports used, at least two), else the single strongest. */
export function strongestIndirect(report) {
  const ranked = [...(report.indirectTests ?? [])].sort((a, b) => b.names.length - a.names.length || (a.test < b.test ? -1 : 1));
  const strong = ranked.filter((t) => t.names.length >= 2).slice(0, INDIRECT_ASK);
  return strong.length > 0 ? strong : ranked.slice(0, 1);
}

export function unacknowledgedTests(report, issueBody) {
  const body = String(issueBody ?? "");
  const tests = [...report.referencingTests, ...strongestIndirect(report).map((t) => t.test)];
  return tests.filter((f) => !body.includes(f) && !body.includes(basename(f)));
}
