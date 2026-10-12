import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPTIN_KEYS, parseOptIn, parseStrictJson, validateOptIn, isPrintable, isPlainText, validGlob, globMatch, cleanHttpsUrl, MAX_BYTES } from "../src/optin.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const good = () => ({
  version: 1, opt_in: true, contact: "@maintainer", policy_url: "https://example.org/contributing/ai", review_by: "2027-04-01",
  label_applied_by: ["maintainer"], disclosure: { mechanism: "pr_body", text: "AI assistance: yes (tool: Common Contributions)" }, certification: { dco: "none", cla: "none" },
});
const check = (o) => parseOptIn(JSON.stringify(o), { now: NOW });
const refuses = (o, re) => { const r = check(o); assert.equal(r.ok, false, `should refuse: ${JSON.stringify(o).slice(0, 120)}`); if (re) assert.match(r.errors.join("; "), re); };
const ch = (...c) => String.fromCharCode(...c);

test("a minimal file passes and defaults are filled in", () => {
  const r = check(good());
  assert.equal(r.ok, true, r.errors?.join());
  assert.deepEqual([r.value.task_label, r.value.max_open_agent_prs, r.value.max_diff_lines, r.value.first_time_contributors, r.value.paused, r.value.claim_required], ["agent-ready", 1, 150, "not_allowed", false, false]);
  assert.equal(r.value.min_hours_between_prs, 24, "absent means 24");
});
test("a full file passes", () => {
  const r = check({ ...good(), paused: false, task_label: "agent ready", label_blocklist: ["good first issue", "Needs Triage"], claim_required: true, first_time_contributors: "allowed", max_open_agent_prs: 2, max_diff_lines: 300, min_hours_between_prs: 168,
    allowed_paths: ["tests/**", "docs/**", "src/*/fixtures/?.json"], forbidden_paths: [".github/**"], safety_critical: true, safety_reason: "mapping data used by responders",
    changelog: { required: true, path: "changelog/{issue}.{type}.rst" }, disclosure: { mechanism: "commit_trailer" }, certification: { dco: "signed-off-by", cla: "individual" } });
  assert.equal(r.ok, true, r.errors?.join());
});

