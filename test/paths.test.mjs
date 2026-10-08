import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultStateDir } from "../src/paths.mjs";

const HOME = "/h";
const only = (...present) => (p) => present.includes(p);

test("an explicit COMMON_CONTRIBUTIONS_HOME always wins", () => {
  assert.equal(defaultStateDir({ env: { COMMON_CONTRIBUTIONS_HOME: "/x" }, home: HOME, exists: only("/h/.divinci/common-contributions") }), "/x");
});

test("a fresh install uses a neutral directory, honouring XDG_STATE_HOME", () => {
  assert.equal(defaultStateDir({ env: {}, home: HOME, exists: only() }), "/h/.local/state/common-ai");
  assert.equal(defaultStateDir({ env: { XDG_STATE_HOME: "/s" }, home: HOME, exists: only() }), "/s/common-ai");
});

test("an older install's directory is kept while the new one does not exist, so its ledger and STOP file are not abandoned", () => {
  assert.equal(defaultStateDir({ env: {}, home: HOME, exists: only("/h/.divinci/common-contributions") }), "/h/.divinci/common-contributions");
});

test("once the new directory exists it is used, even if the old one is still there", () => {
  const exists = only("/h/.divinci/common-contributions", "/h/.local/state/common-ai");
  assert.equal(defaultStateDir({ env: {}, home: HOME, exists }), "/h/.local/state/common-ai");
});

test("the default never mentions the company's directory for a fresh install", () => {
  assert.ok(!defaultStateDir({ env: {}, home: HOME, exists: only() }).includes("divinci"));
});
