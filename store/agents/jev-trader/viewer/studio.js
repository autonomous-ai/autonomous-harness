// Jev Trader pane — draws Jev's live paper-trading: equity + price curves, and the decision log.

const $ = (id) => document.getElementById(id)
const els = { title: $('title'), equity: $('equity'), return: $('return'), price: $('price'), cash: $('cash'), shares: $('shares'), chart: $('chart'), tape: $('tape'), log: $('log'), last: $('last') }

let history = []
let price = 100
let capital = 10000
let equityV = 10000

function fmt(n, d = 0) { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) }

function drawChart() {
  const cv = els.chart, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = 320
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  ctx.font = '10px ' + 'monospace'
  ctx.textBaseline = 'top'

  const pad = { l: 60, r: 14, t: 14, b: 24 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const px = (i) => pad.l + (history.length > 1 ? (i / (history.length - 1)) * plotW : pad.l)
  // normalize both series to their own min/max over the visible window
  const prices = history.map((h) => h.price)
  const equities = history.map((h) => h.equity)
  const all = [...prices, ...equities]
  const lo = Math.min(...all), hi = Math.max(...all)
  const span = (hi - lo) || 1
  const py = (v) => pad.t + plotH - ((v - lo) / span) * plotH
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath()
    history.forEach((h, i) => { const x = px(i), y = py(h[key]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
    ctx.stroke()
  }
  // gridlines + labels
  ctx.strokeStyle = '#1c2030'; ctx.lineWidth = 1; ctx.fillStyle = '#6b7280'
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (g / 4) * plotH
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke()
    ctx.fillText((hi - (g / 4) * span).toFixed(0), 4, y)
  }
  line('price', '#c084fc')
  line('equity', '#5eead4')
  ctx.fillStyle = '#8a90a6'
  ctx.fillText('price (violet)', pad.l + 6, H - 22)
  ctx.fillText('equity (cyan)', pad.l + 90, H - 22)
}

function renderStats() {
  els.equity.textContent = '$' + fmt(equityV, 0)
  const ret = ((equityV - capital) / capital) * 100
  els.return.textContent = (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%'
  els.return.style.color = ret >= 0 ? 'var(--ok)' : 'var(--rose)'
  els.price.textContent = '$' + fmt(price, 2)
}

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-40)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="d">d${h.day}</span><span class="act ${h.action.toLowerCase()}">${h.action}</span><span class="pr">$ ${fmt(h.price)}</span><span>x${h.shares}</span><span>eq ${fmt(h.equity, 0)}</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function renderTape(msg) {
  const last = history[history.length - 1]
  els.tape.className = ''
  if (!last) { els.tape.textContent = ''; const p = document.createElement('span'); p.className = 'pulse'; const s = document.createElement('span'); s.textContent = 'waiting for the first tick…'; els.tape.append(p, s); return }
  els.tape.classList.add(last.action.toLowerCase())
  const pulse = document.createElement('span'); pulse.className = 'pulse'
  const bar = document.createElement('span'); bar.className = 'bar'
  bar.innerHTML = `<b class="trade ${last.action.toLowerCase()}">${last.action}</b><span>x${last.shares} @ $${fmt(last.price, 2)}</span><span class="eq">$ ${fmt(last.equity, 0)}</span><span class="conf">conf ${(last.confidence * 100).toFixed(0)}%</span>`
  els.tape.append(pulse, bar)
  els.last.innerHTML = `<b class="trade ${last.action.toLowerCase()}">${last.action}</b> · x${last.shares} @ $${fmt(last.price, 2)}<br>conviction ${(last.conviction).toFixed(1)}/2 · equity $${fmt(last.equity, 0)}`
}

function onTick(msg) {
  els.title.textContent = msg.title || ''
  history = msg.history || history
  price = msg.price ?? price
  equityV = msg.equity ?? equityV
  capital = capital || msg.history?.[0]?.equity || 10000
  if (msg.cash !== undefined) els.cash.textContent = '$' + fmt(msg.cash, 0)
  if (msg.holdings !== undefined) els.shares.textContent = String(msg.holdings)
  renderStats()
  renderTape()
  renderLog()
  drawChart()
}

$('play').onclick = () => ctl('start')
$('pause').onclick = () => ctl('pause')
$('tick').onclick = () => ctl('tick')
$('reset').onclick = () => { history = []; capital = 10000; equityV = 10000; drawChart(); ctl('reset') }

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

window.addEventListener('resize', drawChart)

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
