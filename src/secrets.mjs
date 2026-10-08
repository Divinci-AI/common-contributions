/**
 * Secret hygiene for a steered agent: (1) it must not START with secrets, (2) it must not EMIT them.
 * Findings carry the KIND and position only — never the matched text — so a scan can never copy a secret into a log.
 */
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["api-key-sk", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
];

export function scanForSecrets(text) {
  const findings = [];
  const s = String(text ?? "");
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(s);
    if (m) findings.push({ kind, index: m.index });
  }
  return findings;
}

/** Shannon entropy in bits per character. */
function entropy(token) {
  const counts = new Map();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / token.length) * Math.log2(n / token.length);
  return h;
}

const KEYWORD_BEFORE = /(?:key|token|secret|passw(?:or)?d|auth|credential)[^\n]{0,40}$/i;
const HEX_ONLY = /^[0-9a-f]+$/i;

/**
 * Secrets that have no fixed prefix: long random-looking strings. Only tokens that were NOT already in `baseline` count, so a
 * project's existing hashes and fixtures never trip the kill switch; only what the agent ADDED does.
 * A token needs 32+ chars, a digit AND a letter, and >= 4.2 bits per character. Pure hex tops out at 4.0 bits, so a hex string
 * is flagged only when a key/token/secret/password word sits just before it on the same line. base64 data URIs are skipped.
 * Findings carry the kind and position only, never the text.
 */
export function scanAddedForEntropy(text, baseline = "") {
  const s = String(text ?? "");
  const known = new Set(String(baseline ?? "").match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []);
  const findings = [];
  const re = /[A-Za-z0-9+/_=-]{32,}/g;
  for (let m; (m = re.exec(s)); ) {
    const tok = m[0];
    if (known.has(tok)) continue;
    if (!/\d/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
    if (/base64,$/.test(s.slice(Math.max(0, m.index - 7), m.index))) continue; // an embedded image, not a credential
    if (HEX_ONLY.test(tok)) {
      const lineStart = s.lastIndexOf("\n", m.index) + 1;
      if (KEYWORD_BEFORE.test(s.slice(lineStart, m.index))) findings.push({ kind: "high-entropy-token", index: m.index });
      continue;
    }
    if (entropy(tok) >= 4.2) findings.push({ kind: "high-entropy-token", index: m.index });
  }
  return findings;
}

/** The only environment variables a sandboxed run may see. Everything else is dropped — an allowlist, not a denylist. */
export const SAFE_ENV_NAMES = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SHELL", "USER", "NODE_ENV"]);

/**
 * Environment for the sandboxed process. HOME is replaced so credentials files under the real home are not found.
 * `extra` is for the few explicit values the task needs (e.g. an Ollama host) and is itself scanned.
 */
export function buildSandboxEnv(env, { home, extra = {} }) {
  const out = {};
  for (const name of SAFE_ENV_NAMES) if (typeof env[name] === "string") out[name] = env[name];
  out.HOME = home;
  for (const [k, v] of Object.entries(extra)) {
    if (scanForSecrets(v).length > 0) throw new Error(`refusing to pass "${k}" into the sandbox: its value looks like a secret`);
    out[k] = v;
  }
  return out;
}
