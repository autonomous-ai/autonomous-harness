// Jev Conductor pane — renders Jev's live composition as a scrolling score and performs it with
// the Web Audio API. The server streams bars over SSE; we queue each bar's notes onto the audio
// clock in advance so pitch, timing and right-hand sync stay tight.

const $ = (id) => document.getElementById(id)
const els = { keyboard: $('keyboard'), score: $('score'), meta: $('meta'), title: $('title'), now: $('now'), log: $('log') }

// ---- Web Audio ----
const AudioCtx = window.AudioContext || window.webkitAudioContext
let ctx = null
let master = null
let nextBarTime = 0
let seqBar = 0

const NOTE_STEP = Math.pow(2, 1 / 12)
const midi = (n) => {
  const map = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
  const m = String(n).match(/^([A-G]#?)(\d)$/)
  if (!m) return null
  return map[m[1]] + (Number(m[2]) + 1) * 12
}

function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  ctx = new AudioCtx()
  master = ctx.createGain()
  master.gain.value = 0.8
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -18; comp.ratio.value = 6
  master.connect(comp); comp.connect(ctx.destination)
}

// A soft plucky sine voice with a touch of warmth.
function voice(type = 'lead') {
  const osc = ctx.createOscillator()
  osc.type = type === 'bass' ? 'triangle' : 'sine'
  const g = ctx.createGain()
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = type === 'bass' ? 700 : 3200
  osc.connect(f); f.connect(g); g.connect(master)
  return { osc, g }
}

function playNote(m, time, dur, vol, type) {
  if (m == null) return
  ensureAudio()
  const v = voice(type)
  const f = 440 * Math.pow(NOTE_STEP, m - 69)
  v.osc.frequency.setValueAtTime(f, time)
  v.osc.frequency.exponentialRampToValueAtTime(f * (type === 'bass' ? 0.995 : 1.001), time + dur)
  v.g.gain.setValueAtTime(0.0001, time)
  v.g.gain.exponentialRampToValueAtTime(vol, time + 0.012)
  v.g.gain.exponentialRampToValueAtTime(0.0001, time + dur)
  v.osc.start(time); v.osc.stop(time + dur + 0.05)
}

function scheduleBar(bar, piece, at) {
  if (!ctx) return
  const barSec = (60 / Math.max(20, piece.tempo)) * piece.beatsPerBar
  const count = piece.leadNotes || 8
  const step = barSec / count
  const energy = typeof bar.energy === 'number' ? bar.energy : 1
  // bass on beat 1 + a passing note on the 3rd beat
  const bassM = midi(bar.bass)
  playNote(bassM, at, barSec * 0.85, 0.3, 'bass')
  playNote(bassM, at + barSec * 0.5, barSec * 0.4, 0.18, 'bass')
  // chord strokes on beats
  const chordM = midi(bar.chordM0 || bar.bass)
  for (let i = 0; i < piece.beatsPerBar; i++) {
    playNote((chordM ?? 48) + 12 + i, at + i * (barSec / piece.beatsPerBar), 0.35, 0.06 + energy * 0.03, 'chord')
  }
  // lead phrase
  bar.lead.forEach((n, i) => {
    const swing = i % 2 === 1 ? piece.swing * step * 0.5 : 0
    playNote(midi(n), at + i * step + swing, Math.max(0.05, step * (energy > 1 ? 0.8 : 0.55)), 0.22 + energy * 0.05, 'lead')
  })
  return barSec
}

function primeBar(bar, piece) {
  ensureAudio()
  if (!nextBarTime || nextBarTime < ctx.currentTime + 0.2) nextBarTime = ctx.currentTime + 0.1
  const barSec = scheduleBar(bar, piece, nextBarTime)
  nextBarTime += barSec
  seqBar = bar.bar
}

// ---- Rendering ----
let plan = []
let piece = { tempo: 96, beatsPerBar: 4, swing: 0.2, scale: [], bassScale: [], chords: [], moods: [], leadNotes: 8, volume: 0.6 }
let composition = []  // {bar, chord, mood, notes:[...], bass, energy}
let playing = false
let currentBar = 0

function renderKeyboard() {
  els.keyboard.textContent = ''
  for (const n of piece.scale) {
    const k = document.createElement('div')
    k.className = 'key'
    k.dataset.note = n
    k.textContent = n
    els.keyboard.appendChild(k)
  }
}

function flash(msg) {
  const { note, bass } = msg
  for (const k of els.keyboard.childNodes) {
    k.classList.toggle('hit', k.dataset.note === note)
    k.classList.toggle('bass-hit', k.dataset.note === bass)
  }
}

function renderScore() {
  els.score.textContent = ''
  composition.forEach((bar) => {
    const li = document.createElement('li')
    li.className = 'bar' + (bar.bar === currentBar ? ' current' : '')
    li.innerHTML = `
      <div class="num">${bar.bar}</div>
      <div class="chord">${bar.chord}</div>
      <div class="mood ${bar.mood}">${bar.mood}</div>
      <div class="notes">${bar.notes.map((n) => `<span data-note="${n}">${n}</span>`).join('')}</div>
      <div class="bass">Bass ${bar.bass}</div>
      <div class="energy"><i style="width:${Math.round(bar.energy / 2 * 100)}%"></i></div>`
    els.score.appendChild(li)
  })
}

function renderNow(bar) {
  if (!bar) return
  els.now.innerHTML = `
    <div class="row"><span class="k">Bar</span><span class="v">${bar.bar}</span></div>
    <div class="row"><span class="k">Chord</span><span class="v">${bar.chord}</span></div>
    <div class="row"><span class="k">Mood</span><span class="v">${bar.mood}</span></div>
    <div class="row"><span class="k">Energy</span><span class="v">${bar.energy.toFixed(1)}/2</span></div>
    <div class="row"><span class="k">Model</span><span class="v">${bar.client || '—'}</span></div>`
}

function renderLog() {
  els.log.textContent = ''
  for (const bar of plan.slice(-20)) {
    const li = document.createElement('li')
    li.innerHTML = `<span>${bar.bar}</span><b>${bar.chord}</b><span class="ch">🎹</span><span class="bs">${bar.bass}</span><span>${bar.mood}</span>`
    els.log.appendChild(li)
  }
}

function onBar(msg) {
  piece = msg.piece || piece
  els.title.textContent = msg.title || piece.title || ''
  els.meta.textContent = `${piece.tempo} bpm · ${piece.beatsPerBar}/4 · play on ▶`
  plan = msg.plan || plan
  // Rebuild composition from the streamed plan (server sends the tail).
  composition = plan.slice().map((b) => ({
    ...b,
    client: b.client,
    notes: b.lead,
    chordM0: b.bass,
  }))
  renderLog()
  if (plan.length) {
    const last = plan[plan.length - 1]
    currentBar = last.bar
    if (playing && last.bar > seqBar) primeBar(last, piece)
    renderScore()
    renderNow(last)
    flash({ note: last.lead[0], bass: last.bass })
    els.score.scrollTop = els.score.scrollHeight
  }
}

// ---- Controls ----
$('play').onclick = () => {
  ensureAudio()
  playing = true
  // Start the audio clock on the most recent composed bar so sound begins right away, then keep
  // following the live stream.
  if (composition.length && (!nextBarTime || nextBarTime < ctx.currentTime + 0.1)) {
    primeBar(composition[composition.length - 1], piece)
  }
  ctl('start')
}
$('pause').onclick = () => { playing = false; ctl('pause') }
$('reset').onclick = () => { composition = []; plan = []; seqBar = 0; nextBarTime = 0; renderScore(); ctl('reset') }
$('onemore').onclick = () => ctl('onemore')

async function ctl(cmd) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
    if (!r.ok) throw new Error(String(r.status))
  } catch (e) { console.error('control failed', e) }
}

// Blink the playing bar highlight on the audio clock.
setInterval(() => {
  if (!playing || !ctx) return
  currentBar = seqBar
  const active = els.score.querySelectorAll('.bar')
  active.forEach((el, i) => el.classList.toggle('current', composition[i]?.bar === seqBar))
}, 120)

// ---- SSE ----
function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onBar(JSON.parse(e.data)))
  es.onerror = () => { /* EventSource auto-reconnects */ }
}
connect()
