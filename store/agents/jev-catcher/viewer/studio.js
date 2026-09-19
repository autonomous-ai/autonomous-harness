// Jev Catcher pane — a ballpark at dusk. The server runs the field and streams one frame per Jev
// decision (about seven a second); this file renders at 60 fps and eases between frames. Pop flies
// climb into the lights and come down on a real arc, with a shadow that shrinks on the grass and a
// ring where each will land. The fielder runs, reaches, dives, or watches it bounce. Jev's mind is
// in the scene: five ghost gloves (one per option, brightness = probability) and a small bar chart
// that rides under the fielder.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap'), ctx = scene.getContext('2d')
const bg = document.createElement('canvas'), bctx = bg.getContext('2d')
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"
const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const GLYPH = { LEFT_FAST: '«', LEFT: '‹', HOLD: '•', RIGHT: '›', RIGHT_FAST: '»' }

let W = 0, H = 0, DPR = 1, bgDirty = true
let prev = null, next = null, nextAt = 0, lastSeq = -1, lastDraw = 0
let paused = false, windDir = 1, windNow = 0, runPhase = 0, facing = 1, gloveUp = 0
const balls = new Map() // id -> what the pane needs to fly one ball smoothly
const particles = [], popups = [], rings = [], streaks = [], bounces = [], flashes = []
const fx = { dive: 0, diveDir: 1, slump: 0, snap: 0, board: 0, boardBad: false, shake: 0 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
function rnd(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// ---------------------------------------------------------------- layout
function resize() {
  const r = wrap.getBoundingClientRect()
  DPR = Math.min(2, window.devicePixelRatio || 1)
  W = Math.max(320, Math.round(r.width)); H = Math.max(240, Math.round(r.height))
  scene.width = Math.round(W * DPR); scene.height = Math.round(H * DPR)
  bgDirty = true
}
function geo(f) {
  const slot = (W * 0.86) / f.fieldWidth, left = (W - slot * f.fieldWidth) / 2, s = H / 600
  return { slot, left, s, gy: H * 0.76, gloveH: 104 * s, plate: { x: W / 2, y: H * 1.04 }, wallTop: H * 0.3, wallBot: H * 0.395, grassTop: H * 0.43, px: (x) => left + x * slot }
}
/** Where a ball is at t (0 = off the bat, 1 = at glove height over its landing spot). */
function ballAt(g, land, t) {
  const gx = lerp(g.plate.x, g.px(land), t), gy = lerp(g.plate.y, g.gy, t)
  const u = Math.pow(clamp(t, 0, 1), 0.75), h = 4 * u * (1 - u) * H * 0.64 * lerp(1.05, 0.85, t) + g.gloveH * t
  return { gx, gy, x: gx, y: gy - h, h, r: lerp(8.5, 5.4, t) * clamp(g.s, 0.8, 1.3) }
}

// ---------------------------------------------------------------- the static backdrop
function paintBg() {
  bg.width = scene.width; bg.height = scene.height
  const g = bctx; g.setTransform(DPR, 0, 0, DPR, 0, 0)
  const wallTop = H * 0.3, wallBot = H * 0.395, grassTop = H * 0.43, r = rnd(57)
  // dusk sky
  let grd = g.createLinearGradient(0, 0, 0, wallTop)
  grd.addColorStop(0, '#070b22'); grd.addColorStop(0.45, '#231a4a'); grd.addColorStop(0.8, '#7a3b5e'); grd.addColorStop(1, '#e0794a')
  g.fillStyle = grd; g.fillRect(0, 0, W, wallTop + 2)
  for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(255,255,255,${0.12 + r() * 0.6})`; g.fillRect(r() * W, r() * wallTop * 0.55, 1.3, 1.3) }
  for (let i = 0; i < 5; i++) {
    const cx = r() * W, cy = wallTop * (0.35 + r() * 0.4), cw = 90 + r() * 160
    grd = g.createRadialGradient(cx, cy, 0, cx, cy, cw); grd.addColorStop(0, 'rgba(255,170,140,.16)'); grd.addColorStop(1, 'rgba(255,170,140,0)')
    g.fillStyle = grd; g.save(); g.translate(cx, cy); g.scale(1, 0.22); g.translate(-cx, -cy); g.fillRect(cx - cw, cy - cw, cw * 2, cw * 2); g.restore()
  }
  // the stands and the crowd
  const standTop = H * 0.17
  g.fillStyle = '#0d1020'; g.beginPath(); g.moveTo(0, standTop + H * 0.03); g.quadraticCurveTo(W / 2, standTop - H * 0.035, W, standTop + H * 0.03); g.lineTo(W, wallTop); g.lineTo(0, wallTop); g.closePath(); g.fill()
  g.save(); g.clip()
  for (let row = 0; row < 9; row++) {
    const y = standTop + 4 + row * ((wallTop - standTop) / 9)
    for (let x = r() * 6; x < W; x += 5 + r() * 3) {
      const c = r()
      g.fillStyle = c < 0.5 ? `rgba(${120 + r() * 120},${110 + r() * 100},${130 + r() * 110},${0.25 + r() * 0.4})` : c < 0.62 ? 'rgba(52,211,153,.55)' : c < 0.7 ? 'rgba(251,191,36,.5)' : 'rgba(20,24,40,.9)'
      g.fillRect(x, y + r() * 3 + Math.sin(x / W * Math.PI) * -H * 0.02, 2.4, 3)
    }
  }
  g.restore()
  grd = g.createLinearGradient(0, standTop, 0, wallTop); grd.addColorStop(0, 'rgba(7,8,16,.2)'); grd.addColorStop(1, 'rgba(7,8,16,.55)')
  g.fillStyle = grd; g.fillRect(0, standTop - H * 0.04, W, wallTop - standTop + H * 0.04)
  // light towers
  for (const tx of [W * 0.1, W * 0.9]) {
    g.fillStyle = '#0a0c16'; g.fillRect(tx - 3, H * 0.05, 6, wallTop - H * 0.05)
    g.fillStyle = '#141828'; g.beginPath(); g.roundRect(tx - 34, H * 0.025, 68, 30, 4); g.fill()
    for (let i = 0; i < 5; i++) for (let j = 0; j < 2; j++) { g.fillStyle = '#fff6d6'; g.shadowColor = '#ffe9a8'; g.shadowBlur = 16; g.fillRect(tx - 29 + i * 12, H * 0.025 + 5 + j * 12, 9, 8) }
    g.shadowBlur = 0
    g.save(); g.globalCompositeOperation = 'lighter'
    grd = g.createRadialGradient(tx, H * 0.05, 0, tx, H * 0.05, W * 0.3); grd.addColorStop(0, 'rgba(255,236,180,.42)'); grd.addColorStop(0.25, 'rgba(255,236,180,.12)'); grd.addColorStop(1, 'rgba(255,236,180,0)')
    g.fillStyle = grd; g.fillRect(tx - W * 0.3, 0, W * 0.6, H * 0.6)
    g.restore()
  }
  // outfield wall
  grd = g.createLinearGradient(0, wallTop, 0, wallBot); grd.addColorStop(0, '#0f3d2e'); grd.addColorStop(1, '#082219')
  g.fillStyle = grd; g.fillRect(0, wallTop, W, wallBot - wallTop)
  g.fillStyle = '#facc15'; g.fillRect(0, wallTop, W, 3)
  for (let x = 0; x < W; x += 64) { g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(x, wallTop + 3, 1.5, wallBot - wallTop - 3) }
  g.font = `800 ${Math.round((wallBot - wallTop) * 0.46)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,255,255,.2)'
  const ads = ['385', 'MADE-UP PARK', '400', 'ONE CALL', '385']
  ads.forEach((t, i) => g.fillText(t, W * (0.08 + i * 0.21), (wallTop + wallBot) / 2 + 2, W * 0.18))
  // warning track, then grass in mown wedges
  grd = g.createLinearGradient(0, wallBot, 0, grassTop); grd.addColorStop(0, '#3a2a1c'); grd.addColorStop(1, '#5a4029')
  g.fillStyle = grd; g.fillRect(0, wallBot, W, grassTop - wallBot)
  grd = g.createLinearGradient(0, grassTop, 0, H); grd.addColorStop(0, '#14532d'); grd.addColorStop(0.55, '#166534'); grd.addColorStop(1, '#0d3a20')
  g.fillStyle = grd; g.fillRect(0, grassTop, W, H - grassTop)
  g.save(); g.beginPath(); g.rect(0, grassTop, W, H - grassTop); g.clip()
  for (let i = -9; i < 9; i += 2) {
    g.fillStyle = 'rgba(190,255,170,.06)'
    g.beginPath(); g.moveTo(W / 2, H * 0.12); g.lineTo(W / 2 + i * W * 0.22, H + 100); g.lineTo(W / 2 + (i + 1) * W * 0.22, H + 100); g.closePath(); g.fill()
  }
  for (let i = 0; i < 900; i++) { const y = grassTop + r() * (H - grassTop); g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.14)' : 'rgba(190,255,170,.07)'; g.fillRect(r() * W, y, 1.4, 2 + (y - grassTop) / 70) }
  // the infield dirt at the near edge, where the flies come from
  grd = g.createRadialGradient(W / 2, H * 1.16, 0, W / 2, H * 1.16, W * 0.5); grd.addColorStop(0, '#7a5a3a'); grd.addColorStop(1, '#5d4329')
  g.fillStyle = grd; g.beginPath(); g.ellipse(W / 2, H * 1.16, W * 0.46, H * 0.27, 0, 0, 7); g.fill()
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 2; g.stroke()
  g.restore()
  // pools of floodlight, and a dark frame
  g.save(); g.globalCompositeOperation = 'lighter'
  for (const cx of [W * 0.3, W * 0.7]) {
    grd = g.createRadialGradient(cx, H * 0.72, 0, cx, H * 0.72, W * 0.42); grd.addColorStop(0, 'rgba(230,255,200,.10)'); grd.addColorStop(1, 'rgba(230,255,200,0)')
    g.fillStyle = grd; g.save(); g.translate(cx, H * 0.72); g.scale(1, 0.42); g.translate(-cx, -H * 0.72); g.fillRect(cx - W * 0.45, H * 0.72 - W * 0.45, W * 0.9, W * 0.9); g.restore()
  }
  g.restore()
  grd = g.createRadialGradient(W / 2, H * 0.55, H * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.75); grd.addColorStop(0, 'rgba(3,4,10,0)'); grd.addColorStop(1, 'rgba(3,4,10,.6)')
  g.fillStyle = grd; g.fillRect(0, 0, W, H)
  // the scoreboard frame (the numbers are drawn live)
  const b = board()
  g.fillStyle = '#05070d'; for (const lx of [b.x + b.w * 0.2, b.x + b.w * 0.8]) g.fillRect(lx - 4, b.y + b.h, 8, wallTop - b.y - b.h)
  g.fillStyle = '#0a0d18'; g.beginPath(); g.roundRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10); g.fill()
  g.strokeStyle = '#2a3350'; g.lineWidth = 2; g.stroke()
  g.fillStyle = '#04060b'; g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 6); g.fill()
  bgDirty = false
}
const board = () => ({ x: W * 0.5 - Math.min(W * 0.2, 230), y: H * 0.035, w: Math.min(W * 0.4, 460), h: H * 0.2 })

