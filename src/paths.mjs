/**
 * Where the harness keeps its state (ledger, STOP file). Order:
 *  1. $COMMON_CONTRIBUTIONS_HOME, if set
 *  2. an older install's directory, if it exists and the new one does not (so a person's ledger and STOP file are never silently abandoned)
 *  3. $XDG_STATE_HOME/common-ai, else ~/.local/state/common-ai
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function defaultStateDir({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.COMMON_CONTRIBUTIONS_HOME) return env.COMMON_CONTRIBUTIONS_HOME;
  const next = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "common-ai");
  const legacy = join(home, ".divinci", "common-contributions");
  if (!exists(next) && exists(legacy)) return legacy;
  return next;
}
