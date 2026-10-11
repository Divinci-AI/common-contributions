/** Confirmations come from the controlling terminal, never argv or stdin: an agent in the same shell cannot type them by passing flags or piping input. */
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export function ttyAsk(prompt) {
  let fd;
  try { fd = openSync("/dev/tty", "r+"); } catch { throw new Error("no terminal available: publishing needs a person at a terminal (confirmations are read from /dev/tty)"); }
  try {
    writeSync(fd, prompt);
    const buf = Buffer.alloc(1); let line = "";
    while (readSync(fd, buf, 0, 1, null) === 1) { const c = buf.toString("utf8"); if (c === "\n") break; line += c; if (line.length > 2000) break; }
    return line.replace(/\r$/, "");
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
