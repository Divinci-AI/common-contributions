/**
 * Input rules for a project proposal. Mirrors .github/ISSUE_TEMPLATE/propose-a-project.yml.
 * The API NEVER fetches a submitted URL (no SSRF, and nobody is contacted); it only stores it for a person to read.
 * Findings from the secret scans carry the KIND only, never the matched text.
 */
import { scanForSecrets, scanAddedForEntropy } from "../secrets.mjs";

export const KINDS = Object.freeze(["Open source software", "Open science / research software", "Other"]);
export const RELATIONSHIPS = Object.freeze(["I maintain it", "I contribute to it", "I use it", "None"]);
const LIMITS = { project: 120, work: 2000, note: 1000 };

/** https only, no userinfo, a real dotted hostname (not an IP literal or localhost). Returns a normalised URL string or null. */
export function cleanUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  u.hash = "";
  return u.toString();
}

/** Same project, however it is typed: lowercase host and path, no trailing slash, no .git, no query. */
export function dedupeKey(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}`;
}

const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function validateProposal(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["body must be a JSON object"] };
  const known = new Set(["project", "url", "kind", "relationship", "work", "policyUrl"]);
  for (const k of Object.keys(input)) if (!known.has(k)) errors.push(`unknown field: ${k}`);

  if (!isText(input.project, LIMITS.project)) errors.push(`project: required, up to ${LIMITS.project} characters`);
  const url = cleanUrl(input.url);
  if (!url) errors.push("url: required, an https link to the project (no credentials, no IP address, no localhost)");
  if (!KINDS.includes(input.kind)) errors.push(`kind: one of ${KINDS.join(" | ")}`);
  if (!RELATIONSHIPS.includes(input.relationship)) errors.push(`relationship: one of ${RELATIONSHIPS.join(" | ")}`);
  if (input.work !== undefined && !isText(input.work, LIMITS.work)) errors.push(`work: up to ${LIMITS.work} characters`);
  let policyUrl;
  if (input.policyUrl !== undefined && input.policyUrl !== "") {
    policyUrl = cleanUrl(input.policyUrl);
    if (!policyUrl) errors.push("policyUrl: an https link, or leave it out");
  }

  const text = [input.project, input.work, input.url, input.policyUrl].filter((v) => typeof v === "string").join("\n");
  const kinds = [...scanForSecrets(text), ...scanAddedForEntropy(text)].map((f) => f.kind);
  if (kinds.length) errors.push(`looks like it contains a secret (${[...new Set(kinds)].join(", ")}); remove it and resubmit`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      project: input.project.trim(), url, kind: input.kind, relationship: input.relationship,
      work: input.work?.trim() || null, policyUrl: policyUrl ?? null,
    },
  };
}

/** Status machine. Only a person (the admin token) moves a proposal; the submitter token can never reach "consented" or "listed". */
export const TRANSITIONS = Object.freeze({
  proposed: ["consented", "declined"],
  consented: ["listed", "declined"],
  listed: ["declined"],
  declined: [],
});

export function validateTransition(current, body) {
  const errors = [];
  const to = body?.status;
  if (!TRANSITIONS[current]?.includes(to)) errors.push(`status: ${current} can move to ${TRANSITIONS[current]?.join(" | ") || "nothing"}`);
  let consentUrl = null;
  if (to === "consented") {
    consentUrl = cleanUrl(body?.consentUrl);
    if (!consentUrl) errors.push("consentUrl: required for consented, an https link to the maintainer's written yes");
  }
  const note = body?.note;
  if (note !== undefined && !isText(note, LIMITS.note)) errors.push(`note: up to ${LIMITS.note} characters`);
  if (typeof note === "string" && (scanForSecrets(note).length || scanAddedForEntropy(note).length)) errors.push("note: looks like it contains a secret");
  return errors.length ? { ok: false, errors } : { ok: true, value: { status: to, consentUrl, note: note?.trim() || null } };
}
