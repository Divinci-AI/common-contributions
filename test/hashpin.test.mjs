import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSpec, reportToRequirements, pinRequirements, PIN_FLAGS } from "../src/hashpin.mjs";
import { checkRequirements } from "../src/depimage.mjs";
import { tmp } from "./helpers.mjs";

const H1 = "a".repeat(64), H2 = "b".repeat(64);
const URL = (n) => `https://files.pythonhosted.org/packages/ab/cd/${n}.whl`;
const entry = (name, version, hash, url) => ({
  download_info: { url: url ?? URL(`${name}-${version}`), archive_info: { hash: `sha256=${hash}`, hashes: { sha256: hash } } },
  is_direct: false, requested: true, metadata: { name, version },
});
const report = (...e) => ({ version: "1", install: e });

// ---- the spec comes from a PROJECT; it must be plain requirements and nothing else ----
test("plain specs, extras, ranges and markers pass", () => {
  const spec = 'pytest>=8\nhypothesis[cli]>=6.0,<7\nattrs==23.1.0 ; python_version >= "3.9"\n# a comment\n\nzope.interface';
  assert.deepEqual(checkSpec(spec), []);
});
const bad = {
  "option line": "--index-url https://evil.example/simple",
  "include": "-r other.txt",
  "editable": "-e .",
  "url": "pkg @ https://evil.example/pkg.whl",
  "vcs": "git+https://github.com/x/y.git",
  "path": "./local",
  "path with slash": "../x",
  "shell metacharacter": "pytest; rm -rf /",
  "backtick": "pytest`id`",
  "dollar": "pytest$(id)",
  "empty": "# nothing\n",
  "not a requirement": "this is not a requirement line",
};
for (const [name, line] of Object.entries(bad)) test(`spec refused: ${name}`, () => assert.ok(checkSpec(line).length > 0, line));
// Two guards overlap (the line shape and the explicit option/URL check); each must fire on its own, so assert WHICH one refused.
test("an option line is refused by the option check, not just by the shape check", () => assert.match(checkSpec("--index-url https://evil.example/simple")[0], /option line/));
test("a URL, VCS or path is refused by the plain-requirement check, not just by the shape check", () => {
  for (const l of ["pkg @ https://evil.example/pkg.whl", "git+https://github.com/x/y.git", "./local", "../x"]) assert.match(checkSpec(l)[0], /not a plain requirement/, l);
});

