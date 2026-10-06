# common-contributions (guard rails, v0 — no model wired in)

The part of "contribute your own AI tokens to open projects" that must not be left to the model: what a call may cost,
what the agent may reach, whether its output is safe to publish, and whether its change stays inside the task.
Zero dependencies; plain Node >= 22.14 ESM; `npm test` uses the built-in runner.

| Module | Guarantees |
|---|---|
| `budget.mjs` | Every call is **reserved at worst-case cost before it is made** and refused if it could cross the per-day or total cap; real cost is appended to a JSONL ledger that survives restarts; a model with no listed price is refused (unknown price is not free). |
| `killswitch.mjs` | A `STOP` file checked before every model call and git action; anything can trip it, only a human clears it (`clear-stop --yes`); first reason kept; N consecutive failures trip it. Local only — no central switch. |
| `secrets.mjs` | Scans output and produced files for secret shapes (findings carry the KIND, never the text); the sandbox environment is an **allowlist** with `HOME` replaced. |
| `egress.mjs` | Host allowlist (exact or `*.suffix`; never a bare `*`); the agent gets a `fetch` that trips STOP off-list. |
| `scope.mjs` | Opt-in by the `agent-ready` label **and** a parseable "one file" scope; diff must stay inside it; publish only to `agent/*` branches (never main/preview). |
| `runner.mjs` | The loop: reserve -> agent -> record -> scan secrets -> check URLs -> check scope. Any breach trips STOP. A refused budget stops the loop but does not trip STOP (it is the system working). |

```sh
npm test                                   # 44 tests
node src/cli.mjs status
node src/cli.mjs stop "reason"
node src/cli.mjs clear-stop --yes
node src/cli.mjs dry-run issues.json       # STUB agent: no model, no network
```
State: `$COMMON_CONTRIBUTIONS_HOME` (default `~/.divinci/common-contributions`). Caps: `CC_MAX_USD_PER_DAY` (3), `CC_MAX_USD_TOTAL` (15).

## What this does NOT do (read before trusting it)
- **No model adapter.** Only a stub agent exists. A real adapter must report token usage measured from the provider's
  response; an adapter that under-reports defeats the ledger (the worst-case reservation still bounds each single call).
- **No OS-level sandbox.** The agent is designed to *return file contents*, not run commands — the harness writes them.
  If an adapter ever hands the agent a shell, env scrubbing is not isolation; use a container/VM.
- **No git/PR publishing.** Only the `assertPublishable` gate exists.
- **The secret scanner is pattern-based**; an unknown token shape passes. **Egress control covers the `fetch` it hands
  the agent and URLs in output, not the network stack.**
- **The ledger is single-process:** two concurrent runners could both reserve against the same headroom.
- Mutation-tested (21 guard removals, all caught) — that shows the tests pin the guards, not that the guards are
  sufficient against a determined attacker.
