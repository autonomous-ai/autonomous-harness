// The Strudel pane: Strudel's own REPL (the <strudel-editor> web component from @strudel/repl, loaded
// by index.html) playing the workspace's .strudel file, with what a musician needs to SEE it — a
// transport, one lane per voice synced to the playhead, mute and solo, the output's waveform — and
// a save from the agent hot-swapped in without stopping the music.
//
// Nothing of Strudel is changed. The pane reads the REPL's public objects (editor, repl, scheduler)
// and wraps two of their methods on this instance: scheduler.setPattern, to filter muted voices out
// of what is played, and editor.highlight, to colour the lit-up code by voice.
import { parseVoices, voiceAt } from './voices.mjs'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const dark = matchMedia('(prefers-color-scheme: dark)')
const LIGHT = ['#3b5bdb', '#f76707', '#0ca678', '#d6336c', '#7048e8', '#e8a100', '#1098ad', '#e03131', '#5c940d', '#ae3ec9', '#868e96', '#c2410c']
const DARK = ['#6f8cff', '#ff922b', '#38d9a9', '#f06595', '#9775fa', '#fcc419', '#3bc9db', '#ff6b6b', '#94d82d', '#da77f2', '#adb5bd', '#fd7e14']
const SPANS = [1, 2, 4, 8, 16, 32]
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

const S = {
  file: params.get('file') || '',
  fileText: null,
  el: null, ed: null, sched: null, origSetPattern: null,
  ready: false, started: false, everStarted: false,
  voices: [], voicesCode: null, // the voices of the code that was last evaluated: hap locations point into it
  muted: new Set(), soloed: new Set(),
  raw: null, cache: new Map(), range: [], sounds: [],
  span: 4, led: [], lastNow: null, lastFrame: 0,
  error: null, dirty: false, applying: false,
  analyser: null, tap: null, scopeBuf: null, freqBuf: null,
  needsDraw: true, rowH: 30, headH: 20,
  playsIn: [], scanned: 0,
}
window.__strudelPane = S // for tests and the curious: the pane's state, read-only by convention
try { const saved = Number(localStorage.getItem('strudel-pane-span')); if (SPANS.includes(saved)) S.span = saved } catch {}

const palette = () => (dark.matches ? DARK : LIGHT)
const colorOf = (v) => (v < 0 ? (dark.matches ? '#8e8d86' : '#8e8d86') : palette()[v % palette().length])
// Theme tokens, read once per frame rather than once per line drawn.
let tokens = null, tokensAt = -1
const css = (name) => {
  const frame = S.frameNo
  if (tokensAt !== frame) { tokens = getComputedStyle(document.documentElement); tokensAt = frame }
  return tokens.getPropertyValue(name).trim()
}
const keyOf = (v) => S.voices[v]?.key

// ---------------------------------------------------------------- voices and the mix

function setVoices(code) {
  if (code === S.voicesCode) return
  S.voicesCode = code
  const { voices } = parseVoices(code)
  const seen = new Map()
  for (const v of voices) {
    const n = (seen.get(v.name) || 0) + 1
    seen.set(v.name, n)
    v.key = n > 1 ? `${v.name}#${n}` : v.name
  }
  S.voices = voices
  // A mute or solo follows its voice by name across saves; one whose voice is gone is dropped.
  const keys = new Set(voices.map((v) => v.key))
  for (const set of [S.muted, S.soloed]) for (const k of [...set]) if (!keys.has(k)) set.delete(k)
  renderMixer()
}

function voiceOfHap(hap) {
  const locs = hap.context?.locations
  if (!locs || !locs.length || !S.voices.length) return S.voices.length === 1 ? 0 : -1
  for (const loc of locs) {
    const v = voiceAt(S.voices, loc.start)
    if (v >= 0) return v
  }
  return -1
}

function audible(v) {
  if (S.soloed.size) return v >= 0 && S.soloed.has(keyOf(v))
  return v < 0 || !S.muted.has(keyOf(v))
}

/** What the scheduler plays: the evaluated pattern, minus muted voices. Read at query time, so a
 *  toggle is heard on the next scheduler tick without re-evaluating anything. */
function mixed(pattern) {
  if (!pattern || typeof pattern.filterHaps !== 'function') return pattern
  return pattern.filterHaps((hap) => (S.muted.size || S.soloed.size ? audible(voiceOfHap(hap)) : true))
}

function toggle(set, v) {
  const k = keyOf(v)
  if (k == null) return
  set.has(k) ? set.delete(k) : set.add(k)
  renderMixer()
  S.needsDraw = true
}

