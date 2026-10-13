/**
 * Dry run and publish. The dry run changes nothing anywhere: it plans, builds the exact commit and texts, and returns them.
 * A publish is one step: plan, then check again that the plan has not changed at three moments (before the fork, before the push, before the PR).
 * The only thing a person is ever asked is a CLA or DCO certification, and only when the project requires one (see certifyAfterReview).
 * The PR is made from the user's own account through their own gh and git.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { planPublish } from "./publish.mjs";
import { approvalToken, branchName, buildCommit, buildCommitMessage, buildPrBody, cleanTitle } from "./publisher.mjs";

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** The write side of gh: POST/PATCH with raw string fields. Returns parsed JSON or throws. */
export function ghWriter(run) {
  const call = (method, path, fields) => {
    const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", path];
    for (const [k, v] of Object.entries(fields ?? {})) args.push("-f", `${k}=${v}`);
    const r = run(args);
    if (r.status !== 0) throw new Error(`GitHub ${method} ${path.split("?")[0]} failed: ${(r.stderr || "").trim().slice(0, 200)}`);
    try { return JSON.parse(r.stdout); } catch { throw new Error(`GitHub ${method} ${path.split("?")[0]} answered with something that is not JSON`); }
  };
  return { post: (p, f) => call("POST", p, f), patch: (p, f) => call("PATCH", p, f) };
}

