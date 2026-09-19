// Jev FPS pane — a software raycaster. The server runs the fight and streams one frame per Jev
// decision (~9 a second); this file renders at 60 fps, easing between frames, into a low-res pixel
// buffer (textured walls, floor and ceiling, billboard sprites, particles) that is scaled up crisp,
// then draws the HUD, the minimap and Jev's lit-up "keys" on top at full resolution.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap')
const ctx = scene.getContext('2d')
const low = document.createElement('canvas')
const lctx = low.getContext('2d')

// ---------------------------------------------------------------- state from the server
let map = ['#'], mapW = 1, mapH = 1, mapRev = -1
let prev = null, next = null, nextAt = 0
let tool = 'spawn'
let paused = false
const fx = { flash: 0, recoil: 0, hurt: 0, shake: 0, pickup: 0, pickupKind: '', tracer: null, banner: null }
const particles = [] // world-space: x, y, z (0 floor..1 ceiling), vx, vy, vz, life, max, color
const corpses = []   // { x, y, t }
const feed = []

// ---------------------------------------------------------------- textures (all procedural)
const TEX = 64, SHADES = 24, FOG = [6, 7, 14]
function rnd(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function paint(draw, size = TEX) {
  const c = document.createElement('canvas'); c.width = c.height = size
  const g = c.getContext('2d'); draw(g, size)
  return new Uint32Array(g.getImageData(0, 0, size, size).data.buffer.slice(0))
}
function speckle(g, r, n, colors, size = TEX) { for (let i = 0; i < n; i++) { g.fillStyle = colors[(r() * colors.length) | 0]; g.fillRect((r() * size) | 0, (r() * size) | 0, 1 + ((r() * 2) | 0), 1) } }
/** A texture at every fog level, so the inner loops only look colours up. Alpha is kept. */
function shadeSet(px) {
  const out = []
  for (let s = 0; s < SHADES; s++) {
    const f = Math.pow(1 - s / (SHADES - 1), 1.35), a = new Uint32Array(px.length)
    for (let i = 0; i < px.length; i++) {
      const c = px[i], r = c & 255, gg = (c >>> 8) & 255, b = (c >>> 16) & 255
      a[i] = ((c >>> 24) << 24) | (((FOG[2] + (b - FOG[2]) * f) & 255) << 16) | (((FOG[1] + (gg - FOG[1]) * f) & 255) << 8) | ((FOG[0] + (r - FOG[0]) * f) & 255)
    }
    out.push(a)
  }
  return out
}
function whiten(px) { const a = new Uint32Array(px.length); for (let i = 0; i < px.length; i++) a[i] = (px[i] >>> 24) > 128 ? 0xffe8f4ff : 0; return a }

const texStone = paint((g) => {
  const r = rnd(11); g.fillStyle = '#4a4f5c'; g.fillRect(0, 0, TEX, TEX)
  for (let row = 0; row < 4; row++) for (let col = -1; col < 3; col++) {
    const x = col * 32 + (row % 2 ? 16 : 0), y = row * 16, v = 70 + ((r() * 34) | 0)
    g.fillStyle = `rgb(${v},${v + 4},${v + 14})`; g.fillRect(x + 1, y + 1, 30, 14)
    g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(x + 1, y + 1, 30, 2)
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(x + 1, y + 13, 30, 2)
  }
  speckle(g, r, 260, ['rgba(0,0,0,.22)', 'rgba(255,255,255,.07)', 'rgba(30,40,70,.25)'])
})
const texTech = paint((g) => {
  const r = rnd(23); g.fillStyle = '#1f2937'; g.fillRect(0, 0, TEX, TEX)
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = '#334155'; g.fillRect(i * 32 + 2, j * 32 + 2, 28, 28)
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(i * 32 + 2, j * 32 + 2, 28, 2)
    g.fillStyle = '#0f172a'; for (const [dx, dy] of [[4, 4], [26, 4], [4, 26], [26, 26]]) g.fillRect(i * 32 + dx, j * 32 + dy, 2, 2)
  }
  g.fillStyle = '#0891b2'; g.fillRect(0, 29, TEX, 6); g.fillStyle = '#67e8f9'; g.fillRect(0, 31, TEX, 2)
  for (let x = 4; x < TEX; x += 12) { g.fillStyle = '#ecfeff'; g.fillRect(x, 31, 5, 2) }
  speckle(g, r, 120, ['rgba(0,0,0,.25)', 'rgba(148,163,184,.12)'])
})
const texHell = paint((g) => {
  const r = rnd(37); g.fillStyle = '#3b0a0a'; g.fillRect(0, 0, TEX, TEX)
  for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
    const x = col * 16 + (row % 2 ? 8 : 0), y = row * 8, v = 90 + ((r() * 60) | 0)
    g.fillStyle = `rgb(${v},${(v * 0.2) | 0},${(v * 0.16) | 0})`; g.fillRect(x + 1, y + 1, 14, 6)
  }
  g.strokeStyle = '#fb923c'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(8, 0); g.lineTo(14, 14); g.lineTo(9, 27); g.lineTo(20, 40); g.lineTo(15, 64); g.stroke()
  g.strokeStyle = '#fde047'; g.lineWidth = 0.6; g.beginPath(); g.moveTo(46, 0); g.lineTo(52, 20); g.lineTo(44, 36); g.lineTo(50, 64); g.stroke()
  speckle(g, r, 160, ['rgba(0,0,0,.3)', 'rgba(251,146,60,.18)'])
})
const texFloor = paint((g) => {
  const r = rnd(51); g.fillStyle = '#2a2622'; g.fillRect(0, 0, TEX, TEX)
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const v = 44 + ((r() * 14) | 0); g.fillStyle = `rgb(${v + 6},${v + 2},${v - 2})`; g.fillRect(i * 32 + 1, j * 32 + 1, 30, 30) }
  speckle(g, r, 420, ['rgba(0,0,0,.25)', 'rgba(255,240,220,.06)', 'rgba(120,20,20,.18)'])
})
const texCeil = paint((g) => {
  const r = rnd(67); g.fillStyle = '#16131c'; g.fillRect(0, 0, TEX, TEX)
  g.fillStyle = '#221d2c'; for (let i = 0; i < 4; i++) g.fillRect(i * 16 + 1, 0, 14, TEX)
  g.fillStyle = '#0c0a10'; for (let j = 0; j < TEX; j += 16) g.fillRect(0, j, TEX, 1)
  speckle(g, r, 200, ['rgba(0,0,0,.3)', 'rgba(167,139,250,.07)'])
})
const WALL_SHADES = { '#': shadeSet(texStone), '%': shadeSet(texTech), '=': shadeSet(texHell) }
const FLOOR_SHADES = shadeSet(texFloor), CEIL_SHADES = shadeSet(texCeil)