// ---------------------------------------------------------------- mixer column

function renderMixer() {
  const mixer = $('mixer')
  const n = S.voices.length
  $('vcount').textContent = n ? `${n} voice${n === 1 ? '' : 's'}` : 'Voices'
  $('clearmix').hidden = !(S.muted.size || S.soloed.size)
  $('clearmix').textContent = S.soloed.size ? 'Clear solo' : 'Unmute all'
  const rows = S.voices.map((v, i) => {
    const row = mixer.children[i] || mixer.appendChild(voiceRow())
    row.style.setProperty('--c', colorOf(i))
    row.dataset.v = i
    const name = row.querySelector('.vname')
    name.textContent = v.name
    name.title = `${v.name}${v.detail ? ' — ' + v.detail : ''}\nline ${v.line} · click to find it in the code`
    const m = row.querySelector('.m'), s = row.querySelector('.s')
    m.classList.toggle('on', S.muted.has(v.key))
    s.classList.toggle('on', S.soloed.has(v.key))
    m.title = `Mute ${v.name}${i < 9 ? ` (${i + 1})` : ''}`
    s.title = `Solo ${v.name}${i < 9 ? ` (⇧${i + 1})` : ''}`
    row.classList.toggle('silent', !audible(i) || !!v.muted)
    row.classList.toggle('codemuted', !!v.muted)
    return row
  })
  while (mixer.children.length > rows.length) mixer.lastChild.remove()
  layoutLanes()
}

function voiceRow() {
  const row = document.createElement('div')
  row.className = 'voice'
  row.innerHTML = '<span class="swatch"><i class="led"></i></span><button class="vname"></button><button class="ms m">M</button><button class="ms s">S</button>'
  row.querySelector('.m').addEventListener('click', () => toggle(S.muted, +row.dataset.v))
  row.querySelector('.s').addEventListener('click', () => toggle(S.soloed, +row.dataset.v))
  row.querySelector('.vname').addEventListener('click', () => revealVoice(+row.dataset.v))
  return row
}

function revealVoice(v) {
  const voice = S.voices[v]
  const view = S.ed?.editor
  if (!voice || !view) return
  const from = Math.min(voice.from, view.state.doc.length)
  const to = Math.min(voice.to, view.state.doc.length)
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
  setTimeout(() => markLines(from, to, 'h-voice', colorOf(v)), 60)
}

function markLines(from, to, cls, color) {
  const view = S.ed?.editor
  if (!view) return
  const doc = view.state.doc
  const a = doc.lineAt(Math.min(from, doc.length)).number
  const b = doc.lineAt(Math.min(to, doc.length)).number
  for (let n = a; n <= Math.min(b, a + 40); n++) {
    let dom
    try { dom = view.domAtPos(doc.line(n).from).node } catch { continue }
    const line = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest('.cm-line')
    if (!line) continue
    line.classList.remove(cls)
    void line.offsetWidth
    if (color) line.style.setProperty('--vc', color)
    line.classList.add(cls)
    setTimeout(() => line.classList.remove(cls), 2400)
  }
}

// ---------------------------------------------------------------- lanes (the roll)

const roll = $('roll')
const rctx = roll.getContext('2d')

function layoutLanes() {
  const wide = matchMedia('(min-width: 1100px)').matches
  const n = Math.max(S.voices.length, 1)
  const body = $('lanesbody')
  S.headH = 20
  if (wide) {
    const avail = body.clientHeight || 600
    S.rowH = Math.max(30, Math.min(88, Math.floor((avail - S.headH - 4) / n)))
    $('lanes').style.maxHeight = ''
  } else {
    S.rowH = n > 8 ? 28 : n <= 3 ? 44 : 32
    $('lanes').style.maxHeight = ''
    body.style.height = Math.min(S.headH + n * S.rowH + 2, Math.round(innerHeight * 0.46)) + 'px'
  }
  if (wide) body.style.height = ''
  body.style.setProperty('--row', S.rowH + 'px')
  body.style.setProperty('--head', S.headH + 'px')
  const wrap = $('rollwrap')
  wrap.style.height = S.headH + n * S.rowH + 'px'
  sizeCanvas(roll, wrap.clientWidth, S.headH + n * S.rowH)
  S.needsDraw = true
}

function sizeCanvas(canvas, w, h) {
  const r = devicePixelRatio || 1
  const W = Math.max(1, Math.round(w * r)), H = Math.max(1, Math.round(h * r))
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
}

const SCAN = 64 // cycles scanned ahead, so an empty lane can say when its voice comes in

