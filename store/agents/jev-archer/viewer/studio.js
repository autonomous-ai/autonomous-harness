// Jev Archer pane — an archery range at dusk. The server runs the range and streams one frame per
// Jev decision (about seven a second); this file renders at 60 fps and eases between frames. A bow
// draws in the foreground, the arrow really flies to the straw wall and sticks where it lands, and
// Jev's mind is drawn into the scene: five ghost aims (one per option, brightness = probability),
// a cone whose width is the uncertainty, and a small histogram that rides under the aim.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap'), ctx = scene.getContext('2d')
const bg = document.createElement('canvas'), bctx = bg.getContext('2d')
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"
const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const GLYPH = { LEFT_FAST: '«', LEFT: '‹', HOLD: '•', RIGHT: '›', RIGHT_FAST: '»' }
const BANDS = ['#ef4444', '#38bdf8', '#1f2937', '#f1f5f9'] // inside out, around the gold
const POINT_COLOR = { 10: '#fde047', 8: '#fca5a5', 6: '#7dd3fc', 4: '#cbd5e1', 2: '#f1f5f9', 0: '#fb7185' }

let W = 0, H = 0, DPR = 1, bgDirty = true
let prev = null, next = null, nextAt = 0, lastSeq = -1, lastDraw = 0
let paused = false, windDir = 1, windNow = 0, bowState = null
const particles = [], popups = [], rings = [], flights = [], streaks = []
const fx = { wobble: 0, twang: 0, shake: 0, flash: 0, nockAt: -1e9 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
function rnd(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const hash = (n) => rnd(n * 7919 + 13)()

// ---------------------------------------------------------------- layout
function resize() {
  const r = wrap.getBoundingClientRect()
  DPR = Math.min(2, window.devicePixelRatio || 1)
  W = Math.max(320, Math.round(r.width)); H = Math.max(240, Math.round(r.height))
  scene.width = Math.round(W * DPR); scene.height = Math.round(H * DPR)
  bgDirty = true
}
function geo(f) {
  const wallTop = H * 0.17, railY = H * 0.66, cy = H * 0.415
  const slot = Math.min((W * 0.86) / f.targetWidth, (H * 0.215) / f.faceR)
  const left = (W - slot * f.targetWidth) / 2
  const Lw = Math.min(H * 0.13, W * 0.12)
  return { wallTop, railY, cy, slot, left, right: left + slot * f.targetWidth, R: f.faceR * slot, rG: f.bullHalf * slot, Lw, AL: Lw * 1.35, by: H * 0.885, px: (x) => left + x * slot }
}

// ---------------------------------------------------------------- the static backdrop
function paintBg() {
  bg.width = scene.width; bg.height = scene.height
  const g = bctx; g.setTransform(DPR, 0, 0, DPR, 0, 0)
  const wallTop = H * 0.17, railY = H * 0.66, r = rnd(91)
  // dusk sky above the wall
  let grd = g.createLinearGradient(0, 0, 0, wallTop + 10)
  grd.addColorStop(0, '#090d24'); grd.addColorStop(0.55, '#2a1d4a'); grd.addColorStop(1, '#c2573a')
  g.fillStyle = grd; g.fillRect(0, 0, W, wallTop + 10)
  for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.6})`; g.fillRect(r() * W, r() * wallTop * 0.62, 1.3, 1.3) }
  grd = g.createRadialGradient(W * 0.22, wallTop + 6, 0, W * 0.22, wallTop + 6, W * 0.4)
  grd.addColorStop(0, 'rgba(255,176,96,.6)'); grd.addColorStop(1, 'rgba(255,176,96,0)')
  g.fillStyle = grd; g.fillRect(0, 0, W, wallTop + 10)
  // trees peeking over the wall
  for (let layer = 0; layer < 2; layer++) {
    g.fillStyle = layer ? '#0b1020' : '#1a1838'
    for (let x = -20; x < W + 20; x += 26 + r() * 22) {
      const h = H * (0.03 + r() * 0.06) * (layer ? 0.8 : 1.15), w = 18 + r() * 20
      g.beginPath(); g.moveTo(x - w, wallTop + 4); g.quadraticCurveTo(x - w * 0.5, wallTop - h * 0.7, x, wallTop - h); g.quadraticCurveTo(x + w * 0.5, wallTop - h * 0.7, x + w, wallTop + 4); g.fill()
    }
  }
  // the straw wall: rows of bales, brick-laid
  const rows = 6, bh = (railY - wallTop) / rows, bw = bh * 2.2
  for (let row = 0; row < rows; row++) {
    for (let x = -bw * (row % 2 ? 0.5 : 0); x < W; x += bw) {
      const y = wallTop + row * bh
      g.fillStyle = `hsl(${37 + r() * 7} ${40 + r() * 12}% ${21 + r() * 8}%)`
      g.beginPath(); g.roundRect(x + 1, y + 1, bw - 2, bh - 2, 5); g.fill()
      for (let k = 0; k < 16; k++) {
        const sx = x + 4 + r() * (bw - 8), sy = y + 3 + r() * (bh - 6), sl = 6 + r() * 16
        g.strokeStyle = r() < 0.5 ? 'rgba(255,222,150,.13)' : 'rgba(0,0,0,.16)'; g.lineWidth = 1
        g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + sl, sy + (r() - 0.5) * 3); g.stroke()
      }
      g.strokeStyle = 'rgba(40,24,6,.55)'; g.lineWidth = 1.5
      for (const t of [0.3, 0.7]) { g.beginPath(); g.moveTo(x + bw * t, y + 2); g.lineTo(x + bw * t, y + bh - 2); g.stroke() }
      g.fillStyle = 'rgba(255,230,170,.07)'; g.fillRect(x + 3, y + 2, bw - 6, 2)
      g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(x + 3, y + bh - 4, bw - 6, 3)
    }
  }
  grd = g.createLinearGradient(0, wallTop, 0, railY); grd.addColorStop(0, 'rgba(5,6,16,.62)'); grd.addColorStop(0.45, 'rgba(5,6,16,.18)'); grd.addColorStop(1, 'rgba(5,6,16,.5)')
  g.fillStyle = grd; g.fillRect(0, wallTop, W, railY - wallTop)
  grd = g.createLinearGradient(0, 0, W, 0); grd.addColorStop(0, 'rgba(5,6,16,.55)'); grd.addColorStop(0.22, 'rgba(5,6,16,0)'); grd.addColorStop(0.78, 'rgba(5,6,16,0)'); grd.addColorStop(1, 'rgba(5,6,16,.55)')
  g.fillStyle = grd; g.fillRect(0, wallTop, W, railY - wallTop)
  // the grass, with mown lanes running to a vanishing point behind the wall
  grd = g.createLinearGradient(0, railY, 0, H); grd.addColorStop(0, '#1c3b2b'); grd.addColorStop(1, '#0c2016')
  g.fillStyle = grd; g.fillRect(0, railY, W, H - railY)
  g.save(); g.beginPath(); g.rect(0, railY, W, H - railY); g.clip()
  const vpY = H * 0.3, lane = W * 0.16
  for (let i = -7; i < 7; i += 2) {
    g.fillStyle = 'rgba(190,255,200,.045)'
    g.beginPath(); g.moveTo(W / 2, vpY); g.lineTo(W / 2 + i * lane * 3, H + 200); g.lineTo(W / 2 + (i + 1) * lane * 3, H + 200); g.closePath(); g.fill()
  }
  for (let k = 1; k <= 7; k++) { const y = railY + (H - railY) * Math.pow(k / 7, 1.8); g.fillStyle = 'rgba(255,255,255,.035)'; g.fillRect(0, y, W, 1) }
  for (let i = 0; i < 500; i++) { const y = railY + r() * (H - railY); g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.18)' : 'rgba(170,255,190,.06)'; g.fillRect(r() * W, y, 1.5, 2 + (y - railY) / 60) }
  grd = g.createLinearGradient(0, railY, 0, railY + 34); grd.addColorStop(0, 'rgba(0,0,0,.6)'); grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd; g.fillRect(0, railY, W, 34)
  g.restore()
  // the shooting line
  g.fillStyle = 'rgba(255,255,255,.34)'; g.fillRect(0, H * 0.9, W, 3)
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, H * 0.9 + 3, W, 2)
  // floodlight poles
  for (const side of [0, 1]) {
    const x = side ? W - 16 : 16
    g.fillStyle = '#0a0c14'; g.fillRect(x - 3, H * 0.02, 6, railY - H * 0.02 + 8)
    g.fillStyle = '#1b2030'; g.beginPath(); g.roundRect(x - 13, H * 0.02 - 4, 26, 12, 3); g.fill()
    g.fillStyle = '#fff3c4'; g.shadowColor = '#ffd98a'; g.shadowBlur = 22; g.fillRect(x - 10, H * 0.02 + 5, 20, 4); g.shadowBlur = 0
    g.save(); g.globalCompositeOperation = 'lighter'; g.filter = 'blur(22px)'
    grd = g.createRadialGradient(x, H * 0.04, 0, x, H * 0.04, W * 0.55); grd.addColorStop(0, 'rgba(255,214,140,.2)'); grd.addColorStop(1, 'rgba(255,214,140,0)')
    g.fillStyle = grd; g.beginPath(); g.moveTo(x, H * 0.03); g.lineTo(side ? W * 0.25 : W * 0.75, railY); g.lineTo(side ? W * 0.6 : W * 0.4, railY); g.closePath(); g.fill()
    g.restore()
  }
  bgDirty = false
}

// ---------------------------------------------------------------- small helpers
function burst(x, y, n, colors, speed, life, grav = 520) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.9)
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.35, life: life * (0.5 + Math.random() * 0.6), max: life, c: colors[(Math.random() * colors.length) | 0], r: 1 + Math.random() * 2.2, grav })
  }
}
function popup(x, y, text, color, size = 18) { popups.push({ x, y, text, color, size, t: 0 }) }

/** Where an arrow sits once it has landed. x is honest; y stays inside the ring the arrow scored. */
function landing(a, g, f) {
  const dist = Math.abs(a.off)
  if (dist > f.faceR) return { onFace: false, x: g.px(a.x), y: g.cy + (hash(a.n + 5) - 0.5) * g.R * 1.3 }
  const x = a.off * g.slot
  let r1 = g.rG
  if (!a.hit) { const band = Math.min(3, Math.floor(((dist - f.bullHalf) / Math.max(0.01, f.faceR - f.bullHalf)) * 4)); r1 = g.rG + (g.R - g.rG) * ((band + 1) / 4) }
  const room = Math.sqrt(Math.max(0, r1 * r1 - x * x)) * 0.85
  return { onFace: true, x, y: (hash(a.n + 11) < 0.5 ? -1 : 1) * (0.15 + 0.85 * hash(a.n + 3)) * room }
}

function drawStuck(x, y, n, scale, alpha = 1) {
  const dx = (hash(n + 21) - 0.5) * 12 * scale, dy = (11 + hash(n + 22) * 8) * scale
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3 * scale; ctx.beginPath(); ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + dx + 6, y + dy + 4); ctx.stroke()
  ctx.fillStyle = '#05060a'; ctx.beginPath(); ctx.arc(x, y, 2.2 * scale, 0, 7); ctx.fill()
  ctx.strokeStyle = '#1e2433'; ctx.lineWidth = 2.6 * scale; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.stroke()
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 0.8 * scale; ctx.beginPath(); ctx.moveTo(x - 0.6, y); ctx.lineTo(x + dx - 0.6, y + dy); ctx.stroke()
  const ang = Math.atan2(dy, dx)
  for (const [s, c] of [[-1, '#f472b6'], [1, '#fde68a'], [0, '#f472b6']]) {
    const ex = x + dx, ey = y + dy, bx = x + dx * 0.55, by = y + dy * 0.55
    const ox = Math.cos(ang + Math.PI / 2) * 5 * scale * s, oy = Math.sin(ang + Math.PI / 2) * 5 * scale * s - (s === 0 ? 4 * scale : 0)
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex + ox, ey + oy); ctx.lineTo(ex, ey); ctx.closePath(); ctx.fill()
  }
  ctx.restore()
}

// ---------------------------------------------------------------- scene pieces
function drawRail(g, f) {
  const { railY, left, right, px } = g
  ctx.fillStyle = '#05070c'; ctx.fillRect(left - 22, railY - 3, right - left + 44, 8)
  const grd = ctx.createLinearGradient(0, railY - 3, 0, railY + 3); grd.addColorStop(0, '#9aa6bd'); grd.addColorStop(1, '#3a4358')
  ctx.fillStyle = grd; ctx.fillRect(left - 22, railY - 3, right - left + 44, 4)
  for (const x of [left - 22, right + 16]) { ctx.fillStyle = '#ef4444'; ctx.fillRect(x, railY - 10, 6, 14) }
  ctx.font = `600 9px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  const every = f.targetWidth > 40 ? 10 : f.targetWidth > 16 ? 4 : 2
  for (let i = 0; i <= f.targetWidth; i++) {
    const x = px(i), major = i % every === 0
    ctx.fillStyle = major ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.2)'; ctx.fillRect(x - 0.5, railY + 5, 1, major ? 6 : 3)
    if (major) { ctx.fillStyle = 'rgba(255,255,255,.34)'; ctx.fillText(String(i), x, railY + 12) }
  }
}

