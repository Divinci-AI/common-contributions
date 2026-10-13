# Security and reporting

Common Contributions is an early, unreleased tool. It is **not installable yet** and nothing here has been used on a project that did not ask for it.

## Report a vulnerability
Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. It is enabled on this repository. Please do not put exploit details in a public issue.

## Report a pull request you did not want
If a pull request made with this tool landed in your project and you did not opt in, or you want it closed:
1. Close it. You never need our permission, and we will not argue.
2. Open an issue here (the "maintainer feedback" template) with the pull request link, so we can find out how it got past the checks. The tool is built so that it should not have been possible: a project must publish an opt-in file on its default branch, and the person submitting must pass every check on the day they submit.

We are a small team and do not promise a response time. We will read every report.

## What the checks do and do not protect
- **A container** runs the model's code with no network, a read-only copy of the source, no capabilities, and memory, process and time limits. It is tested on **one runtime (macOS with OrbStack)**. A container escape would reach the home folder of the person running it, with their rights. `--allow-host-execution` skips the container.
- **The run record is self-reported.** It is made by the tool, on the submitter's machine, and signed with a key that sits in a file only your user can read. That stops accidents and hand edits; it does **not** stop any program running as you from reading the key and writing a clean record, and a modified copy of this tool could do the same. A project's own CI and its reviewers are the real check; the record helps them re-run the same recipe.
- **A project can change hands.** If a repository is transferred, the old owner's opt-in file is still on its default branch. GitHub does not expose a transfer in a way this tool can read, so it can only notice an owner change since your last publish to that project; `review_by` and the named contact are the other limits.
- **The opt-in file is data, never instructions.** The tool parses it strictly and never runs or fetches anything it names.
- **A human submits.** A person runs one command from their own account; the pull request comes from their own fork. The tool prints the whole diff and the project's contact, re-checks the project's opt-in at three moments (before the fork, before the push, before the pull request) and publishes. It adds no waiting period and no approval step: whether and how to review a pull request is the maintainer's business. When a project requires a CLA or DCO, the person types that certification on their terminal; the tool never signs it for them, which keeps a program that only has a pipe from certifying on a person's behalf. It does not stop a program that opens its own terminal or calls GitHub with the submitter's login, and it cannot know whether the submitter understood the change.
- **Anyone can fork this Apache-2.0 code and delete the checks.** A fork without them is not Common Contributions.

Full design notes: `docs/opt-in-spec.md` and `docs/publishing.md`.