function invalidate() {
  S.cache.clear()
  S.range = []
  S.sounds = []
  S.playsIn = []
  S.scanned = 0
  S.needsDraw = true
}

/** A little of the look-ahead scan each frame: which cycles each voice plays in. */
function scanAhead() {
  if (!S.raw || S.scanned >= SCAN) return
  const until = Math.min(SCAN, S.scanned + 2)
  for (; S.scanned < until; S.scanned++) {
    for (const h of cycleHaps(S.scanned)) {
      if (h.v < 0) continue
      const set = S.playsIn[h.v] || (S.playsIn[h.v] = new Set())
      set.add(S.scanned)
    }
  }
  if (S.scanned >= SCAN) S.needsDraw = true
}

function entersAt(v, from) {
  const set = S.playsIn?.[v]
  if (set) {
    let best = Infinity
    for (const c of set) if (c >= from && c < best) best = c
    if (best !== Infinity) return best
  }
  return S.scanned >= SCAN ? (set && set.size ? null : -1) : undefined
}

function toMidi(value) {
  if (value == null) return null
  if (typeof value.note === 'number') return value.note
  if (typeof value.note === 'string') {
    try { const m = window.noteToMidi(value.note); if (Number.isFinite(m)) return m } catch {}
  }
  if (typeof value.freq === 'number' && value.freq > 0) return 69 + 12 * Math.log2(value.freq / 440)
  return null
}

function cycleHaps(c) {
  let list = S.cache.get(c)
  if (list) return list
  list = []
  if (S.raw) {
    try {
      const haps = S.raw.queryArc(c, c + 1, { _cps: S.sched?.cps ?? 0.5 })
      for (const h of haps) {
        if (!h.whole || !h.hasOnset()) continue
        const value = typeof h.value === 'object' && h.value !== null ? h.value : { value: h.value }
        const v = voiceOfHap(h)
        const midi = toMidi(value)
        const sound = value.s != null ? String(value.s) + (value.n != null && midi == null ? ':' + value.n : '') : (midi == null ? String(value.value ?? '·') : '')
        const item = { begin: h.whole.begin.valueOf(), end: h.whole.end.valueOf(), v, midi, sound, gain: typeof value.gain === 'number' ? value.gain : 1, value }
        if (v >= 0) {
          if (midi != null) {
            const r = S.range[v] || (S.range[v] = { lo: midi, hi: midi })
            r.lo = Math.min(r.lo, midi); r.hi = Math.max(r.hi, midi)
          } else {
            const list2 = S.sounds[v] || (S.sounds[v] = [])
            if (!list2.includes(sound)) list2.push(sound)
          }
        }
        list.push(item)
      }
    } catch (error) {
      // a pattern that throws when queried is reported by the REPL itself; the lanes stay empty
    }
  }
  S.cache.set(c, list)
  if (S.cache.size > 120) S.cache.delete(S.cache.keys().next().value)
  return list
}