function drawTarget(g, f, tx, now, flying) {
  const { cy, R, rG, railY } = g
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  let grd = ctx.createRadialGradient(tx, cy, R * 0.3, tx, cy, R * 3); grd.addColorStop(0, 'rgba(255,214,150,.22)'); grd.addColorStop(1, 'rgba(255,214,150,0)')
  ctx.fillStyle = grd; ctx.fillRect(tx - R * 3, g.wallTop, R * 6, railY - g.wallTop)
  grd = ctx.createRadialGradient(tx, railY + 26, 0, tx, railY + 26, R * 2.2); grd.addColorStop(0, 'rgba(200,255,190,.10)'); grd.addColorStop(1, 'rgba(200,255,190,0)')
  ctx.fillStyle = grd; ctx.save(); ctx.translate(tx, railY + 26); ctx.scale(1, 0.3); ctx.translate(-tx, -(railY + 26)); ctx.fillRect(tx - R * 2.5, railY - R * 3, R * 5, R * 8); ctx.restore()
  ctx.restore()
  // shadow on the straw, stand, carriage
  ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.beginPath(); ctx.arc(tx + R * 0.09, cy + R * 0.11, R * 1.02, 0, 7); ctx.fill()
  ctx.strokeStyle = '#3b2a18'; ctx.lineWidth = Math.max(4, R * 0.07); ctx.lineCap = 'round'
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(tx + s * R * 0.35, cy + R * 0.7); ctx.lineTo(tx + s * R * 0.62, railY - 8); ctx.stroke() }
  ctx.strokeStyle = '#5a4126'; ctx.lineWidth = Math.max(2, R * 0.03)
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(tx + s * R * 0.35, cy + R * 0.7); ctx.lineTo(tx + s * R * 0.62, railY - 8); ctx.stroke() }
  const cw = R * 1.6
  ctx.fillStyle = '#141826'; ctx.beginPath(); ctx.roundRect(tx - cw / 2, railY - 13, cw, 11, 4); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(tx - cw / 2 + 4, railY - 12, cw - 8, 1.5)
  for (const s of [-1, 1]) { ctx.fillStyle = '#05070c'; ctx.beginPath(); ctx.arc(tx + s * cw * 0.34, railY - 2, 5, 0, 7); ctx.fill(); ctx.fillStyle = '#7a859c'; ctx.beginPath(); ctx.arc(tx + s * cw * 0.34, railY - 2, 2, 0, 7); ctx.fill() }
  // which way it is sliding
  const v = next ? next.dir : 1
  ctx.fillStyle = 'rgba(255,255,255,.55)'
  for (let k = 0; k < 2; k++) { const x = tx + v * (cw / 2 + 8 + k * 8); ctx.beginPath(); ctx.moveTo(x + v * 6, railY - 7); ctx.lineTo(x, railY - 12); ctx.lineTo(x, railY - 2); ctx.closePath(); ctx.globalAlpha = 0.7 - k * 0.35; ctx.fill() }
  ctx.globalAlpha = 1
  // the face
  ctx.save(); ctx.translate(tx, cy); ctx.rotate(fx.wobble * Math.sin(now * 0.05) * 0.07)
  ctx.fillStyle = '#c9a24a'; ctx.beginPath(); ctx.arc(0, 0, R + 5, 0, 7); ctx.fill()
  ctx.strokeStyle = '#6b4f1d'; ctx.lineWidth = 2; ctx.stroke()
  for (let i = 3; i >= 0; i--) {
    const r1 = rG + (R - rG) * ((i + 1) / 4), r0 = rG + (R - rG) * (i / 4)
    ctx.fillStyle = BANDS[i]; ctx.beginPath(); ctx.arc(0, 0, r1, 0, 7); ctx.fill()
    ctx.strokeStyle = i === 2 ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.35)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(0, 0, (r0 + r1) / 2, 0, 7); ctx.stroke()
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(0, 0, r1, 0, 7); ctx.stroke()
  }
  if (fx.flash > 0.02) { ctx.shadowColor = '#fde047'; ctx.shadowBlur = 40 * fx.flash }
  grd = ctx.createRadialGradient(-rG * 0.3, -rG * 0.3, 0, 0, 0, rG); grd.addColorStop(0, '#fff7b0'); grd.addColorStop(0.6, '#facc15'); grd.addColorStop(1, '#ca8a04')
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(0, 0, rG, 0, 7); ctx.fill(); ctx.shadowBlur = 0
  ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, rG, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, rG * 0.5, 0, 7); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(3, 0); ctx.moveTo(0, -3); ctx.lineTo(0, 3); ctx.stroke()
  grd = ctx.createLinearGradient(-R, -R, R, R); grd.addColorStop(0, 'rgba(255,255,255,.16)'); grd.addColorStop(0.5, 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(0,0,0,.28)')
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill()
  for (const a of f.arrows) {
    if (flying.has(a.n)) continue
    const l = landing(a, g, f)
    if (l.onFace) drawStuck(l.x, l.y, a.n, clamp(R / 95, 0.6, 1.15))
  }
  ctx.restore()
}

