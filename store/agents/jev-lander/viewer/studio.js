// Jev Lander pane — a night landing. The server runs the flight and streams one frame per Jev
// decision; this file draws at 60 fps and eases between frames. The camera zooms in on the pad as
// the booster comes down. Jev's mind is drawn in the scene: a throttle gauge with four segments
// filled by probability, its own answer to "will it be soft?", and under the booster the height it
// would need to stop at full burn.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap')
const ctx = scene.getContext('2d')
const ACTIONS = ['CUT', 'COAST', 'HOVER', 'BURN']
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"
const TCOL = { CUT: '#64748b', COAST: '#38bdf8', HOVER: '#fbbf24', BURN: '#fb923c' }

// ---------------------------------------------------------------- state
let cur = null, curAt = 0
let lastEventId = -1, firstFrame = true
let cssW = 800, cssH = 500, dpr = 1
let viewAlt = 110
const particles = [], rings = [], smoke = [], debris = [], streaks = []
const fx = { shake: 0, flash: 0, power: 0, fuelShown: 60, softShown: 0.5, legs: 0, squash: 0, banner: null, boom: 0, boomAt: 0, note: null, leakUntil: 0, hidden: false }
const probShown = Object.fromEntries(ACTIONS.map((m) => [m, 0.25]))

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
function rnd(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// stars and two mountain ridges, made once
const R = rnd(77)
const stars = Array.from({ length: 170 }, () => ({ x: R(), y: R() * 0.8, r: 0.4 + R() * 1.2, ph: R() * 7, sp: 0.6 + R() * 2 }))
function ridge(seed, n, rough) {
  const r = rnd(seed), pts = new Array(n + 1).fill(0)
  pts[0] = r(); pts[n] = r()
  for (let step = n; step > 1; step >>= 1) for (let i = step >> 1; i < n; i += step) pts[i] = (pts[i - (step >> 1)] + pts[i + (step >> 1)]) / 2 + (r() - 0.5) * rough * (step / n)
  const lo = Math.min(...pts), hi = Math.max(...pts)
  return pts.map((v) => (v - lo) / Math.max(1e-6, hi - lo))
}
const FAR = ridge(5, 128, 1.6), NEAR = ridge(9, 128, 1.1)

function resize() {
  const r = wrap.getBoundingClientRect()
  dpr = Math.min(2.5, window.devicePixelRatio || 1)
  cssW = Math.max(260, r.width); cssH = Math.max(240, r.height)
  scene.width = Math.round(cssW * dpr); scene.height = Math.round(cssH * dpr)
}

// ---------------------------------------------------------------- effects
function sparks(x, y, n, dir, spread, speed, color, size = 2, grav = 0, lifeMul = 1) {
  for (let i = 0; i < n && particles.length < 900; i++) {
    const a = dir + (Math.random() - 0.5) * spread, v = speed * (0.2 + Math.random()), life = (0.3 + Math.random() * 0.7) * lifeMul
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.6 + Math.random() * 0.8), grav })
  }
}
function puff(x, y, vx, vy, r, life, shade = 150) { if (smoke.length < 420) smoke.push({ x, y, vx, vy, r, life, max: life, shade }) }
function ring(x, y, r1, color, life = 0.6, width = 2.5, flat = 1) { rings.push({ x, y, r0: 4, r1, life, max: life, color, width, flat }) }

// ---------------------------------------------------------------- geometry
function geometry(f, a) {
  const gaugeW = cssW > 760 ? 168 : 132
  const groundY = cssH - 92, top = 64
  const scale = (groundY - top) / viewAlt
  const cx = (cssW - gaugeW) * 0.5 + 8
  const y = lerp(f.fromY ?? f.y, f.y, a)
  const rh = clamp(13 * scale, 74, 210), rw = rh * 0.16
  const feetY = groundY - y * scale
  return { gaugeW, groundY, top, scale, cx, y, rh, rw, feetY }
}

function drawSky(g, now) {
  const sky = ctx.createLinearGradient(0, 0, 0, g.groundY)
  sky.addColorStop(0, '#02030a'); sky.addColorStop(0.55, '#08102a'); sky.addColorStop(0.86, '#1a1f48'); sky.addColorStop(1, '#3b2a55')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, cssW, g.groundY + 2)
  const par = (110 - viewAlt) * 0.5
  for (const s of stars) {
    const tw = 0.45 + 0.55 * Math.sin(now * 0.001 * s.sp + s.ph)
    ctx.globalAlpha = 0.25 + 0.75 * tw * (1 - s.y * 0.8); ctx.fillStyle = '#e9ecf5'
    ctx.beginPath(); ctx.arc(s.x * cssW, s.y * g.groundY - par * (0.3 + s.r * 0.2), s.r, 0, 7); ctx.fill()
  }
  ctx.globalAlpha = 1
  // a moon
  const mx = (cssW - g.gaugeW) * 0.8, my = 104 - par * 0.35
  const halo = ctx.createRadialGradient(mx, my, 6, mx, my, 120); halo.addColorStop(0, 'rgba(226,232,255,.22)'); halo.addColorStop(1, 'rgba(226,232,255,0)')
  ctx.fillStyle = halo; ctx.fillRect(mx - 120, my - 120, 240, 240)
  ctx.fillStyle = '#dfe6ff'; ctx.beginPath(); ctx.arc(mx, my, 24, 0, 7); ctx.fill()
  ctx.fillStyle = 'rgba(8,16,42,.9)'; ctx.beginPath(); ctx.arc(mx + 9, my - 5, 22, 0, 7); ctx.fill()
  // ridges: they swell as the camera comes down to the pad
  const z = clamp(110 / viewAlt, 0.8, 3.2)
  const layer = (pts, depth, height, col, glowCol) => {
    const k = Math.pow(z, depth), w = cssW * k * 1.25, x0 = g.cx - w * 0.5
    ctx.beginPath(); ctx.moveTo(x0, g.groundY + 2)
    pts.forEach((v, i) => ctx.lineTo(x0 + (i / (pts.length - 1)) * w, g.groundY - (12 + v * height) * k))
    ctx.lineTo(x0 + w, g.groundY + 2); ctx.closePath()
    const grd = ctx.createLinearGradient(0, g.groundY - height * k, 0, g.groundY); grd.addColorStop(0, col); grd.addColorStop(1, glowCol)
    ctx.fillStyle = grd; ctx.fill()
  }
  layer(FAR, 0.35, cssH * 0.27, '#1c2452', '#3a2c5e')
  layer(NEAR, 0.7, cssH * 0.12, '#0c1128', '#1a1636')
}

