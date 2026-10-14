/**
 * Read-only GitHub queries for `prior-art` (Goal 4, Q2), through the same injectable runner as ghclient.mjs (the user's own `gh`; a fake in tests).
 * Rules, as in ghclient.mjs: every response is shape-checked; an HTTP error, a surprise or an incomplete answer is a refusal, never "none found".
 * Added here because the answers describe OTHER people's projects: every string that came from GitHub is cleaned at this boundary (control
 * characters, ANSI escapes, hidden characters, length), and nothing a person typed can add a search qualifier (org:, user:, repo:, is:private).
 * "unknown" (null) is a real answer: the endpoint could not say. It is never turned into a yes.
 */
import { createGh, GhError } from "./ghclient.mjs";
import { OPTIN_PATH, isPrintable, parseOptIn } from "./optin.mjs";

export const LIMITS = { maxTerms: 8, maxResults: 30, commitsPage: 100, responseWindow: 20, responseReplies: 5, maxDetailCalls: 5 };

const FULL_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TERM = /^[a-z0-9][a-z0-9_.-]{1,39}$/;
const LANGUAGE = /^[A-Za-z0-9+#.-]{1,30}$/;
const SHA = /^[a-f0-9]{40}$/;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

const isDate = (s) => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s));
const goodName = (s) => typeof s === "string" && FULL_NAME.test(s) && s.split("/").every((x) => x !== "." && x !== "..");

/** Text from GitHub, made safe to print: escapes and hidden characters become spaces, runs of space collapse, length is capped (by code point). */
export function clean(v, max) {
  if (typeof v !== "string") return "";
  const s = [...v.replace(ANSI, " ").normalize("NFC")].map((ch) => (isPrintable(ch) ? ch : " ")).join("").replace(/ +/g, " ").trim();
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max - 1).join("") + "…" : s;
}

/**
 * The search string for repositories, from already-split terms. Terms are lowercase words only, so a description cannot add a qualifier
 * (`org:`, `repo:`, `user:`), a quote or an operator. Always: public, not archived, not a fork; matched in name, description and topics
 * (the same fields the overlap in the design note reads).
 */
export function buildQuery({ terms, language } = {}) {
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > LIMITS.maxTerms || !terms.every((t) => typeof t === "string" && TERM.test(t))) throw new GhError(`search terms: 1 to ${LIMITS.maxTerms} lowercase words (letters, digits, . _ -)`);
  if (language !== undefined && !(typeof language === "string" && LANGUAGE.test(language))) throw new GhError("search language: letters, digits and + # . - only");
  return `${terms.join(" ")} in:name,description,topics is:public archived:false fork:false${language ? ` language:${language}` : ""}`;
}

const counted = (run, max) => {
  let n = 0;
  return { run: (a, o) => { if (++n > max) throw new GhError(`more than ${max} GitHub calls for one candidate; refusing`); return run(a, o); }, calls: () => n };
};

