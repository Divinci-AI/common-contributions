/** A fake GitHub behind the same runner interface as `gh`. World shape documented by `defaultWorld`. Unknown paths answer 404 like GitHub would. */
export function defaultWorld() {
  const sha = (c) => c.repeat(40);
  return {
    calls: [],
    repo: { id: 1001, full_name: "acme/widgets", default_branch: "main", archived: false, fork: false, private: false, disabled: false, owner: { id: 7, login: "acme" } },
    head: sha("b"),
    compare: { status: "ahead", files: [{ filename: "README.md" }] },
    optin: null, // { content: string, sha: string, type?: string, size?: number }
    optinCommit: { sha: sha("c"), date: "2026-09-01T00:00:00Z", authorLogin: "maintainer", authorType: "User" },
    users: { maintainer: { id: 11, login: "maintainer", type: "User" }, alice: { id: 21, login: "alice", type: "User" } },
    issue: { number: 7, state: "open", title: "test: add coverage", body: "body", labels: [{ name: "agent-ready" }], repository_url: "https://api.github.com/repos/acme/widgets", created_at: "2026-09-02T00:00:00Z", user: { id: 21 }, assignees: [] },
    events: [{ event: "labeled", label: { name: "agent-ready" }, actor: { id: 11, login: "maintainer", type: "User" }, created_at: "2026-09-03T00:00:00Z" }],
    lastEditedAt: null,
    pulls: [],
    searchTotal: 0,
    timeline: [], // GraphQL cross-reference nodes: { __typename: "CrossReferencedEvent", source: { __typename, number, state, merged, title, url, repository: { databaseId }, author: { login } } }
    closedIssuesByCreator: {},
    // prior-art (ghsearch.mjs): repository search, releases, recent commits, the file tree, closed issues/PRs for response times
    repoSearch: { total_count: 0, incomplete_results: false, items: [] },
    release: null, // { published_at } or null (404)
    recentCommits: [], // GET /repositories/:id/commits?since=...
    tree: null, // { tree: [{ path, type }], truncated } or null (404)
    treeStatus: 404, // what an absent tree answers: 404, or 409 for an empty repository
    searchNodes: [], // GraphQL search nodes (issues and pull requests)
    fail: {}, // path substring -> http status
    writes: [], forkName: "alice/widgets", forkCreated: false, pushedSha: null, prCreated: null, prClosed: false,
  };
}

/** A GraphQL cross-reference node as GitHub returns it. state: open | closed | merged (a plain issue when asIssue). */
export const crossRef = (number, state = "open", { by = "bob", repoId = 1001, title = "fix it", url, asIssue = false } = {}) => ({
  __typename: "CrossReferencedEvent",
  source: asIssue ? { __typename: "Issue", number } : { __typename: "PullRequest", number, state: state.toUpperCase(), merged: state === "merged", title, url: url ?? `https://github.com/acme/widgets/pull/${number}`, repository: { databaseId: repoId }, author: { login: by } },
});

