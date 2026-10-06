/**
 * Spend cap that actually stops the agent.
 *
 * A provider that has no per-key hard limit (Workers AI) cannot be trusted to refuse, so the cap lives here: every
 * model call is RESERVED before it is made (worst-case cost), and refused if it would cross a cap; the real cost is
 * recorded after. The ledger is an append-only JSONL file, so a crash or a second process cannot forget past spend.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

export class Budget {
  #file;
  #caps;
  #prices;
  #now;

  /**
   * @param {{ ledgerFile: string, maxUsdPerDay: number, maxUsdTotal: number, prices: Record<string,{input:number,output:number}>, now?: () => number }} o
   */
  constructor({ ledgerFile, maxUsdPerDay, maxUsdTotal, prices, now = Date.now }) {
    for (const [k, v] of Object.entries({ maxUsdPerDay, maxUsdTotal })) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${k} must be a finite number >= 0`);
    }
    this.#file = ledgerFile;
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

  /** Throws BudgetExceededError if a call of this worst-case size could cross either cap. Call BEFORE the model call. */
  reserve(model, maxInputTokens, maxOutputTokens) {
    const worst = this.estimate(model, maxInputTokens, maxOutputTokens);
    const { total, day } = this.spent();
    if (day + worst > this.#caps.maxUsdPerDay + 1e-12) {
      throw new BudgetExceededError("daily cap would be exceeded", { cap: this.#caps.maxUsdPerDay, spent: day, worst });
    }
    if (total + worst > this.#caps.maxUsdTotal + 1e-12) {
      throw new BudgetExceededError("total cap would be exceeded", { cap: this.#caps.maxUsdTotal, spent: total, worst });
    }
    return worst;
  }

  /** Record the REAL cost of a finished call. Recording is never refused: spend that happened must be on the ledger. */
  record(model, inputTokens, outputTokens) {
    const usd = this.estimate(model, inputTokens, outputTokens);
    const at = this.#now();
    appendFileSync(this.#file, JSON.stringify({ at, day: utcDay(at), model, inputTokens, outputTokens, usd }) + "\n");
    return usd;
  }
}
