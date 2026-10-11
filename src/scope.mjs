/**
 * Task contract and diff scope. A maintainer opts a task in by label; the issue names the ONE file the agent may add.
 * Anything outside that scope fails the run — the agent never gets to decide that a bigger change is fine.
 */
export const OPT_IN_LABEL = "agent-ready";

export function isOptedIn(issue) {
  return (issue.labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === OPT_IN_LABEL);
}

/**
 * Paths an issue allows the agent to touch: the backticked paths in the parenthesis of its "## Done when" heading,
 * e.g. "## Done when (one file: `orchestrator/src/provenance.test.ts`)". Conservative: if nothing can be parsed, or a
 * path is absolute / contains "..", the task is NOT runnable.
 */
export function allowedPaths(issueBody) {
  const body = String(issueBody ?? "");
  const header = /^##\s*Done when[^\n]*\((?:one file|files?):\s*([^)]*)\)/im.exec(body);
  if (!header) return [];
  return [...header[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((p) => isSafeRelativePath(p) && !isConfigFile(p));
}

export function isSafeRelativePath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("..") && !p.includes("\\") && !/^[a-z]+:/i.test(p);
}

/**
 * Files that change what runs (dependencies, install scripts, test and compiler config). A task may never touch them: the
 * dependency image is built from these, so letting a contribution edit them would make the image and the code diverge.
 */
const CONFIG_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?|requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|conftest\.py|pytest\.ini|tox\.ini|vitest\.config\.[^/]+|vitest\.workspace\.[^/]+|jest\.config\.[^/]+|tsconfig[^/]*\.json)$/;
export const isConfigFile = (p) => CONFIG_FILE.test(String(p));

/** Files changed outside the allowed set, or empty list when the diff stays in scope. */
export function diffScopeViolations(changedFiles, allowed) {
  const ok = new Set(allowed);
  return changedFiles.filter((f) => !ok.has(f));
}

/** Branch the agent may push to. Never main/master/preview, never anything outside the agent/ namespace. */
export function isAgentBranch(name) {
  return (
    typeof name === "string" &&
    /^agent\/[A-Za-z0-9._-]+$/.test(name) &&
    !name.includes("..") &&
    !name.endsWith(".lock") &&
    !/(^|\/)(main|master|preview)$/.test(name)
  );
}

export function selectRunnableTasks(issues) {
  return issues
    .filter((i) => isOptedIn(i))
    .map((i) => ({ number: i.number, title: i.title, body: i.body, allowed: allowedPaths(i.body) }))
    .filter((t) => t.allowed.length > 0);
}