export function fakeRunner(world) {
  const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
  const err = (code) => ({ status: 1, stdout: "", stderr: `gh: ${code === 404 ? "Not Found" : "error"} (HTTP ${code})` });
  const page = (arr, url) => { const m = /[?&]page=(\d+)/.exec(url); const p = m ? Number(m[1]) : 1; return arr.slice((p - 1) * 100, p * 100); };
  const fields = (args) => Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-f" ? [[a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]] : [])));
  return (args) => {
    const path = args.filter((a) => a.startsWith("/") || a === "graphql").pop() ?? "";
    world.calls.push(args.join(" "));
    const method = args[args.indexOf("-X") + 1];
    if (args.includes("-X")) {
      world.writes.push({ method, path, fields: fields(args) });
      for (const [k, code] of Object.entries(world.fail)) if (path.includes(k)) return err(code);
      if (method === "POST" && path === `/repositories/${world.repo.id}/forks`) { world.forkCreated = true; world.onFork?.(); return ok({ full_name: world.forkName }); }
      if (method === "POST" && path === `/repositories/${world.repo.id}/pulls`) {
        const f = fields(args);
        const sha = world.prHeadSha ?? world.pushedSha?.() ?? "0".repeat(40);
        world.prCreated = { number: 55, html_url: "https://github.com/acme/widgets/pull/55", state: world.prState ?? "open", title: world.prTitle ?? f.title, body: world.prBody ?? f.body, head: { sha } };
        return ok(world.prCreated);
      }
      if (method === "PATCH" && path.startsWith(`/repositories/${world.repo.id}/pulls/`)) { world.prClosed = true; return ok({ state: "closed" }); }
      return err(404);
    }
    for (const [k, code] of Object.entries(world.fail)) if (path.includes(k)) return err(code);
    if (args[1] === "graphql" && args.some((a) => a.includes("timelineItems"))) {
      if (world.failTimeline) return err(500);
      const f = fields(args), start = f.after ? Number(f.after) : 0, nodes = world.timeline.slice(start, start + 100);
      return ok({ data: { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: start + 100 < world.timeline.length, endCursor: String(start + 100) }, nodes } } } } });
    }
    if (args[1] === "graphql" && args.some((a) => a.includes("search(query"))) return ok({ data: { search: { nodes: world.searchNodes } } });
    if (args[1] === "graphql") return ok({ data: { repository: { issue: { lastEditedAt: world.lastEditedAt } } } });
    const r = world.repo;
    if (path === `/repos/${r.full_name}`) return ok(r);
    if (path.startsWith(`/repositories/${r.id}/branches/`)) return ok({ commit: { sha: world.head } });
    if (path.startsWith(`/repositories/${r.id}/compare/`)) return ok(world.compare);
    if (path.startsWith(`/repositories/${r.id}/contents/`)) {
      if (!world.optin) return err(404);
      const f = world.optin; const content = Buffer.from(f.content).toString("base64");
      return ok({ type: f.type ?? "file", size: f.size ?? Buffer.byteLength(f.content), sha: f.sha ?? "d".repeat(40), encoding: f.encoding ?? "base64", content });
    }
    if (path.startsWith(`/repositories/${r.id}/commits?`) && path.includes("since=")) return ok(page(world.recentCommits, path));
    if (path.startsWith(`/repositories/${r.id}/releases/latest`)) return world.release ? ok(world.release) : err(404);
    if (path.startsWith(`/repositories/${r.id}/git/trees/`)) return world.tree ? ok(world.tree) : err(world.treeStatus);
    if (path.startsWith("/search/repositories")) return ok(world.repoSearch);
    if (path.startsWith(`/repositories/${r.id}/commits?`)) return ok([{ sha: world.optinCommit.sha, commit: { committer: { date: world.optinCommit.date } }, author: { login: world.optinCommit.authorLogin, type: world.optinCommit.authorType } }]);
    if (path.startsWith("/users/")) { const u = world.users[decodeURIComponent(path.slice(7))]; return u ? ok(u) : err(404); }
    if (path.startsWith(`/repositories/${r.id}/issues/${world.issue.number}/events`)) return ok(page(world.events, path));
    if (path.startsWith(`/repositories/${r.id}/issues/${world.issue.number}`)) return ok(world.issue);
    const pm = /^\/repositories\/(\d+)\/pulls\/(\d+)(\/reviews)?/.exec(path);
    if (pm) { const e = world.earlier?.[`${pm[1]}/${pm[2]}`]; if (!e) return err(404); return pm[3] ? ok(page(e.reviews, path)) : ok(e.pr); }
    if (path.startsWith(`/repositories/${r.id}/pulls`)) return ok(page(world.pulls, path));
    if (path.startsWith(`/repositories/${r.id}/issues?`)) { const login = /creator=([^&]+)/.exec(path)?.[1]; return ok(page(world.closedIssuesByCreator[decodeURIComponent(login)] ?? [], path)); }
    if (path === `/repos/${world.forkName}`) return world.forkCreated ? ok({ full_name: world.forkName, fork: world.forkFlag ?? true, source: { id: world.forkSourceId ?? r.id }, owner: { login: world.forkOwner ?? world.forkName.split("/")[0] } }) : err(404);
    if (path.startsWith(`/repos/${world.forkName}/git/ref/heads/`)) { const sha = world.refSha ?? world.pushedSha?.(); world.onRef?.(); return sha ? ok({ object: { sha } }) : err(404); }
    if (path === "/user") return ok({ login: "alice", id: 21 });
    if (path.startsWith("/search/issues")) return ok({ total_count: world.searchTotal });
    return err(404);
  };
}
