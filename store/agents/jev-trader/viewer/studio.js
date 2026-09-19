// Jev Trader pane. The server sends one frame per trading day (one Jev decision). This file draws
// at 60 fps and eases between frames: the candles scroll left at a steady pace, the newest candle
// forms in place, the price scale and every number glide. Jev's mind is drawn ON the newest candle:
// three rays (buy, hold, sell) whose brightness is the probability, ending in three bars.
// Everything on screen is a made-up market and paper money.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), wrap = $('wrap'), ctx = scene.getContext('2d')
const C = { up: '#34d399', down: '#fb7185', hold: '#94a3b8', jev: '#a78bfa', bh: '#fbbf24', cyan: '#5eead4', ink: '#e9ecf5', dim: '#8b92aa', faint: '#565d75', grid: 'rgba(120,130,170,.10)' }
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"

let W = 0, H = 0, dpr = 1
let F = null, arrivedAt = 0, lastKey = '', lastT = 0, paused = false
let burst = null            // a trade that just happened: spawn particles once its marker is placed
let shake = 0, shockNote = null, confettiFor = -1
const view = { lo: 95, hi: 105, elo: 9900, ehi: 10100, price: 100, eq: 10000, inv: 0, cash: 1, dd: 0, right: 0.5, pB: 0.2, pH: 0.6, pS: 0.2, conf: 0, ready: false }
const particles = [], floaters = []
const dragging = new Set()

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t
const easeOut = (t) => 1 - (1 - t) ** 3
const money = (v, d = 0) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (v, d = 1) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%'

// ---------------------------------------------------------------- canvas size
function fit() {
  const r = wrap.getBoundingClientRect()
  dpr = Math.min(2.5, window.devicePixelRatio || 1)
  W = Math.max(50, Math.round(r.width)); H = Math.max(50, Math.round(r.height))
  scene.width = Math.round(W * dpr); scene.height = Math.round(H * dpr)
}
new ResizeObserver(fit).observe(wrap)
fit()

// ---------------------------------------------------------------- frames from the server
function onFrame(f) {
  const key = f.episode + ':' + f.day
  if (key !== lastKey) {
    arrivedAt = performance.now()
    const t = f.trades[f.trades.length - 1]
    if (F && t && t.d === f.day && f.episode === F.episode) burst = t
    if (!F || f.episode !== F.episode || f.day < F.day) view.ready = false // a new year: snap the scales
  }
  const newEvent = f.events.length && (!F || f.events.length !== F.events.length || f.events[f.events.length - 1].d !== F.events[F.events.length - 1]?.d)
  if (F && newEvent) { const ev = f.events[f.events.length - 1]; shake = 1; shockNote = { kind: ev.kind, at: performance.now() } }
  F = f; lastKey = key
  paused = !f.running
  renderDom(f)
}

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => { try { onFrame(JSON.parse(e.data)) } catch (err) { console.error(err) } })
}
connect()

