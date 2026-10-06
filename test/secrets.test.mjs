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
