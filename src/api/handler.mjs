/**
 * Common Contributions proposal API. Pure: (Request, { store, submitToken, adminToken }) -> Response. No network calls, ever.
 *
 *   POST  /api/v1/proposals        submit a project            (submit or admin token)
 *   GET   /api/v1/proposals        list all, ?status=          (submit or admin token)
 *   GET   /api/v1/proposals/:id    read one                    (submit or admin token)
 *   PATCH /api/v1/proposals/:id    move the status             (ADMIN token only: a person)
 *   GET   /api/v1/projects         the public list: status "listed" only, name/url/kind, no auth
 *
 * A proposal is a suggestion, not a listing. A project appears publicly only after a person records the maintainer's written yes.
 * The token an agent holds can submit and read; it cannot consent or list. Both tokens are required to be set and different,
 * otherwise the API answers 503 instead of running open. Tokens are compared by digest in constant time and never logged or echoed.
 */
import { validateProposal, validateTransition, dedupeKey } from "./validate.mjs";

const MAX_BODY = 16 * 1024;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
const fail = (status, errors, extra) => json(status, { ok: false, errors: [].concat(errors) }, extra);

const enc = new TextEncoder();
async function digest(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function roleOf(request, { submitToken, adminToken }) {
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  // Check both unconditionally so timing does not reveal which token was close.
  const [isAdmin, isSubmit] = await Promise.all([sameSecret(m[1], adminToken), sameSecret(m[1], submitToken)]);
  return isAdmin ? "admin" : isSubmit ? "submit" : null;
}

const own = (r) => ({
  id: r.id, status: r.status, project: r.project, url: r.url, kind: r.kind, relationship: r.relationship, work: r.work,
  policyUrl: r.policyUrl, submittedBy: r.submittedBy, consentUrl: r.consentUrl, note: r.note, createdAt: r.createdAt, updatedAt: r.updatedAt,
});
const publicView = (r) => ({ project: r.project, url: r.url, kind: r.kind, listedAt: r.updatedAt });

async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return { error: fail(415, "content-type must be application/json") };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return { error: fail(413, `body over ${MAX_BODY} bytes`) };
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: fail(413, `body over ${MAX_BODY} bytes`) };
  try { return { value: JSON.parse(text) }; } catch { return { error: fail(400, "body is not valid JSON") }; }
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/api/v1/")) return fail(404, "not found");

  if (path === "/api/v1/projects" && request.method === "GET") {
    if (!env.store) return fail(503, "storage is not configured");
    const rows = await env.store.list("listed");
    return json(200, { ok: true, projects: rows.map(publicView) }, { "cache-control": "public, max-age=60" });
  }

  const configured = env.store && env.submitToken && env.adminToken && env.submitToken !== env.adminToken;
  if (!configured) return fail(503, "the API is not configured (storage and two distinct tokens are required)");

  const role = await roleOf(request, env);
  if (!role) return fail(401, "missing or wrong bearer token", { "www-authenticate": "Bearer" });

  if (path === "/api/v1/proposals") {
    if (request.method === "POST") {
      const body = await readJson(request);
      if (body.error) return body.error;
      const v = validateProposal(body.value);
      if (!v.ok) return fail(422, v.errors);
      const now = new Date().toISOString();
      const rec = { id: crypto.randomUUID(), dedupeKey: dedupeKey(v.value.url), status: "proposed", ...v.value, submittedBy: role, consentUrl: null, note: null, createdAt: now, updatedAt: now };
      const res = await env.store.insert(rec);
      if (res.duplicateOf) return json(409, { ok: false, errors: ["this project was already proposed"], id: res.duplicateOf });
      return json(201, { ok: true, proposal: own(rec) }, { location: `/api/v1/proposals/${rec.id}` });
    }
    if (request.method === "GET") {
      const status = url.searchParams.get("status");
      if (status && !["proposed", "consented", "listed", "declined"].includes(status)) return fail(422, "status filter is not a known status");
      return json(200, { ok: true, proposals: (await env.store.list(status)).map(own) });
    }
    return fail(405, "method not allowed", { allow: "GET, POST" });
  }

  const one = /^\/api\/v1\/proposals\/([0-9a-f-]{36})$/.exec(path);
  if (one) {
    if (request.method === "PATCH" && role !== "admin") return fail(403, "only a person (the admin token) can change a proposal's status");
    const rec = await env.store.get(one[1]);
    if (!rec) return fail(404, "no such proposal");
    if (request.method === "GET") return json(200, { ok: true, proposal: own(rec) });
    if (request.method === "PATCH") {
      if (role !== "admin") return fail(403, "only a person (the admin token) can change a proposal's status");
      const body = await readJson(request);
      if (body.error) return body.error;
      const t = validateTransition(rec.status, body.value);
      if (!t.ok) return fail(422, t.errors);
      const updated = await env.store.update(rec.id, { status: t.value.status, consentUrl: t.value.consentUrl ?? rec.consentUrl, note: t.value.note ?? rec.note, updatedAt: new Date().toISOString() });
      return json(200, { ok: true, proposal: own(updated) });
    }
    return fail(405, "method not allowed", { allow: "GET, PATCH" });
  }
  return fail(404, "not found");
}
