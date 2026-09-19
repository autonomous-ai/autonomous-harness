// Jev Slalom pane — a snowy slope seen from above. The server runs the course and streams one frame
// per Jev decision (about six a second); this file renders at 60 fps and eases between frames. The
// camera follows the skier down the hill past two layers of pines, the skis carve trails that stay
// on the snow, turns throw spray, and every gate flashes green or red as it is passed. Jev's mind
// is in the scene: a fan of five predicted paths, one per option, as bold as its probability.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap'), ctx = scene.getContext('2d')
const FONT = "ui-monospace,'SF Mono',Menlo,monospace"
const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const GLYPH = { LEFT_FAST: '«', LEFT: '‹', HOLD: '•', RIGHT: '›', RIGHT_FAST: '»' }
const AHEAD = 6 // ticks of path drawn for each option

let W = 0, H = 0, DPR = 1, snowTile = null
let pp = null, prev = null, next = null, nextAt = 0, lastSeq = -1, lastDraw = 0
let paused = false, windNow = 0, heading = 0, lastCamPx = 0, lastTurn = 0
let trail = []
const particles = [], popups = [], rings = [], streaks = [], confetti = []
const fx = { crash: -1, crashDir: 1, shake: 0, flash: 0 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
const mod = (a, n) => ((a % n) + n) % n
function rnd(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const hash = (n, k = 0) => rnd((n | 0) * 7919 + k * 104729 + 13)()

// ---------------------------------------------------------------- layout
function resize() {
  const r = wrap.getBoundingClientRect()
  DPR = Math.min(2, window.devicePixelRatio || 1)
  W = Math.max(320, Math.round(r.width)); H = Math.max(240, Math.round(r.height))
  scene.width = Math.round(W * DPR); scene.height = Math.round(H * DPR)
}
function geo(f, cam) {
  const slopeW = W * 0.62, slot = slopeW / f.valleyWidth, left = (W - slopeW) / 2, skierY = H * 0.34, rowPx = (H - skierY) / 34
  return { slopeW, slot, left, right: left + slopeW, skierY, rowPx, u: clamp(H / 620, 0.75, 1.4), camPx: cam * rowPx, sx: (x) => left + x * slot, sy: (row) => skierY + (row - cam) * rowPx }
}
function makeSnowTile() {
  const c = document.createElement('canvas'); c.width = c.height = 512
  const g = c.getContext('2d'), r = rnd(31)
  for (let i = 0; i < 46; i++) {
    const x = r() * 512, y = r() * 512, rad = 30 + r() * 70, dark = r() < 0.5
    for (const [ox, oy] of [[0, 0], [512, 0], [-512, 0], [0, 512], [0, -512]]) {
      const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad)
      grd.addColorStop(0, dark ? 'rgba(60,100,160,.10)' : 'rgba(255,255,255,.22)'); grd.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grd; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2)
    }
  }
  for (let i = 0; i < 1500; i++) { g.fillStyle = r() < 0.6 ? 'rgba(255,255,255,.55)' : 'rgba(70,110,170,.16)'; g.fillRect(r() * 512, r() * 512, 1.4, 1.4) }
  return c
}

// ---------------------------------------------------------------- scene pieces
function drawSnow(g) {
  let grd = ctx.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#c7dcf3'); grd.addColorStop(0.5, '#dcebf9'); grd.addColorStop(1, '#eef6fd')
  ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H)
  snowTile ??= makeSnowTile()
  const pat = ctx.createPattern(snowTile, 'repeat')
  ctx.save(); ctx.translate(0, -mod(g.camPx, 512)); ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H + 512); ctx.restore()
  // the banks outside the course lie in the trees' shade
  for (const side of [0, 1]) {
    const x0 = side ? g.right : 0, x1 = side ? W : g.left
    grd = ctx.createLinearGradient(side ? x0 : x1, 0, side ? x1 : x0, 0); grd.addColorStop(0, 'rgba(90,130,185,.10)'); grd.addColorStop(1, 'rgba(40,70,125,.5)')
    ctx.fillStyle = grd; ctx.fillRect(x0, 0, x1 - x0, H)
  }
}

