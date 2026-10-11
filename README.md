# Common AI: common-contributions (guard rails, v0 — not installable yet)

Early and not installable yet. See [the roadmap](docs/roadmap.md), and the [status table](https://common-contributions-preview.divinci-ai.workers.dev/harness/#status) for what exists. Licensed under [Apache-2.0](LICENSE). Maintainers: [tell us what an acceptable AI contribution looks like](../../issues/new/choose).


The part of "contribute your own AI tokens to open projects" that must not be left to the model: what a call may cost,
what the agent may reach, whether its output is safe to publish, and whether its change stays inside the task.
Zero dependencies; plain Node >= 22.14 ESM; `npm test` uses the built-in runner.

| Module | Guarantees |
|---|---|
| `budget.mjs` | Every call is **reserved at worst-case cost before it is made, as a lock-protected hold that other processes can see** and refused if it could cross the per-day or total cap; real cost is appended to a JSONL ledger that survives restarts; a model with no listed price is refused (unknown price is not free). |
| `killswitch.mjs` | A `STOP` file checked before every model call and git action; anything can trip it, only a human clears it (`clear-stop --yes`); first reason kept; N consecutive failures trip it. Local only — no central switch. |
| `secrets.mjs` | Scans output and produced files for secret shapes (findings carry the KIND, never the text); the sandbox environment is an **allowlist** with `HOME` replaced. |
| `egress.mjs` | Host allowlist (exact or `*.suffix`; never a bare `*`); the agent gets a `fetch` that trips STOP off-list. |
| `scope.mjs` | Opt-in by the `agent-ready` label **and** a parseable "one file" scope; diff must stay inside it; publish only to `agent/*` branches (never main/preview). |
| `runner.mjs` | The loop: reserve -> agent -> record -> scan secrets -> check URLs -> check scope. Any breach trips STOP. A refused budget stops the loop but does not trip STOP (it is the system working). URLs in output on reserved documentation hosts (`example.com`, `*.invalid`, `localhost`...) are fixtures, not egress; the agent's own `fetch` stays strictly allowlisted. |
| `coverage.mjs` | Finds every test file that IMPORTS a module (in Node, not grep). `run-one` refuses unless the issue names each existing test, and the prompt carries them. |
| `mutate.mjs` | Runs mutations written by someone OTHER than the test's author: exactly-once patterns, byte-identical restore, and mutants that do not build are reported separately from "caught". |
| `adapters/` | `ollama.mjs` (a local model, loopback only), `workersai.mjs` (a hosted model, measured and bounded) and `replay.mjs` (an already-written reply, e.g. from a coding agent, put through the same checks; any non-zero or missing tool-use count refuses the run). |

```sh
npm test                                   # the full suite
node src/cli.mjs status
node src/cli.mjs stop "reason"
node src/cli.mjs clear-stop --yes
node src/cli.mjs dry-run issues.json       # STUB agent: no model, no network
node src/cli.mjs coverage --repo R --module path/to/source.ts      # who already tests this module?
node src/cli.mjs run-one issues.json 25 --repo R --model NAME --reply-file reply.txt --tool-uses 0   # replay   # add --allow-host-execution to verify on this machine (no container yet)
node src/cli.mjs run-one issues.json 25 --repo R --model NAME --print-prompt                         # the exact prompt
node src/cli.mjs mutate --allow-host-execution --repo R --source S --test T --cwd DIR --mutations muts.json                 # independent mutations
```
State: `$COMMON_CONTRIBUTIONS_HOME` (default `~/.local/state/common-ai`, or `$XDG_STATE_HOME/common-ai`; an older `~/.divinci/common-contributions` is reused only while the new directory does not exist). Caps: `CC_MAX_USD_PER_DAY` (3), `CC_MAX_USD_TOTAL` (15).

## What this does NOT do (read before trusting it)
- **Adapters.** A local one (Ollama, loopback only; mock-tested, not yet run against a real model) and a hosted one (Cloudflare Workers AI; usage
  measured from the provider's own counters, an input bound enforced before the call, so the reservation really is the worst case). One real hosted run is on the
  ledger ($0.0027 for 2,904 tokens in and 792 out). It has **not** been reconciled against Cloudflare's own usage figure, which needs an analytics-read credential.
- **The container is one boundary, tested on one runtime.** The agent only *returns file contents*; the harness writes them and runs the project's checks in a container (`--container-image`, after `build-deps` and `pin-runtime`). Without a container, running them is refused unless you pass `--allow-host-execution`. Tested on macOS with OrbStack only; an escape would reach your home folder with your rights.
  If an adapter ever hands the agent a shell, env scrubbing is not isolation; use a container/VM.
- **No git/PR publishing.** Only the `assertPublishable` gate exists.
- **`--tool-uses` is relayed by whoever runs the harness**, not measured by it: a replayed agent's tool count cannot be verified here.
- **The secret scanner is pattern-based plus an entropy check on what the agent ADDED** (32+ characters, a digit and a letter, 4.2+ bits per character; hex only next to a key/token/secret word). An unknown short or low-entropy secret passes. **Egress control covers the `fetch` it hands
  the agent and URLs in output, not the network stack.**
- **Concurrent runners share headroom through holds.** A reservation is a hold written under a lock, so a second process sees what the first has claimed (two processes raced 12 of 12 times: old code let both through, new code let one). A hold left by a crashed process counts until it expires (10 minutes); after that its possible spend is forgotten.
- Mutation-tested (40+ guard removals, all caught) — that shows the tests pin the guards, not that the guards are
  sufficient against a determined attacker. A first real run also taught that a mutation score is a floor, not a gate:
  a test file tuned against one mutation set fell from 86% to 50% on a held-out set written by a different author.

## Opting a project in, and publishing
- Maintainers: [`docs/opt-in-spec.md`](docs/opt-in-spec.md) (the opt-in file; check yours with `optin-check`).
- Submitters: [`docs/publishing.md`](docs/publishing.md) (dry run first; you are the submitter).
- Reporting a problem or a pull request you did not want: [`SECURITY.md`](SECURITY.md).
