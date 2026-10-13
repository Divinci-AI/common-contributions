/**
 * Texts, the commit, and the approval token. The commit is REBUILT from the recorded base commit and the recorded file contents with git plumbing in a
 * private index: nothing is read from a working tree, no filter runs, and the same inputs always give the same commit sha (its dates are the record's).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER_PREFIX } from "./publish.mjs";
import { gitBlobId } from "./record.mjs";
import { hiddenChars, isPlainText } from "./optin.mjs";
import { scanForSecrets, scanAddedForEntropy } from "./secrets.mjs";

/** Hostile repository text can carry a key into a commit message or PR; findings name the kind only, never the text. */
const secretKinds = (s) => [...new Set([...scanForSecrets(s), ...scanAddedForEntropy(String(s))].map((f) => f.kind))];
function noSecrets(s, what) { const k = secretKinds(s); if (k.length) throw new Error(`${what} looks like it contains a secret (${k.join(", ")}); it was not used`); return s; }

const NOT_SAFE_TEXT = (s) => hiddenChars(s).length > 0 || /@/.test(s);
/** Closing keywords and issue references notify or CLOSE things in other places. The tool adds its own `Refs #N`; a human's text may not add others. */
const REFERENCES = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[^\n]{0,20}#\d|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|(^|[^A-Za-z0-9_&])#\d+/i;

/** The PR title and commit subject come from target-repo issue text, so they are filtered like everything else a human will read. */
export function cleanTitle(raw) {
  const t = String(raw).replace(/\s+/g, " ").trim();
  if (!t) throw new Error("the issue title is empty");
  if (t.length > 120) throw new Error("the issue title is longer than 120 characters");
  noSecrets(t, "the issue title");
  if (REFERENCES.test(t)) throw new Error("the issue title contains an issue reference or a closing keyword; write the title yourself with --title");
  if (NOT_SAFE_TEXT(t) || /https?:|www\.|\]\(|<|>|`/.test(t)) throw new Error("the issue title has hidden characters, a link, markup or an @ mention; write the title yourself with --title");
  return t;
}

export function cleanDescription(text, issueNumber) {
  if (typeof text !== "string" || text.trim().length < 20) throw new Error("the PR description must be written by you (at least 20 characters); pass --description-file");
  if (text.length > 5000) throw new Error("the PR description is longer than 5000 characters");
  if (hiddenChars(text).length > 0) throw new Error("the PR description has hidden characters");
  noSecrets(text, "the PR description");
  if (/@/.test(text)) throw new Error("the PR description has an @ (mentions notify people; remove it)");
  if (/!\[/.test(text)) throw new Error("the PR description has an image");
  if (/<!--|<[A-Za-z\/]/.test(text)) throw new Error("the PR description has raw HTML or a comment (it could forge the marker or track readers)");
  for (const m of text.matchAll(/(^|[^A-Za-z0-9_&])#(\d+)/g)) if (issueNumber === undefined || Number(m[2]) !== issueNumber) throw new Error(`the PR description references #${m[2]}; mention only the issue this change is for (it would notify other threads)`);
  if (/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[^\n]{0,20}#\d|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/i.test(text)) throw new Error("the PR description has a closing keyword or a cross-repository reference");
  return text.trim();
}

const tok = (s) => String(s ?? "").replace(/[^A-Za-z0-9._:\/+-]/g, "-").slice(0, 60);

export function buildCommitMessage({ title, issueNumber, spec, flags = {}, user, model }) {
  const trailers = [];
  if (spec.disclosure.mechanism === "commit_trailer" || spec.certification.dco === "signed-off-by") trailers.push(`Assisted-by: Common-Contributions/${tok(model) || "unknown-model"}`);
  if (spec.certification.dco === "signed-off-by" && flags.certifyDco === true) trailers.push(`Signed-off-by: ${cleanPerson(user.name)} <${cleanEmail(user.email)}>`);
  return `${cleanTitle(title)}\n\nRefs #${issueNumber}\n${trailers.length ? "\n" + trailers.join("\n") + "\n" : ""}`;
}
const cleanPerson = (n) => { if (!/^[^<>\n@]{1,80}$/.test(n ?? "") || hiddenChars(n).length) throw new Error("your git user.name is not usable in a trailer"); return n; };
const cleanEmail = (e) => { if (!/^[^\s<>@]{1,64}@[^\s<>@]{1,120}$/.test(e ?? "") || hiddenChars(e).length) throw new Error("your git user.email is not usable"); return e; };

export function buildPrBody({ description, spec, issueNumber, record, specBlobSha }) {
  const parts = [cleanDescription(description, issueNumber)];
  if (spec.disclosure.mechanism === "pr_body") parts.push(spec.disclosure.text);
  parts.push(`Refs #${issueNumber}`);
  parts.push(`Checked in a container by Common Contributions (self-reported run ${record.recordSha.slice(0, 12)}, harness ${String(record.harness.commit ?? "unknown").slice(0, 12)}). A project's own CI is the real check.`);
  parts.push(`<!-- ${MARKER_PREFIX} run=${record.recordSha} harness=${record.harness.commit ?? "none"} spec=${specBlobSha} -->`);
  return parts.join("\n\n") + "\n";
}

export function branchName(issueNumber, title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `agent/${issueNumber}${slug ? "-" + slug : ""}`;
}

const g = (args, opts = {}) => spawnSync("/usr/bin/git", args, { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: opts.input, cwd: opts.cwd });

/**
 * Build the commit object in `repoDir`'s object database without touching its index, working tree or refs.
 * Dates are the record's creation time, so the same record always gives the same sha. Returns {sha, tree}.
 */
export function buildCommit({ repoDir, base, files, message, author, when }) {
  const tmp = mkdtempSync(join(tmpdir(), "cc-idx-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  const run = (args, input) => { const r = g(["-C", repoDir, ...args], { env, input }); if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim().slice(0, 200)}`); return r.stdout.trim(); };
  try {
    run(["read-tree", base]);
    for (const [path, content] of Object.entries(files)) {
      const sha = run(["hash-object", "-w", "--no-filters", "--stdin"], content);
      if (sha !== gitBlobId(content)) throw new Error(`blob for ${path} does not match the recorded blob id`);
      run(["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`]);
    }
    const tree = run(["write-tree"]);
    const date = `${Math.floor(Date.parse(when) / 1000)} +0000`;
    const cenv = { ...env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const r = g(["-C", repoDir, "commit-tree", tree, "-p", base, "-F", "-"], { env: cenv, input: message });
    if (r.status !== 0) throw new Error(`git commit-tree failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    return { sha: r.stdout.trim(), tree };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Binds everything that was planned. Any change to any of it gives a different token. */
export function approvalToken({ bound, commitSha, title, body, branch }) {
  return createHash("sha256").update(canonical({ ...bound, commitSha, title, body, branch })).digest("hex").slice(0, 32);
}
