let match,
  turn = 0,
  running = !reducedMotion,
  lastTurnTime = 0;
const policyOptions = () => ({
  coral: $("#coral-policy").value,
  teal: $("#teal-policy").value,
});
function drawArena() {
  if (!match) return;
  const c = $("#arena"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height,
    state = match.history[turn],
    unit = Math.min(w / 13, h / 11),
    left = (w - match.map.w * unit) / 2,
    top = (h - match.map.h * unit) / 2;
  ctx.clearRect(0, 0, w, h);
  const pos = (x, y) => ({
    x: left + (x + 0.5) * unit,
    y: top + (y + 0.5) * unit,
  });
  for (let y = 0; y < match.map.h; y++)
    for (let x = 0; x < match.map.w; x++) {
      const p = pos(x, y),
        wall = match.map.walls.some((v) => v[0] === x && v[1] === y);
      ctx.fillStyle = wall ? "#405262" : (x + y) % 2 ? "#24333f" : "#263743";
      ctx.strokeStyle = "#475d6e33";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(
        p.x - unit * 0.46,
        p.y - unit * 0.46,
        unit * 0.92,
        unit * 0.92,
        unit * 0.08,
      );
      ctx.fill();
      ctx.stroke();
      if (wall) {
        ctx.fillStyle = "#536573";
        ctx.fillRect(
          p.x - unit * 0.3,
          p.y - unit * 0.3,
          unit * 0.6,
          unit * 0.12,
        );
      }
    }
  match.map.relays.forEach((r, i) => {
    const p = pos(r.x, r.y),
      owner = state.owners[i];
    ctx.strokeStyle = owner === -1 ? "#d6c69a" : owner ? "#74c8c2" : "#df896f";
    ctx.lineWidth = 2;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-unit * 0.3, -unit * 0.3, unit * 0.6, unit * 0.6);
    ctx.restore();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = `${unit * 0.16}px monospace`;
    ctx.textAlign = "center";
    ctx.fillText(r.name, p.x, p.y + unit * 0.47);
  });
  state.units
    .filter((u) => !u.wait)
    .forEach((u) => {
      const p = pos(u.x, u.y),
        color = u.team ? "#74c8c2" : "#df896f";
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, unit * 0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#162129";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `bold ${unit * 0.24}px monospace`;
      ctx.fillText((u.id % 3) + 1, p.x, p.y);
      ctx.fillStyle = color;
      for (let i = 0; i < u.hp; i++)
        ctx.fillRect(
          p.x - unit * 0.19 + i * unit * 0.14,
          p.y - unit * 0.39,
          unit * 0.1,
          unit * 0.055,
        );
    });
  ctx.textBaseline = "alphabetic";
}
function showTurn() {
  const state = match.history[turn];
  $("#score-ember").textContent = state.score[0];
  $("#score-tide").textContent = state.score[1];
  $("#turn").textContent = `Turn ${String(turn).padStart(2, "0")} / 72`;
  $("#timeline").value = turn;
  $("#match-state").textContent =
    turn === 72
      ? match.winner === -1
        ? "DRAW"
        : match.winner
          ? "TIDE WINS"
          : "EMBER WINS"
      : turn < 12
        ? "THE OPENING"
        : turn < 50
          ? "THE CONTEST"
          : "THE ENDGAME";
  $("#events").replaceChildren();
  state.log.forEach((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    $("#events").append(p);
  });
  $("#play-match").textContent = running
    ? "Ⅱ Pause"
    : turn === 72
      ? "↻ Replay"
      : "▶ Play";
  drawArena();
}
function newMatch() {
  match = arenaMatch(seed, policyOptions());
  turn = 0;
  $("#tournament-result").textContent = "";
  showTurn();
}
$("#play-match").onclick = () => {
  if (turn === 72) turn = 0;
  running = !running;
  lastTurnTime = performance.now();
  showTurn();
};
$("#step").onclick = () => {
  running = false;
  turn = Math.min(72, turn + 1);
  showTurn();
};
$("#rewind").onclick = () => {
  running = false;
  turn = 0;
  showTurn();
};
$("#timeline").oninput = () => {
  running = false;
  turn = +$("#timeline").value;
  showTurn();
};
for (const id of ["coral-policy", "teal-policy"])
  $("#" + id).onchange = newMatch;
$("#export-replay").onclick = () =>
  saveFile(`relay-${hash(seed)}.json`, JSON.stringify(match, null, 2));
$("#tournament").onclick = async () => {
  const b = $("#tournament");
  b.disabled = true;
  $("#tournament-result").textContent = "Playing 32 independent maps…";
  await new Promise((r) => setTimeout(r, 30));
  const result = arenaTournament(seed, policyOptions());
  $("#tournament-result").textContent =
    `Ember ${result.ember} · Tide ${result.tide} · Draws ${result.draws}. Mean Ember margin: ${result.meanMargin.toFixed(1)} points.`;
  b.disabled = false;
};
function arenaFrame(time) {
  if (running && time - lastTurnTime > +$("#speed").value) {
    turn = Math.min(72, turn + 1);
    if (turn === 72) running = false;
    lastTurnTime = time;
    showTurn();
  }
  requestAnimationFrame(arenaFrame);
}
fitCanvas($("#arena"), drawArena);
addEventListener("seedchange", newMatch);
newMatch();
requestAnimationFrame(arenaFrame);
ready();