function drawGround(g, f, now, power) {
  const grd = ctx.createLinearGradient(0, g.groundY, 0, cssH); grd.addColorStop(0, '#11131f'); grd.addColorStop(1, '#05060b')
  ctx.fillStyle = grd; ctx.fillRect(0, g.groundY, cssW, cssH - g.groundY)
  // the pad
  const pw = clamp(g.rh * 2.1, 170, 420), px = g.cx - pw / 2
  ctx.fillStyle = '#2a2e44'; ctx.beginPath(); ctx.roundRect(px, g.groundY - 5, pw, 12, 3); ctx.fill()
  ctx.fillStyle = '#4a5072'; ctx.fillRect(px, g.groundY - 5, pw, 3)
  for (let i = 0; i < 9; i++) { ctx.fillStyle = i % 2 ? '#fbbf24' : '#1b1e30'; ctx.fillRect(px + (i / 9) * pw, g.groundY + 3, pw / 9, 4) }
  ctx.strokeStyle = 'rgba(233,236,245,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(g.cx, g.groundY - 4, pw * 0.2, 2.5, 0, 0, 7); ctx.stroke()
  const ok = f.phase === 'landed', bad = f.phase === 'crashed'
  for (const sgn of [-1, 1]) {
    const lx = g.cx + sgn * (pw / 2 + 12), on = Math.sin(now * 0.006 + (sgn > 0 ? 0 : Math.PI)) > 0
    ctx.fillStyle = '#1b1e30'; ctx.fillRect(lx - 2, g.groundY - 22, 4, 22)
    const col = ok ? '52,211,153' : bad ? '251,113,133' : '251,146,60'
    ctx.fillStyle = `rgba(${col},${on || ok ? 1 : 0.25})`; ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = on || ok ? 14 : 0
    ctx.beginPath(); ctx.arc(lx, g.groundY - 24, 3.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0
  }
  // the engine lights the ground
  const near = clamp(1 - (g.groundY - g.feetY) / (g.rh * 3.2), 0, 1)
  if (power > 0.02 && near > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const gl = ctx.createRadialGradient(g.cx, g.groundY, 4, g.cx, g.groundY, pw * (0.5 + near * 0.7))
    gl.addColorStop(0, `rgba(255,190,110,${0.55 * power * near})`); gl.addColorStop(1, 'rgba(255,150,60,0)')
    ctx.fillStyle = gl; ctx.beginPath(); ctx.ellipse(g.cx, g.groundY, pw * (0.5 + near * 0.7), 26 + near * 22, 0, 0, 7); ctx.fill(); ctx.restore()
  }
}

/** The flame: three nested tongues that flicker, with shock diamonds at full burn. */
function drawPlume(g, x, y, power, now) {
  if (power < 0.015) return
  const flick = 0.86 + 0.1 * Math.sin(now * 0.05) + 0.1 * Math.random()
  const room = Math.max(10, g.groundY - y)
  const len = Math.min(g.rh * (0.3 + 1.75 * power) * flick, room + 6), w = g.rw * (0.62 + 0.5 * power)
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  const tongue = (wk, lk, c0, c1) => {
    const L = len * lk, W = w * wk, jit = (Math.random() - 0.5) * W * 0.5
    const grd = ctx.createLinearGradient(0, y, 0, y + L); grd.addColorStop(0, c0); grd.addColorStop(1, c1)
    ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(x - W, y)
    ctx.quadraticCurveTo(x - W * 1.25, y + L * 0.45, x + jit, y + L); ctx.quadraticCurveTo(x + W * 1.25, y + L * 0.45, x + W, y); ctx.closePath(); ctx.fill()
  }
  tongue(1.5, 1, 'rgba(255,120,40,.55)', 'rgba(255,60,20,0)')
  tongue(0.95, 0.78, 'rgba(255,200,90,.85)', 'rgba(255,140,40,0)')
  tongue(0.5, 0.52, 'rgba(235,245,255,.95)', 'rgba(140,190,255,0)')
  if (power > 0.75) for (let i = 1; i <= 3; i++) { const dy = y + len * 0.17 * i, s = w * 0.42 * (1 - i * 0.2); ctx.fillStyle = `rgba(255,255,255,${0.6 - i * 0.13})`; ctx.beginPath(); ctx.moveTo(x, dy - s); ctx.lineTo(x + s * 0.8, dy); ctx.lineTo(x, dy + s); ctx.lineTo(x - s * 0.8, dy); ctx.closePath(); ctx.fill() }
  const glow = ctx.createRadialGradient(x, y + 4, 2, x, y + 4, g.rw * (2 + 4 * power))
  glow.addColorStop(0, `rgba(255,210,140,${0.75 * power})`); glow.addColorStop(1, 'rgba(255,150,60,0)')
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y + 4, g.rw * (2 + 4 * power), 0, 7); ctx.fill()
  ctx.restore()
  // smoke from the tip; near the pad it is blown out sideways as dust
  const tipY = y + len, hitsGround = tipY >= g.groundY - 4
  if (Math.random() < 0.35 + power * 0.6) {
    if (hitsGround) { const dir = Math.random() < 0.5 ? -1 : 1; puff(x + dir * 8, g.groundY - 4, dir * (120 + Math.random() * 260) * power, -10 - Math.random() * 40, 5 + Math.random() * 8, 0.9 + Math.random() * 0.9, 170) }
    else puff(x + (Math.random() - 0.5) * w, tipY, (Math.random() - 0.5) * 30, 30 + Math.random() * 50, 3 + Math.random() * 5, 0.7 + Math.random() * 0.7, 120)
  }
}