function demonArt(pose) {
  return paint((g) => {
    const arm = pose === 'a' ? [-2, 3] : pose === 'b' ? [3, -2] : [-9, -9]
    const leg = pose === 'a' ? [2, -2] : pose === 'b' ? [-2, 2] : [0, 0]
    const shape = (fill, grow) => {
      g.fillStyle = fill; g.strokeStyle = fill; g.lineWidth = grow * 2; g.lineJoin = 'round'
      const blob = (fn) => { g.beginPath(); fn(); g.closePath(); g.fill(); if (grow) g.stroke() }
      blob(() => g.ellipse(32, 41, 15, 16, 0, 0, 7))                         // body
      blob(() => g.ellipse(32, 21, 12, 11, 0, 0, 7))                         // head
      blob(() => { g.moveTo(22, 15); g.lineTo(13, 2); g.lineTo(27, 11) })    // horns
      blob(() => { g.moveTo(42, 15); g.lineTo(51, 2); g.lineTo(37, 11) })
      blob(() => g.rect(22 + leg[0] * 0, 54, 8, 9 + leg[0]))                 // legs
      blob(() => g.rect(34, 54, 8, 9 + leg[1]))
      blob(() => { g.moveTo(18, 32); g.lineTo(7, 42 + arm[0]); g.lineTo(4, 52 + arm[0]); g.lineTo(11, 50 + arm[0]); g.lineTo(21, 40) })  // arms
      blob(() => { g.moveTo(46, 32); g.lineTo(57, 42 + arm[1]); g.lineTo(60, 52 + arm[1]); g.lineTo(53, 50 + arm[1]); g.lineTo(43, 40) })
    }
    shape('#0b0306', 1.6)
    const grad = g.createLinearGradient(0, 8, 0, 60); grad.addColorStop(0, '#dc2626'); grad.addColorStop(1, '#7f1d1d')
    shape(grad, 0)
    g.fillStyle = '#fecaca'; g.globalAlpha = 0.18; g.beginPath(); g.ellipse(27, 36, 5, 8, -0.3, 0, 7); g.fill(); g.globalAlpha = 1
    g.fillStyle = '#f5f5f4'; for (const [a, b, c] of [[22, 15, 13], [42, 15, 51]]) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, 2); g.lineTo(a + (c < a ? 5 : -5), 11); g.closePath(); g.fill() }
    g.fillStyle = '#fde047'; g.shadowColor = '#f97316'; g.shadowBlur = 5
    g.beginPath(); g.ellipse(27, 19, 3.2, 2.4, 0.35, 0, 7); g.fill(); g.beginPath(); g.ellipse(37, 19, 3.2, 2.4, -0.35, 0, 7); g.fill(); g.shadowBlur = 0
    g.fillStyle = '#111'; g.fillRect(26.4, 18.2, 1.6, 2); g.fillRect(36.4, 18.2, 1.6, 2)
    const open = pose === 'atk' ? 7 : 3
    g.fillStyle = '#1c0408'; g.fillRect(25, 25, 14, open)
    g.fillStyle = '#fafaf9'; for (let x = 26; x < 38; x += 3) { g.beginPath(); g.moveTo(x, 25); g.lineTo(x + 1.5, 25 + Math.min(3, open)); g.lineTo(x + 3, 25); g.fill() }
    g.fillStyle = '#e7e5e4'; for (const [x, y] of [[4, 52 + arm[0]], [60, 52 + arm[1]]]) g.fillRect(x - 2, y, 4, 3)
  })
}
const pickupArt = (kind) => paint((g) => {
  g.fillStyle = '#0b0306'; g.fillRect(14, 28, 36, 30)
  if (kind === 'medkit') { g.fillStyle = '#f8fafc'; g.fillRect(16, 30, 32, 26); g.fillStyle = '#dc2626'; g.fillRect(28, 33, 8, 20); g.fillRect(22, 39, 20, 8) }
  else { g.fillStyle = '#3f6212'; g.fillRect(16, 30, 32, 26); g.fillStyle = '#a3e635'; g.fillRect(16, 30, 32, 4); g.fillStyle = '#facc15'; for (let x = 20; x < 46; x += 7) { g.fillRect(x, 40, 4, 12); g.fillStyle = '#b45309'; g.fillRect(x, 50, 4, 3); g.fillStyle = '#facc15' } }
})
const demonPx = { a: demonArt('a'), b: demonArt('b'), atk: demonArt('atk') }
const SPR = {
  a: shadeSet(demonPx.a), b: shadeSet(demonPx.b), atk: shadeSet(demonPx.atk), white: [whiten(demonPx.a)],
  medkit: shadeSet(pickupArt('medkit')), ammo: shadeSet(pickupArt('ammo')),
}

