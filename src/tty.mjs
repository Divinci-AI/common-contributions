/**
 * Confirmations come from the controlling terminal, never argv or stdin, so they are not typed by passing a flag or piping input. This deters a hurried
 * human and an agent that only has a pipe; it does NOT stop a local program that opens its own pseudo-terminal (script, expect, pty), and an agent with
 * your gh login could call the GitHub API directly. Say so wherever the control is described.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export const decodeLine = (bytes) => Buffer.from(bytes).toString("utf8").replace(/\r$/, "");

export function ttyAsk(prompt) {
  let fd;
  try { fd = openSync("/dev/tty", "r+"); } catch { throw new Error("no terminal available: publishing needs a person at a terminal (confirmations are read from /dev/tty)"); }
  try {
    writeSync(fd, prompt);
    const buf = Buffer.alloc(1); const bytes = [];
    while (readSync(fd, buf, 0, 1, null) === 1) { if (buf[0] === 10) break; bytes.push(buf[0]); if (bytes.length > 8000) break; }
    return decodeLine(bytes);
  } finally { closeSync(fd); }
}

/** Make every control, bidi and zero-width character VISIBLE before printing text that came from a repository. */
export function escapeForTerminal(s) {
  return [...String(s)].map((ch) => {
    const c = ch.codePointAt(0);
    const hidden = (c < 0x20 && c !== 9 && c !== 10) || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb) || c === 0x1b;
    return hidden ? `\\u{${c.toString(16)}}` : ch;
  }).join("");
}