function drawPine(x, y, s, sway, dark) {
  ctx.fillStyle = 'rgba(30,55,100,.26)'; ctx.beginPath(); ctx.ellipse(x + s * 0.55, y + s * 0.12, s * 0.75, s * 0.2, 0.25, 0, 7); ctx.fill()
  ctx.save(); ctx.translate(x, y); ctx.rotate(sway)
  ctx.fillStyle = '#3b2a1a'; ctx.fillRect(-s * 0.05, -s * 0.18, s * 0.1, s * 0.2)
  const tiers = [[0.5, 0.15, 0.62], [0.4, 0.5, 0.95], [0.28, 0.85, 1.28]]
  for (const [w, y0, y1] of tiers) {
    ctx.fillStyle = dark ? '#0c2a22' : '#14532d'
    ctx.beginPath(); ctx.moveTo(-s * w, -s * y0); ctx.lineTo(0, -s * y1); ctx.lineTo(s * w, -s * y0); ctx.closePath(); ctx.fill()
    ctx.fillStyle = dark ? '#103a2d' : '#1c6b3a'
    ctx.beginPath(); ctx.moveTo(0, -s * y0); ctx.lineTo(0, -s * y1); ctx.lineTo(s * w, -s * y0); ctx.closePath(); ctx.fill()
    ctx.fillStyle = dark ? 'rgba(226,240,255,.7)' : 'rgba(255,255,255,.92)'
    ctx.beginPath(); ctx.moveTo(-s * w * 0.72, -s * (y0 + (y1 - y0) * 0.28)); ctx.lineTo(0, -s * y1); ctx.lineTo(s * w * 0.3, -s * (y0 + (y1 - y0) * 0.55)); ctx.lineTo(-s * w * 0.1, -s * (y0 + (y1 - y0) * 0.38)); ctx.closePath(); ctx.fill()
  }
  ctx.restore()
}
/** One layer of pines on both banks. `par` > 1 is nearer the camera, so it slides by faster. */
function drawTrees(g, par, spacing, size, inset, spread, dark, now) {
  const camPx = g.camPx * par, n0 = Math.floor((camPx - g.skierY - 120) / spacing), n1 = Math.ceil((camPx + H - g.skierY + 160) / spacing)
  for (let n = n0; n <= n1; n++) for (const side of [0, 1]) {
    const k = side + (dark ? 2 : 0)
    const y = n * spacing + hash(n, k) * spacing * 0.7 - camPx + g.skierY
    const off = inset + hash(n, k + 10) * spread
    const x = side ? g.right + off : g.left - off
    const s = size * (0.75 + hash(n, k + 20) * 0.6)
    drawPine(x, y, s, windNow * 0.05 + Math.sin(now * 0.0012 + n) * 0.012, dark)
  }
}

function drawNets(g) {
  for (const x of [g.sx(0.7), g.sx(next.valleyWidth - 0.7)]) {
    ctx.strokeStyle = 'rgba(30,55,100,.25)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x + 4, 0); ctx.lineTo(x + 4, H); ctx.stroke()
    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3; ctx.setLineDash([14, 6]); ctx.lineDashOffset = mod(g.camPx, 20)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([])
    const step = 80
    for (let y = -mod(g.camPx, step); y < H + step; y += step) { ctx.fillStyle = '#7c2d12'; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7); ctx.fill() }
  }
}

function drawTrail(g) {
  if (trail.length < 2) return
  for (const [dx, col, lw] of [[-4, 'rgba(60,100,155,.55)', 2.4], [4, 'rgba(60,100,155,.55)', 2.4], [-3, 'rgba(255,255,255,.7)', 1], [5, 'rgba(255,255,255,.7)', 1]]) {
    ctx.strokeStyle = col; ctx.lineWidth = lw * g.u; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath()
    let started = false
    for (const p of trail) {
      const y = g.sy(p.row); if (y < -20) continue
      const x = g.sx(p.x) + dx * g.u
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true
    }
    ctx.stroke()
  }
}