// ---------------------------------------------------------------- the raycaster
const PLANE = Math.tan((66 / 2) * Math.PI / 180)
let W = 480, H = 270, img = null, buf = null, zbuf = new Float32Array(W)
const wallAt = (x, y) => x < 0 || y < 0 || x >= mapW || y >= mapH ? '#' : map[y][x]
const solid = (c) => c === '#' || c === '%' || c === '='
const shadeOf = (d) => { const s = (d * 1.45) | 0; return s >= SHADES ? SHADES - 1 : s }

function resize() {
  const r = wrap.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1)
  scene.width = Math.max(320, Math.round(r.width * dpr)); scene.height = Math.max(180, Math.round(r.height * dpr))
  H = 270; W = Math.max(320, Math.min(640, Math.round((H * r.width) / Math.max(1, r.height) / 2) * 2))
  low.width = W; low.height = H
  img = lctx.createImageData(W, H); buf = new Uint32Array(img.data.buffer); zbuf = new Float32Array(W)
}
new ResizeObserver(resize).observe(wrap)

function render3d(px, py, pa, horizon, time) {
  const dirX = Math.cos(pa), dirY = Math.sin(pa), plX = -dirY * PLANE, plY = dirX * PLANE
  const proj = W / (2 * PLANE), camZ = proj / 2
  // floor and ceiling, one row at a time
  const rx0 = dirX - plX, ry0 = dirY - plY, rx1 = dirX + plX, ry1 = dirY + plY
  for (let y = 0; y < H; y++) {
    const p = y - horizon
    if (p === 0) { buf.fill(0xff0e0706, y * W, y * W + W); continue }
    const rowDist = camZ / Math.abs(p), tex = (p > 0 ? FLOOR_SHADES : CEIL_SHADES)[shadeOf(rowDist)]
    const sx = (rowDist * (rx1 - rx0)) / W, sy = (rowDist * (ry1 - ry0)) / W
    let fxp = px + rowDist * rx0, fyp = py + rowDist * ry0
    const o = y * W
    for (let x = 0; x < W; x++) {
      buf[o + x] = tex[((((fyp - Math.floor(fyp)) * TEX) & 63) << 6) | (((fxp - Math.floor(fxp)) * TEX) & 63)]
      fxp += sx; fyp += sy
    }
  }
  // walls
  for (let x = 0; x < W; x++) {
    const cam = (2 * x) / W - 1, rdx = dirX + plX * cam, rdy = dirY + plY * cam
    let mx = px | 0, my = py | 0
    const ddx = Math.abs(1 / (rdx || 1e-9)), ddy = Math.abs(1 / (rdy || 1e-9))
    const stx = rdx < 0 ? -1 : 1, sty = rdy < 0 ? -1 : 1
    let sdx = rdx < 0 ? (px - mx) * ddx : (mx + 1 - px) * ddx, sdy = rdy < 0 ? (py - my) * ddy : (my + 1 - py) * ddy
    let side = 0, tile = '#'
    for (let i = 0; i < 96; i++) {
      if (sdx < sdy) { sdx += ddx; mx += stx; side = 0 } else { sdy += ddy; my += sty; side = 1 }
      tile = wallAt(mx, my); if (solid(tile)) break
    }
    const perp = Math.max(0.02, side === 0 ? sdx - ddx : sdy - ddy)
    zbuf[x] = perp
    const lineH = proj / perp
    let u = side === 0 ? py + perp * rdy : px + perp * rdx; u -= Math.floor(u)
    let tx = (u * TEX) | 0; if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) tx = TEX - 1 - tx
    const tex = (WALL_SHADES[tile] ?? WALL_SHADES['#'])[Math.min(SHADES - 1, shadeOf(perp) + (side ? 3 : 0))]
    const top = horizon - lineH / 2, y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H - 1, Math.floor(top + lineH))
    const stepT = TEX / lineH
    let tp = (y0 - top) * stepT
    for (let y = y0; y <= y1; y++) { buf[y * W + x] = tex[(((tp | 0) & 63) << 6) | tx]; tp += stepT }
  }
  return { dirX, dirY, plX, plY, proj }
}

function drawSprite(cam, px, py, sx, sy, shades, heightTiles, horizon, liftTiles = 0, squash = 1) {
  const dx = sx - px, dy = sy - py
  const inv = 1 / (cam.plX * cam.dirY - cam.dirX * cam.plY)
  const tX = inv * (cam.dirY * dx - cam.dirX * dy), tY = inv * (-cam.plY * dx + cam.plX * dy)
  if (tY < 0.18) return null
  const unit = cam.proj / tY, hgt = unit * heightTiles * squash, wid = unit * heightTiles
  const cx = (W / 2) * (1 + tX / tY), floorY = horizon + unit / 2 - unit * liftTiles
  const left = cx - wid / 2, top = floorY - hgt
  const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W - 1, Math.floor(left + wid))
  const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H - 1, Math.floor(floorY))
  const tex = shades[Math.min(shades.length - 1, shadeOf(tY))]
  for (let x = x0; x <= x1; x++) {
    if (tY >= zbuf[x]) continue
    const tx = Math.min(63, ((x - left) / wid * TEX) | 0)
    for (let y = y0; y <= y1; y++) {
      const c = tex[(Math.min(63, ((y - top) / hgt * TEX) | 0) << 6) | tx]
      if ((c >>> 24) > 128) buf[y * W + x] = c
    }
  }
  return { cx, cy: floorY - hgt / 2, size: hgt, depth: tY }
}