async function post(body) {
  try { await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { /* the server is restarting; the stream reconnects on its own */ }
}

// ---------------------------------------------------------------- DOM: numbers, lists, sliders
function setText(id, text, cls) { const n = $(id); if (n.textContent !== text) n.textContent = text; if (cls !== undefined) n.className = cls }

function renderDom(f) {
  setText('title', f.title || 'Jev Trader')
  setText('s-ret', pct(f.ret), f.ret >= 0 ? 'up' : 'down')
  setText('s-bh', pct(f.bhRet))
  setText('s-won', f.session.episodes ? `${f.session.beats} / ${f.session.episodes}` : '—')
  setText('s-days', (f.session.days + (f.status === 'done' ? 0 : f.day)).toLocaleString('en-US'))
  setText('daypill', `year ${f.episode + 1} · day ${f.day}`)
  $('pause').textContent = f.running ? 'Pause' : 'Play'
  const err = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !err)
  if (err) $('cfgError').textContent = f.cfgError ? `${f.cfgError} — the desk keeps trading on the last good market.json.` : err
  $('ovr').classList.toggle('hidden', !Object.keys(f.overrides || {}).length)

  if (!dragging.has('vol')) $('vol').value = f.volatility
  if (!dragging.has('fee')) $('fee').value = f.fee
  if (!dragging.has('speed')) $('speed').value = clamp(1000 / f.stepMs, 1, 16)
  setText('volVal', (f.volatility * 100).toFixed(1) + '%')
  setText('feeVal', (f.fee * 100).toFixed(2) + '%')
  setText('speedVal', (1000 / f.stepMs).toFixed(1).replace(/\.0$/, '') + '/s')

  // What Jev reads: the exact text, with the account line and the newest close picked out.
  const pre = $('stateText')
  const lines = String(f.stateText || '').split('\n')
  pre.textContent = ''
  lines.forEach((ln, i) => {
    const s = document.createElement('span')
    const isTape = /^day -?\d+:/.test(ln)
    if (/^Account:/.test(ln)) s.className = 'hl'
    else if (isTape && !/^day -?\d+:/.test(lines[i + 1] || '')) s.className = 'last'
    else if (isTape) s.className = 'dim'
    s.textContent = ln + '\n'
    pre.appendChild(s)
  })

  const bl = $('blotter')
  bl.textContent = ''
  const trades = f.trades.slice(-14).reverse()
  if (!trades.length) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'No trades yet this year.'; bl.appendChild(li) }
  for (const t of trades) {
    const li = document.createElement('li'); li.className = t.side === 'B' ? 'buy' : 'sell'
    const d = document.createElement('span'); d.className = 'd'; d.textContent = 'd' + t.d
    const b = document.createElement('b'); b.textContent = t.side === 'B' ? 'BUY' : 'SELL'
    const q = document.createElement('span'); q.textContent = `${t.sh} @ ${t.px.toFixed(2)}`
    const r = document.createElement('span'); r.className = 'r'; r.textContent = t.why ? t.why : `fee ${money(t.fee, 2)}`
    li.append(d, b, q, r); bl.appendChild(li)
  }
  setText('blotterMeta', `${f.nTrades} trades · fees ${money(f.fees, 0)}`)

  const ys = $('years')
  if (f.session.results.length) {
    ys.textContent = ''
    for (const r of f.session.results.slice().reverse()) {
      const li = document.createElement('li'); li.className = r.edge > 0 ? 'buy' : 'sell'
      const d = document.createElement('span'); d.className = 'd'; d.textContent = 'y' + (r.episode + 1)
      const b = document.createElement('b'); b.textContent = pct(r.ret)
      const q = document.createElement('span'); q.textContent = `b&h ${pct(r.bh)}`
      const e = document.createElement('span'); e.className = 'r'; e.textContent = `right side ${(r.right * 100).toFixed(0)}%`
      li.append(d, b, q, e); ys.appendChild(li)
    }
  } else if (!ys.querySelector('.dim')) { ys.textContent = ''; const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'The first year is still open.'; ys.appendChild(li) }

  const ban = $('banner')
  if (f.status === 'done' && f.result) {
    const won = f.result.edge > 0
    ban.className = 'banner ' + (won ? 'ok' : 'bad')
    ban.innerHTML = ''
    ban.append(`Paper year ${f.episode + 1} closed · Jev ${pct(f.result.ret)} · buy-and-hold ${pct(f.result.bh)}`)
    const sm = document.createElement('small')
    sm.textContent = `${won ? 'Jev beat' : 'Jev lost to'} buy-and-hold by ${Math.abs(f.result.edge * 100).toFixed(1)} points · right side of the trend ${(f.result.right * 100).toFixed(0)}% of days · made-up market, next year opens in a moment`
    ban.appendChild(sm)
    if (won && confettiFor !== f.episode) { confettiFor = f.episode; for (let i = 0; i < 90; i++) spawn(W * (0.2 + Math.random() * 0.6), H * 0.3, [C.up, C.jev, C.cyan, C.bh][i % 4], 260, 1.6) }
  } else ban.className = 'banner hidden'
}

// /jev gives the three numbers people ask about: how fast, how cheap, how many.
async function pollJev() {
  try {
    const j = await (await fetch('/jev')).json()
    setText('s-rate', paused ? '0.0' : j.callsPerSec.toFixed(1))
    const c = j.costUsd
    setText('s-cost', c <= 0 ? '$0' : c < 0.01 ? '$' + c.toFixed(6) : '$' + c.toFixed(4))
  } catch { /* keep the last numbers */ }
}
setInterval(pollJev, 400); pollJev()

