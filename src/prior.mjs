/**
 * Look before you spend: has someone already put forward work for this issue?
 * Compute is wasted when a model writes what a pull request already contains. This reads the issue's own timeline (through the injected gh client)
 * and reports pull requests that mention it. A mention is not proof the work is done, so the CLI lets a person override it for `run-one`;
 * `publish` only refuses on an OPEN pull request by someone else, because opening a second one buries the first for the maintainer.
 */
import { escapeForTerminal } from "./tty.mjs";

export function describePrior(list) {
  const by = (s) => list.filter((x) => x.state === s);
  const fmt = (x) => escapeForTerminal(`${x.sameRepo === false ? "(another repository) " : ""}#${x.number} ${x.state}${x.by ? ` by ${x.by}` : ""}: ${x.title}${x.url ? ` (${x.url})` : ""}`);
  return { open: by("open"), merged: by("merged"), closed: by("closed"), lines: list.filter((x) => x.state !== "closed").map(fmt), closedLines: by("closed").map(fmt) };
}

/** Open pull requests IN THIS REPOSITORY that are not yours: someone else's work on the same issue. (A mention from another repository is shown, never a reason to refuse: anyone could write one.) */
export function othersOpen(list, { userLogin }) {
  return list.filter((x) => x.state === "open" && x.sameRepo === true && !(x.by && userLogin && x.by.toLowerCase() === userLogin.toLowerCase()));
}