function drawBooster(g, f, now, power) {
  const x = g.cx, feet = g.feetY + fx.squash * 3, rh = g.rh, rw = g.rw
  const legLen = rh * 0.26, deploy = fx.legs, legA = lerp(0.12, 0.95, deploy) // radians from the body
  const drop = Math.cos(legA) * legLen * deploy * 0.9 + rh * 0.02          // feet hang below the engine once out
  const baseY = feet - drop                                                  // bottom of the body
  drawPlume(g, x, baseY + rh * 0.035, power, now)
  ctx.save()
  // legs
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = Math.max(2, rw * 0.16); ctx.lineCap = 'round'
  for (const sgn of [-1, 1]) {
    const hx = x + sgn * rw * 0.9, hy = baseY - rh * 0.17
    const fxp = hx + sgn * Math.sin(legA) * legLen, fyp = Math.min(feet, hy + Math.cos(legA) * legLen * (1 - fx.squash * 0.12))
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(fxp, fyp); ctx.stroke()
    ctx.strokeStyle = 'rgba(148,163,184,.8)'; ctx.lineWidth = Math.max(1.2, rw * 0.09)
    ctx.beginPath(); ctx.moveTo(x + sgn * rw * 0.8, baseY - rh * 0.03); ctx.lineTo(lerp(hx, fxp, 0.62), lerp(hy, fyp, 0.62)); ctx.stroke()
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = Math.max(2, rw * 0.16)
    if (deploy > 0.5) { ctx.beginPath(); ctx.moveTo(fxp - 5, fyp); ctx.lineTo(fxp + 5, fyp); ctx.stroke() }
  }
  // engine bell
  ctx.fillStyle = '#3f4560'; ctx.beginPath(); ctx.moveTo(x - rw * 0.42, baseY - rh * 0.03); ctx.lineTo(x + rw * 0.42, baseY - rh * 0.03); ctx.lineTo(x + rw * 0.72, baseY + rh * 0.04); ctx.lineTo(x - rw * 0.72, baseY + rh * 0.04); ctx.closePath(); ctx.fill()
  // body
  const topY = baseY - rh
  const body = ctx.createLinearGradient(x - rw, 0, x + rw, 0)
  body.addColorStop(0, '#7f8aa8'); body.addColorStop(0.3, '#f4f6ff'); body.addColorStop(0.62, '#cfd6ea'); body.addColorStop(1, '#55607e')
  ctx.fillStyle = body; ctx.beginPath(); ctx.moveTo(x - rw, baseY - rh * 0.03); ctx.lineTo(x - rw, topY + rh * 0.13)
  ctx.quadraticCurveTo(x - rw, topY + rh * 0.02, x, topY); ctx.quadraticCurveTo(x + rw, topY + rh * 0.02, x + rw, topY + rh * 0.13)
  ctx.lineTo(x + rw, baseY - rh * 0.03); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#10131f'; ctx.fillRect(x - rw, topY + rh * 0.16, rw * 2, rh * 0.035); ctx.fillRect(x - rw, baseY - rh * 0.24, rw * 2, rh * 0.06)
  ctx.fillStyle = 'rgba(251,146,60,.95)'; ctx.fillRect(x - rw, topY + rh * 0.2, rw * 2, rh * 0.012)
  // grid fins
  ctx.fillStyle = '#2b3150'; for (const sgn of [-1, 1]) ctx.fillRect(x + sgn * rw - (sgn < 0 ? rw * 0.9 : 0), topY + rh * 0.21, rw * 0.9, rh * 0.03)
  // the engine lights the underside of the body
  if (power > 0.02) { ctx.globalCompositeOperation = 'lighter'; const up = ctx.createLinearGradient(0, baseY, 0, baseY - rh * 0.45); up.addColorStop(0, `rgba(255,170,80,${0.55 * power})`); up.addColorStop(1, 'rgba(255,170,80,0)'); ctx.fillStyle = up; ctx.fillRect(x - rw, baseY - rh * 0.45, rw * 2, rh * 0.45) }
  ctx.restore()
  return { baseY, topY, midY: baseY - rh * 0.5 }
}

function arrowV(x, y0, y1, col, width = 3) {
  const dir = Math.sign(y1 - y0) || 1, head = 9
  ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.shadowColor = col; ctx.shadowBlur = 10
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 - dir * head); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x - 6, y1 - dir * head); ctx.lineTo(x + 6, y1 - dir * head); ctx.closePath(); ctx.fill(); ctx.restore()
}