// ---------------------------------------------------------------- small helpers
function burst(x, y, n, colors, speed, life, grav = 520, up = 0.35) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.9)
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * up, life: life * (0.5 + Math.random() * 0.6), max: life, c: colors[(Math.random() * colors.length) | 0], r: 1 + Math.random() * 2.4, grav })
  }
}
function popup(x, y, text, color, size = 18) { popups.push({ x: clamp(x, 60, W - 60), y, text, color, size, t: 0 }) }

function gloveShape(x, y, r, alpha, tint, glow) {
  ctx.save(); ctx.globalAlpha = alpha
  if (glow) { ctx.shadowColor = tint; ctx.shadowBlur = 18 }
  ctx.fillStyle = tint
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 1.08, 0, 0, 7); ctx.fill()
  ctx.beginPath(); ctx.ellipse(x - r * 0.95, y + r * 0.1, r * 0.34, r * 0.6, -0.5, 0, 7); ctx.fill()
  ctx.shadowBlur = 0
  ctx.restore()
}
function drawGlove(x, y, r, squash) {
  ctx.save(); ctx.translate(x, y); ctx.scale(1 + squash * 0.25, 1 - squash * 0.2)
  let grd = ctx.createRadialGradient(-r * 0.3, -r * 0.4, 0, 0, 0, r * 1.2); grd.addColorStop(0, '#c98a4b'); grd.addColorStop(1, '#6b3f1d')
  ctx.fillStyle = grd; ctx.strokeStyle = '#2b1608'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.ellipse(-r * 0.95, r * 0.1, r * 0.34, r * 0.62, -0.5, 0, 7); ctx.fill(); ctx.stroke()
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 1.08, 0, 0, 7); ctx.fill(); ctx.stroke()
  ctx.fillStyle = 'rgba(40,20,8,.55)'; ctx.beginPath(); ctx.ellipse(0, r * 0.12, r * 0.52, r * 0.5, 0, 0, 7); ctx.fill()
  ctx.strokeStyle = 'rgba(43,22,8,.8)'; ctx.lineWidth = 1.2
  for (const a of [-0.9, -0.3, 0.3, 0.9]) { ctx.beginPath(); ctx.moveTo(Math.sin(a) * r * 0.5, -r * 0.45); ctx.lineTo(Math.sin(a) * r * 0.92, -Math.cos(a) * r * 1.02); ctx.stroke() }
  ctx.restore()
}

