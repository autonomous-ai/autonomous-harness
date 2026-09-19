// Jev Arena pane. The server sends one frame per decision (the move Jev chose, the full probability
// over the five moves, what the hero has seen, the route the step counts point along). This file draws
// it at 60 fps and eases everything between frames: the hero hops, coins spin and pop, walls rise and
// sink, the fog lifts, and Jev's mind sits on the board as arrows sized by probability.
'use strict'

const $ = (id) => document.getElementById(id)
const canvas = $('board'), wrap = $('wrap'), ctx = canvas.getContext('2d')
const DIR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], wait: [0, 0] }
const SEE_ALL = 99
const TAU = Math.PI * 2

let F = null // latest frame from the server
let W = 0, H = 0, dpr = 1, cell = 40, ox = 0, oy = 0, lift = 12
let tool = 'wall', paused = false, hover = null, drag = null, downAt = null
let wallH = new Float32Array(0), wallDelay = new Float32Array(0), lit = new Float32Array(0)
let lastAt = -1, lastEpisode = -1, lastStatus = 'play', dims = '', decisionAt = 0, lastNow = 0, lastText = '', lastFeed = ''
const coins = new Map() // "x,y" -> { x, y, born, phase }
const particles = [], floaters = [], rings = []
const hero = { fx: 1, fy: 1, tx: 1, ty: 1, t0: 0, dur: 200, think: 0, kind: 'idle', face: [0, 1], landed: 1 }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const easeOut = (t) => 1 - (1 - t) ** 3
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const backOut = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2
const px = (x) => ox + x * cell
const py = (y) => oy + y * cell
const cx = (x) => ox + (x + 0.5) * cell
const cy = (y) => oy + (y + 0.5) * cell
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmtMoney = (v) => (v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2))

// ---------------------------------------------------------------- layout
function fit() {
  const r = wrap.getBoundingClientRect()
  W = Math.max(50, r.width); H = Math.max(50, r.height)
  dpr = Math.min(2.5, window.devicePixelRatio || 1)
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
  if (F) place()
}
function place() {
  const top = 40, side = 26, bottom = 30
  cell = Math.max(6, Math.floor(Math.min((W - side * 2) / F.w, (H - top - bottom) / (F.h + 0.34))))
  lift = cell * 0.34
  ox = Math.round((W - cell * F.w) / 2)
  oy = Math.round(top + lift + (H - top - bottom - lift - cell * F.h) / 2)
}
new ResizeObserver(fit).observe(wrap)

// ---------------------------------------------------------------- effects
function burst(x, y, n, colors, speed = 1, grav = 0.0009) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = (0.04 + Math.random() * 0.16) * speed * (cell / 40)
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.08 * speed * (cell / 40), life: 0, max: 500 + Math.random() * 600, size: 1.5 + Math.random() * 2.6, color: colors[i % colors.length], grav })
  }
  if (particles.length > 600) particles.splice(0, particles.length - 600)
}
const ring = (x, y, color, max = 1.4, dur = 600) => rings.push({ x, y, color, max, dur, t0: performance.now() })
const floater = (x, y, text, color) => floaters.push({ x, y, text, color, t0: performance.now() })

