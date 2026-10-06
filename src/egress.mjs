/** Egress allowlist: the agent may reach git over https and its own model endpoint, and nothing else. */
export class EgressDeniedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "EgressDeniedError";
    this.details = details;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Exact host or a "*.suffix" entry. No bare "*": an allowlist that allows everything is not one. */
export function isAllowedHost(host, allowlist) {
  if (!host) return false;
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e === "*") return false;
    if (e.startsWith("*.")) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
    return host === e;
  });
}

export function assertAllowedUrl(url, allowlist) {
  const host = hostOf(url);
  if (!isAllowedHost(host, allowlist)) {
    throw new EgressDeniedError(`egress to "${host ?? url}" is not on the allowlist`, { host });
  }
  return host;
}

/** Every http(s) URL mentioned in a piece of text (a model's output or a command line). */
export function urlsIn(text) {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)].map((m) => m[0]);
}

/**
 * Hosts that cannot reach anyone: IANA-reserved documentation and test names (RFC 2606 / RFC 6761) and loopback.
 * A test fixture that says `https://example.com/logo.png` is not a network call. Used ONLY for URLs that merely APPEAR in
 * an agent's output — never to widen what the agent's own fetch may reach (that stays the allowlist, strictly).
 */
export function isReservedTestHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/(^|\.)example\.(com|org|net)$/.test(h)) return true;
  return /\.(example|invalid|test|localhost)$/.test(h) || h === "example" || h === "invalid" || h === "test";
}
