// Jev Duel pane. The server sends one frame per move: the board, the move that just landed with the
// disks it turned (nearest first), the referee's call, and the NEXT player's full answer. This file
// turns that into: a disk drops, the turned disks flip over one after the other in 3D, sparks fly,
// and the next player's mind appears on the board as dots, as strong as each move's probability.
'use strict'

const $ = (id) => document.getElementById(id)
const boardEl = $('board'), stage = $('stage'), fx = $('fx'), fxc = fx.getContext('2d'), spark = $('spark'), sc = spark.getContext('2d')
const READS = ['only how many disks each move flips', 'the flips, and where each square sits', 'the flips, the square, and the rival\'s reply']
const TAU = Math.PI * 2

let F = null, cells = [], size = 0, lastN = -1, lastGame = -1, paused = false
let W = 0, H = 0, dpr = 1, lastNow = 0, frameAt = 0, lastText = '', lastRef = '', lastGames = '', celebrate = 0
let sparkGrow = 1
const particles = [], rings = [], beams = [], timers = []

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmtMoney = (v) => (v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2))
const COLOR = { O: '#38bdf8', X: '#fb7185' }
const callOf = (r) => (r.strong >= 1.4 ? ['brilliant', 'good'] : r.strong >= 0.6 ? ['solid', 'mid'] : ['blunder', 'poor'])

// ---------------------------------------------------------------- layout
function fit() {
  const r = stage.getBoundingClientRect()
  W = r.width; H = r.height; dpr = Math.min(2.5, window.devicePixelRatio || 1)
  fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr)
  const s = spark.getBoundingClientRect()
  spark.width = Math.max(10, Math.round(s.width * dpr)); spark.height = Math.max(10, Math.round(s.height * dpr))
  sizeBoard(); drawSpark()
}
function sizeBoard() {
  if (!size) return
  const a = $('arena').getBoundingClientRect()
  const units = size + 0.11 * (size - 1) + 0.44
  const narrow = a.width < 900
  const room = a.width - 2 * (narrow ? 150 : 190) - 2 * (narrow ? 10 : 16)
  const cell = clamp(Math.floor(Math.min((a.height - 26) / units, room / units)), 18, 92)
  document.documentElement.style.setProperty('--cell', cell + 'px')
}
new ResizeObserver(fit).observe(stage)

function build(n) {
  size = n; cells = []
  boardEl.textContent = ''
  boardEl.style.gridTemplateColumns = `repeat(${n}, var(--cell))`
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const c = document.createElement('div'); c.className = 'cell'; c.setAttribute('role', 'gridcell')
    c.innerHTML = '<div class="disk"><div class="face fo"></div><div class="face fx"></div></div><div class="dot"></div><span class="pct"></span>'
    c.addEventListener('click', () => { if (c.classList.contains('legal')) post({ cmd: 'play', x, y }) })
    boardEl.appendChild(c)
    cells.push({ el: c, disk: c.firstChild, pct: c.lastChild, v: '.' })
  }
  sizeBoard()
}
const cellAt = (x, y) => cells[y * size + x]
function centre(x, y) {
  const r = cellAt(x, y).el.getBoundingClientRect(), s = stage.getBoundingClientRect()
  return [r.left - s.left + r.width / 2, r.top - s.top + r.height / 2, r.width]
}

// ---------------------------------------------------------------- effects
function burst(x, y, n, colors, speed = 1, grav = 0.0007) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = (0.05 + Math.random() * 0.2) * speed
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.06 * speed, life: 0, max: 450 + Math.random() * 700, size: 1.4 + Math.random() * 2.4, color: colors[i % colors.length], grav })
  }
  if (particles.length > 900) particles.splice(0, particles.length - 900)
}
const later = (ms, fn) => timers.push(setTimeout(fn, ms))
function clearTimers() { for (const t of timers) clearTimeout(t); timers.length = 0 }

