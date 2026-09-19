// Jev Pong pane — a neon arcade table. The server runs the rally and streams one frame per Jev
// decision (about 16 a second). Each frame carries the exact path the ball took during that
// decision, so this file can draw at 60 fps and still bounce off the walls at the right spot.
// Jev's mind is drawn in the court: five ghost paddles (one per option, lit by probability), the
// point where the ball will cross its wall, and how far the paddle can still travel before then.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap')
const ctx = scene.getContext('2d')
const MOVES = ['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST']
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"

// ---------------------------------------------------------------- state
let cur = null, curAt = 0            // latest frame and when it arrived
let lastEventId = -1, firstFrame = true
let cssW = 800, cssH = 500, dpr = 1
let geo = { s: 4, x0: 80, y0: 44, w: 800, h: 480 }
let table = null, tableKey = ''
let scan = null
const pending = []                   // events waiting for their moment inside the tick
const particles = [], rings = [], trail = [], pokes = [], flashes = [], dust = []
const fx = { squash: 0, shake: 0, bump: 0, wall: 0, goal: 0, banner: null, paceShown: 6, meterMax: 30, reachShown: 0.5 }
const probShown = Object.fromEntries(MOVES.map((m) => [m, 0.2]))

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
const X = (x) => geo.x0 + x * geo.s
const Y = (y) => geo.y0 + y * geo.s
const HEAT = [[103, 232, 249], [251, 191, 36], [251, 113, 133]]
function heat(h, a = 1) {
  const t = clamp(h, 0, 1) * 2, i = Math.min(1, Math.floor(t)), f = t - i
  const c = HEAT[i].map((v, k) => Math.round(v + (HEAT[i + 1][k] - v) * f))
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}
const heatOf = (f) => clamp((fx.paceShown - f.dials.speed * 0.6) / Math.max(1, f.outrunPace * 1.35 - f.dials.speed * 0.6), 0, 1)

// ---------------------------------------------------------------- layout
function resize() {
  const r = wrap.getBoundingClientRect()
  dpr = Math.min(2.5, window.devicePixelRatio || 1)
  cssW = Math.max(240, r.width); cssH = Math.max(200, r.height)
  scene.width = Math.round(cssW * dpr); scene.height = Math.round(cssH * dpr)
  tableKey = ''
}
function layout(c) {
  const gl = 84, gr = 34, gt = 46, gb = 84
  const s = Math.max(0.5, Math.min((cssW - gl - gr) / c.W, (cssH - gt - gb) / c.H))
  const w = c.W * s, h = c.H * s
  geo = { s, w, h, x0: gl + (cssW - gl - gr - w) / 2, y0: gt + (cssH - gt - gb - h) / 2 }
}

/** Everything that does not move: floor, grid, neon frame. Drawn once per size. */
function buildTable(c) {
  layout(c)
  table = document.createElement('canvas'); table.width = scene.width; table.height = scene.height
  const g = table.getContext('2d'); g.scale(dpr, dpr)
  g.fillStyle = '#03040a'; g.fillRect(0, 0, cssW, cssH)
  let gr = g.createRadialGradient(X(c.W * 0.3), Y(c.H * 0.5), 10, X(c.W * 0.3), Y(c.H * 0.5), geo.w * 0.8)
  gr.addColorStop(0, 'rgba(34,211,238,.10)'); gr.addColorStop(1, 'rgba(34,211,238,0)')
  g.fillStyle = gr; g.fillRect(0, 0, cssW, cssH)
  gr = g.createRadialGradient(X(c.W), Y(c.H * 0.5), 10, X(c.W), Y(c.H * 0.5), geo.w * 0.6)
  gr.addColorStop(0, 'rgba(232,121,249,.10)'); gr.addColorStop(1, 'rgba(232,121,249,0)')
  g.fillStyle = gr; g.fillRect(0, 0, cssW, cssH)

  // floor
  const fl = g.createLinearGradient(0, geo.y0, 0, geo.y0 + geo.h)
  fl.addColorStop(0, '#070b18'); fl.addColorStop(0.5, '#050814'); fl.addColorStop(1, '#090718')
  g.fillStyle = fl; g.beginPath(); g.roundRect(geo.x0, geo.y0, geo.w, geo.h, 10); g.fill()
  g.save(); g.beginPath(); g.roundRect(geo.x0, geo.y0, geo.w, geo.h, 10); g.clip()
  g.lineWidth = 1
  for (let x = 0; x <= c.W; x += 10) { g.strokeStyle = x % 50 === 0 ? 'rgba(103,232,249,.10)' : 'rgba(103,232,249,.045)'; g.beginPath(); g.moveTo(X(x), geo.y0); g.lineTo(X(x), geo.y0 + geo.h); g.stroke() }
  for (let y = 0; y <= c.H; y += 10) { g.strokeStyle = y % 50 === 0 ? 'rgba(103,232,249,.10)' : 'rgba(103,232,249,.045)'; g.beginPath(); g.moveTo(geo.x0, Y(y)); g.lineTo(geo.x0 + geo.w, Y(y)); g.stroke() }
  // centre line
  g.setLineDash([geo.s * 3, geo.s * 3]); g.strokeStyle = 'rgba(233,236,245,.16)'; g.lineWidth = Math.max(1.5, geo.s * 0.5)
  g.beginPath(); g.moveTo(X(c.W / 2), geo.y0); g.lineTo(X(c.W / 2), geo.y0 + geo.h); g.stroke(); g.setLineDash([])
  // the paddle's line
  g.strokeStyle = 'rgba(167,139,250,.16)'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(c.px), geo.y0); g.lineTo(X(c.px), geo.y0 + geo.h); g.stroke()
  g.restore()

  // neon frame: top and bottom rails cyan, far wall magenta, Jev's wall left open (rose)
  const rail = (x1, y1, x2, y2, col, blur) => { g.save(); g.shadowColor = col; g.shadowBlur = blur; g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.shadowBlur = 0; g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore() }
  rail(geo.x0, geo.y0, geo.x0 + geo.w, geo.y0, '#22d3ee', 22)
  rail(geo.x0, geo.y0 + geo.h, geo.x0 + geo.w, geo.y0 + geo.h, '#22d3ee', 22)
  rail(geo.x0 + geo.w, geo.y0, geo.x0 + geo.w, geo.y0 + geo.h, '#e879f9', 26)
  g.save(); g.setLineDash([4, 7]); g.strokeStyle = 'rgba(251,113,133,.55)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(geo.x0, geo.y0 + 4); g.lineTo(geo.x0, geo.y0 + geo.h - 4); g.stroke(); g.restore()

  // scanlines, drawn over everything each frame
  scan = document.createElement('canvas'); scan.width = 4; scan.height = 4
  const sg = scan.getContext('2d'); sg.fillStyle = 'rgba(0,0,0,.20)'; sg.fillRect(0, 0, 4, 1)
}