const methods = (run) => {
  const gh = createGh(run);
  const get = (path) => gh.get(path);
  const absentIs = (codes, path, orElse) => { try { return get(path); } catch (e) { if (e instanceof GhError && codes.includes(e.httpStatus)) return orElse; throw e; } };

  /** One page of repository search. `moreAvailable` says GitHub has more than were asked for; `incomplete_results` (a timed-out search) refuses. */
  const searchRepos = ({ terms, language, limit = 10 }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxResults) throw new GhError(`search limit: 1 to ${LIMITS.maxResults}`);
    const q = buildQuery({ terms, language });
    const r = get(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}`);
    if (!r || typeof r !== "object" || !Number.isInteger(r.total_count) || r.total_count < 0 || typeof r.incomplete_results !== "boolean" || !Array.isArray(r.items)) throw new GhError("search: unexpected answer");
    if (r.incomplete_results) throw new GhError("search: GitHub says the answer is incomplete (the search timed out); not treating it as the whole answer");
    if (r.items.length > limit) throw new GhError("search: more items than requested");
    const seen = new Set();
    const items = r.items.map((x) => {
      if (!x || typeof x !== "object" || !Number.isInteger(x.id) || !goodName(x.full_name) || typeof x.archived !== "boolean" || typeof x.fork !== "boolean" || typeof x.private !== "boolean" || !isDate(x.pushed_at) || !Number.isInteger(x.open_issues_count) || x.open_issues_count < 0 || typeof x.default_branch !== "string" || x.default_branch.length === 0) throw new GhError("search: an item has an unexpected shape");
      if (x.private) throw new GhError("search: a private repository came back from a public search; refusing");
      if (x.html_url !== `https://github.com/${x.full_name}`) throw new GhError("search: an item's link does not match its name");
      if (x.description != null && typeof x.description !== "string") throw new GhError("search: an item's description has the wrong type");
      if (x.topics != null && !(Array.isArray(x.topics) && x.topics.every((t) => typeof t === "string"))) throw new GhError("search: an item's topics have the wrong type");
      if (x.license != null && !(typeof x.license === "object" && (x.license.spdx_id == null || typeof x.license.spdx_id === "string"))) throw new GhError("search: an item's license has the wrong shape");
      if (seen.has(x.id)) throw new GhError("search: the same repository twice");
      seen.add(x.id);
      return { id: x.id, fullName: x.full_name, url: x.html_url, description: clean(x.description, 200), topics: (x.topics ?? []).slice(0, 20).map((t) => clean(t, 50)).filter(Boolean), license: x.license?.spdx_id ? clean(x.license.spdx_id, 40) : null, archived: x.archived, fork: x.fork, pushedAt: x.pushed_at, openIssues: x.open_issues_count, defaultBranch: x.default_branch };
    });
    return { total: r.total_count, items, moreAvailable: r.total_count > items.length, query: q };
  };

  /** The latest published release's date, or null when the project has no GitHub release (a 404 is a real answer). */
  const latestRelease = (id) => {
    const r = absentIs([404], `/repositories/${id}/releases/latest`, null);
    if (r === null) return { publishedAt: null };
    if (!r || typeof r !== "object" || !isDate(r.published_at)) throw new GhError("release: unexpected answer");
    return { publishedAt: r.published_at };
  };

  /**
   * People with commits since `since` among the most recent 100 commits. Bots are counted apart. A full page means "at least": that can only
   * UNDER-count a busy project, which makes it look less alive, never more. An author GitHub cannot link to an account is counted by email
   * (kept in memory only, never returned).
   */
  const recentContributors = (id, since) => {
    if (!isDate(since)) throw new GhError("since: an ISO date like 2025-10-13T00:00:00Z");
    const r = absentIs([409], `/repositories/${id}/commits?since=${encodeURIComponent(since)}&per_page=${LIMITS.commitsPage}&page=1`, []);
    if (!Array.isArray(r) || r.length > LIMITS.commitsPage) throw new GhError("commits: expected a list");
    const people = new Set(), bots = new Set();
    for (const c of r) {
      if (!c || typeof c !== "object" || !SHA.test(c.sha ?? "")) throw new GhError("commits: an item has an unexpected shape");
      const a = c.author;
      if (a && typeof a === "object" && Number.isInteger(a.id)) { (a.type === "Bot" ? bots : people).add(a.id); continue; }
      const email = c.commit?.author?.email;
      if (typeof email !== "string" || email.length === 0) throw new GhError("commits: a commit has no author");
      people.add(`email:${email.toLowerCase()}`);
    }
    return { contributors: people.size, bots: bots.size, commits: r.length, atLeast: r.length === LIMITS.commitsPage };
  };

  /**
   * Hours until someone other than the author, and not a bot, first commented or reviewed, for the last 20 closed issues and pull requests
   * (most recently updated first). One GraphQL read. `responded` < `considered` means some had no reply among the first 5 comments and reviews.
   */
  const responseTimes = (fullName) => {
    if (!goodName(fullName)) throw new GhError("repository must be owner/name");
    const reply = "createdAt author{login __typename}";
    const q = `query($q:String!){search(query:$q,type:ISSUE,first:${LIMITS.responseWindow}){nodes{__typename ... on Issue{createdAt author{login __typename} comments(first:${LIMITS.responseReplies}){nodes{${reply}}}} ... on PullRequest{createdAt author{login __typename} comments(first:${LIMITS.responseReplies}){nodes{${reply}}} reviews(first:${LIMITS.responseReplies}){nodes{${reply}}}}}}}`;
    const r = run(["api", "graphql", "-f", `query=${q}`, "-f", `q=repo:${fullName} is:closed sort:updated-desc`]);
    let j; try { j = JSON.parse(r.stdout); } catch { throw new GhError(r.status !== 0 ? "GitHub GraphQL request failed (response times)" : "GraphQL answer is not JSON (response times)"); }
    if (r.status !== 0 || (Array.isArray(j?.errors) && j.errors.length > 0)) throw new GhError("GitHub GraphQL request failed (response times)");
    const nodes = j?.data?.search?.nodes;
    if (!Array.isArray(nodes) || nodes.length > LIMITS.responseWindow) throw new GhError("GraphQL answer has no search results (response times)");
    const hours = [];
    for (const n of nodes) {
      if (!n || typeof n !== "object" || !["Issue", "PullRequest"].includes(n.__typename) || !isDate(n.createdAt)) throw new GhError("response times: an item has an unexpected shape");
      const list = [...(n.comments?.nodes ?? []), ...(n.reviews?.nodes ?? [])];
      const opened = Date.parse(n.createdAt);
      let first = null;
      for (const c of list) {
        if (!c || typeof c !== "object" || !isDate(c.createdAt)) throw new GhError("response times: a reply has an unexpected shape");
        const who = c.author;
        if (!who || typeof who.login !== "string" || who.__typename === "Bot" || who.login === n.author?.login) continue; // a deleted account, a bot or the author is not a response
        const t = Date.parse(c.createdAt);
        if (t < opened) throw new GhError("response times: a reply is dated before the item");
        if (first === null || t < first) first = t;
      }
      if (first !== null) hours.push(Math.round(((first - opened) / 3600000) * 10) / 10);
    }
    return { considered: nodes.length, responded: hours.length, hours };
  };

  /**
   * What the file listing says. true / false / null (unknown). A truncated listing can prove presence but never absence, so a miss there is null.
   * Tests: a test, tests, spec, specs or __tests__ directory at ANY depth (monorepos keep them under packages/NAME/test; a real run on a popular
   * monorepo read "no tests" when only the top level was looked at), or a *.test.* / *.spec.* / *_test.go / test_*.py file. CI: a .github/workflows file.
   * (The test patterns are provisional, like the thresholds: they exist so monorepos, Go and Python projects are not marked "no tests".)
   */
  const repoFiles = (id, branch) => {
    const r = absentIs([404, 409], `/repositories/${id}/git/trees/${encodeURIComponent(branch)}?recursive=1`, null);
    if (r === null) return { ci: null, tests: null, optinListed: null, truncated: null };
    if (!r || typeof r !== "object" || !Array.isArray(r.tree) || typeof r.truncated !== "boolean") throw new GhError("tree: unexpected answer");
    let ci = false, tests = false, optinListed = false;
    for (const e of r.tree) {
      if (!e || typeof e.path !== "string" || typeof e.type !== "string") throw new GhError("tree: an entry has an unexpected shape");
      const p = e.path;
      if (e.type === "blob" && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) ci = true;
      if (e.type === "blob" && p === OPTIN_PATH) optinListed = true;
      if ((e.type === "tree" && /(^|\/)(tests?|specs?|__tests__)$/.test(p)) || (e.type === "blob" && /(^|\/)(?:[^/]+\.(?:test|spec)\.[A-Za-z0-9]+|[^/]+_test\.go|test_[^/]+\.py)$/.test(p))) tests = true;
    }
    const unknownIfMissing = (found) => (found ? true : r.truncated ? null : false);
    return { ci: unknownIfMissing(ci), tests: unknownIfMissing(tests), optinListed: unknownIfMissing(optinListed), truncated: r.truncated };
  };

  /** The opt-in file at a ref, read and checked with the same parser the publisher uses. A 404 is "not opted in". */
  const optin = (id, ref, now = Date.now()) => {
    let f;
    try { f = gh.file(id, OPTIN_PATH, ref); } catch (e) {
      if (!(e instanceof GhError)) throw e;
      if (e.httpStatus === 404) return { present: false };
      // Only the file's own problems (a directory, a symlink, too large, not base64: all worded "opt-in ..." by gh.file) make it invalid.
      // A rate limit, a server error, a malformed answer or the call cap is a stop.
      if (e.httpStatus !== undefined || !/^opt-in /.test(e.message)) throw e;
      return { present: true, valid: false, errors: [clean(e.message, 120)] };
    }
    const p = parseOptIn(f.bytes, { now });
    if (!p.ok) return { present: true, valid: false, errors: p.errors.slice(0, 3).map((x) => clean(x, 120)) };
    const v = p.value;
    return { present: true, valid: true, paused: v.paused, intervalHours: v.min_hours_between_prs, contact: v.contact, reviewBy: v.review_by };
  };

  return { searchRepos, latestRelease, recentContributors, responseTimes, repoFiles, optin };
};