// ---------------------------------------------------------------- controls
$('pause').onclick = () => post({ cmd: F && F.running ? 'pause' : 'start' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('crash').onclick = () => post({ cmd: 'shock', kind: 'crash' })
$('rally').onclick = () => post({ cmd: 'shock', kind: 'rally' })
$('flat').onclick = () => post({ cmd: 'flatten' })
function slider(id, toBody, show) {
  const n = $(id)
  n.addEventListener('pointerdown', () => dragging.add(id))
  window.addEventListener('pointerup', () => dragging.delete(id))
  n.addEventListener('input', () => { show(Number(n.value)); post(toBody(Number(n.value))) })
  n.addEventListener('change', () => dragging.delete(id))
}
slider('vol', (v) => ({ cmd: 'set', key: 'volatility', value: v }), (v) => setText('volVal', (v * 100).toFixed(1) + '%'))
slider('fee', (v) => ({ cmd: 'set', key: 'fee', value: v }), (v) => setText('feeVal', (v * 100).toFixed(2) + '%'))
slider('speed', (v) => ({ cmd: 'set', key: 'stepMs', value: Math.round(1000 / v) }), (v) => setText('speedVal', v.toFixed(1).replace(/\.0$/, '') + '/s'))

// ---------------------------------------------------------------- particles
function spawn(x, y, color, speed = 160, size = 1.4) {
  const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7)
  particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0, max: 0.6 + Math.random() * 0.7, color, size: size * (0.6 + Math.random()) })
}
function stepParticles(dt) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.life += dt; if (p.life >= p.max) { particles.splice(i, 1); continue }
    p.vy += 260 * dt; p.vx *= 0.985; p.x += p.vx * dt; p.y += p.vy * dt
    ctx.globalAlpha = 1 - p.life / p.max; ctx.fillStyle = p.color
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
  for (let i = floaters.length - 1; i >= 0; i--) {
    const fl = floaters[i]
    fl.life += dt; if (fl.life >= 1.3) { floaters.splice(i, 1); continue }
    ctx.globalAlpha = 1 - fl.life / 1.3; ctx.fillStyle = fl.color; ctx.font = `700 11px ${MONO}`; ctx.textAlign = 'center'
    ctx.fillText(fl.text, fl.x, fl.y - fl.life * 26 * fl.dir)
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- drawing helpers
function niceStep(span, target) {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r) }
function label(text, x, y, color = C.dim, font = `10px ${MONO}`, align = 'left') { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(text, x, y) }

function gauge(cx, cy, r, value, color, big, small, mark) {
  const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15
  ctx.lineCap = 'round'
  ctx.lineWidth = Math.max(6, r * 0.2); ctx.strokeStyle = 'rgba(140,150,190,.13)'
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke()
  const v = clamp(value, 0, 1)
  if (v > 0.004) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 14; ctx.strokeStyle = color
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, lerp(a0, a1, v)); ctx.stroke(); ctx.restore()
  }
  if (mark != null) { // a thin tick, for "worst so far"
    const a = lerp(a0, a1, clamp(mark, 0, 1))
    ctx.lineWidth = 2; ctx.strokeStyle = C.ink
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r - r * 0.18), cy + Math.sin(a) * (r - r * 0.18)); ctx.lineTo(cx + Math.cos(a) * (r + r * 0.18), cy + Math.sin(a) * (r + r * 0.18)); ctx.stroke()
  }
  ctx.lineCap = 'butt'
  let fs = Math.round(r * 0.42)
  ctx.font = `700 ${fs}px ${MONO}`
  const tw = ctx.measureText(big).width
  if (tw > r * 1.34) fs = Math.max(10, Math.floor(fs * (r * 1.34) / tw))
  label(big, cx, cy + fs * 0.2, C.ink, `700 ${fs}px ${MONO}`, 'center')
  label(small, cx, cy + r * 0.62 + 12, C.dim, `9.5px ${MONO}`, 'center')
}