function draw(now, dt) {
  const f = cur
  const a = f.running ? clamp((now - curAt) / Math.max(30, f.tickMs), 0, 1) : 1
  const flying = f.phase === 'flight'
  // ease the numbers
  const yNow = lerp(f.fromY ?? f.y, f.y, a)
  viewAlt = lerp(viewAlt, clamp(yNow * 1.32 + 17, 30, Math.max(60, (f.startAlt || 80) * 1.22)), 1 - Math.exp(-dt * 2.2))
  const wantPower = flying ? (f.fired || 0) / 2.6 : 0
  fx.power = lerp(fx.power, wantPower, 1 - Math.exp(-dt * (wantPower > fx.power ? 16 : 9)))
  fx.fuelShown = lerp(fx.fuelShown, f.fuel, 1 - Math.exp(-dt * 8))
  fx.softShown = lerp(fx.softShown, f.decision.soft ?? 0.5, 1 - Math.exp(-dt * 10))
  fx.legs = lerp(fx.legs, yNow < 30 ? 1 : 0, 1 - Math.exp(-dt * 3.5))
  for (const m of ACTIONS) probShown[m] = lerp(probShown[m], f.decision.probs?.[m] ?? 0, 1 - Math.exp(-dt * 14))
  fx.shake *= Math.exp(-dt * 6); fx.flash *= Math.exp(-dt * 5); fx.squash *= Math.exp(-dt * 5)
  const g = geometry(f, a)

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.save(); ctx.translate((Math.random() - 0.5) * fx.shake * 2, (Math.random() - 0.5) * fx.shake * 2)
  drawSky(g, now)
  drawGround(g, f, now, fx.power)
  drawRuler(g, f)

  // ---- smoke behind the booster
  for (let i = smoke.length - 1; i >= 0; i--) {
    const s = smoke[i]; s.life -= dt
    if (s.life <= 0) { smoke[i] = smoke[smoke.length - 1]; smoke.pop(); continue }
    s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 1 - 1.6 * dt; s.vy = s.vy * (1 - 1.2 * dt) - 14 * dt; s.r += 16 * dt
    if (s.y > g.groundY - 3) { s.y = g.groundY - 3; s.vy = -Math.abs(s.vy) * 0.2 }
    const k = s.life / s.max
    ctx.fillStyle = `rgba(${s.shade},${s.shade},${s.shade + 12},${0.26 * k})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill()
  }

  // ---- wind streaks from a shove
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
  for (let i = streaks.length - 1; i >= 0; i--) {
    const s = streaks[i]; s.life -= dt; if (s.life <= 0) { streaks.splice(i, 1); continue }
    s.y += s.v * dt
    const grd = ctx.createLinearGradient(0, s.y, 0, s.y - Math.sign(s.v) * s.l); grd.addColorStop(0, `rgba(186,230,253,${0.6 * s.life})`); grd.addColorStop(1, 'rgba(186,230,253,0)')
    ctx.strokeStyle = grd; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - Math.sign(s.v) * s.l); ctx.stroke()
  }
  ctx.restore()

  // ---- the booster, its speed and its braking distance
  let body = null
  if (f.phase !== 'crashed') body = drawBooster(g, f, now, fx.power)
  if (body && flying) {
    const safe = Math.abs(f.v) <= f.dials.safeSpeed, stop = f.stopDistance
    const doomed = stop == null || stop > g.y + 0.5
    const col = doomed ? '#fb7185' : safe ? '#34d399' : '#fbbf24'
    const vx = g.cx - g.rw - 34, len = clamp(Math.abs(f.v) * 11, 8, 170) * Math.sign(-f.v || 1)
    arrowV(vx, body.midY, body.midY + len, col, 3.5)
    ctx.font = `700 12px ${FONT}`; ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.fillText(`${f.v.toFixed(1)} / tick`, vx - 12, body.midY + len * 0.5)
    ctx.font = `600 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(safe ? 'soft enough' : `soft is ${f.dials.safeSpeed.toFixed(1)} or less`, vx - 12, body.midY + len * 0.5 + 15)
    // braking distance at full burn, drawn from the feet down
    const bx = g.cx + g.rw + 40, y0 = g.feetY, y1 = stop == null ? g.groundY + 14 : Math.min(g.groundY + 14, y0 + stop * g.scale)
    if (f.v < -0.2) {
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(bx, y0); ctx.lineTo(bx, y1); ctx.stroke(); ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(bx - 7, y0); ctx.lineTo(bx + 7, y0); ctx.moveTo(bx - 7, y1); ctx.lineTo(bx + 7, y1); ctx.stroke(); ctx.restore()
      ctx.font = `600 10.5px ${FONT}`; ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const ty = clamp((y0 + y1) / 2, g.top + 40, g.groundY - 22)
      ctx.fillText(stop == null ? 'full burn cannot slow it' : doomed ? `needs ${stop.toFixed(0)} to stop, has ${g.y.toFixed(0)}` : `full burn stops it in ${stop.toFixed(0)}`, bx + 12, ty)
    }
    if (f.flameout > 0 && Math.sin(now * 0.02) > -0.3) { ctx.font = `800 13px ${FONT}`; ctx.fillStyle = '#fb7185'; ctx.textAlign = 'center'; ctx.fillText(`ENGINE OUT · ${f.flameout}`, g.cx, body.topY - 18) }
    else if (f.dry && Math.sin(now * 0.02) > -0.3) { ctx.font = `800 13px ${FONT}`; ctx.fillStyle = '#fb7185'; ctx.textAlign = 'center'; ctx.fillText('TANK DRY', g.cx, body.topY - 18) }
    if (now < fx.leakUntil && Math.random() < 0.8) sparks(g.cx + g.rw, body.midY, 2, -0.3, 0.7, 150, 'rgba(251,191,36,1)', 1.8, 300, 0.7)
  }

  // ---- wreck, fire and debris after a crash
  if (f.phase === 'crashed') {
    const k = clamp((now - fx.boomAt) / 900, 0, 1)
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.ellipse(g.cx, g.groundY - 2, g.rh * 0.5, 6, 0, 0, 7); ctx.fill()
    ctx.save(); ctx.translate(g.cx + g.rh * 0.12, g.groundY - 6); ctx.rotate(1.25); ctx.fillStyle = '#3a4058'; ctx.fillRect(-g.rw, -g.rh * 0.42, g.rw * 2, g.rh * 0.42); ctx.restore()
    if (k < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const r = g.rh * (0.3 + 1.5 * (1 - (1 - k) * (1 - k))); const fb = ctx.createRadialGradient(g.cx, g.groundY - r * 0.35, 2, g.cx, g.groundY - r * 0.35, r); fb.addColorStop(0, `rgba(255,250,220,${1 - k})`); fb.addColorStop(0.35, `rgba(255,170,60,${0.9 * (1 - k)})`); fb.addColorStop(1, 'rgba(200,40,20,0)'); ctx.fillStyle = fb; ctx.beginPath(); ctx.arc(g.cx, g.groundY - r * 0.35, r, 0, 7); ctx.fill(); ctx.restore() }
    if (Math.random() < 0.5) puff(g.cx + (Math.random() - 0.5) * 40, g.groundY - 10, (Math.random() - 0.5) * 30, -50 - Math.random() * 60, 8 + Math.random() * 10, 1.4 + Math.random(), 70)
    if (Math.random() < 0.35) sparks(g.cx + (Math.random() - 0.5) * 50, g.groundY - 8, 1, -Math.PI / 2, 1.2, 120, 'rgba(255,170,60,1)', 2, 200)
  }
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.life -= dt; if (d.life <= 0) { debris.splice(i, 1); continue }
    d.vy += 620 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.spin * dt
    if (d.y > g.groundY - 3) { d.y = g.groundY - 3; d.vy *= -0.35; d.vx *= 0.6; d.spin *= 0.5 }
    ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.globalAlpha = clamp(d.life, 0, 1); ctx.fillStyle = d.col; ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h); ctx.restore()
  }

  // ---- particles and rings
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i]; q.life -= dt
    if (q.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue }
    q.vy += q.grav * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 1 - 1.4 * dt
    if (q.y > g.groundY - 2 && q.vy > 0) { q.y = g.groundY - 2; q.vy *= -0.3 }
    ctx.globalAlpha = clamp(q.life / q.max, 0, 1); ctx.strokeStyle = q.color; ctx.lineWidth = q.size
    ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * 0.03, q.y - q.vy * 0.03); ctx.stroke()
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.life -= dt; if (r.life <= 0) { rings.splice(i, 1); continue }
    const k = 1 - r.life / r.max, rad = lerp(r.r0, r.r1, 1 - (1 - k) * (1 - k))
    ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = r.width * (1 - k * 0.6)
    ctx.beginPath(); ctx.ellipse(r.x, r.y, rad, rad * r.flat, 0, 0, 7); ctx.stroke()
  }
  ctx.restore()

  drawReadout(g, f)
  drawGauges(g, f, now)
  drawPlot(g, f)
  drawBanner(g, f, now)
  if (fx.flash > 0.02) { ctx.fillStyle = `rgba(255,240,220,${fx.flash * 0.6})`; ctx.fillRect(0, 0, cssW, cssH) }
  ctx.restore()
  return g
}

