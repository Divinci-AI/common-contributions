import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Budget, BudgetExceededError, LOCAL_MODEL_PRICE } from "../src/budget.mjs";
import { tmp } from "./helpers.mjs";

const PRICES = { "cloud:m": { input: 1, output: 4 }, "local:m": LOCAL_MODEL_PRICE }; // USD per 1M tokens
const mk = (over = {}) => {
  const dir = tmp();
  const clock = { t: Date.UTC(2026, 9, 5, 12) };
  const b = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 1, maxUsdTotal: 2, prices: PRICES, now: () => clock.t, ...over });
  return { b, clock, dir };
};

test("a model with no listed price is refused: unknown price is not free", () => {
  const { b } = mk();
  assert.throws(() => b.reserve("mystery", 10, 10), BudgetExceededError);
});

test("reserve refuses a call whose WORST case would cross the daily cap, before it is made", () => {
  const { b } = mk();
  // 500k in * $1 + 150k out * $4 = $1.10 > $1.00/day
  assert.throws(() => b.reserve("cloud:m", 500_000, 150_000), /daily cap/);
});

test("reserve does not write to the ledger (only real spend is recorded)", () => {
  const { b } = mk();
  b.reserve("cloud:m", 1000, 1000);
  assert.equal(b.spent().total, 0);
});

test("record puts real spend on the ledger, and it survives a new Budget on the same file", () => {
  const { b, dir, clock } = mk();
  const usd = b.record("cloud:m", 100_000, 100_000); // $0.10 + $0.40
  assert.ok(Math.abs(usd - 0.5) < 1e-9);
  const again = new Budget({ ledgerFile: join(dir, "l.jsonl"), maxUsdPerDay: 1, maxUsdTotal: 2, prices: PRICES, now: () => clock.t });
  assert.ok(Math.abs(again.spent().total - 0.5) < 1e-9);
});

test("the daily cap resets at the UTC day boundary; the total cap does not", () => {
  const { b, clock } = mk();
  b.record("cloud:m", 200_000, 200_000); // $1.00 today
  assert.throws(() => b.reserve("cloud:m", 1000, 1000), /daily cap/);
  clock.t += 24 * 3600 * 1000;
  b.reserve("cloud:m", 1000, 1000); // new day: allowed
  b.record("cloud:m", 200_000, 200_000); // $1.00 more => total $2.00
  clock.t += 24 * 3600 * 1000;
  assert.throws(() => b.reserve("cloud:m", 1000, 1000), /total cap/);
});

test("a local model costs nothing and is never refused by the cap", () => {
  const { b } = mk({ maxUsdPerDay: 0, maxUsdTotal: 0 });
  for (let i = 0; i < 50; i++) b.reserve("local:m", 1_000_000, 1_000_000);
});

test("caps must be finite numbers >= 0", () => {
  for (const bad of [NaN, -1, Infinity, "3", undefined]) {
    assert.throws(() => mk({ maxUsdPerDay: bad }), /maxUsdPerDay/);
    assert.throws(() => mk({ maxUsdTotal: bad }), /maxUsdTotal/);
  }
});

test("recording is never refused, even when it pushes spend over the cap (it happened)", () => {
  const { b } = mk();
  b.record("cloud:m", 2_000_000, 2_000_000);
  assert.ok(b.spent().total > 2);
});
