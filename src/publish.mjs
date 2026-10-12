/**
 * The publisher's plan: every check that must pass before anything is pushed or opened. Pure decisions over (record, GitHub answers, spec, ledger).
 * Nothing here writes to GitHub. Any error from GitHub, any truncated list, any ambiguity is a refusal.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhError } from "./ghclient.mjs";
import { MIN_HOURS_BETWEEN_PRS, OPTIN_PATH, globMatch, hiddenChars, isPlainText, parseOptIn } from "./optin.mjs";
import { issueHash, publishProblems } from "./record.mjs";
import { isConfigFile } from "./scope.mjs";

export const MARKER_PREFIX = "common-ai";
export const TOOL_MAX_OPEN = 3;
export const TOOL_MAX_DIFF = 400;
export const TOOL_MAX_PER_DAY = 3;
const DAY = 24 * 3600 * 1000;

/** Never allowed whatever the project's file says: things that run in the maintainer's CI or change what git does with files. */
const TOOL_FORBIDDEN = [".github/**", "**/.github/**", ".gitattributes", "**/.gitattributes", ".gitmodules", "**/.gitmodules", "CODEOWNERS", "**/CODEOWNERS", ".git/**"];

/** Added lines that read the environment, open a network, spawn a process or evaluate text. Shown to the human; refused unless they pass --allow-flagged-code. */
const FLAGGED = [
  [/process\.env|os\.environ|getenv\b/, "reads the environment"], [/child_process|\bspawn\(|\bexecSync?\(|subprocess|os\.system|\bpopen\(/, "starts a process"],
  [/\bfetch\(|XMLHttpRequest|require\(["']net["']\)|from ["']node:(net|http|https|dgram|tls)["']|\bsocket\b|urllib|requests\.|http\.client/, "uses the network"],
  [/\beval\(|new Function\(|\bexec\(/, "evaluates text as code"], [/readFile(Sync)?\(\s*["'`]\/|open\(\s*["']\/|\.\.\/\.\./, "reads outside the repository"],
];
export function scanAdded(files) {
  const out = [];
  for (const [path, content] of Object.entries(files)) for (const [i, line] of String(content).split("\n").entries()) for (const [re, why] of FLAGGED) if (re.test(line)) out.push(`${path}:${i + 1} ${why}`);
  return out;
}

/** Tests and documentation, by path: what a safety-critical project accepts regardless of what its own allowed_paths says. */
export function isTestOrDocPath(p) {
  const parts = p.split("/"), base = parts.at(-1);
  if (parts.slice(0, -1).some((d) => ["test", "tests", "__tests__", "spec", "specs", "docs", "doc", "documentation"].includes(d.toLowerCase()))) return true;
  return /\.(test|spec)\.[A-Za-z0-9]+$/.test(base) || /_test\.[A-Za-z0-9]+$/.test(base) || /^test_[^/]*\.py$/.test(base) || /\.(md|rst)$/i.test(base);
}
const fold = (x) => x.normalize("NFC").toLowerCase();

const git = (args, opts = {}) => spawnSync("/usr/bin/git", args, { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

/** Added/deleted line counts and the unified diff of the recorded files against the BASE commit. New files count all their lines as added. */
export function diffAgainstBase(repoDir, base, files) {
  let added = 0, deleted = 0; const patches = [];
  const tmp = mkdtempSync(join(tmpdir(), "cc-diff-"));
  try {
    for (const [i, [path, content]] of Object.entries(files).entries()) {
      const old = git(["-C", repoDir, "cat-file", "-p", `${base}:${path}`]);
      const a = join(tmp, `a${i}`), b = join(tmp, `b${i}`);
      writeFileSync(a, old.status === 0 ? old.stdout : ""); writeFileSync(b, content);
      const n = git(["diff", "--no-index", "--numstat", "--", a, b]);
      const m = n.stdout.trim().split("\t");
      if (!(n.status === 0 || n.status === 1) || m.length < 2) throw new Error(`diff failed for ${path}`);
      if (m[0] === "-" || m[1] === "-") throw new Error(`${path} is a binary file; only text can be published`);
      added += Number(m[0]) || 0; deleted += Number(m[1]) || 0;
      const d = git(["diff", "--no-index", "--", a, b]).stdout.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `a/${path}`).replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `b/${path}`);
      patches.push(d);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { added, deleted, total: added + deleted, patch: patches.join("\n") };
}

const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isOurPr = (p) => p.headRef.startsWith("agent/") || p.body.includes(`<!-- ${MARKER_PREFIX} `);

/**
 * @param {{gh, record, key, reviewedTrees, target:string, issueNumber:number, user:{login:string,id:number,name:string,email:string}, repoDir:string,
 *          ledger:Array<{repoId:number,userId:number,at:number}>, now?:number, flags?:{claSigned?:boolean,certifyDco?:boolean,allowFlaggedCode?:boolean}}} o
 * @returns {{ok:boolean, checks:Array<{name:string,ok:boolean,detail:string}>, bound?:object, spec?:object, diff?:object, warnings:string[]}}
 */
export function planPublish(o) {
  const { gh, record, key, reviewedTrees, target, issueNumber, user, repoDir, ledger = [], now = Date.now(), parse = parseOptIn } = o; // `parse` is injectable for tests only; no caller sets it
  let flags = o.flags ?? {};
  const ack = {};
  const checks = [], warnings = [];
  const add = (name, ok, detail = "") => { checks.push({ name, ok, detail }); return ok; };
  const result = (extra = {}) => ({ ok: checks.every((c) => c.ok), checks, warnings, ...extra });
  const guard = (name, fn) => { try { return fn(); } catch (e) { add(name, false, e instanceof GhError || e instanceof Error ? e.message : String(e)); return undefined; } };

  // 1. the record
  const rp = publishProblems(record, { key, reviewedTrees, now });
  if (!add("run record is publishable", rp.length === 0, rp.join("; "))) return result();
  const files = Object.fromEntries(Object.entries(record.files).map(([p, f]) => [p, f.content]));
  const paths = Object.keys(files);
  if (!add("record is for this issue", record.issue.number === issueNumber, `record is for #${record.issue.number}, asked for #${issueNumber}`)) return result();

  // 2. identity
  const repo = guard("repository lookup", () => gh.repo(target));
  if (!repo) return result();
  const problems = [repo.archived && "archived", repo.disabled && "disabled", repo.private && "private", repo.fork && "a fork (publish to the canonical upstream)"].filter(Boolean);
  if (!add("repository can receive a PR", problems.length === 0, problems.join(", "))) return result();
  if (!add("record came from this repository", eqi(record.origin, `github.com/${repo.fullName}`), `record origin ${record.origin} vs ${repo.fullName}`)) return result();

  // 3. the base is in the target's history and nothing it depends on has moved
  const head = guard("default branch head", () => gh.branchHead(repo.id, repo.defaultBranch));
  if (!head) return result();
  const cmp = guard("compare base to head", () => gh.compare(repo.id, record.base, head));
  if (!cmp) return result();
  if (!add("base is an ancestor of the default branch", cmp.status === "ahead" || cmp.status === "identical", `compare status is "${cmp.status}" (a reset or diverged branch, or a commit not in this repository)`)) return result();
  if (cmp.status === "ahead") {
    if (!add("changed-file list is complete", !cmp.truncatedFiles && cmp.files !== null, "too many files changed since the base to compare; re-run from a fresh clone")) return result();
    const moved = cmp.files.filter((f) => paths.includes(f) || isConfigFile(f) || f === OPTIN_PATH);
    add("nothing the contribution depends on changed since the base", moved.filter((f) => f !== OPTIN_PATH).length === 0, `changed upstream since the base: ${moved.join(", ")}; re-run`);
  }

  // 4. the opt-in file, at the head sha
  const f = guard("read the opt-in file", () => gh.file(repo.id, OPTIN_PATH, head));
  if (!f) return result();
  const parsed = parse(f.bytes, { now });
  if (!add("opt-in file is valid", parsed.ok, (parsed.errors ?? []).join("; "))) return result();
  const spec = parsed.value;
  if (!add("project is not paused", !spec.paused, "the project has paused agent contributions")) return result();
  const lc = guard("opt-in file history", () => gh.lastCommit(repo.id, OPTIN_PATH, head));
  if (lc && (lc.authorType === "Bot" || (lc.authorLogin && ![spec.contact.replace(/^@/, ""), ...spec.label_applied_by].some((x) => eqi(x, lc.authorLogin))))) warnings.push(`the opt-in file was last changed by ${lc.authorLogin ?? "an unknown author"}${lc.authorType === "Bot" ? " (a bot)" : ""}, who is not the listed contact or a listed maintainer: check the contact before publishing`);

  // 5. the issue and who labelled it
  const maintainers = guard("resolve the maintainers", () => spec.label_applied_by.map((l) => gh.user(l)));
  if (!maintainers) return result();
  if (!add("listed maintainers are people", maintainers.every((u) => u.type === "User"), "a listed maintainer is a bot or organisation")) return result();
  const issue = guard("read the issue", () => gh.issue(repo.id, issueNumber));
  if (!issue) return result();
  add("issue is open and is an issue", issue.state === "open" && !issue.isPullRequest, `state ${issue.state}${issue.isPullRequest ? ", and it is a pull request" : ""}`);
  add("issue belongs to this repository", issue.repositoryUrl.toLowerCase().endsWith(`/repos/${repo.fullName.toLowerCase()}`), `issue lives at ${issue.repositoryUrl}`);
  add("issue text is what the run saw", issueHash(issue.title, issue.body) === record.issue.sha256, "the issue title or body changed since the run");
  add("issue carries the task label", issue.labels.includes(spec.task_label), `needs "${spec.task_label}"`);
  add("issue has no blocked label", !issue.labels.some((l) => spec.label_blocklist.includes(l)), `blocked label: ${issue.labels.filter((l) => spec.label_blocklist.includes(l)).join(", ")}`);
  const events = guard("read the issue events", () => gh.issueEvents(repo.id, issueNumber));
  if (events) {
    const relevant = events.filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label === spec.task_label).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const latest = relevant.at(-1);
    const okLabel = latest?.event === "labeled" && latest.actorType !== "Bot" && maintainers.some((m) => m.id === latest.actorId) && Date.parse(latest.createdAt) >= Date.parse(issue.createdAt);
    const renamedAfter = okLabel ? events.filter((e) => e.event === "renamed" && Date.parse(e.createdAt) > Date.parse(latest.createdAt)) : [];
    if (okLabel) add("issue was not renamed after it was labelled", renamedAfter.length === 0, "the title was changed after a maintainer labelled the issue");
    add("the task label was applied by a listed maintainer", okLabel === true, latest ? `latest "${spec.task_label}" event is ${latest.event} by ${latest.actorLogin ?? "unknown"}` : `no "${spec.task_label}" label event found`);
    if (okLabel) {
      const edited = guard("issue edit time", () => gh.issueLastEdit(repo.ownerLogin, repo.fullName.split("/")[1], issueNumber));
      if (edited !== undefined) add("issue was not edited after it was labelled", edited === null || Date.parse(edited) <= Date.parse(latest.createdAt), `edited at ${edited}, labelled at ${latest.createdAt}`);
    }
  }
  if (spec.claim_required) add("issue is assigned to you", issue.assignees.some((a) => eqi(a, user.login)), "this project requires the issue to be assigned to the submitter first");
  if (spec.first_time_contributors === "not_allowed") {
    const m = guard("count your merged PRs", () => gh.mergedPrsBy(repo.id, user.login));
    if (m) add("you have a merged PR in this project", m.merged >= 1, m.truncated ? "could not count (too many items); refusing" : "this project does not accept first-time contributors through this tool");
  }

  // 6. the diff
  const globs = (list, p) => list.some((g) => globMatch(g, p));
  add("no tool-forbidden path", !paths.some((p) => globs(TOOL_FORBIDDEN, p)), paths.filter((p) => globs(TOOL_FORBIDDEN, p)).join(", "));
  const forbid = (p) => spec.forbidden_paths.some((g) => globMatch(fold(g), fold(p)));
  add("no path the project forbids (compared without regard to case)", !paths.some(forbid), paths.filter(forbid).join(", "));
  if (spec.allowed_paths.length > 0) add("every path is allowed by the project", paths.every((p) => globs(spec.allowed_paths, p)), paths.filter((p) => !globs(spec.allowed_paths, p)).join(", "));
  if (spec.safety_critical) add("safety-critical project: tests and documentation only", paths.every(isTestOrDocPath), paths.filter((p) => !isTestOrDocPath(p)).join(", "));
  const diff = guard("diff against the base", () => diffAgainstBase(repoDir, record.base, files));
  if (diff) add("diff is small enough", diff.total <= Math.min(spec.max_diff_lines, TOOL_MAX_DIFF), `${diff.total} changed lines, limit ${Math.min(spec.max_diff_lines, TOOL_MAX_DIFF)}`);
  if (spec.changelog?.required) { const re = new RegExp("^" + spec.changelog.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace("\\{issue\\}", String(issueNumber)).replace("{issue}", String(issueNumber)).replace(/\{type\}/g, "[a-z]+") + "$"); add("changelog entry present", paths.some((p) => re.test(p)), `this project requires a changelog file like ${spec.changelog.path}`); }
  const hidden = [...paths.flatMap((p) => hiddenChars(files[p]).map((c) => `${p} ${c}`)), ...paths.filter((p) => files[p].includes("\0") || files[p].includes("\ufffd")).map((p) => `${p} is not valid text`), ...paths.flatMap((p) => hiddenChars(p).map((c) => `path ${JSON.stringify(p)} ${c}`)), ...paths.filter((p) => p !== p.normalize("NFC")).map((p) => `path ${JSON.stringify(p)} is not NFC`)];
  add("no hidden characters in the files", hidden.length === 0, hidden.slice(0, 5).join(", "));
  const flagged = scanAdded(files);
  if (typeof flags === "function") flags = flags({ spec, flagged, user });
  add("no code that reads the environment, uses the network or starts processes", flagged.length === 0 || flags.allowFlaggedCode === true, flagged.slice(0, 5).join("; ") + (flagged.length > 5 ? ` (+${flagged.length - 5} more)` : "") + " (shown for review; pass --allow-flagged-code after reading)");

  // 7. load on the maintainers
  const pulls = guard("count open pull requests", () => gh.openPulls(repo.id));
  if (pulls) {
    if (add("open pull requests could be counted", !pulls.truncated, "too many open pull requests to count safely")) {
      const ours = pulls.pulls.filter(isOurPr);
      const cap = Math.min(spec.max_open_agent_prs, TOOL_MAX_OPEN);
      add("project is under its open agent PR limit", ours.length < cap, `${ours.length} open, limit ${cap}`);
      add("you have no other open agent PR here", !ours.some((p) => p.userId === user.id), "you already have an open agent PR in this project");
      add("no other agent PR targets this issue", !ours.some((p) => new RegExp(`(^|[^0-9A-Za-z])#${issueNumber}\\b`).test(p.body) || p.body.includes(`/issues/${issueNumber}`)), "another agent PR already references this issue");
    }
    const total = guard("search for agent pull requests", () => gh.searchOpenAgentPrs(repo.fullName, `<!-- ${MARKER_PREFIX} `));
    if (total !== undefined) add("search finds no more agent PRs than the limit allows", total < Math.min(spec.max_open_agent_prs, TOOL_MAX_OPEN), `search reports ${total} (advisory; it lags)`);
  }
  const recent = ledger.filter((l) => l.userId === user.id && now - l.at < DAY);
  const last = ledger.filter((l) => l.repoId === repo.id && l.ownerId !== undefined).at(-1);
  if (last) add("the project's owner is unchanged since your last publish here", last.ownerId === repo.ownerId, "the repository now belongs to a different owner than when you last published; the old owner's opt-in is not the new owner's consent. Ask the new owner");
  // The per-project interval reads the WHOLE ledger (not `recent`, which is cut at 24h, or an interval over 24h would silently stop binding).
  const hours = spec.min_hours_between_prs;
  if (add("the project's publish interval is valid", Number.isSafeInteger(hours) && hours >= MIN_HOURS_BETWEEN_PRS[0] && hours <= MIN_HOURS_BETWEEN_PRS[1], "the interval in the opt-in file is missing or out of range")) {
    const here = ledger.filter((l) => l.userId === user.id && l.repoId === repo.id);
    if (add("your ledger times for this project are readable", here.every((l) => Number.isFinite(l.at) && Math.abs(l.at) <= 8.64e15 - hours * 3600e3), "an entry for this project has no usable time; fix or remove it by hand, then retry")) {
      const newest = here.reduce((m, l) => Math.max(m, l.at), -Infinity);
      const blocked = here.length > 0 && now - newest < hours * 3600e3;
      const detail = blocked ? `your ledger shows a publish to this project at ${new Date(newest).toISOString()}; this project asks for ${hours} hours between pull requests, so the earliest is ${new Date(newest + hours * 3600e3).toISOString()}${hours > 24 ? " (if the project raised its interval since your last publish, that applies to it too)" : ""}` : "";
      add(`not already published here in the last ${hours} hours`, !blocked, detail);
    }
  }
  add("under the daily limit across projects", recent.length < TOOL_MAX_PER_DAY, `${recent.length} publishes in the last 24 hours, limit ${TOOL_MAX_PER_DAY}`);

  // 7b. earlier PRs of yours that are waiting on you: a project's reviewers must not be left hanging while you open more
  const waiting = [];
  for (const l of ledger.filter((x) => x.userId === user.id && x.number && now - x.at < 90 * DAY)) {
    const st = guard(`read your earlier PR #${l.number}`, () => ({ pr: gh.pull(l.repoId, l.number), reviews: gh.reviews(l.repoId, l.number) }));
    if (!st || st.pr.state !== "open") continue;
    const cr = st.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.submittedAt).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1);
    if (cr && now - Date.parse(cr.submittedAt) > 7 * DAY && Date.parse(st.pr.updatedAt) <= Date.parse(cr.submittedAt)) waiting.push(`#${l.number} (changes requested ${cr.submittedAt.slice(0, 10)}, no activity since)`);
  }
  add("none of your earlier PRs is waiting on you", waiting.length === 0, `answer or close first: ${waiting.join(", ")}`);

  // 8. certification the human must make
  ack.cla = flags.claSigned === true; ack.dco = flags.certifyDco === true; ack.flagged = flags.allowFlaggedCode === true;
  if (spec.certification.cla !== "none") add("CLA acknowledged", flags.claSigned === true, `this project requires a ${spec.certification.cla} CLA; pass --cla-signed once YOU have signed it (it can bind your employer)`);
  if (spec.certification.dco === "signed-off-by") add("DCO certification given", flags.certifyDco === true, "this project requires a Signed-off-by line; pass --certify-dco only if YOU can certify the Developer Certificate of Origin for this change");

  return result({ spec, diff, issueTitle: issue.title, info: { intervalHours: spec.min_hours_between_prs, contact: spec.contact, policyUrl: spec.policy_url, safetyReason: spec.safety_reason, safetyCritical: spec.safety_critical, flagged }, bound: { ack, repoId: repo.id, ownerId: repo.ownerId, fullName: repo.fullName, defaultBranch: repo.defaultBranch, base: record.base, head, specBlobSha: f.blobSha, specCommit: lc?.sha ?? null, recordSha: record.recordSha, issueNumber, user: { login: user.login, id: user.id, name: user.name, email: user.email } } });
}

export { isPlainText };
