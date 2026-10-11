import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLockfile, dockerfile, buildDepImage } from "../src/depimage.mjs";

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
