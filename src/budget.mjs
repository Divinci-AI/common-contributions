/**
 * Spend cap that actually stops the agent.
 *
 * A provider that has no per-key hard limit (Workers AI) cannot be trusted to refuse, so the cap lives here: every
 * model call is RESERVED before it is made (worst-case cost), and refused if it would cross a cap; the real cost is
 * recorded after. The ledger is an append-only JSONL file, so a crash or a second process cannot forget past spend.
 *
 * A reservation is also a HOLD, written to a sidecar file under a lock, so a second process sees headroom the first has
 * already claimed. Without that, two runners could each be told "there is room" and together overspend. A hold is freed by
 * record() (the real cost replaces it), by release() (the call failed), or when it expires.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export class BudgetExceededError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BudgetExceededError";
    this.details = details;
  }
}

/** USD per 1M tokens: { input, output }. A model not in the table is REFUSED — unknown price is not "free". */
export const LOCAL_MODEL_PRICE = Object.freeze({ input: 0, output: 0 });

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Budget {
  #file;
  #holdsFile;
  #lockDir;
  #holdTtlMs;
  #caps;
  #prices;
  #now;
  #mine = []; // hold ids this instance has not yet settled, oldest first

  /**
   * @param {{ ledgerFile: string, maxUsdPerDay: number, maxUsdTotal: number, prices: Record<string,{input:number,output:number}>, now?: () => number }} o
   */
  constructor({ ledgerFile, maxUsdPerDay, maxUsdTotal, prices, now = Date.now, holdTtlMs = 10 * 60 * 1000 }) {
    for (const [k, v] of Object.entries({ maxUsdPerDay, maxUsdTotal })) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${k} must be a finite number >= 0`);
    }
    this.#file = ledgerFile;
    this.#holdsFile = `${ledgerFile}.holds`;
    this.#lockDir = `${ledgerFile}.lock`;
    this.#holdTtlMs = holdTtlMs;
    this.#caps = { maxUsdPerDay, maxUsdTotal };
    this.#prices = prices;
    this.#now = now;
    mkdirSync(dirname(ledgerFile), { recursive: true });
  }

  #entries() {
    if (!existsSync(this.#file)) return [];
    return readFileSync(this.#file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  spent() {
    const today = utcDay(this.#now());
    let total = 0;
    let day = 0;
    for (const e of this.#entries()) {
      total += e.usd;
      if (e.day === today) day += e.usd;
    }
    return { total, day };
  }

  priceFor(model) {
    const p = this.#prices[model];
    if (!p) throw new BudgetExceededError(`no price for model "${model}"; refusing (unknown price is not free)`, { model });
    return p;
  }

  /** Worst-case cost of a call, in USD. */
  estimate(model, maxInputTokens, maxOutputTokens) {
    const p = this.priceFor(model);
    return (maxInputTokens * p.input + maxOutputTokens * p.output) / 1_000_000;
  }

  #withLock(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        mkdirSync(this.#lockDir);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(this.#lockDir).mtimeMs > 5000) rmdirSync(this.#lockDir); // a crashed holder
        } catch {
          /* it was released between our two calls: just try again */
        }
        if (Date.now() > deadline) throw new Error("could not take the budget lock within 5s; refusing rather than risk a double spend");
        sleepMs(5);
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(this.#lockDir);
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Holds that still count: not released and not expired. A hold whose process has died is deliberately KEPT until it expires:
   * it died between reserving and recording, so the call may have been made and cost money nobody wrote down. Counting it is the
   * conservative direction for a spend cap. After the TTL the possible spend is forgotten; that is a documented limit.
   */
  #openHolds() {
    if (!existsSync(this.#holdsFile)) return [];
    const open = new Map();
    for (const line of readFileSync(this.#holdsFile, "utf8").split("\n").filter(Boolean)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash
      }
      if (e.release) open.delete(e.release);
      else open.set(e.id, e);
    }
    const now = this.#now();
    return [...open.values()].filter((h) => now - h.at < this.#holdTtlMs);
  }

  /**
   * Reserve the worst case as a HOLD, atomically with the cap check. Throws BudgetExceededError if it could cross either cap.
   * Call BEFORE the model call, then record() or release() with the returned id.
   */
  reserveHold(model, maxInputTokens, maxOutputTokens) {
    const worst = this.estimate(model, maxInputTokens, maxOutputTokens);
    return this.#withLock(() => {
      const { total, day } = this.spent();
      const today = utcDay(this.#now());
      let heldTotal = 0;
      let heldDay = 0;
      for (const h of this.#openHolds()) {
        heldTotal += h.usd;
        if (h.day === today) heldDay += h.usd;
      }
      if (day + heldDay + worst > this.#caps.maxUsdPerDay + 1e-12) {
        throw new BudgetExceededError("daily cap would be exceeded", { cap: this.#caps.maxUsdPerDay, spent: day, held: heldDay, worst });
      }
      if (total + heldTotal + worst > this.#caps.maxUsdTotal + 1e-12) {
        throw new BudgetExceededError("total cap would be exceeded", { cap: this.#caps.maxUsdTotal, spent: total, held: heldTotal, worst });
      }
      const at = this.#now();
      const id = randomUUID();
      appendFileSync(this.#holdsFile, JSON.stringify({ id, at, day: utcDay(at), usd: worst, pid: process.pid }) + "\n");
      this.#mine.push(id);
      return { id, worst };
    });
  }

  /** Same as reserveHold, returning only the worst-case cost. The hold is settled by the next record() or release(). */
  reserve(model, maxInputTokens, maxOutputTokens) {
    return this.reserveHold(model, maxInputTokens, maxOutputTokens).worst;
  }

  /** The call did not happen (or failed before spending): free its hold. With no id, frees this instance's oldest. */
  release(holdId = this.#mine[0]) {
    if (!holdId) return;
    this.#mine = this.#mine.filter((id) => id !== holdId);
    appendFileSync(this.#holdsFile, JSON.stringify({ release: holdId }) + "\n");
  }

  /** Record the REAL cost of a finished call and free its hold. Recording is never refused: spend that happened must be on the ledger. */
  record(model, inputTokens, outputTokens, holdId) {
    const usd = this.estimate(model, inputTokens, outputTokens);
    const at = this.#now();
    appendFileSync(this.#file, JSON.stringify({ at, day: utcDay(at), model, inputTokens, outputTokens, usd }) + "\n");
    this.release(holdId);
    return usd;
  }
}
