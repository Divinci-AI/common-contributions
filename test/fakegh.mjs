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
    closedIssuesByCreator: {},
    fail: {}, // path substring -> http status
  };
}

export function fakeRunner(world) {
  const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
  const err = (code) => ({ status: 1, stdout: "", stderr: `gh: ${code === 404 ? "Not Found" : "error"} (HTTP ${code})` });
  const page = (arr, url) => { const m = /[?&]page=(\d+)/.exec(url); const p = m ? Number(m[1]) : 1; return arr.slice((p - 1) * 100, p * 100); };
  return (args) => {
    const path = args.filter((a) => a.startsWith("/") || a === "graphql").pop() ?? "";
    world.calls.push(args.join(" "));
    for (const [k, code] of Object.entries(world.fail)) if (path.includes(k)) return err(code);
    if (args[1] === "graphql") return ok({ data: { repository: { issue: { lastEditedAt: world.lastEditedAt } } } });
    const r = world.repo;
    if (path === `/repos/${r.full_name}`) return ok(r);
    if (path.startsWith(`/repositories/${r.id}/branches/`)) return ok({ commit: { sha: world.head } });
    if (path.startsWith(`/repositories/${r.id}/compare/`)) return ok(world.compare);
    if (path.startsWith(`/repositories/${r.id}/contents/`)) {
      if (!world.optin) return err(404);
      const f = world.optin; const content = Buffer.from(f.content).toString("base64");
      return ok({ type: f.type ?? "file", size: f.size ?? Buffer.byteLength(f.content), sha: f.sha ?? "d".repeat(40), encoding: "base64", content });
    }
    if (path.startsWith(`/repositories/${r.id}/commits?`)) return ok([{ sha: world.optinCommit.sha, commit: { committer: { date: world.optinCommit.date } }, author: { login: world.optinCommit.authorLogin, type: world.optinCommit.authorType } }]);
    if (path.startsWith("/users/")) { const u = world.users[decodeURIComponent(path.slice(7))]; return u ? ok(u) : err(404); }
    if (path.startsWith(`/repositories/${r.id}/issues/${world.issue.number}/events`)) return ok(page(world.events, path));
    if (path.startsWith(`/repositories/${r.id}/issues/${world.issue.number}`)) return ok(world.issue);
    if (path.startsWith(`/repositories/${r.id}/pulls`)) return ok(page(world.pulls, path));
    if (path.startsWith(`/repositories/${r.id}/issues?`)) { const login = /creator=([^&]+)/.exec(path)?.[1]; return ok(page(world.closedIssuesByCreator[decodeURIComponent(login)] ?? [], path)); }
    if (path.startsWith("/search/issues")) return ok({ total_count: world.searchTotal });
    return err(404);
  };
}
