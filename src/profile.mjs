/**
 * A project profile says HOW to check a contribution in a project's language: where the project lives inside the source tree,
 * which dependency file feeds the dependency image, and the exact argv of each check. Argv only, never a shell string, so there is
 * nothing for a metacharacter to do. Two profiles ship; a file can supply another, and it is validated the same way.
 */
import { readFileSync } from "node:fs";

const PLAIN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "env", "busybox"]);

export const PROFILES = Object.freeze({
  node: {
    language: "node", subdir: "orchestrator", depFile: "package-lock.json", depLabel: "cc.lock", testCheck: "vitest",
    checks: [
      { name: "tsc", argv: ["/work/node_modules/.bin/tsc", "--noEmit"] },
      { name: "vitest", argv: ["/work/node_modules/.bin/vitest", "run", "--configLoader", "runner", "{test}"] },
    ],
  },
  python: {
    language: "python", subdir: "", depFile: "requirements.txt", depLabel: "cc.requirements", testCheck: "pytest",
    checks: [{ name: "pytest", argv: ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "{test}"] }],
  },
});

export function validateProfile(p) {
  const bad = [];
  if (!p || typeof p !== "object") return ["profile is not an object"];
  if (!["node", "python"].includes(p.language)) bad.push(`language ${p.language}`);
  if (p.subdir !== "" && !(PLAIN.test(p.subdir ?? "") && !p.subdir.split("/").includes(".."))) bad.push("subdir must be a plain relative path");
  if (!PLAIN.test(p.depFile ?? "") || p.depFile.split("/").includes("..")) bad.push("depFile must be a plain relative path");
  if (!["cc.lock", "cc.requirements"].includes(p.depLabel)) bad.push("depLabel must be cc.lock or cc.requirements");
  if (p.pythonPath !== undefined && (p.language !== "python" || typeof p.pythonPath !== "string" || !PLAIN.test(p.pythonPath) || p.pythonPath.split("/").includes("..") || p.pythonPath.startsWith("-"))) bad.push("pythonPath must be a plain relative path, and only a python profile may have one");
  if (!Array.isArray(p.checks) || p.checks.length === 0) bad.push("no checks");
  const names = new Set();
  for (const c of p.checks ?? []) {
    if (typeof c?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(c.name) || names.has(c.name)) { bad.push(`check name ${c?.name}`); continue; }
    names.add(c.name);
    if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some((a) => typeof a !== "string" || /[\0\r\n]/.test(a))) { bad.push(`${c.name}: argv must be strings without control characters`); continue; }
    const exe = c.argv[0];
    if (SHELLS.has(exe.split("/").pop())) bad.push(`${c.name}: a shell is not an allowed executable`);
    if (!(exe === "python" || /^\/work\/node_modules\/\.bin\/[A-Za-z0-9._-]+$/.test(exe))) bad.push(`${c.name}: executable must be python or a /work/node_modules/.bin tool`);
    if (c.argv.filter((a) => a.includes("{") && a !== "{test}").length > 0) bad.push(`${c.name}: only {test} is a placeholder`);
  }
  if (!names.has(p.testCheck)) bad.push("testCheck names no check");
  return bad;
}

export function resolveProfile(spec = "node") {
  const p = PROFILES[spec] ?? (() => { try { return JSON.parse(readFileSync(spec, "utf8")); } catch (e) { throw new Error(`cannot read profile ${spec}: ${e.message}`); } })();
  const bad = validateProfile(p);
  if (bad.length > 0) throw new Error(`profile refused: ${bad.join("; ")}`);
  return p;
}

/** The test path relative to the profile's subdir, or throws. `{test}` is replaced; nothing else is interpolated. */
export function testRelative(p, testPath) {
  const prefix = p.subdir ? p.subdir + "/" : "";
  if (!PLAIN.test(testPath) || testPath.split("/").includes("..") || testPath.startsWith("-")) throw new Error(`test path ${testPath} is not a plain relative path`);
  if (prefix && !testPath.startsWith(prefix)) throw new Error(`test path ${testPath} is outside the profile's subdir ${p.subdir}`);
  return testPath.slice(prefix.length);
}
export const expandChecks = (p, testRel) => p.checks.map((c) => ({ name: c.name, argv: c.argv.map((a) => (a === "{test}" ? testRel : a)) }));
