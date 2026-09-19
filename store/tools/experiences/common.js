const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
let seed = (params.get("seed") || "42").slice(0, 128);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const parentMessage = (message) => {
  if (parent !== window) parent.postMessage(message, "*");
};
function toast(message) {
  $("#toast").textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $("#toast").textContent = "";
  }, 3500);
}
function saveFile(name, content, type = "application/json") {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function canvasPNG(canvas, name) {
  canvas.toBlob((blob) => {
    if (blob) saveFile(name, blob);
    else toast("Image export failed. Please try again.");
  });
}
function setSeed(value) {
  seed = String(value).trim().slice(0, 128) || "42";
  $("#seed").value = seed;
  const url = new URL(location.href);
  url.searchParams.set("seed", seed);
  try {
    history.replaceState(null, "", url);
  } catch {
    /* Opaque-origin iframe: the shell owns its URL. */
  }
  parentMessage({ type: "harness:state", seed });
  dispatchEvent(new CustomEvent("seedchange", { detail: seed }));
}
$("#seed").value = seed;
$("#seed-form").addEventListener("submit", (e) => {
  e.preventDefault();
  setSeed($("#seed").value);
});
$("#next-seed").addEventListener("click", () =>
  setSeed(/^\d{1,9}$/.test(seed) ? Number(seed) + 1 : hash(seed)),
);
function fitCanvas(canvas, draw, maxDpr = 2) {
  const observer = new ResizeObserver(() => {
    const box = canvas.getBoundingClientRect(),
      dpr = Math.min(devicePixelRatio || 1, maxDpr);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    draw?.();
  });
  observer.observe(canvas);
  return observer;
}
const editable = (target) =>
  target instanceof Element &&
  !!target.closest("input,textarea,select,[contenteditable=true]");
addEventListener("error", (e) =>
  parentMessage({ type: "harness:error", message: e.message }),
);
addEventListener("unhandledrejection", (e) =>
  parentMessage({
    type: "harness:error",
    message: String(e.reason?.message || e.reason),
  }),
);
function ready() {
  document.body.dataset.ready = "true";
  parentMessage({ type: "harness:ready", title: document.title, seed });
}
