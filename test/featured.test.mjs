import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderFeatured, spliceHtml, spliceLlms } from "../scripts/render-featured.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const d = JSON.parse(read("featured.json"));
const claims = d.cards.flatMap((c) => c.claims);

test("the page and llms.txt are exactly what featured.json renders (no hand edits, no drift)", () => {
  const html = read("site/index.html");
  const llms = read("site/llms.txt");
  assert.equal(spliceHtml(html, d), html, "run `node scripts/render-featured.mjs`");
  assert.equal(spliceLlms(llms, d), llms, "run `node scripts/render-featured.mjs`");
});

test("every claim on the page is a claim in featured.json, in order", () => {
  const ids = [...read("site/index.html").matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, claims.map((k) => k.id));
});

test("nothing says a featured project is live or joinable, and both say there is no open run", () => {
  const page = renderFeatured(d).toLowerCase();
  for (const bad of [/\blive\b/, /join now/, /sign up/, /fully decentrali[sz]ed/, /\bopen-source model\b/]) assert.ok(!bad.test(page), String(bad));
  assert.match(page, /no run is open right now/);
  assert.match(page, /nothing to join/);
});

test("unconfirmed or secondary-only facts and claims about people are absent from every public file", () => {
  const all = [renderFeatured(d), read("site/llms.txt"), read("site/agent.json")].join("\n");
  for (const bad of ["330", "3.3M", "Steeves", "Alexander Long", "Rolnick", "Sam Dare", "PhD", "malice", "Psyche", "Consilience"]) assert.ok(!all.includes(bad), `forbidden: ${bad}`);
});

test("the disclosures are on the page: weights, centralisation, tokens, hardware, funding, dispute, and that we do not join", () => {
  const page = renderFeatured(d);
  for (const need of ["not published", "not decentralized", "paid in TAO", "eight NVIDIA B200", "venture-funded", "publicly disputed", "does not run, join, or send anything"]) assert.ok(page.includes(need), need);
});

test("agent.json and llms.txt agree: no featured run is open and we pay no rewards", () => {
  const agent = JSON.parse(read("site/agent.json"));
  assert.ok(agent.featured_projects.items.every((x) => x.run_open_now === false));
  assert.equal(agent.rewards, "none");
  assert.match(read("site/llms.txt"), /pays no rewards and has no compute network/);
});

test("the page is complete without scripts: no slide is hidden in the HTML", () => {
  assert.ok(!/class="slide[^"]*"[^>]*\bhidden\b/.test(renderFeatured(d)));
});

test("featured.js stops auto-advance for reduced motion and after any use", () => {
  const js = read("site/featured.js");
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /focusin", stop/);
  assert.match(js, /fn\(\)/); // buttons call stop() first
  assert.ok(/stop\(\); fn\(\)/.test(js));
});
