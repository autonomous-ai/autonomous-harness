// Jev Pong pane — draws the court, the bouncing ball, Jev's paddle, the rally and the decision log.
// The ball ricochets; the paddle is Jev's. When a fast ball slips past the left wall, it's a miss.

const $ = (id) => document.getElementById(id)
const els = { rally: $('rally'), best: $('best'), misses: $('misses'), move: $('move'), speed: $('speed'), court: $('court'), gauge: $('gauge'), log: $('log') }

let ball = { x: 140, y: 60, vx: -6, vy: 1 }
let paddleY = 60
let rally = 0, best = 0, misses = 0
let lastMove = 'HOLD'
let lastConf = 0.5
let history = []
let speedBase = 6

// physics constants must mirror viewer defaults
const VIR = { W: 200, H: 120, paddleH: 26, ballR: 3 }

function draw() {
  const cv = els.court, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = cv.clientHeight
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  const sx = W / VIR.W, sy = H / VIR.H

  // court border + centre line
  ctx.strokeStyle = '#1c2030'; ctx.lineWidth = 2
  ctx.strokeRect(2, 2, W - 4, H - 4)
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.strokeStyle = '#161a26'; ctx.stroke()

  // risk band near the paddle wall (where a miss happens)
  ctx.fillStyle = 'rgba(251,113,133,0.06)'
  ctx.fillRect(0, 0, 14, H)

  // predicted intercept ghost: where the ball will cross the left wall (simple bounce fold)
  if (ball.vx < 0) {
    const span = VIR.H - 2 * VIR.ballR
    const t = -ball.x / (ball.vx || -1)
    const u = ((ball.y - VIR.ballR + ball.vy * t) % (2 * span) + 2 * span) % (2 * span)
    const ty = u <= span ? u + VIR.ballR : 2 * VIR.H - VIR.ballR - (u - span) - VIR.ballR
    const gx = 10, gy = ty * sy
    ctx.strokeStyle = 'rgba(56,189,248,0.25)'; ctx.lineWidth = 1.5
    ctx.beginPath()
    // short fading line from ball to intercept
    ctx.moveTo(ball.x * sx, ball.y * sy)
    ctx.lineTo(gx, gy)
    ctx.stroke()
    ctx.fillStyle = 'rgba(56,189,248,0.4)'
    ctx.beginPath(); ctx.arc(gx, gy, 3, 0, Math.PI * 2); ctx.fill()
  }

  // paddle (Jev)
  const py = paddleY * sy
  const ph = VIR.paddleH * sy
  const hitNear = Math.abs(ball.x - 5) < 14 && Math.abs(ball.y - paddleY) < VIR.paddleH / 2 + 2
  ctx.fillStyle = hitNear ? '#5eead4' : '#38bdf8'
  ctx.shadowColor = '#38bdf8'; ctx.shadowBlur = hitNear ? 18 : 10
  ctx.fillRect(3, py - ph / 2, 9, ph)
  ctx.shadowBlur = 0

  // ball
  const danger = ball.vx < 0 && ball.x < 60
  ctx.fillStyle = danger ? '#fb7185' : '#f8fafc'
  ctx.shadowColor = danger ? '#fb7185' : '#e2e8f0'; ctx.shadowBlur = 10
  ctx.beginPath(); ctx.arc(ball.x * sx, ball.y * sy, VIR.ballR * Math.min(sx, sy), 0, Math.PI * 2); ctx.fill()
  ctx.shadowBlur = 0
}

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-30)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="b">y ${h.ballY.toFixed(0)}</span><span class="m">${h.move}</span><span>${(h.conf * 100).toFixed(0)}%</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function onTick(msg) {
  if (msg.ball) { ball = { ...msg.ball }; paddleY = msg.paddleY ?? paddleY }
  rally = msg.rally ?? rally
  best = msg.bestRally ?? best
  misses = msg.misses ?? misses
  lastMove = msg.lastMove || lastMove
  lastConf = msg.conf ?? lastConf
  history = msg.history || history
  speedBase = msg.speed ?? speedBase

  els.rally.textContent = String(rally)
  els.best.textContent = String(best)
  els.misses.textContent = String(misses)
  els.move.textContent = lastMove
  const curSpeed = Math.abs(ball.vx)
  els.speed.textContent = String(speedBase) + (curSpeed > speedBase ? `→${curSpeed.toFixed(1)}` : '')
  els.gauge.textContent = `ball ${ball.x.toFixed(0)},${ball.y.toFixed(0)} @ ${Math.abs(ball.vx).toFixed(1)} · paddle ${paddleY.toFixed(1)} · conf ${(lastConf * 100).toFixed(0)}% · rally ${rally}`
  draw()
  renderLog()
}

$('pause').onclick = () => ctl('pause')
$('tick').onclick = () => ctl('tick')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

window.addEventListener('resize', draw)

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
