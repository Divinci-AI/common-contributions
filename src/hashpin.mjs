/**
 * The hash-pin step for Python projects. A normal project's requirements have no hashes and omit transitive dependencies, but Stage A
 * (depimage.mjs) installs only `name==version --hash=sha256:...` lines, wheels only. This turns a plain list of requirements into that file.
 *
 * It is the one extra network step, so it is narrow:
 *  - the spec is checked first: plain requirements only (no options, includes, URLs, VCS, paths);
 *  - pip runs in a THROWAWAY container (no mounts, no host network mode, all capabilities dropped, read-only root, capped);
 *  - `pip install --dry-run --only-binary=:all: --report -` resolves wheels and reports each file's sha256 without installing or running
 *    anything from the project (never `pip-compile` or a source build on the host: that can run a project's setup.py);
 *  - the report is checked line by line: each file must be a wheel from files.pythonhosted.org with a sha256, and the result is
 *    re-checked by the same checkRequirements() that Stage A uses.
 * Residual trust: PyPI and its CDN, the base image. The hashes pin what was seen at pin time; they do not prove the wheel is benign.
 */
import { spawnSync } from "node:child_process";
import { dockerEnv } from "./container.mjs";
import { checkRequirements } from "./depimage.mjs";

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const SPEC_LINE = new RegExp(`^${NAME}(?:\\[[A-Za-z0-9,._ -]+\\])?\\s*(?:\\(?\\s*(?:[<>=!~]=?|===)\\s*[A-Za-z0-9.*+!_-]+(?:\\s*,\\s*(?:[<>=!~]=?|===)\\s*[A-Za-z0-9.*+!_-]+)*\\s*\\)?)?\\s*(?:;\\s*[A-Za-z0-9_."'()<>=!~, ]+)?$`);

/** Problems with a plain requirements spec. Empty = fine. */
export function checkSpec(text) {
  if (typeof text !== "string") return ["spec is not text"];
  const p = [];
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    n++;
    if (/^-/.test(line)) { p.push(`option line refused: ${line.slice(0, 40)}`); continue; }
    if (/:\/\/|@|git\+|file:|\.\.|\/|\\|`|\$/.test(line)) { p.push(`not a plain requirement: ${line.slice(0, 50)}`); continue; }
    if (!SPEC_LINE.test(line)) p.push(`not a requirement: ${line.slice(0, 50)}`);
  }
  if (n === 0) p.push("no requirements");
  return p;
}

const normalise = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");
const WHEEL_URL = /^https:\/\/files\.pythonhosted\.org\/[A-Za-z0-9._\/+-]*\.whl$/;

/** A pip install report -> a hashed requirements.txt. Throws "refused: ..." on anything unexpected. */
export function reportToRequirements(report) {
  const fail = (m) => { throw new Error(`refused: ${m}`); };
  if (!report || typeof report !== "object" || !Array.isArray(report.install) || report.install.length === 0) fail("the pip report has no packages");
  const seen = new Map();
  for (const e of report.install) {
    const name = e?.metadata?.name, version = e?.metadata?.version;
    if (typeof name !== "string" || !new RegExp(`^${NAME}$`).test(name)) fail(`odd package name ${JSON.stringify(name)}`);
    if (typeof version !== "string" || !/^[A-Za-z0-9._+!-]+$/.test(version)) fail(`${name}: odd version`);
    if (e.is_direct !== false) fail(`${name}: direct URL install`);
    const url = e.download_info?.url;
    if (typeof url !== "string" || !WHEEL_URL.test(url)) fail(`${name}: not a wheel from files.pythonhosted.org`);
    const sha = e.download_info?.archive_info?.hashes?.sha256;
    if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) fail(`${name}: no sha256`);
    const key = normalise(name);
    const line = `${key}==${version} --hash=sha256:${sha}`;
    if (seen.has(key) && seen.get(key) !== line) fail(`${name}: listed twice with different files`);
    seen.set(key, line);
  }
  const text = [...seen.values()].sort().join("\n") + "\n";
  const bad = checkRequirements(text);
  if (bad.length > 0) fail(bad.slice(0, 3).join("; "));
  return text;
}

/** Flags every pin container carries (a test asserts each is present). The container has NETWORK (pip needs it) and nothing else. */
export const PIN_FLAGS = ["--rm", "-i", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "--memory", "--user"];

/** Resolve a plain spec to a hashed requirements.txt in a throwaway container. Returns {ok, requirements} or {ok:false, refused}. */
export function pinRequirements({ docker, baseDigest, specText }) {
  if (!/^[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/.test(baseDigest)) return { ok: false, refused: "base image must be named by digest" };
  const bad = checkSpec(specText);
  if (bad.length > 0) return { ok: false, refused: `spec refused: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}` };
  const script = "cat > /tmp/spec.txt && pip install --dry-run --ignore-installed --only-binary=:all: --no-cache-dir --no-input --disable-pip-version-check --quiet --report - -r /tmp/spec.txt";
  const args = ["run", "--rm", "-i", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=128m",
    "--pids-limit", "256", "--memory", "1g", "--user", "65532:65532", "-e", "HOME=/tmp", baseDigest, "sh", "-c", script];
  const r = spawnSync(docker, args, { input: specText.endsWith("\n") ? specText : specText + "\n", env: dockerEnv(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  if (r.status !== 0) return { ok: false, refused: `pip could not resolve wheels: ${`${r.stdout || ""}${r.stderr || ""}`.trim().slice(-400)}` };
  let report;
  try { report = JSON.parse(r.stdout); } catch { return { ok: false, refused: "pip report was not JSON" }; }
  try { return { ok: true, requirements: reportToRequirements(report) }; } catch (e) { return { ok: false, refused: e.message }; }
}
