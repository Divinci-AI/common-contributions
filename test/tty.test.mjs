import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeForTerminal, decodeLine } from "../src/tty.mjs";
const ch = (...c) => String.fromCharCode(...c);
test("hidden, control and bidi characters are made visible before printing; ordinary text is untouched", () => {
  assert.equal(escapeForTerminal("plain text\twith\nlines é 😀"), "plain text\twith\nlines é 😀");
  assert.equal(escapeForTerminal("a" + ch(0x1b) + "[31mb"), "a\\u{1b}[31mb");
  assert.equal(escapeForTerminal("x" + ch(0x202e) + "y"), "x\\u{202e}y");
  assert.equal(escapeForTerminal("x" + ch(0x200b) + ch(0xfeff) + ch(0x7) + ch(0x85)), "x\\u{200b}\\u{feff}\\u{7}\\u{85}");
  assert.equal(escapeForTerminal("cr\rhere"), "cr\\u{d}here");
});

test("a typed line is decoded as UTF-8 as a whole, so accented and CJK text survives", () => {
  assert.equal(decodeLine(Buffer.from("I read it, voilà — 日本語 for issue 7", "utf8")), "I read it, voilà — 日本語 for issue 7");
  assert.equal(decodeLine(Buffer.from("text\r")), "text");
});
