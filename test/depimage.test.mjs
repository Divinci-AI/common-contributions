import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLockfile, dockerfile, buildDepImage, checkRequirements, pyDockerfile, buildPyDepImage } from "../src/depimage.mjs";

const ok = () => ({ lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-abc" } } });

test("a registry lockfile with hashes passes", () => assert.deepEqual(checkLockfile(ok()), []));
const mutate = {
  "git dependency": (l) => (l.packages["node_modules/a"].resolved = "git+ssh://git@github.com/x/a.git#abc"),
  "tarball URL": (l) => (l.packages["node_modules/a"].resolved = "https://evil.example/a.tgz"),
  "plain http": (l) => (l.packages["node_modules/a"].resolved = "http://registry.npmjs.org/a/-/a-1.0.0.tgz"),
  "lookalike host": (l) => (l.packages["node_modules/a"].resolved = "https://registry.npmjs.org.evil.example/a.tgz"),
  "file dependency": (l) => (l.packages["node_modules/a"].resolved = "file:../a"),
  "link": (l) => (l.packages["node_modules/a"] = { link: true, resolved: "../a" }),
  "no resolved": (l) => delete l.packages["node_modules/a"].resolved,
  "no integrity": (l) => delete l.packages["node_modules/a"].integrity,
  "weak integrity": (l) => (l.packages["node_modules/a"].integrity = "sha1-abc"),
};
for (const [name, fn] of Object.entries(mutate)) test(`lockfile refused: ${name}`, () => { const l = ok(); fn(l); assert.ok(checkLockfile(l).length > 0); });
test("not a v2/3 lockfile is refused", () => { assert.ok(checkLockfile({}).length > 0); assert.ok(checkLockfile(null).length > 0); });

test("dockerfile ignores scripts and uses the digest", () => {
  const d = dockerfile("node@sha256:" + "a".repeat(64));
  assert.match(d, /^FROM node@sha256:a{64}/);
  assert.match(d, /npm ci --ignore-scripts/);
});
test("a tag instead of a digest is refused before docker is touched", () => {
  const r = buildDepImage({ docker: "/nonexistent/docker", projectDir: "/nonexistent", baseDigest: "node:22-alpine" });
  assert.equal(r.ok, false); assert.match(r.refused, /digest/);
});

const H = "--hash=sha256:" + "a".repeat(64);
test("a hashed, pinned requirements file passes (with continuations, comments, markers)", () => {
  assert.deepEqual(checkRequirements(`# c\npytest==8.3.4 \\\n  ${H} \\\n  ${H}\nfoo[bar]==1.0 ; python_version<"3.13" ${H}\n`), []);
});
const badReq = {
  "no hash": "pytest==8.3.4\n",
  "unpinned": `pytest>=8 ${H}\n`,
  "short hash": "pytest==8.3.4 --hash=sha256:abc\n",
  "md5 hash": "pytest==8.3.4 --hash=md5:" + "a".repeat(32) + "\n",
  "VCS": `git+https://github.com/x/y.git#egg=y ${H}\n`,
  "direct url": `y @ https://evil.example/y.whl ${H}\n`,
  "local path": `./y ${H}\n`,
  "editable": `-e . ${H}\n`,
  "include": "-r other.txt\n",
  "extra index": `--extra-index-url https://evil.example/simple\npytest==8.3.4 ${H}\n`,
  "find-links": `--find-links /tmp/x\npytest==8.3.4 ${H}\n`,
  "empty": "# nothing\n",
};
for (const [name, text] of Object.entries(badReq)) test(`requirements refused: ${name}`, () => assert.ok(checkRequirements(text).length > 0));
test("python dockerfile: wheels only, hashes required, no deps resolution", () => {
  const d = pyDockerfile("python@sha256:" + "a".repeat(64));
  for (const f of ["--require-hashes", "--only-binary :all:", "--no-deps"]) assert.ok(d.includes(f), f);
});
test("python: a tag instead of a digest is refused", () => assert.equal(buildPyDepImage({ docker: "/x", projectDir: "/x", baseDigest: "python:3" }).ok, false));
