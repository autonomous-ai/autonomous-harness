// Jev Slalom pane — draws a top-down slalom course: the skier descends with snow spray, gates sweep
// toward it and light up blue when threaded, and a finished run shows a clean-run or fell banner.

const $ = (id) => document.getElementById(id)
const els = {
  gate: $('gate'), move: $('move'), speed: $('speed'), pos: $('pos'), ticks: $('ticks'),
  banner: $('banner'), log: $('log'), scene: $('scene'),
}

let x = 9, rows = 0, speed = 2.2, width = 18, move = 'HOLD', ticks = 0
let finished = null
let gates = []
let next = 0
const THREADED = new Set()

function draw() {
  const c = els.scene
  const ctx = c.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth, H = c.clientHeight
  c.width = W * dpr; c.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  // snow ground
  const grd = ctx.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, '#eef4fb')
  grd.addColorStop(1, '#cdd9ea')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, W, H)

  // course bounds
  const margin = 30
  const courseLeft = margin, courseRight = W - margin
  const topY = 12, botY = H - 16

  // valley walls
  ctx.strokeStyle = '#8a97ad'; ctx.lineWidth = 10
  ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(courseLeft, topY); ctx.lineTo(courseLeft, botY); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(courseRight, topY); ctx.lineTo(courseRight, botY); ctx.stroke()

  const px = (gateX) => courseLeft + (gateX / width) * (courseRight - courseLeft)
  const py = (row) => botY - (row / 130) * (botY - topY)

  // threading gates: draw from far (top) to near (bottom)
  for (let i = gates.length - 1; i >= 0; i--) {
    const g = gates[i]
    if (g.y < rows - 90) continue
    const gx = px(g.x), gy = py(g.y)
    const threaded = THREADED.has(i)
    ctx.strokeStyle = threaded ? '#10b981' : '#e11d48'
    ctx.lineWidth = 6
    ctx.lineCap = 'round'
    const half = (g.gap / width) * (courseRight - courseLeft) / 2
    ctx.beginPath(); ctx.moveTo(gx - half, gy); ctx.lineTo(gx + half, gy); ctx.stroke()
    // flags
    ctx.fillStyle = threaded ? '#34d399' : '#f43f5e'
    ctx.beginPath(); ctx.arc(gx - half, gy, 4, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(gx + half, gy, 4, 0, Math.PI * 2); ctx.fill()
  }

  // snow trail from history
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 8
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  if (history.length > 1) {
    ctx.beginPath()
    history.forEach((h, i) => {
      const hx = px(h.x), hy = py(h.rows)
      i ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy)
    })
    ctx.stroke()
  }

  // skier
  const sx = px(x), sy = py(rows)
  // spray
  ctx.fillStyle = 'rgba(255,255,255,.9)'
  for (let i = 0; i < 5; i++) {
    ctx.beginPath()
    ctx.arc(sx + (3 - i) * 3, sy, 3 + i * 1.2, 0, Math.PI * 2)
    ctx.fill()
  }
  // body
  ctx.fillStyle = '#1f2937'
  ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#f59e0b'
  ctx.beginPath()
  ctx.moveTo(sx, sy - 9)
  ctx.lineTo(sx + 7, sy)
  ctx.lineTo(sx - 7, sy)
  ctx.closePath(); ctx.fill()

  // target gate highlight
  const cur = gates[next]
  if (cur) {
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([4, 4])
    const gx = px(cur.x), gy = py(cur.y)
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(gx, gy); ctx.stroke()
    ctx.setLineDash([])
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-30)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="a">${esc(h.move)}</span><span class="p">x ${h.x.toFixed(1)}</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function renderBanner() {
  if (!finished) { els.banner.classList.add('hidden'); return }
  els.banner.classList.remove('hidden')
  els.banner.textContent = finished.ok
    ? `✓ CLEAN RUN · ${finished.gates} gates threaded`
    : `✗ FELL at gate ${finished.atGate + 1} · ${finished.reason}`
  els.banner.className = 'banner ' + (finished.ok ? 'ok' : 'bad')
}

let history = []

function onTick(msg) {
  if (typeof msg.x === 'number') x = msg.x
  if (typeof msg.rows === 'number') rows = msg.rows
  if (typeof msg.speed === 'number') speed = msg.speed
  if (typeof msg.valleyWidth === 'number') width = msg.valleyWidth
  move = msg.move || move
  ticks = msg.step ?? ticks
  finished = msg.finished || null
  gates = msg.gates || gates
  next = msg.next ?? next
  history = msg.history || history

  THREADED.clear()
  gates.forEach((g, i) => { if (g.passed) THREADED.add(i) })

  els.gate.textContent = finished ? '—' : `${Math.min(next + 1, gates.length)}/${gates.length}`
  els.move.textContent = move
  els.speed.textContent = 'v' + speed.toFixed(1)
  els.pos.textContent = 'x' + x.toFixed(1)
  els.ticks.textContent = String(ticks)

  renderBanner()
  renderLog()
  draw()
}

$('pause').onclick = () => ctl('pause')
$('tick').onclick = () => ctl('tick')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