// ---- the pip report becomes a hashed requirements.txt the existing Stage A check accepts ----
test("a report becomes name==version with its sha256, sorted, and passes the Stage A requirements check", () => {
  const text = reportToRequirements(report(entry("Zope.Interface", "6.1", H2), entry("attrs", "23.1.0", H1)));
  assert.deepEqual(checkRequirements(text), []);
  assert.match(text, /^attrs==23\.1\.0 --hash=sha256:a{64}$/m);
  assert.match(text, /^zope-interface==6\.1 --hash=sha256:b{64}$/m); // normalised name
  assert.ok(text.indexOf("attrs==") < text.indexOf("zope-interface=="), "sorted for a stable file");
});
test("the same report gives byte-identical output", () => {
  const r = report(entry("b", "1", H1), entry("a", "2", H2));
  assert.equal(reportToRequirements(r), reportToRequirements(JSON.parse(JSON.stringify(r))));
});
const badReport = {
  "no hash": (e) => delete e.download_info.archive_info.hashes,
  "md5 only": (e) => (e.download_info.archive_info = { hashes: { md5: "a".repeat(32) } }),
  "short hash": (e) => (e.download_info.archive_info.hashes.sha256 = "abc"),
  "uppercase hash": (e) => (e.download_info.archive_info.hashes.sha256 = "A".repeat(64)),
  "not pypi files host": (e) => (e.download_info.url = "https://evil.example/x.whl"),
  "lookalike host": (e) => (e.download_info.url = "https://files.pythonhosted.org.evil.example/x.whl"),
  "plain http": (e) => (e.download_info.url = "http://files.pythonhosted.org/x.whl"),
  "an sdist, not a wheel": (e) => (e.download_info.url = URL("x").replace(".whl", ".tar.gz")),
  "direct url": (e) => (e.is_direct = true),
  "no version": (e) => delete e.metadata.version,
  "odd name": (e) => (e.metadata.name = "a b; c"),
};
const badReason = { "no hash": /no sha256/, "md5 only": /no sha256/, "short hash": /no sha256/, "uppercase hash": /no sha256/, "not pypi files host": /not a wheel/, "lookalike host": /not a wheel/, "plain http": /not a wheel/, "an sdist, not a wheel": /not a wheel/, "direct url": /direct URL/, "no version": /odd version/, "odd name": /odd package name/ };
for (const [name, fn] of Object.entries(badReport)) test(`report refused: ${name}`, () => {
  const e = entry("attrs", "1.0", H1); fn(e);
  assert.throws(() => reportToRequirements(report(e)), badReason[name]);
});
test("the same package listed twice with different files is refused", () => {
  assert.throws(() => reportToRequirements(report(entry("attrs", "1.0", H1), entry("Attrs", "1.0", H2))), /listed twice/);
});
test("the same package listed twice with the same file is fine", () => {
  assert.equal(reportToRequirements(report(entry("attrs", "1.0", H1), entry("attrs", "1.0", H1))).trim().split("\n").length, 1);
});
test("an empty or malformed report is refused", () => {
  assert.throws(() => reportToRequirements(report()), /no packages/);
  assert.throws(() => reportToRequirements({}), /no packages/);
  assert.throws(() => reportToRequirements(null), /no packages/);
});

// ---- the one network step: a throwaway container with no host access ----
const fakeDocker = (dir, stdout, code = 0) => {
  const p = join(dir, "docker");
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\nprintf '%s' '${stdout.replace(/'/g, "")}'\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
};
const DIGEST = "python@sha256:" + "c".repeat(64);

test("pinRequirements runs a locked-down throwaway container, feeds the spec on stdin, and returns hashed requirements", () => {
  const dir = tmp();
  const docker = fakeDocker(dir, JSON.stringify(report(entry("attrs", "23.1.0", H1))));
  const r = pinRequirements({ docker, baseDigest: DIGEST, specText: "attrs\n" });
  assert.equal(r.ok, true);
  assert.deepEqual(checkRequirements(r.requirements), []);
  const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
  for (const flag of PIN_FLAGS) assert.ok(argv.includes(flag) || argv.join(" ").includes(flag), `missing ${flag}`);
  assert.ok(argv.includes(DIGEST), "base image named by digest");
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "attrs\n");
  assert.ok(!argv.some((a) => /^-v$|--volume|--mount|docker\.sock|--privileged|--network=host/.test(a)), "no mounts, no host network");
});
test("pinning refuses a tag instead of a digest, and a bad spec, before docker is touched", () => {
  const t = pinRequirements({ docker: "/nonexistent/docker", baseDigest: "python:3.12", specText: "attrs" });
  assert.equal(t.ok, false);
  assert.match(t.refused, /digest/);
  const r = pinRequirements({ docker: "/nonexistent/docker", baseDigest: DIGEST, specText: "-r evil.txt" });
  assert.equal(r.ok, false);
  assert.match(r.refused, /spec refused/);
});
test("a failing container (pip could not resolve wheels) is a refusal that carries pip's reason", () => {
  const dir = tmp();
  const r = pinRequirements({ docker: fakeDocker(dir, "ERROR: No matching distribution found for asv", 1), baseDigest: DIGEST, specText: "asv" });
  assert.equal(r.ok, false);
  assert.match(r.refused, /No matching distribution/);
});
test("garbage on stdout is a refusal, not a crash", () => {
  const dir = tmp();
  const r = pinRequirements({ docker: fakeDocker(dir, "not json"), baseDigest: DIGEST, specText: "attrs" });
  assert.equal(r.ok, false);
});