/** The fielder, drawn with the origin at the feet. `up` raises the glove overhead. */
function drawFielder(g, x, up, lean, speed, now) {
  const s = g.s, gy = g.gy
  const k = fx.dive > 0 ? Math.sin(Math.PI * clamp(1 - fx.dive, 0, 1)) : 0
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(x + fx.diveDir * k * 30 * s, gy + 4, (24 + k * 26) * s, 6 * s, 0, 0, 7); ctx.fill()
  ctx.save()
  ctx.translate(x, gy - 40 * s * (1 - k * 0.72)); ctx.rotate(fx.diveDir * k * 1.22 + lean * 0.16)
  const hip = 0, foot = 40 * s, sw = Math.sin(runPhase) * 11 * s * clamp(speed, 0, 1) * (1 - k)
  ctx.lineCap = 'round'
  // legs
  for (const side of [-1, 1]) {
    ctx.strokeStyle = '#0b0d14'; ctx.lineWidth = 9 * s; ctx.beginPath(); ctx.moveTo(side * 5 * s, hip); ctx.lineTo(side * 7 * s + side * sw, foot - 2 * s); ctx.stroke()
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 6.5 * s; ctx.beginPath(); ctx.moveTo(side * 5 * s, hip); ctx.lineTo(side * 7 * s + side * sw, foot - 5 * s); ctx.stroke()
    ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.ellipse(side * 7 * s + side * sw + facing * 3 * s, foot - 1 * s, 7 * s, 3.4 * s, 0, 0, 7); ctx.fill()
  }
  // jersey
  const slump = fx.slump * 5 * s
  let grd = ctx.createLinearGradient(-12 * s, 0, 12 * s, 0); grd.addColorStop(0, '#34d399'); grd.addColorStop(1, '#047857')
  ctx.fillStyle = grd; ctx.strokeStyle = '#05231a'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.roundRect(-12 * s, -30 * s + slump, 24 * s, 33 * s, 7 * s); ctx.fill(); ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = `800 ${Math.round(13 * s)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('J', 0, -13 * s + slump)
  // free arm
  ctx.strokeStyle = '#047857'; ctx.lineWidth = 6 * s; ctx.beginPath(); ctx.moveTo(-facing * 11 * s, -24 * s + slump); ctx.lineTo(-facing * 17 * s, -6 * s + slump + sw * 0.5); ctx.stroke()
  // head and cap
  ctx.fillStyle = '#e8b48a'; ctx.beginPath(); ctx.arc(0, -40 * s + slump * 1.6, 9 * s, 0, 7); ctx.fill()
  ctx.fillStyle = '#064e3b'; ctx.beginPath(); ctx.arc(0, -42 * s + slump * 1.6, 9.6 * s, Math.PI, 0); ctx.fill()
  ctx.beginPath(); ctx.ellipse(facing * 9 * s, -42 * s + slump * 1.6, 8 * s, 2.6 * s, 0, 0, 7); ctx.fill()
  // glove arm: the glove sits right over the fielder, which is the x Jev controls
  const gyy = lerp(-20 * s, -(g.gloveH - 40 * s), up) + slump * 2
  ctx.strokeStyle = '#047857'; ctx.lineWidth = 6.5 * s; ctx.beginPath(); ctx.moveTo(facing * 10 * s, -26 * s + slump); ctx.quadraticCurveTo(facing * 16 * s, lerp(-22 * s, -46 * s, up), 0, gyy + 8 * s); ctx.stroke()
  drawGlove(0, gyy, 13 * s, fx.snap)
  ctx.restore()
}

function drawBoard(f, now) {
  const b = board()
  ctx.save(); ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 6); ctx.clip()
  if (fx.board > 0.02) { ctx.fillStyle = fx.boardBad ? `rgba(251,113,133,${fx.board * 0.32})` : `rgba(52,211,153,${fx.board * 0.32})`; ctx.fillRect(b.x, b.y, b.w, b.h) }
  ctx.fillStyle = 'rgba(255,255,255,.035)'; for (let y = b.y; y < b.y + b.h; y += 3) ctx.fillRect(b.x, y, b.w, 1)
  const cols = [['CAUGHT', f.catches, '#34d399'], ['DROPS', f.drops, '#fb7185'], ['STREAK', f.streak, '#fde047']]
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  cols.forEach(([lab, val, col], i) => {
    const cx = b.x + b.w * (0.18 + i * 0.32)
    ctx.font = `700 ${Math.max(8, Math.round(b.h * 0.1))}px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText(lab, cx, b.y + b.h * 0.2)
    ctx.font = `800 ${Math.round(b.h * 0.44)}px ${FONT}`; ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.fillStyle = col
    ctx.fillText(String(val).padStart(2, '0'), cx, b.y + b.h * 0.66); ctx.shadowBlur = 0
  })
  ctx.font = `700 ${Math.max(8, Math.round(b.h * 0.095))}px ${FONT}`; ctx.fillStyle = '#fbbf24'
  const done = Math.min(f.next + 1, f.ballsTotal)
  ctx.fillText(`BALL ${f.finished ? f.ballsTotal : done}/${f.ballsTotal}  ·  FALL ${f.fallTicks} TICKS  ·  REACH ${Number(f.gloveReach).toFixed(1)}`, b.x + b.w / 2, b.y + b.h * 0.9)
  ctx.restore()
  // two small flags on the board show the wind
  const w = clamp(Math.abs(windNow) / 1.2, 0, 1)
  for (const fxp of [b.x + 8, b.x + b.w - 8]) {
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(fxp, b.y - 6); ctx.lineTo(fxp, b.y - 30); ctx.stroke()
    ctx.fillStyle = '#34d399'; ctx.beginPath()
    const L = 26
    for (let i = 0; i <= 8; i++) { const t = i / 8; ctx.lineTo(fxp + windDir * L * t * (0.25 + 0.75 * w), b.y - 30 + Math.sin(now * (0.006 + w * 0.012) - t * 5) * (1.5 + w * 5) * t + (1 - w) * L * 0.7 * t * t) }
    for (let i = 8; i >= 0; i--) { const t = i / 8; ctx.lineTo(fxp + windDir * L * t * (0.25 + 0.75 * w), b.y - 19 + Math.sin(now * (0.006 + w * 0.012) - t * 5) * (1.5 + w * 5) * t + (1 - w) * L * 0.75 * t * t) }
    ctx.closePath(); ctx.fill()
  }
}

