/**
 * Dry run and real publish. The dry run changes nothing on GitHub: it plans, builds the exact commit and texts, writes a pending marker and prints a token.
 * A real publish needs: the token, a cool-down since the dry run, the repo name and the sentence typed on /dev/tty, and a fresh plan whose token still matches
 * at three moments (before the fork, before the push, before the PR). The PR is made from the user's own account through their own gh and git.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planPublish } from "./publish.mjs";
import { approvalToken, branchName, buildCommit, buildCommitMessage, buildPrBody, cleanSentence, cleanTitle } from "./publisher.mjs";

export const COOLDOWN_MS = 10 * 60 * 1000;

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
  const { record, flags = {}, repoDir, descriptionText, sentence, titleOverride } = o;
  const plan = planPublish(o);
  if (!plan.ok) return { phase: "refused", plan };
  let texts;
  try {
    const title = titleOverride ? cleanTitle(titleOverride) : cleanTitle(plan.issueTitle);
    const clean = cleanSentence(sentence, o.issueNumber);
    const message = buildCommitMessage({ title, issueNumber: o.issueNumber, spec: plan.spec, flags, user: o.user, model: record.model });
    const body = buildPrBody({ description: descriptionText, spec: plan.spec, issueNumber: o.issueNumber, record, sentence: clean, specBlobSha: plan.bound.specBlobSha });
    const branch = branchName(o.issueNumber, title);
    const files = Object.fromEntries(Object.entries(record.files).map(([p, f]) => [p, f.content]));
    const commit = buildCommit({ repoDir, base: record.base, files, message, author: { name: o.user.name, email: o.user.email }, when: record.createdAt });
    const token = approvalToken({ bound: plan.bound, commitSha: commit.sha, title, body, branch, sentence: clean });
    texts = { title, body, branch, message, sentence: clean, commitSha: commit.sha, token };
  } catch (e) {
    plan.checks.push({ name: "texts and commit", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { phase: "refused", plan: { ...plan, ok: false } };
  }
  return { phase: "ready", plan, texts };
}

export function dryRun(o) {
  const p = prepare(o);
  if (p.phase !== "ready") return p;
  mkdirSync(o.pendingDir, { recursive: true });
  writeFileSync(join(o.pendingDir, p.texts.token), JSON.stringify({ at: o.now ?? Date.now(), repo: p.plan.bound.fullName, issue: o.issueNumber }) + "\n");
  return { ...p, phase: "dry-run" };
}

/**
 * @param o.ask       (prompt) => string, reads from /dev/tty in production
 * @param o.approve   the token from the dry run
 * @param o.write     {post, patch} from ghWriter
 * @param o.pushUrlFor (forkFullName) => url to push to
 * @param o.sleep     async (ms) => void
 */