// ---------------------------------------------------------------- effects
function sparks(x, y, n, dir, spread, speed, color, size = 2) {
  for (let i = 0; i < n && particles.length < 900; i++) {
    const a = dir + (Math.random() - 0.5) * spread, v = speed * (0.25 + Math.random() * 0.95), life = 0.25 + Math.random() * 0.55
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.6 + Math.random() * 0.8) })
  }
}
function ring(x, y, r1, color, life = 0.45, width = 2.5) { rings.push({ x, y, r0: 2, r1, life, max: life, color, width }) }

function fire(ev, f) {
  const h = heatOf(f), x = X(ev.x), y = Y(ev.y)
  if (ev.e === 'hit') {
    const pace = ev.speed || 6
    sparks(x, y, Math.round(16 + pace * 1.6), 0, 2.2, 160 + pace * 16, heat(h), 2.2)
    sparks(x, y, 8, 0, 3, 90, 'rgba(255,255,255,1)', 1.4)
    ring(x, y, 26 + pace * 1.6, heat(h, 1))
    fx.squash = 1; fx.bump = 1; fx.shake = Math.max(fx.shake, Math.min(7, 1.5 + pace * 0.16))
    const el = $('s-rally'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump')
  } else if (ev.e === 'bounce') {
    flashes.push({ x, y, life: 0.5, color: '103,232,249', horiz: true })
    sparks(x, y, 7, ev.y <= 0 ? Math.PI / 2 : -Math.PI / 2, 2.4, 120, 'rgba(103,232,249,1)', 1.6)
  } else if (ev.e === 'wall') {
    flashes.push({ x, y, life: 0.5, color: '232,121,249', horiz: false })
    sparks(x, y, 12, Math.PI, 2.2, 170, 'rgba(232,121,249,1)', 1.8); ring(x, y, 22, 'rgba(232,121,249,1)', 0.35); fx.wall = 1
  } else if (ev.e === 'miss') {
    sparks(X(0), y, 70, 0, 3.1, 330, 'rgba(251,113,133,1)', 2.6)
    sparks(X(0), y, 24, 0, 3.1, 140, 'rgba(255,255,255,1)', 1.6)
    ring(X(0), y, 90, 'rgba(251,113,133,1)', 0.7, 4); ring(X(0), y, 46, 'rgba(255,255,255,1)', 0.4, 2)
    fx.shake = 16; fx.goal = 1
    fx.banner = { kind: 'miss', rally: ev.rally, speed: ev.speed, gap: ev.gap, at: performance.now() }
  } else if (ev.e === 'serve') {
    ring(x, y, 40, 'rgba(255,255,255,1)', 0.5); sparks(x, y, 14, Math.PI, 1.2, 150, heat(h), 1.8); fx.banner = null
  } else if (ev.e === 'shove') {
    sparks(x, y, 22, Math.atan2(ev.ty - ev.y, ev.tx - ev.x), 1.0, 240, 'rgba(167,139,250,1)', 2); ring(x, y, 30, 'rgba(167,139,250,1)', 0.4)
  } else if (ev.e === 'burst') {
    sparks(x, y, 34, 0, 6.3, 260, 'rgba(251,191,36,1)', 2.2); ring(x, y, 54, 'rgba(251,191,36,1)', 0.5, 3); fx.shake = Math.max(fx.shake, 5)
  }
}

// ---------------------------------------------------------------- drawing
function ballAt(f, a) {
  const p = f.path
  if (!p || p.length < 2) return { x: f.ball.x, y: f.ball.y, i: 0 }
  for (let i = 1; i < p.length; i++) {
    if (a <= p[i][0] || i === p.length - 1) {
      const span = p[i][0] - p[i - 1][0], t = span > 1e-9 ? clamp((a - p[i - 1][0]) / span, 0, 1) : 1
      return { x: lerp(p[i - 1][1], p[i][1], t), y: lerp(p[i - 1][2], p[i][2], t), i }
    }
  }
  return { x: f.ball.x, y: f.ball.y, i: p.length - 1 }
}

function capsule(g, x, y, w, h) { g.beginPath(); g.roundRect(x, y, w, h, Math.min(w, h) / 2) }

function chevron(g, cx, cy, size, dirY, double) {
  const one = (oy) => { g.beginPath(); g.moveTo(cx - size, cy + oy + dirY * size * 0.55); g.lineTo(cx, cy + oy - dirY * size * 0.55); g.lineTo(cx + size, cy + oy + dirY * size * 0.55); g.stroke() }
  if (dirY === 0) { g.beginPath(); g.moveTo(cx - size, cy); g.lineTo(cx + size, cy); g.stroke(); return }
  if (double) { one(-size * 0.5); one(size * 0.5) } else one(0)
}

function draw(now, dt) {
  const f = cur
  const c = f.court
  const key = `${scene.width}x${scene.height}:${c.W}x${c.H}:${c.px}`
  if (key !== tableKey) { buildTable(c); tableKey = key }
  const a = f.running ? clamp((now - curAt) / Math.max(30, f.tickMs), 0, 1) : 1
  const s = geo.s

  // fire the events whose moment inside this tick has come
  for (let i = pending.length - 1; i >= 0; i--) if (now >= pending[i].at) { if (now - pending[i].at < 500) fire(pending[i].ev, f); pending.splice(i, 1) }

  // ease the numbers
  fx.paceShown = lerp(fx.paceShown, f.speedNow, 1 - Math.exp(-dt * 10))
  fx.meterMax = lerp(fx.meterMax, Math.min(f.dials.topSpeed, Math.max(f.outrunPace * 2.1, f.dials.speed * 1.6, 12)), 1 - Math.exp(-dt * 5))
  fx.reachShown = lerp(fx.reachShown, f.decision.reach ?? 0.5, 1 - Math.exp(-dt * 14))
  for (const m of MOVES) probShown[m] = lerp(probShown[m], f.decision.probs?.[m] ?? 0, 1 - Math.exp(-dt * 18))
  for (const k of ['squash', 'bump', 'wall', 'goal']) fx[k] *= Math.exp(-dt * (k === 'squash' ? 9 : k === 'bump' ? 6 : 5))
  fx.shake *= Math.exp(-dt * 7)
  const h = heatOf(f)

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const shx = (Math.random() - 0.5) * fx.shake * 2, shy = (Math.random() - 0.5) * fx.shake * 2
  ctx.save(); ctx.translate(shx, shy)
  ctx.drawImage(table, 0, 0, cssW, cssH)

  // ---- the rally counter, huge and faint behind the play
  const big = f.phase === 'missed' ? f.lastRally : f.rally
  ctx.save()
  ctx.translate(X(c.W * 0.56), Y(c.H * 0.5)); ctx.scale(1 + fx.bump * 0.16, 1 + fx.bump * 0.16)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  const size = Math.min(geo.h * 0.74, geo.w * 0.34) * (1 + Math.min(0.18, big * 0.006))
  ctx.font = `800 ${size}px ${FONT}`
  ctx.fillStyle = heat(h, 0.07 + fx.bump * 0.16 + Math.min(0.06, big * 0.002)); ctx.fillText(String(big), 0, size * 0.04)
  ctx.lineWidth = 1.5; ctx.strokeStyle = heat(h, 0.16 + fx.bump * 0.5); ctx.strokeText(String(big), 0, size * 0.04)
  ctx.font = `700 ${Math.max(10, s * 3.2)}px ${FONT}`; ctx.fillStyle = 'rgba(233,236,245,.22)'
  ctx.fillText('R A L L Y', 0, size * 0.56)
  ctx.restore()

  const ball = ballAt(f, a)
  const padY = lerp(f.paddleFrom ?? f.paddleY, f.paddleY, a)
  const half = c.paddleH / 2
  const inPlay = f.phase !== 'missed'

  // ---- Jev's wall: how far the paddle can still travel before the ball arrives
  const ic = f.intercept
  if (ic && inPlay) {
    const top = clamp(padY - half - ic.reach, 0, c.H), bot = clamp(padY + half + ic.reach, 0, c.H)
    if (top > 0.5 || bot < c.H - 0.5) {
      const gx = X(c.px) - s * 1.2, gw = s * 2.4
      const grd = ctx.createLinearGradient(0, Y(top), 0, Y(bot))
      grd.addColorStop(0, 'rgba(167,139,250,0)'); grd.addColorStop(0.12, 'rgba(167,139,250,.20)'); grd.addColorStop(0.88, 'rgba(167,139,250,.20)'); grd.addColorStop(1, 'rgba(167,139,250,0)')
      ctx.fillStyle = grd; ctx.fillRect(gx, Y(top), gw, Y(bot) - Y(top))
      ctx.strokeStyle = 'rgba(196,181,253,.8)'; ctx.lineWidth = 1.5
      for (const yy of [top, bot]) if (yy > 0.5 && yy < c.H - 0.5) { ctx.beginPath(); ctx.moveTo(gx - 5, Y(yy)); ctx.lineTo(gx + gw + 12, Y(yy)); ctx.stroke() }
      ctx.font = `600 10px ${FONT}`; ctx.fillStyle = 'rgba(196,181,253,.75)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      if (top > 6) ctx.fillText('paddle reach', gx + gw + 16, Y(top)); else if (bot < c.H - 6) ctx.fillText('paddle reach', gx + gw + 16, Y(bot))
    }
  }

  // ---- the predicted path and the intercept ring
  if (ic && inPlay) {
    const ok = fx.reachShown
    const col = (al) => ok > 0.6 ? `rgba(52,211,153,${al})` : ok > 0.35 ? `rgba(251,191,36,${al})` : `rgba(251,113,133,${al})`
    ctx.save(); ctx.beginPath(); ctx.rect(geo.x0, geo.y0, geo.w, geo.h); ctx.clip()
    ctx.setLineDash([s * 1.6, s * 2.2]); ctx.lineDashOffset = -now * 0.04; ctx.lineWidth = 1.5; ctx.strokeStyle = col(0.5)
    ctx.beginPath(); ctx.moveTo(X(ball.x), Y(ball.y))
    for (let i = ball.i; i < f.path.length; i++) ctx.lineTo(X(f.path[i][1]), Y(f.path[i][2]))
    for (let i = 1; i < ic.pts.length; i++) ctx.lineTo(X(ic.pts[i][0]), Y(ic.pts[i][1]))
    ctx.stroke(); ctx.setLineDash([]); ctx.restore()
    const ix = X(c.px + c.r), iy = Y(ic.y), pulse = 0.5 + 0.5 * Math.sin(now * 0.012)
    ctx.save(); ctx.shadowColor = col(1); ctx.shadowBlur = 16
    ctx.strokeStyle = col(0.95); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ix, iy, s * (2.6 + pulse * 1.2), 0, 7); ctx.stroke()
    ctx.fillStyle = col(1); ctx.beginPath(); ctx.arc(ix, iy, s * 0.9, 0, 7); ctx.fill()
    ctx.restore()
    ctx.strokeStyle = col(0.8); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ix + s * 5, iy); ctx.lineTo(ix + s * 9, iy); ctx.stroke()
    ctx.font = `600 10.5px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = col(0.95)
    const ly = clamp(iy, geo.y0 + 9, geo.y0 + geo.h - 9)
    ctx.fillText(`crosses here in ${Math.max(0, ic.ticks - a).toFixed(1)} decisions`, ix + s * 10, ly)
  }

  // ---- far wall flash, and Jev's wall when a ball gets through
  if (fx.wall > 0.02) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const g2 = ctx.createLinearGradient(X(c.W) - 70, 0, X(c.W), 0); g2.addColorStop(0, 'rgba(232,121,249,0)'); g2.addColorStop(1, `rgba(232,121,249,${0.4 * fx.wall})`); ctx.fillStyle = g2; ctx.fillRect(X(c.W) - 70, geo.y0, 70, geo.h); ctx.restore() }
  if (fx.goal > 0.02) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const g2 = ctx.createLinearGradient(X(0), 0, X(0) + 160, 0); g2.addColorStop(0, `rgba(251,113,133,${0.55 * fx.goal})`); g2.addColorStop(1, 'rgba(251,113,133,0)'); ctx.fillStyle = g2; ctx.fillRect(X(0), geo.y0, 160, geo.h); ctx.restore() }

  // ---- the ball: trail first, then the hot core
  const last = trail[trail.length - 1]
  if (last && Math.hypot(last.x - ball.x, last.y - ball.y) > Math.max(30, f.speedNow * 1.6)) trail.length = 0
  trail.push({ x: ball.x, y: ball.y, t: now })
  while (trail.length && now - trail[0].t > 420) trail.shift()
  ctx.save(); ctx.beginPath(); ctx.rect(geo.x0 - 30, geo.y0, geo.w + 30, geo.h); ctx.clip()
  ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'butt'
  for (let i = 1; i < trail.length; i++) {
    const k = i / trail.length
    ctx.strokeStyle = heat(h, 0.02 + k * k * 0.5); ctx.lineWidth = Math.max(1, c.r * s * 2 * k)
    ctx.beginPath(); ctx.moveTo(X(trail[i - 1].x), Y(trail[i - 1].y)); ctx.lineTo(X(trail[i].x), Y(trail[i].y)); ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
  const fade = inPlay ? 1 : clamp((ball.x + 30) / 40, 0, 1)
  if (fade > 0.01) {
    const bx = X(ball.x), by = Y(ball.y), br = c.r * s
    const held = f.phase === 'serve'
    ctx.save(); ctx.globalAlpha = fade
    const glow = ctx.createRadialGradient(bx, by, 0, bx, by, br * 3.6)
    glow.addColorStop(0, heat(h, 0.42)); glow.addColorStop(1, heat(h, 0))
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(bx, by, br * 3.6, 0, 7); ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    // stretch along the direction of travel: a fast ball is a streak
    const ang = Math.atan2(f.ball.vy, f.ball.vx), stretch = held ? 1 : 1 + Math.min(1.1, f.speedNow * 0.03)
    ctx.translate(bx, by); ctx.rotate(ang); ctx.scale(stretch, 1 / Math.sqrt(stretch))
    ctx.shadowColor = heat(h, 1); ctx.shadowBlur = 18
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, br, 0, 7); ctx.fill()
    ctx.restore()
    if (held) {
      const k = clamp(f.hold / 15, 0, 1) - a / 15
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bx, by, br * (1.8 + k * 5), 0, 7); ctx.stroke()
      ctx.font = `700 11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillText('SERVE', bx, by - br * 7.4)
    }
  }
  ctx.restore()

  // ---- Jev's five options as ghost paddles, then the real paddle
  const pw = s * 4.6, px = X(c.px) - pw
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  for (const m of MOVES) {
    const p = probShown[m], gy = f.ghosts?.[m]
    if (gy == null || p < 0.015 || !inPlay) continue
    const chosen = m === f.decision.move
    ctx.fillStyle = `rgba(167,139,250,${0.06 + p * 0.5})`
    capsule(ctx, px - s * 1.4, Y(gy - half) - s * 0.6, pw + s * 3.6, c.paddleH * s + s * 1.2); ctx.fill()
    if (chosen) { ctx.strokeStyle = `rgba(221,214,254,${0.35 + p * 0.6})`; ctx.lineWidth = 1.5; ctx.stroke() }
  }
  ctx.restore()
  const sq = fx.squash, cx = px + pw / 2 - sq * s * 1.1, cy = Y(padY)
  ctx.save(); ctx.translate(cx, cy); ctx.scale(1 - sq * 0.42, 1 + sq * 0.13)
  ctx.shadowColor = sq > 0.2 ? '#fff' : '#22d3ee'; ctx.shadowBlur = 16 + sq * 26
  const pg = ctx.createLinearGradient(-pw / 2, 0, pw / 2, 0); pg.addColorStop(0, '#0e7490'); pg.addColorStop(0.55, '#67e8f9'); pg.addColorStop(1, '#ecfeff')
  ctx.fillStyle = pg; capsule(ctx, -pw / 2, -half * s, pw, c.paddleH * s); ctx.fill()
  ctx.restore()

  // ---- a rail lights up where the ball struck it
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  for (let i = flashes.length - 1; i >= 0; i--) {
    const q = flashes[i]; q.life -= dt
    if (q.life <= 0) { flashes.splice(i, 1); continue }
    const k = q.life / 0.5, len = 90 * (1.2 - k * 0.4)
    const g2 = q.horiz ? ctx.createLinearGradient(q.x - len, 0, q.x + len, 0) : ctx.createLinearGradient(0, q.y - len, 0, q.y + len)
    g2.addColorStop(0, `rgba(${q.color},0)`); g2.addColorStop(0.5, `rgba(255,255,255,${k})`); g2.addColorStop(1, `rgba(${q.color},0)`)
    ctx.strokeStyle = g2; ctx.lineWidth = 5; ctx.beginPath()
    if (q.horiz) { ctx.moveTo(q.x - len, q.y); ctx.lineTo(q.x + len, q.y) } else { ctx.moveTo(q.x, q.y - len); ctx.lineTo(q.x, q.y + len) }
    ctx.stroke()
  }
  // ---- slow dust in the light of the table
  while (dust.length < 46) dust.push({ x: Math.random(), y: Math.random(), v: 0.004 + Math.random() * 0.012, r: 0.6 + Math.random() * 1.2, ph: Math.random() * 7 })
  for (const d of dust) {
    d.x += d.v * dt; if (d.x > 1) d.x = 0
    ctx.globalAlpha = 0.10 + 0.10 * Math.sin(now * 0.0012 + d.ph); ctx.fillStyle = '#a5f3fc'
    ctx.beginPath(); ctx.arc(geo.x0 + d.x * geo.w, geo.y0 + d.y * geo.h + Math.sin(now * 0.0006 + d.ph) * 6, d.r, 0, 7); ctx.fill()
  }
  ctx.restore()

  // ---- particles and rings
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i]; q.life -= dt
    if (q.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue }
    q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 1 - 2.2 * dt; q.vy *= 1 - 2.2 * dt
    if (q.y < geo.y0) { q.y = geo.y0; q.vy = Math.abs(q.vy) } else if (q.y > geo.y0 + geo.h) { q.y = geo.y0 + geo.h; q.vy = -Math.abs(q.vy) }
    ctx.globalAlpha = clamp(q.life / q.max, 0, 1); ctx.strokeStyle = q.color; ctx.lineWidth = q.size
    ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * 0.035, q.y - q.vy * 0.035); ctx.stroke()
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.life -= dt
    if (r.life <= 0) { rings.splice(i, 1); continue }
    const k = 1 - r.life / r.max
    ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = r.width * (1 - k * 0.6)
    ctx.beginPath(); ctx.arc(r.x, r.y, lerp(r.r0, r.r1, 1 - (1 - k) * (1 - k)), 0, 7); ctx.stroke()
  }
  for (let i = pokes.length - 1; i >= 0; i--) {
    const p = pokes[i]; p.life -= dt
    if (p.life <= 0) { pokes.splice(i, 1); continue }
    ctx.globalAlpha = p.life / 0.5; ctx.strokeStyle = 'rgba(196,181,253,1)'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(X(ball.x), Y(ball.y)); ctx.stroke()
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 + (0.5 - p.life) * 40, 0, 7); ctx.stroke()
  }
  ctx.restore()

  drawMind(f, padY, c)
  drawHeader(f, c, h)
  drawMeter(f, c, h)
  drawBanner(f, c, now)
  ctx.restore()

  ctx.fillStyle = ctx.createPattern(scan, 'repeat'); ctx.fillRect(0, 0, cssW, cssH)
}

