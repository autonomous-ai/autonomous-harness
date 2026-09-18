// Jev Lander pane — draws a booster descending against a sky, its flame plume scaling with the
// throttle Jev set, live altitude / speed / fuel readouts, and a landing-pad finish. Jev's throttle
// is the beat; the trajectory is the show.

const $ = (id) => document.getElementById(id)
const els = {
  alt: $('alt'), vy: $('vy'), thrust: $('thrust'), fuel: $('fuel'), gravity: $('gravity'), ticks: $('ticks'),
  rAlt: $('r-alt'), rVy: $('r-vy'), rFuel: $('r-fuel'), rG: $('r-g'), banner: $('banner'), log: $('log'),
  scene: $('scene'),
}

let y = 80, v = 0, fuel = 260, gravity = 1.2, safeSpeed = 2.0
let thrust = 'COAST'
let ticks = 0
let finished = null
let history = []

const THRUST_LABEL = { CUT: 'cut', COAST: 'coast', HOVER: 'hover', BURN: 'burn' }

// ---- flame plumes per throttle (3 tiers of chaos sampled deterministically per frame) ----
const FLAMES = {
  CUT: [],
  COAST: [[0, 14, 4]],
  HOVER: [[0, 30, 8], [-5, 24, 5], [5, 24, 5]],
  BURN: [[0, 52, 12], [-10, 44, 8], [10, 44, 8], [-4, 40, 6], [4, 40, 6]],
}

