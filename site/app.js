// Wires the panel state machine (panel.js) to the page. The page is complete without this file: every circuit's
// "stops" and "how" text is already in the HTML. This only makes the breakers clickable.
import { CIRCUITS, createPanel } from "./panel.js";

const panel = createPanel(CIRCUITS);
const strip = document.getElementById("event");
const counter = document.getElementById("counter");
const killBtn = document.getElementById("kill");
const resetBtn = document.getElementById("reset");
const buttons = [...document.querySelectorAll("[data-circuit]")];

function render() {
  for (const btn of buttons) {
    const id = btn.dataset.circuit;
    const open = panel.isTripped(id);
    const card = btn.closest(".breaker");
    const label = CIRCUITS.find((c) => c.id === id).label;
    btn.setAttribute("aria-checked", open ? "false" : "true");
    btn.setAttribute("aria-label", `${label}, ${open ? "tripped" : "armed"}`);
    card.dataset.state = open ? "tripped" : "armed";
    card.querySelector(".b-state").textContent = open ? "Tripped" : "Armed";
  }
  counter.textContent = `${panel.trippedCount()} of ${CIRCUITS.length} tripped`;
  killBtn.disabled = panel.isMainTripped();
  resetBtn.disabled = !panel.isMainTripped();
}

function show(event) {
  strip.dataset.kind = event.kind;
  strip.textContent = "";
  const tag = document.createElement("span");
  tag.className = "t";
  tag.textContent = event.id === "main" ? "main " : `${event.id} `;
  strip.appendChild(tag);
  strip.appendChild(document.createTextNode(event.text));
  render();
}

for (const btn of buttons) btn.addEventListener("click", () => show(panel.toggle(btn.dataset.circuit)));
killBtn.addEventListener("click", () => show(panel.killAll()));
resetBtn.addEventListener("click", () => show(panel.resetAll()));
render();