/** Left gutter: the five moves as chevrons beside the paddle, each lit by its probability. */
function drawMind(f, padY, c) {
  const rowH = 21, n = MOVES.length, x = geo.x0 - 22
  const y0 = clamp(Y(padY) - (rowH * n) / 2, geo.y0 + 16, geo.y0 + geo.h - rowH * n - 2)
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  MOVES.forEach((m, i) => {
    const p = probShown[m], chosen = m === f.decision.move && f.phase !== 'missed', cy = y0 + rowH * i + rowH / 2
    const col = chosen ? `rgba(52,211,153,${0.6 + p * 0.4})` : `rgba(167,139,250,${0.25 + p * 0.75})`
    ctx.strokeStyle = col; ctx.lineWidth = chosen ? 2.6 : 2
    if (chosen) { ctx.shadowColor = '#34d399'; ctx.shadowBlur = 12 } else ctx.shadowBlur = 0
    chevron(ctx, x, cy, 6, i < 2 ? 1 : i > 2 ? -1 : 0, i === 0 || i === 4)
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.roundRect(x - 54, cy - 3, 40, 6, 3); ctx.fill()
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x - 14 - 40 * p, cy - 3, Math.max(1, 40 * p), 6, 3); ctx.fill()
  })
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,.9)'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
  ctx.fillText("JEV'S MIND", x + 8, y0 - 4)
  ctx.restore()
}

