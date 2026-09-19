let points = [],
  visible = [],
  showControl = true,
  showTreatment = true,
  collected = Infinity,
  collectTimer;
const groupColors = ["#73b3b5", "#efc273"];
function experimentOptions() {
  return {
    effect: +$("#effect").value,
    noise: +$("#noise").value,
    count: +$("#count").value,
  };
}
function drawChart() {
  const c = $("#chart"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height;
  if (!w || !h) return;
  const d = w / c.getBoundingClientRect().width,
    m = { l: 53 * d, r: 22 * d, t: 24 * d, b: 48 * d };
  const low = Math.floor(Math.min(0, ...points.map((p) => p.y)) / 20) * 20,
    high = Math.ceil(Math.max(100, ...points.map((p) => p.y)) / 20) * 20;
  const px = (x) => m.l + (x / 100) * (w - m.l - m.r),
    py = (y) => h - m.b - ((y - low) / (high - low)) * (h - m.b - m.t);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${10 * d}px monospace`;
  ctx.lineWidth = d;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 5; i++) {
    const y = low + ((high - low) * i) / 5;
    ctx.strokeStyle = "#8ea4aa20";
    ctx.beginPath();
    ctx.moveTo(m.l, py(y));
    ctx.lineTo(w - m.r, py(y));
    ctx.stroke();
    ctx.fillStyle = "#98abb1";
    ctx.fillText(y.toFixed(0), m.l - 12 * d, py(y));
    const x = i * 20;
    ctx.textAlign = "center";
    ctx.fillText(x, px(x), h - m.b + 20 * d);
    ctx.textAlign = "right";
  }
  ctx.save();
  ctx.translate(15 * d, h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("Yield (%)", 0, 0);
  ctx.restore();
  ctx.textAlign = "center";
  ctx.fillText("Temperature (°C)", w / 2, h - 10 * d);
  for (const group of [0, 1]) {
    const subset = visible.filter((p) => p.group === group);
    if (subset.length < 2) continue;
    const r = regression(subset);
    ctx.strokeStyle = groupColors[group];
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([5 * d, 4 * d]);
    ctx.beginPath();
    ctx.moveTo(px(10), py(r.intercept + r.slope * 10));
    ctx.lineTo(px(90), py(r.intercept + r.slope * 90));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  visible.forEach((p) => {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = groupColors[p.group];
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), 3.5 * d, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  drawChart.project = (p) => ({ x: px(p.x) / d, y: py(p.y) / d });
}
function drawInterval() {
  const c = $("#interval-chart"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height;
  const e = treatmentEffect(points.slice(0, collected)),
    min = Math.min(-20, e.low - 3),
    max = Math.max(30, e.high + 3),
    px = (v) => 25 + ((v - min) / (max - min)) * (w - 50);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#98abb1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(25, h * 0.5);
  ctx.lineTo(w - 25, h * 0.5);
  ctx.stroke();
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(px(0), h * 0.15);
  ctx.lineTo(px(0), h * 0.7);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 7;
  ctx.strokeStyle = "#efc273";
  ctx.beginPath();
  ctx.moveTo(px(e.low), h * 0.5);
  ctx.lineTo(px(e.high), h * 0.5);
  ctx.stroke();
  ctx.fillStyle = "#e9efe9";
  ctx.beginPath();
  ctx.arc(px(e.difference), h * 0.5, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#98abb1";
  ctx.font = "18px monospace";
  ctx.textAlign = "center";
  ctx.fillText("0", px(0), h * 0.9);
  ctx.fillText("95% interval", w / 2, h * 0.12);
}
function updateBench() {
  const partial = points.slice(0, collected);
  visible = partial.filter((p) => (p.group ? showTreatment : showControl));
  const e = treatmentEffect(partial),
    r = regression(visible);
  $("#sample-count").textContent = visible.length;
  $("#effect-estimate").textContent =
    `${e.difference >= 0 ? "+" : ""}${e.difference.toFixed(1)}`;
  $("#r-squared").textContent = visible.length > 1 ? r.r2.toFixed(2) : "—";
  $("#conclusion").textContent =
    e.low > 0
      ? "A positive signal emerges."
      : e.high < 0
        ? "The catalyst reduces yield."
        : "The effect is still uncertain.";
  $("#interval").textContent =
    `95% interval: ${e.low.toFixed(1)} to ${e.high.toFixed(1)} percentage points · both groups, ${partial.length} samples.`;
  $("#observations").replaceChildren();
  visible.slice(0, 12).forEach((p) => {
    const tr = document.createElement("tr");
    for (const text of [
      p.id,
      p.group ? "Catalyst" : "Control",
      p.x.toFixed(2),
      p.y.toFixed(2),
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    $("#observations").append(tr);
  });
  drawChart();
  drawInterval();
}
function generateExperiment() {
  clearInterval(collectTimer);
  collected = Infinity;
  $("#run").textContent = "Replay collection";
  const options = experimentOptions();
  points = experiment(seed, options);
  $("#effect-value").value = `${options.effect} pp`;
  $("#noise-value").value = `±${options.noise} σ`;
  $("#count-value").value = options.count;
  updateBench();
}
for (const id of ["effect", "noise", "count"])
  $("#" + id).oninput = generateExperiment;
$("#control").onclick = () => {
  if (showControl && !showTreatment)
    return toast("Keep at least one group visible.");
  showControl = !showControl;
  $("#control").setAttribute("aria-pressed", showControl);
  updateBench();
};
$("#treatment").onclick = () => {
  if (showTreatment && !showControl)
    return toast("Keep at least one group visible.");
  showTreatment = !showTreatment;
  $("#treatment").setAttribute("aria-pressed", showTreatment);
  updateBench();
};
$("#run").onclick = () => {
  if (Number.isFinite(collected)) {
    collected = Infinity;
    clearInterval(collectTimer);
    $("#run").textContent = "Replay collection";
    updateBench();
    return;
  }
  collected = 4;
  $("#run").textContent = "Finish collection";
  updateBench();
  collectTimer = setInterval(() => {
    collected += 4;
    if (collected >= points.length) {
      collected = Infinity;
      clearInterval(collectTimer);
      $("#run").textContent = "Replay collection";
    }
    updateBench();
  }, 90);
};
$("#chart").onpointermove = (e) => {
  const box = e.currentTarget.getBoundingClientRect(),
    x = e.clientX - box.left,
    y = e.clientY - box.top;
  let best,
    dist = Infinity;
  for (const p of visible) {
    const pos = drawChart.project(p),
      d = Math.hypot(pos.x - x, pos.y - y);
    if (d < dist) {
      best = p;
      dist = d;
    }
  }
  $("#probe").textContent =
    best && dist < 25
      ? `Sample ${best.id} · ${best.group ? "Catalyst" : "Control"} · ${best.x.toFixed(2)} °C · ${best.y.toFixed(2)}% yield`
      : "Hover a point to inspect an observation.";
};
$("#export-csv").onclick = () =>
  saveFile(`signal-${hash(seed)}.csv`, csvRows(visible), "text/csv");
fitCanvas($("#chart"), drawChart);
fitCanvas($("#interval-chart"), drawInterval);
addEventListener("seedchange", generateExperiment);
generateExperiment();
ready();