function draw() {
  const c = els.scene
  const ctx = c.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth, H = c.clientHeight
  c.width = W * dpr; c.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  // sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#02040a')
  sky.addColorStop(0.6, '#0a1024')
  sky.addColorStop(1, '#1a1f35')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)

  // a horizon ring of light low on the sky
  ctx.fillStyle = 'rgba(94,234,212,.06)'
  ctx.fillRect(0, H * 0.82, W, H * 0.18)

  // stars
  const starSeed = 20260919
  for (let i = 0; i < 40; i++) {
    const sx = ((starSeed * (i + 3)) % 997) / 997
    const sy = ((starSeed * (i * 7 + 11)) % 991) / 991
    ctx.fillStyle = `rgba(255,255,255,${0.25 + ((i * 13) % 5) / 16})`
    ctx.fillRect(sx * W, sy * H * 0.7, 1.4, 1.4)
  }

  // pad & ground
  const padW = 120, padH = 10
  const padX = (W - padW) / 2, padY = H - 34
  ctx.fillStyle = '#3b4254'
  ctx.fillRect(0, padY + padH, W, H - padY - padH)
  ctx.fillStyle = '#232838'
  ctx.fillRect(padX, padY, padW, padH)
  ctx.fillStyle = '#5eead4'
  ctx.fillRect(padX + 10, padY - 3, padW - 20, 3)
  ctx.fillStyle = 'rgba(94,234,212,.25)'
  ctx.fillRect(0, padY, W, 2)

  // where the rocket is: map [0..alt] -> near the pad .. near the top
  const shownY = Math.max(0.5, y)
  let rx, ry, scale
  // boosters start high and far; as they near the pad they grow and center
  const progress = Math.min(1, shownY / 50)
  scale = 0.7 + 1.6 * (1 - progress)
  ry = padY - 4 - progress * (padY - 40)
  rx = W / 2

  const rocketW = 16 * scale, rocketH = 34 * scale

  // flame plume behind/under the rocket
  const flames = FLAMES[thrust] || []
  for (const [ox, len, wid] of flames) {
    const flicker = 0.75 + 0.5 * ((Date.now() / 60 + ox) % 1)
    ctx.fillStyle = thrust === 'BURN' ? `rgba(251,191,36,${0.9 * flicker})` : `rgba(245,158,11,${0.75 * flicker})`
    ctx.beginPath()
    ctx.moveTo(rx - wid * scale, ry + rocketH)
    ctx.lineTo(rx + wid * scale, ry + rocketH)
    ctx.lineTo(rx + ox * scale, ry + rocketH + len * scale * flicker)
    ctx.closePath()
    ctx.fill()
  }

  // rocket body
  ctx.fillStyle = '#dfe5f2'
  ctx.beginPath()
  ctx.moveTo(rx, ry - rocketH * 0.4)
  ctx.lineTo(rx + rocketW / 2, ry)
  ctx.lineTo(rx + rocketW / 2, ry + rocketH)
  ctx.lineTo(rx - rocketW / 2, ry + rocketH)
  ctx.lineTo(rx - rocketW / 2, ry)
  ctx.closePath()
  ctx.fill()
  // window
  ctx.fillStyle = '#141827'
  ctx.beginPath()
  ctx.arc(rx, ry + rocketH * 0.25, 4 * scale, 0, Math.PI * 2)
  ctx.fill()
  // fins
  ctx.fillStyle = '#f59e0b'
  ctx.beginPath()
  ctx.moveTo(rx + rocketW / 2, ry + rocketH * 0.5)
  ctx.lineTo(rx + rocketW * 0.85, ry + rocketH)
  ctx.lineTo(rx + rocketW / 2, ry + rocketH)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(rx - rocketW / 2, ry + rocketH * 0.5)
  ctx.lineTo(rx - rocketW * 0.85, ry + rocketH)
  ctx.lineTo(rx - rocketW / 2, ry + rocketH)
  ctx.closePath()
  ctx.fill()

  // landing done: a vivid ring + burst
  if (finished) {
    const col = finished.ok ? '#34d399' : '#fb7185'
    ctx.strokeStyle = col
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(rx, ry + rocketH, 14 + 6 * ((Date.now() / 160) % 3), 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.arc(rx, ry + rocketH, 4, 0, Math.PI * 2)
    ctx.fill()
  }

  // trajectory trace (altitude over time, inverted)
  ctx.strokeStyle = 'rgba(94,234,212,.5)'
  ctx.lineWidth = 2
  ctx.beginPath()
  history.forEach((h, i) => {
    const x = W * 0.08 + (i / Math.max(1, history.length - 1)) * (W * 0.84)
    const yy = padY - 4 - (Math.min(1, h.y / 50)) * (padY - 40)
    i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy)
  })
  ctx.stroke()
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-40)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="a">${esc(h.action)}</span><span class="y">${h.y.toFixed(0)}</span><span class="v">${h.v.toFixed(1)}</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function faviconBanner() {
  if (!finished) { els.banner.classList.add('hidden'); return }
  els.banner.classList.remove('hidden')
  els.banner.textContent = finished.ok
    ? `✓ LANDED SOFT · ${finished.ticks} ticks · ${finished.fuelLeft} fuel left`
    : `✗ CRASHED at ${finished.crashSpeed.toFixed(1)} · ${finished.ticks} ticks`
  els.banner.className = 'banner ' + (finished.ok ? 'ok' : 'bad')
}

function onTick(msg) {
  if (typeof msg.y === 'number') y = msg.y
  if (typeof msg.v === 'number') v = msg.v
  if (typeof msg.fuel === 'number') fuel = msg.fuel
  if (typeof msg.gravity === 'number') gravity = msg.gravity
  if (typeof msg.safeSpeed === 'number') safeSpeed = msg.safeSpeed
  thrust = msg.thrust || thrust
  ticks = msg.step ?? ticks
  finished = msg.finished || null
  history = msg.history || history

  const vy = Math.abs(v) < 0.05 ? 0 : v
  els.alt.textContent = y.toFixed(0)
  els.vy.textContent = (vy >= 0 ? '+' : '') + vy.toFixed(1)
  els.thrust.textContent = thrust
  els.fuel.textContent = String(Math.round(fuel))
  els.gravity.textContent = 'g' + gravity.toFixed(1)
  els.ticks.textContent = String(ticks)
  els.rAlt.textContent = y.toFixed(1)
  els.rVy.textContent = (vy >= 0 ? '+' : '') + vy.toFixed(1)
  els.rFuel.textContent = String(Math.round(fuel))
  els.rG.textContent = gravity.toFixed(2)

  faviconBanner()
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
  setInterval(draw, 120) // keep flame flicker alive between ticks
}
connect()
