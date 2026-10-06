import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { KillSwitch, StopRequestedError } from "../src/killswitch.mjs";
import { tmp } from "./helpers.mjs";

test("check() passes until the STOP file exists, then throws with the reason", () => {
  const k = new KillSwitch({ stateDir: tmp() });
  k.check();
  assert.throws(() => k.trip("because"), StopRequestedError);
  assert.ok(existsSync(k.file));
  assert.throws(() => k.check(), /because/);
});

test("the FIRST reason is kept; a later trip does not overwrite it", () => {
  const k = new KillSwitch({ stateDir: tmp() });
  assert.throws(() => k.trip("first cause"));
  assert.throws(() => k.trip("second cause"));
  assert.match(k.reason(), /first cause/);
  assert.doesNotMatch(k.reason(), /second cause/);
});

test("N consecutive failures trip it; a success resets the count", () => {
  const k = new KillSwitch({ stateDir: tmp(), maxConsecutiveFailures: 3 });
  k.noteFailure("a");
  k.noteFailure("b");
  k.noteSuccess();
  k.noteFailure("c");
  k.noteFailure("d");
  assert.equal(k.isStopped(), false);
  assert.throws(() => k.noteFailure("e"), StopRequestedError);
  assert.ok(k.isStopped());
});

test("a human clearing the file re-enables it; a second instance sees the same STOP", () => {
  const dir = tmp();
  const k = new KillSwitch({ stateDir: dir });
  assert.throws(() => k.trip("x"));
  assert.ok(new KillSwitch({ stateDir: dir }).isStopped());
  rmSync(k.file);
  assert.equal(new KillSwitch({ stateDir: dir }).isStopped(), false);
});
