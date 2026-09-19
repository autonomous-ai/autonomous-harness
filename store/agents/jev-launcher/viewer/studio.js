// Jev Launcher pane — the agent types and Jev re-ranks the palette live on every keystroke.
// Shows the full ranking with confidence bars, the top pick, and how the pick evolved as the query
// narrowed. Firing a launch is always the agent's choice — nothing is actually launched.

const $ = (id) => document.getElementById(id)
const els = { title: $('title'), query: $('query'), seq: $('seq'), results: $('results'), ranking: $('ranking'), launched: $('launched'), chart: $('chart') }

let history = []        // [{seq, query, top, conf, probs, ts}]
let launches = []       // [{name, ts}]
let targets = []

function fmtPct(x) { return (x * 100).toFixed(0) + '%' }

async function ctl(body) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) { console.error('control failed', e) }
}

function rankOptions() {
  const last = history[history.length - 1]
  const probs = last?.probs || {}
  return targets
    .map((t) => ({ t, p: probs[t.name] ?? 0 }))
    .sort((a, b) => b.p - a.p)
}

function renderResults() {
  els.results.textContent = ''
  const ranked = rankOptions()
  ranked.forEach(({ t, p }, i) => {
    const row = document.createElement('div')
    row.className = 'result' + (i === 0 ? ' sel' : '')
    row.innerHTML = `<span class="rank">${i + 1}</span><span class="name">${escapeHtml(t.name)}</span><span class="cat">${escapeHtml(t.category || '')}</span><span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span><span class="pct">${fmtPct(p)}</span>`
    row.onclick = () => { fire(t.name) }
    els.results.appendChild(row)
  })
}

function renderRanking() {
  els.ranking.textContent = ''
  for (const h of history.slice(-14)) {
    const row = document.createElement('div')
    row.className = 'rankrow'
    row.innerHTML = `<span class="r">#${h.seq}</span><span class="q">"${escapeHtml(h.query)}"</span><span class="t">→ ${escapeHtml(h.top)}</span><span class="pct">${fmtPct(h.conf)}</span>`
    els.ranking.appendChild(row)
  }
  els.ranking.scrollTop = els.ranking.scrollHeight
}

function renderLaunched() {
  els.launched.textContent = ''
  if (!launches.length) { els.launched.innerHTML = '<span class="empty">Press <b>Enter</b> to fire a launch (nothing really launches).</span>'; return }
  for (const l of launches.slice(-8).reverse()) {
    const item = document.createElement('div')
    item.className = 'item'
    item.innerHTML = `<span class="target">${escapeHtml(l.name)}</span><span class="dim">${l.ts.replace('T', ' ').slice(5, 19)}</span>`
    els.launched.appendChild(item)
  }
}

function drawChart() {
  const cv = els.chart, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = 200
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  ctx.font = '10px ' + 'monospace'
  ctx.textBaseline = 'top'
  if (history.length < 2) {
    ctx.fillStyle = '#4b5266'
    ctx.fillText('type to see Jev’s pick evolve…', 12, 12)
    return
  }
  const pad = { l: 8, r: 8, t: 10, b: 20 }
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b
  const px = (i) => pad.l + (i / (history.length - 1)) * plotW
  const py = (v) => pad.t + plotH - v * plotH
  ctx.strokeStyle = '#1c2030'; ctx.lineWidth = 1
  for (let g = 0; g <= 4; g++) { const y = pad.t + (g / 4) * plotH; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke() }
  ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 2; ctx.beginPath()
  history.forEach((h, i) => { const x = px(i), y = py(h.conf || 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
  ctx.stroke()
  ctx.fillStyle = '#8a90a6'
  ctx.fillText('Jev’s confidence in its top pick, per keystroke', pad.l, H - 4)
}

function onTick(msg) {
  els.title.textContent = msg.title || ''
  history = msg.history || history
  targets = msg.targets || targets
  if (msg.query !== undefined && document.activeElement !== els.query) els.query.value = msg.query
  if (msg.seq !== undefined) els.seq.textContent = '#' + msg.seq
  renderResults()
  renderRanking()
  renderLaunched()
  drawChart()
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

function fire(name) {
  launches.push({ name, ts: new Date().toISOString() })
  ctl({ cmd: 'launch' })
  renderLaunched()
}

let debounce = null
els.query.addEventListener('input', () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { if (thereIsAQuery()) ctl({ cmd: 'query', query: els.query.value }) }, 40)
})
els.query.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const top = rankOptions()[0]?.t?.name
    if (top) fire(top)
  }
})

function thereIsAQuery() { return els.query.value.length > 0 }

$('clear').onclick = () => { els.query.value = ''; ctl({ cmd: 'reset' }); focusQuery() }
$('demo').onclick = () => playDemo()
function focusQuery() { els.query.focus() }

// The demo types a query one keystroke at a time (one launch at the end).
const DEMO_QUERIES = ['deploy', 'music', 'email', 'test']
async function playDemo() {
  $('demo').disabled = true
  for (const q of DEMO_QUERIES) {
    els.query.value = ''
    await typeOut(q)
  }
  const top = rankOptions()[0]?.t?.name
  if (top) fire(top)
  $('demo').disabled = false
}
async function typeOut(q) {
  for (let i = 1; i <= q.length; i++) {
    els.query.value = q.slice(0, i)
    ctl({ cmd: 'query', query: els.query.value })
    await new Promise((r) => setTimeout(r, 260))
  }
}

focusQuery()
window.addEventListener('resize', drawChart)

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onTick(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
