# Publishing a contribution (for the person submitting)

You are the submitter. The pull request comes from **your** fork and **your** account, and you answer the review. Several projects ban autonomous agent pull requests outright; this tool is built so that a person is always the submitter.

## The flow
1. `run-one` checks the model's change in a container and writes a **run record** (self-reported).
2. `publish --record ... --repo owner/name --issue N --clone DIR --description-file FILE` runs every check, prints the whole diff, the exact commit message, the exact PR title and body and the author name and email that will be published, and then publishes. Add `--dry-run` to see all of that and change nothing (it needs no terminal).
3. The tool re-checks the project three times (before forking, before pushing, before opening the PR), pushes exactly the planned commit to your fork, opens the PR and verifies what was created.

There is no waiting period and no approval step. How a pull request is reviewed is the maintainer's decision; the tool's job is to create it, from your account, only where the project asked for it.

## What you write yourself
The PR description (`--description-file`). The tool adds only the project's required disclosure, the issue reference and a short note that the checks ran in a container (self-reported).

## Flags you have to mean
Two things are asked ON THE TERMINAL, never as flags, after the text is shown, and only when the project's opt-in file requires them: that you have signed a CLA (it can bind your employer), and that you certify the Developer Certificate of Origin for this change (the tool never signs for you, and the origin of model output is unknown). Added lines that touch the environment, network or processes make the publish refuse unless you pass `--allow-flagged-code`, which you should do only after reading them in the printed diff.

## What the certification is and is not
When a project requires a CLA or DCO, the certification is read from your terminal (`/dev/tty`), not from a flag or a pipe, after the diff and your published name and email are printed. That keeps a program that only has a pipe from certifying for you. It does **not** stop a program running as you that opens its own pseudo-terminal, or that calls the GitHub API with your login. Do not run this where something else has your terminal. A project that requires neither gets no prompt at all.

## Things to know
- Every pull request notifies the project's watchers and code owners.
- GitHub's Acceptable Use Policy prohibits bulk and inauthentic automated activity. This tool refuses a second pull request to the same project within the interval that project sets (24 hours unless its opt-in file says otherwise, never less than 6) and more than three in a day across projects, but it counts those from a ledger on your machine, which you control; the checks it makes on GitHub itself are the project's open agent PR count, your own open agent PR, and an earlier PR waiting on you. It opens one only after you confirm, and never retries a failed write. Read the policy and keep to it.
- Your git `user.name` and `user.email` are published in the commit.
- If a project answers with changes requested and you do not reply for a week, the tool refuses to open more. Answer or close.
- The tool refuses until the harness source you are running is a reviewed one (`reviewed-harness-trees.json`). That is a consistency check against edited copies, not security.