function drawParticles(cam, px, py, horizon) {
  const inv = 1 / (cam.plX * cam.dirY - cam.dirX * cam.plY)
  for (const p of particles) {
    const dx = p.x - px, dy = p.y - py
    const tX = inv * (cam.dirY * dx - cam.dirX * dy), tY = inv * (-cam.plY * dx + cam.plX * dy)
    if (tY < 0.15) continue
    const x = ((W / 2) * (1 + tX / tY)) | 0, y = (horizon + (0.5 - p.z) * (cam.proj / tY)) | 0
    if (x < 1 || x >= W - 1 || y < 1 || y >= H - 1 || tY >= zbuf[x]) continue
    const s = tY < 2.5 ? 2 : 1
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) buf[(y + j) * W + x + i] = p.color
  }
}

// ---------------------------------------------------------------- effects
const rand = Math.random
function burst(x, y, z, n, colors, speed, life) {
  for (let i = 0; i < n && particles.length < 900; i++) {
    const a = rand() * 6.283, v = speed * (0.3 + rand())
    particles.push({ x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: (rand() - 0.2) * speed * 1.2, life: life * (0.5 + rand() * 0.7), color: colors[(rand() * colors.length) | 0] })
  }
}
const BLOOD = [0xff1c1cdc, 0xff1a1a99, 0xff4040f0, 0xff0c0c70], SPARK = [0xff47ccfa, 0xff9fe8fe, 0xff1590f9], TELE = [0xff5ee5a3, 0xff99f6e4, 0xffffffff], HEAL = [0xff7cf54a, 0xffffffff], SHELL = [0xff15ccfa, 0xffffffff]

function onEvents(f) {
  for (const ev of f.events || []) {
    if (ev.e === 'shot') {
      fx.flash = 1; fx.recoil = 1; fx.shake = Math.max(fx.shake, 0.35)
      fx.tracer = { x: ev.x, y: ev.y, t: 1 }
      if (ev.hit) burst(ev.x, ev.y, 0.5, ev.kill ? 46 : 14, BLOOD, ev.kill ? 2.6 : 1.6, 0.7); else burst(ev.x, ev.y, 0.5, 9, SPARK, 1.4, 0.35)
      if (ev.kill) { corpses.push({ x: ev.x, y: ev.y, t: 1 }); log('kill', `<b>Kill</b> · demon#${ev.hit} · ${f.player.kills}/${f.need}`) }
      sfx(ev.kill ? 'kill' : 'shot')
    } else if (ev.e === 'bite') { fx.hurt = 1; fx.shake = 1; sfx('bite') }
    else if (ev.e === 'spawn') burst(ev.x, ev.y, 0.45, 26, TELE, 1.2, 0.8)
    else if (ev.e === 'pickup') { fx.pickup = 1; fx.pickupKind = ev.kind; burst(f.player.x, f.player.y, 0.3, 16, ev.kind === 'medkit' ? HEAL : SHELL, 1, 0.6); log('', `<b>Picked up</b> ${ev.kind}`); sfx('pickup') }
    else if (ev.e === 'dead') { log('dead', `<b>Jev died</b> on wave ${f.wave} with ${f.player.kills} kills`); sfx('dead') }
    else if (ev.e === 'cleared') { log('wave', `<b>Wave ${f.wave} cleared</b> · next one is faster`); sfx('pickup') }
    else if (ev.e === 'click') sfx('click')
  }
}
function log(cls, html) {
  feed.push({ cls, html }); if (feed.length > 60) feed.shift()
  const ul = $('feed'), li = document.createElement('li'); li.className = cls; li.innerHTML = html
  ul.prepend(li); while (ul.children.length > 40) ul.lastChild.remove()
}

// ---------------------------------------------------------------- sound (off until asked for)
let audio = null
$('sound').onclick = () => {
  if (audio) { audio.close(); audio = null } else audio = new (window.AudioContext || window.webkitAudioContext)()
  $('sound').textContent = audio ? 'Sound on' : 'Sound off'; $('sound').classList.toggle('on', !!audio)
}
function sfx(kind) {
  if (!audio) return
  const t = audio.currentTime, g = audio.createGain(); g.connect(audio.destination)
  const tone = (type, f0, f1, dur, vol) => { const o = audio.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); o.start(t); o.stop(t + dur) }
  if (kind === 'shot') tone('square', 190, 40, 0.13, 0.16)
  else if (kind === 'kill') tone('sawtooth', 260, 30, 0.4, 0.2)
  else if (kind === 'bite') tone('sawtooth', 90, 50, 0.2, 0.22)
  else if (kind === 'pickup') tone('triangle', 520, 1040, 0.16, 0.14)
  else if (kind === 'dead') tone('sawtooth', 200, 22, 1.1, 0.25)
  else tone('square', 900, 700, 0.04, 0.06)
}

// ---------------------------------------------------------------- HUD drawing (full resolution)
const lerp = (a, b, t) => a + (b - a) * t
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t }
let miniRect = null
const THREAT = [['CALM', '#34d399'], ['WATCHFUL', '#fbbf24'], ['PRESSED', '#fb923c'], ['CRITICAL', '#fb7185']]