/** Left edge: an altitude ruler with the booster's marker. */
function drawRuler(g, f) {
  const x = 18
  ctx.save(); ctx.font = `600 10px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  const stepA = viewAlt > 140 ? 20 : viewAlt > 60 ? 10 : 5
  for (let h = 0; h <= viewAlt; h += stepA) {
    const y = g.groundY - h * g.scale; if (y < g.top - 6) break
    ctx.fillStyle = 'rgba(233,236,245,.28)'; ctx.fillRect(x, y - 0.5, h % (stepA * 2) === 0 ? 12 : 7, 1)
    if (h % (stepA * 2) === 0) { ctx.fillStyle = 'rgba(139,146,170,.85)'; ctx.fillText(String(h), x + 16, y) }
  }
  const my = clamp(g.feetY, g.top, g.groundY)
  ctx.fillStyle = '#5eead4'; ctx.beginPath(); ctx.moveTo(x + 40, my); ctx.lineTo(x + 50, my - 6); ctx.lineTo(x + 50, my + 6); ctx.closePath(); ctx.fill()
  ctx.restore()
}

/** Top left: altitude and speed, large. */
function drawReadout(g, f) {
  ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText('ALTITUDE', 78, 30)
  ctx.font = `800 38px ${FONT}`; ctx.fillStyle = '#5eead4'; ctx.shadowColor = '#5eead4'; ctx.shadowBlur = 16; ctx.fillText(g.y.toFixed(1), 78, 66); ctx.shadowBlur = 0
  ctx.font = `600 10.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'
  ctx.fillText(`flight ${f.episode} · gravity ${f.dials.gravity.toFixed(2)} · full burn brakes ${f.brake > 0 ? f.brake.toFixed(2) : 'nothing'} / tick`, 78, 86)
  ctx.restore()
}