// ---------------------------------------------------------------- frames
function setDisk(c, v, how, i = 0) {
  c.v = v
  c.disk.className = 'disk' + (v === 'O' ? ' is-o' : v === 'X' ? ' is-x' : '') + (how ? ' ' + how : '')
  c.disk.style.setProperty('--i', i)
}

function onFrame(f) {
  const prev = F
  F = f; frameAt = performance.now()
  if (f.size !== size) build(f.size)
  const last = f.history.length ? f.history[f.history.length - 1] : null
  const fresh = !prev || f.game !== lastGame || f.size !== prev.size || f.moveCount < lastN || f.moveCount - lastN > 1
  if (fresh) { clearTimers(); celebrate = 0 }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = cellAt(x, y), v = f.board[y][x]
    c.el.classList.toggle('last', !!last && last.x === x && last.y === y)
    if (v === c.v && !fresh) continue
    if (fresh || !last || f.moveCount === lastN) { setDisk(c, v, v !== '.' && fresh && prev ? 'placed' : ''); continue }
    if (last.x === x && last.y === y) setDisk(c, v, 'placed')
    else { const i = last.flipped.findIndex((p) => p[0] === x && p[1] === y); setDisk(c, v, 'flipping', Math.max(0, i)) }
  }
  if (!fresh && last && f.moveCount !== lastN) {
    // the disk is thrown in from its player's card, then each turned disk sparks as it flips
    const [px, py, cw] = centre(last.x, last.y), col = COLOR[last.disk]
    const card = $(last.disk === 'O' ? 'cardO' : 'cardX').getBoundingClientRect(), s = stage.getBoundingClientRect()
    beams.push({ x0: card.left - s.left + card.width / 2, y0: card.top - s.top + 40, x1: px, y1: py, color: col, t0: performance.now() })
    rings.push({ x: px, y: py, r: cw * 0.5, color: last.human ? '#fbbf24' : '#ffffff', t0: performance.now(), dur: 600 })
    burst(px, py, 10, [col, '#ffffff'], 0.8)
    last.flipped.forEach(([x, y], i) => later(140 + i * 85 + 240, () => { const [qx, qy] = centre(x, y); burst(qx, qy, 7, [col, '#ffffff'], 0.6) }))
    sparkGrow = 0
  }
  if (f.gameOver && (!prev || !prev.gameOver)) celebrate = performance.now()
  lastN = f.moveCount; lastGame = f.game
  paintMind(f); paint(f); drawSpark()
}

/** The player to move has already answered. Its whole probability spread goes on the board. */
function paintMind(f) {
  const p = f.gameOver ? null : f.pending
  const max = p ? Math.max(...p.moves.map((m) => m.p), 1e-6) : 1
  const map = new Map((p?.moves ?? []).map((m) => [`${m.x},${m.y}`, m]))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = cellAt(x, y), m = map.get(`${x},${y}`)
    c.el.classList.toggle('legal', !!m)
    c.el.classList.toggle('for-o', !!m && p.disk === 'O'); c.el.classList.toggle('for-x', !!m && p.disk === 'X')
    c.el.classList.toggle('chosen', !!m && p.choice[0] === x && p.choice[1] === y)
    if (m) {
      c.el.style.setProperty('--a', (0.16 + 0.84 * (m.p / max) ** 0.8).toFixed(3))
      c.el.style.setProperty('--s', (0.4 + 0.6 * Math.sqrt(m.p / max)).toFixed(3))
      c.pct.textContent = m.p >= 0.06 ? Math.round(m.p * 100) : ''
      c.el.title = `${x},${y} flips ${m.flips} · Jev gives it ${Math.round(m.p * 100)}% · click to play it yourself`
    } else { c.pct.textContent = ''; c.el.removeAttribute('title') }
  }
  boardEl.className = f.gameOver ? '' : f.toMove === 'O' ? 'turn-o' : 'turn-x'
}