function drawWeapon(time, moving) {
  const bob = moving ? Math.sin(time * 0.011) * 6 : Math.sin(time * 0.002) * 1.5, dip = moving ? Math.abs(Math.cos(time * 0.011)) * 5 : 0
  const cx = Math.round(W / 2 + bob), by = Math.round(H - 26 + dip + fx.recoil * 22)
  const R = (c, x, y, w, h) => { lctx.fillStyle = c; lctx.fillRect(cx + x, by + y, w, h) }
  if (fx.flash > 0.2) {
    lctx.save(); lctx.translate(cx, by - 84); lctx.rotate(time * 0.05)
    lctx.fillStyle = '#fff7c2'; lctx.beginPath(); for (let i = 0; i < 14; i++) { const r = i % 2 ? 9 : 30 * fx.flash + 8, an = (i / 14) * 6.283; lctx.lineTo(Math.cos(an) * r, Math.sin(an) * r) } lctx.fill()
    lctx.fillStyle = '#fb923c'; lctx.beginPath(); lctx.arc(0, 0, 9, 0, 7); lctx.fill()
    lctx.fillStyle = '#fff'; lctx.beginPath(); lctx.arc(0, 0, 4, 0, 7); lctx.fill(); lctx.restore()
  }
  // barrels (perspective: narrow at the muzzle, wide at the breech)
  for (let i = 0; i < 40; i++) { const w = 9 + i * 0.36, y = -80 + i * 2; R('#08080a', -w - 2, y, (w + 2) * 2, 2); R('#52525b', -w, y, w - 1, 2); R('#3f3f46', 1, y, w - 1, 2); R('#a1a1aa', -w + 1, y, 2, 2); R('#71717a', 2, y, 2, 2) }
  R('#08080a', -11, -82, 22, 3); R('#18181b', -8, -81, 6, 3); R('#18181b', 2, -81, 6, 3)
  // wooden fore-end and the two hands
  R('#08080a', -27, -30, 54, 30); R('#7c2d12', -25, -28, 50, 26); R('#9a3412', -25, -28, 50, 4); R('#5b1f0b', -25, -8, 50, 6)
  for (let i = 0; i < 5; i++) R('#5b1f0b', -21 + i * 10, -22, 2, 12)
  R('#08080a', -44, -8, 30, 56); R('#d6a77a', -42, -6, 26, 54); R('#b8865a', -42, 6, 26, 4); R('#b8865a', -42, 18, 26, 4); R('#e8c19c', -42, -6, 5, 54)
  R('#08080a', 18, 2, 30, 46); R('#d6a77a', 20, 4, 26, 44); R('#b8865a', 20, 16, 26, 4); R('#b8865a', 20, 28, 26, 4)
}

function keycap(x, y, w, h, label, p, on, color) {
  ctx.fillStyle = 'rgba(8,9,14,.72)'; ctx.strokeStyle = on ? color : 'rgba(255,255,255,.22)'; ctx.lineWidth = on ? 2.5 : 1
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill()
  if (p > 0.01) { ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.clip(); ctx.fillStyle = color; ctx.globalAlpha = on ? 0.85 : 0.35; ctx.fillRect(x, y + h * (1 - p), w, h * p); ctx.restore() }
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.stroke()
  ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,.6)'; ctx.font = `700 ${Math.round(h * 0.36)}px ui-monospace,Menlo,monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(label, x + w / 2, y + h / 2 + 1)
}

