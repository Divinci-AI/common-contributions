#!/usr/bin/env node
/**
 * Client for the proposal API, for use from a Claude Code session or a shell.
 *   COMMON_CONTRIBUTIONS_API_TOKEN=... node scripts/propose.mjs submit --project "Name" --url https://... --kind other --relationship none --work "..."
 *   node scripts/propose.mjs list [--status proposed]
 *   node scripts/propose.mjs get <id>
 *   node scripts/propose.mjs public
 * The token comes from the environment only (never argv, where `ps` can read it). It is never printed.
 * Base URL: COMMON_CONTRIBUTIONS_API_URL, default the preview Worker. Exit code is non-zero on any non-2xx.
 */
const BASE = (process.env.COMMON_CONTRIBUTIONS_API_URL ?? "https://common-contributions-preview.divinci-ai.workers.dev").replace(/\/+$/, "");
const KINDS = { software: "Open source software", science: "Open science / research software", other: "Other" };
const RELS = { maintain: "I maintain it", contribute: "I contribute to it", use: "I use it", none: "None" };

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i]; else positional.push(rest[i]);
}

async function call(method, path, { body, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const t = process.env.COMMON_CONTRIBUTIONS_API_TOKEN;
    if (!t) { console.error("set COMMON_CONTRIBUTIONS_API_TOKEN in the environment"); process.exit(2); }
    headers.authorization = `Bearer ${t}`;
  }
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, errors: [`non-JSON response (${res.status}): ${text.slice(0, 200)}`] }; }
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

if (cmd === "submit") {
  const kind = KINDS[flags.kind] ?? flags.kind;
  const relationship = RELS[flags.relationship] ?? flags.relationship;
  const body = { project: flags.project, url: flags.url, kind, relationship };
  if (flags.work) body.work = flags.work;
  if (flags.policy) body.policyUrl = flags.policy;
  await call("POST", "/api/v1/proposals", { body });
} else if (cmd === "list") await call("GET", `/api/v1/proposals${flags.status ? `?status=${encodeURIComponent(flags.status)}` : ""}`);
else if (cmd === "get" && positional[0]) await call("GET", `/api/v1/proposals/${encodeURIComponent(positional[0])}`);
else if (cmd === "public") await call("GET", "/api/v1/projects", { auth: false });
else { console.error("usage: propose.mjs submit|list|get <id>|public  (see the header of this file)"); process.exit(2); }
