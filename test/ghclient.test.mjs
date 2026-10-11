import { test } from "node:test";
import assert from "node:assert/strict";
import { createGh, ghRunner, GhError } from "../src/ghclient.mjs";
import { defaultWorld, fakeRunner } from "./fakegh.mjs";

const setup = (mod) => { const w = defaultWorld(); mod?.(w); return { w, gh: createGh(fakeRunner(w)) }; };

test("repo: shape is checked and the id, owner id and default branch come back", () => {
  const { gh } = setup();
  assert.deepEqual(gh.repo("acme/widgets"), { id: 1001, fullName: "acme/widgets", defaultBranch: "main", archived: false, disabled: false, fork: false, private: false, ownerId: 7, ownerLogin: "acme" });
});
test("repo: names that are not owner/name never reach the network", () => {
  const { w, gh } = setup();
  for (const bad of ["acme", "acme/widgets/x", "../x", "a b/c", "a/b?x=1", ""]) assert.throws(() => gh.repo(bad), /owner\/name/);
  assert.equal(w.calls.length, 0);
});
test("repo: a malformed answer is an error, not a default", () => {
  for (const mod of [(w) => delete w.repo.id, (w) => delete w.repo.owner, (w) => (w.repo.archived = "no"), (w) => (w.repo.default_branch = 5)]) {
    const { gh } = setup(mod); assert.throws(() => gh.repo("acme/widgets"), GhError);
  }
});
test("an HTTP error becomes a GhError carrying the status; non-JSON is an error", () => {
  const { gh } = setup((w) => (w.fail["/repos/acme"] = 403));
  assert.throws(() => gh.repo("acme/widgets"), (e) => e instanceof GhError && e.httpStatus === 403);
  const gh2 = createGh(() => ({ status: 0, stdout: "<html>", stderr: "" }));
  assert.throws(() => gh2.repo("acme/widgets"), /not JSON/);
  const gh3 = createGh(() => ({ status: 1, stdout: "", stderr: "boom" }));
  assert.throws(() => gh3.repo("acme/widgets"), (e) => e instanceof GhError && e.httpStatus === undefined);
});
test("branchHead and compare", () => {
  const { gh, w } = setup();
  assert.equal(gh.branchHead(1001, "main"), w.head);
  assert.equal(gh.compare(1001, "a".repeat(40), w.head).status, "ahead");
  const bad = setup((x) => (x.head = "nothex")).gh; assert.throws(() => bad.branchHead(1001, "main"), /bad commit sha/);
});
test("file: only a small base64 regular file is returned; absent is an error", () => {
  const ok = setup((w) => (w.optin = { content: '{"a":1}' })).gh.file(1001, ".github/agent-contributions.json", "x");
  assert.equal(ok.bytes.toString(), '{"a":1}'); assert.match(ok.blobSha, /^d+$/);
  for (const [name, optin, re] of [["symlink", { content: "x", type: "symlink" }, /symlink/], ["submodule", { content: "x", type: "submodule" }, /submodule/], ["too big", { content: "x", size: 20000 }, /too large/], ["not base64", { content: "x", encoding: "none" }, /encoding/]]) {
    assert.throws(() => setup((w) => (w.optin = optin)).gh.file(1001, "p", "x"), re, name);
  }
  assert.throws(() => setup().gh.file(1001, "p", "x"), (e) => e instanceof GhError && e.httpStatus === 404);
});
test("issue: shape, labels as names, pull requests flagged", () => {
  const { gh, w } = setup();
  const i = gh.issue(1001, 7); assert.deepEqual([i.number, i.state, i.labels, i.isPullRequest, i.authorId], [7, "open", ["agent-ready"], false, 21]);
  w.issue.pull_request = {}; assert.equal(gh.issue(1001, 7).isPullRequest, true);
  delete w.issue.user; assert.throws(() => gh.issue(1001, 7), GhError);
});
test("events: read in full; more than the page cap refuses", () => {
  const { gh, w } = setup();
  assert.equal(gh.issueEvents(1001, 7)[0].actorId, 11);
  w.events = Array.from({ length: 501 }, () => ({ event: "labeled", label: { name: "x" }, actor: { id: 1 }, created_at: "2026-01-01T00:00:00Z" }));
  assert.throws(() => gh.issueEvents(1001, 7), /too many issue events/);
});
test("pulls: truncation is reported so the caller can refuse", () => {
  const { gh, w } = setup();
  w.pulls = Array.from({ length: 499 }, (_, i) => ({ number: i, head: { ref: "agent/x", repo: { id: 5 }, sha: "a" }, user: { id: 1, login: "u" }, body: "" }));
  assert.equal(gh.openPulls(1001).truncated, false);
  w.pulls.push(...Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, head: { ref: "x" }, user: {}, body: "" })));
  assert.equal(gh.openPulls(1001).truncated, true);
});
test("user, lastCommit, lastEdit, search, mergedPrsBy", () => {
  const { gh, w } = setup();
  assert.deepEqual(gh.user("maintainer"), { id: 11, login: "maintainer", type: "User" });
  assert.throws(() => gh.user("nobody"), (e) => e.httpStatus === 404);
  assert.equal(gh.lastCommit(1001, "p", "main").authorLogin, "maintainer");
  assert.equal(gh.issueLastEdit("acme", "widgets", 7), null); w.lastEditedAt = "2026-09-04T00:00:00Z"; assert.equal(gh.issueLastEdit("acme", "widgets", 7), "2026-09-04T00:00:00Z");
  w.searchTotal = 3; assert.equal(gh.searchOpenAgentPrs("acme/widgets", "common-ai"), 3);
  w.closedIssuesByCreator.alice = [{ pull_request: { merged_at: "2026-01-01" } }, { pull_request: { merged_at: null } }, {}];
  assert.deepEqual(gh.mergedPrsBy(1001, "alice"), { merged: 1, truncated: false });
});
test("the real runner needs an absolute gh path and reduces the environment", () => {
  assert.throws(() => ghRunner("gh"), /absolute/);
  const r = ghRunner("/usr/bin/env");
  const out = r([]); // `env` with no args prints the environment gh would see
  assert.equal(out.status, 0);
  const names = out.stdout.split("\n").map((l) => l.split("=")[0]).filter(Boolean);
  assert.ok(names.every((n) => ["PATH", "HOME", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "PWD", "SHLVL", "_", "OLDPWD"].includes(n)), names.join());
});

test("a list endpoint that answers with an object is an error, not an empty list", () => {
  const gh = createGh(() => ({ status: 0, stdout: JSON.stringify({ message: "rate limited" }), stderr: "" }));
  assert.throws(() => gh.issueEvents(1, 2), /expected a list/);
  assert.throws(() => gh.openPulls(1), /expected a list/);
});