function drawHud(f, p, time) {
  const cw = scene.width, ch = scene.height, u = Math.max(0.6, Math.min(1.5, ch / 520, cw / 980))
  const mono = (px, w = 700) => `${w} ${Math.round(px * u)}px ui-monospace,'SF Mono',Menlo,monospace`
  ctx.textBaseline = 'alphabetic'
  // damage and pickup washes, low-health pulse
  if (fx.hurt > 0.02) { const g = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.25, cw / 2, ch / 2, ch * 0.8); g.addColorStop(0, 'rgba(220,38,38,0)'); g.addColorStop(1, `rgba(220,38,38,${0.75 * fx.hurt})`); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch) }
  if (f.player.hp < 35 && f.status === 'playing') { ctx.fillStyle = `rgba(220,38,38,${0.10 + 0.08 * Math.sin(time * 0.008)})`; ctx.fillRect(0, 0, cw, ch) }
  if (fx.pickup > 0.02) { ctx.fillStyle = fx.pickupKind === 'medkit' ? `rgba(74,222,128,${0.3 * fx.pickup})` : `rgba(250,204,21,${0.3 * fx.pickup})`; ctx.fillRect(0, 0, cw, ch) }
  // crosshair
  const on = f.crosshair != null, cx = cw / 2, cy = ch / 2, r = 9 * u
  ctx.strokeStyle = on ? '#f87171' : 'rgba(255,255,255,.8)'; ctx.lineWidth = 2 * u; ctx.shadowColor = on ? '#ef4444' : 'transparent'; ctx.shadowBlur = on ? 14 : 0
  ctx.beginPath(); for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(cx + ax * r * 0.45, cy + ay * r * 0.45); ctx.lineTo(cx + ax * r * 1.5, cy + ay * r * 1.5) } ctx.stroke()
  if (on) { ctx.beginPath(); ctx.arc(cx, cy, r * 2.1, 0, 7); ctx.stroke() } ctx.shadowBlur = 0

  // bottom status bar
  const barH = 58 * u, y0 = ch - barH
  const g = ctx.createLinearGradient(0, y0 - 20 * u, 0, ch); g.addColorStop(0, 'rgba(5,6,10,0)'); g.addColorStop(0.35, 'rgba(5,6,10,.78)'); g.addColorStop(1, 'rgba(5,6,10,.92)'); ctx.fillStyle = g; ctx.fillRect(0, y0 - 20 * u, cw, barH + 20 * u)
  const cell = (x, label, value, color, frac) => {
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = mono(10, 600); ctx.fillText(label, x, y0 + 16 * u)
    ctx.fillStyle = color; ctx.font = mono(27); ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.fillText(value, x, y0 + 45 * u); ctx.shadowBlur = 0
    if (frac != null) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x, y0 + 50 * u, 96 * u, 3 * u); ctx.fillStyle = color; ctx.fillRect(x, y0 + 50 * u, 96 * u * Math.max(0, Math.min(1, frac)), 3 * u) }
  }
  const right = cw - 18 * u
  const hp = Math.round(p.hp)
  cell(right - 330 * u, 'HEALTH', String(hp), hp < 35 ? '#fb7185' : hp < 70 ? '#fbbf24' : '#34d399', hp / 100)
  cell(right - 215 * u, 'AMMO', String(f.player.ammo), f.player.ammo < 10 ? '#fb7185' : '#fde047', f.player.ammo / 99)
  cell(right - 100 * u, `WAVE ${f.wave}`, `${f.player.kills}/${f.need}`, '#f87171', f.player.kills / Math.max(1, f.need))

  // Jev's keys: the move choice as W A S D, the turn choice as a seven-step bar, fire as a button
  const d = f.decision || {}, mv = d.probs?.move || {}, tn = d.probs?.turn || {}, human = f.driver === 'human'
  const k = 34 * u, gap = 5 * u, kx = 18 * u, ky = ch - barH + 8 * u - k - gap
  const col = human ? '#fbbf24' : '#a78bfa'
  keycap(kx + k + gap, ky, k, k, 'W', mv.FORWARD ?? 0, d.move === 'FORWARD', col)
  keycap(kx, ky + k + gap, k, k, 'A', mv.STRAFE_LEFT ?? 0, d.move === 'STRAFE_LEFT', col)
  keycap(kx + k + gap, ky + k + gap, k, k, 'S', mv.BACK ?? 0, d.move === 'BACK', col)
  keycap(kx + 2 * (k + gap), ky + k + gap, k, k, 'D', mv.STRAFE_RIGHT ?? 0, d.move === 'STRAFE_RIGHT', col)
  const tx0 = kx + 3 * (k + gap) + 14 * u, names = ['LEFT_HARD', 'LEFT', 'LEFT_FINE', 'AHEAD', 'RIGHT_FINE', 'RIGHT', 'RIGHT_HARD'], glyph = ['«', '‹', '·', '↑', '·', '›', '»']
  names.forEach((n, i) => keycap(tx0 + i * (k * 0.72 + gap), ky + k + gap, k * 0.72, k, glyph[i], tn[n] ?? 0, d.turn === n, col))
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = mono(10, 600)
  ctx.fillText(human ? 'YOU HAVE THE CONTROLS' : "JEV'S KEYS  ·  fill = probability", tx0, ky + k * 0.62)
  const fxk = tx0 + 7 * (k * 0.72 + gap) + 10 * u
  keycap(fxk, ky + k + gap, k * 2.1, k, 'FIRE', d.pFire ?? 0, !!d.fire, '#f87171')

  // threat read-out, top left
  const lv = Math.max(0, Math.min(3, Math.round(d.threat ?? 0))), [tl, tc] = THREAT[lv]
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(8,9,14,.7)'; ctx.beginPath(); ctx.roundRect(14 * u, 14 * u, 190 * u, 44 * u, 8); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = mono(9.5, 600); ctx.fillText("JEV'S THREAT READ", 24 * u, 30 * u)
  ctx.fillStyle = tc; ctx.font = mono(16); ctx.fillText(tl, 24 * u, 49 * u)
  for (let i = 0; i < 4; i++) { ctx.fillStyle = i <= lv ? tc : 'rgba(255,255,255,.15)'; ctx.fillRect((140 + i * 14) * u, 38 * u, 10 * u, 12 * u) }

  drawMinimap(f, p, u)

  // banners
  if (f.status !== 'playing') {
    const dead = f.status === 'dead'
    ctx.fillStyle = dead ? 'rgba(60,4,8,.55)' : 'rgba(4,40,24,.45)'; ctx.fillRect(0, 0, cw, ch)
    ctx.textAlign = 'center'; ctx.fillStyle = dead ? '#fb7185' : '#34d399'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 24; ctx.font = mono(44)
    ctx.fillText(dead ? 'JEV DIED' : `WAVE ${f.wave} CLEARED`, cw / 2, ch * 0.42); ctx.shadowBlur = 0
    ctx.fillStyle = '#e9ecf5'; ctx.font = mono(15, 600)
    ctx.fillText(dead ? `wave ${f.wave} · ${f.player.kills} kills this wave · restarting in ${Math.ceil(f.statusLeftMs / 1000)}` : `next wave: one more demon, 12% faster · starts in ${Math.ceil(f.statusLeftMs / 1000)}`, cw / 2, ch * 0.42 + 34 * u)
  }
  if (paused) { ctx.textAlign = 'center'; ctx.fillStyle = '#fbbf24'; ctx.font = mono(15); ctx.fillText('PAUSED · press Step to advance one decision', cw / 2, 34 * u) }
}

