import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CIRCUITS, LOCKED_EVENT, MAIN_EVENT, createPanel } from "../site/panel.js";

test("every circuit names what it stops, what happens when it trips, and how it works", () => {
  for (const c of CIRCUITS) {
    for (const k of ["id", "label", "rating", "stops", "event", "how"]) assert.ok(c[k] && c[k].length > 3, `${c.id}.${k}`);
  }
  assert.equal(new Set(CIRCUITS.map((c) => c.id)).size, CIRCUITS.length, "ids are unique");
});

test("a fresh panel is fully closed with no event", () => {
  const p = createPanel();
  assert.equal(p.trippedCount(), 0);
  assert.equal(p.isMainTripped(), false);
  assert.equal(p.lastEvent(), null);
});

test("clicking a circuit trips it and reports that circuit's own event", () => {
  const p = createPanel();
  const e = p.toggle("scope");
  assert.equal(e.kind, "trip");
  assert.equal(e.text, CIRCUITS.find((c) => c.id === "scope").event);
  assert.equal(p.isTripped("scope"), true);
  assert.equal(p.isTripped("spend"), false);
});

test("clicking again resets it, by a person", () => {
  const p = createPanel();
  p.toggle("egress");
  const e = p.toggle("egress");
  assert.equal(e.kind, "reset");
  assert.match(e.text, /reset by a person/);
  assert.equal(p.isTripped("egress"), false);
});

test("circuits trip independently", () => {
  const p = createPanel();
  p.toggle("spend"); p.toggle("branch");
  assert.equal(p.trippedCount(), 2);
  p.toggle("spend");
  assert.equal(p.isTripped("branch"), true);
  assert.equal(p.trippedCount(), 1);
});

test("the main kill switch opens every circuit and sets the main flag", () => {
  const p = createPanel();
  const e = p.killAll();
  assert.equal(e.text, MAIN_EVENT);
  assert.equal(p.trippedCount(), CIRCUITS.length);
  assert.equal(p.isMainTripped(), true);
});

test("while the main switch is open individual circuits are locked, and nothing changes", () => {
  const p = createPanel();
  p.killAll();
  const e = p.toggle("spend");
  assert.equal(e.kind, "locked");
  assert.equal(e.text, LOCKED_EVENT);
  assert.equal(p.isTripped("spend"), true, "it stays open");
  assert.equal(p.trippedCount(), CIRCUITS.length);
});

test("resetting the main switch closes everything again", () => {
  const p = createPanel();
  p.killAll();
  p.resetAll();
  assert.equal(p.trippedCount(), 0);
  assert.equal(p.isMainTripped(), false);
  assert.equal(p.toggle("spend").kind, "trip", "circuits work again");
});

test("an unknown circuit is an error, not a silent no-op", () => {
  const p = createPanel();
  assert.throws(() => p.toggle("nope"), /unknown circuit/);
  assert.throws(() => p.isTripped("nope"), /unknown circuit/);
});

test("the copy never promises more than the harness does", () => {
  const all = JSON.stringify(CIRCUITS) + MAIN_EVENT + LOCKED_EVENT;
  for (const bad of [/guarantee/i, /impossible/i, /100% safe/i, /unhackable/i, /always works/i]) assert.doesNotMatch(all, bad);
});

test("the page and the state machine agree on the circuit ids", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const inHtml = [...html.matchAll(/data-circuit="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(inHtml.sort(), CIRCUITS.map((c) => c.id).sort(), "index.html data-circuit ids == CIRCUITS ids");
});

test("every guard appears exactly once as a gate on the path schematic", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const gates = [...html.matchAll(/data-gate="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...gates].sort(), CIRCUITS.map((c) => c.id).sort());
});
