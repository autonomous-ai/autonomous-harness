// Jev Shopper pane — a price board. The server sends one frame per tick (one Jev decision). This
// file draws at 60 fps and eases between frames: every chart scrolls smoothly, the prices count
// instead of jumping, and Jev's spotlight glides from product to product. Jev's mind is in the
// scene: a lamp and a bar on every card glow by the probability Jev gave that product, the big
// spotlight is its pick, and the cone gets wider when Jev is less sure.
'use strict'

const $ = (id) => document.getElementById(id)
const HUES = [[245, 158, 11], [34, 211, 238], [167, 139, 250], [244, 114, 182], [163, 230, 53], [96, 165, 250], [251, 146, 60], [45, 212, 191]]
const SHOW = 60 // ticks across a chart
const shelf = $('shelf'), board = $('board'), fxc = $('fx'), fx = fxc.getContext('2d')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const easeOut = (u) => 1 - (1 - u) * (1 - u)
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
const money = (v, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

let F = null, prevStep = -1, dpr = Math.max(1, window.devicePixelRatio || 1)
let showFair = true, firstFrame = true, lastRound = 0, lastResultRound = 0
let seenBuy = 0, seenBounce = 0, budgetKey = '', receiptKey = ''
let fxW = 0, fxH = 0, lastT = performance.now()
const cards = new Map()            // product name -> card
const trails = new Map()           // product name -> [{ step, conf }] where Jev's spotlight was
const particles = [], floaters = [], rings = [], motes = []
const beam = { x: 0, y: 0, x0: 0, x1: 0, bottom: 0, a: 0, conf: 0, ready: false, trail: [] }
const tele = { rate: 0, cost: 0, shownRate: 0, shownCost: 0 }
const shown = { saved: 0, cash: 0 }
const dragging = new Set()
for (let i = 0; i < 34; i++) motes.push({ u: Math.random(), v: Math.random(), s: 0.04 + Math.random() * 0.1, ph: Math.random() * 6.28 })

async function post(body) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(String(r.status))
    return await r.json()
  } catch (e) { console.error('control failed', e); return null }
}

// ---------------------------------------------------------------- cards
const sizer = new ResizeObserver((entries) => {
  for (const en of entries) { const c = en.target.__card; if (c) sizeCanvas(c) }
})
function sizeCanvas(c) {
  const r = c.canvas.parentElement.getBoundingClientRect()
  c.w = r.width; c.h = r.height
  c.canvas.width = Math.max(1, Math.round(c.w * dpr)); c.canvas.height = Math.max(1, Math.round(c.h * dpr))
}

function makeCard(name) {
  const el = document.createElement('div')
  el.className = 'card'
  el.innerHTML = '<button class="rm" title="Take this product off the board">×</button>' +
    '<div class="head"><h3></h3><span class="tag">watching</span></div>' +
    '<div class="row"><span class="price"><small>$</small><span class="pv">0.00</span></span><span class="chip"></span><span class="real">◆ real sale on</span></div>' +
    '<div class="chart"><canvas></canvas></div>' +
    '<div class="mind"><label>Jev</label><div class="bar"><i></i></div><b>—</b></div>'
  el.querySelector('h3').textContent = name
  el.title = `Click to start a flash sale on ${name}`
  const canvas = el.querySelector('canvas')
  const c = {
    name, el, canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, s: null, at: -1, lo: null, hi: null, avgShown: null, priceShown: null, pShown: 0,
    pv: el.querySelector('.pv'), tag: el.querySelector('.tag'), chip: el.querySelector('.chip'), real: el.querySelector('.real'),
    bar: el.querySelector('.bar i'), pLabel: el.querySelector('.mind b'), stamp: null, stampBuy: 0, ribbon: null, hue: HUES[0], lastTxt: '',
  }
  canvas.parentElement.__card = c
  sizer.observe(canvas.parentElement)
  el.addEventListener('click', (ev) => {
    const b = board.getBoundingClientRect()
    burst(ev.clientX - b.left, ev.clientY - b.top, 'spark', 34)
    rings.push({ x: ev.clientX - b.left, y: ev.clientY - b.top, r: 6, life: 0, max: 0.6, color: [244, 114, 182] })
    post({ cmd: 'flash', name })
  })
  el.querySelector('.rm').addEventListener('click', (ev) => { ev.stopPropagation(); post({ cmd: 'remove', name }) })
  shelf.appendChild(el)
  return c
}

