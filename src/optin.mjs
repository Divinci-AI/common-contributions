/**
 * The maintainer's opt-in file (.github/agent-contributions.json). It is INERT DATA: enums, small numbers, short printable strings and globs.
 * It cannot name a command, a URL to fetch or a path to run. Anything unexpected refuses the WHOLE file (fail closed).
 * Parsed by a strict in-house JSON parser: no dependencies, no duplicate keys, no prototype tricks, no BOM, depth and size capped.
 */

export const OPTIN_PATH = ".github/agent-contributions.json";
export const MAX_BYTES = 16 * 1024;
const MAX_DEPTH = 3;

// ---- strict JSON ---------------------------------------------------------------------------------------------------------------------

class ParseError extends Error {}
const fail = (m) => { throw new ParseError(m); };

/** Parse bytes as UTF-8 JSON, strictly. Throws ParseError. Objects have a null prototype. */
export function parseStrictJson(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buf.length > MAX_BYTES) fail(`file is ${buf.length} bytes (max ${MAX_BYTES})`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf); } catch { fail("not valid UTF-8"); }
  if (text.charCodeAt(0) === 0xfeff) fail("byte order mark");
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++; };
  const value = (depth) => {
    ws();
    const c = text[i];
    if (c === "{") return object(depth + 1);
    if (c === "[") return array(depth + 1);
    if (c === '"') return string();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    return fail(`unexpected character at ${i}`);
  };
  const number = () => {
    const m = /^-?(0|[1-9][0-9]*)/.exec(text.slice(i, i + 20));
    if (!m) fail(`bad number at ${i}`);
    i += m[0].length;
    if (/[.eE]/.test(text[i] ?? "")) fail("only integers are allowed");
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("integer out of range");
    return n;
  };
  const string = () => {
    i++; let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i++];
      if (c === '"') return out;
      const code = c.charCodeAt(0);
      if (code < 0x20) fail("control character in string");
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      if (e === "u") {
        const h = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad \\u escape");
        out += String.fromCharCode(parseInt(h, 16)); i += 4;
      } else if ('"\\/'.includes(e)) out += e;
      else if (e === "b") out += "\b"; else if (e === "f") out += "\f"; else if (e === "n") out += "\n"; else if (e === "r") out += "\r"; else if (e === "t") out += "\t";
      else fail("bad escape");
    }
  };
  const noLoneSurrogates = (s) => { for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(k + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) fail("lone surrogate"); k++; } else if (c >= 0xdc00 && c <= 0xdfff) fail("lone surrogate"); } return s; };
  const object = (depth) => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    i++; const o = Object.create(null);
    ws();
    if (text[i] === "}") { i++; return o; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail(`expected a key at ${i}`);
      const k = noLoneSurrogates(string());
      if (k in o) fail(`duplicate key "${k.slice(0, 40)}"`);
      ws(); if (text[i++] !== ":") fail("expected ':'");
      o[k] = checkStrings(value(depth));
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return o; }
      fail(`expected ',' or '}' at ${i}`);
    }
  };
  const checkStrings = (v) => (typeof v === "string" ? noLoneSurrogates(v) : v);
  const array = (depth) => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    i++; const a = [];
    ws();
    if (text[i] === "]") { i++; return a; }
    for (;;) {
      a.push(checkStrings(value(depth)));
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return a; }
      fail(`expected ',' or ']' at ${i}`);
    }
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail("trailing content after the JSON value");
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("top level must be an object");
  return v;
}

// ---- string and glob rules -----------------------------------------------------------------------------------------------------------

