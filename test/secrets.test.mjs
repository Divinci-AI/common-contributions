import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxEnv, SAFE_ENV_NAMES, scanForSecrets } from "../src/secrets.mjs";
import { FAKE } from "./helpers.mjs";

test("detects each secret shape, by kind", () => {
  const expect = { aws: "aws-access-key", github: "github-token", slack: "slack-token", sk: "api-key-sk", google: "google-api-key", jwt: "jwt", pem: "private-key", bearer: "bearer" };
  for (const [name, kind] of Object.entries(expect)) {
    const kinds = scanForSecrets(`prefix ${FAKE[name]} suffix`).map((f) => f.kind);
    assert.ok(kinds.includes(kind), `${name} -> ${kind}, got ${kinds}`);
  }
});

test("findings never contain the matched text", () => {
  for (const v of Object.values(FAKE)) {
    const json = JSON.stringify(scanForSecrets(`x ${v} y`));
    assert.ok(!json.includes(v), "a finding leaked the secret");
  }
});

test("ordinary prose and code are not flagged", () => {
  assert.deepEqual(scanForSecrets("const x = skills.filter(s => s.ok); // task-list and a-b-c"), []);
  assert.deepEqual(scanForSecrets(""), []);
  assert.deepEqual(scanForSecrets(undefined), []);
});

test("the sandbox env is an allowlist: tokens and cloud credentials never pass through", () => {
  const env = { PATH: "/bin", HOME: "/Users/real", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "y", AWS_SECRET_ACCESS_KEY: "z", CLOUDFLARE_API_TOKEN: "w", FOO: "bar" };
  const out = buildSandboxEnv(env, { home: "/scratch/home" });
  assert.deepEqual(Object.keys(out).sort(), ["HOME", "PATH"]);
  for (const forbidden of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "FOO"]) {
    assert.ok(!(forbidden in out), forbidden);
    assert.ok(!SAFE_ENV_NAMES.includes(forbidden));
  }
});

test("HOME is replaced so credential files under the real home are not found", () => {
  assert.equal(buildSandboxEnv({ HOME: "/Users/real" }, { home: "/scratch/home" }).HOME, "/scratch/home");
});

test("an explicit extra value is passed, unless it looks like a secret", () => {
  assert.equal(buildSandboxEnv({}, { home: "/h", extra: { OLLAMA_HOST: "http://127.0.0.1:11434" } }).OLLAMA_HOST, "http://127.0.0.1:11434");
  assert.throws(() => buildSandboxEnv({}, { home: "/h", extra: { TOKEN: FAKE.github } }), /looks like a secret/);
});

// ---- prefix-less secrets: long random-looking strings that were ADDED ----
import { scanAddedForEntropy } from "../src/secrets.mjs";

const RANDOM_B64 = ["q9XvT2mZk7LpR4sW", "8nYb1HcJd6FgA3eU"].join(""); // 32 chars, built at runtime so no scanner flags this file
const HEX32 = "0123456789abcdef".repeat(2);

test("a long random-looking token that was added is flagged, and the finding never contains it", () => {
  const f = scanAddedForEntropy(`const t = "${RANDOM_B64}";`);
  assert.deepEqual(f.map((x) => x.kind), ["high-entropy-token"]);
  assert.ok(!JSON.stringify(f).includes(RANDOM_B64));
});

test("a token already in the original file is not 'added', so existing fixtures never trip the kill switch", () => {
  assert.deepEqual(scanAddedForEntropy(`x = "${RANDOM_B64}"`, `// old\nkeep = "${RANDOM_B64}"`), []);
});

test("ordinary long strings are not flagged: hashes, uuids, kebab ids, camelCase, paths, data URIs", () => {
  const benign = [
    "a".repeat(40),
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // sha256 hex
    "da39a3ee5e6b4b0d3255bfef95601890afd80709", // sha1 hex
    "123e4567-e89b-12d3-a456-426614174000", // uuid
    "very-long-kebab-case-identifier-name-for-a-test-case",
    "internationalizationConfigurationLoader2Factory",
    "src/components/very/deeply/nested/directory/path/file2.test.ts",
    `data:image/png;base64,${RANDOM_B64}`,
    "abcdefghijklmnopqrstuvwxyzABCDEFGH", // an alphabet fixture: high entropy, no digit, not a credential
  ];
  for (const b of benign) assert.deepEqual(scanAddedForEntropy(`x ${b} y`), [], b);
});

test("a hex string is flagged only when a key/token/secret word sits just before it", () => {
  assert.deepEqual(scanAddedForEntropy(`checksum ${HEX32}`), []);
  assert.deepEqual(scanAddedForEntropy(`api_key = "${HEX32}"`).map((x) => x.kind), ["high-entropy-token"]);
  assert.deepEqual(scanAddedForEntropy(`password: ${HEX32}`).map((x) => x.kind), ["high-entropy-token"]);
});