function drawFlagAndBunting(g, now) {
  const w = clamp(Math.abs(windNow) / 1.4, 0, 1), sway = windDir * w
  // bunting between the light poles
  const y0 = H * 0.04, sag = H * 0.06, n = Math.max(10, Math.round(W / 46))
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.beginPath()
  for (let i = 0; i <= n; i++) { const t = i / n, x = lerp(18, W - 18, t), y = y0 + sag * 4 * t * (1 - t); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) }
  ctx.stroke()
  for (let i = 1; i < n; i++) {
    const t = i / n, x = lerp(18, W - 18, t), y = y0 + sag * 4 * t * (1 - t)
    const rot = sway * 0.9 + Math.sin(now * 0.0021 + i * 1.3) * (0.06 + w * 0.22)
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot)
    ctx.fillStyle = ['#f472b6', '#fde047', '#5eead4', '#a78bfa'][i % 4]; ctx.globalAlpha = 0.8
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.lineTo(0, 13); ctx.closePath(); ctx.fill(); ctx.restore()
  }
  // the wind flag
  const px0 = W * 0.36, top = H * 0.045, base = g.wallTop + 6, L = Math.min(70, W * 0.07)
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(px0, base); ctx.lineTo(px0, top - 4); ctx.stroke()
  ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(px0, top - 6, 3, 0, 7); ctx.fill()
  const seg = 12, up = [], dn = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const x = px0 + windDir * L * t * (0.22 + 0.78 * w)
    const wave = Math.sin(now * (0.006 + w * 0.012) - t * 5) * (2 + w * 7) * t
    const droop = (1 - w) * L * 0.85 * t * t
    up.push([x, top + wave + droop]); dn.push([x, top + 22 * (1 - t * 0.15) + wave * 1.1 + droop * 1.08])
  }
  const grd = ctx.createLinearGradient(px0, 0, px0 + windDir * L, 0); grd.addColorStop(0, '#fb7185'); grd.addColorStop(1, '#be123c')
  ctx.fillStyle = grd; ctx.beginPath(); up.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); dn.reverse().forEach(([x, y]) => ctx.lineTo(x, y)); ctx.closePath(); ctx.fill()
  ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = w > 0.05 ? '#fecdd3' : 'rgba(255,255,255,.45)'
  ctx.fillText(w > 0.05 ? `WIND ${windDir > 0 ? '→' : '←'} ${Math.abs(windNow).toFixed(1)}` : 'WIND calm', px0, base + 14)
}