function drawHeader(f, c, h) {
  const y = geo.y0 - 22
  ctx.save(); ctx.textBaseline = 'middle'
  ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'left'
  const pretty = { MOVE_UP_FAST: '▲▲ UP FAST', MOVE_UP: '▲ UP', HOLD: '■ HOLD', MOVE_DOWN: '▼ DOWN', MOVE_DOWN_FAST: '▼▼ DOWN FAST' }
  ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText('JEV PLAYS', geo.x0, y)
  ctx.fillStyle = '#34d399'; ctx.fillText(f.phase === 'missed' ? '—' : `${pretty[f.decision.move] ?? f.decision.move}  ${Math.round((f.decision.conf ?? 0) * 100)}%`, geo.x0 + 78, y)
  ctx.textAlign = 'right'
  const r = fx.reachShown
  ctx.fillStyle = r > 0.6 ? '#34d399' : r > 0.35 ? '#fbbf24' : '#fb7185'
  ctx.fillText(f.phase === 'missed' ? 'BALL LOST' : `${Math.round(r * 100)}%`, geo.x0 + geo.w, y)
  if (f.phase !== 'missed') { const w = ctx.measureText(`${Math.round(r * 100)}%`).width; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText('JEV: WILL I REACH IT?', geo.x0 + geo.w - w - 10, y) }
  ctx.restore()
}

