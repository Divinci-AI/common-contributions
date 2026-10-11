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
- **The run record is self-reported.** It is made by the tool, on the submitter's machine. A modified copy of this tool could write a clean record. A project's own CI and its reviewers are the real check; the record helps them re-run the same recipe.
- **The opt-in file is data, never instructions.** The tool parses it strictly and never runs or fetches anything it names.
- **A human submits.** The tool prepares a pull request, shows the whole diff, and publishes only after the submitter confirms on their terminal. It cannot know whether they understood the change.
- **Anyone can fork this Apache-2.0 code and delete the checks.** A fork without them is not Common Contributions.

Full design notes: `docs/opt-in-spec.md` and `docs/publishing.md`.
