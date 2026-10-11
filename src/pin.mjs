/** The runtime pin: written only after the escape suite is green on this runtime; read before any container run. A missing pin REFUSES. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readRuntime } from "./container.mjs";

export const MIN_ESCAPE_PASS = 14;

export function loadPin(file) {
  if (!existsSync(file)) throw new Error(`no runtime pin at ${file}. Run \`pin-runtime\` (it runs the escape tests on this runtime first).`);
  const pin = JSON.parse(readFileSync(file, "utf8"));
  if (!pin?.engine || !pin?.kernel || !pin?.os) throw new Error(`runtime pin ${file} is incomplete`);
  return pin;
}

/** `runSuite()` returns {pass, fail, skipped}. The pin is written only if nothing failed and enough of the suite ran. */
export function qualifyRuntime({ docker, runSuite, out, harness }) {
  const suite = runSuite();
  if (suite.fail !== 0 || suite.pass < MIN_ESCAPE_PASS) return { ok: false, suite, reason: `escape suite: ${suite.pass} passed, ${suite.fail} failed (need ${MIN_ESCAPE_PASS}+ passing and none failing); no pin written` };
  const pin = { ...readRuntime(docker), qualifiedAt: new Date().toISOString(), harness, escapeSuite: suite };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(pin, null, 2) + "\n");
  return { ok: true, pin };
}

export function parseTap(text) {
  const n = (k) => Number((text.match(new RegExp(`^# ${k} (\\d+)`, "m")) ?? [])[1] ?? NaN);
  return { pass: n("pass"), fail: n("fail"), skipped: n("skipped") };
}