// ---- opt-in semantics
const bad = {
  "label_blocklist entry with a comma": (o) => (o.label_blocklist = ["a,b"]), "label_blocklist entry with markup": (o) => (o.label_blocklist = ["<x>"]), "label_blocklist not a list": (o) => (o.label_blocklist = "x"),
  "absent opt_in": (o) => delete o.opt_in, "opt_in false": (o) => (o.opt_in = false), "opt_in the string true": (o) => (o.opt_in = "true"), "opt_in 1": (o) => (o.opt_in = 1),
  "version 2": (o) => (o.version = 2), "version as string": (o) => (o.version = "1"), "version 1.0 as float is a parse error elsewhere": (o) => (o.version = true),
  "unknown key": (o) => (o.extra = 1), "a command key": (o) => (o.test_command = "curl x | sh"),
  "missing contact": (o) => delete o.contact, "contact is a url": (o) => (o.contact = "https://x.org"), "contact with spaces": (o) => (o.contact = "a b"), "contact too long": (o) => (o.contact = "@" + "a".repeat(50)),
  "missing policy_url": (o) => delete o.policy_url, "http policy_url": (o) => (o.policy_url = "http://example.org/p"), "policy_url with credentials": (o) => (o.policy_url = "https://u:p@example.org/p"),
  "policy_url ip literal": (o) => (o.policy_url = "https://10.0.0.1/p"), "policy_url localhost": (o) => (o.policy_url = "https://localhost/p"), "policy_url with a port": (o) => (o.policy_url = "https://example.org:8443/p"), "policy_url file": (o) => (o.policy_url = "file:///etc/passwd"),
  "review_by missing": (o) => delete o.review_by, "review_by expired": (o) => (o.review_by = "2026-10-10"), "review_by two years out": (o) => (o.review_by = "2028-10-11"), "review_by 2099": (o) => (o.review_by = "2099-01-01"),
  "review_by not a date": (o) => (o.review_by = "2027-02-30"), "review_by wrong format": (o) => (o.review_by = "04/01/2027"),
  "label_applied_by missing": (o) => delete o.label_applied_by, "label_applied_by empty": (o) => (o.label_applied_by = []), "label_applied_by a bot": (o) => (o.label_applied_by = ["dependabot[bot]"]),
  "label_applied_by duplicate": (o) => (o.label_applied_by = ["a", "a"]), "label_applied_by too many": (o) => (o.label_applied_by = Array.from({ length: 11 }, (_, i) => "u" + i)), "label_applied_by not strings": (o) => (o.label_applied_by = [1]),
  "label_applied_by a bad login": (o) => (o.label_applied_by = ["-bad"]),
  "task_label with a comma": (o) => (o.task_label = "a,b"), "task_label with markup": (o) => (o.task_label = "<b>"), "task_label empty": (o) => (o.task_label = ""),
  "claim_required string": (o) => (o.claim_required = "yes"), "paused string": (o) => (o.paused = "false"), "first_time_contributors other": (o) => (o.first_time_contributors = "maybe"),
  "max_open_agent_prs 11": (o) => (o.max_open_agent_prs = 11), "max_open_agent_prs -1": (o) => (o.max_open_agent_prs = -1), "max_diff_lines 0": (o) => (o.max_diff_lines = 0), "max_diff_lines 2001": (o) => (o.max_diff_lines = 2001),
  "min_hours 5": (o) => (o.min_hours_between_prs = 5), "min_hours 0": (o) => (o.min_hours_between_prs = 0), "min_hours 721": (o) => (o.min_hours_between_prs = 721), "min_hours string": (o) => (o.min_hours_between_prs = "24"), "min_hours 7.5": (o) => (o.min_hours_between_prs = 7.5), "min_hours null": (o) => (o.min_hours_between_prs = null),
  "allowed_paths with ..": (o) => (o.allowed_paths = ["../x"]), "allowed_paths absolute": (o) => (o.allowed_paths = ["/etc/**"]), "allowed_paths with backslash": (o) => (o.allowed_paths = ["a\\b"]),
  "allowed_paths with **x": (o) => (o.allowed_paths = ["**x/a"]), "allowed_paths with brackets": (o) => (o.allowed_paths = ["[a-z]*"]), "allowed_paths with braces": (o) => (o.allowed_paths = ["{a,b}"]),
  "allowed_paths trailing slash": (o) => (o.allowed_paths = ["tests/"]), "allowed_paths double slash": (o) => (o.allowed_paths = ["a//b"]), "allowed_paths 51 entries": (o) => (o.allowed_paths = Array.from({ length: 51 }, (_, i) => "d" + i + "/**")),
  "forbidden_paths not a list": (o) => (o.forbidden_paths = "src/**"),
  "safety_critical without allowed_paths": (o) => (o.safety_critical = true), "safety_critical not boolean": (o) => (o.safety_critical = "true"),
  "safety_reason with a link": (o) => (o.safety_reason = "see https://x.org"), "safety_reason with markup": (o) => (o.safety_reason = "<img src=x>"),
  "changelog extra key": (o) => (o.changelog = { required: true, path: "c/{issue}.rst", cmd: "x" }), "changelog path ..": (o) => (o.changelog = { required: true, path: "../x/{issue}.rst" }), "changelog unknown placeholder": (o) => (o.changelog = { required: true, path: "c/{secret}.rst" }),
  "changelog absolute": (o) => (o.changelog = { required: true, path: "/c/{issue}.rst" }),
  "disclosure missing": (o) => delete o.disclosure, "disclosure mechanism other": (o) => (o.disclosure = { mechanism: "assistance_level", text: "x" }), "disclosure pr_body without text": (o) => (o.disclosure = { mechanism: "pr_body" }),
  "disclosure text with a link": (o) => (o.disclosure = { mechanism: "pr_body", text: "see https://x.org" }), "disclosure text with an image": (o) => (o.disclosure = { mechanism: "pr_body", text: "![x](y)" }),
  "disclosure text with a mention": (o) => (o.disclosure = { mechanism: "pr_body", text: "thanks @someone" }), "disclosure text too long": (o) => (o.disclosure = { mechanism: "pr_body", text: "a".repeat(201) }),
  "disclosure trailer with text": (o) => (o.disclosure = { mechanism: "commit_trailer", text: "x" }), "disclosure extra key": (o) => (o.disclosure = { mechanism: "commit_trailer", trailer: "Co-authored-by" }),
  "certification missing": (o) => delete o.certification, "certification dco other": (o) => (o.certification = { dco: "yes", cla: "none" }), "certification cla other": (o) => (o.certification = { dco: "none", cla: "corporate" }), "certification extra": (o) => (o.certification = { dco: "none", cla: "none", x: 1 }),
};
for (const [name, fn] of Object.entries(bad)) test(`refused: ${name}`, () => { const o = good(); fn(o); refuses(o); });