function drawMind(g, f, aim, tip) {
  const { cy, railY, slot, px } = g
  const nudge = f.nudge || {}, lo = 1, hi = f.targetWidth - 1
  let mean = 0, varc = 0, total = 0
  for (const m of MOVES) { const p = f.probs?.[m] ?? 0; total += p; mean += p * (nudge[m] ?? 0) }
  if (total <= 0) return
  mean /= total
  for (const m of MOVES) varc += ((f.probs[m] ?? 0) / total) * ((nudge[m] ?? 0) - mean) ** 2
  const sd = Math.max(0.3, Math.sqrt(varc))
  // the cone: from the arrow tip to the wall, as wide as Jev is unsure
  const cx = px(clamp(aim + mean, lo, hi)), hw = sd * slot
  const grd = ctx.createLinearGradient(tip.x, tip.y, cx, cy); grd.addColorStop(0, 'rgba(244,114,182,.02)'); grd.addColorStop(1, 'rgba(244,114,182,.26)')
  ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(cx - hw, cy); ctx.lineTo(cx + hw, cy); ctx.closePath(); ctx.fill()
  ctx.strokeStyle = 'rgba(244,114,182,.4)'; ctx.lineWidth = 1; ctx.setLineDash([5, 6])
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(cx - hw, cy); ctx.moveTo(tip.x, tip.y); ctx.lineTo(cx + hw, cy); ctx.stroke(); ctx.setLineDash([])
  // ghost aims: one ring per option, as bright as its probability
  const rr = clamp(slot * 0.34, 7, 13), barW = clamp(slot * 0.36, 5, 13), base = railY + 50, maxH = 28
  ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  for (const m of MOVES) {
    const p = (f.probs[m] ?? 0) / total, x = px(clamp(aim + (nudge[m] ?? 0), lo, hi)), chosen = m === f.move
    const al = 0.14 + 0.86 * Math.sqrt(p)
    ctx.strokeStyle = `rgba(255,255,255,${al * 0.4})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, cy + rr); ctx.lineTo(x, base - maxH - 2); ctx.stroke()
    ctx.lineWidth = 5; ctx.strokeStyle = `rgba(5,6,12,${al * 0.7})`; ctx.beginPath(); ctx.arc(x, cy, rr, 0, 7); ctx.stroke()
    if (chosen) { ctx.shadowColor = '#f472b6'; ctx.shadowBlur = 20 }
    ctx.fillStyle = chosen ? `rgba(244,114,182,${0.25 + p * 0.45})` : `rgba(255,255,255,${p * 0.5})`; ctx.beginPath(); ctx.arc(x, cy, rr, 0, 7); ctx.fill()
    ctx.lineWidth = chosen ? 2.8 : 1.8; ctx.strokeStyle = chosen ? `rgba(255,205,232,${al})` : `rgba(255,255,255,${al})`
    ctx.beginPath(); ctx.arc(x, cy, rr, 0, 7); ctx.stroke(); ctx.shadowBlur = 0
    // the histogram riding under the aim
    const h = Math.max(2, p * maxH)
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(x - barW / 2, base - maxH, barW, maxH)
    if (chosen) { ctx.shadowColor = '#f472b6'; ctx.shadowBlur = 12 }
    ctx.fillStyle = chosen ? '#f472b6' : 'rgba(196,181,253,.75)'; ctx.fillRect(x - barW / 2, base - h, barW, h); ctx.shadowBlur = 0
    ctx.fillStyle = chosen ? '#fff' : 'rgba(255,255,255,.45)'; ctx.fillText(GLYPH[m], x, base + 11)
  }
}

function drawReticle(g, aim) {
  const x = g.px(aim), y = g.cy, r = clamp(g.slot * 0.42, 9, 17)
  for (const [lw, c] of [[5, 'rgba(0,0,0,.55)'], [2, '#fff']]) {
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * r * 0.55, y + dy * r * 0.55); ctx.lineTo(x + dx * r * 1.5, y + dy * r * 1.5) }
    ctx.stroke()
  }
  ctx.fillStyle = '#f472b6'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill()
}

function arrowShape(len, alpha = 1) {
  // drawn pointing up (−y), nock at the origin
  ctx.globalAlpha = alpha; ctx.lineCap = 'round'
  ctx.strokeStyle = '#0b0d14'; ctx.lineWidth = Math.max(2, len * 0.03) + 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke()
  const grd = ctx.createLinearGradient(-2, 0, 2, 0); grd.addColorStop(0, '#e2e8f0'); grd.addColorStop(1, '#64748b')
  ctx.strokeStyle = grd; ctx.lineWidth = Math.max(2, len * 0.03); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke()
  const hw = Math.max(3, len * 0.045)
  ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.moveTo(0, -len - hw * 2.6); ctx.lineTo(-hw, -len + hw * 0.4); ctx.lineTo(hw, -len + hw * 0.4); ctx.closePath(); ctx.fill()
  for (const s of [-1, 1]) { ctx.fillStyle = s < 0 ? '#f472b6' : '#fde68a'; ctx.beginPath(); ctx.moveTo(0, -len * 0.04); ctx.lineTo(s * hw * 2.1, len * 0.02); ctx.lineTo(s * hw * 2.1, -len * 0.16); ctx.lineTo(0, -len * 0.24); ctx.closePath(); ctx.fill() }
  ctx.globalAlpha = 1
}

/** Where the bow is, which way it points, and where the arrow tip is on screen. */
function bowPose(g, aim, pull) {
  const { Lw, by, cy, px, AL } = g
  const ax = px(aim), bx = W / 2 + (ax - W / 2) * 0.45
  const th = Math.atan2(ax - bx, by - cy)
  const tipY = Lw * (0.2 + 0.2 * pull), nockY = tipY + pull * Lw * 0.62
  const d = AL - nockY + AL * 0.1
  return { bx, th, tipY, nockY, x: bx + Math.sin(th) * d, y: by - Math.cos(th) * d, len: AL }
}

/** The bow, seen from above, pointing at the aim. */
function drawBow(g, f, pose, now) {
  const { Lw, by, AL } = g
  const { bx, th, tipY } = pose
  const nockY = pose.nockY + fx.twang * Math.sin(now * 0.11) * 5
  const hasArrow = !f.finished && now - fx.nockAt > 240
  ctx.save(); ctx.translate(bx, by); ctx.rotate(th)
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6
  // string
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.4
  ctx.beginPath(); ctx.moveTo(-Lw, tipY); ctx.lineTo(0, nockY); ctx.lineTo(Lw, tipY); ctx.stroke()
  // limbs
  for (const s of [-1, 1]) {
    const grd = ctx.createLinearGradient(0, 0, s * Lw, 0); grd.addColorStop(0, '#3b1d2c'); grd.addColorStop(0.5, '#9d174d'); grd.addColorStop(1, '#f472b6')
    ctx.strokeStyle = grd; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(5, Lw * 0.085)
    ctx.beginPath(); ctx.moveTo(s * Lw * 0.1, 0); ctx.quadraticCurveTo(s * Lw * 0.62, -Lw * 0.16, s * Lw, tipY); ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.moveTo(s * Lw * 0.1, -2); ctx.quadraticCurveTo(s * Lw * 0.62, -Lw * 0.16 - 2, s * Lw, tipY - 2); ctx.stroke()
  }
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
  ctx.fillStyle = '#12141c'; ctx.beginPath(); ctx.roundRect(-Lw * 0.13, -Lw * 0.07, Lw * 0.26, Lw * 0.15, 6); ctx.fill()
  ctx.strokeStyle = 'rgba(244,114,182,.6)'; ctx.lineWidth = 1; ctx.stroke()
  if (hasArrow) { ctx.save(); ctx.translate(0, nockY); arrowShape(AL, clamp((now - fx.nockAt - 240) / 140, 0, 1)); ctx.restore() }
  ctx.restore()
}

function drawFlights(g, f, tx, now) {
  for (let i = flights.length - 1; i >= 0; i--) {
    const fl = flights[i], t = clamp((now - fl.t0) / fl.dur, 0, 1), e = 1 - Math.pow(1 - t, 2.1)
    const l = landing(fl.a, g, f), ex = l.onFace ? tx + l.x : l.x, ey = l.onFace ? g.cy + l.y : l.y
    const at = (u) => ({ x: lerp(fl.sx, ex, u), y: lerp(fl.sy, ey, u) - Math.sin(Math.PI * u) * H * 0.05 })
    const p = at(e), q = at(Math.min(1, e + 0.03)), ang = Math.atan2(q.x - p.x, -(q.y - p.y))
    if (t >= 1) { flights.splice(i, 1); impact(fl.a, ex, ey, l.onFace); continue }
    const len = fl.len * lerp(1, 0.22, e)
    const back = at(Math.max(0, e - 0.16))
    const grd = ctx.createLinearGradient(back.x, back.y, p.x, p.y); grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(255,240,250,.55)')
    ctx.strokeStyle = grd; ctx.lineWidth = lerp(5, 1.5, e); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(back.x, back.y); ctx.lineTo(p.x, p.y); ctx.stroke()
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(ang); ctx.translate(0, len); arrowShape(len); ctx.restore()
  }
}

function impact(a, x, y, onFace) {
  fx.shake = Math.max(fx.shake, a.hit ? 1 : 0.5)
  if (onFace) fx.wobble = 1
  if (a.hit) {
    fx.flash = 1
    burst(x, y, 34, ['#fde047', '#fff7b0', '#f472b6', '#ffffff'], 300, 0.9)
    rings.push({ x, y, t: 0, c: '253,224,71' })
    popup(x + (a.n % 2 ? -22 : 22), y - 18, '+10', POINT_COLOR[10], 30)
    if (a.streak >= 3) popup(x + (a.n % 2 ? -22 : 22), y - 50, `${a.streak} in a row`, '#f9a8d4', 13)
  } else if (onFace) {
    burst(x, y, 14, ['#e5c77a', '#a3824a', '#ffffff'], 190, 0.7)
    popup(x, y - 16, `+${a.points}`, POINT_COLOR[a.points] || '#fff', 20)
  } else {
    burst(x, y, 20, ['#e5c77a', '#a3824a', '#6b4f1d'], 210, 0.8)
    popup(x, y - 16, 'MISS', POINT_COLOR[0], 18)
  }
}

function drawFx(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt * 1.8
    if (r.t >= 1) { rings.splice(i, 1); continue }
    ctx.strokeStyle = `rgba(${r.c},${(1 - r.t) * 0.9})`; ctx.lineWidth = 3 * (1 - r.t) + 0.5
    ctx.beginPath(); ctx.arc(r.x, r.y, 8 + r.t * (r.size || 90), 0, 7); ctx.stroke()
  }
  for (let i = streaks.length - 1; i >= 0; i--) {
    const s = streaks[i]; s.life -= dt; s.x += s.vx * dt
    if (s.life <= 0) { streaks.splice(i, 1); continue }
    const al = Math.min(1, s.life * 2.5) * 0.6
    const grd = ctx.createLinearGradient(s.x, 0, s.x - Math.sign(s.vx) * s.len, 0); grd.addColorStop(0, `rgba(255,255,255,${al})`); grd.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = grd; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - Math.sign(s.vx) * s.len, s.y); ctx.stroke()
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
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(5,6,12,.85)'; ctx.strokeText(p.text, p.x, p.y - p.t * 64)
    ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y - p.t * 64)
  }
  ctx.globalAlpha = 1
}

function drawHud(g, f, now) {
  const pad = 14
  // streak, top left
  const hot = clamp(f.streak / 8, 0, 1)
  ctx.fillStyle = 'rgba(6,7,12,.72)'; ctx.beginPath(); ctx.roundRect(pad + 18, 10, 148, 58, 10); ctx.fill()
  ctx.strokeStyle = `rgba(253,224,71,${0.18 + hot * 0.6})`; ctx.lineWidth = 1; ctx.stroke()
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText('STREAK', pad + 30, 28)
  ctx.fillText('SCORE', pad + 102, 28)
  if (f.streak >= 3) { ctx.shadowColor = '#fb923c'; ctx.shadowBlur = 10 + hot * 16 }
  ctx.font = `800 26px ${FONT}`; ctx.fillStyle = f.streak >= 3 ? '#fde047' : '#e9ecf5'; ctx.fillText(`×${f.streak}`, pad + 30, 57); ctx.shadowBlur = 0
  ctx.fillStyle = '#f9a8d4'; ctx.fillText(String(f.score), pad + 102, 57)
  // quiver, top right: one pip per arrow
  const total = f.shots, show = Math.min(total, 32), done = f.arrows.length, from = Math.max(0, Math.min(done - show + 4, total - show))
  const pw = 7, gap = 3, bw = show * (pw + gap) + 20, x0 = W - pad - 18 - bw, y0 = 10
  ctx.fillStyle = 'rgba(6,7,12,.72)'; ctx.beginPath(); ctx.roundRect(x0, y0, bw, 40, 10); ctx.fill()
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText(`ARROWS ${Math.min(done + (f.finished ? 0 : 1), total)} / ${total}`, x0 + 10, y0 + 14)
  for (let i = 0; i < show; i++) {
    const a = f.arrows[from + i]
    ctx.fillStyle = a ? (a.hit ? '#34d399' : a.points ? '#fbbf24' : '#fb7185') : 'rgba(255,255,255,.16)'
    ctx.beginPath(); ctx.roundRect(x0 + 10 + i * (pw + gap), y0 + 21, pw, 11, 2); ctx.fill()
  }
  // draw meter beside the bow, and what Jev just chose
  const bx = bowState ? bowState.bx : W / 2, y = H * 0.955
  if (!f.finished) {
    ctx.textAlign = 'left'; ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'
    const lx = bx + g.Lw + 22
    ctx.fillText(`RELEASE IN ${f.fuse}`, lx, y - 10)
    for (let i = 0; i < f.fuseMax; i++) { ctx.fillStyle = i < f.fuseMax - f.fuse ? '#f472b6' : 'rgba(255,255,255,.16)'; ctx.beginPath(); ctx.roundRect(lx + i * 13, y - 3, 10, 5, 2); ctx.fill() }
    ctx.textAlign = 'right'; ctx.font = `700 10px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'
    ctx.fillText('JEV SAYS', bx - g.Lw - 22, y - 10)
    ctx.font = `800 15px ${FONT}`; ctx.fillStyle = '#f9a8d4'
    ctx.fillText(`${f.move} ${Math.round((f.conf || 0) * 100)}%`, bx - g.Lw - 22, y + 6)
  }
  if (f.slowmo) { ctx.textAlign = 'center'; ctx.font = `800 11px ${FONT}`; ctx.fillStyle = 'rgba(94,234,212,.9)'; ctx.fillText('SLOW MOTION ×3', W / 2, pad + H * 0.17 + 8) }
  if (paused) { ctx.textAlign = 'center'; ctx.font = `800 11px ${FONT}`; ctx.fillStyle = 'rgba(251,191,36,.95)'; ctx.fillText('PAUSED', W / 2, pad + H * 0.17 + (f.slowmo ? 24 : 8)) }
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
  const aim = lerp(from.aim, f.aim, a), target = lerp(from.target, f.target, a)
  const fuseS = from.fuse > f.fuse ? lerp(from.fuse, f.fuse, a) : f.fuse
  const pull = f.finished ? 0 : Math.pow(clamp(1 - (fuseS - 1) / (f.fuseMax - 1), 0, 1), 0.8) * clamp((now - fx.nockAt - 240) / 200, 0, 1)
  for (const k of ['wobble', 'twang', 'shake', 'flash']) fx[k] = Math.max(0, fx[k] - dt * (k === 'shake' ? 6 : k === 'flash' ? 1.6 : 2.4))
  windNow = lerp(windNow, f.gust, 1 - Math.pow(0.002, dt)); if (Math.abs(f.gust) > 0.05) windDir = Math.sign(f.gust)

  const g = geo(f), tx = g.px(target)
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.save()
  if (fx.shake > 0.01) ctx.translate((Math.random() - 0.5) * fx.shake * 5, (Math.random() - 0.5) * fx.shake * 5)
  ctx.drawImage(bg, 0, 0, W, H)
  drawFlagAndBunting(g, now)
  drawRail(g, f)
  const flying = new Set(flights.map((fl) => fl.a.n))
  for (const ar of f.arrows) { if (flying.has(ar.n)) continue; const l = landing(ar, g, f); if (!l.onFace) drawStuck(l.x, l.y, ar.n, clamp(g.R / 95, 0.6, 1.15)) }
  drawTarget(g, f, tx, now, flying)
  const pose = bowPose(g, aim, pull)
  bowState = pose
  if (!f.finished) { drawMind(g, f, aim, pose); drawReticle(g, aim) }
  drawBow(g, f, pose, now)
  drawFlights(g, f, tx, now)
  drawFx(dt)
  ctx.restore()
  drawHud(g, f, now)
  if (f.finished) $('banner').querySelector('small').textContent = `next range in ${(Math.max(0, f.finished.leftMs - (now - nextAt)) / 1000).toFixed(1)} s`
}
function loop(now) { requestAnimationFrame(loop); draw(now) }

