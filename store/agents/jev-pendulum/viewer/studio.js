// Jev Pendulum pane — draws the rod balancing live, the current action, tilt history and falls.
// Renders on a 2D canvas: the rod pivots at the base, the ground line stays fixed, and the rod
// leans as Jev corrects it. When it crosses the fall threshold it tips over and resets.

const $ = (id) => document.getElementById(id)
const els = { title: $('title'), tilt: $('tilt'), action: $('action'), falls: $('falls'), best: $('best'), rod: $('rod'), chart: $('chart'), log: $('log'), gauge: $('gauge'), gustLbl: $('gustLbl') }

let angleDeg = 0
let vel = 0
let step = 0
let falls = 0
let bestRun = 0
let lastAction = 'CENTER'
let lastConf = 0.5
let history = []
let gustEvery = 10

function drawRod() {
  const cv = els.rod, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = 380
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  const cx = W / 2, baseY = H - 40
  const rodLen = H * 0.78
  const a = angleDeg * Math.PI / 180
  const tipX = cx + rodLen * Math.sin(a)
  const tipY = baseY - rodLen * Math.cos(a)

  // ground
  ctx.strokeStyle = '#2a2f42'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(W, baseY); ctx.stroke()
  ctx.fillStyle = '#1a1e2c'; ctx.fillRect(0, baseY, W, 8)

  // fall wedge (danger zone at ±fallDeg)
  const fallDeg = 60
  ctx.fillStyle = 'rgba(251,113,133,0.08)'
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(cx, baseY)
    ctx.lineTo(cx + s * Math.sin(fallDeg * Math.PI / 180) * rodLen, baseY - Math.cos(fallDeg * Math.PI / 180) * rodLen)
    ctx.lineTo(cx + s * Math.sin(fallDeg * Math.PI / 180) * rodLen * 1.3, baseY)
    ctx.closePath(); ctx.fill()
  }
  // danger line at fallDeg
  ctx.strokeStyle = 'rgba(251,113,133,0.25)'; ctx.lineWidth = 1
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx, baseY); ctx.lineTo(cx + s * Math.sin(fallDeg * Math.PI / 180) * rodLen, baseY - Math.cos(fallDeg * Math.PI / 180) * rodLen); ctx.stroke() }

  // rod
  const danger = Math.abs(angleDeg) > fallDeg * 0.7
  ctx.strokeStyle = danger ? '#fb7185' : '#c084fc'
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  ctx.shadowColor = danger ? '#fb7185' : '#a855f7'
  ctx.shadowBlur = danger ? 22 : 12
  ctx.beginPath(); ctx.moveTo(cx, baseY); ctx.lineTo(tipX, tipY); ctx.stroke()
  ctx.shadowBlur = 0

  // tip ball
  ctx.fillStyle = danger ? '#fb7185' : '#5eead4'
  ctx.beginPath(); ctx.arc(tipX, tipY, 8, 0, Math.PI * 2); ctx.fill()

  // pivot
  ctx.fillStyle = '#e8eaf2'
  ctx.beginPath(); ctx.arc(cx, baseY, 6, 0, Math.PI * 2); ctx.fill()

  // angle readout near the rod
  ctx.fillStyle = '#8a90a6'; ctx.font = '12px ' + 'monospace'
  ctx.fillText(`${angleDeg.toFixed(1)}°`, cx + rodLen * 0.5 * Math.sin(a) + 12, baseY - rodLen * 0.5 * Math.cos(a))
}

function drawChart() {
  const cv = els.chart, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = 150
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  if (history.length < 2) { ctx.fillStyle = '#4b5266'; ctx.fillText('watching…', 10, 14); return }
  const pts = history.slice(-180)
  const pad = { l: 30, r: 8, t: 8, b: 18 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  // fixed scale 0..65° (absolute tilt) so the fall threshold is a real line
  const lim = 65
  // gridlines at target angles
  ctx.strokeStyle = '#1c2030'; ctx.lineWidth = 1
  for (const deg of [0, 15, 30, 45, 60]) {
    const y = pad.t + plotH - (deg / lim) * plotH
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke()
    ctx.fillStyle = '#4b5266'; ctx.font = '9px ' + 'monospace'; ctx.fillText(String(deg), 2, y - 3)
  }
  ctx.strokeStyle = 'rgba(251,113,133,0.5)'; ctx.lineWidth = 1
  const fallY = pad.t + plotH - (60 / lim) * plotH
  ctx.beginPath(); ctx.moveTo(pad.l, fallY); ctx.lineTo(W - pad.r, fallY); ctx.stroke()
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.5; ctx.beginPath()
  pts.forEach((h, i) => { const x = pad.l + (i / (pts.length - 1)) * plotW; const y = pad.t + plotH - (Math.min(lim, h.deg) / lim) * plotH; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
  ctx.stroke()
}

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-30)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="d">${h.deg.toFixed(1)}°</span><span class="a">${h.action}</span><span>${(h.conf * 100).toFixed(0)}%</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function onTick(msg) {
  els.title.textContent = msg.title || ''
  angleDeg = msg.angle ?? angleDeg
  vel = msg.vel ?? vel
  step = msg.step ?? step
  falls = msg.falls ?? falls
  bestRun = msg.bestRun ?? bestRun
  lastAction = msg.lastAction || lastAction
  lastConf = msg.conf ?? lastConf
  history = msg.history || history
  gustEvery = msg.gustEvery ?? gustEvery
  els.gustLbl.textContent = msg.gustEvery || 'some'

  els.tilt.textContent = angleDeg.toFixed(1) + '°'
  els.tilt.style.color = Math.abs(angleDeg) > 60 * 0.7 ? 'var(--rose)' : 'var(--amber)'
  els.action.textContent = lastAction
  els.falls.textContent = String(falls)
  const min = (bestRun * (msg.stepMs || 80)) / 1000 / 60
  els.best.textContent = min.toFixed(1) + ' min'
  els.gauge.textContent = `angle ${angleDeg.toFixed(1)}° · velocity ${vel.toFixed(2)} rad/s · conf ${(lastConf * 100).toFixed(0)}%`
  drawRod()
  drawChart()
  renderLog()
}

$('pause').onclick = () => ctl('pause')
$('tick').onclick = () => ctl('tick')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

window.addEventListener('resize', () => { drawRod(); drawChart() })

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