// ---- hidden text and unicode
test("hidden and control characters are refused in every string field", () => {
  for (const c of [ch(0x202e), ch(0x200b), ch(0x2066), ch(0xfeff), ch(0x0007), ch(0x0085), ch(0x2028), ch(0x00ad)]) {
    for (const f of [(o, v) => (o.disclosure.text = "AI" + v + "yes"), (o, v) => (o.safety_reason = "r" + v), (o, v) => (o.task_label = "a" + v + "b"), (o, v) => (o.contact = "@a" + v)]) {
      const o = good(); f(o, c); if (o.safety_reason) { o.safety_critical = true; o.allowed_paths = ["tests/**"]; } refuses(o);
    }
  }
});
test("non-NFC text is refused", () => { const o = good(); o.disclosure.text = "cafe" + ch(0x0301); refuses(o); assert.equal(isPrintable("caf" + ch(0xe9)), true); });

// ---- the parser itself
const raw = (s, opts) => parseOptIn(s, { now: NOW, ...opts });
const base = JSON.stringify(good());
test("parse errors refuse and never throw", () => {
  for (const s of ["", "{", "[]", "null", "42", '"x"', base + " x", base + "{}", "{'a':1}", '{"a":1,}', '{"a":NaN}', '{"a":Infinity}', '{"a":1.5}', '{"a":1e3}', '{"a":01}', '{"a":-}', '{"a":"\\x"}', '{"a":"\\u12"}', '{"a":"tab\there"}', '{"a" 1}', '{"a":1 "b":2}', '// c\n{}', '{"a":1}\n/* c */']) {
    const r = raw(s); assert.equal(r.ok, false, JSON.stringify(s)); assert.ok(r.errors.length > 0);
  }
});
test("duplicate keys refuse, including after unescaping", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate/);
  assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), /duplicate/);
  assert.throws(() => parseStrictJson('{"a":{"b":1,"b":2}}'), /duplicate/);
});
test("__proto__ and constructor cannot bypass the unknown-key check", () => {
  for (const k of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) { const r = raw(base.replace("{", `{"${k}":{"x":1},`)); assert.equal(r.ok, false, k); assert.match(r.errors.join(), /unknown key/); }
  assert.equal({}.polluted, undefined);
});
test("a BOM, invalid UTF-8, lone surrogates, deep nesting and oversize files are refused", () => {
  assert.equal(raw(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(base)])).ok, false);
  assert.equal(raw(Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])).ok, false);
  // Invalid UTF-8 inside an otherwise VALID file must refuse (with lenient decoding it would become U+FFFD and be accepted).
  const withBad = Buffer.concat([Buffer.from(base.replace("AI assistance: yes (tool: Common Contributions)", "AI assistance XX")).subarray(0, 0), Buffer.from(base.slice(0, base.indexOf("AI assistance"))), Buffer.from("AI "), Buffer.from([0xff]), Buffer.from(base.slice(base.indexOf(" (tool"))) ]);
  assert.equal(raw(base).ok, true); assert.equal(raw(withBad).ok, false);
  assert.throws(() => parseStrictJson('{"a":"\\ud800"}'), /surrogate/);
  assert.throws(() => parseStrictJson('{"\\udc00":1}'), /surrogate/);
  assert.throws(() => parseStrictJson('{"a":{"b":{"c":{"d":1}}}}'), /deeply/);
  assert.throws(() => parseStrictJson('{"a":[[[[1]]]]}'), /deeply/);
  assert.throws(() => parseStrictJson(" ".repeat(MAX_BYTES) + "{}"), /bytes/);
  assert.throws(() => parseStrictJson('{"a":1e5}'), /integers/);
  assert.throws(() => parseStrictJson('{"a":99999999999999999999}'), /range/);
});
test("a valid surrogate pair is fine", () => assert.equal(parseStrictJson('{"a":"\\ud83d\\ude00"}').a.length, 2));

