import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeForTerminal } from "../src/tty.mjs";
const ch = (...c) => String.fromCharCode(...c);
test("hidden, control and bidi characters are made visible before printing; ordinary text is untouched", () => {
  assert.equal(escapeForTerminal("plain text\twith\nlines é 😀"), "plain text\twith\nlines é 😀");
  assert.equal(escapeForTerminal("a" + ch(0x1b) + "[31mb"), "a\\u{1b}[31mb");
  assert.equal(escapeForTerminal("x" + ch(0x202e) + "y"), "x\\u{202e}y");
  assert.equal(escapeForTerminal("x" + ch(0x200b) + ch(0xfeff) + ch(0x7) + ch(0x85)), "x\\u{200b}\\u{feff}\\u{7}\\u{85}");
  assert.equal(escapeForTerminal("cr\rhere"), "cr\\u{d}here");
});