// ---------------------------------------------------------------- frames
function onFrame(f) {
  const now = performance.now()
  const newDims = `${f.w}x${f.h}` !== dims
  const prev = F
  F = f
  if (newDims) {
    dims = `${f.w}x${f.h}`
    wallH = new Float32Array(f.w * f.h); wallDelay = new Float32Array(f.w * f.h); lit = new Float32Array(f.w * f.h)
    coins.clear(); place()
  }
  const newLayout = newDims || f.episode !== lastEpisode
  if (newLayout) {
    // Walls rise in a ripple that starts under the hero.
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) wallDelay[y * f.w + x] = now + (Math.abs(x - f.hero[0]) + Math.abs(y - f.hero[1])) * 26
    if (prev) ring(cx(f.hero[0]), cy(f.hero[1]), '#5ee0c0', 3.2, 900)
  }
  // coins: pop the one Jev just took, fade the rest that went away, grow the new ones
  const have = new Set(f.coins.map(([x, y]) => `${x},${y}`))
  for (const [k, c] of coins) {
    if (have.has(k)) continue
    coins.delete(k)
    if (f.last?.coin && `${f.last.coin[0]},${f.last.coin[1]}` === k && !newLayout) {
      burst(cx(c.x), cy(c.y) - cell * 0.1, 18, ['#ffce6b', '#fff3c4', '#f59e0b'], 1.1)
      ring(cx(c.x), cy(c.y), '#ffce6b', 1.1, 450)
      floater(cx(c.x), cy(c.y) - cell * 0.3, '+1', '#ffce6b')
    } else if (!newLayout) burst(cx(c.x), cy(c.y), 6, ['#8b92aa'], 0.5)
  }
  for (const [x, y] of f.coins) {
    const k = `${x},${y}`
    if (!coins.has(k)) {
      const late = newLayout ? (Math.abs(x - f.hero[0]) + Math.abs(y - f.hero[1])) * 26 + 200 : 0
      coins.set(k, { x, y, born: now + late, phase: (x * 7 + y * 13) % 6 })
      if (!newLayout) ring(cx(x), cy(y), '#ffce6b', 0.9, 400)
    }
  }
  // walls a person just built or broke puff some dust
  if (prev && !newLayout) for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (prev.walls[y]?.[x] !== f.walls[y][x]) { wallDelay[y * f.w + x] = 0; burst(cx(x), cy(y), 8, ['#7f8ab0', '#4a5270'], 0.6) }
  if (prev && !newLayout && (prev.goal[0] !== f.goal[0] || prev.goal[1] !== f.goal[1])) ring(cx(f.goal[0]), cy(f.goal[1]), '#34d399', 1.6, 700)
  // the hero
  if (f.last && f.last.at !== lastAt) {
    lastAt = f.last.at; decisionAt = now
    const d = DIR[f.last.move] ?? DIR.wait
    const at = heroPos(now), near = Math.abs(at.x - f.last.from[0]) + Math.abs(at.y - f.last.from[1]) < 1.6
    hero.fx = near ? at.x : f.last.from[0]; hero.fy = near ? at.y : f.last.from[1]; hero.tx = f.last.to[0]; hero.ty = f.last.to[1]
    // Think first (the arrows show), then hop.
    hero.think = clamp(f.speed * 0.28, 0, 170); hero.t0 = now + hero.think; hero.dur = clamp(f.speed * 0.5, 70, 260)
    hero.kind = f.last.bumped ? 'bump' : f.last.move === 'wait' ? 'wait' : 'hop'
    if (f.last.move !== 'wait') hero.face = d
    if (f.last.bumped) burst(cx(hero.fx) + d[0] * cell * 0.5, cy(hero.fy) + d[1] * cell * 0.5, 8, ['#fb7185', '#fbbf24'], 0.7)
  } else if (hero.tx !== f.hero[0] || hero.ty !== f.hero[1] || !f.last) {
    if (hero.tx !== f.hero[0] || hero.ty !== f.hero[1]) ring(cx(f.hero[0]), cy(f.hero[1]), '#7aa2ff', 1.5, 600)
    hero.fx = hero.tx = f.hero[0]; hero.fy = hero.ty = f.hero[1]; hero.kind = 'idle'
    if (!f.last) lastAt = -1
  }
  if (f.status !== lastStatus || newLayout) {
    if (f.status === 'won' && lastStatus === 'play') {
      const gx = cx(f.goal[0]), gy = cy(f.goal[1])
      burst(gx, gy - cell * 0.4, 70, ['#34d399', '#5ee0c0', '#ffce6b', '#7aa2ff', '#ffffff'], 1.7, 0.0006)
      ring(gx, gy, '#34d399', 2.6, 900); ring(gx, gy, '#ffffff', 1.6, 600)
    } else if ((f.status === 'stuck' || f.status === 'timeout') && lastStatus === 'play') {
      ring(cx(f.hero[0]), cy(f.hero[1]), '#fb7185', 2.2, 900)
    }
  }
  lastStatus = f.status; lastEpisode = f.episode
  paint(f)
}

