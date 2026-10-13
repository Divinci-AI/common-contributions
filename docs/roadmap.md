# Roadmap: from "not installable yet" to a first real contribution

Public roadmap, written 2026-10-08. Every line on the website's status table and every "not built" claim on the homepage is a row here.
This is a plan, not a promise: no dates, only order, exit tests and the decisions that belong to a person.

## 0. What "installable" has to mean (so the website line can honestly change)

The homepage says "not installable yet". That line may be removed only when ALL of these are true:

1. A person can run **one command** with **their own API key** against **a project that opted in**.
2. The model call is **measured** (usage read from the provider's response) and **capped** before it is made.
3. Any code the agent wrote that gets **executed** (the project's own type check and tests) runs **inside a sandbox**.
4. Publishing is a **pull request from a fork, from an `agent/*` branch**, by a **person running the publish command from their own account**; whether the maintainers approve it is theirs to decide.
5. **At least one maintainer** has said yes to it for their project, in writing, where we can link to it.

"Installable" (a tool exists) is not "launched" (a public list of projects). The homepage says which one is true.
Items 1 to 4 are engineering. Item 5 is a person saying yes, and we cannot build it.

## 1. The claims on the page, as rows

| # | Row on the site | State today | Becomes | Phase |
|---|---|---|---|---|
| a | Hosted model, capped API key | Not built | Built + reconciled against real billing | 2 |
| b | Local model adapter | Mock-tested | Run once against a real local model | 2 |
| c | Operating-system sandbox | Not built | Container verifier with escape tests | 3 |
| d | Pull request publishing | Not built (gate only) | Fork-and-PR behind human approval | 4 |
| e | Maintainer opt-in file | Designed | Parser, validator, revocation check | 4 |
| f | One-command install | Not built | Clean-machine install test | 5 |
| g | Name and domain | Not cleared | Cleared or replaced | 0 |
| h | The catalog | Does not exist | A queryable index with a measured benchmark | 7 |
| i | Open science listings | None | One pilot, proposed by the project's own team | 8 |
| j | Propose or sponsor | Not open | Public tracker first; payments much later | 0, 9 |
| k | First external project | None | One maintainer's written yes | 6 |

The dry run's own "what this does not show yet" list is also work, and is folded into the phases:
the budget cap was never exercised against real billing (2), token counts were never measured (2), a tool-use
count cannot be verified by the harness (3), no maintainer has reviewed a test file (6), no PR has been opened (4),
and the evidence is two small modules with one model family (cross-cutting, below).

## 2. Phases, in order

### Phase 0. Housekeeping that blocks honesty (no spend)
- **Name.** "Common AI" is the name for now. Another organisation, CommonAI, uses a near-identical name, so it has not been cleared and nothing is registered. The footer says so.
- **License and public repository.** Done: Apache-2.0, repository public.
- **Contact channel.** The public issue templates are the channel. No email address goes on the page.
- **No CI yet.** Nothing verifies a push automatically, so correctness rests on `npm test` on a clean clone, recorded in each commit message.
- **Status as data.** Move the status table into one `status.json`; add a test that fails if a row says "Built" and no test
  file names it. The site table and this roadmap then cannot drift from the code.

Exit: repo public with license; `status.json` + the test; name decision recorded.

### Phase 1. Close the gaps the dry run found (no spend, mostly small)
- **Ledger is single-process.** Two concurrent runners can both reserve the same headroom. Add a file lock; test with two processes.
- **Secret scanner is pattern-only.** Add an entropy check on added lines; keep reporting kind, never text.
- **Egress covers the injected `fetch`, not the network.** Fully closed in Phase 3 (container network is off).
- **More evidence before claiming more.** Mutation sets so far: two modules, one author per set. Run the coverage gate
  and mutation runner on 8 to 10 modules across 3 repositories, with mutation sets written by two different models.
  Report the spread, not the average.

Exit: concurrency test red-before / green-after; entropy test; an evidence table with n >= 8 modules.

### Phase 2. A real model, measured and capped (needs a spend approval)
- **Hosted adapter.** One provider first. Usage is read from the response; a response with no usage field is a refusal.
  A model with no known price is refused (already true). The worst case is reserved before the call (already true).
- **Reconcile.** After a run, compare the ledger to the provider's own usage figure for that key. Fail the test if they differ
  by more than 5%. This is the first time the budget guard meets real billing.
- **Local adapter.** Run the existing Ollama adapter against a real local model once; today it is only mock-tested.
- **Mutation-test the adapters**: remove "usage must be present", "refuse unknown price", "loopback only"; each removal must fail a test.

Spend: bounded by the harness's own defaults, $3 a day and $15 in total, with a provider-side limit set by a person.
Exit: a ledger-versus-billing reconciliation on a real run, and the adapter guards killed by their mutations.

### Phase 3. Containment (the real reason for "OS sandbox")
The agent only returns text, but the harness then **runs the project's own tests on that text**. That is executing
untrusted code. So the sandbox is not for the model call; it is for the verifier.
- Run type check and tests in a container: no network, non-root, read-only source mount with a scratch tmpfs, CPU, memory
  and wall-clock limits, scrubbed environment, no host mounts.
- **Escape tests, written first:** a test file that tries to read `~/.ssh`, read the host environment, open a socket, fork-bomb,
  and write outside its directory. Every one must fail.
- **Language support.** The verifier has only been exercised on TypeScript. The strongest candidate projects are Python (see the shortlist), so the container
  needs a Python image that runs `pytest`, with the same escape tests, before any of them. One language at a time.
- A person can still set the harness up wrongly. The page says so.

Exit: the escape tests are red without the container and green with it.

### Phase 4. Publishing and the opt-in file
- **Publisher.** Push to a **fork**, branch `agent/<issue>-<short>`, open a PR whose body carries the disclosure line.
  One open PR per project, diff under the project's `max_diff_lines`, refuses if the project's file says `false` at the moment of publishing.
- **A person submits** every publish (one command, no waiting period; a CLA/DCO certification is typed by them when the project requires it). Several target projects require a **human submitter who understands
  the change**, so the PR is opened from that person's own fork and account, never as a bot, and the submitter can answer review questions.
- **Opt-in file.** Parser and validator for the `.github/AGENT-CONTRIBUTIONS.md` design on the site, a revocation check on the
  default branch that fails closed, and the spec as a public document. Name stays provisional.
- **Stage 1b, our own repository:** open the real PRs from `agent/*` against `Divinci-AI/divinci-demo-pipeline-oss` (issues #25, #26) and merge them by hand.

Exit: two real PRs on our own repo, one merged by a person; revocation test; publish refuses when the file is absent.

### Phase 5. One-command install
- A command that runs preflight (Node version, key present, caps set, state directory), runs a self-test where each guard is
  tripped on purpose, prints exactly what it is about to do, and refuses to proceed without an explicit acknowledgement.
- Provider-side spend limits cannot be verified by us; the installer says that out loud and asks the person to set one.
- Package name waits on the name decision.

Exit: install in a fresh container with nothing preinstalled; the self-test fails when a guard is removed.

Phases 1 to 5 together flip items 1 to 4 of the definition. Item 5 is Phase 6.

### Phase 6. The first real project (a person's yes)
- **Choose the project from a shortlist** (kept private until a project agrees to be named): written policy that permits AI-assisted
  work with disclosure, labelled small issues, tests that run offline, active reviewers.
- **We do not contact anyone from this plan.** A person decides whether to ask, writes the message, and sends it. The ask is
  "would this be useful, and on what terms", not a pull request.
- The first task is small and test-only or docs-only. A maintainer reviews it; only then does anything appear on the site, and only
  after the maintainer agrees to be named.

Exit: one maintainer's written yes, linked from the site, and one reviewed contribution.

### Phase 7. The catalog (a separate product, so its own plan)
The idea: before an AI spends tokens building something, it asks the catalog whether open software already does the job.
- **First version is a query, not a crawler.** A seed of the most widely used open projects by category, each with: what it does in
  plain words, license, last release, open and closed issue counts, whether CI exists, and links. Sources: public registries and
  open datasets (GitHub, npm, PyPI, crates.io, ecosyste.ms, Software Heritage); check each source's terms before use.
- **One tool call:** `catalog_check("what I need")` returns up to five candidates with a health summary. Ship it as a command and
  as an MCP tool so a coding agent can call it before it writes anything.
- **Measure it before saying it saves tokens.** Build a benchmark of 50 "build me X" requests where a good open project exists
  and 20 where none does. Report recall at 5, false-match rate, and the tokens the agent spends with and without the check.
- **Index design:** use one index with namespaces, or another store; never an index per entry.
- **Honest scope:** a catalog that is wrong confidently is worse than no catalog. Show the health data, never a bare "use this".

Exit: the benchmark numbers, published with their failures, and a working tool.

### Phase 8. Open science (one pilot)
- Open research projects whose own team proposes a task an AI can do and a person can check: data cleaning, replication checks,
  documentation, tooling.
- One pilot, proposed by the project, using Phases 2 to 4 unchanged. No science project is named on the site until it agrees.

Exit: one reviewed contribution to a research project that asked for it.

### Phase 9. Propose or sponsor
- **Proposals first:** a public issue template. Free, no accounts, no payments.
- **Sponsorship later and separately.** It needs a written policy before a single payment is taken: sponsorship can buy a listing or a
  feature, never acceptance of a change; sponsored entries are labelled; where the money goes. It also needs legal and tax advice.
  Do not build payment flows until that exists.

Exit (proposals): the template and a stated review process. Exit (sponsorship): counsel's sign-off, then a labelled listing.


## 3. What needs a person (everything else I can do)
1. Whether the name stands, given the CommonAI overlap.
2. Any spend: a hosted model key and its limit (Phase 2).
3. Choosing the first project, writing the message, and sending it.
4. Open science pilot, same.
5. Sponsorship policy and legal advice.

## 4. Order of work, and why
0, then 1 and 2 together (no sequence between them), then 3, then 4, then 5. Phase 7 can start any time in parallel because it
shares no code with the harness, but it should not be announced until its benchmark exists. Phase 6 starts the day Phase 4's
own-repo PRs have been merged, because only then is there a real artifact to show a maintainer. Phases 8 and 9 follow 6.

## 5. Risks to the plan itself
- **Scope.** Two products (harness, catalog) plus a content program. If something has to wait, the catalog waits; the harness is
  what makes any contribution safe.
- **Policy drift.** A project's AI policy can change. The opt-in check at publish time is the only protection; do not cache it for long.
- **Reputation.** Many maintainers are tired of AI-written changes. A single bad PR from a pre-launch tool costs more than the
  schedule. Phase 4's own-repo stage exists to find those problems before a stranger sees them.
- **No CI.** Until there is one, correctness rests on local runs. Say so in commits.