export async function publish(o) {
  const { gh, write, approve, ask, pendingDir, ledgerFile, repoDir, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pushUrlFor, user } = o;
  const log = [];
  const first = prepare(o);
  if (first.phase !== "ready") return first;
  const { texts, plan } = first;
  if (!approve || approve !== texts.token) return refuse(first, "the approval token does not match the current plan (something changed since the dry run, or the token is wrong); run the dry run again");
  const pend = join(pendingDir, texts.token);
  if (!existsSync(pend)) return refuse(first, "no dry run found for this token; run the dry run first");
  const age = now - statSync(pend).mtimeMs, recorded = now - JSON.parse(readFileSync(pend, "utf8")).at;
  if (Math.min(age, recorded) < COOLDOWN_MS) return refuse(first, `wait ${Math.ceil((COOLDOWN_MS - Math.min(age, recorded)) / 60000)} more minute(s) after the dry run and read the diff again`);

  o.display?.(reviewText(first));
  const typed = (ask(`Type the repository name (${plan.bound.fullName}) to confirm: `) ?? "").trim();
  if (typed !== plan.bound.fullName) return refuse(first, "the repository name was not typed correctly");
  const again = (ask(`Your sentence, retype it exactly (or press Enter to confirm it as printed):\n  "${texts.sentence}"\n> `) ?? "").trim();
  if (again !== "" && cleanSentence(again, o.issueNumber) !== texts.sentence) return refuse(first, "the sentence differs from the one in the dry run");
  if ((ask("Open this pull request from your account? Type yes: ") ?? "").trim().toLowerCase() !== "yes") return refuse(first, "not confirmed");

  const recheck = (stage) => { const p = prepare(o); if (p.phase !== "ready" || p.texts.token !== texts.token) { throw new RecheckError(`${stage}: the plan changed since you approved it (${p.phase === "ready" ? "token differs" : p.plan.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}); nothing was opened`); } };
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
    if (ref?.object?.sha !== texts.commitSha) throw new RecheckError("the pushed branch does not point at the approved commit; nothing was opened");
    log.push(`pushed ${texts.commitSha.slice(0, 12)} to ${fork.full_name}:${texts.branch}`);

    recheck("before opening the pull request");
    const pr = write.post(`/repositories/${plan.bound.repoId}/pulls`, { title: texts.title, head: `${user.login}:${texts.branch}`, base: plan.bound.defaultBranch, body: texts.body });
    const problems = [];
    if (pr?.head?.sha !== texts.commitSha) problems.push("its head is not the approved commit");
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
const refuse = (first, reason) => ({ phase: "refused", plan: { ...first.plan, ok: false, checks: [...first.plan.checks, { name: "approval", ok: false, detail: reason }] }, texts: first.texts });

/** Everything the person should see on THEIR terminal immediately before confirming (not only in the dry run's output). */
export function reviewText(first) {
  const { plan, texts } = first, i = plan.info ?? {};
  return [
    `Repository: ${plan.bound.fullName}   issue #${plan.bound.issueNumber}   base ${plan.bound.base.slice(0, 12)}   commit ${texts.commitSha.slice(0, 12)}`,
    `Project contact: ${i.contact ?? "?"}   policy: ${i.policyUrl ?? "?"}${i.safetyCritical ? `\nSAFETY-CRITICAL project${i.safetyReason ? `: ${i.safetyReason}` : ""}: tests and documentation only` : ""}`,
    `Published under your name: ${plan.bound.user.name} <${plan.bound.user.email}>`,
    `Certifications given: CLA ${plan.bound.ack?.cla ? "yes" : "no"}, DCO sign-off ${plan.bound.ack?.dco ? "yes" : "no"}, flagged code reviewed ${plan.bound.ack?.flagged ? "yes" : "no"}`,
    (i.flagged?.length ?? 0) > 0 ? `Lines that touch the environment, network or processes:\n  ${i.flagged.join("\n  ")}` : "No lines touch the environment, network or processes.",
    `--- diff (${plan.diff.total} changed lines) ---\n${plan.diff.patch}`,
    `--- commit message ---\n${texts.message}`,
    `--- PR title ---\n${texts.title}\n--- PR body ---\n${texts.body}`,
  ].join("\n");
}

/**
 * Show the person the whole review text FIRST, then ask the certifications. The plan is first made with provisional "yes" answers purely so there is something
 * to show; the real plan is made after, with the person's actual answers bound into the token. Returns the flags object, or {refused} when the provisional plan failed.
 * @param o   prepare() inputs without `flags`
 * @param io  {display(text), askCertifications({spec, flagged}) => flags}
 */
export function certifyAfterReview(o, io) {
  const provisional = prepare({ ...o, flags: { claSigned: true, certifyDco: true, allowFlaggedCode: true } });
  if (provisional.phase !== "ready") return { refused: provisional };
  io.display(reviewText(provisional));
  return { flags: io.askCertifications({ spec: provisional.plan.spec, flagged: provisional.plan.info.flagged }) };
}
