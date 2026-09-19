// Jev Duel pane — renders the Reversi board, streams each move over SSE, shows Jev-on-both-sides
// thinking, and displays the referee's running calls.

const $ = (id) => document.getElementById(id)
const els = { board: $('board'), title: $('title'), meta: $('meta'), turn: $('turn'), scoreO: $('scoreO'), scoreX: $('scoreX'), refFocus: $('ref-focus'), refLog: $('ref-log'), log: $('log') }

let size = 6
let board = []
let counts = { O: 4, X: 4 }
let running = false
let gameOver = false
let rivals = { O: { name: 'Jev·O' }, X: { name: 'Jev·X' } }
let last = null

function renderBoard() {
  els.board.style.gridTemplateColumns = `repeat(${size}, auto)`
  els.board.textContent = ''
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    const v = board[y]?.[x]
    if (v === 'O' || v === 'X') {
      cell.classList.add(v.toLowerCase())
      const d = document.createElement('div'); d.className = 'disk'; cell.appendChild(d)
    }
    if (last && last.x === x && last.y === y) cell.classList.add('last')
    els.board.appendChild(cell)
  }
}

function renderScores() {
  els.scoreO.innerHTML = `<span class="chip"></span><span class="name">${rivals.O.name || 'O'}</span><span class="pts">${counts.O}</span>`
  els.scoreX.innerHTML = `<span class="pts">${counts.X}</span><span class="name">${rivals.X.name || 'X'}</span><span class="chip"></span>`
  const oA = document.querySelector('.side.o'), xA = document.querySelector('.side.x')
  oA.classList.toggle('thinking', running && !gameOver && last?.disk !== 'O')
  xA.classList.toggle('thinking', running && !gameOver && last?.disk !== 'X')
  if (gameOver) {
    els.turn.textContent = counts.O === counts.X ? 'Draw' : (counts.O > counts.X ? `${rivals.O.name} wins` : `${rivals.X.name} wins`)
  } else {
    els.turn.textContent = `${(last?.disk === 'O' ? rivals.X : rivals.O).name} thinking…`
  }
}

function refTag(r) {
  const strong = r?.strong ?? 1
  const agg = (r?.aggressive ?? 0.5) >= 0.55
  const decided = r?.decided ?? 0
  const s = strong >= 1.5 ? 'brilliant' : strong >= 0.5 ? 'solid' : 'blunder'
  const a = agg ? 'aggressive' : 'quiet'
  const d = decided >= 1.5 ? ' decided' : decided >= 0.5 ? ' leaning' : ' wide open'
  return `${s} · ${a}${d}`
}

function renderHistory() {
  els.refLog.textContent = ''
  els.log.textContent = ''
  // Server sends history tail (newest last) with ref already attached.
  for (const m of els._hist || []) {
    const ri = document.createElement('li')
    ri.innerHTML = `<span class="n">#${m.n}</span><span class="tag ${m.disk.toLowerCase()}">${m.side}</span><span>${m.x},${m.y} +${m.flips}</span><span>${refTag(m.ref)}</span>`
    els.refLog.appendChild(ri)
    const li = document.createElement('li')
    li.innerHTML = `<span>#${m.n}</span><b class="${m.disk.toLowerCase()}">${m.side}</b><span>→ ${m.x},${m.y} (flips ${m.flips})</span>`
    els.log.appendChild(li)
  }
  els.refLog.scrollTop = els.refLog.scrollHeight
  els.log.scrollTop = els.log.scrollHeight
}

function onFrame(msg) {
  size = msg.size || size
  board = msg.board || board
  counts = msg.counts || counts
  running = !!msg.running
  gameOver = !!msg.gameOver
  rivals = msg.rivals || rivals
  last = msg.history?.length ? msg.history[msg.history.length - 1] : null
  els._hist = msg.history || []
  els.title.textContent = msg.title || ''
  els.meta.textContent = msg.gameOver ? 'Game over' : (msg.running ? 'live' : 'paused')
  els.refFocus.textContent = msg.refereeFocus || ''
  renderBoard()
  renderScores()
  renderHistory()
}

// ---- Controls ----
$('play').onclick = () => ctl('start')
$('pause').onclick = () => ctl('pause')
$('step').onclick = () => ctl('step')
$('reset').onclick = () => ctl('reset')

async function ctl(cmd) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) { console.error('control failed', e) }
}

// ---- SSE ----
function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
  es.onerror = () => { /* auto-reconnect */ }
}
connect()
