import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { STATUSES, spliceStatus } from "../scripts/render-status.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const { rows } = JSON.parse(read("status.json"));

test("the status table on the page is exactly what status.json renders (no drift)", () => {
  const html = read("site/harness/index.html");
  assert.equal(spliceStatus(html, rows), html, "run `npm run render-status`");
});

test("every row has a known status and a piece name", () => {
  for (const r of rows) {
    assert.ok(STATUSES[r.status], `unknown status for "${r.piece}"`);
    assert.ok(r.piece && r.detail, "piece and detail are required");
  }
  assert.equal(new Set(rows.map((r) => r.piece)).size, rows.length, "piece names are unique");
});

test("a 'built' or 'mock-tested' row names modules that exist and tests that exist and mention each module", () => {
  for (const r of rows.filter((x) => ["built", "partly-built", "mock-tested"].includes(x.status))) {
    assert.ok(r.modules?.length, `"${r.piece}" claims ${r.status} but names no module`);
    assert.ok(r.tests?.length, `"${r.piece}" claims ${r.status} but names no test`);
    for (const m of r.modules) assert.ok(existsSync(new URL(m, root)), `${m} does not exist`);
    const testSource = r.tests.map((t) => {
      assert.ok(existsSync(new URL(t, root)), `${t} does not exist`);
      return read(t);
    }).join("\n");
    for (const m of r.modules) {
      const name = basename(m).replace(/\.mjs$/, "");
      assert.ok(testSource.includes(name), `no listed test mentions "${name}" for "${r.piece}"`);
    }
  }
});

test("a row that is not built does not point at a module (it would be claiming something exists)", () => {
  for (const r of rows.filter((x) => !["built", "partly-built", "mock-tested"].includes(x.status))) {
    assert.ok(!r.modules?.length, `"${r.piece}" is ${r.status} but lists modules`);
  }
});

test("the homepage does not claim to have built what status.json says is not built", () => {
  const home = read("site/index.html");
  const notBuilt = rows.filter((r) => r.status === "not-built").map((r) => r.piece);
  assert.ok(notBuilt.length > 0);
  assert.ok(/Not built/.test(home) && /installer/i.test(home), "the 'where we are' card lists what is not built");
});

const piece = (name) => rows.find((r) => r.piece === name);

test("llms.txt, agent.json and the machine note agree with status.json about the hosted model adapter", () => {
  const hosted = piece("Hosted model, capped API key");
  assert.ok(hosted, "row exists");
  const llms = read("site/llms.txt");
  const [exists, doesNot = ""] = llms.split(/^## What does not exist$/m);
  const agent = JSON.parse(read("site/agent.json"));
  const note = read("site/harness/index.html").match(/what_does_not: .*/)?.[0] ?? "";
  const claimsNotBuilt = [doesNot, agent.does_not_exist.join(" "), note].some((t) => /hosted/i.test(t));
  assert.equal(claimsNotBuilt, hosted.status === "not-built", "a surface lists the hosted adapter on the wrong side of status.json");
  assert.equal(/hosted/i.test(exists) || agent.exists.some((e) => /hosted/i.test(e)), hosted.status !== "not-built");
});

test("no page or README hard-codes a test count (it drifts; the suite is the evidence)", () => {
  for (const f of ["README.md", "site/index.html", "site/harness/index.html", "site/report/index.html", "site/llms.txt"]) {
    assert.ok(!/\b\d{2,4} tests\b/i.test(read(f)), `${f} hard-codes a test count`);
  }
});

test("the egress wording does not claim more than the check does", () => {
  for (const f of ["site/harness/index.html", "site/panel.js"]) {
    assert.ok(!/Only the model endpoint and git are reachable/.test(read(f)), `${f} says the network is restricted, but only the harness's own requests are checked`);
  }
});

test("no surface still says the design relies on the agent returning text (a container runner exists)", () => {
  for (const f of ["status.json", "site/harness/index.html", "README.md", "site/index.html", "site/llms.txt"]) {
    assert.ok(!/relies on the agent returning text|depends on the agent returning text|No OS-level sandbox/i.test(read(f)), `${f} has the stale sandbox claim`);
  }
});

test("every surface agrees with status.json about the container verifier", () => {
  const row = rows.find((r) => r.piece === "Container verifier");
  assert.ok(row, "row exists");
  const built = row.status === "built";
  const llms = read("site/llms.txt");
  const [exists, doesNot = ""] = llms.split(/^## What does not exist$/m);
  const agent = JSON.parse(read("site/agent.json"));
  const note = read("site/harness/index.html");
  const noteExists = note.match(/what_exists: .*/)?.[0] ?? "", noteNot = note.match(/what_does_not: .*/)?.[0] ?? "";
  const mentionsNot = [doesNot, agent.does_not_exist.join(" "), noteNot, read("site/index.html").match(/Not built<\/b>.*/)?.[0] ?? ""].some((t) => /sandbox|container/i.test(t));
  const mentionsYes = /container/i.test(exists) || agent.exists.some((e) => /container/i.test(e)) || /container/i.test(noteExists);
  assert.equal(mentionsNot, !built, "a surface lists the container verifier on the wrong side");
  assert.equal(mentionsYes, built);
  if (built) assert.ok(/macOS/.test(row.detail) && /home folder/.test(row.detail) && /allow-host-execution/.test(row.detail), "the row keeps its limits: one runtime, what an escape reaches, the host flag");
});