/** Bottom strip: the ball's pace as an LED bar, with the zone where a far ball is out of reach. */
function drawMeter(f, c, h) {
  const x = geo.x0, w = geo.w, y = geo.y0 + geo.h + 30, hh = 14, max = Math.max(4, fx.meterMax)
  const px = (v) => x + clamp(v / max, 0, 1) * w
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,.045)'; ctx.beginPath(); ctx.roundRect(x, y, w, hh, 4); ctx.fill()
  // out-of-reach zone
  if (f.outrunPace < max) {
    ctx.save(); ctx.beginPath(); ctx.roundRect(px(f.outrunPace), y, x + w - px(f.outrunPace), hh, 4); ctx.clip()
    ctx.fillStyle = 'rgba(251,113,133,.13)'; ctx.fillRect(x, y, w, hh)
    ctx.strokeStyle = 'rgba(251,113,133,.35)'; ctx.lineWidth = 1
    for (let k = px(f.outrunPace) - hh; k < x + w; k += 8) { ctx.beginPath(); ctx.moveTo(k, y + hh); ctx.lineTo(k + hh, y); ctx.stroke() }
    ctx.restore()
  }
  // LED fill
  const seg = 6, n = Math.floor(w / seg), lit = Math.round(clamp(fx.paceShown / max, 0, 1) * n)
  for (let i = 0; i < lit; i++) {
    const v = (i / n) * max, hv = clamp((v - f.dials.speed * 0.6) / Math.max(1, f.outrunPace * 1.35 - f.dials.speed * 0.6), 0, 1)
    ctx.fillStyle = heat(hv, i === lit - 1 ? 1 : 0.78); ctx.fillRect(x + i * seg + 1, y + 2, seg - 2, hh - 4)
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.shadowColor = heat(h, 1); ctx.shadowBlur = 14; ctx.fillStyle = heat(h, 0.9); ctx.fillRect(x + Math.max(0, lit - 1) * seg + 1, y + 1, seg - 2, hh - 2); ctx.restore()
  // marks
  ctx.font = `600 10px ${FONT}`; ctx.textBaseline = 'top'
  const marks = [{ v: f.dials.speed, label: `serve ${f.dials.speed.toFixed(1)}`, col: 'rgba(233,236,245,.75)' }]
  if (f.outrunPace < max) marks.push({ v: f.outrunPace, label: `past ${f.outrunPace.toFixed(1)} a far ball is out of reach`, col: 'rgba(251,113,133,.95)' })
  const boxes = []
  for (const m of marks) {
    const mx = px(m.v), tw = ctx.measureText(m.label).width, right = mx + tw + 8 > x + w
    const x1 = right ? mx - 4 - tw : mx + 4
    let row = 0
    if (boxes.some((b) => b.row === 0 && x1 < b.x2 + 10 && x1 + tw > b.x1 - 10)) row = 1
    boxes.push({ x1, x2: x1 + tw, row })
    ctx.strokeStyle = m.col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(mx, y - 4); ctx.lineTo(mx, y + hh + 4 + row * 13); ctx.stroke()
    ctx.fillStyle = m.col; ctx.textAlign = 'left'; ctx.fillText(m.label, x1, y + hh + 7 + row * 13)
  }
  ctx.textBaseline = 'bottom'; ctx.textAlign = 'left'; ctx.font = `700 11px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'
  ctx.fillText('BALL PACE', x, y - 6)
  ctx.fillStyle = heat(h, 1); ctx.font = `800 15px ${FONT}`; ctx.fillText(fx.paceShown.toFixed(1), x + 76, y - 4)
  ctx.font = `600 10.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'right'
  ctx.fillText(`units per decision · +${f.dials.accel} every return · paddle ${(2 * f.dials.maxSpeed).toFixed(1)} at most`, x + w, y - 6)
  ctx.restore()
}

