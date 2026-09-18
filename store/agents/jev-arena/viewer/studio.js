// Jev Arena studio — the pane that renders Jev's live decisions. Connects via SSE, draws the grid
// onto a canvas with a soft, attractive look, and animates the "Jev brain" probability readout.

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

let state = {
  type: 'frame', moves: 0, reachedGoal: false, coinsCollected: 0,
  running: false, hero: { x: 1, y: 1 }, coins: [], goal: { x: 10, y: 10 },
  walls: [], size: 12, decisionLog: [], speed: 300, model: 'jev-latest', client: 'mock',
};
let lastAction = null;

// --- canvas sizing ---
function sizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const side = Math.min(rect.width - 4, 640);
  canvas.width = side;
  canvas.height = side;
  draw();
}
window.addEventListener('resize', sizeCanvas);

// --- drawing ---
const COLORS = {
  bg: '#0f1422', cell: '#161e31', wall: '#2c3a5e', coin: '#ffce6b',
  goal: '#5ee0c0', hero: '#7aa2ff', heroStroke: '#ffffff', trail: 'rgba(122,162,255,0.18)',
};
function draw() {
  const W = canvas.width, size = state.size || 12;
  const cell = W / size;
  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, W);

  // grid
  ctx.strokeStyle = 'rgba(38,49,78,0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i++) {
    ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, W); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(W, i * cell); ctx.stroke();
  }

  // walls
  for (const w of state.walls || []) {
    ctx.fillStyle = COLORS.wall;
    ctx.fillRect(w.x * cell + 1, w.y * cell + 1, cell - 2, cell - 2);
  }
  // coins
  for (const c of state.coins || []) {
    const cx = c.x * cell + cell / 2, cy = c.y * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.coin;
    ctx.shadowColor = COLORS.coin; ctx.shadowBlur = 14;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(cx - cell*0.06, cy - cell*0.06, cell*0.10, 0, Math.PI*2); ctx.fill();
  }
  // goal
  const g = state.goal;
  if (g) {
    const cx = g.x * cell + cell/2, cy = g.y * cell + cell/2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((Date.now() / 900) % (Math.PI * 2));
    ctx.fillStyle = COLORS.goal;
    ctx.shadowColor = COLORS.goal; ctx.shadowBlur = 18;
    drawStar(ctx, 0, 0, 5, cell*0.34, cell*0.15);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  // hero with a soft glow + trail
  if (state.hero) {
    const hx = state.hero.x * cell + cell/2, hy = state.hero.y * cell + cell/2;
    ctx.beginPath(); ctx.arc(hx, hy, cell*0.30, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(122,162,255,0.15)'; ctx.fill();
    ctx.beginPath(); ctx.arc(hx, hy, cell*0.34, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(122,162,255,0.4)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(hx, hy, cell*0.24, 0, Math.PI*2);
    ctx.fillStyle = COLORS.hero;
    ctx.shadowColor = COLORS.hero; ctx.shadowBlur = 18;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.heroStroke; ctx.lineWidth = 1.5; ctx.stroke();
    // eyes → direction of last action
    const dir = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }[lastAction] || [0,0];
    const ex = hx + dir[0]*cell*0.09, ey = hy + dir[1]*cell*0.09;
    ctx.fillStyle = '#0a0f1e';
    ctx.beginPath(); ctx.arc(ex - 5, ey, 2.6, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5, ey, 2.6, 0, Math.PI*2); ctx.fill();
  }
}
function drawStar(ctx, cx, cy, points, outer, inner) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
}

// --- brain UI ---
const ACTION_NAMES = { up: '⬆ up', down: '⬇ down', left: '⬅ left', right: '➡ right', wait: '⋯ wait' };
function renderActions(frame) {
  const wrap = $('actions');
  const log = (frame.decisionLog || []).slice(-1)[0];
  const probs = log?.probabilities || {};
  const entries = Object.entries(probs).length ? Object.entries(probs).sort((a, b) => b[1] - a[1]) : [];
  const chosen = log?.move;
  wrap.innerHTML = '';
  if (!entries.length) {
    const div = document.createElement('div');
    div.className = 'action';
    div.innerHTML = '<span class="name">waiting…</span>';
    wrap.appendChild(div);
    return;
  }
  for (const [name, p] of entries) {
    const el = document.createElement('div');
    el.className = 'action' + (name === chosen ? ' chosen' : '');
    const pct = (p * 100).toFixed(1);
    el.innerHTML = `<span class="name">${ACTION_NAMES[name] || name}</span>
      <span class="bar"><i style="width:${Math.max(1, p * 100)}%"></i></span>
      <span class="pct">${pct}%</span>`;
    wrap.appendChild(el);
  }
  // confidence + live
  const cfEl = $('confidence');
  if (log) {
    const cf = Math.round((log.confidence ?? 0) * 100);
    cfEl.textContent = cf + '%';
    $('rail-fill').style.width = (log.confidence ?? 0) * 100 + '%';
  }
}
function renderLog(frame) {
  const ol = $('log');
  ol.innerHTML = '';
  const log = (frame.decisionLog || []).slice(-8).reverse();
  for (const d of log) {
    const li = document.createElement('li');
    const cf = Math.round((d.confidence ?? 0) * 100);
    li.innerHTML = `<span class="n">#${d.at}</span><span class="mv">${ACTION_NAMES[d.move] || d.move}</span><span class="cf">conf ${cf}%</span>`;
    ol.appendChild(li);
  }
}

// --- metering ---
function renderMeta(frame) {
  $('moves').textContent = frame.moves ?? 0;
  $('coins').textContent = frame.coinsCollected ?? 0;
  $('model').textContent = frame.model || 'jev-latest';
  $('client').textContent = frame.client || 'mock';
  $('title').textContent = frame.title || 'Jev Arena';
  if (frame.description) $('description').textContent = frame.description;
  if (frame.rules) $('rules').textContent = frame.rules;
  const live = $('live');
  if (frame.reachedGoal) { live.textContent = 'done'; live.className = 'live done'; }
  else if (frame.running) { live.textContent = 'thinking…'; live.className = 'live thinking'; }
  else { live.textContent = 'paused'; live.className = 'live idle'; }
  $('overlay').hidden = !frame.reachedGoal;
  if (frame.reachedGoal) {
    $('overlay-title').textContent = 'Goal reached ⭐';
    $('overlay-msg').textContent = `Jev crossed the arena in ${frame.moves} decisions and ${frame.coinsCollected} coins.`;
  }
  for (const b of ['start', 'pause', 'step', 'reset', 'reset-big']) {
    $(b).disabled = !!frame.reachedGoal && b !== 'reset' && b !== 'reset-big';
  }
}

// --- SSE ---
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('state', (e) => {
    const frame = JSON.parse(e.data);
    state = { ...state, ...frame };
    state.title = frame.title;
    renderMeta(frame);
    renderActions(frame);
    renderLog(frame);
    lastAction = (frame.decisionLog || []).slice(-1)[0]?.move || null;
    draw();
  });
  es.onerror = () => { /* auto-reconnect */ };
}
function control(cmd) {
  fetch('/control', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}
$('start').onclick = () => control('start');
$('pause').onclick = () => control('pause');
$('step').onclick = () => control('step');
$('reset').onclick = () => control('reset');
$('reset-big').onclick = () => control('reset');

sizeCanvas();
connect();
// gentle perpetual animation for the rotating star + hero pulse
function loop() { draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
