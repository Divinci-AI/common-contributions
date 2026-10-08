// Pre-publication scan. Run before making the repository public: `node scripts/scrub-check.mjs`.
// Looks in the current tree AND in every commit's content and message for secret shapes (src/secrets.mjs), absolute home paths,
// the company's internal directory and hostnames, and email addresses. Reports file, line and KIND only, never the matched text.
// Exit 1 if anything is found, so a person decides what to do about each hit.
import { execFileSync } from "node:child_process";
import { scanForSecrets } from "../src/secrets.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const EXTRA = [
  ["home-path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["internal-dir", /~\/\.divinci|\.divinci\//],
  ["internal-host", /\b[a-z0-9-]+\.(?:divinci\.(?:app|ai)|internal|corp|local)\b/i],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
// Allowed on purpose: the legacy-directory fallback in paths.mjs, the documentation placeholder address, and reserved hosts.
const ALLOW = [/maintainer@example\.org/, /@example\.(?:com|org)\b/, /noreply@anthropic\.com/, /noreply@github\.com/];

function scanText(label, text, hits) {
  text.split("\n").forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const f of scanForSecrets(line)) hits.push({ where: label, line: i + 1, kind: f.kind });
    for (const [kind, re] of EXTRA) if (re.test(line)) hits.push({ where: label, line: i + 1, kind });
  });
}

const hits = [];
const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
for (const f of files) {
  if (/\.(?:woff2|png|jpg|jpeg|svg)$/.test(f) || f === "scripts/scrub-check.mjs") continue;
  let text;
  try { text = git(["show", `HEAD:${f}`]); } catch { continue; }
  scanText(`tree:${f}`, text, hits);
}
const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);
const authors = new Set();
for (const c of commits) {
  authors.add(git(["log", "-1", "--format=%ae", c]).trim()); // identities are counted, never printed
  scanText(`message:${c.slice(0, 10)}`, git(["log", "-1", "--format=%B", c]), hits);
  scanText(`diff:${c.slice(0, 10)}`, git(["show", "--format=", "--unified=0", c]), hits);
}
const summary = {};
for (const h of hits) summary[h.kind] = (summary[h.kind] ?? 0) + 1;
const area = { tree: 0, history: 0 };
for (const h of hits) area[h.where.startsWith("tree:") ? "tree" : "history"]++;
console.warn(JSON.stringify({
  commitsScanned: commits.length, filesScanned: files.length, findingsByKind: summary, findingsByArea: area,
  distinctAuthorEmails: authors.size, note: "every commit carries its author email; making the repository public publishes them",
}, null, 2));
for (const h of hits.slice(0, 60)) console.warn(`${h.kind}\t${h.where}:${h.line}`);
if (hits.length > 60) console.warn(`... and ${hits.length - 60} more`);
process.exit(hits.length ? 1 : 0);