function paint(f) {
  paused = !f.running
  $('title').textContent = f.title; $('title').title = f.description || ''
  $('s-game').textContent = f.game; $('s-move').textContent = f.moveCount
  $('s-wins').innerHTML = `<b class="o">${f.totals.winsO}</b> – <b class="x">${f.totals.winsX}</b>`
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still playing on the last good settings.` : ''
  for (const d of ['O', 'X']) {
    const r = f.rivals[d], card = $('card' + d), pts = $('pts' + d)
    $('name' + d).textContent = r.name; $('name' + d).title = r.name
    if (pts.textContent !== String(f.counts[d])) { pts.textContent = f.counts[d]; pts.classList.remove('bump'); void pts.offsetWidth; pts.classList.add('bump') }
    $('persona' + d).textContent = r.personality; $('persona' + d).title = r.personality
    const mine = !f.gameOver && f.toMove === d
    card.classList.toggle('turn', mine)
    card.classList.toggle('won', f.gameOver && f.winner === d); card.classList.toggle('lost', f.gameOver && !!f.winner && f.winner !== d)
    $('state' + d).textContent = f.gameOver ? (f.winner === d ? 'wins this game' : f.winner ? '' : 'draw') : mine ? (f.pending ? `thinking · top move ${Math.round(f.pending.confidence * 100)}%` : 'has no move, passes') : 'waiting'
    if (document.activeElement !== $('insight' + d)) $('insight' + d).value = r.insight
    $('insight' + d + 'Val').textContent = r.insight; $('insight' + d + 'Hint').textContent = READS[r.insight]
    const mv = [...f.history].reverse().find((h) => h.disk === d)
    $('last' + d).innerHTML = mv ? `last <b>${mv.x},${mv.y}</b> +${mv.flips} · ${callOf(mv.ref)[0]}${mv.human ? ' · you' : ''}` : '&nbsp;'
  }
  const total = f.size * f.size
  $('terO').style.width = (f.counts.O / total) * 100 + '%'; $('terX').style.width = (f.counts.X / total) * 100 + '%'
  $('terE').style.width = ((total - f.counts.O - f.counts.X) / total) * 100 + '%'
  $('terNum').textContent = `${f.counts.O} · ${f.counts.X}`
  for (const b of document.querySelectorAll('[data-size]')) b.classList.toggle('on', Number(b.dataset.size) === f.size)
  if (document.activeElement !== $('speed')) { $('speed').value = f.speed; $('speedVal').textContent = f.speed + ' ms' }
  // referee
  $('ref-focus').textContent = f.refereeFocus; $('ref-focus').title = f.refereeFocus
  const lastMv = f.history[f.history.length - 1]
  const pill = $('refCall')
  if (lastMv) { const [word, cls] = callOf(lastMv.ref); pill.textContent = `${word} · ${lastMv.ref.decided >= 1.4 ? 'decided' : lastMv.ref.decided >= 0.6 ? 'leaning' : 'wide open'}`; pill.className = 'right pill ' + cls } else { pill.textContent = '—'; pill.className = 'right pill' }
  const refKey = `${f.game}:${f.moveCount}`
  if (refKey !== lastRef) {
    lastRef = refKey
    $('ref-log').innerHTML = [...f.history].reverse().slice(0, 14).map((m) => {
      const [word, cls] = callOf(m.ref)
      return `<li class="${m.human ? 'you' : ''}"><span class="n">#${m.n}</span><span class="mv"><b class="${m.disk.toLowerCase()}">${esc(m.side)}</b> ${m.x},${m.y} +${m.flips}</span><span class="call ${cls}">${word} · ${m.ref.aggressive >= 0.55 ? 'bold' : 'quiet'}</span></li>`
    }).join('')
  }
  // what the player to move reads
  $('readsWho').textContent = f.rivals[f.toMove].name; $('readsWho').className = 'right pill ' + f.toMove.toLowerCase()
  const textKey = f.stateText + '|' + (f.pending?.choice ?? '')
  if (textKey !== lastText) {
    lastText = textKey
    const pick = f.pending ? `${f.pending.choice[0]},${f.pending.choice[1]} flips` : null
    $('stateText').innerHTML = f.stateText.split('\n').map((line) => {
      if (/^[.OX]+$/.test(line)) return `<span class="g">${line.replace(/O/g, '<span class="o">O</span>').replace(/X/g, '<span class="x">X</span>')}</span>`
      return pick && line.trim().startsWith(pick) ? `<span class="hl">${esc(line)}</span>` : esc(line)
    }).join('\n')
  }
  const gamesKey = JSON.stringify(f.totals.results)
  if (gamesKey !== lastGames) {
    lastGames = gamesKey
    $('games').innerHTML = f.totals.results.length
      ? [...f.totals.results].reverse().map((g) => `<li>Game ${g.game} · <b class="${(g.winner || '').toLowerCase()}">${esc(g.name)}</b> · ${g.O}–${g.X} in ${g.moves} moves</li>`).join('')
      : '<li class="empty">No game has finished yet.</li>'
  }
  banner(f)
}

