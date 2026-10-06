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