function paint(f) {
  paused = !f.running
  $('title').textContent = f.title
  $('description').textContent = f.description; $('description').title = f.description
  $('rules').textContent = f.rules ? `Rules: ${f.rules}` : ''
  $('s-run').textContent = f.episode + 1
  $('s-goals').textContent = f.totals.goals
  $('s-coins').textContent = f.totals.coins
  $('s-moves').textContent = `${f.moves} / ${f.par}`
  $('s-eff').textContent = f.totals.wonMoves ? Math.round((f.totals.wonPar / f.totals.wonMoves) * 100) + '%' : '—'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const head = $('heading'); head.textContent = f.heading === 'none' ? 'NO WAY' : 'TO THE ' + f.heading.toUpperCase(); head.className = 'right pill ' + f.heading
  if (document.activeElement !== $('sight')) { $('sight').value = f.sight >= SEE_ALL ? 11 : Math.min(10, f.sight); $('sightVal').textContent = f.sight >= SEE_ALL ? 'all' : f.sight }
  if (document.activeElement !== $('speed')) { $('speed').value = f.speed; $('speedVal').textContent = f.speed + ' ms' }
  if (document.activeElement !== $('density')) { $('density').value = Math.round(f.density * 100); $('densityVal').textContent = Math.round(f.density * 100) + '%' }
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still running on the last good world.` : ''
  const b = $('banner')
  if (f.status === 'play') b.classList.add('hidden')
  else {
    const next = f.remix ? 'A new layout is coming.' : 'Playing it again.'
    const text = f.status === 'won'
      ? `Goal reached in ${f.result.moves} moves <small>shortest way ${f.result.par} · ${f.result.coins}/${f.result.coinsTotal} coins · ${next}</small>`
      : f.status === 'stuck' ? `Walled in. There is no way to the goal. <small>${next}</small>` : `Out of moves. <small>${next}</small>`
    if (b.dataset.key !== `${f.episode}:${f.status}`) { b.dataset.key = `${f.episode}:${f.status}`; b.innerHTML = text; b.className = 'banner ' + (f.status === 'won' ? 'ok' : 'bad') }
    b.classList.remove('hidden')
  }
  if (f.stateText !== lastText) {
    lastText = f.stateText
    $('stateText').innerHTML = f.stateText.split('\n').map((line) => {
      if (/^[.#$G@?]+$/.test(line)) return `<span class="grid">${[...line].map((c) => (c === '#' ? '<span class="w">#</span>' : c === '$' ? '<span class="c">$</span>' : c === 'G' ? '<span class="g">G</span>' : c === '@' ? '<span class="h">@</span>' : c === '?' ? '<span class="q">?</span>' : c)).join('')}</span>`
      const on = (f.heading === 'coin' && /^Steps to the nearest coin/.test(line)) || (f.heading === 'goal' && /^Steps to the goal/.test(line))
      return on ? `<span class="n">${esc(line)}</span>\n` : esc(line) + '\n'
    }).join('').replace(/\n(<span class="grid">)/g, '$1').replace(/(<\/span>)\n?(?=<span class="grid">)/g, '$1')
  }
  const feedKey = JSON.stringify(f.totals.results)
  if (feedKey !== lastFeed) {
    lastFeed = feedKey
    $('feed').innerHTML = f.totals.results.length
      ? [...f.totals.results].reverse().map((r) => `<li class="${r.status}">Run ${r.episode + 1} · <b>${r.status === 'won' ? 'goal' : r.status === 'stuck' ? 'walled in' : 'out of moves'}</b> · ${r.moves} moves, shortest ${r.par} · ${r.coins}/${r.coinsTotal} coins</li>`).join('')
      : '<li class="empty">No run has finished yet.</li>'
  }
}

// ---------------------------------------------------------------- drawing
function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect && r > 0.5) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h) }

function heroPos(now) {
  const t = clamp((now - hero.t0) / hero.dur, 0, 1)
  let x = hero.tx, y = hero.ty, hop = 0, squash = 0
  if (now < hero.t0 && hero.kind !== 'idle') return { x: hero.fx, y: hero.fy, hop: 0, squash: hero.kind === 'hop' ? -0.1 * (1 - (hero.t0 - now) / Math.max(1, hero.think)) : 0 }
  if (hero.kind === 'hop') {
    const e = easeInOut(t)
    x = lerp(hero.fx, hero.tx, e); y = lerp(hero.fy, hero.ty, e); hop = Math.sin(Math.PI * t) * 0.38
    squash = t < 1 ? Math.sin(Math.PI * t) * 0.12 : -Math.max(0, 1 - (now - hero.t0 - hero.dur) / 110) * 0.16
  } else if (hero.kind === 'bump') {
    const k = Math.sin(Math.PI * t) * 0.28
    x = hero.tx + hero.face[0] * k; y = hero.ty + hero.face[1] * k
  } else if (hero.kind === 'wait') hop = Math.sin(Math.PI * t) * 0.08
  if (hero.kind === 'hop' && t >= 1 && !hero.landed) { hero.landed = 1; burst(cx(hero.tx), cy(hero.ty) + cell * 0.26, 4, ['rgba(160,175,215,.55)'], 0.35, 0) }
  if (t < 1) hero.landed = 0
  return { x, y, hop, squash }
}

function drawFloor(now, hp) {
  const { w, h } = F
  // the slab the world stands on
  const bw = w * cell, bh = h * cell
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18
  ctx.fillStyle = '#080b15'; rr(ox - 9, oy - 9, bw + 18, bh + 18 + cell * 0.2, 12); ctx.fill()
  ctx.restore()
  ctx.strokeStyle = 'rgba(94,224,192,.16)'; ctx.lineWidth = 1; rr(ox - 8.5, oy - 8.5, bw + 17, bh + 17, 11); ctx.stroke()
  const gap = cell > 16 ? 1 : 0, rad = cell > 22 ? 3 : 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lit[y * w + x], alt = (x + y) & 1
    const r = Math.round(lerp(alt ? 14 : 12, alt ? 27 : 24, l)), g = Math.round(lerp(alt ? 18 : 16, alt ? 37 : 33, l)), b = Math.round(lerp(alt ? 33 : 30, alt ? 68 : 61, l))
    ctx.fillStyle = `rgb(${r},${g},${b})`
    rr(px(x) + gap, py(y) + gap, cell - gap * 2, cell - gap * 2, rad); ctx.fill()
  }
  // the hero's light
  if (F.sight < SEE_ALL) {
    const R = (F.sight + 1.2) * cell, gx = cx(hp.x), gy = cy(hp.y)
    const grad = ctx.createRadialGradient(gx, gy, cell * 0.2, gx, gy, R)
    grad.addColorStop(0, 'rgba(120,235,205,.24)'); grad.addColorStop(0.55, 'rgba(94,160,224,.09)'); grad.addColorStop(1, 'rgba(94,160,224,0)')
    ctx.save(); rr(ox, oy, bw, bh, 4); ctx.clip()
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = grad; ctx.fillRect(gx - R, gy - R, R * 2, R * 2)
    ctx.restore()
  }
}

function drawTrail() {
  const t = F.trail, n = t.length
  for (let i = 0; i < n; i++) {
    const [x, y] = t[i], [nx, ny] = i + 1 < n ? t[i + 1] : [hero.tx, hero.ty]
    const dx = Math.sign(nx - x), dy = Math.sign(ny - y)
    const a = ((i + 1) / n) ** 1.4 * 0.7, side = i % 2 ? 1 : -1
    ctx.save(); ctx.translate(cx(x) + -dy * side * cell * 0.1, cy(y) + dx * side * cell * 0.1); ctx.rotate(Math.atan2(dy, dx))
    ctx.fillStyle = `rgba(122,162,255,${a})`
    ctx.beginPath(); ctx.ellipse(0, 0, cell * 0.1, cell * 0.055, 0, 0, TAU); ctx.fill()
    ctx.restore()
  }
}

function drawPlan(now) {
  const p = F.plan
  if (!p.length || F.status !== 'play') return
  const flow = (now / 90) % 8
  for (let i = 0; i < p.length; i++) {
    const [x, y] = p[i], known = lit[y * F.w + x] > 0.5
    const pulse = 0.55 + 0.45 * Math.sin((i * 8 - flow * TAU) / 8)
    ctx.fillStyle = known ? `rgba(140,176,255,${0.45 + 0.5 * pulse})` : `rgba(251,191,36,${0.4 + 0.5 * pulse})`
    ctx.beginPath(); ctx.arc(cx(x), cy(y), Math.max(1.6, cell * (known ? 0.085 : 0.07)), 0, TAU); ctx.fill()
  }
  // a turning reticle on what Jev is heading for
  const [tx, ty] = p[p.length - 1]
  ctx.save(); ctx.translate(cx(tx), cy(ty)); ctx.rotate(now / 700)
  ctx.strokeStyle = F.heading === 'coin' ? 'rgba(255,206,107,.8)' : 'rgba(52,211,153,.8)'; ctx.lineWidth = Math.max(1.5, cell * 0.04)
  for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(0, 0, cell * 0.44, k * TAU / 4 + 0.25, k * TAU / 4 + TAU / 4 - 0.25); ctx.stroke() }
  ctx.restore()
}

function drawMind(now) {
  const L = F.last
  if (!L || !L.probabilities) return
  const fade = clamp((now - decisionAt) / 110, 0, 1)
  const fx = cx(L.from[0]), fy = cy(L.from[1])
  ctx.save()
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `600 ${Math.max(9, Math.round(cell * 0.19))}px ui-monospace, Menlo, monospace`
  for (const [name, d] of Object.entries(DIR)) {
    const p = L.probabilities[name] ?? 0
    if (p < 0.025) continue
    const chosen = name === L.move
    const alpha = (0.2 + 0.8 * p ** 0.7) * fade
    if (name === 'wait') {
      ctx.strokeStyle = chosen ? `rgba(94,224,192,${alpha})` : `rgba(159,180,255,${alpha})`
      ctx.lineWidth = Math.max(1.5, cell * 0.1 * Math.sqrt(p)); ctx.beginPath(); ctx.arc(fx, fy, cell * 0.43, 0, TAU); ctx.stroke()
      continue
    }
    const s = cell * (0.1 + 0.25 * Math.sqrt(p)), ax = fx + d[0] * cell * 0.95, ay = fy + d[1] * cell * 0.95
    const qx = -d[1], qy = d[0]
    ctx.beginPath()
    ctx.moveTo(ax + d[0] * s, ay + d[1] * s)
    ctx.lineTo(ax - d[0] * s * 0.7 + qx * s * 0.85, ay - d[1] * s * 0.7 + qy * s * 0.85)
    ctx.lineTo(ax - d[0] * s * 0.25, ay - d[1] * s * 0.25)
    ctx.lineTo(ax - d[0] * s * 0.7 - qx * s * 0.85, ay - d[1] * s * 0.7 - qy * s * 0.85)
    ctx.closePath()
    if (chosen) { ctx.shadowColor = '#5ee0c0'; ctx.shadowBlur = 16 * fade; ctx.fillStyle = `rgba(94,224,192,${alpha})` } else { ctx.shadowBlur = 0; ctx.fillStyle = `rgba(159,180,255,${alpha * 0.9})` }
    ctx.fill(); ctx.shadowBlur = 0
    if (p >= 0.1 && cell >= 26) {
      ctx.fillStyle = chosen ? `rgba(214,255,244,${fade})` : `rgba(200,210,245,${0.75 * fade})`
      if (d[0]) ctx.fillText(Math.round(p * 100) + '%', ax, ay + s * 0.85 + cell * 0.17)
      else { ctx.textAlign = 'left'; ctx.fillText(Math.round(p * 100) + '%', ax + s * 0.85 + cell * 0.08, ay); ctx.textAlign = 'center' }
    }
  }
  ctx.restore()
}

function drawWall(x, y, hgt, l) {
  const X = px(x), top = py(y) - lift * hgt, south = y + 1 < F.h && wallH[(y + 1) * F.w + x] > 0.5
  if (!south) { ctx.fillStyle = 'rgba(0,0,0,.34)'; ctx.fillRect(X, py(y) + cell, cell, lift * 0.55 * hgt) }
  ctx.fillStyle = `rgb(${Math.round(lerp(13, 30, l))},${Math.round(lerp(17, 41, l))},${Math.round(lerp(32, 80, l))})`
  ctx.fillRect(X, top + cell, cell, lift * hgt) // front face
  const g = ctx.createLinearGradient(0, top, 0, top + cell)
  g.addColorStop(0, `rgb(${Math.round(lerp(26, 74, l))},${Math.round(lerp(32, 96, l))},${Math.round(lerp(54, 160, l))})`)
  g.addColorStop(1, `rgb(${Math.round(lerp(21, 56, l))},${Math.round(lerp(27, 74, l))},${Math.round(lerp(47, 128, l))})`)
  ctx.fillStyle = g; ctx.fillRect(X, top, cell, cell)
  ctx.fillStyle = `rgba(255,255,255,${(((x * 31 + y * 17) % 5) / 5) * 0.05 * l})`; ctx.fillRect(X, top, cell, cell)
  ctx.fillStyle = `rgba(190,215,255,${lerp(0.05, 0.3, l)})`; ctx.fillRect(X, top, cell, Math.max(1, cell * 0.05)); ctx.fillRect(X, top, Math.max(1, cell * 0.04), cell)
  ctx.fillStyle = `rgba(4,6,14,${lerp(0.2, 0.3, l)})`; ctx.fillRect(X, top + cell * 0.94, cell, cell * 0.06)
  ctx.strokeStyle = `rgba(8,10,20,${lerp(0.5, 0.35, l)})`; ctx.lineWidth = 1; ctx.strokeRect(X + 0.5, top + 0.5, cell - 1, cell - 1)
}

function drawCoin(c, now) {
  const age = now - c.born
  if (age < 0) return
  const grow = age < 360 ? backOut(age / 360) : 1
  const spin = Math.cos(now / 380 + c.phase), bob = Math.sin(now / 520 + c.phase) * cell * 0.04
  const x = cx(c.x), y = cy(c.y) - cell * 0.1 + bob, r = cell * 0.24 * grow
  const dim = 0.72 + 0.28 * lit[c.y * F.w + c.x]
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x, cy(c.y) + cell * 0.27, r * 0.8, r * 0.26, 0, 0, TAU); ctx.fill()
  ctx.save(); ctx.globalAlpha = dim; ctx.shadowColor = '#ffce6b'; ctx.shadowBlur = cell * 0.35
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r); g.addColorStop(0, '#fff1bd'); g.addColorStop(0.5, '#ffce6b'); g.addColorStop(1, '#c78412')
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, Math.max(1.2, Math.abs(spin) * r), r, 0, 0, TAU); ctx.fill()
  ctx.shadowBlur = 0
  if (Math.abs(spin) > 0.35) { ctx.strokeStyle = 'rgba(122,74,6,.55)'; ctx.lineWidth = Math.max(1, r * 0.13); ctx.beginPath(); ctx.ellipse(x, y, Math.abs(spin) * r * 0.62, r * 0.62, 0, 0, TAU); ctx.stroke() }
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.ellipse(x - r * 0.3 * spin, y - r * 0.4, r * 0.12, r * 0.2, 0.5, 0, TAU); ctx.fill()
  ctx.restore()
}

function star(x, y, r, rot) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) { const rad = i % 2 ? r * 0.45 : r, a = rot + (i * Math.PI) / 5 - Math.PI / 2; ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad) }
  ctx.closePath()
}

function drawGoal(gx, gy, now, ghost = false) {
  const x = cx(gx), y = cy(gy), power = ghost ? 0.5 : F.heading === 'goal' || F.status === 'won' ? 1 : 0.6
  ctx.fillStyle = `rgba(52,211,153,${0.16 * power})`; rr(px(gx) + 2, py(gy) + 2, cell - 4, cell - 4, 5); ctx.fill()
  ctx.strokeStyle = `rgba(52,211,153,${0.5 * power})`; ctx.lineWidth = 1.5; rr(px(gx) + 2.5, py(gy) + 2.5, cell - 5, cell - 5, 5); ctx.stroke()
  for (let k = 0; k < 2; k++) {
    const t = ((now / 1600 + k / 2) % 1)
    ctx.strokeStyle = `rgba(52,211,153,${(1 - t) * 0.55 * power})`; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(x, y + cell * 0.1, cell * (0.2 + t * 0.55), cell * (0.1 + t * 0.26), 0, 0, TAU); ctx.stroke()
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  const beamH = cell * 3.2, bw = cell * 0.62 * (0.9 + 0.1 * Math.sin(now / 210))
  const g = ctx.createLinearGradient(0, y, 0, y - beamH); g.addColorStop(0, `rgba(52,211,153,${0.5 * power})`); g.addColorStop(1, 'rgba(52,211,153,0)')
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - bw / 2, y + cell * 0.1); ctx.lineTo(x + bw / 2, y + cell * 0.1); ctx.lineTo(x + bw * 0.32, y - beamH); ctx.lineTo(x - bw * 0.32, y - beamH); ctx.closePath(); ctx.fill()
  ctx.restore()
  ctx.save(); ctx.shadowColor = '#34d399'; ctx.shadowBlur = cell * 0.5 * power; ctx.fillStyle = ghost ? 'rgba(52,211,153,.55)' : '#5ff0b8'
  star(x, y - cell * 0.2 + Math.sin(now / 430) * cell * 0.06, cell * 0.36, now / 1100); ctx.fill()
  ctx.restore()
}

function drawHero(hp, now) {
  const L = F.last, conf = L ? L.confidence : 0.5
  const x = cx(hp.x), gy = cy(hp.y) + cell * 0.2, y = cy(hp.y) - hp.hop * cell - cell * 0.04, r = cell * 0.3
  const breathe = paused || F.status !== 'play' ? Math.sin(now / 420) * 0.03 : 0
  // shadow
  ctx.fillStyle = `rgba(0,0,0,${0.42 - hp.hop * 0.5})`
  ctx.beginPath(); ctx.ellipse(x, gy + cell * 0.08, r * (0.95 - hp.hop * 0.7), r * 0.3 * (1 - hp.hop * 0.7), 0, 0, TAU); ctx.fill()
  // confidence halo: tight and green when sure, wide and amber when torn
  const col = conf > 0.62 ? '94,224,192' : '251,191,36'
  ctx.strokeStyle = `rgba(${col},${0.25 + conf * 0.5})`; ctx.lineWidth = Math.max(1.5, cell * 0.045)
  ctx.beginPath(); ctx.arc(x, y, r * (1.62 - conf * 0.3) + Math.sin(now / 160) * cell * 0.02 * (1 - conf) * 4, 0, TAU); ctx.stroke()
  ctx.save(); ctx.translate(x, y); ctx.scale(1 - hp.squash + breathe, 1 + hp.squash - breathe)
  ctx.shadowColor = '#5ee0c0'; ctx.shadowBlur = cell * 0.45
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.45, r * 0.1, 0, 0, r * 1.05); g.addColorStop(0, '#d9fff5'); g.addColorStop(0.45, '#5ee0c0'); g.addColorStop(1, '#16806b')
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.shadowBlur = 0
  // antenna
  ctx.strokeStyle = '#9af3dd'; ctx.lineWidth = Math.max(1, cell * 0.035); ctx.beginPath(); ctx.moveTo(0, -r * 0.9); ctx.lineTo(0, -r * 1.45); ctx.stroke()
  ctx.fillStyle = Math.sin(now / 200) > 0 ? '#fbbf24' : '#fff3c4'; ctx.beginPath(); ctx.arc(0, -r * 1.5, r * 0.13, 0, TAU); ctx.fill()
  // visor and eyes that look where it is going
  const ex = hero.face[0] * r * 0.22, ey = hero.face[1] * r * 0.16
  ctx.fillStyle = '#06231d'; rr(-r * 0.68 + ex * 0.5, -r * 0.34 + ey * 0.5, r * 1.36, r * 0.62, r * 0.3); ctx.fill()
  const blink = (now % 3400) < 110 ? 0.15 : 1
  ctx.fillStyle = '#eafff9'; ctx.shadowColor = '#eafff9'; ctx.shadowBlur = 6
  ctx.beginPath(); ctx.ellipse(-r * 0.3 + ex, -r * 0.04 + ey, r * 0.13, r * 0.17 * blink, 0, 0, TAU); ctx.fill()
  ctx.beginPath(); ctx.ellipse(r * 0.3 + ex, -r * 0.04 + ey, r * 0.13, r * 0.17 * blink, 0, 0, TAU); ctx.fill()
  ctx.restore()
}

function drawHover() {
  if (drag) {
    ctx.strokeStyle = 'rgba(52,211,153,.9)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); rr(px(drag.x) + 2, py(drag.y) + 2, cell - 4, cell - 4, 5); ctx.stroke(); ctx.setLineDash([])
    return
  }
  if (!hover || F.status !== 'play') return
  const { x, y } = hover, isWall = F.walls[y][x] === '#', isGoal = F.goal[0] === x && F.goal[1] === y
  const isHero = F.hero[0] === x && F.hero[1] === y, isCoin = coins.has(`${x},${y}`)
  if (isHero) return
  let color = 'rgba(159,180,255,.9)'
  if (isGoal) color = 'rgba(52,211,153,.95)'
  else if (tool === 'wall') color = isWall ? 'rgba(251,113,133,.95)' : isCoin ? 'rgba(139,146,170,.5)' : 'rgba(159,180,255,.95)'
  else color = isWall ? 'rgba(139,146,170,.5)' : 'rgba(255,206,107,.95)'
  const top = isWall ? py(y) - lift : py(y)
  ctx.strokeStyle = color; ctx.lineWidth = 2; rr(px(x) + 1.5, top + 1.5, cell - 3, cell - 3, 5); ctx.stroke()
  if (tool === 'wall' && !isWall && !isGoal && !isCoin) { ctx.fillStyle = 'rgba(122,162,255,.22)'; ctx.fillRect(px(x), py(y) - lift, cell, cell + lift) }
  if (tool === 'coin' && !isWall && !isGoal && !isCoin) { ctx.fillStyle = 'rgba(255,206,107,.4)'; ctx.beginPath(); ctx.arc(cx(x), cy(y) - cell * 0.1, cell * 0.22, 0, TAU); ctx.fill() }
}

function draw(now) {
  requestAnimationFrame(draw)
  if (!F || !W) return
  const dt = Math.min(50, now - (lastNow || now)); lastNow = now
  const { w, h } = F
  // ease walls and fog toward the server's truth
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, target = F.walls[y][x] === '#' ? 1 : 0
    if (now >= wallDelay[i]) wallH[i] += (target - wallH[i]) * Math.min(1, dt * 0.014)
    const see = F.seen[y][x] === '1' ? 1 : 0
    lit[i] += (see - lit[i]) * Math.min(1, dt * (see ? 0.012 : 0.005))
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H * 0.45, Math.max(W, H) * 0.75)
  bg.addColorStop(0, '#0d1224'); bg.addColorStop(1, '#03040a')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)

  const hp = heroPos(now)
  drawFloor(now, hp)
  drawTrail()
  drawPlan(now)
  drawMind(now)
  const goalRow = drag ? -1 : F.goal[1], heroRow = Math.round(hp.y)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { const i = y * w + x; if (wallH[i] > 0.02) drawWall(x, y, wallH[i], 0.18 + 0.82 * lit[i]) }
    for (const c of coins.values()) if (c.y === y) drawCoin(c, now)
    if (goalRow === y) drawGoal(F.goal[0], F.goal[1], now)
    if (heroRow === y) drawHero(hp, now)
  }
  if (drag) drawGoal(drag.x, drag.y, now, true)
  drawHover()

  // rings, particles, floating text
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i], t = (now - r.t0) / r.dur
    if (t >= 1) { rings.splice(i, 1); continue }
    ctx.strokeStyle = r.color; ctx.globalAlpha = (1 - t) * 0.8; ctx.lineWidth = 2.5 * (1 - t) + 0.5
    ctx.beginPath(); ctx.arc(r.x, r.y, cell * (0.3 + easeOut(t) * r.max), 0, TAU); ctx.stroke()
  }
  ctx.globalAlpha = 1
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life += dt
    if (p.life >= p.max) { particles.splice(i, 1); continue }
    p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt
    ctx.globalAlpha = 1 - p.life / p.max; ctx.fillStyle = p.color
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (cell / 44), 0, TAU); ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i], t = (now - f.t0) / 900
    if (t >= 1) { floaters.splice(i, 1); continue }
    ctx.globalAlpha = 1 - t * t; ctx.fillStyle = f.color; ctx.font = `700 ${Math.round(cell * 0.36)}px ui-monospace, Menlo, monospace`
    ctx.fillText(f.text, f.x, f.y - easeOut(t) * cell * 0.9)
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- the person plays
const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
function tileAt(e) {
  if (!F) return null
  const r = canvas.getBoundingClientRect()
  const x = Math.floor((e.clientX - r.left - ox) / cell), y = Math.floor((e.clientY - r.top - oy) / cell)
  return x >= 0 && y >= 0 && x < F.w && y < F.h ? { x, y } : null
}
canvas.addEventListener('pointermove', (e) => {
  hover = tileAt(e)
  if (drag && hover) { drag.x = hover.x; drag.y = hover.y }
  const onGoal = hover && F && hover.x === F.goal[0] && hover.y === F.goal[1]
  wrap.style.cursor = drag ? 'grabbing' : onGoal ? 'grab' : hover ? 'pointer' : 'default'
})
canvas.addEventListener('pointerleave', () => { hover = null })
canvas.addEventListener('pointerdown', (e) => {
  const t = tileAt(e); downAt = t
  if (t && F && F.status === 'play' && t.x === F.goal[0] && t.y === F.goal[1]) { drag = { ...t }; try { canvas.setPointerCapture(e.pointerId) } catch { /* a synthetic pointer has nothing to capture */ } }
})
canvas.addEventListener('pointerup', (e) => {
  const t = tileAt(e)
  if (drag) { if (t && (t.x !== F.goal[0] || t.y !== F.goal[1])) post({ cmd: 'goal', x: t.x, y: t.y }); drag = null }
  else if (t && downAt && t.x === downAt.x && t.y === downAt.y) post({ cmd: tool, x: t.x, y: t.y })
  downAt = null
})
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => { tool = b.dataset.tool; for (const o of document.querySelectorAll('[data-tool]')) o.classList.toggle('on', o === b) }
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('remix').onclick = () => post({ cmd: 'remix' })
$('sight').oninput = (e) => { const v = Number(e.target.value); $('sightVal').textContent = v >= 11 ? 'all' : v; post({ cmd: 'set', key: 'sight', value: v >= 11 ? SEE_ALL : v }) }
$('speed').oninput = (e) => { $('speedVal').textContent = e.target.value + ' ms'; post({ cmd: 'set', key: 'speed', value: Number(e.target.value) }) }
$('density').oninput = (e) => { $('densityVal').textContent = e.target.value + '%' }
$('density').onchange = (e) => { post({ cmd: 'set', key: 'density', value: Number(e.target.value) / 100 }); e.target.blur() }
for (const id of ['sight', 'speed']) $(id).onchange = (e) => e.target.blur()

async function pollJev() {
  try {
    const s = await (await fetch('/jev', { cache: 'no-store' })).json()
    $('s-rate').textContent = s.callsPerSec.toFixed(1); $('s-dec').textContent = s.calls.toLocaleString('en-US'); $('s-cost').textContent = fmtMoney(s.costUsd)
  } catch { /* viewer restarting */ }
  setTimeout(pollJev, 300)
}

fit()
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
pollJev()
requestAnimationFrame(draw)