function drawBanner(f, c, now) {
  const b = fx.banner
  if (!b || f.phase !== 'missed') return
  const k = clamp((now - b.at) / 260, 0, 1), e = 1 - (1 - k) * (1 - k)
  const cx = X(c.W * 0.56), cy = geo.y0 + geo.h * 0.2
  ctx.save(); ctx.globalAlpha = e; ctx.translate(cx, cy); ctx.scale(1.3 - 0.3 * e, 1.3 - 0.3 * e)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = `800 ${Math.max(20, geo.s * 9)}px ${FONT}`; ctx.shadowColor = '#fb7185'; ctx.shadowBlur = 24; ctx.fillStyle = '#fecdd3'
  ctx.fillText('MISSED', 0, 0); ctx.shadowBlur = 0
  ctx.font = `600 12.5px ${FONT}`; ctx.fillStyle = 'rgba(254,205,211,.92)'
  const gap = b.gap > 0 ? ` · ${b.gap.toFixed(1)} units short` : ''
  ctx.fillText(`rally of ${b.rally} ended at pace ${Number(b.speed).toFixed(1)}${gap} · new serve in ${(Math.max(0, f.hold) * f.tickMs / 1000).toFixed(1)}s`, 0, Math.max(20, geo.s * 9) * 0.85)
  ctx.restore()
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  if (cur) draw(now, dt)
}

