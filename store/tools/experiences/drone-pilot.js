let course,
  state,
  flightRunning = false,
  autopilot = true,
  telemetry = [],
  keys = {},
  touchInput = { x: 0, y: 0 },
  accumulator = 0,
  previousTime = 0;
function projectFlight(x, y, z, w, h) {
  const dz = z - state.z;
  if (dz < 0.6) return null;
  const scale = (w * 0.8) / dz;
  return {
    x: w / 2 + (x - state.x) * scale,
    y: h * 0.47 - (y - state.y) * scale,
    scale,
  };
}
function drawFlight() {
  if (!state) return;
  const c = $("#flight"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#243e4a");
  sky.addColorStop(0.53, "#849c9a");
  sky.addColorStop(1, "#576654");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d7d9af";
  ctx.beginPath();
  ctx.arc(w * 0.72, h * 0.23, w * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(w / 2, h * 0.5);
  ctx.rotate(-state.vx * 0.009);
  ctx.translate(-w / 2, -h * 0.5);
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = ["#708989", "#5d7777", "#476164"][layer];
    ctx.beginPath();
    ctx.moveTo(-w, h);
    for (let i = -1; i <= 24; i++) {
      const x = (i * w) / 22;
      const y =
        h * (0.4 + layer * 0.035) -
        Math.sin(i * 1.2 + layer * 2.2 + (hash(seed) % 20)) * h * 0.05 -
        Math.cos(i * 2.7) * h * 0.025;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w * 2, h);
    ctx.fill();
  }
  const base = Math.floor(state.z / 14) * 14;
  for (let z = base + 250; z > state.z + 1; z -= 14) {
    const a = projectFlight(-80, 0, z, w, h),
      b = projectFlight(80, 0, z, w, h);
    if (!a || !b) continue;
    ctx.strokeStyle = "#bed3ae24";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let x = -80; x <= 80; x += 10) {
    const a = projectFlight(x, 0, state.z + 2, w, h),
      b = projectFlight(x, 0, state.z + 270, w, h);
    ctx.strokeStyle = "#bed3ae20";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // Cliff columns are projected in world space; their parallax makes steering legible.
  const boxes = [];
  for (let i = Math.floor(state.z / 28); i < Math.floor(state.z / 28) + 12; i++)
    for (const side of [-1, 1]) {
      const r = random(seed, `rock:${i}:${side}`);
      boxes.push({
        x: side * (34 + r() * 22),
        z: i * 28 + 12,
        y: 12 + r() * 35,
        width: 8 + r() * 7,
      });
    }
  for (const box of boxes.sort((a, b) => b.z - a.z)) {
    const p = [
      projectFlight(box.x - box.width, 0, box.z, w, h),
      projectFlight(box.x + box.width, 0, box.z, w, h),
      projectFlight(box.x + box.width, box.y, box.z, w, h),
      projectFlight(box.x - box.width, box.y, box.z, w, h),
    ];
    if (p.some((v) => !v)) continue;
    ctx.fillStyle = box.x < 0 ? "#344f53" : "#3d5558";
    ctx.beginPath();
    p.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#768d7744";
    ctx.stroke();
  }
  for (let i = course.length - 1; i >= state.next; i--) {
    const gate = course[i],
      p = projectFlight(gate.x, gate.y, gate.z, w, h);
    if (!p || gate.z - state.z > 260) continue;
    const radius = gate.radius * p.scale;
    ctx.strokeStyle = i === state.next ? "#d9f0a7" : "#bfd9bc66";
    ctx.lineWidth = Math.max(2, p.scale * 0.35);
    ctx.shadowColor = "#ddf7af";
    ctx.shadowBlur = i === state.next ? 9 : 0;
    ctx.beginPath();
    for (let j = 0; j <= 8; j++) {
      const a = Math.PI / 8 + (j * Math.PI) / 4,
        x = p.x + Math.cos(a) * radius,
        y = p.y + Math.sin(a) * radius;
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = `${clamp(p.scale * 1.8, 10, 50)}px monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#e6f3cc";
    ctx.fillText(String(i + 1).padStart(2, "0"), p.x, p.y - radius - 8);
  }
  ctx.restore();
  drawMinimap();
}
function drawMinimap() {
  const c = $("#minimap"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height;
  if (!course) return;
  ctx.clearRect(0, 0, w, h);
  const pos = (x, z) => ({
    x: w / 2 + (x / 90) * w,
    y: h - 12 - (z / (course.at(-1).z + 30)) * (h - 24),
  });
  ctx.strokeStyle = "#94b2a95c";
  ctx.beginPath();
  course.forEach((g, i) => {
    const p = pos(g.x, g.z);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.stroke();
  course.forEach((g, i) => {
    const p = pos(g.x, g.z);
    ctx.fillStyle = i < state.next ? "#8eac99" : "#cde4a1";
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  });
  ctx.strokeStyle = "#dfa578";
  ctx.beginPath();
  telemetry.forEach((t, i) => {
    const p = pos(t.x, t.z);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.stroke();
  const p = pos(state.x, state.z);
  ctx.fillStyle = "#f4eac7";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fill();
}
function updateFlightHUD() {
  $("#velocity").textContent = flightRunning ? state.speed.toFixed(1) : "0";
  $("#altitude").textContent = state.y.toFixed(1);
  $("#gates").textContent = `${state.passed} / ${course.length}`;
  $("#flight-clock").textContent =
    `${String(Math.floor(state.time / 60)).padStart(2, "0")}:${(state.time % 60).toFixed(2).padStart(5, "0")}`;
  $("#flight-mode").textContent =
    `${flightRunning ? "FLYING" : "PAUSED"} / ${autopilot ? "AUTOPILOT" : "MANUAL"}`;
  $("#gate-hint").textContent =
    state.next < course.length
      ? `GATE ${String(state.next + 1).padStart(2, "0")} · ${Math.max(0, course[state.next].z - state.z).toFixed(0)} m · ${state.missed} missed`
      : "Course complete";
  $("#start-flight").textContent = flightRunning
    ? "Ⅱ Pause flight"
    : autopilot
      ? "▶ Watch autopilot"
      : "▶ Resume flight";
  $("#manual").textContent = autopilot ? "Take control" : "Engage autopilot";
}
function resetFlight() {
  course = flightCourse(seed);
  state = flightStart();
  telemetry = [{ ...state }];
  flightRunning = false;
  accumulator = 0;
  keys = {};
  $("#flight-summary").hidden = true;
  updateFlightHUD();
  drawFlight();
}
$("#start-flight").onclick = () => {
  if (state.finished || state.crashed) resetFlight();
  flightRunning = !flightRunning;
  updateFlightHUD();
  $("#flight").focus();
};
$("#manual").onclick = () => {
  autopilot = !autopilot;
  flightRunning = true;
  updateFlightHUD();
  $("#flight").focus();
};
$("#reset-flight").onclick = resetFlight;
addEventListener("keydown", (e) => {
  if (editable(e.target)) return;
  if (
    [
      "w",
      "a",
      "s",
      "d",
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
      " ",
      "shift",
    ].includes(e.key.toLowerCase())
  ) {
    e.preventDefault();
    keys[e.key.toLowerCase()] = true;
  }
});
addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});
addEventListener("blur", () => {
  keys = {};
  touchInput = { x: 0, y: 0 };
});
$$(".flight-pad button").forEach((b) => {
  b.onpointerdown = (e) => {
    e.preventDefault();
    autopilot = false;
    flightRunning = true;
    touchInput[b.dataset.axis] = +b.dataset.value;
    b.setPointerCapture(e.pointerId);
    updateFlightHUD();
  };
  b.onpointerup = b.onpointercancel = () => {
    touchInput[b.dataset.axis] = 0;
  };
});
$("#export-flight").onclick = () =>
  saveFile(
    `vector-${hash(seed)}.json`,
    JSON.stringify(
      {
        seed,
        mode: autopilot ? "autopilot" : "manual",
        step: 1 / 60,
        course,
        telemetry,
        result: state,
      },
      null,
      2,
    ),
  );
function flightFrame(time) {
  const delta = Math.min(0.1, (time - previousTime) / 1000 || 0);
  previousTime = time;
  if (flightRunning && !document.hidden) {
    accumulator += delta;
    while (accumulator >= 1 / 60) {
      state = flightStep(state, course, {
        autopilot,
        x:
          touchInput.x +
          (keys.d || keys.arrowright ? 1 : 0) -
          (keys.a || keys.arrowleft ? 1 : 0),
        y:
          touchInput.y +
          (keys.w || keys.arrowup ? 1 : 0) -
          (keys.s || keys.arrowdown ? 1 : 0),
        brake: keys[" "],
        boost: keys.shift,
      });
      accumulator -= 1 / 60;
      if (state.steps % 12 === 0) telemetry.push({ ...state });
      if (state.finished || state.crashed) {
        flightRunning = false;
        $("#flight-summary").hidden = false;
        $("#flight-summary").replaceChildren(
          document.createTextNode(
            state.crashed
              ? "Back to the flight line."
              : state.missed
                ? "A line to improve."
                : "A clean run.",
          ),
        );
        const span = document.createElement("span");
        span.textContent = `${state.passed} / ${course.length} gates · ${state.time.toFixed(2)} s · ${state.missed} missed`;
        $("#flight-summary").append(span);
        break;
      }
    }
    updateFlightHUD();
    drawFlight();
  }
  requestAnimationFrame(flightFrame);
}
fitCanvas($("#flight"), drawFlight);
fitCanvas($("#minimap"), drawMinimap);
addEventListener("seedchange", resetFlight);
resetFlight();
requestAnimationFrame(flightFrame);
ready();