// ---------------------------------------------------------------- frames and events from the server
function onEvents(f) {
  const fresh = lastSeq < 0
  for (const ev of f.events || []) {
    if (ev.seq <= lastSeq) continue
    lastSeq = ev.seq
    if (fresh) continue // a pane that opens late does not replay old arrows
    const g = geo(f), now = performance.now()
    if (ev.e === 'release') {
      const b = bowState || { x: W / 2, y: H * 0.8, len: g.AL }
      flights.push({ a: ev, t0: now, dur: f.slowmo ? 900 : 430, sx: b.x, sy: b.y, len: b.len })
      fx.twang = 1; fx.nockAt = now
    } else if (ev.e === 'gust') {
      const dir = Math.sign(ev.v) || 1
      for (let i = 0; i < 34; i++) streaks.push({ x: dir > 0 ? -Math.random() * W * 0.6 : W + Math.random() * W * 0.6, y: H * (0.04 + Math.random() * 0.86), vx: dir * (900 + Math.random() * 900), len: 50 + Math.random() * 130, life: 0.7 + Math.random() * 0.8 })
      popup(W / 2, H * 0.12, dir > 0 ? 'GUST  →→→' : '←←←  GUST', '#fecdd3', 17)
    } else if (ev.e === 'shove') {
      const x = g.px(ev.x)
      rings.push({ x, y: g.cy, t: 0, c: '94,234,212', size: g.R * 1.6 })
      burst(x, g.railY - 6, 16, ['#5eead4', '#ffffff'], 200, 0.6)
      popup(x, g.cy - g.R - 22, 'SHOVED', '#5eead4', 15)
    } else if (ev.e === 'range') { flights.length = 0 }
  }
  if (fresh && lastSeq < 0) lastSeq = 0
}