// ---------------------------------------------------------------- wiring
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const esc = (t) => t.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
function paintStateText(text) {
  $('stateText').innerHTML = text.split('\n').slice(1).map((l) => {
    l = esc(l)
    if (l.startsWith('ball:')) return `<span class="hl">${l}</span>`
    if (l.startsWith('paddle:')) return `<span class="ok">${l}</span>`
    if (l.startsWith('serve:')) return `<span class="bad">${l}</span>`
    return l
  }).join('\n')
}
function paintHistory(f) {
  const all = [...(f.rallies || []).map((r) => ({ ...r })), { n: f.phase === 'missed' ? null : f.rally, live: true }].filter((r) => r.n != null)
  const max = Math.max(4, ...all.map((r) => r.n))
  $('hist').innerHTML = all.length ? all.map((r) => `<div class="bar${r.live ? ' live' : ''}" style="height:${Math.max(4, (r.n / max) * 100)}%" title="${r.live ? `this rally: ${r.n} returns so far` : `${r.n} returns, lost at pace ${r.speed.toFixed(1)}`}"></div>`).join('') : '<span class="empty">no rally finished yet</span>'
  const done = f.rallies || []
  $('histNote').textContent = done.length ? `mean ${(done.reduce((s, r) => s + r.n, 0) / done.length).toFixed(1)} · lost at pace ${(done.reduce((s, r) => s + r.speed, 0) / done.length).toFixed(1)}` : 'returns per rally'
}