function drawMind(g, f, glove, up) {
  let total = 0
  for (const m of MOVES) total += f.probs?.[m] ?? 0
  if (total <= 0) return
  const lo = 1, hi = f.fieldWidth - 1, s = g.s
  const gyy = g.gy - 40 * s + lerp(-20 * s, -(g.gloveH - 40 * s), up)
  const barW = clamp(g.slot * 0.34, 5, 12), base = g.gy + 52 * s, maxH = 26 * s
  ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  for (const m of MOVES) {
    const p = (f.probs[m] ?? 0) / total, x = g.px(clamp(glove + (f.nudge?.[m] ?? 0), lo, hi)), chosen = m === f.move
    const al = 0.1 + 0.8 * Math.sqrt(p)
    if (m !== 'HOLD' || chosen) gloveShape(x, gyy, 13 * s, al * (chosen ? 0.85 : 0.6), chosen ? '#34d399' : '#ffffff', chosen)
    ctx.strokeStyle = `rgba(255,255,255,${al * 0.3})`; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, g.gy + 8 * s); ctx.lineTo(x, base - maxH - 2); ctx.stroke(); ctx.setLineDash([])
    const h = Math.max(2, p * maxH)
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - barW / 2, base - maxH, barW, maxH)
    if (chosen) { ctx.shadowColor = '#34d399'; ctx.shadowBlur = 12 }
    ctx.fillStyle = chosen ? '#34d399' : 'rgba(226,232,240,.7)'; ctx.fillRect(x - barW / 2, base - h, barW, h); ctx.shadowBlur = 0
    ctx.fillStyle = chosen ? '#fff' : 'rgba(255,255,255,.5)'; ctx.fillText(GLYPH[m], x, base + 11)
  }
}

