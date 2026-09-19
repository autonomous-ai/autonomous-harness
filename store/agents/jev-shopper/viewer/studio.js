// Jev Shopper pane — draws the shop window of live price cards with sparklines, highlights Jev's
// current best-buy call, and logs each decision. The price cards are the show; Jev's pick is the
// beat.

const $ = (id) => document.getElementById(id)
const els = { ticks: $('ticks'), pick: $('pick'), sure: $('sure'), cash: $('cash'), shelf: $('shelf'), log: $('log') }

let streams = []
let cash = 100
let lastPick = '—'
let lastConf = 0
let lastAct = 0
let history = []
let ticks = 0
let bought = new Set()

function spark(canvas, series) {
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth, H = canvas.clientHeight
  canvas.width = W * dpr; canvas.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  if (series.length < 2) { ctx.fillStyle = '#4b5266'; ctx.font = '9px monospace'; ctx.fillText('…', 4, 10); return }
  const lo = Math.min(...series), hi = Math.max(...series)
  const span = (hi - lo) || 1
  const pad = 2
  ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5
  ctx.beginPath()
  series.forEach((v, i) => {
    const x = pad + (i / (series.length - 1)) * (W - 2 * pad)
    const y = pad + (1 - (v - lo) / span) * (H - 2 * pad)
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  })
  ctx.stroke()
}

function renderShelf() {
  els.shelf.textContent = ''
  for (const s of streams) {
    const card = document.createElement('div')
    card.className = 'card' + (s.name === lastPick ? ' picked' : '') + (bought.has(s.name) ? ' bought' : '')
    const series = s.series || []
    const first = series[0], last = series[series.length - 1]
    const chg = first && last ? ((last - first) / first * 100) : 0
    const up = chg >= 0
    card.innerHTML = `
      <h3>${esc(s.name)}</h3>
      <div class="price">${(last ?? 0).toFixed(2)}</div>
      <div class="chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%</div>
      <canvas class="spark"></canvas>
      <div class="tag">${bought.has(s.name) ? 'bought for ' + last.toFixed(0) : s.name === lastPick ? 'best buy now' : 'watching'}</div>`
    els.shelf.appendChild(card)
    spark(card.querySelector('.spark'), series)
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function renderLog() {
  els.log.textContent = ''
  for (const h of history.slice(-30)) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="n">#${h.step}</span><span class="p">${esc(h.buy)}</span><span class="s">${(h.conf * 100).toFixed(0)}%</span>`
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function onTick(msg) {
  if (Array.isArray(msg.streams)) {
    streams = msg.streams
    for (const s of msg.committed || []) bought.add(s.name)
  }
  cash = msg.cash ?? cash
  lastPick = msg.lastPick || lastPick
  lastConf = msg.lastConf ?? lastConf
  lastAct = msg.lastAct ?? lastAct
  history = msg.history || history
  ticks = msg.step ?? ticks

  els.ticks.textContent = String(ticks)
  els.pick.textContent = lastPick
  els.sure.textContent = (lastConf * 100).toFixed(0) + '%'
  els.cash.textContent = String(Math.round(cash))
  renderShelf()
  renderLog()
}

$('pause').onclick = () => ctl('pause')
$('tick').onclick = () => ctl('tick')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

window.addEventListener('resize', renderShelf)

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