let paused = false
function onFrame(f) {
  const now = performance.now()
  if (firstFrame || (cur && f.episode !== cur.episode && f.t < cur.t)) { lastEventId = Math.max(-1, ...(f.events || []).map((e) => e.id)); firstFrame = false; fx.paceShown = f.speedNow }
  for (const ev of f.events || []) if (ev.id > lastEventId) { pending.push({ ev, at: now + (ev.f ?? 0) * (f.running ? f.tickMs : 0) }); lastEventId = ev.id }
  cur = f; curAt = now
  paused = !f.running
  $('title').textContent = f.title
  $('s-rally').textContent = f.rally; $('s-best').textContent = f.bestRally; $('s-misses').textContent = f.misses; $('s-pace').textContent = f.speedNow.toFixed(1)
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const ph = $('phase'); ph.textContent = f.phase === 'missed' ? 'BALL LOST' : f.phase === 'serve' ? 'SERVE' : 'RALLY'; ph.className = 'right pill ' + (f.phase === 'missed' ? 'bad' : f.phase === 'serve' ? 'warn' : 'ok')
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem); $('cfgError').textContent = problem ? `${problem} — still playing on the last good court.` : ''
  for (const k of ['speed', 'maxSpeed', 'paddleH']) {
    const el = $('d-' + k)
    if (document.activeElement !== el) { el.value = f.dials[k]; $('v-' + k).textContent = k === 'paddleH' ? Math.round(f.dials[k]) : f.dials[k].toFixed(1) }
    $('v-' + k).style.color = k in (f.overrides || {}) ? '' : 'var(--dim)'
  }
  paintStateText(f.stateText || '')
  paintHistory(f)
}

const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('burst').onclick = () => post({ cmd: 'burst', n: 4 })
$('serve').onclick = () => post({ cmd: 'serve' })
for (const k of ['speed', 'maxSpeed', 'paddleH']) $('d-' + k).oninput = (e) => { const v = Number(e.target.value); $('v-' + k).textContent = k === 'paddleH' ? Math.round(v) : v.toFixed(1); post({ cmd: 'set', key: k, value: v }) }
scene.addEventListener('click', (e) => {
  if (!cur) return
  const r = scene.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
  const x = (mx - geo.x0) / geo.s, y = (my - geo.y0) / geo.s
  if (x < 0 || y < 0 || x > cur.court.W || y > cur.court.H) return
  pokes.push({ x: mx, y: my, life: 0.5 })
  post({ cmd: 'shove', x, y })
})

async function pollJev() {
  try { const s = await (await fetch('/jev', { cache: 'no-store' })).json(); $('s-rate').textContent = s.callsPerSec.toFixed(1); $('s-cost').textContent = fmtMoney(s.costUsd); $('s-dec').textContent = s.calls.toLocaleString() } catch { /* restarting */ }
  setTimeout(pollJev, 400)
}

new ResizeObserver(resize).observe(wrap)
resize()
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
pollJev()
requestAnimationFrame(loop)