function banner(f) {
  const b = $('banner')
  if (!f.gameOver) { b.classList.add('hidden'); return }
  const left = Math.max(0, Math.ceil((f.restLeftMs - (f.running ? performance.now() - frameAt : 0)) / 1000))
  const hi = Math.max(f.counts.O, f.counts.X), lo = Math.min(f.counts.O, f.counts.X)
  b.className = 'banner ' + (f.winner ? f.winner.toLowerCase() : 'draw')
  b.innerHTML = `${f.winner ? esc(f.winnerName) + ' wins' : 'A draw'} ${hi}–${lo} <small>${f.running ? `new game in ${left} s` : 'paused'}</small>`
}

// ---------------------------------------------------------------- the move-quality line
function drawSpark() {
  if (!F) return
  const w = spark.width, h = spark.height, q = F.quality, n = Math.max(q.length, 12), pad = 5 * dpr
  sc.clearRect(0, 0, w, h)
  const X = (i) => pad + (i / (n - 1)) * (w - pad * 2), Y = (v) => h - pad - (v / 2) * (h - pad * 2)
  sc.strokeStyle = 'rgba(138,144,166,.18)'; sc.lineWidth = 1
  for (const v of [0, 1, 2]) { sc.beginPath(); sc.moveTo(pad, Y(v)); sc.lineTo(w - pad, Y(v)); sc.stroke() }
  if (!q.length) { $('sparkNum').textContent = '—'; return }
  const val = (i) => (i === q.length - 1 ? 1 + (q[i][1] - 1) * sparkGrow : q[i][1])
  sc.beginPath(); q.forEach((_, i) => (i ? sc.lineTo(X(i), Y(val(i))) : sc.moveTo(X(i), Y(val(i)))))
  sc.strokeStyle = 'rgba(192,132,252,.75)'; sc.lineWidth = 1.5 * dpr; sc.lineJoin = 'round'; sc.stroke()
  sc.lineTo(X(q.length - 1), h - pad); sc.lineTo(X(0), h - pad); sc.closePath()
  const g = sc.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(192,132,252,.28)'); g.addColorStop(1, 'rgba(192,132,252,0)')
  sc.fillStyle = g; sc.fill()
  q.forEach(([d], i) => {
    const lastOne = i === q.length - 1
    sc.fillStyle = COLOR[d]; sc.shadowColor = COLOR[d]; sc.shadowBlur = lastOne ? 10 * dpr : 0
    sc.beginPath(); sc.arc(X(i), Y(val(i)), (lastOne ? 3.6 : 2.2) * dpr, 0, TAU); sc.fill()
  })
  sc.shadowBlur = 0
  const mean = (d) => { const v = q.filter((e) => e[0] === d).map((e) => e[1]); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : '—' }
  $('sparkNum').innerHTML = `<b style="color:${COLOR.O}">${mean('O')}</b> · <b style="color:${COLOR.X}">${mean('X')}</b>`
}