/** Letters, numbers, punctuation and the ordinary space only: no controls, bidi controls, zero-width, separators, tabs or newlines. */
const BAD_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xd800, 0xdfff]];
export const isPrintable = (s) => typeof s === "string" && s === s.normalize("NFC") && ![...s].some((ch) => { const c = ch.codePointAt(0); return BAD_RANGES.some(([lo, hi]) => c >= lo && c <= hi); });
/** Hidden or control characters in free text (newline, carriage return and tab are allowed: this is for files and PR text). Returns the code points found. */
export const hiddenChars = (s) => [...String(s)].filter((ch) => { const c = ch.codePointAt(0); return c !== 9 && c !== 10 && c !== 13 && BAD_RANGES.some(([lo, hi]) => c >= lo && c <= hi); }).map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
/** No markup, links, images or mentions in text that lands in a PR. */
export const isPlainText = (s) => isPrintable(s) && !/[<>`@\\]|\]\(|https?:|www\./i.test(s);

export function validGlob(g) {
  if (typeof g !== "string" || g.length === 0 || g.length > 200 || !isPrintable(g)) return false;
  if (!/^[A-Za-z0-9._\-\/*?]+$/.test(g) || g.startsWith("/") || g.includes("//") || g.endsWith("/")) return false;
  return g.split("/").every((seg) => seg !== ".." && seg !== "." && (!seg.includes("**") || seg === "**"));
}

/** Linear-ish glob matcher (no regex built from the pattern): `*` and `?` stay inside a segment, a `**` segment matches any number of segments. */
export function globMatch(pattern, path) {
  const P = pattern.split("/"), S = path.split("/");
  const seg = (p, s) => { // iterative wildcard match inside one segment
    let pi = 0, si = 0, star = -1, mark = 0;
    while (si < s.length) {
      if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) { pi++; si++; }
      else if (pi < p.length && p[pi] === "*") { star = pi++; mark = si; }
      else if (star !== -1) { pi = star + 1; si = ++mark; }
      else return false;
    }
    while (pi < p.length && p[pi] === "*") pi++;
    return pi === p.length;
  };
  const memo = new Map();
  const go = (i, j) => {
    const k = i * (S.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === P.length) r = j === S.length;
    else if (P[i] === "**") r = go(i + 1, j) || (j < S.length && go(i, j + 1));
    else r = j < S.length && seg(P[i], S[j]) && go(i + 1, j + 1);
    memo.set(k, r); return r;
  };
  return go(0, 0);
}

// ---- schema --------------------------------------------------------------------------------------------------------------------------

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CONTACT = /^(?:@[A-Za-z0-9-]{1,39}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24})$/;
/** A project may ask for 6 to 720 hours between our pull requests to it (default 24). Below 6 is not allowed; a project cannot ask for less. */
export const MIN_HOURS_BETWEEN_PRS = [6, 720];
export const OPTIN_KEYS = ["version", "opt_in", "contact", "policy_url", "review_by", "paused", "task_label", "label_applied_by", "label_blocklist", "claim_required", "first_time_contributors", "max_open_agent_prs", "max_diff_lines", "min_hours_between_prs", "allowed_paths", "forbidden_paths", "safety_critical", "safety_reason", "changelog", "disclosure", "certification"];
const REQUIRED = ["version", "opt_in", "contact", "policy_url", "review_by", "label_applied_by", "disclosure", "certification"];
const DAY = 24 * 3600 * 1000;

/** An https URL with a real hostname, no credentials, no IP literal, no port tricks. Shown to people, never fetched. */
export function cleanHttpsUrl(v) {
  if (typeof v !== "string" || v.length > 300 || !isPrintable(v)) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return null;
  return u.toString();
}

/** Returns {ok:true, value} with defaults filled in, or {ok:false, errors}. `now` is injectable for tests. */
export function validateOptIn(o, { now = Date.now() } = {}) {
  const e = [];
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, errors: ["not an object"] };
  for (const k of Object.keys(o)) if (!OPTIN_KEYS.includes(k)) e.push(`unknown key: ${k.slice(0, 40)}`);
  for (const k of REQUIRED) if (!(k in o)) e.push(`missing key: ${k}`);
  const int = (k, lo, hi) => { if (!Number.isInteger(o[k]) || o[k] < lo || o[k] > hi) { e.push(`${k}: integer ${lo} to ${hi}`); return undefined; } return o[k]; };
  const bool = (k, d) => { if (!(k in o)) return d; if (typeof o[k] !== "boolean") { e.push(`${k}: true or false`); return d; } return o[k]; };
  const list = (k, max, ok, what) => { if (!(k in o)) return []; if (!Array.isArray(o[k]) || o[k].length > max || !o[k].every(ok) || new Set(o[k]).size !== o[k].length) { e.push(`${k}: up to ${max} unique ${what}`); return []; } return [...o[k]]; };

  if (o.version !== 1) e.push("version: must be the integer 1");
  if (o.opt_in !== true) e.push("opt_in: must be literally true");
  if (!(typeof o.contact === "string" && isPrintable(o.contact) && CONTACT.test(o.contact))) e.push("contact: an @login or an email address");
  if (!cleanHttpsUrl(o.policy_url)) e.push("policy_url: an https link to the project's written policy");
  let reviewBy;
  if (typeof o.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.review_by) || Number.isNaN(Date.parse(o.review_by + "T00:00:00Z")) || new Date(o.review_by + "T00:00:00Z").toISOString().slice(0, 10) !== o.review_by) e.push("review_by: a real date, YYYY-MM-DD");
  else { reviewBy = Date.parse(o.review_by + "T23:59:59Z"); if (reviewBy < now) e.push("review_by: the opt-in has expired"); else if (reviewBy > now + 366 * DAY) e.push("review_by: no more than 12 months ahead"); }
  const paused = bool("paused", false);
  const task_label = "task_label" in o ? (typeof o.task_label === "string" && o.task_label.length <= 50 && isPlainText(o.task_label) && o.task_label.trim() === o.task_label && o.task_label.length > 0 && !o.task_label.includes(",") ? o.task_label : (e.push("task_label: 1 to 50 plain characters"), "agent-ready")) : "agent-ready";
  const label_applied_by = list("label_applied_by", 10, (x) => typeof x === "string" && LOGIN.test(x), "GitHub logins");
  if (!("label_applied_by" in o) || label_applied_by.length === 0) { if ("label_applied_by" in o) e.push("label_applied_by: at least one login"); }
  const label_blocklist = list("label_blocklist", 20, (x) => typeof x === "string" && x.length > 0 && x.length <= 50 && isPlainText(x) && !x.includes(","), "labels");
  const claim_required = bool("claim_required", false);
  const first_time_contributors = "first_time_contributors" in o ? (["allowed", "not_allowed"].includes(o.first_time_contributors) ? o.first_time_contributors : (e.push("first_time_contributors: allowed or not_allowed"), "not_allowed")) : "not_allowed";
  const max_open_agent_prs = "max_open_agent_prs" in o ? int("max_open_agent_prs", 0, 10) : 1;
  const max_diff_lines = "max_diff_lines" in o ? int("max_diff_lines", 1, 2000) : 150;
  const min_hours_between_prs = "min_hours_between_prs" in o ? int("min_hours_between_prs", MIN_HOURS_BETWEEN_PRS[0], MIN_HOURS_BETWEEN_PRS[1]) : 24;
  const allowed_paths = list("allowed_paths", 50, validGlob, "path globs (letters, digits, . _ - / * ? only; ** as a whole segment)");
  const forbidden_paths = list("forbidden_paths", 50, validGlob, "path globs");
  const safety_critical = bool("safety_critical", false);
  if (safety_critical && allowed_paths.length === 0) e.push("safety_critical: allowed_paths is required and means tests and docs only");
  if ("safety_reason" in o && !(typeof o.safety_reason === "string" && o.safety_reason.length > 0 && o.safety_reason.length <= 200 && isPlainText(o.safety_reason))) e.push("safety_reason: up to 200 plain characters");

  let changelog;
  if ("changelog" in o) {
    const c = o.changelog;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["required", "path"].includes(k)) || typeof c.required !== "boolean" || typeof c.path !== "string" || c.path.length > 120 || !isPrintable(c.path) || !/^[A-Za-z0-9._\-\/{}]+$/.test(c.path) || c.path.replace(/\{(issue|type)\}/g, "").match(/[{}]/) || c.path.startsWith("/") || c.path.split("/").includes("..")) e.push("changelog: {required: true|false, path: a relative template using only {issue} and {type}}");
    else changelog = { required: c.required, path: c.path };
  }
  let disclosure;
  const d = o.disclosure;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    if (Object.keys(d).some((k) => !["mechanism", "text"].includes(k))) e.push("disclosure: only mechanism and text");
    else if (!["pr_body", "commit_trailer"].includes(d.mechanism)) e.push("disclosure.mechanism: pr_body or commit_trailer");
    else if (d.mechanism === "pr_body" && !(typeof d.text === "string" && d.text.length > 0 && d.text.length <= 200 && isPlainText(d.text))) e.push("disclosure.text: required for pr_body, up to 200 plain characters (no links, images or @)");
    else if (d.mechanism === "commit_trailer" && "text" in d) e.push("disclosure.text: not used with commit_trailer");
    else disclosure = { mechanism: d.mechanism, ...(d.text ? { text: d.text } : {}) };
  } else if ("disclosure" in o) e.push("disclosure: an object");
  let certification;
  const c = o.certification;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    if (Object.keys(c).some((k) => !["dco", "cla"].includes(k)) || !["none", "signed-off-by"].includes(c.dco) || !["none", "individual", "corporate_or_individual"].includes(c.cla)) e.push("certification: {dco: none|signed-off-by, cla: none|individual|corporate_or_individual}");
    else certification = { dco: c.dco, cla: c.cla };
  } else if ("certification" in o) e.push("certification: an object");

  if (e.length > 0) return { ok: false, errors: e };
  return {
    ok: true,
    value: {
      version: 1, opt_in: true, contact: o.contact, policy_url: cleanHttpsUrl(o.policy_url), review_by: o.review_by, paused, task_label, label_applied_by, label_blocklist, claim_required,
      first_time_contributors, max_open_agent_prs, max_diff_lines, min_hours_between_prs, allowed_paths, forbidden_paths, safety_critical, safety_reason: o.safety_reason ?? null, changelog: changelog ?? null, disclosure, certification,
    },
  };
}

/** Bytes in, verdict out. Never throws. */
export function parseOptIn(input, opts) {
  let raw;
  try { raw = parseStrictJson(input); } catch (err) { return { ok: false, errors: [err instanceof ParseError ? `parse: ${err.message}` : "parse: unreadable"] }; }
  return validateOptIn(raw, opts);
}