function drawMinimap(f, p, u) {
  const cw = scene.width, cell = Math.max(3, Math.floor(Math.min((cw * 0.25) / mapW, (scene.height * 0.34) / mapH)))
  const w = cell * mapW, h = cell * mapH, x0 = cw - w - 14 * u, y0 = 14 * u
  miniRect = { x: x0, y: y0, w, h, cell }
  ctx.fillStyle = 'rgba(6,7,12,.78)'; ctx.beginPath(); ctx.roundRect(x0 - 6, y0 - 6, w + 12, h + 12, 8); ctx.fill()
  for (let y = 0; y < mapH; y++) for (let x = 0; x < mapW; x++) {
    const c = map[y][x]; if (!solid(c)) continue
    ctx.fillStyle = c === '#' ? '#475569' : c === '%' ? '#0e7490' : '#9f1239'; ctx.fillRect(x0 + x * cell, y0 + y * cell, cell - 0.5, cell - 0.5)
  }
  if (f.route?.length > 1) {
    ctx.strokeStyle = f.routeKind === 'demon' ? 'rgba(248,113,113,.55)' : 'rgba(74,222,128,.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.beginPath()
    f.route.forEach(([x, y], i) => { const X = x0 + (x + 0.5) * cell, Y = y0 + (y + 0.5) * cell; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y) }); ctx.stroke(); ctx.setLineDash([])
  }
  for (const k of f.pickups) { if (!k.on) continue; ctx.fillStyle = k.k === 'medkit' ? '#4ade80' : '#facc15'; ctx.fillRect(x0 + k.x * cell - 2, y0 + k.y * cell - 2, 4, 4) }
  for (const d of p.demons) { ctx.fillStyle = d.id === f.crosshair ? '#fff' : '#ef4444'; ctx.beginPath(); ctx.arc(x0 + d.x * cell, y0 + d.y * cell, Math.max(2.2, cell * 0.32), 0, 7); ctx.fill() }
  const X = x0 + p.x * cell, Y = y0 + p.y * cell, half = (33 * Math.PI) / 180
  ctx.fillStyle = 'rgba(167,139,250,.22)'; ctx.beginPath(); ctx.moveTo(X, Y); ctx.arc(X, Y, cell * 5, p.a - half, p.a + half); ctx.closePath(); ctx.fill()
  ctx.fillStyle = f.driver === 'human' ? '#fbbf24' : '#c4b5fd'; ctx.beginPath(); ctx.moveTo(X + Math.cos(p.a) * cell * 0.75, Y + Math.sin(p.a) * cell * 0.75); ctx.lineTo(X + Math.cos(p.a + 2.5) * cell * 0.55, Y + Math.sin(p.a + 2.5) * cell * 0.55); ctx.lineTo(X + Math.cos(p.a - 2.5) * cell * 0.55, Y + Math.sin(p.a - 2.5) * cell * 0.55); ctx.closePath(); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = `600 ${Math.round(10 * u)}px ui-monospace,Menlo,monospace`; ctx.textAlign = 'right'
  ctx.fillText(`click: ${tool === 'spawn' ? 'spawn a demon' : 'drop ' + tool}`, x0 + w, y0 + h + 16 * u)
}

// ---------------------------------------------------------------- the frame loop
let lastT = performance.now()
function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  if (!next || !buf) return
  const f = next, a = prev && prev.mapRev === next.mapRev ? Math.max(0, Math.min(1, (now - nextAt) / Math.max(40, f.tickMs))) : 1
  const from = prev && prev.mapRev === next.mapRev ? prev : next
  const p = {
    x: lerp(from.player.x, f.player.x, a), y: lerp(from.player.y, f.player.y, a), a: lerpAngle(from.player.a, f.player.a, a), hp: lerp(from.player.hp, f.player.hp, a),
    demons: f.demons.map((d) => { const o = from.demons.find((q) => q.id === d.id); return o ? { ...d, x: lerp(o.x, d.x, a), y: lerp(o.y, d.y, a) } : d }),
  }
  for (const k of ['flash', 'recoil', 'hurt', 'shake', 'pickup']) fx[k] = Math.max(0, fx[k] - dt * (k === 'flash' ? 11 : k === 'recoil' ? 7 : k === 'shake' ? 5 : 2.2))
  for (let i = particles.length - 1; i >= 0; i--) { const q = particles[i]; q.life -= dt; if (q.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue } q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; q.vz -= 2.6 * dt; if (q.z < 0.02) { q.z = 0.02; q.vz *= -0.35; q.vx *= 0.6; q.vy *= 0.6 } }
  for (let i = corpses.length - 1; i >= 0; i--) { corpses[i].t -= dt * 2.4; if (corpses[i].t <= 0) corpses.splice(i, 1) }

  const moving = f.player.moving && f.status === 'playing' && !paused
  const horizon = Math.round(H / 2 + (moving ? Math.sin(now * 0.011) * 2.2 : 0) + (rand() - 0.5) * fx.shake * 9 - fx.recoil * 3)
  const cam = render3d(p.x, p.y, p.a, horizon, now)
  const sprites = []
  for (const k of f.pickups) if (k.on) sprites.push({ x: k.x, y: k.y, sh: SPR[k.k], h: 0.42, lift: 0.02 + Math.sin(now * 0.004 + k.id) * 0.03, sq: 1 })
  for (const d of p.demons) sprites.push({ x: d.x, y: d.y, sh: d.hurt ? SPR.white : d.st === 'attack' ? SPR.atk : (Math.floor(now / 170) + d.id) % 2 ? SPR.a : SPR.b, h: 0.92, lift: 0, sq: 1 })
  for (const c of corpses) sprites.push({ x: c.x, y: c.y, sh: SPR.white, h: 0.92, lift: 0, sq: Math.max(0.05, c.t) })
  sprites.sort((s1, s2) => ((s2.x - p.x) ** 2 + (s2.y - p.y) ** 2) - ((s1.x - p.x) ** 2 + (s1.y - p.y) ** 2))
  for (const s of sprites) drawSprite(cam, p.x, p.y, s.x, s.y, s.sh, s.h, horizon, s.lift, s.sq)
  drawParticles(cam, p.x, p.y, horizon)
  lctx.putImageData(img, 0, 0)
  if (fx.tracer && fx.tracer.t > 0) {
    fx.tracer.t -= dt * 14
    lctx.strokeStyle = `rgba(255,236,160,${Math.max(0, fx.tracer.t)})`; lctx.lineWidth = 1.5; lctx.beginPath(); lctx.moveTo(W / 2 + 4, H - 66); lctx.lineTo(W / 2, horizon + 2); lctx.stroke()
  }
  if (fx.flash > 0.1) { lctx.fillStyle = `rgba(255,214,120,${0.13 * fx.flash})`; lctx.fillRect(0, 0, W, H) }
  if (f.status !== 'dead') drawWeapon(now, moving)

  ctx.imageSmoothingEnabled = false
  const sx = (rand() - 0.5) * fx.shake * 12
  ctx.drawImage(low, 0, 0, W, H, sx, 0, scene.width, scene.height)
  drawHud(f, p, now)
}