function windowAt(now) {
  const span = S.span
  if (span <= 4) {
    const t0 = now - span * 0.18
    return [t0, t0 + span]
  }
  const t0 = Math.floor(Math.max(0, now) / span) * span
  return [t0, t0 + span]
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

function drawRoll(now) {
  const r = devicePixelRatio || 1
  const W = roll.width / r, H = roll.height / r
  const ctx = rctx
  ctx.setTransform(r, 0, 0, r, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const n = S.voices.length
  if (!n) return
  const [t0, t1] = windowAt(now)
  const span = t1 - t0
  const px = W / span
  const X = (t) => (t - t0) * px
  const head = S.headH, row = S.rowH

  // lanes
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) { ctx.fillStyle = css('--h-lane-alt'); ctx.fillRect(0, head + i * row, W, row) }
  }
  // grid: beats, bars, bar numbers
  ctx.font = '500 10.5px -apple-system, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const barEvery = px >= 34 ? 1 : px >= 16 ? 2 : px >= 8 ? 4 : 8
  for (let c = Math.floor(t0); c <= Math.ceil(t1); c++) {
    if (px / 4 >= 9) {
      ctx.fillStyle = css('--h-beat')
      for (let b = 1; b < 4; b++) ctx.fillRect(Math.round(X(c + b / 4)), head, 1, n * row)
    }
    const x = Math.round(X(c))
    const major = c % 4 === 0
    ctx.fillStyle = major ? css('--h-guide') : css('--h-bar')
    if (c % barEvery === 0 || px >= 34) ctx.fillRect(x, head - (major ? 6 : 3), 1, n * row + (major ? 6 : 3))
    if (c >= 0 && c % barEvery === 0) {
      ctx.fillStyle = major ? css('--h-ink2') : css('--h-faint')
      ctx.fillText(String(c + 1), x + 4, head / 2)
    }
  }

  // notes
  const active = []
  const drawn = new Set()
  for (let c = Math.max(0, Math.floor(t0)); c < Math.ceil(t1); c++) {
    for (const h of cycleHaps(c)) {
      if (h.end < t0 || h.begin > t1) continue
      const v = h.v
      if (v < 0 || v >= n) continue // a sound the source ranges cannot place is heard, not drawn
      const top = head + v * row
      const color = colorOf(h.v)
      const silent = !audible(h.v) || S.voices[v]?.muted
      let x = X(h.begin), w = Math.max(2, (h.end - h.begin) * px - (px > 60 ? 1.5 : 0.5))
      let y, hh
      const pad = Math.max(4, row * 0.14)
      const inner = row - pad * 2
      if (h.midi != null && S.range[v]) {
        const { lo, hi } = S.range[v]
        const steps = Math.max(hi - lo, 1)
        hh = Math.max(4, Math.min(row > 44 ? 10 : 6, inner / (steps + 1) * 2.4))
        y = top + pad + (hi === lo ? (inner - hh) / 2 : (hi - h.midi) / steps * (inner - hh))
      } else {
        const names = S.sounds[v] || [h.sound]
        const k = Math.min(names.length, 4)
        const idx = Math.max(0, names.indexOf(h.sound)) % k
        const lane = inner / k
        hh = Math.max(3, Math.min(lane - 2, Math.min(22, Math.max(12, lane * 0.4))) * (0.55 + 0.45 * Math.min(1, h.gain)))
        y = top + pad + idx * lane + (lane - hh) / 2
      }
      drawn.add(v)
      const isActive = S.started && h.begin <= now && now < h.end
      const past = h.end <= now
      const alpha = silent ? 0.12 : isActive ? 1 : past ? 0.32 : 0.72
      ctx.fillStyle = withAlpha(color, alpha)
      roundRect(ctx, x, y, w, hh, Math.min(3, hh / 2))
      ctx.fill()
      if (isActive && !silent) active.push([x, y, w, hh, color])
    }
  }
  // an empty lane says when its voice comes in, or that it is silent
  ctx.font = '11px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'right'
  for (let v = 0; v < n; v++) {
    if (drawn.has(v)) continue
    const at = entersAt(v, Math.floor(t1))
    const label = S.voices[v]?.muted ? 'muted in the code' : at === -1 ? 'silent' : at != null ? `comes in at bar ${at + 1} →` : ''
    if (!label) continue
    ctx.fillStyle = css('--h-faint')
    ctx.fillText(label, W - 10, head + v * row + row / 2)
  }
  ctx.textAlign = 'left'
  for (const [x, y, w, hh, color] of active) {
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.strokeStyle = withAlpha(color, 0.9)
    ctx.lineWidth = 1.5
    roundRect(ctx, x - 1, y - 1, w + 2, hh + 2, 3.5)
    ctx.stroke()
    ctx.restore()
  }

  // playhead
  const ph = X(now)
  if (ph >= 0 && ph <= W) {
    ctx.fillStyle = S.started ? css('--h-accent') : css('--h-guide')
    ctx.fillRect(Math.round(ph) - 1, head - 6, 2, n * row + 6)
    ctx.beginPath()
    ctx.moveTo(ph - 5, head - 8); ctx.lineTo(ph + 5, head - 8); ctx.lineTo(ph, head - 2); ctx.closePath()
    ctx.fill()
  }
}

function hapAt(px, py) {
  const r = roll.getBoundingClientRect()
  const x = px - r.left, y = py - r.top
  const v = Math.floor((y - S.headH) / S.rowH)
  if (v < 0 || v >= S.voices.length) return null
  const [t0, t1] = windowAt(S.lastNow ?? 0)
  const t = t0 + (x / r.width) * (t1 - t0)
  const slack = (t1 - t0) * 4 / r.width
  let best = null
  for (const h of cycleHaps(Math.floor(t))) {
    if (h.v !== v || t < h.begin - slack || t > h.end + slack) continue
    if (!best || Math.abs(h.begin - t) < Math.abs(best.begin - t)) best = h
  }
  return best
}

