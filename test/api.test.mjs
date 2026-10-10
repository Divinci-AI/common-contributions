import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/api/handler.mjs";
import { MemoryStore } from "../src/api/stores.mjs";
import { validateProposal, cleanUrl, dedupeKey } from "../src/api/validate.mjs";
import { FAKE } from "./helpers.mjs";

const SUBMIT = ["sub", "mit-", "Zk3P9xQwL2mR7vTn"].join("");
const ADMIN = ["adm", "in-", "B5yH8cJdQ4wE6rTy"].join("");
const GOOD = { project: "Atlas Mini", url: "https://github.com/example/atlas-mini", kind: "Other", relationship: "None", work: "Add unit tests for the kinematics module." };

const env = (over = {}) => ({ store: new MemoryStore(), submitToken: SUBMIT, adminToken: ADMIN, ...over });
const call = (e, method, path, { token = SUBMIT, body, headers = {} } = {}) => handle(new Request(`https://x.test${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
}), e);
const j = async (res) => res.json();

test("fails closed: no store, no tokens, or identical tokens -> 503, never open", async () => {
  for (const e of [env({ store: null }), env({ submitToken: undefined }), env({ adminToken: "" }), env({ adminToken: SUBMIT })]) {
    assert.equal((await call(e, "GET", "/api/v1/proposals")).status, 503);
  }
});

test("auth: missing or wrong token is 401 and the token is never echoed", async () => {
  const e = env();
  assert.equal((await call(e, "GET", "/api/v1/proposals", { token: null })).status, 401);
  const res = await call(e, "GET", "/api/v1/proposals", { token: "wrong-token-value-0123456789" });
  assert.equal(res.status, 401);
  assert.ok(!(await res.text()).includes("wrong-token"));
});

test("submit creates a proposal as 'proposed', records the role, and returns 201 with a location", async () => {
  const e = env();
  const res = await call(e, "POST", "/api/v1/proposals", { body: GOOD });
  assert.equal(res.status, 201);
  const { proposal } = await j(res);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.submittedBy, "submit");
  assert.match(res.headers.get("location"), /^\/api\/v1\/proposals\/[0-9a-f-]{36}$/);
  assert.equal((await j(await call(e, "GET", `/api/v1/proposals/${proposal.id}`))).proposal.project, "Atlas Mini");
});

test("a client cannot choose its own status, submitter or id", async () => {
  const r = await call(env(), "POST", "/api/v1/proposals", { body: { ...GOOD, status: "listed", submittedBy: "admin" } });
  assert.equal(r.status, 422);
});

test("duplicates are caught however the URL is typed, and name the existing id", async () => {
  const e = env();
  const first = await j(await call(e, "POST", "/api/v1/proposals", { body: GOOD }));
  const dup = await call(e, "POST", "/api/v1/proposals", { body: { ...GOOD, url: "https://www.GitHub.com/Example/Atlas-Mini.git/" } });
  assert.equal(dup.status, 409);
  assert.equal((await j(dup)).id, first.proposal.id);
});

test("validation: bad urls, enums, secrets, oversize and wrong content-type are refused", async () => {
  const e = env();
  for (const bad of [
    { ...GOOD, url: "http://github.com/a/b" }, { ...GOOD, url: "https://user:pw@github.com/a/b" }, { ...GOOD, url: "https://localhost/a" },
    { ...GOOD, url: "https://127.0.0.1/a" }, { ...GOOD, url: "javascript:alert(1)" }, { ...GOOD, kind: "nope" }, { ...GOOD, relationship: "" },
    { ...GOOD, project: "" }, { ...GOOD, work: "x".repeat(2001) }, { ...GOOD, policyUrl: "ftp://x.org/p" },
  ]) assert.equal((await call(e, "POST", "/api/v1/proposals", { body: bad })).status, 422, JSON.stringify(bad).slice(0, 80));
  assert.equal((await call(e, "POST", "/api/v1/proposals", { body: "{not json" , headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await call(e, "POST", "/api/v1/proposals", { body: GOOD, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call(e, "POST", "/api/v1/proposals", { body: JSON.stringify({ ...GOOD, work: "y".repeat(20000) }) })).status, 413);
  const withSecret = await call(e, "POST", "/api/v1/proposals", { body: { ...GOOD, work: `use ${FAKE.github} to push` } });
  assert.equal(withSecret.status, 422);
  const text = await withSecret.text();
  assert.match(text, /github-token/);
  assert.ok(!text.includes(FAKE.github), "the response must name the kind, never the secret");
  assert.equal((await e.store.list()).length, 0);
});

test("the submit token cannot consent or list; only the admin token can, and consent needs a link", async () => {
  const e = env();
  const { proposal } = await j(await call(e, "POST", "/api/v1/proposals", { body: GOOD }));
  const path = `/api/v1/proposals/${proposal.id}`;
  assert.equal((await call(e, "PATCH", path, { token: SUBMIT, body: { status: "consented", consentUrl: "https://example.org/yes" } })).status, 403);
  assert.equal((await call(e, "PATCH", path, { token: ADMIN, body: { status: "consented" } })).status, 422, "consent without a link");
  assert.equal((await call(e, "PATCH", path, { token: ADMIN, body: { status: "listed" } })).status, 422, "cannot skip consent");
  const ok = await call(e, "PATCH", path, { token: ADMIN, body: { status: "consented", consentUrl: "https://example.org/yes", note: "maintainer replied" } });
  assert.equal(ok.status, 200);
  assert.equal((await j(ok)).proposal.consentUrl, "https://example.org/yes");
  assert.equal((await call(e, "PATCH", path, { token: ADMIN, body: { status: "listed" } })).status, 200);
});

test("public list shows only listed projects, with name/url/kind and nothing else, without a token", async () => {
  const e = env();
  const a = (await j(await call(e, "POST", "/api/v1/proposals", { body: GOOD }))).proposal;
  await call(e, "POST", "/api/v1/proposals", { body: { ...GOOD, project: "Other", url: "https://github.com/example/other" } });
  assert.deepEqual((await j(await call(e, "GET", "/api/v1/projects", { token: null }))).projects, []);
  await call(e, "PATCH", `/api/v1/proposals/${a.id}`, { token: ADMIN, body: { status: "consented", consentUrl: "https://example.org/yes" } });
  await call(e, "PATCH", `/api/v1/proposals/${a.id}`, { token: ADMIN, body: { status: "listed" } });
  const { projects } = await j(await call(e, "GET", "/api/v1/projects", { token: null }));
  assert.equal(projects.length, 1);
  assert.deepEqual(Object.keys(projects[0]).sort(), ["kind", "listedAt", "project", "url"]);
});

test("list filters by status and rejects an unknown one; unknown routes are 404", async () => {
  const e = env();
  await call(e, "POST", "/api/v1/proposals", { body: GOOD });
  assert.equal((await j(await call(e, "GET", "/api/v1/proposals?status=listed"))).proposals.length, 0);
  assert.equal((await j(await call(e, "GET", "/api/v1/proposals?status=proposed"))).proposals.length, 1);
  assert.equal((await call(e, "GET", "/api/v1/proposals?status=bogus")).status, 422);
  assert.equal((await call(e, "GET", "/api/v1/nope")).status, 404);
  assert.equal((await call(e, "DELETE", "/api/v1/proposals")).status, 405);
});

test("url helpers", () => {
  assert.equal(cleanUrl("https://github.com/a/b#frag"), "https://github.com/a/b");
  assert.equal(cleanUrl("https://10.0.0.1/x"), null);
  assert.equal(dedupeKey("https://github.com/A/B.git"), dedupeKey("https://www.github.com/a/b/"));
  assert.equal(validateProposal(null).ok, false);
});

test("the API source never makes an outbound request", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(new URL("../src/api/", import.meta.url))) {
    const src = readFileSync(new URL(`../src/api/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/.test(src), `${f} must not make network calls`);
  }
});

test("authenticated responses are never cacheable; only the public list is", async () => {
  const e = env();
  assert.equal((await call(e, "GET", "/api/v1/proposals")).headers.get("cache-control"), "no-store");
  assert.equal((await call(e, "GET", "/api/v1/proposals", { token: null })).headers.get("cache-control"), "no-store");
  assert.match((await call(e, "GET", "/api/v1/projects", { token: null })).headers.get("cache-control"), /public/);
});

test("the permission check comes before the lookup: a submit token gets 403 even for an id that does not exist", async () => {
  const r = await call(env(), "PATCH", "/api/v1/proposals/00000000-0000-0000-0000-000000000000", { body: { status: "declined" } });
  assert.equal(r.status, 403);
});
