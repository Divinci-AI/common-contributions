// Renders featured.json into the "featured" section of site/index.html (between markers) and the llms.txt lines.
// Page text comes ONLY from the claims. `node scripts/render-featured.mjs` rewrites both; the test compares.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const START = "<!-- featured:start -->";
export const END = "<!-- featured:end -->";
export const LLMS_START = "<!-- featured-llms:start -->";
export const LLMS_END = "<!-- featured-llms:end -->";
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const SVG = {
  // Decorative only (aria-hidden). Pluralis: a pipeline of stages, with volunteer machines feeding the middle ones.
  pluralis: `<svg class="art" viewBox="0 0 240 130" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="48" width="26" height="34" rx="4"/><rect x="40" y="48" width="26" height="34" rx="4" class="hot"/><rect x="74" y="48" width="26" height="34" rx="4" class="hot"/><rect x="108" y="48" width="26" height="34" rx="4" class="hot"/><rect x="142" y="48" width="26" height="34" rx="4" class="hot"/><rect x="176" y="48" width="26" height="34" rx="4" class="hot"/><rect x="210" y="48" width="26" height="34" rx="4"/><path d="M32 65h8M66 65h8M100 65h8M134 65h8M168 65h8M202 65h8"/><path d="M53 20v28M87 20v28M121 20v28M155 20v28M189 20v28M53 82v28M87 82v28M121 82v28M155 82v28M189 82v28" stroke-dasharray="3 3"/></g><g class="dot"><circle cx="53" cy="16" r="4"/><circle cx="87" cy="16" r="4"/><circle cx="121" cy="16" r="4"/><circle cx="155" cy="16" r="4"/><circle cx="189" cy="16" r="4"/><circle cx="53" cy="114" r="4"/><circle cx="87" cy="114" r="4"/><circle cx="121" cy="114" r="4"/><circle cx="155" cy="114" r="4"/><circle cx="189" cy="114" r="4"/></g></svg>`,
  // Covenant: many peers around one aggregation point, updates flowing in.
  covenant: `<svg class="art" viewBox="0 0 240 130" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="120" cy="65" r="22" class="hot"/><circle cx="120" cy="65" r="8"/><path d="M120 12v31M120 118V87M40 65h58M200 65h-58M63 25l37 25M177 25l-37 25M63 105l37-25M177 105l-37-25" stroke-dasharray="3 3"/></g><g class="dot"><circle cx="120" cy="10" r="5"/><circle cx="120" cy="120" r="5"/><circle cx="36" cy="65" r="5"/><circle cx="204" cy="65" r="5"/><circle cx="60" cy="22" r="5"/><circle cx="180" cy="22" r="5"/><circle cx="60" cy="108" r="5"/><circle cx="180" cy="108" r="5"/></g></svg>`,
};

export function renderFeatured(d) {
  const slides = d.cards.map((c, i) => `        <article class="slide card" id="feat-${c.id}" aria-label="${i + 1} of ${d.cards.length}: ${esc(c.title)}">
          <div class="slide-head">
            <div>
              <span class="kicker">${esc(c.kind)}</span>
              <h3>${esc(c.title)}</h3>
              <p class="tags">${c.tags.map((t) => `<span class="lamp ${t.cls}">${esc(t.label)}</span>`).join("")}</p>
            </div>
            ${SVG[c.id] ?? ""}
          </div>
          <ul class="list">
${c.claims.map((k) => `            <li data-claim="${k.id}">${esc(k.text)}</li>`).join("\n")}
          </ul>
          <p class="note"><a href="${esc(c.link.href)}" rel="noopener">${esc(c.link.label)}</a> · checked ${d.asOf}</p>
        </article>`).join("\n");
  return `    <section id="featured" aria-labelledby="featured-h">
      <span class="kicker">The wider field</span>
      <h2 id="featured-h">${esc(d.tagline)}</h2>
      <p class="note">${esc(d.disclaimer.text)}</p>
      <div class="carousel" id="carousel">
${slides}
      </div>
    </section>`;
}
export const renderLlms = (d) => d.llms.map((l) => l.text).join("\n");

const splice = (text, a, b, body) => {
  const i = text.indexOf(a), j = text.indexOf(b);
  if (i === -1 || j === -1 || j < i) throw new Error(`markers ${a} not found`);
  return `${text.slice(0, i + a.length)}\n${body}\n${text.slice(j)}`;
};
export const spliceHtml = (html, d) => splice(html, START, END, renderFeatured(d));
export const spliceLlms = (txt, d) => splice(txt, LLMS_START, LLMS_END, renderLlms(d));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const d = JSON.parse(readFileSync(new URL("featured.json", root), "utf8"));
  for (const [p, fn] of [["site/index.html", spliceHtml], ["site/llms.txt", spliceLlms]]) {
    const u = new URL(p, root);
    writeFileSync(u, fn(readFileSync(u, "utf8"), d));
  }
  console.warn("featured section and llms lines rendered");
}