function describeHap(h) {
  const val = h.value || {}
  const bits = []
  if (h.midi != null) {
    const m = Math.round(h.midi)
    bits.push(`<b>${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}</b>`)
  }
  if (val.s != null) bits.push(`<code>${String(val.s).replace(/</g, '&lt;')}${val.n != null && h.midi == null ? ':' + val.n : ''}</code>`)
  const bar = Math.floor(h.begin), beat = (h.begin - bar) * 4
  bits.push(`bar ${bar + 1} · beat ${(beat + 1).toFixed(beat % 1 ? 2 : 0)}`)
  if (typeof val.gain === 'number') bits.push(`gain ${+val.gain.toFixed(2)}`)
  return `${S.voices[h.v]?.name ? `<b>${S.voices[h.v].name.replace(/</g, '&lt;')}</b> · ` : ''}${bits.join(' · ')}`
}

roll.addEventListener('mousemove', (e) => {
  const h = hapAt(e.clientX, e.clientY)
  const tip = $('tip')
  if (!h) { tip.hidden = true; return }
  tip.innerHTML = describeHap(h)
  tip.hidden = false
  const wrap = $('rollwrap').getBoundingClientRect()
  const x = Math.min(e.clientX - wrap.left + 12, wrap.width - tip.offsetWidth - 6)
  tip.style.left = Math.max(4, x) + 'px'
  tip.style.top = e.clientY - wrap.top + 14 + 'px'
})
roll.addEventListener('mouseleave', () => { $('tip').hidden = true })
roll.addEventListener('click', (e) => {
  const v = Math.floor((e.clientY - roll.getBoundingClientRect().top - S.headH) / S.rowH)
  if (v >= 0 && v < S.voices.length) revealVoice(v)
})

// ---------------------------------------------------------------- scope

const scope = $('scope')
const sctx = scope.getContext('2d')

function ensureTap() {
  if (!S.started || typeof window.getSuperdoughAudioController !== 'function') return
  try {
    const node = window.getSuperdoughAudioController().output?.destinationGain
    if (!node || node === S.tap) return
    const ac = window.getAudioContext()
    if (!S.analyser || S.analyser.context !== ac) {
      S.analyser = ac.createAnalyser()
      S.analyser.fftSize = 2048
      S.analyser.smoothingTimeConstant = 0.72
      S.scopeBuf = new Float32Array(S.analyser.fftSize)
      S.freqBuf = new Uint8Array(S.analyser.frequencyBinCount)
    }
    node.connect(S.analyser)
    S.tap = node
  } catch {}
}

function drawScope() {
  const box = scope.parentElement
  if (box.offsetParent === null) return
  sizeCanvas(scope, box.clientWidth, box.clientHeight)
  const r = devicePixelRatio || 1
  const W = scope.width / r, H = scope.height / r
  const ctx = sctx
  ctx.setTransform(r, 0, 0, r, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const accent = css('--h-accent')
  if (!S.analyser || !S.started) {
    ctx.fillStyle = css('--h-guide')
    ctx.fillRect(6, H / 2, W - 12, 1)
    return
  }
  // spectrum, log-spaced bars behind
  S.analyser.getByteFrequencyData(S.freqBuf)
  const bands = Math.floor(W / 5)
  const bins = S.freqBuf.length
  const sr = S.analyser.context.sampleRate
  for (let b = 0; b < bands; b++) {
    const f0 = 30 * Math.pow(16000 / 30, b / bands), f1 = 30 * Math.pow(16000 / 30, (b + 1) / bands)
    const i0 = Math.floor(f0 / (sr / 2) * bins), i1 = Math.max(i0 + 1, Math.floor(f1 / (sr / 2) * bins))
    let m = 0
    for (let i = i0; i < i1 && i < bins; i++) m = Math.max(m, S.freqBuf[i])
    const h = (m / 255) * (H - 4)
    ctx.fillStyle = withAlpha(accent.startsWith('#') ? accent : '#2f5bea', 0.14)
    ctx.fillRect(b * 5 + 1, H - h, 4, h)
  }
  // waveform, triggered on a rising zero crossing so it stands still
  S.analyser.getFloatTimeDomainData(S.scopeBuf)
  const buf = S.scopeBuf
  let start = 0
  for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break }
  const len = Math.min(buf.length - start, 900)
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(buf[start + i]))
  // auto-gain on a slow envelope: loud hits fill the box, the quiet tail between them still shows
  S.env = Math.max(peak, (S.env || 0.05) * 0.985, 0.01)
  const gain = 0.42 / S.env
  ctx.beginPath()
  for (let i = 0; i < len; i++) {
    const x = 4 + (i / (len - 1)) * (W - 8)
    const y = H / 2 - buf[start + i] * gain * H
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  }
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.4
  ctx.stroke()
}

// ---------------------------------------------------------------- transport

function nowCycle() {
  if (!S.sched || !S.started) return 0
  try { return Math.max(0, S.sched.now()) } catch { return 0 }
}