/** Plan + texts + the exact commit + the token. Pure with respect to GitHub (reads only) and the remote repository (writes nothing). */
export function prepare(o) {
  const { record, repoDir, descriptionText, titleOverride } = o;
  // The ledger is read again at every plan (not once at startup), so an entry another run appended meanwhile is seen by the next re-check.
  const plan = planPublish(typeof o.ledgerFn === "function" ? { ...o, ledger: o.ledgerFn() } : o);
  if (!plan.ok) return { phase: "refused", plan };
  // The answers may be a callback (the CLI asks after the review text); the plan resolved it, so the commit must use the same answers.
  const flags = typeof o.flags === "function" ? o.flags({ spec: plan.spec, flagged: plan.info.flagged, user: o.user }) : (o.flags ?? {});
  let texts;
  try {
    const title = titleOverride ? cleanTitle(titleOverride) : cleanTitle(plan.issueTitle);
    const message = buildCommitMessage({ title, issueNumber: o.issueNumber, spec: plan.spec, flags, user: o.user, model: record.model });
    const body = buildPrBody({ description: descriptionText, spec: plan.spec, issueNumber: o.issueNumber, record, specBlobSha: plan.bound.specBlobSha });
    const branch = branchName(o.issueNumber, title);
    const files = Object.fromEntries(Object.entries(record.files).map(([p, f]) => [p, f.content]));
    const commit = buildCommit({ repoDir, base: record.base, files, message, author: { name: o.user.name, email: o.user.email }, when: record.createdAt });
    const token = approvalToken({ bound: plan.bound, commitSha: commit.sha, title, body, branch });
    texts = { title, body, branch, message, commitSha: commit.sha, token };
  } catch (e) {
    plan.checks.push({ name: "texts and commit", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { phase: "refused", plan: { ...plan, ok: false } };
  }
  return { phase: "ready", plan, texts };
}

export function dryRun(o) {
  const p = prepare(o);
  return p.phase === "ready" ? { ...p, phase: "dry-run" } : p;
}

/**
 * @param o.write     {post, patch} from ghWriter
 * @param o.pushUrlFor (forkFullName) => url to push to
 * @param o.sleep     async (ms) => void
 */
export async function publish(o) {
  if (!o.lockFile) return runPublish(o);
  // One publish at a time per person: two runs started together would both read an empty ledger and both pass the interval and daily limit.
  mkdirSync(dirname(o.lockFile), { recursive: true });
  try { if (Date.now() - statSync(o.lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(o.lockFile); } catch { /* none */ }
  let fd;
  try { fd = openSync(o.lockFile, "wx"); writeSync(fd, `${process.pid}\n`); } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const first = prepare(o);
    return { phase: "refused", plan: { ...(first.plan ?? {}), ok: false, checks: [...(first.plan?.checks ?? []), { name: "no other publish is running", ok: false, detail: `another publish holds ${o.lockFile}; wait for it to finish (a lock older than ${LOCK_STALE_MS / 60000} minutes is ignored)` }] }, texts: first.texts };
  }
  try { return await runPublish(o); } finally { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(o.lockFile); } catch { /* gone */ } }
}
const LOCK_STALE_MS = 15 * 60 * 1000;

async function runPublish(o) {
  const { gh, write, ledgerFile, repoDir, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pushUrlFor, user } = o;
  const log = [];
  const first = prepare(o);
  if (first.phase !== "ready") return first;
  const { texts, plan } = first;
  // What the person was shown before certifying must be what is being published (the project's file and the diff can change while they read).
  if (o.expect && (o.expect.specBlobSha !== plan.bound.specBlobSha || o.expect.patch !== plan.diff.patch)) return { phase: "refused", plan: { ...plan, ok: false, checks: [...plan.checks, { name: "what you were shown", ok: false, detail: "the project's opt-in file or the diff changed after you were shown them; nothing was changed, run the command again" }] }, texts };

  const recheck = (stage) => { const p = prepare(o); if (p.phase !== "ready" || p.texts.token !== texts.token) { throw new RecheckError(`${stage}: the plan changed while publishing (${p.phase === "ready" ? "token differs" : p.plan.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}); nothing was opened`); } };
  try {
    recheck("before forking");
    const forkName = `${user.login}/${plan.bound.fullName.split("/")[1]}`;
    write.post(`/repositories/${plan.bound.repoId}/forks`, {});
    let fork;
    for (let i = 0; i < 20 && !fork; i++) { try { fork = gh.get(`/repos/${forkName}`); } catch { await sleep(3000); } }
    if (!fork || fork.fork !== true || fork.source?.id !== plan.bound.repoId || fork.owner?.login?.toLowerCase() !== user.login.toLowerCase()) throw new RecheckError("the fork is missing or is not a fork of the target repository; nothing was pushed");
    log.push(`fork ready: ${fork.full_name}`);

    recheck("before pushing");
    const push = spawnSync("/usr/bin/git", ["-C", repoDir, "push", pushUrlFor(fork.full_name), `${texts.commitSha}:refs/heads/${texts.branch}`], { env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", timeout: 120_000 });
    if (push.status !== 0) throw new Error(`git push failed: ${(push.stderr || "").trim().slice(0, 300)}`);
    const ref = gh.get(`/repos/${fork.full_name}/git/ref/heads/${texts.branch}`);
    if (ref?.object?.sha !== texts.commitSha) throw new RecheckError("the pushed branch does not point at the planned commit; nothing was opened");
    log.push(`pushed ${texts.commitSha.slice(0, 12)} to ${fork.full_name}:${texts.branch}`);

    recheck("before opening the pull request");
    const pr = write.post(`/repositories/${plan.bound.repoId}/pulls`, { title: texts.title, head: `${user.login}:${texts.branch}`, base: plan.bound.defaultBranch, body: texts.body });
    const problems = [];
    if (pr?.head?.sha !== texts.commitSha) problems.push("its head is not the planned commit");
    if (pr?.title !== texts.title) problems.push("its title differs");
    if (pr?.body !== texts.body) problems.push("its body differs");
    if (pr?.state !== "open") problems.push("it is not open");
    if (problems.length > 0) {
      try { write.patch(`/repositories/${plan.bound.repoId}/pulls/${pr.number}`, { state: "closed" }); } catch { /* reported below */ }
      throw new RecheckError(`the pull request that was created ${problems.join(", ")}; it was closed. Nothing else was done.`);
    }
    mkdirSync(dirname(ledgerFile), { recursive: true });
    appendFileSync(ledgerFile, JSON.stringify({ repoId: plan.bound.repoId, ownerId: plan.bound.ownerId, userId: user.id, at: now, pr: pr.html_url ?? pr.url, number: pr.number, issue: o.issueNumber, branch: texts.branch, commitSha: texts.commitSha }) + "\n");
    log.push(`opened ${pr.html_url ?? pr.url}`);
    return { phase: "published", plan, texts, pr, log };
  } catch (e) {
    return { phase: "aborted", plan, texts, error: e instanceof Error ? e.message : String(e), log };
  }
}
class RecheckError extends Error {}

/** What is about to happen, for the person who runs the command. `dry` says no certification was asked and nothing will be changed. */
export function reviewText(first, { dry = false, asking = false } = {}) {
  const { plan, texts } = first, i = plan.info ?? {};
  const cert = plan.spec?.certification ?? {};
  const reqs = [cert.cla && cert.cla !== "none" ? `${cert.cla} CLA` : null, cert.dco === "signed-off-by" ? "DCO sign-off (Signed-off-by)" : null].filter(Boolean);
  const required = reqs.length > 0 ? reqs.join(" and ") : "none";
  return [
    `Repository: ${plan.bound.fullName}   issue #${plan.bound.issueNumber}   base ${plan.bound.base.slice(0, 12)}   commit ${texts.commitSha.slice(0, 12)}`,
    `Project contact: ${i.contact ?? "?"}   policy: ${i.policyUrl ?? "?"}${i.safetyCritical ? `\nSAFETY-CRITICAL project${i.safetyReason ? `: ${i.safetyReason}` : ""}: tests and documentation only` : ""}`,
    `Interval in force between our pull requests to this project: ${i.intervalHours ?? "?"} hours`,
    `Published under your name: ${plan.bound.user.name} <${plan.bound.user.email}>`,
    dry ? `Dry run: no certification was asked and nothing will be changed. Certifications this project requires, asked when you publish: ${required}.` : asking ? `Certifications you will be asked for next (typed by you): ${required}. Nothing has been certified yet.` : `Certifications given: CLA ${plan.bound.ack?.cla ? "yes" : "no"}, DCO sign-off ${plan.bound.ack?.dco ? "yes" : "no"}, flagged code allowed ${plan.bound.ack?.flagged ? "yes" : "no"}`,
    i.priorWork === null || i.priorWork === undefined ? "Earlier work on this issue: not checked" : i.priorWork.length > 0 ? `Other pull requests that mention this issue (not blocking):\n  ${i.priorWork.join("\n  ")}` : "No other pull request mentions this issue.",
    (i.flagged?.length ?? 0) > 0 ? `Lines that touch the environment, network or processes:\n  ${i.flagged.join("\n  ")}` : "No lines touch the environment, network or processes.",
    `--- diff (${plan.diff.total} changed lines) ---\n${plan.diff.patch}`,
    `--- commit message ---\n${texts.message}`,
    `--- PR title ---\n${texts.title}\n--- PR body ---\n${texts.body}`,
  ].join("\n");
}

/**
 * Show the person what will be published FIRST, then ask the certifications (none are asked when the project requires none). The plan is first made with provisional "yes" answers purely so there is something
 * to show; the real plan is made after, with the person's actual answers bound into the token. Returns the flags object, or {refused} when the provisional plan failed.
 * @param o   prepare() inputs without `flags`
 * @param io  {display(text), askCertifications({spec, flagged, text}) => flags, allowFlaggedCode} (the real flag decides whether flagged code can pass, so nobody certifies for a publish that will be refused)
 */
export function certifyAfterReview(o, io) {
  const provisional = prepare({ ...o, flags: { claSigned: true, certifyDco: true, allowFlaggedCode: io.allowFlaggedCode === true } });
  if (provisional.phase !== "ready") return { refused: provisional };
  const text = reviewText(provisional, { asking: true });
  io.display(text);
  const flags = io.askCertifications({ spec: provisional.plan.spec, flagged: provisional.plan.info.flagged, text });
  return { flags, expect: { specBlobSha: provisional.plan.bound.specBlobSha, patch: provisional.plan.diff.patch } };
}