function drawGate(g, f, gate, i, now) {
  const y = g.sy(gate.y)
  if (y < -60 || y > H + 60) return
  const xl = g.sx(gate.x - gate.gap / 2), xr = g.sx(gate.x + gate.gap / 2), u = g.u
  const isNext = i === f.next && !f.finished
  const col = gate.result === 'ok' ? '#22c55e' : gate.result === 'clip' ? '#ef4444' : gate.planted ? '#8b5cf6' : i % 2 ? '#2563eb' : '#dc2626'
  if (isNext) {
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.008)
    const grd = ctx.createLinearGradient(0, y - 26 * u, 0, y + 10 * u); grd.addColorStop(0, 'rgba(251,146,60,0)'); grd.addColorStop(1, `rgba(251,146,60,${0.16 + pulse * 0.14})`)
    ctx.fillStyle = grd; ctx.fillRect(xl, y - 26 * u, xr - xl, 36 * u)
    ctx.fillStyle = `rgba(194,65,12,${0.55 + pulse * 0.4})`
    for (let k = 0; k < 3; k++) { const cx = lerp(xl, xr, (k + 1) / 4); ctx.beginPath(); ctx.moveTo(cx - 7 * u, y - 22 * u); ctx.lineTo(cx, y - 13 * u); ctx.lineTo(cx + 7 * u, y - 22 * u); ctx.lineTo(cx, y - 17 * u); ctx.closePath(); ctx.fill() }
  }
  ctx.strokeStyle = gate.result === 'ok' ? 'rgba(34,197,94,.75)' : gate.result === 'clip' ? 'rgba(239,68,68,.8)' : 'rgba(30,58,138,.4)'
  ctx.lineWidth = gate.result ? 3 : 1.6; ctx.setLineDash(gate.result ? [] : [6, 6]); ctx.beginPath(); ctx.moveTo(xl, y); ctx.lineTo(xr, y); ctx.stroke(); ctx.setLineDash([])
  for (const [x, dir] of [[xl, -1], [xr, 1]]) {
    const bent = gate.result === 'clip' && Math.sign(gate.hitX - gate.x) === dir ? dir * 0.9 : 0
    ctx.fillStyle = 'rgba(30,55,100,.3)'; ctx.beginPath(); ctx.ellipse(x + 9 * u, y + 3 * u, 12 * u, 3.4 * u, 0.2, 0, 7); ctx.fill()
    ctx.save(); ctx.translate(x, y); ctx.rotate(bent)
    if (gate.result === 'ok' && fx.flash > 0.02) { ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 22 * fx.flash }
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 5 * u; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -30 * u); ctx.stroke()
    ctx.strokeStyle = col; ctx.lineWidth = 3.2 * u; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -30 * u); ctx.stroke()
    ctx.fillStyle = col; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.roundRect(dir > 0 ? 0 : -17 * u, -31 * u, 17 * u, 12 * u, 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(dir > 0 ? 1 : -16 * u, -30 * u, 15 * u, 3 * u)
    ctx.shadowBlur = 0
    ctx.restore()
  }
  ctx.font = `700 ${Math.round(10 * u)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(30,58,138,.6)'
  ctx.fillText(gate.planted ? `${i + 1} · planted` : String(i + 1), (xl + xr) / 2, y + 5 * u)
}

function drawFinish(g, f) {
  const y = g.sy(f.finishRow)
  if (y < -80 || y > H + 80) return
  const x0 = g.sx(0.7), x1 = g.sx(f.valleyWidth - 0.7), u = g.u, top = y - 58 * u, bh = 22 * u
  ctx.fillStyle = 'rgba(30,55,100,.28)'; ctx.fillRect(x0, y - 2, x1 - x0, 7 * u)
  for (const x of [x0, x1]) { ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 7 * u; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke(); ctx.strokeStyle = '#f97316'; ctx.lineWidth = 4 * u; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke() }
  ctx.fillStyle = '#0f172a'; ctx.fillRect(x0, top, x1 - x0, bh)
  const cell = bh / 2
  for (let i = 0; i * cell < x1 - x0; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(x0 + i * cell, top + j * cell, Math.min(cell, x1 - x0 - i * cell), cell) }
  const tw = 120 * u
  ctx.fillStyle = '#c2410c'; ctx.beginPath(); ctx.roundRect((x0 + x1) / 2 - tw / 2, top - 3 * u, tw, bh + 6 * u, 4); ctx.fill()
  ctx.font = `800 ${Math.round(15 * u)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText('FINISH', (x0 + x1) / 2, top + bh / 2 + 1)
}