function renderTransport(now) {
  const cps = S.sched?.cps
  $('bpm').textContent = cps ? String(Math.round(cps * 240 * 10) / 10) : '–'
  $('bpm').parentElement.title = cps ? `Tempo, at four beats a cycle · ${+(cps * 60).toFixed(2)} cycles a minute` : 'Tempo'
  $('barno').textContent = String(Math.floor(now) + 1)
  const beat = S.started ? Math.floor((now % 1) * 4) : -1
  ;[...$('pips').children].forEach((pip, i) => pip.classList.toggle('on', i === beat))
}

function status(text, kind) {
  $('statustext').textContent = text
  $('status').className = kind || ''
}

function refreshStatus() {
  const play = $('play')
  play.classList.toggle('playing', S.started)
  play.title = S.started ? 'Stop (Space)' : 'Play (Space)'
  play.setAttribute('aria-label', S.started ? 'Stop' : 'Play')
  play.disabled = !S.ed
  $('gate').hidden = S.everStarted || !S.ready || !S.fileText
  if (!S.ready) return status('Loading Strudel…')
  if (S.error && !S.started) return status('Not playable yet — see the error above', 'err')
  if (S.error) return status('Playing the last version that worked', 'warn')
  const offline = window.__strudelOffline ? ' · offline: sample banks unavailable, synths play' : ''
  if (S.started) return status('Playing · a save swaps in without stopping' + offline, 'playing')
  status((S.everStarted ? 'Stopped' : 'Ready') + ' · press Play or Space' + offline, window.__strudelOffline ? 'warn' : '')
}

async function play() {
  const ed = S.ed
  if (!ed) return
  try { await window.getAudioContext?.().resume() } catch {}
  if (!S.audioInit && typeof window.initAudio === 'function') {
    S.audioInit = true
    try { await Promise.race([window.initAudio(), new Promise((r) => setTimeout(r, 1500))]) } catch {}
  }
  await ed.evaluate()
}
function stop() { S.ed?.stop() }
function togglePlay() { S.started ? stop() : play() }

// ---------------------------------------------------------------- errors and edits

function showError(err) {
  S.error = err || null
  const box = $('err')
  if (!err) { box.hidden = true; refreshStatus(); return }
  const message = String(err.message || err)
  const m = /\((\d+):(\d+)\)/.exec(message) || (err.loc ? [null, err.loc.line, err.loc.column] : null)
  $('errtitle').textContent = m ? `Line ${m[1]}:` : 'The track does not run:'
  $('errmsg').textContent = message.replace(/\s*\(\d+:\d+\)\s*$/, '')
  $('errsub').textContent = S.started
    ? 'Still playing the last version that worked. The next save tries again.'
    : 'Nothing new plays until it runs. The next save tries again.'
  const go = $('errgo')
  go.hidden = !m
  go.onclick = () => {
    const view = S.ed?.editor
    if (!view || !m) return
    const line = view.state.doc.line(Math.min(Number(m[1]), view.state.doc.lines))
    view.dispatch({ selection: { anchor: Math.min(line.from + Number(m[2] || 0), line.to) }, scrollIntoView: true })
    setTimeout(() => markLines(line.from, line.to, 'h-voice', css('--h-err')), 60)
  }
  box.hidden = false
  refreshStatus()
}

function checkDirty() {
  const dirty = !!S.ed && S.fileText != null && S.ed.code !== S.fileText
  if (dirty !== S.dirty) { S.dirty = dirty; $('edited').hidden = !dirty }
}

let toastTimer = null
function toast(text, action) {
  $('toasttext').textContent = text
  const go = $('toastgo')
  go.hidden = !action
  if (action) { go.textContent = action.label; go.onclick = () => { action.run(); $('toast').classList.remove('on') } }
  $('toast').classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => $('toast').classList.remove('on'), action ? 5000 : 2600)
}

