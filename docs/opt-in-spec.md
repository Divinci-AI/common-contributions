# The opt-in file (version 1, provisional name)

A project says yes by committing `.github/agent-contributions.json` to its **default branch**. No file, or anything this page does not allow, means **no**.

The tool reads the file at publish time, from the default branch, by repository id, and refuses on any doubt. It treats the file as **data**: it never runs, fetches or follows anything in it.

Check yours without contacting anyone: `node src/cli.mjs optin-check .github/agent-contributions.json`.

## Example
```json
{
  "version": 1,
  "opt_in": true,
  "contact": "@maintainer-login",
  "policy_url": "https://example.org/contributing/ai-policy",
  "review_by": "2027-04-01",
  "label_applied_by": ["maintainer-login"],
  "task_label": "agent-ready",
  "max_open_agent_prs": 1,
  "max_diff_lines": 150,
  "allowed_paths": ["tests/**", "docs/**"],
  "forbidden_paths": [".github/**"],
  "disclosure": { "mechanism": "pr_body", "text": "AI assistance: yes (tool: Common Contributions)" },
  "certification": { "dco": "none", "cla": "none" }
}
```

## Fields
| Key | Required | Meaning |
|---|---|---|
| `version` | yes | the integer `1` |
| `opt_in` | yes | literally `true` |
| `contact` | yes | an `@login` or an email address: the named human to ask. Printed to the submitter before they confirm; never emailed by the tool |
| `policy_url` | yes | `https` link to your written policy. Printed to the submitter, never fetched |
| `review_by` | yes | a date, at most 12 months ahead. After it the file is stale and publishing is refused |
| `paused` | no | `true` freezes everything (an active incident, a release) |
| `task_label` | no | default `agent-ready`. A task needs this label |
| `label_applied_by` | yes | GitHub logins (1 to 10, people not bots) allowed to apply the label. Resolved to ids at publish time. A label applied by anyone else does nothing |
| `label_blocklist` | no | labels that make an issue ineligible (`good first issue`, `Needs Triage`) |
| `claim_required` | no | the issue must be assigned to the submitter first |
| `first_time_contributors` | no | `allowed` or `not_allowed` (default). If not allowed, the submitter needs a merged PR in your project |
| `max_open_agent_prs` | no | 0 to 10, default 1. The tool's own ceiling is 3 |
| `max_diff_lines` | no | 1 to 2000, default 150. The tool's own ceiling is 400 |
| `allowed_paths` / `forbidden_paths` | no | globs: `*` and `?` inside a path segment, `**` as a whole segment; letters, digits and `. _ - /` only |
| `safety_critical` | no | `true` for software where a subtle error could hurt people (health, crisis response, money). Requires `allowed_paths`; the publisher then also refuses any path that is not a test or documentation by its path (a directory named `test`, `tests`, `__tests__`, `spec`, `docs` or `doc`; `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`; `*.md`, `*.rst`) |
| `safety_reason` | no | a short plain sentence, shown to the submitter |
| `changelog` | no | `{"required": true, "path": "changelog/{issue}.{type}.rst"}` if your project wants a changelog file |
| `disclosure` | yes | `{"mechanism": "pr_body", "text": "..."}` (a line in the PR) or `{"mechanism": "commit_trailer"}` (an `Assisted-by:` trailer). There is no "none" |
| `certification` | yes | `{"dco": "none" or "signed-off-by", "cla": "none", "individual" or "corporate_or_individual"}` |

Unknown keys, missing keys, wrong types, duplicate keys, a byte-order mark, anything over 16 KiB or nested more than three levels, and hidden or control characters all refuse the whole file.

## What the tool will never do whatever the file says
It never touches `.github/**`, `.gitattributes`, `.gitmodules` or `CODEOWNERS` (the publisher refuses them), the common dependency, build and CI configuration files (the list is in `src/scope.mjs`; the contribution step refuses them), or executable files and symlinks (the base commit's mode is checked). It never mentions anyone with `@`, and refuses closing keywords and references to other issues in the text it publishes (they would close or notify other threads). It opens a pull request only from the submitter's own fork and account, one at a time, after they confirm on their terminal.

## How to say no, or stop
Delete the file, or set `"opt_in": false`, or `"paused": true`. The next publish attempt reads it and refuses. A pull request already open is yours to close; the tool never comments on one, and it closes a pull request only in one case: one it has just created that turns out to differ from the commit and text you approved.

## What the tool cannot know
It cannot tell whether a person who got through its checks understood the change, and it cannot see a pull request opened by a copy of the tool with the checks removed. Your contact line and your reviewers are the real safeguard.