function drawMind(g, f, x, rows) {
  let total = 0
  for (const m of MOVES) total += f.probs?.[m] ?? 0
  if (total <= 0) return
  const lo = 1, hi = f.valleyWidth - 1
  const order = MOVES.slice().sort((a, b) => (a === f.move) - (b === f.move)) // the chosen path goes on top
  for (const m of order) {
    const p = (f.probs[m] ?? 0) / total, chosen = m === f.move, al = 0.1 + 0.9 * Math.sqrt(p)
    ctx.beginPath(); ctx.moveTo(g.sx(x), g.sy(rows))
    let ex = 0, ey = 0
    for (let k = 1; k <= AHEAD; k++) { ex = g.sx(clamp(x + (f.nudge?.[m] ?? 0) * k, lo, hi)); ey = g.sy(rows + f.speed * k); ctx.lineTo(ex, ey) }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    if (chosen) { ctx.shadowColor = '#fb923c'; ctx.shadowBlur = 16 }
    ctx.strokeStyle = chosen ? `rgba(234,88,12,${al})` : `rgba(30,58,138,${al * 0.75})`
    ctx.lineWidth = (chosen ? 3 : 1.6) + p * 5; ctx.setLineDash(chosen ? [] : [7, 7]); ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0
    ctx.fillStyle = chosen ? `rgba(234,88,12,${al})` : `rgba(30,58,138,${al * 0.8})`; ctx.beginPath(); ctx.arc(ex, ey, 3 + p * 8, 0, 7); ctx.fill()
    if (chosen) {
      ctx.font = `800 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(`${GLYPH[m]} ${Math.round(p * 100)}%`, ex, ey + 12)
      ctx.fillStyle = '#9a3412'; ctx.fillText(`${GLYPH[m]} ${Math.round(p * 100)}%`, ex, ey + 12)
    }
  }
}

function drawSkier(g, x, now) {
  const u = g.u * 1.3, sx = g.sx(x), sy = g.skierY
  const c = fx.crash >= 0 ? Math.min(1, fx.crash / 0.9) : 0
  const spin = fx.crash >= 0 ? fx.crashDir * (1 - Math.pow(1 - c, 2)) * 5.6 : 0
  ctx.fillStyle = 'rgba(30,55,100,.32)'; ctx.beginPath(); ctx.ellipse(sx + 8 * u, sy + 8 * u, 14 * u, 8 * u, 0.4, 0, 7); ctx.fill()
  ctx.save(); ctx.translate(sx, sy); ctx.rotate(-heading + spin)
  // skis (they come off in a fall)
  for (const s of [-1, 1]) {
    ctx.save(); ctx.translate(s * (5 * u + c * 26 * u), c * s * 14 * u); ctx.rotate(c * s * 1.3)
    ctx.fillStyle = '#111827'; ctx.beginPath(); ctx.roundRect(-1.9 * u, -17 * u, 3.8 * u, 40 * u, 2 * u); ctx.fill()
    ctx.fillStyle = '#fb923c'; ctx.beginPath(); ctx.roundRect(-1.9 * u, 17 * u, 3.8 * u, 6 * u, 2 * u); ctx.fill()
    ctx.restore()
  }
  // poles
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.6 * u; ctx.lineCap = 'round'
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 10 * u, 2 * u); ctx.lineTo(s * (15 + c * 10) * u, -16 * u); ctx.stroke() }
  // body, arms, helmet
  const lean = clamp(heading * 9, -6, 6) * u
  let grd = ctx.createLinearGradient(-9 * u, 0, 9 * u, 0); grd.addColorStop(0, '#fdba74'); grd.addColorStop(1, '#c2410c')
  ctx.fillStyle = grd; ctx.strokeStyle = '#431407'; ctx.lineWidth = 1.2
  ctx.beginPath(); ctx.ellipse(lean, 0, 9 * u, 11 * u, 0, 0, 7); ctx.fill(); ctx.stroke()
  for (const s of [-1, 1]) { ctx.fillStyle = '#9a3412'; ctx.beginPath(); ctx.ellipse(lean + s * 10 * u, 2 * u, 3.2 * u, 5 * u, s * 0.4, 0, 7); ctx.fill() }
  ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(lean, 5 * u, 6 * u, 0, 7); ctx.fill(); ctx.stroke()
  ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.ellipse(lean, 8.5 * u, 4.6 * u, 2.2 * u, 0, 0, 7); ctx.fill()
  ctx.fillStyle = '#38bdf8'; ctx.fillRect(lean - 3 * u, 7.8 * u, 2.4 * u, 1.2 * u)
  ctx.restore()
}

function burst(x, y, n, colors, speed, life, world = true) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.9)
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * (0.5 + Math.random() * 0.6), max: life, c: colors[(Math.random() * colors.length) | 0], r: 1.5 + Math.random() * 3, world })
  }
}
function popup(x, y, text, color, size = 18) { popups.push({ x: clamp(x, 70, W - 70), y, text, color, size, t: 0 }) }

function drawFx(g, dt, dCam) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt * 2; r.y -= dCam
    if (r.t >= 1) { rings.splice(i, 1); continue }
    ctx.strokeStyle = `rgba(${r.c},${(1 - r.t) * 0.9})`; ctx.lineWidth = 4 * (1 - r.t) + 0.5
    ctx.save(); ctx.translate(r.x, r.y); ctx.scale(1, 0.45); ctx.beginPath(); ctx.arc(0, 0, 8 + r.t * r.size, 0, 7); ctx.stroke(); ctx.restore()
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt
    if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue }
    p.x += p.vx * dt; p.y += p.vy * dt - (p.world ? dCam : 0); p.vx *= 0.94; p.vy *= 0.94
    const k = clamp(p.life / p.max, 0, 1)
    ctx.globalAlpha = k * 0.9; ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.6 + (1 - k) * 0.9), 0, 7); ctx.fill()
  }
  ctx.globalAlpha = 1
  for (let i = confetti.length - 1; i >= 0; i--) {
    const q = confetti[i]; q.life -= dt; q.vy += 260 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.a += q.va * dt
    if (q.life <= 0) { confetti.splice(i, 1); continue }
    ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.a); ctx.globalAlpha = clamp(q.life, 0, 1); ctx.fillStyle = q.c; ctx.fillRect(-4, -2, 8, 4); ctx.restore()
  }
  ctx.globalAlpha = 1
  for (let i = streaks.length - 1; i >= 0; i--) {
    const s = streaks[i]; s.life -= dt; s.x += s.vx * dt
    if (s.life <= 0) { streaks.splice(i, 1); continue }
    const al = Math.min(1, s.life * 2.5) * 0.75, d = Math.sign(s.vx)
    const grd = ctx.createLinearGradient(s.x, 0, s.x - d * s.len, 0); grd.addColorStop(0, `rgba(255,255,255,${al})`); grd.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = grd; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - d * s.len, s.y); ctx.stroke()
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i]; p.t += dt; p.y -= dCam * 0.5
    if (p.t > 1.15) { popups.splice(i, 1); continue }
    const k = Math.min(1, p.t / 0.16), s = 0.5 + 0.5 * (1 - Math.pow(1 - k, 3)) + (k < 1 ? 0.25 * Math.sin(k * Math.PI) : 0)
    ctx.globalAlpha = clamp((1.15 - p.t) / 0.4, 0, 1)
    ctx.font = `800 ${Math.round(p.size * s)}px ${FONT}`
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.strokeText(p.text, p.x, p.y - p.t * 30)
    ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y - p.t * 30)
  }
  ctx.globalAlpha = 1
}

function drawFlakes(g, now) {
  for (let i = 0; i < 46; i++) {
    const s = 0.5 + hash(i, 3), x = mod(hash(i, 1) * W + Math.sin(now * 0.0007 + i) * 24 + windNow * now * 0.05 * s, W)
    const y = mod(hash(i, 2) * H + now * 0.035 * s - g.camPx * 0.55 * s, H)
    ctx.fillStyle = `rgba(255,255,255,${0.5 + s * 0.3})`; ctx.beginPath(); ctx.arc(x, y, 1.2 + s * 1.6, 0, 7); ctx.fill()
  }
}

function chip(x, y, w, h) { ctx.fillStyle = 'rgba(8,12,24,.78)'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill(); ctx.strokeStyle = 'rgba(251,146,60,.35)'; ctx.lineWidth = 1; ctx.stroke() }
function drawHud(g, f) {
  const pad = 14
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  // gates, top left
  const total = f.gatesTotal, show = Math.min(total, 30), from = clamp(f.next - show + 6, 0, total - show)
  const cw = Math.max(150, show * 9 + 22)
  chip(pad, pad, cw, 46)
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText(`GATE ${Math.min(f.next + 1, total)} / ${total}`, pad + 11, pad + 16)
  for (let i = 0; i < show; i++) {
    const gate = f.gates[from + i]
    ctx.fillStyle = gate?.result === 'ok' ? '#22c55e' : gate?.result === 'clip' ? '#ef4444' : from + i === f.next ? '#fb923c' : gate?.planted ? 'rgba(167,139,250,.7)' : 'rgba(255,255,255,.2)'
    ctx.beginPath(); ctx.roundRect(pad + 11 + i * 9, pad + 25, 6, 12, 2); ctx.fill()
  }
  // pace, top right
  chip(W - pad - 214, pad, 214, 46)
  ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText('SPEED', W - pad - 203, pad + 16); ctx.fillText('GAP', W - pad - 92, pad + 16)
  ctx.font = `800 17px ${FONT}`; ctx.fillStyle = '#fdba74'; ctx.fillText(`${f.speed.toFixed(1)}`, W - pad - 203, pad + 37)
  ctx.font = `600 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText('rows/tick', W - pad - 203 + 38, pad + 37)
  ctx.font = `800 17px ${FONT}`; ctx.fillStyle = '#fdba74'; ctx.fillText(`${f.gateGap.toFixed(1)}`, W - pad - 92, pad + 37)
  ctx.font = `600 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText('slots', W - pad - 92 + 38, pad + 37)
  // what Jev just chose, bottom left
  if (!f.finished) {
    chip(pad, H - pad - 46, 186, 46)
    ctx.font = `700 9px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText('JEV SAYS', pad + 11, H - pad - 30)
    ctx.font = `800 16px ${FONT}`; ctx.fillStyle = '#fdba74'; ctx.fillText(`${f.move} ${Math.round((f.conf || 0) * 100)}%`, pad + 11, H - pad - 10)
  }
  ctx.textAlign = 'center'
  const notes = [f.slowmo ? ['SLOW MOTION ×3', '#0e7490'] : null, paused ? ['PAUSED', '#b45309'] : null, Math.abs(windNow) > 0.08 ? [`WIND ${windNow > 0 ? '→' : '←'} ${Math.abs(windNow).toFixed(1)}`, '#1e3a8a'] : null].filter(Boolean)
  notes.forEach(([t, c], i) => { ctx.font = `800 11px ${FONT}`; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(t, W / 2, pad + 14 + i * 16); ctx.fillStyle = c; ctx.fillText(t, W / 2, pad + 14 + i * 16) })
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
/** Ease x through the last three frames so the carved line is round, and exact on every tick. */
function hermite(p0, p1, m0, m1, t) { const t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1 }
function draw(now) {
  lastDraw = now
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now
  if (!next || W < 2) return
  const f = next
  const from = prev && prev.episode === f.episode ? prev : f
  const before = pp && pp.episode === f.episode ? pp : from
  const a = clamp((now - nextAt) / Math.max(40, f.tickMs), 0, 1)
  const x = clamp(hermite(from.x, f.x, (f.x - before.x) / 2, f.x - from.x, a), 0.8, f.valleyWidth - 0.8)
  const rows = lerp(from.rows, f.rows, a)
  const g = geo(f, rows)
  const dCam = Math.abs(g.camPx - lastCamPx) < 400 ? g.camPx - lastCamPx : 0; lastCamPx = g.camPx
  const vx = (f.x - from.x) * g.slot, vy = Math.max(1, (f.rows - from.rows) * g.rowPx)
  const wantHead = f.finished && !f.finished.ok ? heading : Math.atan2(vx, vy) * 0.85
  heading = lerp(heading, wantHead, 1 - Math.pow(0.0008, dt))
  if (fx.crash >= 0) fx.crash += dt
  for (const k of ['shake', 'flash']) fx[k] = Math.max(0, fx[k] - dt * (k === 'shake' ? 4 : 1.4))
  windNow = lerp(windNow, f.gust, 1 - Math.pow(0.002, dt))
  // the carved line, and the spray off the edges
  const last = trail[trail.length - 1]
  if (fx.crash < 0 && (!last || rows - last.row > 0.25)) { trail.push({ x, row: rows }); if (trail.length > 1200) trail.shift() }
  if (!paused && fx.crash < 0 && !f.finished && Math.abs(heading) > 0.12) {
    const n = Math.min(5, Math.round(Math.abs(heading) * 7 * dt * 60 / 2))
    for (let i = 0; i < n; i++) particles.push({ x: g.sx(x) - Math.sign(heading) * (4 + Math.random() * 8) * g.u, y: g.skierY - 8 * g.u + Math.random() * 10, vx: -Math.sign(heading) * (60 + Math.random() * 170), vy: -20 - Math.random() * 60, life: 0.35 + Math.random() * 0.4, max: 0.75, c: Math.random() < 0.7 ? '#ffffff' : '#dbeafe', r: 1.5 + Math.random() * 2.8, world: true })
    if (Math.sign(heading) !== lastTurn && Math.abs(heading) > 0.3) { lastTurn = Math.sign(heading); burst(g.sx(x), g.skierY - 6 * g.u, 16, ['#ffffff', '#e0efff'], 170, 0.6) }
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.save()
  if (fx.shake > 0.01) ctx.translate((Math.random() - 0.5) * fx.shake * 8, (Math.random() - 0.5) * fx.shake * 8)
  drawSnow(g)
  drawTrees(g, 1, 74, 46 * g.u, 26, Math.max(30, g.left - 90), false, now)
  drawNets(g)
  drawTrail(g)
  drawFinish(g, f)
  f.gates.forEach((gate, i) => drawGate(g, f, gate, i, now))
  if (!f.finished) drawMind(g, f, x, rows)
  drawSkier(g, x, now)
  drawFx(g, dt, dCam)
  drawTrees(g, 1.4, 190, 92 * g.u, Math.max(60, g.left - 70), 60, true, now)
  drawFlakes(g, now)
  const grd = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.78); grd.addColorStop(0, 'rgba(10,20,50,0)'); grd.addColorStop(1, 'rgba(10,20,50,.42)')
  ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H)
  ctx.restore()
  drawHud(g, f)
  if (f.finished) $('banner').querySelector('small').textContent = `${f.finished.ok ? '' : f.finished.reason + ' · '}next run in ${(Math.max(0, f.finished.leftMs - (now - nextAt)) / 1000).toFixed(1)} s`
}
function loop(now) { requestAnimationFrame(loop); draw(now) }

// ---------------------------------------------------------------- frames and events from the server
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function onFrame(f) {
  const fresh = lastSeq < 0
  if (next && next.episode !== f.episode) { pp = prev = null; trail = []; fx.crash = -1; heading = 0; particles.length = 0 } else { pp = prev; prev = next }
  next = f; nextAt = performance.now()
  const g = geo(f, f.rows)
  for (const ev of f.events || []) {
    if (ev.seq <= lastSeq) continue
    lastSeq = ev.seq
    if (fresh) continue // a pane that opens late does not replay old gates
    const sx = g.sx(ev.x ?? f.x)
    if (ev.e === 'gate') {
      const gate = f.gates[ev.i]; if (gate) gate.hitX = ev.x
      if (ev.ok) { fx.flash = 1; rings.push({ x: g.sx(ev.gx), y: g.skierY, t: 0, c: '34,197,94', size: ev.gap * g.slot * 0.6 }); popup(g.sx(ev.gx), g.skierY - 46, `GATE ${ev.i + 1}`, '#15803d', 17) }
      else popup(sx, g.skierY - 50, 'CLIPPED!', '#dc2626', 24)
    } else if (ev.e === 'crash') {
      fx.crash = 0; fx.crashDir = Math.sign(heading) || 1; fx.shake = 1
      burst(sx, g.skierY, 70, ['#ffffff', '#e0efff', '#bfdbfe'], 330, 1.1, false)
      rings.push({ x: sx, y: g.skierY, t: 0, c: '239,68,68', size: 110 })
      if (ev.reason === 'hit the wall') popup(sx, g.skierY - 50, 'INTO THE NET!', '#dc2626', 22)
    } else if (ev.e === 'finish') {
      const cols = ['#fb923c', '#22c55e', '#38bdf8', '#f472b6', '#fde047']
      for (let i = 0; i < 120; i++) confetti.push({ x: W * (0.2 + Math.random() * 0.6), y: H * (0.1 + Math.random() * 0.2), vx: (Math.random() - 0.5) * 320, vy: -80 - Math.random() * 220, a: Math.random() * 6, va: (Math.random() - 0.5) * 12, c: cols[i % 5], life: 1.6 + Math.random() * 1.2 })
    } else if (ev.e === 'plant') {
      rings.push({ x: g.sx(ev.x), y: g.sy(ev.y), t: 0, c: '139,92,246', size: 90 })
      burst(g.sx(ev.x), g.sy(ev.y), 22, ['#ffffff', '#c4b5fd'], 150, 0.6)
      popup(g.sx(ev.x), g.sy(ev.y) - 44, 'GATE PLANTED', '#6d28d9', 15)
    } else if (ev.e === 'refused') {
      popup(g.sx(ev.x), g.sy(ev.y) - 20, 'too close to a gate', '#b91c1c', 13)
    } else if (ev.e === 'gust') {
      const dir = Math.sign(ev.v) || 1
      for (let i = 0; i < 44; i++) streaks.push({ x: dir > 0 ? -Math.random() * W * 0.6 : W + Math.random() * W * 0.6, y: H * (0.04 + Math.random() * 0.92), vx: dir * (900 + Math.random() * 900), len: 60 + Math.random() * 150, life: 0.7 + Math.random() * 0.8 })
      popup(W / 2, H * 0.2, dir > 0 ? 'GUST  →→→' : '←←←  GUST', '#1e3a8a', 18)
    }
  }
  if (fresh && lastSeq < 0) lastSeq = 0
  if (fresh && f.finished && !f.finished.ok) fx.crash = 2

  paused = !f.running
  $('title').textContent = f.title
  $('s-gate').textContent = `${Math.min(f.next + (f.finished ? 0 : 1), f.gatesTotal)}/${f.gatesTotal}`
  $('s-clean').textContent = f.session.cleanRuns; $('s-falls').textContent = f.session.runs - f.session.cleanRuns
  $('s-rate').textContent = f.recentN ? Math.round(f.recentRate * 100) + '%' : '—'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  $('slowmo').classList.toggle('on', !!f.slowmo)
  $('pick').textContent = f.move
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still running on the last good course.` : ''
  for (const [id, key, val, dp] of [['d-speed', 'speed', 'v-speed', 1], ['d-gap', 'gateGap', 'v-gap', 2]]) {
    if (document.activeElement !== $(id)) $(id).value = f[key]
    $(val).textContent = Number(f[key]).toFixed(dp)
    $(id).parentElement.classList.toggle('over', !!f.overrides && key in f.overrides)
  }
  const lines = String(f.stateText || '').split('\n').slice(1)
  $('stateText').innerHTML = lines.map((l, i) => (i === 2 ? `<span class="hl">${esc(l)}</span>` : i === lines.length - 1 ? `<span class="q">${esc(l)}</span>` : esc(l))).join('\n')
  const banner = $('banner')
  if (f.finished) {
    banner.className = 'banner ' + (f.finished.ok ? 'ok' : 'bad')
    const head = f.finished.ok ? `CLEAN RUN · all ${f.finished.gates} gates` : `FELL AT GATE ${f.finished.atGate + 1} · ${f.finished.gates} of ${f.gatesTotal} threaded`
    if (banner.dataset.head !== head) { banner.dataset.head = head; banner.innerHTML = `${esc(head)}<small></small>` }
  } else { banner.className = 'banner hidden'; banner.dataset.head = '' }
  const log = $('log'), sig = (f.log || []).map((s) => s.run).join(',')
  if (log.dataset.sig !== sig) {
    log.dataset.sig = sig
    log.innerHTML = (f.log || []).slice().reverse().map((s) => `<li class="${s.ok ? 'hit' : 'miss'}"><span class="n">#${s.run}</span><b>${s.ok ? 'clean run' : esc(s.reason)}</b><span class="pts">${s.gates}/${s.of}</span><span class="off">speed ${Number(s.speed).toFixed(1)}</span></li>`).join('')
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
$('d-speed').oninput = (e) => { $('v-speed').textContent = Number(e.target.value).toFixed(1); post({ cmd: 'set', key: 'speed', value: Number(e.target.value) }) }
$('d-gap').oninput = (e) => { $('v-gap').textContent = Number(e.target.value).toFixed(2); post({ cmd: 'set', key: 'gateGap', value: Number(e.target.value) }) }
scene.addEventListener('click', (e) => {
  if (!next) return
  const r = scene.getBoundingClientRect(), a = clamp((performance.now() - nextAt) / Math.max(40, next.tickMs), 0, 1)
  const rows = prev && prev.episode === next.episode ? lerp(prev.rows, next.rows, a) : next.rows
  const g = geo(next, rows)
  const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H
  const y = rows + (py - g.skierY) / g.rowPx
  if (y < next.rows + 5) { popup(px, py, 'plant it further ahead', '#b91c1c', 13); return }
  post({ cmd: 'plant', x: (px - g.left) / g.slot, y })
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