function flashSaved() {
  const el = $('saved')
  const t = new Date()
  el.textContent = `updated ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
  el.classList.add('on')
  setTimeout(() => el.classList.remove('on'), 2200)
}

// ---------------------------------------------------------------- the file

/** Replace the editor's text with the file's by the smallest edit, so scroll and cursor stay put. */
function replaceDoc(next) {
  const view = S.ed.editor
  const prev = view.state.doc.toString()
  if (prev === next) return null
  let a = 0
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++
  let b = 0
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  S.applying = true
  view.dispatch({ changes: { from: a, to: prev.length - b, insert: next.slice(a, next.length - b) } })
  S.applying = false
  return { from: a, to: next.length - b }
}

async function previewEval() {
  // Evaluate without starting: the tempo, the voices and the lanes are there before the first
  // click, and a pattern that does not run says so before anyone presses Play.
  const ed = S.ed
  try { await ed.prebaked } catch {}
  if (S.started) return
  try { await ed.repl.evaluate(ed.code, false) } catch {}
  S.ready = true
  refreshStatus()
}

function mount(text) {
  const el = document.createElement('strudel-editor')
  el.settings = {
    ...(el.settings || {}),
    theme: dark.matches ? 'strudelTheme' : 'githubLight',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: matchMedia('(min-width: 1100px)').matches ? 13.5 : 12.5,
    isLineNumbersDisplayed: true, isPatternHighlightingEnabled: true, isFlashEnabled: true,
    isActiveLineHighlighted: false, isLineWrappingEnabled: false, isAutoCompletionEnabled: false,
    isTooltipEnabled: false, isBracketClosingEnabled: true, keybindings: 'codemirror',
  }
  el.setAttribute('code', text)
  el.addEventListener('update', (e) => {
    const state = e.detail || {}
    const was = S.started
    S.started = !!state.started
    if (S.started) S.everStarted = true
    if (was !== S.started) S.needsDraw = true
    if (state.error !== S.error) showError(state.error)
    checkDirty()
    refreshStatus()
  })
  $('editor').append(el)
  S.el = el
  S.ed = el.editor
  S.sched = S.ed.repl.scheduler
  S.origSetPattern = S.sched.setPattern.bind(S.sched)
  S.sched.setPattern = (pattern, autostart) => {
    // The code being evaluated right now is what the hap locations point into.
    setVoices(S.ed.repl.state.code ?? S.ed.code)
    S.raw = pattern
    invalidate()
    return S.origSetPattern(mixed(pattern), autostart)
  }
  const highlight = S.ed.highlight.bind(S.ed)
  S.ed.highlight = (haps, time) => highlight(haps.map((hap) => {
    const v = voiceOfHap(hap)
    if (v < 0) return hap
    const c = colorOf(v)
    return hap.withValue((value) => ({ ...(typeof value === 'object' ? value : { value }), markcss: `outline: 1.5px solid ${c}; background: ${withAlpha(c, 0.14)}; border-radius: 3px` }))
  }), time)
  // Strudel's own draw canvas (for tracks that call .pianoroll() and friends) belongs behind the code.
  const tc = document.getElementById('test-canvas')
  if (tc) $('editor').prepend(tc)
  setVoices(text)
  $('play').disabled = false
  previewEval()
}

async function pickFile() {
  if (S.file) return S.file
  try {
    const files = await (await fetch('/_files', { cache: 'no-store' })).json()
    return files[0]?.path || 'track.strudel'
  } catch { return 'track.strudel' }
}

async function renderPicker() {
  try {
    const files = await (await fetch('/_files', { cache: 'no-store' })).json()
    const picker = $('picker')
    if (files.length < 2) { picker.hidden = true; $('name').hidden = false; return }
    picker.innerHTML = files.map((f) => `<option${f.path === S.file ? ' selected' : ''}>${f.path.replace(/</g, '&lt;')}</option>`).join('')
    if (!files.some((f) => f.path === S.file)) picker.insertAdjacentHTML('afterbegin', `<option selected>${S.file.replace(/</g, '&lt;')}</option>`)
    picker.hidden = false
    $('name').hidden = true
  } catch {}
}
$('picker').addEventListener('change', (e) => { S.file = e.target.value; S.fileText = null; load() })

async function load() {
  S.file = await pickFile()
  $('name').textContent = S.file
  $('editfile').textContent = S.file
  let text
  try {
    const res = await fetch('/' + S.file.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(), { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status === 404 ? 'missing' : 'HTTP ' + res.status)
    text = await res.text()
  } catch (error) {
    if (!S.ed) {
      $('empty').hidden = false
      $('emptytitle').textContent = 'No track yet'
      $('emptytext').innerHTML = `The agent writes <code>${S.file.replace(/</g, '&lt;')}</code> in this workspace. It shows up here the moment it is saved, ready to play.`
    }
    return
  }
  $('empty').hidden = true
  renderPicker()
  const lines = text.split('\n').length
  $('codemeta').textContent = `${S.file} · ${lines} line${lines === 1 ? '' : 's'}`
  if (!S.ed) { S.fileText = text; mount(text); refreshStatus(); return }
  if (text === S.fileText) return
  const hadEdits = S.dirty
  S.fileText = text
  const changed = replaceDoc(text)
  checkDirty()
  flashSaved()
  if (changed) {
    setTimeout(() => markLines(changed.from, Math.max(changed.from, changed.to), 'h-changed'), 40)
    const view = S.ed.editor
    const line = view.state.doc.lineAt(Math.min(changed.from, view.state.doc.length)).number
    const visible = (() => {
      try { const b = view.lineBlockAt(changed.from); const s = view.scrollDOM; return b.top >= s.scrollTop && b.top <= s.scrollTop + s.clientHeight } catch { return true }
    })()
    const note = hadEdits ? 'Saved by the agent — your edits here were replaced' : S.started ? 'Saved · swapped in without stopping' : 'Saved · ready to play'
    toast(`${note} · line ${line}`, visible ? null : { label: 'Show', run: () => { view.dispatch({ selection: { anchor: changed.from }, scrollIntoView: true }); setTimeout(() => markLines(changed.from, changed.to, 'h-changed'), 60) } })
  }
  if (S.started) await S.ed.evaluate()
  else previewEval()
}

// ---------------------------------------------------------------- frame loop, input, wiring

function frame(ts) {
  S.frameNo = (S.frameNo || 0) + 1
  const now = nowCycle()
  scanAhead()
  if (S.started) {
    ensureTap()
    // activity lights: onsets between the last frame and this one, per audible voice
    if (S.lastNow != null && now >= S.lastNow && now - S.lastNow < 0.5) {
      for (let c = Math.floor(S.lastNow); c <= Math.floor(now); c++) {
        for (const h of cycleHaps(c)) {
          if (h.begin > S.lastNow && h.begin <= now && h.v >= 0 && audible(h.v)) S.led[h.v] = Math.min(1, 0.45 + 0.6 * Math.min(1, h.gain))
        }
      }
    }
  }
  const dt = Math.min(0.1, (ts - (S.lastFrame || ts)) / 1000)
  S.lastFrame = ts
  const leds = $('mixer').children
  for (let i = 0; i < leds.length; i++) {
    const level = (S.led[i] || 0) * Math.pow(0.004, dt)
    S.led[i] = level < 0.01 ? 0 : level
    const led = leds[i].firstChild.firstChild
    const o = (S.led[i] || 0).toFixed(2)
    if (led.style.opacity !== o) led.style.opacity = o
  }
  if (S.started || S.needsDraw || now !== S.lastNow) {
    drawRoll(now)
    renderTransport(now)
    S.needsDraw = false
  }
  drawScope()
  S.lastNow = now
  requestAnimationFrame(frame)
}

function setSpan(span) {
  S.span = span
  for (const b of $('zoom').children) b.classList.toggle('on', Number(b.dataset.span) === span)
  try { localStorage.setItem('strudel-pane-span', String(span)) } catch {}
  S.needsDraw = true
}
$('zoom').addEventListener('click', (e) => { const s = Number(e.target.dataset?.span); if (s) setSpan(s) })
$('play').addEventListener('click', togglePlay)
$('gate').addEventListener('click', play)
$('clearmix').addEventListener('click', () => { S.muted.clear(); S.soloed.clear(); renderMixer(); S.needsDraw = true })
$('revert').addEventListener('click', () => {
  if (!S.ed || S.fileText == null) return
  replaceDoc(S.fileText)
  checkDirty()
  if (S.started) S.ed.evaluate()
})

document.addEventListener('keydown', (e) => {
  const inEditor = e.target instanceof Element && !!e.target.closest('.cm-editor, input, select, textarea')
  if (inEditor || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return }
  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit) {
    const v = Number(digit[1]) - 1
    if (v < S.voices.length) { e.preventDefault(); toggle(e.shiftKey ? S.soloed : S.muted, v) }
    return
  }
  if (e.code === 'Digit0' || e.key === 'Escape') { S.muted.clear(); S.soloed.clear(); renderMixer(); return }
  if (e.key === '-' || e.key === '_') { const i = SPANS.indexOf(S.span); if (i < SPANS.length - 1) setSpan(SPANS[i + 1]) }
  if (e.key === '=' || e.key === '+') { const i = SPANS.indexOf(S.span); if (i > 0) setSpan(SPANS[i - 1]) }
})

dark.addEventListener('change', () => {
  S.ed?.setTheme(dark.matches ? 'strudelTheme' : 'githubLight')
  renderMixer()
})
new ResizeObserver(() => layoutLanes()).observe(document.body)
window.addEventListener('strudel-offline', refreshStatus)
new EventSource('/events').addEventListener('change', () => load())

setSpan(S.span)
refreshStatus()
load()
requestAnimationFrame(frame)
