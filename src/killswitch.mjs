/**
 * Kill switch: a file, checked before every model call and every git action. It is local on purpose — no central
 * switch, no dependency on us. Anything can trip it; only a human clears it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class StopRequestedError extends Error {
  constructor(reason) {
    super(`STOP: ${reason}`);
    this.name = "StopRequestedError";
    this.reason = reason;
  }
}

export class KillSwitch {
  #file;
  #maxConsecutiveFailures;
  #failures = 0;

  constructor({ stateDir, maxConsecutiveFailures = 3 }) {
    mkdirSync(stateDir, { recursive: true });
    this.#file = join(stateDir, "STOP");
    this.#maxConsecutiveFailures = maxConsecutiveFailures;
  }

  get file() {
    return this.#file;
  }

  isStopped() {
    return existsSync(this.#file);
  }

  reason() {
    return this.isStopped() ? readFileSync(this.#file, "utf8").trim() : null;
  }

  /** Throws StopRequestedError when stopped. Call before every model call and every git action. */
  check() {
    if (this.isStopped()) throw new StopRequestedError(this.reason() || "STOP file present");
  }

  trip(reason) {
    // Never clobber an earlier reason: the first cause is the useful one.
    if (!this.isStopped()) writeFileSync(this.#file, `${new Date().toISOString()} ${reason}\n`, { flag: "wx" });
    throw new StopRequestedError(reason);
  }

  /** Count a failed step; trips after N in a row. A success resets the count. */
  noteFailure(what) {
    this.#failures += 1;
    if (this.#failures >= this.#maxConsecutiveFailures) {
      this.trip(`${this.#failures} consecutive failures (last: ${what})`);
    }
  }

  noteSuccess() {
    this.#failures = 0;
  }
}
