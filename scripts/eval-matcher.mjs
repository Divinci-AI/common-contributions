// Offline evaluation of the model-assisted matcher (Goal 4, M2). Reads saved `prior-art --json` runs and a labels file; asks a LOCAL Ollama model
// (loopback only) one question per candidate; prints numbers. It has no GitHub access and writes only the report file you name.
//   node scripts/eval-matcher.mjs --runs DIR --labels FILE --model NAME [--host http://127.0.0.1:11434] [--repeat 2] [--out report.json]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildTask, parseChoice, evaluateRun, summarize } from "../src/matcher.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const dir = arg("--runs"), labelsFile = arg("--labels"), model = arg("--model"), host = arg("--host", "http://127.0.0.1:11434"), repeat = Number(arg("--repeat", "1")), outFile = arg("--out");
if (!dir || !labelsFile || !model || !(repeat >= 1 && repeat <= 5)) { console.error("usage: eval-matcher --runs DIR --labels FILE --model NAME [--host URL] [--repeat 1-5] [--out FILE]"); process.exit(2); }
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(host).hostname)) { console.error(`refusing: ${host} is not loopback; this evaluation sends the plan and candidate text only to a local model`); process.exit(2); }

const labelsDoc = JSON.parse(readFileSync(labelsFile, "utf8"));
async function ask(task) {
  const r = await fetch(`${host}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, system: task.system, prompt: task.prompt, stream: false, think: false, options: { temperature: 0, num_predict: 8 } }) });
  if (!r.ok) throw new Error(`ollama answered HTTP ${r.status}`);
  const j = await r.json();
  return { text: typeof j.response === "string" ? j.response : "", tokens: (j.prompt_eval_count ?? 0) + (j.eval_count ?? 0) };
}

const started = Date.now(); let calls = 0, tokens = 0; const perPass = [];
for (let pass = 0; pass < repeat; pass++) {
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => /^run\d+\.json$/.test(x)).sort()) {
    const key = f.replace(".json", ""), spec = labelsDoc.runs[key];
    if (!spec) continue;
    const run = JSON.parse(readFileSync(join(dir, f), "utf8")), answers = {}, raw = {};
    for (const c of run.candidates) {
      if (!c.read || !spec.labels[c.fullName]) continue;
      const a = await ask(buildTask(spec.description, c)); calls++; tokens += a.tokens;
      const label = parseChoice(a.text); raw[c.fullName] = a.text.trim().slice(0, 20);
      if (label) answers[c.fullName] = label;
    }
    const lab = Object.fromEntries(Object.entries(spec.labels).map(([n, v]) => [n, v.label]));
    rows.push({ run: key, ...evaluateRun(run.candidates, lab, answers), across: evaluateRun(run.candidates, lab, answers, 3, { acrossTiers: true }), answers, raw });
  }
  perPass.push(rows);
}
const summaries = perPass.map((rows) => summarize(rows));
const acrossSummary = summarize(perPass[0].map((r) => r.across));
let agree = null;
if (repeat > 1) { const flat = perPass.map((rows) => rows.flatMap((r) => Object.entries(r.answers).map(([n, a]) => `${r.run}/${n}=${a}`))); agree = flat[0].filter((x) => flat.every((f) => f.includes(x))).length / Math.max(1, flat[0].length); }
const report = { model, host, repeat, calls, seconds: Math.round((Date.now() - started) / 1000), tokens, repeatAgreement: agree, summary: summaries[0], summaryAcrossTiers: acrossSummary, perRun: perPass[0].map(({ answers, raw, across, ...r }) => ({ ...r, acrossTiers: { matcherYesInTop: across.matcherYesInTop, demoted: across.demoted } })) };
console.log(JSON.stringify({ ...report, perRun: undefined }, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify({ ...report, answers: perPass[0].map((r) => ({ run: r.run, answers: r.answers, raw: r.raw })) }, null, 2));