/** Right side: the fuel tank, and Jev's throttle gauge with four segments filled by probability. */
function drawGauges(g, f, now) {
  const x0 = cssW - g.gaugeW + 6, w = g.gaugeW - 24
  ctx.save()
  ctx.fillStyle = 'rgba(5,6,12,.62)'; ctx.strokeStyle = 'rgba(46,53,80,.9)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.roundRect(x0 - 8, 14, w + 20, g.groundY - 22, 10); ctx.fill(); ctx.stroke()
  // Jev's answer
  const s = fx.softShown, sc = s > 0.6 ? '#34d399' : s > 0.35 ? '#fbbf24' : '#fb7185'
  ctx.font = `700 9.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('JEV: SOFT LANDING?', x0, 34)
  ctx.font = `800 22px ${FONT}`; ctx.fillStyle = f.phase === 'flight' ? sc : 'rgba(139,146,170,1)'; ctx.fillText(f.phase === 'flight' ? `${Math.round(s * 100)}%` : '—', x0, 58)
  // throttle gauge
  ctx.font = `700 9.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText("JEV'S THROTTLE", x0, 82)
  const segH = clamp((g.groundY - 330) / 4, 30, 46), sy0 = 90
  ;[...ACTIONS].reverse().forEach((m, i) => {
    const y = sy0 + i * (segH + 5), p = probShown[m], chosen = m === f.thrust && f.phase === 'flight'
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.beginPath(); ctx.roundRect(x0, y, w, segH, 6); ctx.fill()
    ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y, w, segH, 6); ctx.clip()
    const fill = ctx.createLinearGradient(x0, 0, x0 + w, 0); fill.addColorStop(0, TCOL[m] + 'cc'); fill.addColorStop(1, TCOL[m] + '55')
    ctx.fillStyle = fill; ctx.globalAlpha = 0.35 + p * 0.65; ctx.fillRect(x0, y, w * p, segH); ctx.restore()
    ctx.strokeStyle = chosen ? '#34d399' : 'rgba(46,53,80,1)'; ctx.lineWidth = chosen ? 2 : 1
    if (chosen) { ctx.shadowColor = '#34d399'; ctx.shadowBlur = 14 }
    ctx.beginPath(); ctx.roundRect(x0, y, w, segH, 6); ctx.stroke(); ctx.shadowBlur = 0
    ctx.font = `700 11.5px ${FONT}`; ctx.fillStyle = chosen ? '#ecfdf5' : 'rgba(233,236,245,.85)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(m, x0 + 9, y + segH / 2 - 6)
    ctx.font = `600 9.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(`push ${f.levels[m].toFixed(2)}`, x0 + 9, y + segH / 2 + 8)
    ctx.font = `700 12px ${FONT}`; ctx.fillStyle = chosen ? '#a7f3d0' : 'rgba(233,236,245,.8)'; ctx.textAlign = 'right'; ctx.fillText(`${Math.round(p * 100)}%`, x0 + w - 8, y + segH / 2)
    if (chosen) { ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.moveTo(x0 - 3, y + segH / 2); ctx.lineTo(x0 - 11, y + segH / 2 - 6); ctx.lineTo(x0 - 11, y + segH / 2 + 6); ctx.closePath(); ctx.fill() }
  })
  // fuel tank
  const ty = sy0 + 4 * (segH + 5) + 22, th = Math.max(50, g.groundY - 34 - ty), tw = 40, tx = x0 + 2
  const frac = clamp(fx.fuelShown / Math.max(1, f.tank), 0, 1), low = frac < 0.22
  ctx.font = `700 9.5px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('FUEL', x0, ty - 7)
  ctx.save(); ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 9); ctx.clip()
  ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(tx, ty, tw, th)
  const ly = ty + th * (1 - frac)
  const liq = ctx.createLinearGradient(0, ly, 0, ty + th); liq.addColorStop(0, low ? '#fb7185' : '#fbbf24'); liq.addColorStop(1, low ? '#9f1239' : '#c2410c')
  ctx.fillStyle = liq; ctx.beginPath(); ctx.moveTo(tx, ty + th)
  for (let i = 0; i <= 10; i++) ctx.lineTo(tx + (i / 10) * tw, ly + Math.sin(now * 0.006 + i * 0.9) * (1.2 + fx.power * 2.4))
  ctx.lineTo(tx + tw, ty + th); ctx.closePath(); ctx.fill(); ctx.restore()
  ctx.strokeStyle = low && Math.sin(now * 0.015) > 0 ? '#fb7185' : 'rgba(203,213,225,.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 9); ctx.stroke()
  for (let i = 1; i < 4; i++) { ctx.fillStyle = 'rgba(233,236,245,.35)'; ctx.fillRect(tx + tw, ty + (th * i) / 4, 5, 1) }
  ctx.font = `800 20px ${FONT}`; ctx.fillStyle = low ? '#fb7185' : '#fbbf24'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(fx.fuelShown.toFixed(0), tx + tw + 12, ty + 24)
  ctx.font = `600 10px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(`of ${Math.round(f.tank)}`, tx + tw + 12, ty + 40)
  ctx.fillText(w >= 140 ? `−${(f.fired || 0).toFixed(2)} / tick` : `−${(f.fired || 0).toFixed(2)}`, tx + tw + 12, ty + 58)
  if (low) { ctx.font = `800 11px ${FONT}`; ctx.fillStyle = '#fb7185'; ctx.fillText(frac <= 0.001 ? 'EMPTY' : 'LOW', tx + tw + 12, ty + 78) }
  ctx.restore()
}

/** Bottom left, in the ground strip: altitude over the flight, coloured by the throttle. */
function drawPlot(g, f) {
  const x = 18, y = g.groundY + 22, w = Math.min(330, cssW * 0.36), h = cssH - y - 12, tr = f.trace || []
  if (h < 30) return
  ctx.save()
  ctx.fillStyle = 'rgba(6,7,14,.7)'; ctx.strokeStyle = 'rgba(46,53,80,.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke()
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('ALTITUDE THIS FLIGHT', x + 8, y + 6)
  const top = Math.max(f.startAlt || 80, ...tr.map((p) => p[0])), n = Math.max(40, tr.length), dx = (w - 16) / (n - 1)
  for (let i = 1; i < tr.length; i++) {
    const p = tr[i][1] / 2.6
    ctx.strokeStyle = p > 0.8 ? TCOL.BURN : p > 0.3 ? TCOL.HOVER : p > 0.05 ? TCOL.COAST : TCOL.CUT; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(x + 8 + (i - 1) * dx, y + h - 6 - (tr[i - 1][0] / top) * (h - 24)); ctx.lineTo(x + 8 + i * dx, y + h - 6 - (tr[i][0] / top) * (h - 24)); ctx.stroke()
  }
  ctx.restore()
}

function drawBanner(g, f, now) {
  if (f.phase === 'flight') return
  if (!fx.banner) fx.banner = { ok: f.phase === 'landed', speed: f.finished?.crashSpeed ?? 0, at: now }
  const b = fx.banner
  const k = clamp((now - b.at) / 280, 0, 1), e = 1 - (1 - k) * (1 - k), ok = b.ok
  const cx = (cssW - g.gaugeW) / 2 + 30
  ctx.save(); ctx.globalAlpha = e; ctx.translate(cx, 134); ctx.scale(1.25 - 0.25 * e, 1.25 - 0.25 * e)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.font = `800 32px ${FONT}`; ctx.shadowColor = ok ? '#34d399' : '#fb7185'; ctx.shadowBlur = 24; ctx.fillStyle = ok ? '#d1fae5' : '#fecdd3'
  ctx.fillText(ok ? 'SOFT LANDING' : 'CRASHED', 0, 0); ctx.shadowBlur = 0
  ctx.font = `600 12.5px ${FONT}`; ctx.fillStyle = ok ? 'rgba(209,250,229,.92)' : 'rgba(254,205,211,.92)'
  const fin = f.finished || {}
  ctx.fillText(`touched down at ${Number(b.speed).toFixed(1)} / tick · soft is ${f.dials.safeSpeed.toFixed(1)} or less`, 0, 30)
  ctx.fillStyle = 'rgba(139,146,170,1)'; ctx.fillText(`${fin.fuelLeft ?? 0} fuel left · next booster in ${(Math.max(0, f.hold) * f.tickMs / 1000).toFixed(1)} s`, 0, 50)
  ctx.restore()
}

function fire(ev, f, g) {
  if (ev.e === 'touchdown') {
    fx.banner = { ok: true, speed: ev.speed, at: performance.now() }; fx.squash = 1; fx.shake = 4
    for (const sgn of [-1, 1]) for (let i = 0; i < 26; i++) puff(g.cx + sgn * 10, g.groundY - 4, sgn * (80 + Math.random() * 300), -8 - Math.random() * 46, 5 + Math.random() * 9, 1 + Math.random() * 1.1, 175)
    ring(g.cx, g.groundY - 3, g.rh * 1.3, 'rgba(52,211,153,1)', 0.9, 3, 0.16); ring(g.cx, g.groundY - 3, g.rh * 0.8, 'rgba(167,243,208,1)', 0.6, 2, 0.16)
    sparks(g.cx, g.groundY - 4, 24, -Math.PI / 2, 2.6, 160, 'rgba(167,243,208,1)', 1.8, 300)
  } else if (ev.e === 'crash') {
    fx.banner = { ok: false, speed: ev.speed, at: performance.now() }; fx.boomAt = performance.now(); fx.shake = 24; fx.flash = 1
    sparks(g.cx, g.groundY - 10, 150, -Math.PI / 2, 3.1, 520, 'rgba(255,190,90,1)', 2.8, 520, 1.5)
    sparks(g.cx, g.groundY - 10, 60, -Math.PI / 2, 3.1, 300, 'rgba(255,255,255,1)', 1.8, 420)
    for (let i = 0; i < 26; i++) debris.push({ x: g.cx + (Math.random() - 0.5) * 20, y: g.groundY - 12 - Math.random() * g.rh * 0.5, vx: (Math.random() - 0.5) * 620, vy: -160 - Math.random() * 520, rot: Math.random() * 7, spin: (Math.random() - 0.5) * 16, w: 4 + Math.random() * 12, h: 3 + Math.random() * 7, col: Math.random() < 0.6 ? '#cbd5e1' : '#334155', life: 2.6 + Math.random() })
    for (let i = 0; i < 40; i++) puff(g.cx + (Math.random() - 0.5) * 60, g.groundY - 8 - Math.random() * 40, (Math.random() - 0.5) * 260, -40 - Math.random() * 160, 9 + Math.random() * 14, 1.6 + Math.random() * 1.4, 60 + Math.random() * 50)
    ring(g.cx, g.groundY - 3, g.rh * 2.2, 'rgba(251,146,60,1)', 0.9, 4, 0.2)
  } else if (ev.e === 'launch') {
    fx.banner = null; fx.legs = 0; debris.length = 0; viewAlt = Math.max(viewAlt, 60)
  } else if (ev.e === 'shove') {
    const dir = Math.sign(ev.dv) < 0 ? 1 : -1 // screen y grows downward
    for (let i = 0; i < 22; i++) streaks.push({ x: g.cx + (Math.random() - 0.5) * g.rh * 1.6, y: g.feetY - g.rh * 0.5 - dir * (60 + Math.random() * 160), v: dir * (500 + Math.random() * 500), l: 40 + Math.random() * 90, life: 0.5 + Math.random() * 0.4 })
    fx.note = { text: ev.dv < 0 ? 'DOWNDRAFT' : 'UPDRAFT', until: performance.now() + 1100 }; fx.shake = Math.max(fx.shake, 5)
  } else if (ev.e === 'leak') { fx.leakUntil = performance.now() + 900; fx.shake = Math.max(fx.shake, 3) }
  else if (ev.e === 'flameout') { sparks(g.cx, g.feetY, 20, Math.PI / 2, 1.6, 160, 'rgba(148,163,184,1)', 2, 200); for (let i = 0; i < 10; i++) puff(g.cx, g.feetY + 6, (Math.random() - 0.5) * 60, 20 + Math.random() * 40, 6 + Math.random() * 6, 1 + Math.random(), 90) }
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
const pending = []
function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  if (!cur) return
  const g = draw(now, dt)
  if (fx.note && now < fx.note.until) { ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.font = `800 13px ${FONT}`; ctx.fillStyle = 'rgba(186,230,253,.95)'; ctx.textAlign = 'center'; ctx.fillText(fx.note.text, g.cx, Math.max(118, g.feetY - g.rh - 40)); ctx.restore() }
  for (let i = pending.length - 1; i >= 0; i--) if (now >= pending[i].at) { if (now - pending[i].at < 700 || pending[i].ev.e === 'launch') fire(pending[i].ev, cur, g); pending.splice(i, 1) }
}

// ---------------------------------------------------------------- wiring
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const esc = (t) => t.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))
function paintStateText(text) {
  $('stateText').innerHTML = text.split('\n').slice(1).map((l) => {
    l = esc(l)
    if (l.startsWith('ALT')) return `<span class="hl">${l}</span>`
    if (l.startsWith('engine: OUT')) return `<span class="bad">${l}</span>`
    if (l.startsWith('throttle')) return `<span class="ok">${l}</span>`
    return l
  }).join('\n')
}
function paintHistory(f) {
  const all = f.flights || []
  const max = Math.max(f.dials.safeSpeed * 2, ...all.map((r) => r.speed))
  $('hist').innerHTML = all.length ? all.map((r) => `<div class="bar${r.ok ? '' : ' crash'}" style="height:${Math.max(6, (r.speed / max) * 100)}%" title="${r.ok ? 'landed' : 'crashed'} at ${r.speed.toFixed(1)} per tick, ${Math.round(r.fuelLeft)} fuel left"></div>`).join('') : '<span class="empty">no flight finished yet</span>'
  $('histNote').textContent = all.length ? `touchdown speed · ${f.landed} soft, ${f.crashed} crashed` : 'touchdown speed per flight'
}

let paused = false
const FMT = { gravity: (v) => v.toFixed(2), fuel: (v) => String(Math.round(v)) }
function onFrame(f) {
  const now = performance.now()
  if (firstFrame) { lastEventId = Math.max(-1, ...(f.events || []).map((e) => e.id)); firstFrame = false; fx.fuelShown = f.fuel; viewAlt = clamp(f.y * 1.32 + 17, 30, 140) }
  if (cur && f.t < cur.t) lastEventId = -1
  if (f.phase === 'flight' && cur && cur.phase !== 'flight') fx.banner = null
  for (const ev of f.events || []) if (ev.id > lastEventId) { pending.push({ ev, at: now + (f.running && (ev.e === 'touchdown' || ev.e === 'crash') ? f.tickMs * 0.95 : 0) }); lastEventId = ev.id }
  cur = f; curAt = now
  paused = !f.running
  $('title').textContent = f.title
  $('s-alt').textContent = f.y.toFixed(1); $('s-vy').textContent = f.v.toFixed(1); $('s-landed').textContent = f.landed; $('s-crashed').textContent = f.crashed
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const ph = $('phase'); ph.textContent = f.phase === 'flight' ? 'IN FLIGHT' : f.phase === 'landed' ? 'LANDED' : 'CRASHED'; ph.className = 'right pill ' + (f.phase === 'crashed' ? 'bad' : f.phase === 'landed' ? 'ok' : 'warn')
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem); $('cfgError').textContent = problem ? `${problem} — still flying on the last good settings.` : ''
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
$('flameout').onclick = () => post({ cmd: 'flameout', ticks: 4 })
$('leak').onclick = () => post({ cmd: 'leak', share: 0.3 })
$('launch').onclick = () => post({ cmd: 'launch' })
for (const k of Object.keys(FMT)) $('d-' + k).oninput = (e) => { const v = Number(e.target.value); $('v-' + k).textContent = FMT[k](v); post({ cmd: 'set', key: k, value: v }) }
scene.addEventListener('click', (e) => {
  if (!cur) return
  const r = scene.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
  const g = geometry(cur, 1)
  if (mx > cssW - g.gaugeW) return
  const mid = g.feetY - g.rh * 0.5
  ring(mx, my, 24, 'rgba(186,230,253,1)', 0.4)
  post({ cmd: 'shove', dv: my > mid ? -3 : 3 })
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