// ---- globs and helpers
test("glob matching: * and ? stay in a segment, ** spans segments, case-sensitive", () => {
  const m = (p, s) => globMatch(p, s);
  assert.ok(m("tests/**", "tests/a.py")); assert.ok(m("tests/**", "tests/a/b/c.py")); assert.ok(m("**/a.py", "a.py")); assert.ok(m("**/a.py", "x/y/a.py"));
  assert.ok(m("src/*.ts", "src/a.ts")); assert.ok(!m("src/*.ts", "src/a/b.ts")); assert.ok(m("a?c", "abc")); assert.ok(!m("a?c", "a/c")); assert.ok(!m("tests/**", "src/tests/a.py"));
  assert.ok(!m("Tests/**", "tests/a.py"), "case-sensitive"); assert.ok(m("*", "a")); assert.ok(!m("*", "a/b")); assert.ok(m("**", "a/b/c")); assert.ok(m("a/**/b", "a/b")); assert.ok(m("a/**/b", "a/x/y/b"));
});
test("a pathological glob does not blow up (linear-time matcher)", () => {
  const t = Date.now();
  globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(5000));
  globMatch("**/**/**/**/**/**/**/x", "a/".repeat(500) + "y");
  assert.ok(Date.now() - t < 2000);
});
test("validGlob", () => { for (const g of ["a/**", "*.md", "docs/?x"]) assert.equal(validGlob(g), true, g); for (const g of ["", "/a", "a/", "../a", "a/../b", "a b", "a\\b", "[a]", "a//b", "**a"]) assert.equal(validGlob(g), false, g); });
test("cleanHttpsUrl and text helpers", () => {
  assert.ok(cleanHttpsUrl("https://docs.example.org/a?b=1")); assert.equal(cleanHttpsUrl("http://example.org"), null); assert.equal(cleanHttpsUrl("https://example.org:444/"), null);
  assert.equal(isPlainText("AI assistance: yes"), true); for (const t of ["a@b", "<b>x</b>", "`x`", "[x](y)", "http://x", "www.x.org", "a\\b"]) assert.equal(isPlainText(t), false, t);
});
test("validateOptIn is pure data in, verdict out: it never executes or fetches anything", () => {
  const o = good(); o.policy_url = "https://example.org/p"; const before = JSON.stringify(o);
  validateOptIn(o, { now: NOW }); assert.equal(JSON.stringify(o), before);
});

test("the spec document lists exactly the keys the validator accepts (no drift)", () => {
  const doc = readFileSync(new URL("../docs/opt-in-spec.md", import.meta.url), "utf8");
  const table = doc.split("## Fields")[1].split("## What the tool will never do")[0];
  const documented = [...table.matchAll(/^\| `([a-z_]+)`(?: \/ `([a-z_]+)`)? \|/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean).sort();
  assert.deepEqual(documented, [...OPTIN_KEYS].sort());
});