// ---------------------------------------------------------------- the scene
function draw(now) {
  requestAnimationFrame(draw)
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (!F || W < 200) return
  const f = F
  const kLin = paused ? 1 : clamp((now - arrivedAt) / Math.max(60, f.stepMs), 0, 1)
  const kForm = easeOut(kLin)
  const glide = 1 - Math.exp(-dt * 7)

  // layout
  const axisW = 60, futureW = W > 820 ? 206 : 176
  const gaugesH = clamp(H * 0.2, 98, 132), eqH = clamp(H * 0.19, 78, 150)
  const P = { x0: 0, x1: W - axisW, y0: 46, y1: H - gaugesH - eqH - 56 }
  const R = { y0: P.y1 + 8, y1: P.y1 + 20 }
  const E = { y0: R.y1 + 24, y1: R.y1 + 24 + eqH }
  const G = { y0: E.y1 + 12, y1: H - 6 }
  const xLive = P.x1 - futureW
  const cw = clamp((xLive - 6) / 86, 5, 13)
  const N = f.candles.length
  const xOf = (j) => xLive - j * cw + (1 - kLin) * cw // j = 0 is the newest candle
  const nVis = Math.min(N, Math.ceil((xLive + cw) / cw) + 1)

  if (shake > 0.01) { ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 8 * shake); shake *= Math.exp(-dt * 5) }

  // the forming candle
  const liveC = f.candles[N - 1]
  const lc = { o: liveC.o, c: lerp(liveC.o, liveC.c, kForm), h: 0, l: 0 }
  lc.h = Math.max(lc.o, lc.c, lerp(liveC.o, liveC.h, Math.min(1, kLin * 1.5)))
  lc.l = Math.min(lc.o, lc.c, lerp(liveC.o, liveC.l, Math.min(1, kLin * 1.5)))
  const cd = (j) => (j === 0 ? lc : f.candles[N - 1 - j])

  // scales glide to fit what is on screen
  let lo = Infinity, hi = -Infinity
  for (let j = 0; j < nVis; j++) { const c = cd(j); if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h }
  const padP = Math.max((hi - lo) * 0.12, hi * 0.004); lo -= padP; hi += padP
  let elo = Infinity, ehi = -Infinity
  const M = Math.min(f.eq.length, f.bh.length)
  for (let j = 0; j < Math.min(nVis, M); j++) { const a = f.eq[f.eq.length - 1 - j], b = f.bh[f.bh.length - 1 - j]; elo = Math.min(elo, a, b); ehi = Math.max(ehi, a, b) }
  if (!Number.isFinite(elo)) { elo = f.capital * 0.99; ehi = f.capital * 1.01 }
  const padE = Math.max((ehi - elo) * 0.14, f.capital * 0.004); elo -= padE; ehi += padE
  if (!view.ready) Object.assign(view, { lo, hi, elo, ehi, price: lc.c, eq: f.equity, inv: f.invested, cash: f.equity > 0 ? f.cash / f.equity : 1, dd: f.drawdown, right: f.right ?? 0.5, ready: true })
  view.lo = lerp(view.lo, lo, glide); view.hi = lerp(view.hi, hi, glide)
  view.elo = lerp(view.elo, elo, glide); view.ehi = lerp(view.ehi, ehi, glide)
  view.eq = lerp(view.eq, f.equity, glide); view.inv = lerp(view.inv, f.invested, glide)
  view.cash = lerp(view.cash, f.equity > 0 ? f.cash / f.equity : 1, glide); view.dd = lerp(view.dd, f.drawdown, glide)
  view.right = lerp(view.right, f.right ?? 0.5, glide)
  view.pB = lerp(view.pB, f.last.probs.BUY ?? 0, glide * 1.6); view.pH = lerp(view.pH, f.last.probs.HOLD ?? 0, glide * 1.6); view.pS = lerp(view.pS, f.last.probs.SELL ?? 0, glide * 1.6)
  view.conf = lerp(view.conf, f.last.confidence ?? 0, glide)
  setText('s-eq', money(view.eq))
  const yP = (v) => P.y1 - ((v - view.lo) / (view.hi - view.lo)) * (P.y1 - P.y0)
  const yE = (v) => E.y1 - ((v - view.elo) / (view.ehi - view.elo)) * (E.y1 - E.y0)

  // ---- price area: grid, axis
  ctx.save()
  const bg = ctx.createLinearGradient(0, P.y0, 0, P.y1); bg.addColorStop(0, 'rgba(120,110,220,.05)'); bg.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = bg; ctx.fillRect(0, P.y0 - 6, P.x1, P.y1 - P.y0 + 12)
  const step = niceStep(view.hi - view.lo, 5)
  ctx.lineWidth = 1; ctx.textBaseline = 'middle'
  for (let v = Math.ceil(view.lo / step) * step; v < view.hi; v += step) {
    const y = Math.round(yP(v)) + 0.5
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(P.x1, y); ctx.stroke()
    label(v.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0), P.x1 + 8, y, C.faint, `10px ${MONO}`)
  }
  // the future zone: a soft curtain to the right of today
  const fz = ctx.createLinearGradient(xLive + cw, 0, P.x1, 0); fz.addColorStop(0, 'rgba(167,139,250,0)'); fz.addColorStop(1, 'rgba(167,139,250,.06)')
  ctx.fillStyle = fz; ctx.fillRect(xLive + cw, P.y0 - 6, P.x1 - xLive - cw, P.y1 - P.y0 + 12)
  ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(167,139,250,.28)'; ctx.beginPath(); ctx.moveTo(xLive + cw * 0.9, P.y0 - 4); ctx.lineTo(xLive + cw * 0.9, E.y1); ctx.stroke(); ctx.setLineDash([])

  // ---- clip everything that scrolls
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, P.x1, H); ctx.clip()

  // shocks: a dashed flag where a made-up shock began
  for (const ev of f.events) {
    const j = liveC.d - ev.d; const x = xOf(j)
    if (x < -20 || j < -1) continue
    const col = ev.kind === 'crash' ? C.down : C.up
    ctx.setLineDash([4, 4]); ctx.strokeStyle = col; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x - cw / 2, P.y0); ctx.lineTo(x - cw / 2, E.y1); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1
    if (x > 40) { ctx.fillStyle = col; roundRect(x - cw / 2, P.y0 - 2, 74, 15, 4); ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1; label(ev.kind === 'crash' ? 'your crash' : 'your rally', x - cw / 2 + 6, P.y0 + 6, col, `700 9.5px ${MONO}`) }
  }

  // close line with a soft area under it
  ctx.beginPath()
  for (let j = nVis - 1; j >= 0; j--) { const x = xOf(j), y = yP(cd(j).c); j === nVis - 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) }
  ctx.strokeStyle = 'rgba(167,139,250,.35)'; ctx.lineWidth = 1.2; ctx.stroke()
  ctx.lineTo(xOf(0), P.y1); ctx.lineTo(xOf(nVis - 1), P.y1); ctx.closePath()
  const ar = ctx.createLinearGradient(0, P.y0, 0, P.y1); ar.addColorStop(0, 'rgba(167,139,250,.16)'); ar.addColorStop(1, 'rgba(167,139,250,0)')
  ctx.fillStyle = ar; ctx.fill()

  // candles
  const bw = Math.max(2, cw * 0.66)
  for (let j = nVis - 1; j >= 0; j--) {
    const c = cd(j), x = xOf(j), up = c.c >= c.o, col = up ? C.up : C.down
    const yo = yP(c.o), yc = yP(c.c), top = Math.min(yo, yc), hgt = Math.max(1.2, Math.abs(yc - yo))
    ctx.save()
    if (j === 0 || f.candles[N - 1 - j].s) { ctx.shadowColor = col; ctx.shadowBlur = j === 0 ? 16 : 9 }
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yP(c.h)); ctx.lineTo(Math.round(x) + 0.5, yP(c.l)); ctx.stroke()
    const g = ctx.createLinearGradient(0, top, 0, top + hgt); g.addColorStop(0, col); g.addColorStop(1, up ? '#0f9f74' : '#c2415b')
    ctx.fillStyle = g; roundRect(x - bw / 2, top, bw, hgt, Math.min(2, bw / 3)); ctx.fill()
    ctx.restore()
  }

  // trades: up arrows under the candle for buys, down arrows over it for sells
  for (const t of f.trades) {
    const j = liveC.d - t.d; if (j < 0 || j >= nVis) continue
    const c = cd(j), x = xOf(j), buy = t.side === 'B', col = buy ? C.up : C.down
    const y = buy ? yP(c.l) + 13 : yP(c.h) - 13
    const age = j + (1 - kLin), pop = j === 0 ? 1 + (1 - kForm) * 0.9 : 1
    const s = clamp(4.5 + (t.sh * t.px) / Math.max(1, f.equity) * 9, 5, 9) * pop
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = age < 6 ? 14 : 4; ctx.fillStyle = col
    ctx.beginPath()
    if (buy) { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8) } else { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y - s * 0.8); ctx.lineTo(x - s, y - s * 0.8) }
    ctx.closePath(); ctx.fill(); ctx.restore()
    if (burst && burst.d === t.d && burst.side === t.side) {
      for (let i = 0; i < 34; i++) spawn(x, y, col, 190)
      floaters.push({ x, y: (buy ? y + 26 : y - 18) + (buy ? 1 : -1) * 13 * floaters.filter((fl) => fl.life < 0.9).length, dir: buy ? -1 : 1, life: 0, color: col, text: `${buy ? 'BUY' : 'SELL'} ${t.sh}${t.why ? ' · ' + t.why : ''}` })
      burst = null
    }
  }

  // the hidden trend ribbon (Jev cannot see it)
  for (let j = nVis - 1; j >= 0; j--) {
    const r = f.candles[N - 1 - j].r, x = xOf(j)
    ctx.fillStyle = r > 0 ? 'rgba(52,211,153,.55)' : r < 0 ? 'rgba(251,113,133,.55)' : 'rgba(148,163,184,.22)'
    ctx.fillRect(x - cw / 2, R.y0, cw + 0.6, R.y1 - R.y0)
  }

  // equity: Jev against buy-and-hold, the gap shaded by who is ahead
  const pts = []
  for (let j = Math.min(nVis, M) - 1; j >= 0; j--) {
    let a = f.eq[f.eq.length - 1 - j], b = f.bh[f.bh.length - 1 - j]
    if (j === 0 && M > 1) { a = lerp(f.eq[f.eq.length - 2], a, kForm); b = lerp(f.bh[f.bh.length - 2], b, kForm) }
    pts.push({ x: xOf(j), a: yE(a), b: yE(b), ahead: a >= b })
  }
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i]
    ctx.fillStyle = p1.ahead ? 'rgba(52,211,153,.16)' : 'rgba(251,113,133,.16)'
    ctx.beginPath(); ctx.moveTo(p0.x, p0.a); ctx.lineTo(p1.x, p1.a); ctx.lineTo(p1.x, p1.b); ctx.lineTo(p0.x, p0.b); ctx.closePath(); ctx.fill()
  }
  const yCap = yE(f.capital)
  if (yCap > E.y0 && yCap < E.y1) { ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(140,150,190,.35)'; ctx.beginPath(); ctx.moveTo(0, yCap); ctx.lineTo(P.x1, yCap); ctx.stroke(); ctx.setLineDash([]) }
  const line = (key, col, width, glow) => {
    ctx.save(); if (glow) { ctx.shadowColor = col; ctx.shadowBlur = 10 }
    ctx.strokeStyle = col; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p[key]) : ctx.moveTo(p.x, p[key]))); ctx.stroke(); ctx.restore()
  }
  line('b', C.bh, 1.4, false); line('a', C.jev, 2.2, true)
  ctx.restore() // end of the scrolling clip

  // ---- fixed labels over the scrolling parts
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(7,8,15,.78)'; roundRect(6, R.y0 - 1, 238, R.y1 - R.y0 + 2, 4); ctx.fill()
  label('HIDDEN TREND · JEV CANNOT SEE THIS', 12, (R.y0 + R.y1) / 2 + 0.5, C.dim, `700 8.5px ${MONO}`)
  label('EQUITY', 10, E.y0 - 9, C.dim, `700 9.5px ${MONO}`)
  label('— Jev', 66, E.y0 - 9, C.jev, `700 9.5px ${MONO}`); label('— buy and hold', 116, E.y0 - 9, C.bh, `700 9.5px ${MONO}`)
  const estep = niceStep(view.ehi - view.elo, 3)
  for (let v = Math.ceil(view.elo / estep) * estep; v < view.ehi; v += estep) {
    const y = yE(v); if (y < E.y0 + 4 || y > E.y1 - 4) continue
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(P.x1, Math.round(y) + 0.5); ctx.stroke()
    label(v >= 10000 ? (v / 1000).toFixed(estep < 1000 ? 1 : 0) + 'k' : v.toFixed(0), P.x1 + 8, y, C.faint, `10px ${MONO}`)
  }
  if (yCap > E.y0 + 8 && yCap < E.y1 - 4) label('start', 10, yCap - 7, C.faint, `9.5px ${MONO}`)

  // end dots and tags of the two equity lines, in the future zone
  const pe = pts[pts.length - 1]
  if (pe) {
    let ya = pe.a, yb = pe.b
    if (Math.abs(ya - yb) < 15) { const mid = (ya + yb) / 2, s = ya <= yb ? -1 : 1; ya = mid + s * 7.5; yb = mid - s * 7.5 }
    for (const [y0, y, col, text] of [[pe.b, yb, C.bh, 'buy & hold ' + pct(f.bhRet)], [pe.a, ya, C.jev, 'Jev ' + pct(f.ret)]]) {
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(pe.x, y0, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      label(text, pe.x + 12, clamp(y, E.y0 + 2, E.y1 - 2), col, `700 10.5px ${MONO}`)
    }
  }

  // ---- Jev's mind, drawn on the newest candle
  const ox = xOf(0) + bw / 2 + 3, oy = yP(lc.c)
  const bx = P.x1 - 96, by = clamp(oy, P.y0 + 64, P.y1 - 52)
  const rows = [['BUY', view.pB, C.up, by - 28], ['HOLD', view.pH, C.hold, by], ['SELL', view.pS, C.down, by + 28]]
  const chosen = f.last.action
  // the wedge around the chosen ray: wide when Jev is unsure, narrow when it is sure
  const cr = rows.find((r) => r[0] === chosen) ?? rows[1]
  const half = 5 + (1 - view.conf) * 22
  const wg = ctx.createLinearGradient(ox, 0, bx, 0); wg.addColorStop(0, 'rgba(255,255,255,0)'); wg.addColorStop(1, cr[2] + '30')
  ctx.fillStyle = wg; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(bx - 4, cr[3] - half); ctx.lineTo(bx - 4, cr[3] + half); ctx.closePath(); ctx.fill()
  for (const [name, p, col, y] of rows) {
    const on = name === chosen
    ctx.save()
    ctx.globalAlpha = clamp(0.12 + p * 0.95, 0, 1); ctx.strokeStyle = col; ctx.lineWidth = 1 + p * 4.5
    if (on) { ctx.shadowColor = col; ctx.shadowBlur = 16 }
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.bezierCurveTo(lerp(ox, bx, 0.5), oy, lerp(ox, bx, 0.5), y, bx - 6, y); ctx.stroke()
    if (on) { // a pulse runs along the chosen ray
      const u = (now / 700) % 1, mx = lerp(ox, bx, 0.5)
      const bz = (a, b, c2, d) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u * u * c2 + u ** 3 * d
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(bz(ox, mx, mx, bx - 6), bz(oy, oy, y, y), 2.6, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
    // the bar
    ctx.fillStyle = 'rgba(140,150,190,.12)'; roundRect(bx, y - 6, 44, 12, 3); ctx.fill()
    ctx.save(); if (on) { ctx.shadowColor = col; ctx.shadowBlur = 14 }
    ctx.globalAlpha = on ? 1 : 0.55; ctx.fillStyle = col; roundRect(bx, y - 6, Math.max(2, 44 * clamp(p, 0, 1)), 12, 3); ctx.fill(); ctx.restore()
    label(name, bx, y - 14, on ? col : C.faint, `700 9px ${MONO}`)
    label((p * 100).toFixed(0) + '%', bx + 50, y + 0.5, on ? C.ink : C.dim, `${on ? 700 : 400} 11px ${MONO}`)
  }
  label("JEV'S CALL", bx, rows[0][3] - 30, C.jev, `700 9px ${MONO}`)
  if (f.last.pCrash >= 0.5) label('CRASH FLAG ' + (f.last.pCrash * 100).toFixed(0) + '%', bx, rows[2][3] + 22, C.down, `700 9.5px ${MONO}`)
  else label(`trend: ${f.last.regime}`, bx, rows[2][3] + 22, C.dim, `9.5px ${MONO}`)

  // the price tag on the axis
  view.price = lerp(view.price, lc.c, 0.5)
  const upDay = lc.c >= lc.o, tagCol = upDay ? C.up : C.down, ty = clamp(oy, P.y0 + 9, P.y1 - 9)
  ctx.save(); ctx.shadowColor = tagCol; ctx.shadowBlur = 12; ctx.fillStyle = tagCol; roundRect(P.x1 + 3, ty - 9, axisW - 6, 18, 4); ctx.fill(); ctx.restore()
  label(lc.c.toFixed(2), P.x1 + axisW / 2, ty + 0.5, '#06110c', `700 11px ${MONO}`, 'center')

  // header: instrument, price, the day's move, where we are in the year
  ctx.textBaseline = 'alphabetic'
  label(f.instrument, 12, 30, C.ink, `700 17px ${MONO}`)
  const iw = ctx.measureText(f.instrument).width
  label(lc.c.toFixed(2), 22 + iw, 30, tagCol, `700 17px ${MONO}`)
  const pw = ctx.measureText(lc.c.toFixed(2)).width
  const dayMove = liveC.o ? lc.c / liveC.o - 1 : 0
  label(`${upDay ? '▲' : '▼'} ${pct(dayMove, 2)}`, 32 + iw + pw, 29, tagCol, `700 11px ${MONO}`)
  if (W > 760) label(`paper year ${f.episode + 1} · day ${f.day} of ${f.episodeDays}`, 120 + iw + pw, 29, C.dim, `11px ${MONO}`)
  // progress of the year, a hairline under the header
  ctx.fillStyle = 'rgba(140,150,190,.14)'; ctx.fillRect(12, 37, 200, 2)
  ctx.fillStyle = C.jev; ctx.fillRect(12, 37, 200 * clamp(f.day / f.episodeDays, 0, 1), 2)

  // a shock in progress tints the chart and says so
  if (f.shock || (shockNote && now - shockNote.at < 2200)) {
    const kind = f.shock?.kind ?? shockNote.kind, col = kind === 'crash' ? C.down : C.up
    const vg = ctx.createLinearGradient(0, 0, 0, P.y1); vg.addColorStop(0, col + '26'); vg.addColorStop(1, col + '00')
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, P.y1)
    ctx.textBaseline = 'middle'
    const text = `${kind === 'crash' ? 'CRASH' : 'RALLY'} INJECTED BY YOU${f.shock ? ` · ${f.shock.left} day${f.shock.left === 1 ? '' : 's'} left` : ''}`
    ctx.font = `700 12px ${MONO}`; const tw = ctx.measureText(text).width + 24
    ctx.fillStyle = 'rgba(7,8,15,.8)'; roundRect(xLive / 2 - tw / 2, P.y0 + 8, tw, 24, 6); ctx.fill()
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke()
    label(text, xLive / 2, P.y0 + 20.5, col, `700 12px ${MONO}`, 'center')
  }

  // ---- gauges
  ctx.textBaseline = 'alphabetic'
  ctx.strokeStyle = 'rgba(140,150,190,.12)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(10, G.y0 - 2.5); ctx.lineTo(W - 10, G.y0 - 2.5); ctx.stroke()
  const gw = W / 4, gh = G.y1 - G.y0, r = clamp(Math.min(gw * 0.27, gh * 0.47), 26, 56), gy = G.y0 + r + 10
  gauge(gw * 0.5, gy, r, view.inv, C.jev, (view.inv * 100).toFixed(0) + '%', `POSITION · ${f.holdings} sh`)
  gauge(gw * 1.5, gy, r, view.cash, C.cyan, money(view.cash * view.eq), 'CASH')
  gauge(gw * 2.5, gy, r, view.dd / 0.3, C.down, '-' + (view.dd * 100).toFixed(1) + '%', `DRAWDOWN · worst -${(f.maxDD * 100).toFixed(1)}%`, f.maxDD / 0.3)
  const rc = view.right >= 0.65 ? C.up : view.right >= 0.55 ? C.bh : C.down
  gauge(gw * 3.5, gy, r, f.right == null ? 0 : view.right, rc, f.right == null ? '—' : (view.right * 100).toFixed(0) + '%', 'RIGHT SIDE OF THE TREND')

  stepParticles(dt)
}
requestAnimationFrame(draw)
