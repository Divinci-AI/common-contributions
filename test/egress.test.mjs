import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedUrl, EgressDeniedError, hostOf, isAllowedHost, urlsIn } from "../src/egress.mjs";

const ALLOW = ["github.com", "*.githubusercontent.com", "127.0.0.1"];

test("exact hosts and *.suffix entries are allowed; nothing else", () => {
  assert.ok(isAllowedHost("github.com", ALLOW));
  assert.ok(isAllowedHost("raw.githubusercontent.com", ALLOW));
  assert.ok(isAllowedHost("127.0.0.1", ALLOW));
  assert.ok(!isAllowedHost("evil.com", ALLOW));
});

test("a lookalike host is not allowed (suffix tricks)", () => {
  assert.ok(!isAllowedHost("evilgithub.com", ALLOW));
  assert.ok(!isAllowedHost("github.com.evil.com", ALLOW));
  assert.ok(!isAllowedHost("githubusercontent.com", ALLOW), "the bare suffix is not covered by *.suffix");
  assert.ok(!isAllowedHost("xgithubusercontent.com", ALLOW));
});

test("a bare * entry allows nothing: an allowlist that allows everything is not one", () => {
  assert.ok(!isAllowedHost("anything.com", ["*"]));
});

test("unparseable URLs and empty hosts are refused", () => {
  assert.equal(hostOf("not a url"), null);
  assert.ok(!isAllowedHost(null, ALLOW));
  assert.throws(() => assertAllowedUrl("not a url", ALLOW), EgressDeniedError);
});

test("assertAllowedUrl returns the host when allowed and is case-insensitive", () => {
  assert.equal(assertAllowedUrl("https://GitHub.com/a/b", ALLOW), "github.com");
});

test("urlsIn finds every http(s) URL in text", () => {
  assert.deepEqual(urlsIn('see https://a.com/x and "http://b.org/y?q=1" end'), ["https://a.com/x", "http://b.org/y?q=1"]);
  assert.deepEqual(urlsIn("no links here"), []);
});

import { isReservedTestHost } from "../src/egress.mjs";

test("isReservedTestHost: documentation, test and loopback names only", () => {
  for (const ok of ["example.com", "www.example.org", "a.b.example.net", "foo.invalid", "thing.test", "localhost", "127.0.0.1", "::1", "[::1]", "my.example", "x.localhost"]) {
    assert.ok(isReservedTestHost(ok), ok);
  }
  for (const bad of ["evil.com", "example.com.evil.com", "notexample.com", "myexample.com", "example.co", "github.com", "invalid.com", "test.com", "", null, undefined]) {
    assert.ok(!isReservedTestHost(bad), String(bad));
  }
});
