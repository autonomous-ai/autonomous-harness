// Jev Pendulum pane — a physical rig on a lit workbench. The server runs the physics and streams
// one frame per Jev decision (about 12 a second); this file draws at 60 fps and eases between
// frames. The camera follows the cart along a long rail, so the cart can really move.
// Jev's mind is drawn on the rig: five force arrows on the cart (one per option, sized by
// probability), the wedge where gravity beats the hardest shove, and how much of the lean that can
// still be saved is used up.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap')
const ctx = scene.getContext('2d')
const ORDER = ['LEFT_HARD', 'LEFT', 'CENTER', 'RIGHT', 'RIGHT_HARD']
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"
const RAD = Math.PI / 180

// ---------------------------------------------------------------- state
let cur = null, curAt = 0
let lastEventId = -1, firstFrame = true
let cssW = 800, cssH = 500, dpr = 1
let camX = 0, ppm = 240, lenShown = 1
const particles = [], rings = [], trail = [], wind = []
const fx = { shake: 0, gust: 0, gustDir: 1, flick: 0, banner: null, budgetShown: 0, steadyShown: 0.5, newBest: 0, stand: 0 }
const probShown = Object.fromEntries(ORDER.map((m) => [m, 0.2]))

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
const HEAT = [[94, 234, 212], [251, 191, 36], [251, 113, 133]]
function heat(h, a = 1) {
  const t = clamp(h, 0, 1) * 2, i = Math.min(1, Math.floor(t)), f = t - i
  const c = HEAT[i].map((v, k) => Math.round(v + (HEAT[i + 1][k] - v) * f))
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

function resize() {
  const r = wrap.getBoundingClientRect()
  dpr = Math.min(2.5, window.devicePixelRatio || 1)
  cssW = Math.max(240, r.width); cssH = Math.max(220, r.height)
  scene.width = Math.round(cssW * dpr); scene.height = Math.round(cssH * dpr)
}

// ---------------------------------------------------------------- effects
function sparks(x, y, n, dir, spread, speed, color, size = 2, grav = 0) {
  for (let i = 0; i < n && particles.length < 700; i++) {
    const a = dir + (Math.random() - 0.5) * spread, v = speed * (0.25 + Math.random() * 0.95), life = 0.3 + Math.random() * 0.6
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.6 + Math.random() * 0.8), grav })
  }
}
function ring(x, y, r1, color, life = 0.5, width = 2.5) { rings.push({ x, y, r0: 3, r1, life, max: life, color, width }) }

// ---------------------------------------------------------------- drawing
function geometry(f, a) {
  const railY = cssH - 148
  const wheelR = 12, bodyH = 30, bodyW = 96
  const hingeY = railY - wheelR * 2 - bodyH + 2
  const x = lerp(f.from.x, f.x, a), ang = lerp(f.from.angle, f.angle, a) * RAD
  const sx = (xw) => cssW * 0.5 + (xw - camX) * ppm
  const hx = sx(x), rodPx = lenShown * ppm
  return { railY, wheelR, bodyH, bodyW, hingeY, x, ang, sx, hx, rodPx, tipX: hx + Math.sin(ang) * rodPx, tipY: hingeY - Math.cos(ang) * rodPx }
}

