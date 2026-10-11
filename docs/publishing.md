# Publishing a contribution (for the person submitting)

You are the submitter. The pull request comes from **your** fork and **your** account, and you answer the review. Several projects ban autonomous agent pull requests outright; this tool is built so that a person is always the submitter.

## The flow
1. `run-one` checks the model's change in a container and writes a **run record** (self-reported).
2. `publish --record ... --repo owner/name --issue N --clone DIR --description-file FILE` is a **dry run**. It checks everything, prints every check, the whole diff, the exact commit message, the exact PR title and body and the author name and email that will be published, and a token. It changes nothing on GitHub.
3. Wait at least 10 minutes. Read it again.
4. Run the same command with `--approve <token>`. On the terminal you retype the repository name, confirm your sentence and type `yes`. The tool then re-checks the project three times (before forking, before pushing, before opening the PR), pushes exactly the approved commit to your fork, opens the PR and verifies what was created.

## What you write yourself
The PR description (`--description-file`) and one sentence in your own words that says what the change does and mentions the issue number. The tool adds only the project's required disclosure, the issue reference, your sentence and a short note that the checks ran in a container (self-reported).

## Flags you have to mean
`--cla-signed` (you have signed the project's CLA; a CLA can bind your employer). `--certify-dco` (you can certify the Developer Certificate of Origin for this change; the tool never signs for you, and the origin of model output is unknown). `--allow-flagged-code` (you read the lines that touch the environment, network or processes).

## Things to know
- Every pull request notifies the project's watchers and code owners.
- GitHub's Acceptable Use Policy prohibits bulk and inauthentic automated activity. This tool opens at most one pull request per project per 24 hours and at most three a day, only after you confirm each one, and never retries a failed write. Read the policy and keep it that way.
- Your git `user.name` and `user.email` are published in the commit.
- If a project answers with changes requested and you do not reply for a week, the tool refuses to open more. Answer or close.
- The tool refuses until the harness source you are running is a reviewed one (`reviewed-harness-trees.json`). That is a consistency check against edited copies, not security.
