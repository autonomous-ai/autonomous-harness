// Jev Catcher pane — draws a side-on outfield: a glove slides left/right along the ground as pop
// flies arc down from the sky, light up amber when caught, and thud and bounce when dropped. A
// finished session shows a clean-session or dropped banner.

const $ = (id) => document.getElementById(id)
const els = {
  ball: $('ball'), move: $('move'), fall: $('fall'), caught: $('caught'), drops: $('drops'),
  banner: $('banner'), log: $('log'), scene: $('scene'),
}

let glove = 12, move = 'HOLD', catches = 0, drops = 0
let fallTicks = 10, width = 24, ballTicks = 10
let finished = null
let balls = []
let next = 0
let history = []
let prevBallId = -1

// frothy effects: catch flashes and dropped-ball bounces
let flashes = []   // {x, t}
let bounces = []   // {x, y, vy, t}

function draw() {
  const c = els.scene
  const ctx = c.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth, H = c.clientHeight
  c.width = W * dpr; c.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  // sky to grass
  const grd = ctx.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, '#bfe7d6')
  grd.addColorStop(0.5, '#eef7ef')
  grd.addColorStop(0.62, '#79b456')
  grd.addColorStop(1, '#4e8a38')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, W, H)

  const groundY = H * 0.68
  ctx.strokeStyle = 'rgba(30,70,20,.4)'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke()

  const margin = 26
  const fieldLeft = margin, fieldRight = W - margin
  const px = (fx) => fieldLeft + (fx / width) * (fieldRight - fieldLeft)

  // grandstand / fence posts behind the grass line
  ctx.fillStyle = 'rgba(255,255,255,.35)'
  for (let x = fieldLeft; x < fieldRight; x += 38) ctx.fillRect(x, groundY - 18, 3, 18)

  // landing-spot marker for the current ball
  const cur = balls[next]
  if (cur && !cur.done) {
    const lx = px(cur.land)
    ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.ellipse(lx, groundY + 2, 7, 2.5, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
  }

  // the glove (Jev) sliding along the ground
  const gx = px(glove)
  ctx.fillStyle = 'rgba(0,0,0,.22)'
  ctx.beginPath(); ctx.ellipse(gx, groundY + 3, 17, 3, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#b45309'
  ctx.beginPath(); ctx.ellipse(gx, groundY - 9, 15, 10, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#92400e'
  ctx.beginPath(); ctx.ellipse(gx, groundY - 10, 9, 6, 0, 0, Math.PI * 2); ctx.fill()

  // the active ball arcing down to its landing spot
  if (cur && !cur.done && ballTicks > 0) {
    const prog = (fallTicks - ballTicks) / fallTicks   // 0 high, 1 at the ground
    const peakH = H * 0.5
    const bx = px(cur.land)
    const yy = groundY - peakH * ((1 - prog) * (1 - prog))
    // rise-fall trail behind it
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 2
    ctx.beginPath()
    for (let k = 0; k <= 1; k += 0.16) {
      const ky = groundY - peakH * ((1 - Math.max(0, prog - k * 0.5)) ** 2)
      k ? ctx.lineTo(bx, ky) : ctx.moveTo(bx, ky)
    }
    ctx.stroke()
    // the ball itself with a seam
    ctx.fillStyle = '#facc15'
    ctx.beginPath(); ctx.arc(bx, yy, 7, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = '#92400e'; ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(bx - 5, yy); ctx.lineTo(bx + 5, yy)
    ctx.moveTo(bx, yy - 5); ctx.lineTo(bx, yy + 5)
    ctx.stroke()
    // shadow ring as it nears the ground
    ctx.fillStyle = `rgba(0,0,0,${0.12 + prog * 0.2})`
    ctx.beginPath(); ctx.ellipse(bx, groundY + 2, 5 + prog * 6, 2, 0, 0, Math.PI * 2); ctx.fill()
  }

  // catch flash rings
  flashes.forEach((f) => {
    const t = f.t
    ctx.strokeStyle = `rgba(245,158,11,${1 - t})`
    ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(px(f.x), groundY - 8, 14 + t * 34, 0, Math.PI * 2); ctx.stroke()
  })

  // dropped-ball bounces
  bounces.forEach((b) => {
    b.y -= b.vy; b.vy *= 0.8
    if (b.y <= groundY) { b.y = groundY + 0.5; b.vy = Math.abs(b.vy) * 0.55 }
    ctx.fillStyle = `rgba(250,204,21,${Math.max(0, 1 - b.t)})`
    ctx.beginPath(); ctx.arc(px(b.x), b.y, 4, 0, Math.PI * 2); ctx.fill()
  })

  flashes = flashes.map((f) => ({ x: f.x, t: f.t + 0.05 })).filter((f) => f.t < 1)
  bounces = bounces.map((b) => ({ ...b, t: b.t + 0.05 })).filter((b) => b.t < 0.9)
}

function pump() {
  draw()
  if (flashes.length || bounces.length) requestAnimationFrame(pump)
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function renderLog() {
  els.log.textContent = ''
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]
    if (!b.done) break
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${i + 1}</span><span class="p">${b.caught ? '● caught' : '○ drop'}</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function renderBanner() {
  if (!finished) { els.banner.classList.add('hidden'); return }
  els.banner.classList.remove('hidden')
  els.banner.textContent = finished.ok
    ? `✓ CLEAN SESSION · ${finished.caught} caught`
    : `✗ ${finished.caught} caught · ${finished.dropped} dropped`
  els.banner.className = 'banner ' + (finished.ok ? 'ok' : 'bad')
}

function onTick(msg) {
  if (typeof msg.glove === 'number') glove = msg.glove
  if (typeof msg.fallTicks === 'number') fallTicks = msg.fallTicks
  if (typeof msg.fieldWidth === 'number') width = msg.fieldWidth
  if (typeof msg.ballTicks === 'number') ballTicks = msg.ballTicks
  move = msg.move || move
  catches = msg.catches ?? catches
  drops = msg.drops ?? drops
  finished = msg.finished || null
  balls = msg.balls || balls
  next = msg.next ?? next
  history = msg.history || history

  // fresh outcomes -> one-shot effects
  const cur = balls[next - 1]
  if (cur && cur.done && next - 1 !== prevBallId) {
    if (cur.caught) flashes.push({ x: cur.land, t: 0 })
    else bounces.push({ x: cur.land, y: groundYFrom(), vy: 8, t: 0 })
    prevBallId = next - 1
  }

  els.ball.textContent = finished ? '—' : `${Math.min(next + 1, balls.length)}/${balls.length}`
  els.move.textContent = move
  els.fall.textContent = fallTicks + 't'
  els.caught.textContent = String(catches)
  els.drops.textContent = String(drops)

  renderBanner()
  renderLog()
  draw()
  if (flashes.length || bounces.length) requestAnimationFrame(pump)
}

function groundYFrom() {
  const c = els.scene
  return (c.clientHeight || 300) * 0.68
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