const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function onFrame(f) {
  if (next && next.episode !== f.episode) prev = null
  else prev = next
  next = f; nextAt = performance.now()
  onEvents(f)
  paused = !f.running
  $('title').textContent = f.title
  const done = f.hits + f.misses
  $('s-arrow').textContent = f.finished ? `${done}/${f.shots}` : `${Math.min(done + 1, f.shots)}/${f.shots}`
  $('s-hits').textContent = f.hits; $('s-miss').textContent = f.misses
  $('s-rate').textContent = f.recentN ? Math.round(f.recentRate * 100) + '%' : '—'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  $('slowmo').classList.toggle('on', !!f.slowmo)
  $('pick').textContent = f.move
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still running on the last good range.` : ''
  for (const [id, key, val] of [['d-speed', 'speed', 'v-speed'], ['d-bull', 'bullHalf', 'v-bull']]) {
    if (document.activeElement !== $(id)) $(id).value = f[key]
    $(val).textContent = Number(f[key]).toFixed(2)
    $(id).parentElement.classList.toggle('over', f.overrides && key in f.overrides)
  }
  const lines = String(f.stateText || '').split('\n')
  $('stateText').innerHTML = lines.slice(-3).map((l, i) => (i === 1 ? `<span class="hl">${esc(l)}</span>` : i === 2 ? `<span class="q">${esc(l)}</span>` : esc(l))).join('\n')
  const banner = $('banner')
  if (f.finished) {
    banner.className = 'banner ' + (f.finished.ok ? 'ok' : 'bad')
    const head = f.finished.ok ? `CLEAN DAY · ${f.finished.hits} of ${f.shots} on the gold` : `${f.finished.hits} of ${f.shots} on the gold · ${f.finished.misses} missed`
    if (banner.dataset.head !== head) { banner.dataset.head = head; banner.innerHTML = `${esc(head)} · ${f.finished.score} points<small></small>` }
  } else { banner.className = 'banner hidden'; banner.dataset.head = '' }
  const log = $('log'), sig = (f.log || []).map((s) => s.episode + ':' + s.n).join(',')
  if (log.dataset.sig !== sig) {
    log.dataset.sig = sig
    log.innerHTML = (f.log || []).slice().reverse().map((s) => `<li class="${s.hit ? 'hit' : s.points ? 'face' : 'miss'}"><span class="n">#${s.n}</span><b>${s.hit ? 'bullseye' : s.points ? 'on the face' : 'missed'}</b><span class="pts">+${s.points}</span><span class="off">off ${Math.abs(s.off).toFixed(1)}</span></li>`).join('')
  }
}

// ---------------------------------------------------------------- wiring
const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('gust').onclick = () => post({ cmd: 'gust' })
$('slowmo').onclick = () => post({ cmd: 'slowmo' })
$('d-speed').oninput = (e) => { $('v-speed').textContent = Number(e.target.value).toFixed(2); post({ cmd: 'set', key: 'speed', value: Number(e.target.value) }) }
$('d-bull').oninput = (e) => { $('v-bull').textContent = Number(e.target.value).toFixed(2); post({ cmd: 'set', key: 'bullHalf', value: Number(e.target.value) }) }
scene.addEventListener('click', (e) => {
  if (!next) return
  const r = scene.getBoundingClientRect(), g = geo(next)
  const x = ((e.clientX - r.left) / r.width) * W
  post({ cmd: 'shove', x: clamp((x - g.left) / g.slot, 1, next.targetWidth - 1) })
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
