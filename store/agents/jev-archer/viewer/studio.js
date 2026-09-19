// Jev Archer pane — draws a target range: a target slides back and forth on a wire, Jev's crosshair
// aim tracks it, arrows release along the aim line every window, a bullseye flashes a ring and a
// miss flies the arrow past. Finished range shows a clean-day or badge banner.

const $ = (id) => document.getElementById(id)
const els = {
  arrow: $('arrow'), move: $('move'), speed: $('speed'), hits: $('hits'), misses: $('misses'),
  banner: $('banner'), log: $('log'), scene: $('scene'),
}

let aim = 12, target = 12, speed = 0.6, width = 24, fuse = 6
let hits = 0, misses = 0, shots = 16, move = 'HOLD'
let finished = null
let history = []
let arrows = []      // {x, hit, t} released arrows for effect
let prevArrow = -1

function draw() {
  const c = els.scene
  const ctx = c.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth, H = c.clientHeight
  c.width = W * dpr; c.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  // range backdrop (sky)
  const grd = ctx.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, '#cfe4f0')
  grd.addColorStop(1, '#eaf3f7')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, W, H)

  const margin = 30
  const fieldLeft = margin, fieldRight = W - margin
  const wireY = H * 0.5
  const px = (fx) => fieldLeft + (fx / width) * (fieldRight - fieldLeft)

  // the sliding wire / track the target rides
  ctx.strokeStyle = '#9aa8bd'; ctx.lineWidth = 3; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(fieldLeft, wireY); ctx.lineTo(fieldRight, wireY); ctx.stroke()
  // distance markers
  ctx.fillStyle = 'rgba(60,70,90,.4)'
  for (let i = 1; i < width; i++) {
    const x = px(i)
    ctx.fillRect(x - 1, wireY - 6, 2, 12)
  }

  // the aim crosshair (Jev)
  const ax = px(aim)
  ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(ax - 12, wireY); ctx.lineTo(ax + 12, wireY)
  ctx.moveTo(ax, wireY - 12); ctx.lineTo(ax, wireY + 12)
  ctx.stroke()
  ctx.fillStyle = '#f9a8d4'
  ctx.beginPath(); ctx.arc(ax, wireY, 3, 0, Math.PI * 2); ctx.fill()

  // the sliding target
  const tx = px(target)
  const tw = 20   // target width in px
  ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(tx, wireY, tw, 0, Math.PI * 2); ctx.stroke()
  // concentric rings to the bullseye
  ctx.fillStyle = '#f43f5e'
  ctx.beginPath(); ctx.arc(tx, wireY, tw, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(tx, wireY, tw * 0.65, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#f43f5e'
  ctx.beginPath(); ctx.arc(tx, wireY, tw * 0.28, 0, Math.PI * 2); ctx.fill()
  // direction chevron
  ctx.fillStyle = 'rgba(0,0,0,.35)'
  ctx.beginPath()
  const dd = typeof dir === 'number' ? dir : 1
  ctx.moveTo(tx + dd * tw, wireY); ctx.lineTo(tx + dd * (tw + 7), wireY - 4); ctx.lineTo(tx + dd * (tw + 7), wireY + 4)
  ctx.closePath(); ctx.fill()

  // frozen arrows: a hit sticks in the bullseye, a miss trails off past where it was
  arrows.forEach((a) => {
    a.t += 0.06
    const x = a.hit ? px(a.x) : px(a.x - (1 - a.t) * (60 / width) * (a.x - aim) ) // drift for a miss
    const y = wireY + (a.hit ? -2 : (a.t) * 30) // a miss sinks or flies
    ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
    ctx.beginPath()
    if (a.hit) { ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14) }
    else { ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y) }
    ctx.stroke()
  })
  arrows = arrows.filter((a) => a.t < 1)
}

// no `dir` var; derive from state if provided
let dir = 1

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-28)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="a">${esc(h.move)}</span><span class="p">aim ${h.aim.toFixed(1)}</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function renderBanner() {
  if (!finished) { els.banner.classList.add('hidden'); return }
  els.banner.classList.remove('hidden')
  els.banner.textContent = finished.ok
    ? `✓ CLEAN DAY · ${finished.hits} bullseyes`
    : `✗ ${finished.hits} bullseyes · ${finished.misses} missed`
  els.banner.className = 'banner ' + (finished.ok ? 'ok' : 'bad')
}

function onTick(msg) {
  if (typeof msg.aim === 'number') aim = msg.aim
  if (typeof msg.target === 'number') target = msg.target
  if (typeof msg.dir === 'number') dir = msg.dir
  if (typeof msg.speed === 'number') speed = msg.speed
  if (typeof msg.targetWidth === 'number') width = msg.targetWidth
  if (typeof msg.fuse === 'number') fuse = msg.fuse
  if (typeof msg.shots === 'number') shots = msg.shots
  hits = msg.hits ?? hits
  misses = msg.misses ?? misses
  move = msg.move || move
  finished = msg.finished || null
  history = msg.history || history

  // detect a fresh released arrow (hits+misses incremented) for effects
  const total = hits + misses
  if (total > prevArrow) { arrows.push({ x: target, hit: msg.lastHit, t: 0 }); prevArrow = total }

  els.arrow.textContent = finished ? '—' : `${Math.min(total + 1, shots)}/${shots}`
  els.move.textContent = move
  els.speed.textContent = 'v' + speed.toFixed(2)
  els.hits.textContent = String(hits)
  els.misses.textContent = String(misses)

  renderBanner()
  renderLog()
  draw()
  if (arrows.length) requestAnimationFrame(draw)
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