function drawBackdrop(g, now) {
  const sky = ctx.createLinearGradient(0, 0, 0, cssH)
  sky.addColorStop(0, '#080a16'); sky.addColorStop(0.62, '#0b0d1c'); sky.addColorStop(1, '#05060c')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, cssW, cssH)
  // far wall: tall panels, slow parallax
  const pan = 2.2 * ppm, off = ((-camX * ppm * 0.35) % pan + pan) % pan
  for (let x = off - pan; x < cssW + pan; x += pan) {
    const grd = ctx.createLinearGradient(x, 0, x + pan, 0)
    grd.addColorStop(0, 'rgba(167,139,250,.05)'); grd.addColorStop(0.5, 'rgba(167,139,250,.012)'); grd.addColorStop(1, 'rgba(167,139,250,.05)')
    ctx.fillStyle = grd; ctx.fillRect(x + 3, 26, pan - 6, g.railY - 60)
    ctx.strokeStyle = 'rgba(167,139,250,.10)'; ctx.lineWidth = 1; ctx.strokeRect(x + 3.5, 26.5, pan - 7, g.railY - 61)
  }
  // ceiling lamps, a little nearer
  const lp = 3 * ppm, lo = ((-camX * ppm * 0.6) % lp + lp) % lp
  for (let x = lo - lp; x < cssW + lp; x += lp) {
    ctx.fillStyle = 'rgba(233,236,245,.5)'; ctx.fillRect(x - 22, 0, 44, 5)
    const cone = ctx.createRadialGradient(x, 0, 4, x, 0, cssH * 0.75)
    cone.addColorStop(0, 'rgba(196,181,253,.13)'); cone.addColorStop(1, 'rgba(196,181,253,0)')
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(x - 24, 0); ctx.lineTo(x + 24, 0); ctx.lineTo(x + cssH * 0.42, g.railY); ctx.lineTo(x - cssH * 0.42, g.railY); ctx.closePath(); ctx.fill()
  }
  // the bench under the rail
  const fl = ctx.createLinearGradient(0, g.railY, 0, cssH)
  fl.addColorStop(0, '#14172a'); fl.addColorStop(1, '#07080f')
  ctx.fillStyle = fl; ctx.fillRect(0, g.railY + 6, cssW, cssH - g.railY)
  // the rail: a steel bar with a ruler on it
  const bar = ctx.createLinearGradient(0, g.railY - 3, 0, g.railY + 8)
  bar.addColorStop(0, '#aab2cc'); bar.addColorStop(0.35, '#5b6382'); bar.addColorStop(1, '#22263a')
  ctx.fillStyle = bar; ctx.fillRect(0, g.railY - 3, cssW, 11)
  const first = Math.floor((camX - cssW / ppm) * 4) / 4
  ctx.font = `600 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  for (let m = first; m < camX + cssW / ppm; m += 0.25) {
    const x = g.sx(m), whole = Math.abs(m - Math.round(m)) < 1e-6
    ctx.fillStyle = whole ? 'rgba(233,236,245,.55)' : 'rgba(233,236,245,.2)'
    ctx.fillRect(x - 0.5, g.railY + 8, 1, whole ? 12 : 6)
    if (whole) { ctx.fillStyle = 'rgba(139,146,170,.8)'; ctx.fillText(`${Math.round(m)} m`, x, g.railY + 23) }
    if (whole) { ctx.fillStyle = '#0c0e18'; ctx.beginPath(); ctx.arc(x, g.railY + 2.5, 2.2, 0, 7); ctx.fill() }
  }
}

function arrow(x, y, len, dir, thick, color, glow) {
  const head = Math.max(10, thick * 1.5), x2 = x + dir * len
  ctx.save(); if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 16 }
  ctx.fillStyle = color; ctx.beginPath()
  ctx.moveTo(x, y - thick / 2); ctx.lineTo(x2 - dir * head, y - thick / 2); ctx.lineTo(x2 - dir * head, y - thick); ctx.lineTo(x2, y)
  ctx.lineTo(x2 - dir * head, y + thick); ctx.lineTo(x2 - dir * head, y + thick / 2); ctx.lineTo(x, y + thick / 2); ctx.closePath(); ctx.fill(); ctx.restore()
}

function draw(now, dt) {
  const f = cur
  const a = f.running ? clamp((now - curAt) / Math.max(30, f.tickMs), 0, 1) : 1
  // ease the numbers
  lenShown = lerp(lenShown, f.dials.length, 1 - Math.exp(-dt * 8))
  ppm = lerp(ppm, clamp((cssH - 260) / Math.max(1.0, f.dials.length + 0.12), 60, 420), 1 - Math.exp(-dt * 6))
  fx.budgetShown = lerp(fx.budgetShown, clamp(f.budget, -1.6, 1.6), 1 - Math.exp(-dt * 14))
  fx.steadyShown = lerp(fx.steadyShown, f.decision.steady ?? 0.5, 1 - Math.exp(-dt * 12))
  for (const m of ORDER) probShown[m] = lerp(probShown[m], f.decision.probs?.[m] ?? 0, 1 - Math.exp(-dt * 18))
  for (const k of ['gust', 'flick', 'newBest', 'stand']) fx[k] *= Math.exp(-dt * 2.4)
  fx.shake *= Math.exp(-dt * 7)

  let g = geometry(f, a)
  camX = lerp(camX, g.x, 1 - Math.exp(-dt * 5)); if (Math.abs(camX - g.x) > 6) camX = g.x
  g = geometry(f, a)
  const fallen = f.phase === 'fallen'
  const danger = clamp(Math.abs(fx.budgetShown), 0, 1), side = Math.sign(fx.budgetShown) || 1
  const tiltDeg = g.ang / RAD

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.save(); ctx.translate((Math.random() - 0.5) * fx.shake * 2, (Math.random() - 0.5) * fx.shake * 2)
  drawBackdrop(g, now)

  // ---- spotlight on the rig
  const spot = ctx.createRadialGradient(g.hx, g.hingeY - g.rodPx * 0.5, 10, g.hx, g.hingeY - g.rodPx * 0.4, Math.max(260, g.rodPx * 1.5))
  spot.addColorStop(0, fallen ? 'rgba(251,113,133,.10)' : heat(danger, 0.10)); spot.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = spot; ctx.fillRect(0, 0, cssW, cssH)

  // ---- danger wedges: from "no return" out to "falls", lit as the lean budget runs out
  const R = g.rodPx + 26
  for (const sgn of [-1, 1]) {
    const lit = sgn === side && !fallen ? danger : 0, a0 = -Math.PI / 2 + sgn * f.noReturnDeg * RAD, a1 = -Math.PI / 2 + sgn * f.dials.fallDeg * RAD
    const grd = ctx.createRadialGradient(g.hx, g.hingeY, 20, g.hx, g.hingeY, R)
    grd.addColorStop(0, `rgba(251,113,133,${0.01 + lit * 0.10})`); grd.addColorStop(1, `rgba(251,113,133,${0.035 + lit * 0.42})`)
    ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(g.hx, g.hingeY); ctx.arc(g.hx, g.hingeY, R, Math.min(a0, a1), Math.max(a0, a1)); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = `rgba(251,113,133,${0.3 + lit * 0.65})`; ctx.lineWidth = 1.5; ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(g.hx, g.hingeY); ctx.lineTo(g.hx + Math.cos(a0) * R, g.hingeY + Math.sin(a0) * R); ctx.stroke()
    ctx.setLineDash([5, 6]); ctx.strokeStyle = 'rgba(251,113,133,.35)'
    ctx.beginPath(); ctx.moveTo(g.hx, g.hingeY); ctx.lineTo(g.hx + Math.cos(a1) * R, g.hingeY + Math.sin(a1) * R); ctx.stroke(); ctx.setLineDash([])
    ctx.font = `600 10px ${FONT}`; ctx.fillStyle = `rgba(253,164,175,${0.7 + lit * 0.3})`; ctx.textBaseline = 'middle'; ctx.textAlign = sgn > 0 ? 'left' : 'right'
    const lx = (v) => clamp(v, sgn > 0 ? 8 : 96, sgn > 0 ? cssW - 96 : cssW - 8)
    ctx.fillText(`no return ${f.noReturnDeg.toFixed(1)}°`, lx(g.hx + Math.cos(a0) * (R + 8)), Math.max(118, g.hingeY + Math.sin(a0) * (R + 8)))
    ctx.fillStyle = 'rgba(253,164,175,.5)'; ctx.fillText(`falls ${f.dials.fallDeg}°`, lx(g.hx + Math.cos(a1) * (R + 8)), g.hingeY + Math.sin(a1) * (R + 8))
  }
  // plumb line
  ctx.strokeStyle = 'rgba(233,236,245,.16)'; ctx.setLineDash([3, 6]); ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(g.hx, g.hingeY); ctx.lineTo(g.hx, g.hingeY - R - 6); ctx.stroke(); ctx.setLineDash([])

  // ---- wind streaks while a gust passes
  if (fx.gust > 0.05) {
    while (wind.length < 26) wind.push({ x: Math.random() * cssW, y: 40 + Math.random() * (g.railY - 90), l: 40 + Math.random() * 120, v: 900 + Math.random() * 700 })
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
    for (const s of wind) {
      s.x += fx.gustDir * s.v * dt; if (s.x > cssW + 200) s.x = -200; if (s.x < -200) s.x = cssW + 200
      const grd = ctx.createLinearGradient(s.x, 0, s.x - fx.gustDir * s.l, 0)
      grd.addColorStop(0, `rgba(196,181,253,${0.5 * fx.gust})`); grd.addColorStop(1, 'rgba(196,181,253,0)')
      ctx.strokeStyle = grd; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - fx.gustDir * s.l, s.y); ctx.stroke()
    }
    ctx.restore()
  }

  // ---- tip trail (kept in world space, so it shows the cart's dash too)
  const tipW = { x: g.x + Math.sin(g.ang) * lenShown, y: Math.cos(g.ang) * lenShown, t: now }
  trail.push(tipW); while (trail.length && now - trail[0].t > 1100) trail.shift()
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
  for (let i = 1; i < trail.length; i++) {
    const k = i / trail.length
    ctx.strokeStyle = heat(danger, k * k * 0.7); ctx.lineWidth = 1 + k * 7
    ctx.beginPath(); ctx.moveTo(g.sx(trail[i - 1].x), g.hingeY - trail[i - 1].y * ppm); ctx.lineTo(g.sx(trail[i].x), g.hingeY - trail[i].y * ppm); ctx.stroke()
  }
  ctx.restore()

  // ---- angle arc
  if (!fallen) {
    const ar = Math.min(84, g.rodPx * 0.36)
    ctx.fillStyle = heat(danger, 0.22); ctx.beginPath(); ctx.moveTo(g.hx, g.hingeY)
    ctx.arc(g.hx, g.hingeY, ar, -Math.PI / 2, -Math.PI / 2 + g.ang, g.ang < 0); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = heat(danger, 0.95); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(g.hx, g.hingeY, ar, -Math.PI / 2, -Math.PI / 2 + g.ang, g.ang < 0); ctx.stroke()
    ctx.font = `700 13px ${FONT}`; ctx.fillStyle = heat(danger, 1); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.textAlign = g.ang >= 0 ? 'left' : 'right'
    ctx.fillText(`${tiltDeg >= 0 ? '+' : ''}${tiltDeg.toFixed(1)}°`, g.hx + (g.ang >= 0 ? 1 : -1) * (Math.abs(Math.sin(g.ang)) * ar + 18), g.hingeY - ar - 12)
  }

  // ---- Jev's mind: five force arrows on the cart
  const ay = g.railY - g.wheelR * 2 - g.bodyH / 2 + 2
  if (!fallen) {
    for (const m of ORDER) {
      const p = probShown[m], chosen = m === f.decision.action, u = f.pushes?.[m] ?? 0
      if (m === 'CENTER') {
        ctx.save(); if (chosen) { ctx.shadowColor = '#34d399'; ctx.shadowBlur = 16 }
        ctx.strokeStyle = chosen ? `rgba(52,211,153,${0.5 + p * 0.5})` : `rgba(167,139,250,${0.15 + p * 0.85})`; ctx.lineWidth = 2 + p * 9
        ctx.beginPath(); ctx.arc(g.hx, ay, 15, 0, 7); ctx.stroke(); ctx.restore(); continue
      }
      const dir = Math.sign(u), hard = /HARD/.test(m)
      const len = (hard ? 150 : 84) * clamp(0.6 + Math.abs(u) / 4, 0.6, 1.5), y = ay + (hard ? 13 : -13)
      const col = chosen ? `rgba(52,211,153,${0.45 + p * 0.55})` : `rgba(167,139,250,${0.10 + p * 0.85})`
      arrow(g.hx + dir * (g.bodyW / 2 + 8), y, len, dir, 3 + p * 15, col, chosen ? '#34d399' : null)
      if (p > 0.12) { ctx.font = `700 11px ${FONT}`; ctx.fillStyle = chosen ? '#a7f3d0' : 'rgba(221,214,254,.9)'; ctx.textBaseline = 'middle'; ctx.textAlign = dir > 0 ? 'left' : 'right'; ctx.fillText(`${Math.round(p * 100)}%`, g.hx + dir * (g.bodyW / 2 + 16 + len), y) }
    }
  }

  // ---- the cart
  const bx = g.hx - g.bodyW / 2, by = g.railY - g.wheelR * 2 - g.bodyH + 4
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(g.hx, g.railY + 9, g.bodyW * 0.62, 6, 0, 0, 7); ctx.fill()
  const body = ctx.createLinearGradient(0, by, 0, by + g.bodyH)
  body.addColorStop(0, '#4c4f78'); body.addColorStop(0.5, '#2b2d4a'); body.addColorStop(1, '#16172a')
  ctx.fillStyle = body; ctx.strokeStyle = 'rgba(196,181,253,.55)'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.roundRect(bx, by, g.bodyW, g.bodyH, 8); ctx.fill(); ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.beginPath(); ctx.roundRect(bx + 4, by + 3, g.bodyW - 8, 5, 3); ctx.fill()
  const pushing = Math.abs(f.push) > 0.01 && !fallen
  ctx.fillStyle = pushing ? '#34d399' : '#475569'; ctx.shadowColor = '#34d399'; ctx.shadowBlur = pushing ? 10 : 0
  ctx.beginPath(); ctx.arc(bx + g.bodyW - 12, by + g.bodyH - 9, 3, 0, 7); ctx.fill(); ctx.shadowBlur = 0
  for (const wx of [bx + 20, bx + g.bodyW - 20]) {
    const wy = g.railY - g.wheelR - 3, rot = (g.x * ppm) / g.wheelR
    ctx.fillStyle = '#0b0c16'; ctx.strokeStyle = '#9aa3c2'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(wx, wy, g.wheelR, 0, 7); ctx.fill(); ctx.stroke()
    ctx.strokeStyle = 'rgba(154,163,194,.8)'; ctx.lineWidth = 1.5
    for (let k = 0; k < 3; k++) { const ra = rot + (k * Math.PI) / 3; ctx.beginPath(); ctx.moveTo(wx - Math.cos(ra) * (g.wheelR - 2), wy - Math.sin(ra) * (g.wheelR - 2)); ctx.lineTo(wx + Math.cos(ra) * (g.wheelR - 2), wy + Math.sin(ra) * (g.wheelR - 2)); ctx.stroke() }
    ctx.fillStyle = '#c4b5fd'; ctx.beginPath(); ctx.arc(wx, wy, 2.5, 0, 7); ctx.fill()
  }
  ctx.restore()
  // wheel sparks on a hard shove
  if (pushing && Math.abs(f.push) > f.shove * 0.75 && Math.random() < 0.6) sparks(g.hx - Math.sign(f.push) * 28, g.railY - 3, 2, Math.sign(f.push) > 0 ? Math.PI : 0, 0.9, 190, 'rgba(253,230,138,1)', 1.4, 500)

  // ---- the rod
  ctx.save(); ctx.translate(g.hx, g.hingeY); ctx.rotate(g.ang)
  ctx.shadowColor = heat(danger, 0.9); ctx.shadowBlur = 16
  const rodG = ctx.createLinearGradient(-5, 0, 5, 0); rodG.addColorStop(0, '#6d6f93'); rodG.addColorStop(0.45, '#f1f3ff'); rodG.addColorStop(1, '#7b7da3')
  ctx.fillStyle = rodG; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-3.5, -g.rodPx); ctx.lineTo(3.5, -g.rodPx); ctx.lineTo(6, 0); ctx.closePath(); ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#e9ecf5'; ctx.strokeStyle = '#16172a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(g.hx, g.hingeY, 7, 0, 7); ctx.fill(); ctx.stroke()
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  const tg = ctx.createRadialGradient(g.tipX, g.tipY, 0, g.tipX, g.tipY, 34)
  tg.addColorStop(0, heat(danger, 0.75)); tg.addColorStop(1, heat(danger, 0)); ctx.fillStyle = tg; ctx.beginPath(); ctx.arc(g.tipX, g.tipY, 34, 0, 7); ctx.fill(); ctx.restore()
  ctx.fillStyle = '#fff'; ctx.shadowColor = heat(danger, 1); ctx.shadowBlur = 18; ctx.beginPath(); ctx.arc(g.tipX, g.tipY, 7, 0, 7); ctx.fill(); ctx.shadowBlur = 0

  // ---- particles and rings
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i]; q.life -= dt
    if (q.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue }
    q.vy += q.grav * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 1 - 1.8 * dt
    if (q.y > g.railY - 2 && q.vy > 0) { q.y = g.railY - 2; q.vy *= -0.35 }
    ctx.globalAlpha = clamp(q.life / q.max, 0, 1); ctx.strokeStyle = q.color; ctx.lineWidth = q.size
    ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * 0.03, q.y - q.vy * 0.03); ctx.stroke()
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.life -= dt
    if (r.life <= 0) { rings.splice(i, 1); continue }
    const k = 1 - r.life / r.max
    ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = r.width * (1 - k * 0.6)
    ctx.beginPath(); ctx.arc(r.x, r.y, lerp(r.r0, r.r1, 1 - (1 - k) * (1 - k)), 0, 7); ctx.stroke()
  }
  ctx.restore()

  drawTimer(f, a)
  drawBudget(f)
  drawScope(f, g)
  drawBanner(f, now)
  ctx.restore()
  return g
}

/** Top left: this run against the best run. */
function drawTimer(f, a) {
  const secs = (t) => (t * f.tickMs) / 1000
  const run = f.phase === 'fallen' ? secs(f.lastRun) : secs(f.thisRun + (f.running ? a : 0)), best = Math.max(secs(f.bestRun), 0.001)
  const isBest = f.phase !== 'fallen' && f.thisRun >= f.bestRun && f.falls > 0
  ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(isBest ? 'THIS RUN · NEW BEST' : 'THIS RUN', 22, 30)
  ctx.font = `800 40px ${FONT}`; ctx.fillStyle = isBest ? '#fbbf24' : f.phase === 'fallen' ? '#fb7185' : '#5eead4'
  ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 18 + fx.newBest * 20; ctx.fillText(run.toFixed(1), 22, 70); ctx.shadowBlur = 0
  const w = ctx.measureText(run.toFixed(1)).width
  ctx.font = `700 14px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText('s', 28 + w, 70)
  ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.roundRect(22, 80, 190, 6, 3); ctx.fill()
  ctx.fillStyle = isBest ? '#fbbf24' : '#5eead4'; ctx.beginPath(); ctx.roundRect(22, 80, Math.max(3, 190 * clamp(run / best, 0, 1)), 6, 3); ctx.fill()
  ctx.font = `600 10.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(`best ${secs(f.bestRun).toFixed(1)} s · ${f.falls} falls`, 22, 102)
  ctx.restore()
}

/** Top right: how much of the lean that can still be saved is used up, and Jev's own answer. */
function drawBudget(f) {
  const w = Math.min(300, cssW * 0.34), x = cssW - w - 22, y = 50, h = 12
  ctx.save()
  ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('LEAN BUDGET', x, 26)
  const s = fx.steadyShown
  ctx.textAlign = 'right'; ctx.fillStyle = s > 0.6 ? '#34d399' : s > 0.35 ? '#fbbf24' : '#fb7185'
  const label = f.phase === 'fallen' ? 'ROD DOWN' : `${Math.round(s * 100)}%`
  ctx.font = `700 12px ${FONT}`; ctx.fillText(label, x + w, 26)
  if (f.phase !== 'fallen') { const lw = ctx.measureText(label).width; ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText('JEV: UNDER CONTROL?', x + w - lw - 8, 26) }
  const grd = ctx.createLinearGradient(x, 0, x + w, 0)
  grd.addColorStop(0, 'rgba(251,113,133,.55)'); grd.addColorStop(0.19, 'rgba(251,113,133,.55)'); grd.addColorStop(0.3, 'rgba(251,191,36,.35)'); grd.addColorStop(0.5, 'rgba(52,211,153,.35)')
  grd.addColorStop(0.7, 'rgba(251,191,36,.35)'); grd.addColorStop(0.81, 'rgba(251,113,133,.55)'); grd.addColorStop(1, 'rgba(251,113,133,.55)')
  ctx.fillStyle = grd; ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill()
  // the bar spans -1.6..+1.6; the point of no return sits at ±1
  const px = (v) => x + ((v + 1.6) / 3.2) * w
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5
  for (const v of [-1, 1]) { ctx.beginPath(); ctx.moveTo(px(v), y - 3); ctx.lineTo(px(v), y + h + 3); ctx.stroke() }
  const mx = px(clamp(fx.budgetShown, -1.6, 1.6)), lost = Math.abs(fx.budgetShown) > 1
  ctx.fillStyle = '#fff'; ctx.shadowColor = lost ? '#fb7185' : '#fff'; ctx.shadowBlur = 12
  ctx.beginPath(); ctx.moveTo(mx, y - 4); ctx.lineTo(mx + 6, y - 12); ctx.lineTo(mx - 6, y - 12); ctx.closePath(); ctx.fill()
  ctx.fillRect(mx - 1.5, y - 2, 3, h + 4); ctx.shadowBlur = 0
  ctx.font = `600 10px ${FONT}`; ctx.fillStyle = lost ? '#fda4af' : 'rgba(139,146,170,1)'; ctx.textAlign = 'right'
  ctx.fillText(lost ? 'past the white line: gravity beats the hardest shove' : 'lean + swing, against what the hardest shove can save', x + w, y + h + 16)
  ctx.restore()
}

/** Bottom strip: signed tilt over the last decisions, gusts marked. */
function drawScope(f, g) {
  const x = 22, w = cssW - 44, y = cssH - 92, h = 62, tr = f.trace || []
  ctx.save()
  ctx.fillStyle = 'rgba(6,7,14,.72)'; ctx.strokeStyle = 'rgba(46,53,80,.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill(); ctx.stroke()
  const span = Math.max(6, f.noReturnDeg * 1.2), Y = (deg) => y + h / 2 - clamp(deg / span, -1, 1) * (h / 2 - 5)
  ctx.strokeStyle = 'rgba(233,236,245,.14)'; ctx.beginPath(); ctx.moveTo(x + 6, Y(0)); ctx.lineTo(x + w - 6, Y(0)); ctx.stroke()
  ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(251,113,133,.5)'
  for (const v of [-f.noReturnDeg, f.noReturnDeg]) { ctx.beginPath(); ctx.moveTo(x + 6, Y(v)); ctx.lineTo(x + w - 6, Y(v)); ctx.stroke() }
  ctx.setLineDash([])
  const n = 160, dx = (w - 100) / (n - 1), x0 = x + 92 + (n - tr.length) * dx
  ctx.beginPath(); tr.forEach(([deg], i) => { const X = x0 + i * dx; i ? ctx.lineTo(X, Y(deg)) : ctx.moveTo(X, Y(deg)) })
  ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 1.8; ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0
  tr.forEach(([deg, gust], i) => { if (!gust) return; const X = x0 + i * dx; ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.moveTo(X, y + 5); ctx.lineTo(X + 4, y + 12); ctx.lineTo(X - 4, y + 12); ctx.closePath(); ctx.fill() })
  ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('TILT', x + 10, y + 8)
  ctx.font = `600 9.5px ${FONT}`; ctx.fillStyle = 'rgba(251,191,36,.9)'; ctx.fillText('▼ gust', x + 10, y + 24)
  ctx.fillStyle = 'rgba(253,164,175,.85)'; ctx.fillText('- - no return', x + 10, y + 38)
  ctx.restore()
}

function drawBanner(f, now) {
  const b = fx.banner
  if (!b || f.phase !== 'fallen') return
  const k = clamp((now - b.at) / 260, 0, 1), e = 1 - (1 - k) * (1 - k)
  ctx.save(); ctx.globalAlpha = e; ctx.translate(cssW / 2, 132); ctx.scale(1.25 - 0.25 * e, 1.25 - 0.25 * e)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = `800 34px ${FONT}`; ctx.shadowColor = '#fb7185'; ctx.shadowBlur = 24; ctx.fillStyle = '#fecdd3'; ctx.fillText('ROD DOWN', 0, 0); ctx.shadowBlur = 0
  ctx.font = `600 12.5px ${FONT}`; ctx.fillStyle = 'rgba(254,205,211,.92)'
  ctx.fillText(`held for ${((b.ticks * f.tickMs) / 1000).toFixed(1)} s at gravity ${f.dials.gravity} · standing up again in ${(Math.max(0, f.hold) * f.tickMs / 1000).toFixed(1)} s`, 0, 30)
  ctx.restore()
}

function fire(ev, f, g) {
  if (ev.e === 'gust' || ev.e === 'flick') {
    const dir = Math.sign(ev.dv) || 1
    fx.gust = 1; fx.gustDir = dir; wind.length = 0
    sparks(g.tipX, g.tipY, ev.e === 'flick' ? 26 : 12, dir > 0 ? 0 : Math.PI, 1.0, 260, ev.e === 'flick' ? 'rgba(94,234,212,1)' : 'rgba(196,181,253,1)', 2)
    ring(g.tipX, g.tipY, ev.e === 'flick' ? 46 : 30, ev.e === 'flick' ? 'rgba(94,234,212,1)' : 'rgba(196,181,253,1)')
  } else if (ev.e === 'fall') {
    fx.banner = { ticks: ev.ticks, at: performance.now() }
  } else if (ev.e === 'thud') {
    const x = g.hx + ev.side * g.rodPx * 0.9
    sparks(x, g.railY - 4, 46, -Math.PI / 2, 2.6, 240, 'rgba(203,213,225,1)', 2.4, 420)
    sparks(x, g.railY - 4, 16, -Math.PI / 2, 2.0, 320, 'rgba(251,113,133,1)', 2, 420)
    ring(x, g.railY - 4, 70, 'rgba(251,113,133,1)', 0.6, 3); fx.shake = 14
  } else if (ev.e === 'stand') {
    fx.banner = null; trail.length = 0
    ring(g.hx, g.hingeY, 90, 'rgba(94,234,212,1)', 0.7, 3); sparks(g.hx, g.hingeY, 18, -Math.PI / 2, 1.4, 220, 'rgba(94,234,212,1)', 2)
  }
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
const pending = []
function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  if (!cur) return
  const g = draw(now, dt)
  for (let i = pending.length - 1; i >= 0; i--) if (now >= pending[i].at) { if (now - pending[i].at < 500) fire(pending[i].ev, cur, g); pending.splice(i, 1) }
}

// ---------------------------------------------------------------- wiring
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const esc = (t) => t.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
function paintStateText(text) {
  $('stateText').innerHTML = text.split('\n').slice(1).map((l) => {
    l = esc(l)
    if (l.startsWith('angle:')) return `<span class="hl">${l}</span>`
    if (l.startsWith('push:')) return `<span class="ok">${l}</span>`
    return l
  }).join('\n')
}
function paintHistory(f) {
  const secs = (t) => (t * f.tickMs) / 1000
  const all = [...(f.runs || []).map((r) => ({ s: r.secs })), ...(f.phase === 'fallen' ? [] : [{ s: secs(f.thisRun), live: true }])]
  const max = Math.max(5, ...all.map((r) => r.s))
  $('hist').innerHTML = all.length ? all.map((r) => `<div class="bar${r.live ? ' live' : ''}" style="height:${Math.max(4, (r.s / max) * 100)}%" title="${r.live ? `this run: ${r.s.toFixed(1)} s so far` : `held for ${r.s.toFixed(1)} s`}"></div>`).join('') : '<span class="empty">no run finished yet</span>'
  const done = f.runs || []
  $('histNote').textContent = done.length ? `mean ${(done.reduce((s, r) => s + r.secs, 0) / done.length).toFixed(1)} s before a fall` : 'seconds held per run'
}

let paused = false
const FMT = { gravity: (v) => v.toFixed(1), length: (v) => v.toFixed(2), gustStrength: (v) => v.toFixed(2) }
function onFrame(f) {
  const now = performance.now()
  if (firstFrame) { lastEventId = Math.max(-1, ...(f.events || []).map((e) => e.id)); firstFrame = false; camX = f.x; lenShown = f.dials.length }
  if (cur && f.t < cur.t) lastEventId = Math.min(lastEventId, -1)
  for (const ev of f.events || []) if (ev.id > lastEventId) { pending.push({ ev, at: now + (f.running ? f.tickMs * 0.9 : 0) }); lastEventId = ev.id }
  cur = f; curAt = now
  paused = !f.running
  const secs = (t) => ((t * f.tickMs) / 1000).toFixed(1) + ' s'
  $('title').textContent = f.title
  $('s-run').textContent = secs(f.phase === 'fallen' ? f.lastRun : f.thisRun); $('s-run').classList.toggle('best', f.phase !== 'fallen' && f.falls > 0 && f.thisRun >= f.bestRun)
  $('s-best').textContent = secs(f.bestRun); $('s-falls').textContent = f.falls; $('s-tilt').textContent = `${f.angle >= 0 ? '+' : ''}${f.angle.toFixed(1)}°`
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const ph = $('phase'); ph.textContent = f.phase === 'fallen' ? 'ROD DOWN' : 'BALANCING'; ph.className = 'right pill ' + (f.phase === 'fallen' ? 'bad' : 'ok')
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem); $('cfgError').textContent = problem ? `${problem} — still running on the last good rig.` : ''
  for (const k of Object.keys(FMT)) {
    const el = $('d-' + k)
    if (document.activeElement !== el) { el.value = f.dials[k]; $('v-' + k).textContent = FMT[k](f.dials[k]) }
    $('v-' + k).style.color = k in (f.overrides || {}) ? '' : 'var(--dim)'
  }
  paintStateText(f.stateText || '')
  paintHistory(f)
}

const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('gust').onclick = () => post({ cmd: 'gust' })
$('stand').onclick = () => post({ cmd: 'stand' })
for (const k of Object.keys(FMT)) $('d-' + k).oninput = (e) => { const v = Number(e.target.value); $('v-' + k).textContent = FMT[k](v); post({ cmd: 'set', key: k, value: v }) }
scene.addEventListener('click', (e) => {
  if (!cur) return
  const r = scene.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
  const g = geometry(cur, 1), dx = mx - g.tipX
  const v = Math.sign(dx || 1) * clamp(0.35 + Math.abs(dx) / 320, 0.35, 1.6)
  ring(mx, my, 26, 'rgba(94,234,212,1)', 0.4)
  post({ cmd: 'flick', v })
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
