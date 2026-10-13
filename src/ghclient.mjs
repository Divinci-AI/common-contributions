/**
 * Read-only GitHub queries for the publisher, through ONE injectable runner (the user's own `gh` in production, a fake in tests).
 * Rules: ids not names (a renamed or transferred repo keeps its id); every response is shape-checked; an error, a truncated list or a surprise
 * is a refusal, never a skip; the harness never sees a token (gh holds it).
 */
import { spawnSync } from "node:child_process";
import { MAX_BYTES } from "./optin.mjs";

export class GhError extends Error {
  constructor(message, { status, path } = {}) { super(message); this.name = "GhError"; this.httpStatus = status; this.path = path; }
}

/** The real runner: absolute gh path, environment reduced to PATH and HOME (gh needs HOME for its own credentials). */
export function ghRunner(ghPath) {
  if (!ghPath?.startsWith("/")) throw new Error("gh must be an absolute path");
  return (args, { input } = {}) => {
    const r = spawnSync(ghPath, args, { env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
const num = (v) => Number.isInteger(v) && v >= 0;
const str = (v) => typeof v === "string";
const need = (o, shape, what) => {
  if (!o || typeof o !== "object") throw new GhError(`${what}: not an object`);
  for (const [k, t] of Object.entries(shape)) {
    const v = o[k];
    const ok = t === "n" ? num(v) : t === "s" ? str(v) : t === "b" ? typeof v === "boolean" : t === "o" ? v && typeof v === "object" : t === "n?" ? v == null || num(v) : t === "s?" ? v == null || str(v) : false;
    if (!ok) throw new GhError(`${what}: field "${k}" is missing or has the wrong type`);
  }
  return o;
};

export function createGh(run) {
  const get = (path) => {
    const r = run(["api", ...HEADERS, path]);
    if (r.status !== 0) {
      const m = /HTTP (\d{3})/.exec(r.stderr ?? "");
      throw new GhError(`GitHub request failed: ${path.split("?")[0]} (${m ? "HTTP " + m[1] : "no response"})`, { status: m ? Number(m[1]) : undefined, path });
    }
    try { return JSON.parse(r.stdout); } catch { throw new GhError(`GitHub answered with something that is not JSON: ${path.split("?")[0]}`, { path }); }
  };
  /** All pages up to `maxPages`; `truncated` says there were more (the caller must refuse). */
  const pages = (path, { maxPages = 5, key } = {}) => {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const arr = key ? r?.[key] : r;
      if (!Array.isArray(arr)) throw new GhError(`${path.split("?")[0]}: expected a list`);
      items.push(...arr);
      if (arr.length < 100) return { items, truncated: false };
    }
    return { items, truncated: true };
  };
  return {
    get, pages,
    /** The repository, by owner/name (the only lookup by name; everything after uses the id). */
    repo(ownerName) {
      if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(ownerName) || ownerName.split("/").some((x) => x === "." || x === "..")) throw new GhError("repository must be owner/name");
      const r = need(get(`/repos/${ownerName}`), { id: "n", full_name: "s", default_branch: "s", archived: "b", fork: "b", private: "b", owner: "o" }, "repo");
      need(r.owner, { id: "n", login: "s" }, "repo.owner");
      return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, archived: r.archived, disabled: r.disabled === true, fork: r.fork, private: r.private, ownerId: r.owner.id, ownerLogin: r.owner.login };
    },
    branchHead(id, branch) {
      const r = need(get(`/repositories/${id}/branches/${encodeURIComponent(branch)}`), { commit: "o" }, "branch");
      if (!/^[a-f0-9]{40}$/.test(r.commit.sha ?? "")) throw new GhError("branch: bad commit sha");
      return r.commit.sha;
    },
    /** `ahead` or `identical`: the base is an ancestor of the head. Anything else is not. */
    compare(id, base, head) {
      const r = need(get(`/repositories/${id}/compare/${base}...${head}`), { status: "s" }, "compare");
      return { status: r.status, files: Array.isArray(r.files) ? r.files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]) : null, truncatedFiles: (r.files?.length ?? 0) >= 300 };
    },
    /** The opt-in file at a ref: bytes and blob sha, or throws. */
    file(id, path, ref) {
      const r = get(`/repositories/${id}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(r)) throw new GhError("opt-in path is a directory");
      need(r, { type: "s", size: "n", sha: "s", encoding: "s", content: "s" }, "contents");
      if (r.type !== "file") throw new GhError(`opt-in path is a ${r.type}, not a file`);
      if (r.size > MAX_BYTES) throw new GhError("opt-in file is too large");
      if (r.encoding !== "base64") throw new GhError("opt-in file encoding is not base64");
      return { bytes: Buffer.from(r.content, "base64"), blobSha: r.sha };
    },
    lastCommit(id, path, ref) {
      const r = get(`/repositories/${id}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`);
      if (!Array.isArray(r) || r.length !== 1) throw new GhError("no commit found for the opt-in file");
      const c = r[0];
      return { sha: c.sha, date: c.commit?.committer?.date ?? null, authorLogin: c.author?.login ?? null, authorType: c.author?.type ?? null };
    },
    user(login) {
      const r = need(get(`/users/${encodeURIComponent(login)}`), { id: "n", login: "s", type: "s" }, "user");
      return { id: r.id, login: r.login, type: r.type };
    },
    issue(id, n) {
      const r = need(get(`/repositories/${id}/issues/${n}`), { number: "n", state: "s", title: "s", body: "s?", labels: "o", repository_url: "s", created_at: "s", user: "o" }, "issue");
      return { number: r.number, state: r.state, title: r.title, body: r.body ?? "", labels: r.labels.map((l) => (typeof l === "string" ? l : l.name)), isPullRequest: "pull_request" in r, repositoryUrl: r.repository_url, createdAt: r.created_at, authorId: r.user.id, assignees: (r.assignees ?? []).map((a) => a.login) };
    },
    issueEvents(id, n) {
      const { items, truncated } = pages(`/repositories/${id}/issues/${n}/events`, { maxPages: 5 });
      if (truncated) throw new GhError("too many issue events to read; refusing");
      return items.map((e) => ({ event: e.event, rename: e.rename ?? null, label: e.label?.name ?? null, actorId: e.actor?.id ?? null, actorType: e.actor?.type ?? null, actorLogin: e.actor?.login ?? null, createdAt: e.created_at }));
    },
    /**
     * Pull requests that mention the issue (from its timeline), by anyone: what a person or another agent has already put forward.
     * A mention is not proof of a fix, so callers treat this as "look before you spend", not as a verdict.
     */
    priorWork(id, n) {
      const { items, truncated } = pages(`/repositories/${id}/issues/${n}/timeline`, { maxPages: 5 });
      if (truncated) throw new GhError("too many timeline events to read; refusing");
      const seen = new Map();
      for (const e of items) {
        const i = e?.event === "cross-referenced" ? e.source?.issue : null;
        if (!i || !i.pull_request || !Number.isInteger(i.number)) continue;
        const merged = typeof i.pull_request.merged_at === "string";
        const state = merged ? "merged" : i.state === "open" ? "open" : "closed";
        const url = typeof i.html_url === "string" && /^https:\/\/github\.com\//.test(i.html_url) ? i.html_url : null;
        seen.set(i.number, { number: i.number, state, title: String(i.title ?? "").slice(0, 120), by: typeof i.user?.login === "string" ? i.user.login : null, url, repoId: i.repository?.id ?? null });
      }
      return [...seen.values()];
    },
    /** GraphQL: when the issue's title or body was last edited by anyone (null if never). */
    issueLastEdit(owner, name, n) {
      const q = "query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt}}}";
      const r = run(["api", "graphql", "-f", `query=${q}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `i=${n}`]);
      if (r.status !== 0) throw new GhError("GitHub GraphQL request failed");
      let j; try { j = JSON.parse(r.stdout); } catch { throw new GhError("GraphQL answer is not JSON"); }
      const issue = j?.data?.repository?.issue;
      if (!issue || !("lastEditedAt" in issue)) throw new GhError("GraphQL answer has no issue");
      return issue.lastEditedAt;
    },
    pull(id, n) {
      const r = need(get(`/repositories/${id}/pulls/${n}`), { state: "s", updated_at: "s" }, "pull");
      return { state: r.state, updatedAt: r.updated_at, merged: r.merged === true };
    },
    reviews(id, n) {
      const { items, truncated } = pages(`/repositories/${id}/pulls/${n}/reviews`, { maxPages: 2 });
      if (truncated) throw new GhError("too many reviews to read; refusing");
      return items.map((x) => ({ state: x.state, submittedAt: x.submitted_at ?? null, login: x.user?.login ?? null }));
    },
    openPulls(id) {
      const { items, truncated } = pages(`/repositories/${id}/pulls?state=open`, { maxPages: 5 });
      return { truncated, pulls: items.map((p) => ({ number: p.number, headRef: p.head?.ref ?? "", headRepoId: p.head?.repo?.id ?? null, userId: p.user?.id ?? null, userLogin: p.user?.login ?? null, body: p.body ?? "", headSha: p.head?.sha ?? null })) };
    },
    /** Advisory only: the search index lags, so a just-opened PR is missing from it. */
    searchOpenAgentPrs(fullName, marker) {
      const r = need(get(`/search/issues?q=${encodeURIComponent(`repo:${fullName} is:pr is:open "${marker}" in:body`)}`), { total_count: "n" }, "search");
      return r.total_count;
    },
    /** Merged PRs by `login` in the repo, from the issues list (no search lag); truncated lists refuse upstream. */
    mergedPrsBy(id, login) {
      const { items, truncated } = pages(`/repositories/${id}/issues?state=closed&creator=${encodeURIComponent(login)}`, { maxPages: 3 });
      return { merged: items.filter((i) => i.pull_request?.merged_at).length, truncated };
    },
  };
}