function drawBalls(g, f, now, glove) {
  const tick = Math.max(40, f.tickMs)
  const list = []
  for (const b of balls.values()) {
    const a = clamp((now - b.t0) / tick, 0, 1), k = lerp(b.k0, b.k1, a), land = lerp(b.land0, b.land1, a)
    const t = clamp(1 - k / b.total, 0, 1), p = ballAt(g, land, t)
    list.push({ b, a, t, land, p })
  }
  // landing rings and shadows go under everything
  for (const { b, t, land, p } of list) {
    const x = g.px(land), rx = Math.max(10, f.gloveReach * g.slot), primary = b.id === f.primary
    const col = b.extra ? '94,234,212' : '251,191,36', pulse = 0.5 + 0.5 * Math.sin(now * 0.008 + b.id)
    ctx.save(); ctx.translate(x, g.gy + 4); ctx.scale(1, 0.26)
    ctx.fillStyle = `rgba(${col},${0.07 + t * 0.12})`; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 7); ctx.fill()
    ctx.strokeStyle = `rgba(${col},${primary ? 0.9 : 0.5})`; ctx.lineWidth = primary ? 3 : 2; ctx.setLineDash([10, 7]); ctx.lineDashOffset = -now * 0.02
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, 7); ctx.stroke(); ctx.setLineDash([])
    ctx.strokeStyle = `rgba(${col},${0.5 * (1 - pulse)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, rx * (0.3 + 0.7 * pulse) * (1 - t * 0.5), 0, 7); ctx.stroke()
    ctx.restore()
    ctx.fillStyle = `rgba(${col},.9)`; ctx.beginPath(); ctx.moveTo(x - 5, g.gy + 4); ctx.lineTo(x, g.gy - 1); ctx.lineTo(x + 5, g.gy + 4); ctx.lineTo(x, g.gy + 9); ctx.closePath(); ctx.fill()
    const hk = clamp(p.h / (H * 0.6), 0, 1)
    ctx.fillStyle = `rgba(0,0,0,${0.42 - hk * 0.3})`; ctx.beginPath(); ctx.ellipse(p.gx, p.gy + 3, (7 + hk * 30) * clamp(g.s, 0.8, 1.3), (2.4 + hk * 8) * clamp(g.s, 0.8, 1.3), 0, 0, 7); ctx.fill()
  }
  return list
}
function drawBallBodies(g, f, list, now, glove) {
  for (const { b, a, t, p } of list) {
    b.trail.push({ x: p.x, y: p.y }); if (b.trail.length > 16) b.trail.shift()
    b.trail.forEach((q, i) => { ctx.fillStyle = `rgba(255,255,255,${(i / b.trail.length) * 0.32})`; ctx.beginPath(); ctx.arc(q.x, q.y, p.r * (0.3 + 0.6 * i / b.trail.length), 0, 7); ctx.fill() })
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(p.x, p.y + p.r); ctx.lineTo(p.gx, p.gy); ctx.stroke(); ctx.setLineDash([])
    ctx.shadowColor = 'rgba(255,245,210,.9)'; ctx.shadowBlur = 14
    const grd = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, 0, p.x, p.y, p.r); grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, '#cfd6e4')
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.1; const sp = now * 0.012 + b.id
    ctx.beginPath(); ctx.arc(p.x + Math.cos(sp) * p.r * 0.9, p.y + Math.sin(sp) * p.r * 0.9, p.r * 0.95, sp + 2.2, sp + 4.1); ctx.stroke()
    if (b.ending && a >= 1) { settle(g, f, b, p, glove); balls.delete(b.id) }
  }
}

function settle(g, f, b, p, glove) {
  const ev = b.ending, gx = g.px(glove), gyy = g.gy - g.gloveH
  if (ev.caught) {
    fx.snap = 1; fx.board = 1; fx.boardBad = false
    burst(gx, gyy, ev.dive ? 30 : 18, ['#ffffff', '#fde68a', '#34d399'], 230, 0.7)
    rings.push({ x: gx, y: gyy, t: 0, c: '52,211,153', size: 70 })
    if (ev.dive) {
      fx.dive = 1; fx.diveDir = Math.sign(ev.land - ev.glove) || ev.dir || facing
      for (let i = 0; i < 26; i++) particles.push({ x: gx + fx.diveDir * Math.random() * 60, y: g.gy + 2, vx: fx.diveDir * (40 + Math.random() * 160), vy: -60 - Math.random() * 160, life: 0.5 + Math.random() * 0.5, max: 1, c: Math.random() < 0.6 ? '#4ade80' : '#a16207', r: 1.5 + Math.random() * 2, grav: 600 })
      popup(gx, gyy - 34, 'DIVING CATCH!', '#fde047', 20)
    } else popup(gx, gyy - 30, ev.extra ? 'EXTRA OUT!' : 'OUT!', '#34d399', 22)
    if (ev.streak >= 3) popup(gx, gyy - 60, `${ev.streak} in a row`, '#a7f3d0', 12)
    for (let i = 0; i < 14; i++) flashes.push({ x: Math.random() * W, y: H * (0.18 + Math.random() * 0.11), t: -Math.random() * 0.5 })
  } else {
    fx.slump = 1; fx.board = 1; fx.boardBad = true; fx.shake = 0.6
    bounces.push({ x: p.x, y: p.y, vx: (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 50), vy: 120, r: p.r, floor: g.gy + 4, n: 0, life: 1.7 })
    popup(g.px(ev.land), g.gy - 40, 'DROPPED', '#fb7185', 20)
  }
}

function drawFx(g, dt) {
  for (let i = bounces.length - 1; i >= 0; i--) {
    const b = bounces[i]; b.life -= dt; b.vy += 1900 * dt; b.x += b.vx * dt; b.y += b.vy * dt
    if (b.y > b.floor) { b.y = b.floor; b.vy *= -0.48; b.vx *= 0.7; b.n++; burst(b.x, b.floor, b.n === 1 ? 18 : 7, ['#d6c3a0', '#a3e635', '#8b7355'], b.n === 1 ? 150 : 70, 0.6, 300, 0.6) }
    if (b.life <= 0) { bounces.splice(i, 1); continue }
    ctx.globalAlpha = clamp(b.life * 2, 0, 1)
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(b.x, b.floor + 3, 7, 2.4, 0, 0, 7); ctx.fill()
    ctx.fillStyle = '#f1f5f9'; ctx.beginPath(); ctx.arc(b.x, b.y - b.r, b.r, 0, 7); ctx.fill(); ctx.globalAlpha = 1
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt * 1.9
    if (r.t >= 1) { rings.splice(i, 1); continue }
    ctx.strokeStyle = `rgba(${r.c},${(1 - r.t) * 0.9})`; ctx.lineWidth = 3 * (1 - r.t) + 0.5
    ctx.save(); ctx.translate(r.x, r.y); if (r.flat) ctx.scale(1, 0.3); ctx.beginPath(); ctx.arc(0, 0, 6 + r.t * r.size, 0, 7); ctx.stroke(); ctx.restore()
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const q = flashes[i]; q.t += dt * 3
    if (q.t >= 1) { flashes.splice(i, 1); continue }
    if (q.t < 0) continue
    const al = Math.sin(q.t * Math.PI)
    ctx.fillStyle = `rgba(255,255,255,${al})`; ctx.shadowColor = '#fff'; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(q.x, q.y, 1.6 + al * 1.6, 0, 7); ctx.fill(); ctx.shadowBlur = 0
  }
  for (let i = streaks.length - 1; i >= 0; i--) {
    const s = streaks[i]; s.life -= dt; s.x += s.vx * dt
    if (s.life <= 0) { streaks.splice(i, 1); continue }
    const al = Math.min(1, s.life * 2.5) * 0.55, d = Math.sign(s.vx)
    const grd = ctx.createLinearGradient(s.x, 0, s.x - d * s.len, 0); grd.addColorStop(0, `rgba(255,255,255,${al})`); grd.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = grd; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - d * s.len, s.y); ctx.stroke()
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt
    if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue }
    p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.985
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.c; ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r)
  }
  ctx.globalAlpha = 1
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i]; p.t += dt
    if (p.t > 1.15) { popups.splice(i, 1); continue }
    const k = Math.min(1, p.t / 0.16), s = 0.5 + 0.5 * (1 - Math.pow(1 - k, 3)) + (k < 1 ? 0.25 * Math.sin(k * Math.PI) : 0)
    ctx.globalAlpha = clamp((1.15 - p.t) / 0.4, 0, 1)
    ctx.font = `800 ${Math.round(p.size * s)}px ${FONT}`
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(5,6,12,.85)'; ctx.strokeText(p.text, p.x, p.y - p.t * 56)
    ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y - p.t * 56)
  }
  ctx.globalAlpha = 1
}

function drawHud(g, f) {
  const y = H * 0.945, pad = 22
  ctx.textBaseline = 'alphabetic'
  if (!f.finished) {
    ctx.textAlign = 'left'; ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.65)'; ctx.fillText('JEV SAYS', pad, y - 12)
    ctx.font = `800 16px ${FONT}`; ctx.fillStyle = '#6ee7b7'; ctx.fillText(`${f.move} ${Math.round((f.conf || 0) * 100)}%`, pad, y + 6)
    const pr = f.air.find((b) => b.id === f.primary)
    if (pr) {
      ctx.textAlign = 'right'; ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.65)'
      ctx.fillText(`LANDS IN ${pr.ticks}${f.air.length > 1 ? `  ·  ${f.air.length} IN THE AIR` : ''}`, W - pad, y - 12)
      const n = Math.min(pr.total, 20), pw = 9
      for (let i = 0; i < n; i++) { ctx.fillStyle = i < Math.round((1 - pr.ticks / pr.total) * n) ? '#fbbf24' : 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.roundRect(W - pad - (n - i) * (pw + 3), y - 3, pw, 5, 2); ctx.fill() }
    }
  }
  ctx.textAlign = 'center'
  if (f.slowmo) { ctx.font = `800 11px ${FONT}`; ctx.fillStyle = 'rgba(94,234,212,.95)'; ctx.fillText('SLOW MOTION ×3', W / 2, H * 0.28) }
  if (paused) { ctx.font = `800 11px ${FONT}`; ctx.fillStyle = 'rgba(251,191,36,.95)'; ctx.fillText('PAUSED', W / 2, H * 0.28 + (f.slowmo ? 15 : 0)) }
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
function draw(now) {
  lastDraw = now
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now
  if (!next || W < 2) return
  if (bgDirty) paintBg()
  const f = next
  const from = prev && prev.episode === f.episode ? prev : f
  const a = clamp((now - nextAt) / Math.max(40, f.tickMs), 0, 1)
  const glove = lerp(from.glove, f.glove, a)
  const v = f.glove - from.glove
  if (Math.abs(v) > 0.01 && !paused) { facing = Math.sign(v); runPhase += dt * (9 + Math.abs(v) * 9) }
  const g = geo(f)
  const pr = f.air.find((b) => b.id === f.primary)
  const want = pr ? clamp(1.35 - (pr.ticks / pr.total) * 1.6, 0, 1) : 0
  gloveUp = lerp(gloveUp, Math.max(want, fx.snap), 1 - Math.pow(0.001, dt))
  for (const k of ['slump', 'snap', 'board', 'shake']) fx[k] = Math.max(0, fx[k] - dt * (k === 'snap' ? 4 : k === 'shake' ? 5 : 1.1))
  fx.dive = Math.max(0, fx.dive - dt * 1.35)
  windNow = lerp(windNow, f.gust, 1 - Math.pow(0.002, dt)); if (Math.abs(f.gust) > 0.05) windDir = Math.sign(f.gust)

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.save()
  if (fx.shake > 0.01) ctx.translate((Math.random() - 0.5) * fx.shake * 5, (Math.random() - 0.5) * fx.shake * 5)
  ctx.drawImage(bg, 0, 0, W, H)
  drawBoard(f, now)
  const list = drawBalls(g, f, now, glove)
  if (!f.finished) drawMind(g, f, glove, gloveUp)
  drawFielder(g, g.px(glove), gloveUp, clamp(v / 1.2, -1, 1) * (paused ? 0 : 1), Math.abs(v) / 0.6, now)
  drawBallBodies(g, f, list, now, glove)
  drawFx(g, dt)
  ctx.restore()
  drawHud(g, f)
  if (f.finished) $('banner').querySelector('small').textContent = `next session in ${(Math.max(0, f.finished.leftMs - (now - nextAt)) / 1000).toFixed(1)} s`
}
function loop(now) { requestAnimationFrame(loop); draw(now) }

// ---------------------------------------------------------------- frames and events from the server
function onFrame(f) {
  const now = performance.now(), fresh = lastSeq < 0
  if (next && next.episode !== f.episode) { prev = null; for (const [id, b] of balls) if (!b.ending) balls.delete(id) } else prev = next
  next = f; nextAt = now
  const g = geo(f), seen = new Set()
  for (const b of f.air) {
    seen.add(b.id)
    const cur = balls.get(b.id)
    if (cur) Object.assign(cur, { k0: cur.k1, k1: b.ticks, land0: cur.land1, land1: b.land, t0: now })
    else balls.set(b.id, { id: b.id, total: b.total, extra: b.extra, k0: fresh ? b.ticks : Math.min(b.total, b.ticks + 0), k1: b.ticks, land0: b.land, land1: b.land, t0: now, trail: [], ending: null })
  }
  for (const ev of f.events || []) {
    if (ev.seq <= lastSeq) continue
    lastSeq = ev.seq
    if (fresh) continue // a pane that opens late does not replay old plays
    if (ev.e === 'catch' || ev.e === 'drop') {
      const cur = balls.get(ev.id)
      if (cur) { Object.assign(cur, { k0: cur.k1, k1: 0, land0: cur.land1, land1: ev.land, t0: now, ending: ev }); seen.add(ev.id) }
    } else if (ev.e === 'launch') {
      burst(g.plate.x, H - 4, 12, ['#ffffff', '#fde68a'], 160, 0.4, 300, 1)
      if (ev.extra) { rings.push({ x: g.px(ev.land), y: g.gy + 4, t: 0, c: '94,234,212', size: 80, flat: true }); popup(g.px(ev.land), g.gy - 20, 'EXTRA FLY', '#5eead4', 14) }
    } else if (ev.e === 'gust') {
      const dir = Math.sign(ev.v) || 1
      for (let i = 0; i < 36; i++) streaks.push({ x: dir > 0 ? -Math.random() * W * 0.6 : W + Math.random() * W * 0.6, y: H * (0.04 + Math.random() * 0.8), vx: dir * (900 + Math.random() * 900), len: 50 + Math.random() * 130, life: 0.7 + Math.random() * 0.8 })
      popup(W / 2, H * 0.34, dir > 0 ? 'GUST  →→→' : '←←←  GUST', '#a7f3d0', 17)
    }
  }
  if (fresh && lastSeq < 0) lastSeq = 0
  for (const [id, b] of balls) if (!seen.has(id) && !b.ending) balls.delete(id)

  paused = !f.running
  $('title').textContent = f.title
  $('s-ball').textContent = `${f.finished ? f.ballsTotal : Math.min(f.next + 1, f.ballsTotal)}/${f.ballsTotal}`
  $('s-caught').textContent = f.catches; $('s-drops').textContent = f.drops
  $('s-rate').textContent = f.recentN ? Math.round(f.recentRate * 100) + '%' : '—'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  $('slowmo').classList.toggle('on', !!f.slowmo)
  $('pick').textContent = f.move
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still running on the last good field.` : ''
  for (const [id, key, val, dp] of [['d-fall', 'fallTicks', 'v-fall', 0], ['d-reach', 'gloveReach', 'v-reach', 2]]) {
    if (document.activeElement !== $(id)) $(id).value = f[key]
    $(val).textContent = Number(f[key]).toFixed(dp)
    $(id).parentElement.classList.toggle('over', !!f.overrides && key in f.overrides)
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const lines = String(f.stateText || '').split('\n').slice(1)
  $('stateText').innerHTML = lines.map((l, i) => (i === 1 ? `<span class="hl">${esc(l)}</span>` : i === lines.length - 1 ? `<span class="q">${esc(l)}</span>` : esc(l))).join('\n')
  const banner = $('banner')
  if (f.finished) {
    banner.className = 'banner ' + (f.finished.ok ? 'ok' : 'bad')
    const head = f.finished.ok ? `CLEAN SESSION · ${f.finished.caught} of ${f.finished.caught} caught` : `${f.finished.caught} caught · ${f.finished.dropped} dropped`
    if (banner.dataset.head !== head) { banner.dataset.head = head; banner.innerHTML = `${esc(head)}<small></small>` }
  } else { banner.className = 'banner hidden'; banner.dataset.head = '' }
  const log = $('log'), sig = (f.log || []).map((s) => s.id).join(',')
  if (log.dataset.sig !== sig) {
    log.dataset.sig = sig
    log.innerHTML = (f.log || []).slice().reverse().map((s) => `<li class="${s.caught ? 'hit' : 'miss'}"><span class="n">#${s.id}</span><b>${s.caught ? (s.dive ? 'diving catch' : 'caught') : 'dropped'}${s.extra ? ' (extra)' : ''}</b><span class="pts">fall ${s.fall}</span><span class="off">gap ${s.gap.toFixed(1)}</span></li>`).join('')
  }
}

