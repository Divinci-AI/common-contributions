// Progressive enhancement. Without this file every featured project is shown, one under the other.
// With it, one project shows at a time, with previous/next buttons; it advances by itself only if the
// visitor has not asked for reduced motion, and stops for good once they use the buttons or focus inside.
const root = document.getElementById("carousel");
if (root) {
  const slides = [...root.querySelectorAll(".slide")];
  let i = 0;
  let timer = null;
  const show = (n) => {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => { s.hidden = k !== i; });
    status.textContent = `${i + 1} of ${slides.length}`;
  };
  const bar = document.createElement("div");
  bar.className = "carousel-bar";
  const mk = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", () => { stop(); fn(); }); return b; };
  const status = document.createElement("span");
  status.setAttribute("aria-live", "polite");
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  bar.append(mk("Previous", () => show(i - 1)), status, mk("Next", () => show(i + 1)));
  root.before(bar);
  root.setAttribute("aria-roledescription", "carousel");
  root.addEventListener("focusin", stop);
  show(0);
  let reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { reduced = true; }
  if (!reduced) timer = setInterval(() => show(i + 1), 9000);
}
