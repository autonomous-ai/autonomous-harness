// Jev Guard pane — a dashboard of Jev judging the coding agent's own live edits.

const $ = (id) => document.getElementById(id)
const els = { goal: $('goal'), run: $('run'), verdict: $('verdict'), chart: $('chart'), log: $('log'), output: $('output'), title: $('title'), meta: $('meta') }

let history = []
let lastRun = null

function setMeter(key, val) {
  const pct = Math.round((val / 2) * 100)
  document.querySelector(`.meter .bar i[data-k="${key}"]`).style.width = pct + '%'
  document.querySelector(`.meter .v[data-v="${key}"]`).textContent = val.toFixed(1) + '/2'
}

function renderRun(msg) {
  const t = msg.lastRun
  els.run.className = ''
  els.run.innerHTML = ''
  if (!t) {
    els.run.innerHTML = '<div class="pulse"></div><span>waiting for the agent\'s first edit…</span>'
    return
  }
  const pulse = document.createElement('div'); pulse.className = 'pulse'
  const span = document.createElement('span')
  span.textContent = t.passed
    ? `passed — tests green (run ${msg.runCount})`
    : `failed — tests failing (run ${msg.runCount})`
  els.run.append(pulse, span)
  els.run.classList.add(t.passed ? 'pass' : 'fail')
  els.output.textContent = t.output.trim() || '(no output)'
}

function renderVerdict() {
  const last = history[history.length - 1]
  const v = els.verdict
  v.textContent = '— no run judged yet —'
  v.className = 'verdict'
  if (!last) return
  setMeter('toward', last.toward)
  setMeter('trust', last.trust)
  setMeter('risk', last.risk)
  if (last.passed) {
    v.textContent = 'goal met — Jev trusts this state'
    v.classList.add('done')
  } else if (last.toward >= 1) {
    v.textContent = 'progress — tests still failing, Jev is wary'
    v.classList.add('work')
  } else {
    v.textContent = 'failing — Jev is not confident'
    v.classList.add('fail')
  }
}

function renderLog() {
  els.log.textContent = ''
  for (const h of history) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="i">#${h.i}</span><span class="status ${h.passed ? 'pass' : 'fail'}">${h.passed ? 'PASS' : 'FAIL'}</span><span>toward ${h.toward.toFixed(1)} · trust ${h.trust.toFixed(1)} · risk ${h.risk.toFixed(1)}</span>`
    if (h.changed && h.changed !== '(no file changes)') {
      const ch = document.createElement('span'); ch.className = 'ch'; ch.textContent = h.changed
      li.appendChild(ch)
    }
    els.log.appendChild(li)
  }
  els.log.scrollTop = els.log.scrollHeight
}

function drawChart() {
  const cv = els.chart, ctx = cv.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = 160
  cv.width = W * dpr; cv.height = H * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  ctx.strokeStyle = '#1c2030'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(4, H - 20); ctx.lineTo(W - 4, H - 20); ctx.stroke()
  if (history.length < 2) return
  const x = (i) => 6 + (i / (history.length - 1)) * (W - 12)
  const y = (v) => H - 20 - v * (H - 32)
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath()
    history.forEach((h, i) => { const px = x(i), py = y(h[key] / 2); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
    ctx.stroke()
  }
  line('toward', '#5eead4')
  line('trust', '#c084fc')
  line('risk', '#fb7185')
}

function onJudge(msg) {
  els.title.textContent = msg.title || ''
  els.meta.textContent = msg.running ? 'auto-judging on edits' : 'manual'
  els.goal.textContent = msg.goal || ''
  history = msg.history || history
  lastRun = msg.lastRun
  renderRun(msg)
  renderVerdict()
  renderLog()
  drawChart()
}

$('judge').onclick = () => ctl('judge')
$('pause').onclick = () => ctl('pause')
$('start').onclick = () => ctl('start')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) }); if (!r.ok) throw new Error(String(r.status)) }
  catch (e) { console.error('control failed', e) }
}

window.addEventListener('resize', drawChart)

function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onJudge(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