// ---------------------------------------------------------------- wiring
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
function paintStateText(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  $('stateText').innerHTML = text.split('\n').slice(1).map((l) => {
    l = esc(l)
    if (l.startsWith('crosshair on: demon')) return `<span class="bad">${l}</span>`
    if (/BITING/.test(l)) return `<span class="bad">${l}</span>`
    if (l.startsWith('  demon#')) return `<span class="hl">${l}</span>`
    if (l.startsWith('route')) return `<span class="ok">${l}</span>`
    return l
  }).join('\n')
}
function onFrame(f, full) {
  if (full || f.mapRev !== mapRev) {
    if (!f.map) { fetch('/state').then((r) => r.json()).then((s) => onFrame(s, true)).catch(() => {}); if (mapRev < 0) return }
    else { map = f.map; mapH = map.length; mapW = map[0].length; mapRev = f.mapRev; prev = null; particles.length = 0; corpses.length = 0 }
  }
  prev = next; next = f; nextAt = performance.now()
  onEvents(f)
  paused = !f.running
  $('title').textContent = f.title
  $('s-wave').textContent = f.wave; $('s-kills').textContent = f.session.kills; $('s-deaths').textContent = f.session.deaths; $('s-best').textContent = f.session.bestWave
  $('s-acc').textContent = f.session.shots ? Math.round((f.session.hits / f.session.shots) * 100) + '%' : '—'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  $('driver').textContent = f.driver === 'human' ? 'YOU' : 'JEV'; $('driver').classList.toggle('human', f.driver === 'human')
  const problem = f.cfgError || f.mapError || f.error
  $('cfgError').classList.toggle('hidden', !problem); $('cfgError').textContent = problem ? `level.json: ${problem} — still running on the last good level.` : ''
  if (document.activeElement !== $('speed')) { const base = f.demonSpeed / (1 + 0.12 * (f.wave - 1)); $('speed').value = base; $('speedVal').textContent = base.toFixed(1) }
  paintStateText(f.stateText || '')
}

const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('swarm').onclick = () => post({ cmd: 'swarm' })
$('speed').oninput = (e) => { $('speedVal').textContent = Number(e.target.value).toFixed(1); post({ cmd: 'set', key: 'demonSpeed', value: Number(e.target.value) }) }
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => { tool = b.dataset.tool; document.querySelectorAll('[data-tool]').forEach((o) => o.classList.toggle('on', o === b)) }
scene.addEventListener('click', (e) => {
  scene.focus()
  if (!miniRect) return
  const r = scene.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * scene.width, y = ((e.clientY - r.top) / r.height) * scene.height
  if (x < miniRect.x || y < miniRect.y || x > miniRect.x + miniRect.w || y > miniRect.y + miniRect.h) return
  const cx = (x - miniRect.x) / miniRect.cell, cy = (y - miniRect.y) / miniRect.cell
  post(tool === 'spawn' ? { cmd: 'spawn', x: cx, y: cy } : { cmd: 'medkit', kind: tool, x: cx, y: cy })
})

// Human takeover: while a key is held, the person's input replaces Jev's. Jev keeps answering, so
// the lit keys still show what it WOULD do.
const held = new Set()
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ShiftRight'])
function sendHuman() {
  if (![...held].some((k) => !k.startsWith('Shift'))) return
  const hard = held.has('ShiftLeft') || held.has('ShiftRight')
  const turn = held.has('ArrowLeft') ? (hard ? 'LEFT_HARD' : 'LEFT') : held.has('ArrowRight') ? (hard ? 'RIGHT_HARD' : 'RIGHT') : 'AHEAD'
  const move = held.has('KeyW') || held.has('ArrowUp') ? 'FORWARD' : held.has('KeyS') || held.has('ArrowDown') ? 'BACK' : held.has('KeyA') ? 'STRAFE_LEFT' : held.has('KeyD') ? 'STRAFE_RIGHT' : 'HOLD'
  post({ cmd: 'human', turn, move, fire: held.has('Space') })
}
window.addEventListener('keydown', (e) => { if (!KEYS.has(e.code) || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) return; e.preventDefault(); held.add(e.code); sendHuman() })
window.addEventListener('keyup', (e) => { held.delete(e.code) })
window.addEventListener('blur', () => held.clear())
setInterval(sendHuman, 90)

async function pollJev() {
  try { const s = await (await fetch('/jev', { cache: 'no-store' })).json(); $('s-rate').textContent = s.callsPerSec.toFixed(1); $('s-cost').textContent = fmtMoney(s.costUsd); $('s-dec').textContent = s.calls.toLocaleString() } catch { /* restarting */ }
  setTimeout(pollJev, 500)
}

resize()
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data), false))
fetch('/state').then((r) => r.json()).then((s) => onFrame(s, true)).catch(() => {})
pollJev()
requestAnimationFrame(loop)