function syncCards(f, now, snap) {
  const names = new Set(f.streams.map((s) => s.name))
  for (const [name, c] of cards) if (!names.has(name)) { sizer.unobserve(c.canvas.parentElement); c.el.remove(); cards.delete(name) }
  const n = f.streams.length
  shelf.style.setProperty('--cols', String(n <= 4 ? n : n <= 6 ? 3 : 4))
  const pick = f.phase === 'shopping' && !f.jev.watchOnly ? f.jev.pick : null
  f.streams.forEach((s, i) => {
    let c = cards.get(s.name)
    if (!c) { c = makeCard(s.name); cards.set(s.name, c); snap = true }
    c.s = s; c.at = snap ? -1 : now
    c.hue = HUES[i % HUES.length]
    c.el.style.setProperty('--hue', rgba(c.hue, 1))
    c.el.style.order = String(i)
    if (snap) { c.lo = null; c.priceShown = null }
    const isPick = s.name === pick
    c.el.className = ['card', isPick ? 'pick' : '', s.status, s.flash > 0 ? 'flash' : '', c.el.classList.contains('wipe') ? 'wipe' : ''].filter(Boolean).join(' ')
    c.tag.textContent = s.status === 'pending' ? 'order placed…' : s.status === 'locked' ? 'bought this dip' : s.status === 'over' ? 'over budget' : isPick ? 'best buy now' : 'watching'
    const d = s.disc * 100
    c.chip.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}% vs usual`
    c.chip.className = 'chip' + (s.disc <= -f.minDeal ? ' deal' : s.disc > 0.03 ? ' dear' : '')
    c.real.classList.toggle('on', showFair && s.trueDisc <= -0.05)
    const p = s.status === 'open' || s.status === 'pending' || f.jev.watchOnly ? s.p : null
    c.pTarget = p ?? 0
    c.bar.style.width = `${Math.round((p ?? 0) * 100)}%`
    c.pLabel.textContent = p == null ? '—' : p >= 0.995 ? '1.0' : p.toFixed(2).replace(/^0/, '')

    // FLASH SALE ribbon
    if (s.flash > 0 && !c.ribbon) { c.ribbon = document.createElement('div'); c.ribbon.className = 'ribbon'; c.ribbon.textContent = 'FLASH SALE'; c.canvas.parentElement.appendChild(c.ribbon) }
    if (s.flash <= 0 && c.ribbon) { c.ribbon.remove(); c.ribbon = null }

    // purchase stamp: stays while the product is "bought this dip"
    const buy = s.buys[s.buys.length - 1]
    if (buy && s.status === 'locked' && c.stampBuy !== buy.id) {
      c.stamp?.remove()
      c.stampBuy = buy.id
      c.stamp = document.createElement('div')
      c.stamp.className = 'stamp' + (buy.saved < 0 ? ' bad' : '')
      c.stamp.innerHTML = `BOUGHT<small>$${money(buy.price)} · ${buy.saved >= 0 ? 'saved' : 'over by'} $${money(Math.abs(buy.saved))}</small>`
      c.el.appendChild(c.stamp)
    }
    if (c.stamp && s.status !== 'locked' && !c.stamp.classList.contains('out')) { const st = c.stamp; st.classList.add('out'); setTimeout(() => { st.remove(); if (c.stamp === st) c.stamp = null }, 520) }
  })
}

// ---------------------------------------------------------------- one frame from the server
function onFrame(f) {
  const now = performance.now()
  const snap = firstFrame || f.step !== prevStep + 1 || f.round !== lastRound
  if (f.round !== lastRound && !firstFrame) {
    for (const c of cards.values()) { c.el.classList.add('wipe'); c.stamp?.remove(); c.stamp = null; c.stampBuy = 0; setTimeout(() => c.el.classList.remove('wipe'), 520) }
  }
  F = f; prevStep = f.step; lastRound = f.round

  trails.clear()
  for (const h of f.history) if (h.step > f.roundStart) { let t = trails.get(h.buy); if (!t) trails.set(h.buy, (t = [])); t.push(h) }
  syncCards(f, now, snap)

  // new buys and bounced orders -> effects (not for what happened before this pane opened)
  const newest = f.receipts.length ? f.receipts[f.receipts.length - 1].id : 0
  if (firstFrame) { seenBuy = newest; seenBounce = f.bounce?.id ?? 0 }
  else if (newest < seenBuy) seenBuy = 0 // the server was reset
  for (const b of f.receipts) if (b.id > seenBuy) buyFx(b)
  seenBuy = newest
  if (f.bounce && f.bounce.id !== seenBounce) { seenBounce = f.bounce.id; const p = anchor(f.bounce.name); if (p) floaters.push({ x: p.x, y: p.y, text: 'order bounced: the price jumped past the budget', color: [251, 113, 133], life: 0, max: 1.8 }) }

  // top bar
  $('title').textContent = f.title || 'Jev Shopper'
  $('s-buys').textContent = String(f.score.buys)
  $('s-acc').textContent = f.score.accuracy == null ? '—' : Math.round(f.score.accuracy * 100) + '%'
  $('pause').textContent = f.running ? 'Pause' : 'Play'
  const e = $('cfgError')
  e.classList.toggle('hidden', !(f.cfgError || f.error))
  e.textContent = f.cfgError ? `${f.cfgError} — the last good shopper.json keeps running` : f.error ? `Jev call failed: ${f.error}` : ''

  // sliders follow the config unless a hand is on them
  const tps = 1000 / f.tickMs
  if (!dragging.has('budget')) $('budget').value = String(f.budget)
  if (!dragging.has('vol')) $('vol').value = String(f.vol)
  if (!dragging.has('speed')) $('speed').value = String(clamp(tps, 1, 16))
  $('budgetVal').textContent = '$' + money(f.budget, 0)
  $('volVal').textContent = (f.vol * 100).toFixed(f.vol * 100 % 1 ? 1 : 0) + '%'
  $('speedVal').textContent = tps.toFixed(tps < 10 && tps % 1 ? 1 : 0) + ' /s'
  $('add').disabled = f.streams.length >= 8

  // Jev's line above the board
  const j = f.jev
  $('lampSay').innerHTML = f.phase === 'result' ? 'round over' : j.watchOnly ? 'nothing can be bought right now · still watching' : j.pick === '—' ? 'reading the board…'
    : `best buy <em>${esc(j.pick)}</em> · ${Math.round(j.confidence * 100)}% sure · spend now? ${Math.round(j.act * 100)}%`

  // budget strip
  $('roundLab').innerHTML = `<b>Round ${f.round}</b> · tick ${Math.min(f.roundTick, f.maxRoundTicks)} / ${f.maxRoundTicks}`
  $('budgetLab').innerHTML = `budget $${money(f.budget, 0)} · spent $${money(f.spent, 0)} · <b>left $${money(f.cash, 0)}</b>`
  const buys = f.streams.flatMap((s, i) => s.buys.map((b) => ({ ...b, hue: HUES[i % HUES.length], name: s.name }))).sort((a, b) => a.id - b.id)
  const key = buys.map((b) => b.id).join(',') + '|' + Math.round(f.cash) + '|' + f.round
  if (key !== budgetKey) {
    budgetKey = key
    const total = Math.max(1, f.spent + f.cash)
    const bar = $('budgetBar'); bar.textContent = ''
    for (const b of buys) { const i = document.createElement('i'); i.style.width = (b.price / total) * 100 + '%'; i.style.background = rgba(b.hue, 0.85); i.title = `${b.name} · $${money(b.price)}`; bar.appendChild(i) }
    const left = document.createElement('i'); left.className = 'left'; left.style.width = (f.cash / total) * 100 + '%'; bar.appendChild(left)
  }

  // rail
  $('stateText').textContent = f.stateText || ''
  const pill = $('phasePill'); pill.textContent = f.phase === 'result' ? 'round over' : 'shopping'; pill.className = 'right pill' + (f.phase === 'result' ? ' result' : '')
  const rk = f.receipts.map((b) => b.id).join(',')
  if (rk !== receiptKey) {
    receiptKey = rk
    const ul = $('receipts'); ul.textContent = ''
    if (!f.receipts.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'no buys yet: Jev is waiting for a deal'; ul.appendChild(li) }
    for (const b of f.receipts.slice().reverse()) {
      const li = document.createElement('li'); if (b.saved < 0) li.className = 'bad'
      li.innerHTML = `<span>R${b.round}</span><span class="n">${b.flash ? '⚡ ' : ''}${esc(b.name)}</span><span>$${money(b.price)}</span><span class="s">${b.saved >= 0 ? '+' : '−'}$${money(Math.abs(b.saved))}</span>`
      li.title = `usual price $${money(b.avg)} · seen at $${money(b.seen)} when Jev called it`
      ul.appendChild(li)
    }
  }
  $('receiptSum').textContent = f.score.buys ? `paid $${money(f.score.paid, 0)} · usual $${money(f.score.avgSum, 0)}` : ''

  // round result
  const res = $('result')
  if (f.phase === 'result' && f.result) {
    if (lastResultRound !== f.result.round || res.classList.contains('hidden')) {
      lastResultRound = f.result.round
      const r = f.result
      res.className = 'result' + (r.saved < 0 ? ' bad' : '')
      res.innerHTML = `<h2>${r.buys ? `${r.saved >= 0 ? 'Saved' : 'Overpaid'} $${money(Math.abs(r.saved))} <span style="font-size:15px">(${(Math.abs(r.savedPct) * 100).toFixed(1)}%)</span>` : 'No buys'}</h2>` +
        `<p>Round ${r.round} · ${r.reason === 'budget' ? 'budget spent' : 'time is up'} · ${r.buys} ${r.buys === 1 ? 'buy' : 'buys'} · paid $${money(r.paid, 0)} against a usual $${money(r.avgSum, 0)}</p>` +
        '<p class="next">next round in a moment: new seed, new made-up prices</p>'
      if (!firstFrame && r.buys && r.saved > 0) { const b = board.getBoundingClientRect(); burst(b.width / 2, b.height / 2 - 30, 'coin', 46) }
    }
  } else res.classList.add('hidden')

  firstFrame = false
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))

// ---------------------------------------------------------------- effects
function anchor(name) {
  const c = cards.get(name); if (!c) return null
  const b = board.getBoundingClientRect(), r = c.el.getBoundingClientRect()
  return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height * 0.45 }
}
function burst(x, y, kind, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = kind === 'coin' ? 120 + Math.random() * 300 : 80 + Math.random() * 360
    particles.push({ kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (kind === 'coin' ? 220 : 0), life: 0, max: kind === 'coin' ? 1.1 + Math.random() * 0.6 : 0.35 + Math.random() * 0.35, r: kind === 'coin' ? 2.5 + Math.random() * 2.5 : 1.5, spin: Math.random() * 6.28 })
  }
}
function buyFx(b) {
  const p = anchor(b.name); if (!p) return
  const good = b.saved >= 0
  burst(p.x, p.y, 'coin', good ? 30 : 8)
  rings.push({ x: p.x, y: p.y, r: 10, life: 0, max: 0.7, color: good ? [52, 211, 153] : [251, 113, 133] })
  floaters.push({ x: p.x, y: p.y - 26, text: `${good ? '+' : '−'}$${money(Math.abs(b.saved))} ${good ? 'saved' : 'over the usual price'}`, color: good ? [110, 231, 183] : [251, 113, 133], life: 0, max: 1.7, big: true })
}

// ---------------------------------------------------------------- charts
function drawChart(c, now) {
  const s = c.s, g = c.ctx, w = c.w, h = c.h
  if (!s || w < 20 || h < 20) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
  const series = s.series, fair = s.fairSeries, n = series.length
  if (n < 2) return
  const padL = 2, padR = 52, padT = 12, padB = 14
  const pw = w - padL - padR, ph = h - padT - padB, dx = pw / (SHOW - 1), xr = padL + pw
  const u = !F.running || c.at < 0 ? 1 : clamp((now - c.at) / Math.max(40, F.tickMs), 0, 1)
  const X = (i) => (i === n - 1 ? xr : xr - (n - 1 - i) * dx + (1 - u) * dx)
  const eu = easeOut(u)
  const V = (arr, i) => (i === n - 1 ? arr[n - 2] + (arr[n - 1] - arr[n - 2]) * eu : arr[i])

  const from = Math.max(0, n - SHOW - 2)
  let lo = Infinity, hi = -Infinity
  for (let i = from; i < n; i++) { lo = Math.min(lo, series[i], fair[i]); hi = Math.max(hi, series[i], fair[i]) }
  lo = Math.min(lo, s.avg * (1 - F.minDeal) * 0.99); hi = Math.max(hi, s.avg * 1.01)
  const padv = (hi - lo) * 0.1 || 1; lo -= padv; hi += padv
  if (c.lo == null) { c.lo = lo; c.hi = hi; c.avgShown = s.avg } else { c.lo += (lo - c.lo) * 0.09; c.hi += (hi - c.hi) * 0.09; c.avgShown += (s.avg - c.avgShown) * 0.2 }
  const Y = (v) => padT + ph - ((v - c.lo) / (c.hi - c.lo || 1)) * ph
  const avgY = Y(c.avgShown), dealY = Y(c.avgShown * (1 - F.minDeal))

  // grid
  g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.035)'
  for (let k = 1; k < 4; k++) { const y = Math.round(padT + (ph * k) / 4) + 0.5; g.beginPath(); g.moveTo(padL, y); g.lineTo(xr, y); g.stroke() }

  g.save(); g.beginPath(); g.rect(padL, 0, pw + 1, h); g.clip()
  // the deal zone: under this line the standing order fires
  const dz = g.createLinearGradient(0, dealY, 0, h); dz.addColorStop(0, 'rgba(52,211,153,.10)'); dz.addColorStop(1, 'rgba(52,211,153,0)')
  g.fillStyle = dz; g.fillRect(padL, dealY, pw, h - dealY)
  g.setLineDash([2, 4]); g.strokeStyle = 'rgba(52,211,153,.55)'; g.beginPath(); g.moveTo(padL, dealY); g.lineTo(xr, dealY); g.stroke()
  g.setLineDash([6, 5]); g.strokeStyle = 'rgba(255,255,255,.38)'; g.beginPath(); g.moveTo(padL, avgY); g.lineTo(xr, avgY); g.stroke()
  g.setLineDash([])

  const path = (arr) => { g.beginPath(); for (let i = from; i < n; i++) { const x = X(i), y = Y(V(arr, i)); i === from ? g.moveTo(x, y) : g.lineTo(x, y) } }
  // money saved: the area where the price runs under the usual price
  g.save(); g.beginPath(); g.rect(padL, avgY, pw + 1, h - avgY); g.clip()
  path(series); g.lineTo(xr, avgY); g.lineTo(X(from), avgY); g.closePath()
  g.fillStyle = 'rgba(52,211,153,.16)'; g.fill(); g.restore()
  // body glow under the line
  path(series); g.lineTo(xr, h); g.lineTo(X(from), h); g.closePath()
  const body = g.createLinearGradient(0, padT, 0, h); body.addColorStop(0, rgba(c.hue, 0.2)); body.addColorStop(1, rgba(c.hue, 0))
  g.fillStyle = body; g.fill()
  if (showFair) { g.setLineDash([2, 3]); g.lineWidth = 1.6; g.strokeStyle = 'rgba(253,230,138,.8)'; path(fair); g.stroke(); g.setLineDash([]) }
  g.lineWidth = 2; g.lineJoin = 'round'; g.strokeStyle = rgba(c.hue, 1); g.shadowColor = rgba(c.hue, 0.9); g.shadowBlur = 9
  path(series); g.stroke(); g.shadowBlur = 0

  // Jev's spotlight trail along the bottom
  const tr = trails.get(s.name)
  if (tr) for (const t of tr) { const i = n - 1 - (F.step - t.step); if (i < from) continue; g.fillStyle = `rgba(245,158,11,${0.25 + 0.75 * t.conf})`; g.fillRect(X(i) - dx / 2, h - 8, Math.max(2, dx - 0.5), 5) }
  // buys
  for (const b of s.buys) {
    const i = n - 1 - (F.step - b.step); if (i < from) continue
    const x = X(i), y = Y(b.price), col = b.saved >= 0 ? [52, 211, 153] : [251, 113, 133]
    g.strokeStyle = rgba(col, 0.35); g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x, h - 9); g.stroke()
    g.fillStyle = '#07080d'; g.strokeStyle = rgba(col, 1); g.lineWidth = 2; g.shadowColor = rgba(col, 0.9); g.shadowBlur = 8
    g.beginPath(); g.arc(x, y, 4.5, 0, 6.29); g.fill(); g.stroke(); g.shadowBlur = 0
  }
  g.restore()

  // head dot, price tag and the usual-price label in the right gutter
  const hy = Y(V(series, n - 1)), pulse = 0.5 + 0.5 * Math.sin(now / 160)
  g.fillStyle = rgba(c.hue, 0.18 + 0.12 * pulse); g.beginPath(); g.arc(xr, hy, 8 + 3 * pulse, 0, 6.29); g.fill()
  g.fillStyle = '#fff'; g.shadowColor = rgba(c.hue, 1); g.shadowBlur = 12; g.beginPath(); g.arc(xr, hy, 3, 0, 6.29); g.fill(); g.shadowBlur = 0
  g.font = '700 10px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle'; g.textAlign = 'left'
  const ty = clamp(hy, 9, h - 9)
  g.fillStyle = rgba(c.hue, 0.95); roundRect(g, xr + 7, ty - 8, 43, 16, 4); g.fill()
  g.fillStyle = '#0a0b10'; g.fillText(V(series, n - 1).toFixed(V(series, n - 1) >= 1000 ? 0 : 1), xr + 11, ty + 0.5)
  let ay = clamp(avgY, 8, h - 8); if (Math.abs(ay - ty) < 15) ay = clamp(ty + (avgY >= hy ? 16 : -16), 8, h - 8)
  g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 9px ui-monospace, Menlo, monospace'; g.fillText('usual', xr + 9, ay - 5 < 6 ? ay + 1 : ay - 4)
  g.fillText(c.avgShown.toFixed(c.avgShown >= 1000 ? 0 : 1), xr + 9, ay - 5 < 6 ? ay + 11 : ay + 6)
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath() }

// ---------------------------------------------------------------- the spotlight layer
function sizeFx() {
  const r = board.getBoundingClientRect()
  fxW = r.width; fxH = r.height
  fxc.width = Math.max(1, Math.round(fxW * dpr)); fxc.height = Math.max(1, Math.round(fxH * dpr))
}
new ResizeObserver(sizeFx).observe(board)

function cone(x, y, x0, x1, bottom, a, col) {
  const g = fx.createLinearGradient(0, y, 0, bottom)
  g.addColorStop(0, rgba(col, a)); g.addColorStop(0.5, rgba(col, a * 0.45)); g.addColorStop(1, rgba(col, a * 0.12))
  fx.fillStyle = g
  fx.beginPath(); fx.moveTo(x - 4, y); fx.lineTo(x + 4, y); fx.lineTo(x1, bottom); fx.lineTo(x0, bottom); fx.closePath(); fx.fill()
}

function drawFx(now, dt) {
  fx.setTransform(dpr, 0, 0, dpr, 0, 0); fx.clearRect(0, 0, fxW, fxH)
  if (!F) return
  const b = board.getBoundingClientRect()
  let target = null
  for (const c of cards.values()) {
    c.pShown += (c.pTarget - c.pShown) * Math.min(1, dt * 9)
    const r = c.el.getBoundingClientRect()
    const box = { x0: r.left - b.left, x1: r.right - b.left, top: r.top - b.top, bottom: r.bottom - b.top }
    const cx = (box.x0 + box.x1) / 2
    // every product has a small lamp; it glows by the probability Jev gave that product
    const p = c.pShown
    if (p > 0.015) cone(cx, box.top - 3, box.x0 + 10, box.x1 - 10, box.bottom - 4, 0.05 + p * 0.2, [253, 224, 130])
    const lamp = fx.createRadialGradient(cx, box.top - 3, 0, cx, box.top - 3, 7 + p * 22)
    lamp.addColorStop(0, `rgba(255,244,200,${0.25 + p * 0.75})`); lamp.addColorStop(1, 'rgba(245,158,11,0)')
    fx.fillStyle = lamp; fx.beginPath(); fx.arc(cx, box.top - 3, 7 + p * 22, 0, 6.29); fx.fill()
    if (c.el.classList.contains('pick')) target = { box, cx, conf: F.jev.confidence }
  }

  // the big spotlight glides to Jev's pick; the less sure Jev is, the wider it spills
  const k = Math.min(1, dt * 7.5)
  if (target) {
    const spill = (1 - clamp(target.conf, 0, 1)) * 46
    const t = { x: target.cx, y: target.box.top - 12, x0: target.box.x0 - spill, x1: target.box.x1 + spill, bottom: target.box.bottom + 6 }
    if (!beam.ready) { Object.assign(beam, t, { ready: true, a: 0 }) }
    for (const key of ['x', 'y', 'x0', 'x1', 'bottom']) beam[key] += (t[key] - beam[key]) * k
    beam.conf += (target.conf - beam.conf) * k
    beam.a += (1 - beam.a) * k
  } else beam.a += (0 - beam.a) * k
  if (beam.ready && beam.a > 0.01) {
    const a = beam.a * (0.16 + 0.3 * beam.conf)
    cone(beam.x, beam.y, beam.x0, beam.x1, beam.bottom, a, [255, 236, 170])
    cone(beam.x, beam.y, beam.x0 + (beam.x1 - beam.x0) * 0.22, beam.x1 - (beam.x1 - beam.x0) * 0.22, beam.bottom, a * 0.8, [255, 250, 225])
    // pool of light on the floor
    const pw = (beam.x1 - beam.x0) / 2, px = (beam.x0 + beam.x1) / 2
    fx.save(); fx.translate(px, beam.bottom - 2); fx.scale(1, 0.12)
    const pool = fx.createRadialGradient(0, 0, 0, 0, 0, pw); pool.addColorStop(0, `rgba(255,236,170,${a * 1.5})`); pool.addColorStop(1, 'rgba(255,236,170,0)')
    fx.fillStyle = pool; fx.beginPath(); fx.arc(0, 0, pw, 0, 6.29); fx.fill(); fx.restore()
    // dust in the beam
    for (const m of motes) {
      m.v -= m.s * dt * 0.5; if (m.v < 0) { m.v = 1; m.u = Math.random() }
      const y = beam.y + (beam.bottom - beam.y) * m.v, half = ((beam.x1 - beam.x0) / 2) * m.v
      const x = (beam.x0 + beam.x1) / 2 * m.v + beam.x * (1 - m.v) + (m.u - 0.5) * 2 * half * 0.9 + Math.sin(now / 900 + m.ph) * 4
      fx.fillStyle = `rgba(255,244,210,${beam.a * (0.25 + 0.35 * Math.sin(now / 300 + m.ph) ** 2)})`
      fx.fillRect(x, y, 1.6, 1.6)
    }
    // the lamp head and its trail
    beam.trail.push({ x: beam.x, y: beam.y }); if (beam.trail.length > 14) beam.trail.shift()
    beam.trail.forEach((t, i) => { fx.fillStyle = `rgba(255,236,170,${(i / beam.trail.length) * 0.22 * beam.a})`; fx.beginPath(); fx.arc(t.x, t.y, 3 + (i / beam.trail.length) * 5, 0, 6.29); fx.fill() })
    const head = fx.createRadialGradient(beam.x, beam.y, 0, beam.x, beam.y, 30)
    head.addColorStop(0, `rgba(255,255,255,${beam.a})`); head.addColorStop(0.25, `rgba(255,236,170,${0.8 * beam.a})`); head.addColorStop(1, 'rgba(245,158,11,0)')
    fx.fillStyle = head; fx.beginPath(); fx.arc(beam.x, beam.y, 30, 0, 6.29); fx.fill()
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life += dt
    if (p.life >= p.max) { particles.splice(i, 1); continue }
    const fade = 1 - p.life / p.max
    if (p.kind === 'coin') {
      p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.992
      const squash = Math.abs(Math.cos(p.spin + p.life * 9))
      fx.fillStyle = `rgba(253,224,71,${Math.min(1, fade * 1.6)})`; fx.beginPath(); fx.ellipse(p.x, p.y, p.r * (0.25 + 0.75 * squash), p.r, 0, 0, 6.29); fx.fill()
      fx.fillStyle = `rgba(255,255,240,${fade * 0.8})`; fx.fillRect(p.x - 0.6, p.y - p.r * 0.5, 1.2, p.r * 0.7)
    } else {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94
      fx.strokeStyle = `rgba(${i % 2 ? '244,114,182' : '253,224,71'},${fade})`; fx.lineWidth = 1.6
      fx.beginPath(); fx.moveTo(p.x, p.y); fx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); fx.stroke()
    }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.life += dt
    if (r.life >= r.max) { rings.splice(i, 1); continue }
    const q = r.life / r.max
    fx.strokeStyle = rgba(r.color, 1 - q); fx.lineWidth = 3 * (1 - q) + 0.5; fx.beginPath(); fx.arc(r.x, r.y, r.r + easeOut(q) * 90, 0, 6.29); fx.stroke()
  }
  fx.textAlign = 'center'; fx.textBaseline = 'middle'
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.life += dt
    if (f.life >= f.max) { floaters.splice(i, 1); continue }
    const q = f.life / f.max
    fx.font = `800 ${f.big ? 17 : 12}px ui-monospace, Menlo, monospace`
    fx.shadowColor = rgba(f.color, 0.9); fx.shadowBlur = 14
    fx.fillStyle = rgba(f.color, q < 0.75 ? 1 : (1 - q) * 4)
    fx.fillText(f.text, clamp(f.x, 150, fxW - 150), f.y - easeOut(q) * 54)
    fx.shadowBlur = 0
  }
}

// ---------------------------------------------------------------- 60 fps loop
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  if (F) {
    for (const c of cards.values()) {
      if (!c.s) continue
      c.priceShown = c.priceShown == null ? c.s.price : c.priceShown + (c.s.price - c.priceShown) * Math.min(1, dt * 14)
      const txt = money(c.priceShown)
      if (txt !== c.lastTxt) { c.lastTxt = txt; c.pv.textContent = txt }
      drawChart(c, now)
    }
    shown.saved += (F.score.saved - shown.saved) * Math.min(1, dt * 6)
    shown.cash += (F.cash - shown.cash) * Math.min(1, dt * 8)
    const sv = $('s-saved'), v = Math.abs(shown.saved) < 0.5 ? 0 : shown.saved
    sv.innerHTML = `${v < 0 ? '−' : ''}$${money(Math.abs(v), 0)}<small>${(F.score.savedPct * 100).toFixed(1)}%</small>`
    sv.className = v > 0 ? 'up' : v < 0 ? 'down' : ''
    $('s-cash').textContent = '$' + money(shown.cash, 0)
  }
  tele.shownRate += (tele.rate - tele.shownRate) * Math.min(1, dt * 5)
  tele.shownCost += (tele.cost - tele.shownCost) * Math.min(1, dt * 5)
  $('s-rate').textContent = tele.shownRate.toFixed(1)
  $('s-cost').textContent = '$' + tele.shownCost.toFixed(tele.shownCost < 0.1 ? 5 : 3)
  drawFx(now, dt)
  requestAnimationFrame(loop)
}

// ---------------------------------------------------------------- controls
function slider(id, toBody) {
  const el = $(id); let t = 0, queued = null
  const send = () => { t = 0; if (queued) { post(queued); queued = null } }
  el.addEventListener('pointerdown', () => dragging.add(id))
  window.addEventListener('pointerup', () => dragging.delete(id))
  el.addEventListener('blur', () => dragging.delete(id))
  el.addEventListener('input', () => { queued = toBody(Number(el.value)); if (!t) t = setTimeout(send, 60) })
}
slider('budget', (v) => ({ cmd: 'set', key: 'cash', value: v }))
slider('vol', (v) => ({ cmd: 'set', key: 'vol', value: v }))
slider('speed', (v) => ({ cmd: 'set', key: 'tickMs', value: Math.round(1000 / v) }))
$('add').onclick = () => post({ cmd: 'add' })
$('fair').onchange = (e) => { showFair = e.target.checked; if (F) for (const c of cards.values()) c.real.classList.toggle('on', showFair && c.s && c.s.trueDisc <= -0.05) }
$('pause').onclick = () => post({ cmd: F && F.running ? 'pause' : 'start' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })

async function pollJev() {
  try { const j = await (await fetch('/jev')).json(); tele.rate = j.callsPerSec || 0; tele.cost = j.costUsd || 0 } catch { /* the server is restarting */ }
  setTimeout(pollJev, 450)
}

window.addEventListener('resize', () => { dpr = Math.max(1, window.devicePixelRatio || 1); sizeFx(); for (const c of cards.values()) sizeCanvas(c) })
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
sizeFx(); pollJev(); requestAnimationFrame(loop)
