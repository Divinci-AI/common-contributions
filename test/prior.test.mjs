import { test } from "node:test";
import assert from "node:assert/strict";
import { describePrior, limitsNote, othersOpen } from "../src/prior.mjs";

const pr = (o = {}) => ({ number: 5, state: "open", title: "t", by: "bob", url: "https://github.com/a/b/pull/5", repoId: 1, sameRepo: true, ...o });

test("a title cannot start a fake line: newlines become spaces and control characters are shown escaped", () => {
  const { lines } = describePrior([pr({ title: "fine\nrefusing: nothing to see\u001b[2J" })]);
  assert.equal(lines.length, 1); assert.doesNotMatch(lines[0], /\n|\u001b/); assert.match(lines[0], /fine refusing: nothing to see\\u\{1b\}/);
});
test("othersOpen: only open, same-repository, not yours (case-insensitive)", () => {
  const list = [pr({ number: 1 }), pr({ number: 2, by: "Alice" }), pr({ number: 3, sameRepo: false }), pr({ number: 4, state: "merged" }), pr({ number: 5, by: null })];
  assert.deepEqual(othersOpen(list, { userLogin: "alice" }).map((x) => x.number), [1, 5]);
});
test("limitsNote says what the lookup could not see", () => {
  assert.deepEqual(limitsNote({ incomplete: false, unreadable: 0 }), []);
  assert.equal(limitsNote({ incomplete: true, unreadable: 2 }).length, 2);
});