// ---------------------------------------------------------------- wiring
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('gust').onclick = () => post({ cmd: 'gust' })
$('slowmo').onclick = () => post({ cmd: 'slowmo' })
$('d-fall').oninput = (e) => { $('v-fall').textContent = String(Math.round(Number(e.target.value))); post({ cmd: 'set', key: 'fallTicks', value: Number(e.target.value) }) }
$('d-reach').oninput = (e) => { $('v-reach').textContent = Number(e.target.value).toFixed(2); post({ cmd: 'set', key: 'gloveReach', value: Number(e.target.value) }) }
scene.addEventListener('click', (e) => {
  if (!next) return
  const r = scene.getBoundingClientRect(), g = geo(next)
  const x = ((e.clientX - r.left) / r.width) * W
  post({ cmd: 'drop', x: clamp((x - g.left) / g.slot, 1, next.fieldWidth - 1) })
})

async function pollJev() {
  try {
    const s = await (await fetch('/jev', { cache: 'no-store' })).json()
    $('s-dps').textContent = s.callsPerSec.toFixed(1); $('s-cost').textContent = fmtMoney(s.costUsd); $('s-dec').textContent = s.calls.toLocaleString()
  } catch { /* the server is restarting */ }
  setTimeout(pollJev, 400)
}

resize()
new ResizeObserver(resize).observe(wrap)
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
pollJev()
requestAnimationFrame(loop)
// A hidden tab gets no animation frames. Keep the picture fresh anyway so it is never blank.
setInterval(() => { if (performance.now() - lastDraw > 400) draw(performance.now()) }, 250)