export function createSearch(run) {
  return {
    ...methods(run),
    /**
     * Everything the report needs about one candidate: at most 4 reads, plus one more only when the project carries an opt-in file.
     * A GitHub error stops it (the caller labels the run PARTIAL); only "the endpoint could not say" is `null`.
     */
    facts(cand, { since, now = Date.now(), maxCalls = LIMITS.maxDetailCalls }) {
      if (!cand || !Number.isInteger(cand.id) || !goodName(cand.fullName) || typeof cand.defaultBranch !== "string") throw new GhError("candidate: id, fullName and defaultBranch are required");
      const c = counted(run, maxCalls), m = methods(c.run);
      const release = m.latestRelease(cand.id);
      const contributors = m.recentContributors(cand.id, since);
      const response = m.responseTimes(cand.fullName);
      const files = m.repoFiles(cand.id, cand.defaultBranch);
      // Listed in the tree: read it. Listing truncated or unavailable (null): ask directly. Listed as absent: do not spend a call.
      const opt = files.optinListed === false ? { present: false } : m.optin(cand.id, cand.defaultBranch, now);
      return { id: cand.id, fullName: cand.fullName, lastReleaseAt: release.publishedAt, contributors, response, ci: files.ci, tests: files.tests, treeTruncated: files.truncated, optin: opt, apiCalls: c.calls() };
    },
  };
}