// ---------------------------------------------------------------- 60 fps overlay
function draw(now) {
  requestAnimationFrame(draw)
  const dt = Math.min(50, now - (lastNow || now)); lastNow = now
  if (sparkGrow < 1) { sparkGrow = Math.min(1, sparkGrow + dt / 380); drawSpark() }
  if (F?.gameOver) banner(F)
  fxc.setTransform(dpr, 0, 0, dpr, 0, 0); fxc.clearRect(0, 0, W, H)
  if (celebrate && F?.gameOver && now - celebrate < 3600 && size) {
    // the winner's colour rains over the board
    const r = boardEl.getBoundingClientRect(), s = stage.getBoundingClientRect()
    const cols = F.winner ? [COLOR[F.winner], '#ffffff', '#fbbf24'] : ['#c084fc', '#38bdf8', '#fb7185']
    if (Math.random() < 0.55) burst(r.left - s.left + Math.random() * r.width, r.top - s.top + Math.random() * r.height * 0.5, 5, cols, 1.5, 0.0009)
  }
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i], t = (now - b.t0) / 320
    if (t >= 1) { beams.splice(i, 1); continue }
    const e = 1 - (1 - t) ** 3, hx = b.x0 + (b.x1 - b.x0) * e, hy = b.y0 + (b.y1 - b.y0) * e - Math.sin(Math.PI * e) * 46
    const tx = b.x0 + (b.x1 - b.x0) * Math.max(0, e - 0.35), ty = b.y0 + (b.y1 - b.y0) * Math.max(0, e - 0.35) - Math.sin(Math.PI * Math.max(0, e - 0.35)) * 46
    const g = fxc.createLinearGradient(tx, ty, hx, hy); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, b.color)
    fxc.strokeStyle = g; fxc.lineWidth = 3; fxc.lineCap = 'round'; fxc.globalAlpha = 1 - t * 0.5
    fxc.beginPath(); fxc.moveTo(tx, ty); fxc.lineTo(hx, hy); fxc.stroke()
  }
  fxc.globalAlpha = 1
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i], t = (now - r.t0) / r.dur
    if (t >= 1) { rings.splice(i, 1); continue }
    fxc.strokeStyle = r.color; fxc.globalAlpha = (1 - t) * 0.85; fxc.lineWidth = 2.5 * (1 - t) + 0.5
    fxc.beginPath(); fxc.arc(r.x, r.y, r.r * (0.7 + (1 - (1 - t) ** 3) * 1.3), 0, TAU); fxc.stroke()
  }
  fxc.globalAlpha = 1
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life += dt
    if (p.life >= p.max) { particles.splice(i, 1); continue }
    p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt
    fxc.globalAlpha = 1 - p.life / p.max; fxc.fillStyle = p.color
    fxc.beginPath(); fxc.arc(p.x, p.y, p.size, 0, TAU); fxc.fill()
  }
  fxc.globalAlpha = 1
}

// ---------------------------------------------------------------- the person plays
const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('swap').onclick = () => post({ cmd: 'swap' })
for (const b of document.querySelectorAll('[data-size]')) b.onclick = () => post({ cmd: 'set', key: 'size', value: Number(b.dataset.size) })
$('speed').oninput = (e) => { $('speedVal').textContent = e.target.value + ' ms'; post({ cmd: 'set', key: 'speed', value: Number(e.target.value) }) }
$('speed').onchange = (e) => e.target.blur()
for (const d of ['O', 'X']) {
  $('insight' + d).oninput = (e) => { const v = Number(e.target.value); $('insight' + d + 'Val').textContent = v; $('insight' + d + 'Hint').textContent = READS[v]; post({ cmd: 'set', key: 'insight' + d, value: v }) }
  $('insight' + d).onchange = (e) => e.target.blur()
}

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
