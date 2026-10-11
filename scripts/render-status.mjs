// Renders status.json into the table body of site/harness/index.html, between the status markers.
// `node scripts/render-status.mjs` rewrites the page; the test calls renderStatusRows() and compares.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATUSES = {
  built: { cls: "built", label: "Built" },
  "partly-built": { cls: "part", label: "Partly built" },
  "mock-tested": { cls: "part", label: "Mock-tested" },
  designed: { cls: "part", label: "Designed" },
  "not-built": { cls: "none", label: "Not built" },
  "not-cleared": { cls: "none", label: "Not cleared" },
};
export const START = "<!-- status:start -->";
export const END = "<!-- status:end -->";

export function renderStatusRows(rows) {
  return rows
    .map((r) => {
      const s = STATUSES[r.status];
      if (!s) throw new Error(`unknown status "${r.status}" for "${r.piece}"`);
      return `            <tr><td>${r.piece}</td><td><span class="lamp ${s.cls}">${s.label}</span></td><td>${r.detail}</td></tr>`;
    })
    .join("\n");
}

export function spliceStatus(html, rows) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("status markers not found in the page");
  return `${html.slice(0, a + START.length)}\n${renderStatusRows(rows)}\n            ${html.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const rows = JSON.parse(readFileSync(new URL("status.json", root), "utf8")).rows;
  const page = new URL("site/harness/index.html", root);
  writeFileSync(page, spliceStatus(readFileSync(page, "utf8"), rows));
  console.warn(`status table rendered: ${rows.length} rows`);
}
