// Jev Conductor pane. The server sends each bar as Jev writes it, with the full probability spread of
// every answer. This file keeps its own timeline, scrolls a piano roll under a fixed playhead at
// 60 fps, draws the notes Jev weighed but did not pick as a faint cloud, and plays the bar with Web
// Audio once the person turns the sound on. Everything on the stage runs with the sound off too:
// until there is real audio to analyse, the spectrum is drawn from the notes themselves.
'use strict'

const $ = (id) => document.getElementById(id)
const canvas = $('roll'), wrap = $('wrap'), g = canvas.getContext('2d')
const TAU = Math.PI * 2
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
const PALETTE = ['#60a5fa', '#34d399', '#fb923c', '#c084fc', '#fbbf24', '#fb7185', '#22d3ee', '#a3e635']

let F = null, W = 0, H = 0, dpr = 1, lastNow = 0, chipsBottom = 30
let lastBarSeen = 0, lastCut = null, paused = false, inst = 'keys'
let pxPerMs = 0.1, energyNow = 1, beatFlash = 0, lastMoodsKey = '', lastText = '', lastLogKey = ''
const timeline = [] // { data, t0, dur, end, fired:Set, voices:[] }   times in performance.now() ms
const active = [] // notes sounding now, for the key lights and the drawn spectrum
const particles = []
let audio = null // { ctx, master, analyser, send, freq:Uint8Array, wave:Uint8Array, on }
const spec = new Float32Array(72)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmtMoney = (v) => (v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2))
const midi = (n) => { const m = /^([A-G](?:#|b)?)(-?\d)$/.exec(String(n)); return m && PC[m[1]] != null ? PC[m[1]] + (Number(m[2]) + 1) * 12 : null }
const hz = (m) => 440 * 2 ** ((m - 69) / 12)
function moodColor(name) {
  if (/brood|sad|blue|dark|lonely|still|quiet/i.test(name)) return '#60a5fa'
  if (/hope|warm|bright|sweet|joy|happy|sunny/i.test(name)) return '#34d399'
  if (/driv|urgent|fierce|wild|storm|angry|chase/i.test(name)) return '#fb923c'
  const i = F ? Math.max(0, F.piece.moods.indexOf(name)) : 0
  return PALETTE[(i + 3) % PALETTE.length]
}
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }

// ---------------------------------------------------------------- layout
function fit() {
  const r = wrap.getBoundingClientRect()
  W = Math.max(60, r.width); H = Math.max(60, r.height); dpr = Math.min(2.5, window.devicePixelRatio || 1)
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
  const chips = document.querySelector('.chips').getBoundingClientRect()
  chipsBottom = Math.max(30, chips.bottom - r.top)
}
new ResizeObserver(fit).observe(wrap)
new ResizeObserver(fit).observe(document.querySelector('.chips')) // its text changes when the sound comes on

// ---------------------------------------------------------------- the bar as timed events (shared by sound and picture)
function eventsOf(e) {
  const b = e.data, p = e.piece, n = b.lead.length, step = e.dur / n, beat = e.dur / p.beatsPerBar, out = []
  b.lead.forEach((note, k) => {
    if (note === 'rest') return
    const m = midi(note); if (m == null) return
    out.push({ kind: 'lead', slot: k, m, t: e.t0 + k * step + (k % 2 ? p.swing * step * 0.5 : 0), dur: step * (inst === 'pad' ? 1.15 : 0.62 + 0.12 * b.energy), vel: (k % 2 ? 0.72 : 1) * (0.5 + 0.25 * b.energy) })
  })
  const bm = midi(b.bass)
  if (bm != null) for (let i = 0; i < p.beatsPerBar; i++) if (b.energy > 1.4 || i === 0 || i === Math.floor(p.beatsPerBar / 2)) out.push({ kind: 'bass', m: bm, t: e.t0 + i * beat, dur: beat * (b.energy > 1.4 ? 0.85 : 1.7), vel: 0.8 })
  for (const tn of b.tones ?? []) { const m = midi(tn + '3'); if (m != null) out.push({ kind: 'chord', m, t: e.t0, dur: e.dur, vel: 0.5 }) }
  if (b.energy > 1.15) for (let i = 0; i < p.beatsPerBar; i++) if (b.energy > 1.55 || i % 2 === 0) out.push({ kind: 'kick', m: 36, t: e.t0 + i * beat, dur: 140, vel: 0.5 + 0.2 * b.energy })
  return out
}

// ---------------------------------------------------------------- sound (off until the person clicks)
function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return false
  if (!audio) {
    const ctx = new AC(), master = ctx.createGain(), analyser = ctx.createAnalyser(), send = ctx.createGain()
    const delay = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain()
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.78
    delay.delayTime.value = 0.29; fb.gain.value = 0.3; wet.gain.value = 0.24
    send.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master)
    master.connect(analyser); analyser.connect(ctx.destination)
    audio = { ctx, master, analyser, send, freq: new Uint8Array(analyser.frequencyBinCount), wave: new Uint8Array(analyser.fftSize), on: false }
  }
  audio.ctx.resume?.()
  audio.on = true
  audio.master.gain.value = F ? F.piece.volume * 0.9 : 0.5
  for (const e of timeline) scheduleAudio(e)
  return true
}
function stopAudio() { if (!audio) return; audio.on = false; for (const e of timeline) silence(e, 0); audio.ctx.suspend?.() }
const when = (t) => audio.ctx.currentTime + (t - performance.now()) / 1000

function voice(ev) {
  const c = audio.ctx, t = when(ev.t), d = ev.dur / 1000, f = hz(ev.m)
  if (t < c.currentTime - 0.02) return null
  const out = c.createGain(); out.gain.value = 0
  const oscs = []
  const osc = (type, freq, gain, detune = 0) => { const o = c.createOscillator(), gn = c.createGain(); o.type = type; o.frequency.value = freq; o.detune.value = detune; gn.gain.value = gain; o.connect(gn); oscs.push(o); return gn }
  let end = t + d + 0.4
  if (ev.kind === 'kick') {
    const o = c.createOscillator(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13); o.connect(out); oscs.push(o)
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.55 * ev.vel, t + 0.005); out.gain.exponentialRampToValueAtTime(0.0008, t + 0.2); end = t + 0.25
  } else if (ev.kind === 'bass') {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520
    osc('sine', f, 1).connect(lp); osc('triangle', f, 0.45).connect(lp); lp.connect(out)
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.34 * ev.vel, t + 0.012); out.gain.exponentialRampToValueAtTime(0.0008, t + d)
    end = t + d + 0.05
  } else if (ev.kind === 'chord') {
    osc('sine', f, 1).connect(out); osc('triangle', f, 0.35, 5).connect(out)
    out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(0.045 * ev.vel, t + 0.3); out.gain.setValueAtTime(0.045 * ev.vel, t + Math.max(0.31, d - 0.3)); out.gain.linearRampToValueAtTime(0.0001, t + d + 0.25)
    end = t + d + 0.3
  } else if (inst === 'pluck') {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 7
    lp.frequency.setValueAtTime(4200, t); lp.frequency.exponentialRampToValueAtTime(520, t + 0.2)
    osc('sawtooth', f, 1).connect(lp); lp.connect(out)
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.2 * ev.vel, t + 0.004); out.gain.exponentialRampToValueAtTime(0.0008, t + Math.max(0.22, d))
  } else if (inst === 'pad') {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500
    osc('sawtooth', f, 0.5, -8).connect(lp); osc('sawtooth', f, 0.5, 8).connect(lp); lp.connect(out)
    out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(0.11 * ev.vel, t + 0.12); out.gain.setValueAtTime(0.11 * ev.vel, t + d); out.gain.linearRampToValueAtTime(0.0001, t + d + 0.35)
  } else {
    osc('triangle', f, 1).connect(out); osc('sine', f * 2, 0.28).connect(out)
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.24 * ev.vel, t + 0.006); out.gain.exponentialRampToValueAtTime(0.0008, t + d + 0.28)
  }
  out.connect(audio.master)
  if (ev.kind === 'lead') out.connect(audio.send)
  for (const o of oscs) { o.start(Math.max(c.currentTime, t)); o.stop(end) }
  return { t: ev.t, out, oscs }
}
function scheduleAudio(e) {
  if (!audio?.on || e.scheduled) return
  e.scheduled = true
  const from = performance.now() - 30
  for (const ev of eventsOf(e)) if (ev.t >= from && ev.t < e.end) { const v = voice(ev); if (v) e.voices.push(v) }
}
/** Stop what this bar would still play after time t (a person cut in with a new request). */
function silence(e, t) {
  if (!audio) return
  for (const v of e.voices) {
    try {
      if (v.t >= t) { for (const o of v.oscs) o.stop() } else if (t) { const at = Math.max(audio.ctx.currentTime, when(t)); v.out.gain.cancelScheduledValues(at); v.out.gain.setTargetAtTime(0, at, 0.04) }
    } catch { /* already stopped */ }
  }
  if (!t) { e.voices.length = 0; e.scheduled = false }
}

// ---------------------------------------------------------------- frames
function onFrame(f) {
  const first = !F
  F = f
  const now = performance.now()
  if (audio?.on) audio.master.gain.setTargetAtTime(f.piece.volume * 0.9, audio.ctx.currentTime, 0.1)
  let fresh = f.plan.filter((b) => b.bar > lastBarSeen)
  const wasReset = f.bar < lastBarSeen
  if (wasReset) { for (const e of timeline) silence(e, now); timeline.length = 0; fresh = f.plan.slice(-2) }
  if (first || fresh.length > 3) fresh = fresh.slice(-2)
  const cutIn = !first && lastCut !== null && f.cut !== lastCut && fresh.length > 0
  let startAt = now
  if (cutIn && timeline.length) {
    // drop what has not started, and end the playing bar on its next beat
    while (timeline.length && timeline[timeline.length - 1].t0 > now) { silence(timeline[timeline.length - 1], now); timeline.pop() }
    const cur = timeline[timeline.length - 1]
    if (cur && cur.end > now) {
      const beat = cur.dur / cur.piece.beatsPerBar
      cur.end = Math.min(cur.end, cur.t0 + Math.ceil((now - cur.t0 + 40) / beat) * beat)
      silence(cur, cur.end); startAt = cur.end
    }
  }
  for (const b of fresh) {
    const last = timeline[timeline.length - 1]
    const t0 = Math.max(startAt, last ? last.end : now)
    const e = { data: b, piece: f.piece, t0, dur: f.barMs, end: t0 + f.barMs, fired: new Set(), voices: [], scheduled: false }
    timeline.push(e); scheduleAudio(e)
  }
  while (timeline.length > 10) timeline.shift()
  if (f.plan.length) lastBarSeen = f.bar
  lastCut = f.cut
  paint(f)
}

function optRow(el, probs, chosen, colorOf) {
  const entries = Object.entries(probs ?? {})
  el.innerHTML = entries.map(([k, p]) => `<span class="opt${k === chosen ? ' top' : ''}" style="--p:${p.toFixed(3)};--c:${colorOf(k)}">${esc(k)}<small>${Math.round(p * 100)}%</small><i></i></span>`).join('')
}

function paint(f) {
  paused = !f.running
  $('title').textContent = f.title; $('title').title = f.description || ''
  $('s-bar').textContent = f.bar; $('s-notes').textContent = f.totals.notes.toLocaleString('en-US')
  const flow = $('s-flow'); flow.textContent = f.measure.pairs ? Math.round(f.measure.flow * 100) + '%' : '—'
  flow.className = f.measure.flow >= 0.9 ? 'good' : f.measure.flow >= 0.75 ? 'mid' : 'poor'
  const flick = $('s-flick'); flick.textContent = f.measure.pairs ? Math.round(f.measure.moodFlips * 100) + '%' : '—'
  flick.className = f.measure.moodFlips <= 0.3 ? 'good' : f.measure.moodFlips <= 0.5 ? 'mid' : 'poor'
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem ? `${problem} — still playing on the last good piece.` : ''
  if (document.activeElement !== $('tempo')) { $('tempo').value = f.piece.tempo; $('tempoVal').textContent = f.piece.tempo + ' bpm' }
  if (document.activeElement !== $('memory')) { $('memory').value = f.piece.memory; $('memoryVal').textContent = f.piece.memory === 1 ? '1 bar' : f.piece.memory + ' bars' }
  const moodsKey = f.piece.moods.join('|')
  if (moodsKey !== lastMoodsKey) {
    lastMoodsKey = moodsKey
    $('moods').innerHTML = f.piece.moods.map((m) => `<button class="mood" data-mood="${esc(m)}" style="--c:${moodColor(m)}">${esc(m)}</button>`).join('')
    for (const b of $('moods').children) b.onclick = () => post({ cmd: 'request', mood: b.dataset.mood })
  }
  for (const b of $('moods').children) b.classList.toggle('on', b.dataset.mood === f.request)
  $('noMood').classList.toggle('on', !f.request)
  const rq = $('request')
  rq.classList.toggle('hidden', !f.request)
  if (f.request) { rq.textContent = `the audience asked for ${f.request}`; rq.style.setProperty('--c', moodColor(f.request)) }
  const b = f.plan[f.plan.length - 1]
  if (b) {
    $('barPill').textContent = `bar ${b.bar} · ${b.pos} of ${f.piece.phrase}`
    optRow($('chordMind'), b.probs?.chord, b.chord, () => moodColor(b.mood))
    optRow($('moodMind'), b.probs?.mood, b.mood, (k) => moodColor(k))
  }
  if (f.stateText !== lastText) {
    lastText = f.stateText
    $('stateText').innerHTML = f.stateText.split('\n').map((line) => (/^The audience asked/.test(line) ? `<span class="hl">${esc(line)}</span>` : /^\s+bar \d+:|^You remember/.test(line) ? `<span class="mem">${esc(line)}</span>` : /^You do not remember/.test(line) ? `<span class="lost">${esc(line)}</span>` : esc(line))).join('\n')
  }
  const logKey = `${f.bar}:${f.plan.length}`
  if (logKey !== lastLogKey) {
    lastLogKey = logKey
    $('log').innerHTML = [...f.plan].reverse().slice(0, 14).map((x) => `<li style="--c:${moodColor(x.mood)}"><span class="n">${x.bar}</span><b>${esc(x.chord)}</b><span class="notes">${esc(x.mood)} · ${esc(x.bass)} · ${x.lead.map((n) => (n === 'rest' ? '·' : esc(n))).join(' ')}</span></li>`).join('')
  }
}

// ---------------------------------------------------------------- the stage
function rr(x, y, w, h, r) { g.beginPath(); if (g.roundRect && r > 0.5 && w > 1) g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else g.rect(x, y, w, h) }

function draw(now) {
  requestAnimationFrame(draw)
  if (!F || !W) return
  const dt = Math.min(50, now - (lastNow || now)); lastNow = now
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  const p = F.piece
  const cur = timeline.find((e) => now >= e.t0 && now < e.end) ?? null
  const mood = cur?.data.mood ?? F.plan[F.plan.length - 1]?.mood ?? ''
  const col = moodColor(mood)
  energyNow += ((cur ? cur.data.energy : 0.2) - energyNow) * Math.min(1, dt * 0.006)

  // geometry
  const gutter = 52, right = 52, top = chipsBottom + 10, chordH = 46 // start below the legend, however many rows it wraps to
  const specH = Math.max(80, Math.round(H * 0.24)), bassRows = [...p.bassScale].sort((a, b) => midi(b) - midi(a)), leadRows = [...p.scale].sort((a, b) => midi(b) - midi(a))
  const rollTop = top + chordH + 10, rollBottom = H - specH - 16
  const bassH = Math.max(40, Math.min(90, (rollBottom - rollTop) * 0.24)), leadBottom = rollBottom - bassH - 10
  const leadRowH = (leadBottom - rollTop) / leadRows.length, bassRowH = bassH / bassRows.length
  const x0 = gutter, x1 = W - right, headX = x0 + (x1 - x0) * 0.4
  pxPerMs += ((x1 - x0) / (3.2 * F.barMs) - pxPerMs) * Math.min(1, dt * 0.008)
  const X = (t) => headX + (t - now) * pxPerMs
  const leadY = (note) => rollTop + leadRows.indexOf(note) * leadRowH
  const bassY = (note) => leadBottom + 10 + bassRows.indexOf(note) * bassRowH

  // backdrop: a stage lit in the colour of the mood
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#070811'); bg.addColorStop(1, '#04050a')
  g.fillStyle = bg; g.fillRect(0, 0, W, H)
  const glow = g.createRadialGradient(headX, rollTop + (leadBottom - rollTop) / 2, 10, headX, rollTop + (leadBottom - rollTop) / 2, W * 0.55)
  glow.addColorStop(0, rgba(col, 0.1 + 0.05 * energyNow + beatFlash * 0.05)); glow.addColorStop(1, rgba(col, 0))
  g.fillStyle = glow; g.fillRect(0, 0, W, H)
  if (mood) {
    g.save(); g.font = `800 ${Math.round(Math.min(150, (leadBottom - rollTop) * 0.55))}px ui-monospace, Menlo, monospace`; g.textAlign = 'right'; g.textBaseline = 'middle'
    g.fillStyle = rgba(col, 0.085); g.fillText(mood.toUpperCase(), x1 - 6, rollTop + (leadBottom - rollTop) / 2); g.restore()
  }
  // rows
  leadRows.forEach((n, i) => { g.fillStyle = i % 2 ? 'rgba(255,255,255,.018)' : 'rgba(255,255,255,.035)'; g.fillRect(x0, rollTop + i * leadRowH, x1 - x0, leadRowH - 1) })
  bassRows.forEach((n, i) => { g.fillStyle = i % 2 ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.03)'; g.fillRect(x0, leadBottom + 10 + i * bassRowH, x1 - x0, bassRowH - 1) })

  g.save(); g.beginPath(); g.rect(x0, top - 2, x1 - x0, rollBottom - top + 4); g.clip()
  for (const e of timeline) {
    const bx0 = X(e.t0), bx1 = X(e.end)
    if (bx1 < x0 - 4 || bx0 > x1 + 4) continue
    const b = e.data, c = moodColor(b.mood), playing = e === cur, past = now >= e.end
    const n = b.lead.length, fullW = e.dur * pxPerMs, slotW = fullW / n, beatW = fullW / e.piece.beatsPerBar
    // beat and bar lines
    for (let i = 0; i <= e.piece.beatsPerBar; i++) { const x = bx0 + i * beatW; if (x > bx1 + 0.5) break; g.fillStyle = i === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.05)'; g.fillRect(x, rollTop, 1, rollBottom - rollTop) }
    // chord block, coloured by mood
    g.fillStyle = rgba(c, playing ? 0.34 : past ? 0.1 : 0.2); g.strokeStyle = rgba(c, playing ? 0.95 : 0.4); g.lineWidth = playing ? 1.6 : 1
    if (playing) { g.shadowColor = c; g.shadowBlur = 18 }
    rr(bx0 + 2, top, bx1 - bx0 - 4, chordH, 9); g.fill(); g.stroke(); g.shadowBlur = 0
    if (bx1 - bx0 > 70) {
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'
      g.fillStyle = past ? 'rgba(232,234,242,.5)' : '#fff'; g.font = '700 17px ui-monospace, Menlo, monospace'; g.fillText(b.chord, bx0 + 12, top + 21)
      g.fillStyle = rgba(c, past ? 0.55 : 0.95); g.font = '600 10.5px ui-monospace, Menlo, monospace'
      g.fillText(`${b.mood}${b.request ? ' · asked' : ''} · bar ${b.bar}`, bx0 + 12, top + 37)
      g.textAlign = 'right'; g.fillStyle = 'rgba(232,234,242,.55)'; g.fillText(`${Math.round(b.confidence * 100)}%`, bx1 - 12, top + 21)
    }
    // the lead: a faint cloud of what Jev weighed, and the note it picked
    for (let k = 0; k < n; k++) {
      const sx = bx0 + k * slotW + (k % 2 ? e.piece.swing * slotW * 0.5 : 0), w = slotW * (inst === 'pad' ? 0.97 : 0.84)
      if (sx + w < x0 || sx > x1) continue
      const probs = b.probs?.lead?.[k]
      if (probs && !past) for (const [note, pr] of Object.entries(probs)) {
        if (note === b.lead[k] || note === 'rest' || pr < 0.035) continue
        const y = leadY(note); if (y < rollTop) continue
        g.fillStyle = rgba(c, Math.min(0.42, pr * 1.2)); rr(sx, y + leadRowH * 0.24, w, leadRowH * 0.52, 4); g.fill()
      }
      const note = b.lead[k]
      const t0 = e.t0 + (k * e.dur) / n + (k % 2 ? e.piece.swing * (e.dur / n) * 0.5 : 0), sounding = now >= t0 && now < t0 + (e.dur / n) * 0.9 && now < e.end
      if (note === 'rest') { g.fillStyle = rgba(c, past ? 0.12 : 0.3); g.fillRect(sx + w * 0.3, rollTop + (leadBottom - rollTop) / 2 - 1, w * 0.4, 2); continue }
      const y = leadY(note); if (y < rollTop) continue
      const pr = probs?.[note]
      g.fillStyle = sounding ? '#ffffff' : rgba(c, past ? 0.38 : 0.95)
      if (sounding) { g.shadowColor = c; g.shadowBlur = 22 } else if (!past) { g.shadowColor = c; g.shadowBlur = 8 }
      rr(sx, y + leadRowH * 0.16, w, leadRowH * 0.68, 5); g.fill(); g.shadowBlur = 0
      if (pr != null && !past && w > 22 && leadRowH > 20) { g.fillStyle = sounding ? '#0a0b10' : 'rgba(10,11,16,.8)'; g.font = '700 9.5px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(Math.round(pr * 100), sx + w / 2, y + leadRowH * 0.5) }
    }
    // the bass
    for (const ev of e.events ?? (e.events = eventsOf(e))) {
      if (ev.kind !== 'bass') continue
      const sx = X(ev.t), w = Math.max(4, ev.dur * pxPerMs - 3), y = bassY(b.bass); if (sx > x1 || sx + w < x0 || ev.t >= e.end) continue
      const sounding = now >= ev.t && now < ev.t + ev.dur
      g.fillStyle = sounding ? '#fff' : rgba(c, past ? 0.3 : 0.75); if (sounding) { g.shadowColor = c; g.shadowBlur = 16 }
      rr(sx, y + bassRowH * 0.2, w, bassRowH * 0.6, 4); g.fill(); g.shadowBlur = 0
    }
    // fire what the playhead has just reached: key lights, sparks, and the drawn spectrum
    if (playing || (past && now - e.end < 200)) for (const ev of e.events) {
      const key = ev.kind + ev.t
      if (ev.t > now || ev.t >= e.end || e.fired.has(key)) continue
      e.fired.add(key)
      if (now - ev.t > 250) continue
      active.push({ m: ev.m, t: now, dur: ev.kind === 'chord' ? ev.dur : Math.max(260, ev.dur), kind: ev.kind, vel: ev.vel })
      if (ev.kind === 'kick') beatFlash = 1
      if (ev.kind === 'lead' || ev.kind === 'bass') {
        const y = ev.kind === 'lead' ? leadY(b.lead[ev.slot]) + leadRowH / 2 : bassY(b.bass) + bassRowH / 2
        for (let i = 0; i < (ev.kind === 'lead' ? 9 : 5); i++) particles.push({ x: headX, y, vx: -0.04 - Math.random() * 0.2, vy: (Math.random() - 0.5) * 0.22, life: 0, max: 380 + Math.random() * 500, size: 1.2 + Math.random() * 2.2, color: i % 3 ? c : '#ffffff' })
      }
    }
  }
  g.restore()
  if (cur) { const beat = cur.dur / cur.piece.beatsPerBar, ph = ((now - cur.t0) % beat) / beat; if (ph < 0.08) beatFlash = Math.max(beatFlash, 0.6) }
  beatFlash *= Math.exp(-dt * 0.008)

  // playhead
  g.save(); g.shadowColor = col; g.shadowBlur = 16 + beatFlash * 18
  g.fillStyle = rgba('#ffffff', 0.85); g.fillRect(headX - 1, top - 4, 2, rollBottom - top + 8)
  g.beginPath(); g.arc(headX, top - 4, 4 + beatFlash * 4, 0, TAU); g.fill(); g.restore()

  // note names, lit while they sound
  for (let i = active.length - 1; i >= 0; i--) if (now - active[i].t > active[i].dur + 500) active.splice(i, 1)
  const lit = (m) => active.reduce((a, s) => (s.m === m && s.kind !== 'chord' ? Math.max(a, 1 - (now - s.t) / (s.dur + 300)) : a), 0)
  g.textAlign = 'right'; g.textBaseline = 'middle'; g.font = '600 11px ui-monospace, Menlo, monospace'
  leadRows.forEach((n, i) => { const l = lit(midi(n)); g.fillStyle = l > 0 ? rgba('#ffffff', 0.5 + 0.5 * l) : 'rgba(138,144,166,.75)'; if (l > 0) { g.shadowColor = col; g.shadowBlur = 12 * l } g.fillText(n, gutter - 10, rollTop + i * leadRowH + leadRowH / 2); g.shadowBlur = 0 })
  bassRows.forEach((n, i) => { const l = lit(midi(n)); g.fillStyle = l > 0 ? rgba('#ffffff', 0.5 + 0.5 * l) : 'rgba(138,144,166,.6)'; g.fillText(n, gutter - 10, leadBottom + 10 + i * bassRowH + bassRowH / 2) })

  // energy meter
  const mx = W - right + 18, mw = 14, my = rollTop, mh = rollBottom - rollTop
  g.fillStyle = 'rgba(255,255,255,.05)'; rr(mx, my, mw, mh, 7); g.fill()
  const level = clamp(energyNow / 2 + beatFlash * 0.04 * energyNow, 0.02, 1)
  const eg = g.createLinearGradient(0, my + mh, 0, my); eg.addColorStop(0, rgba(col, 0.35)); eg.addColorStop(1, col)
  g.save(); g.shadowColor = col; g.shadowBlur = 14; g.fillStyle = eg; rr(mx, my + mh * (1 - level), mw, mh * level, 7); g.fill(); g.restore()
  g.fillStyle = 'rgba(138,144,166,.8)'; g.font = '600 9px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'
  g.fillText('ENERGY', mx + mw / 2, my - 8); g.fillStyle = '#fff'; g.font = '700 11px ui-monospace, Menlo, monospace'; g.fillText(energyNow.toFixed(1), mx + mw / 2, my + mh + 16)

  drawSpectrum(now, dt, x0, x1, H - specH - 4, specH - 6, col)

  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i]; q.life += dt
    if (q.life >= q.max) { particles.splice(i, 1); continue }
    q.x += q.vx * dt; q.y += q.vy * dt
    g.globalAlpha = 1 - q.life / q.max; g.fillStyle = q.color; g.beginPath(); g.arc(q.x, q.y, q.size, 0, TAU); g.fill()
  }
  g.globalAlpha = 1
  if (particles.length > 500) particles.splice(0, particles.length - 500)
}

/** Live from the analyser when there is sound; drawn from the sounding notes when there is not. */
function drawSpectrum(now, dt, x0, x1, y, h, col) {
  const n = spec.length
  let live = false
  if (audio?.on && audio.ctx.state === 'running') {
    audio.analyser.getByteFrequencyData(audio.freq)
    const nyq = audio.ctx.sampleRate / 2
    let sum = 0
    for (let i = 0; i < n; i++) {
      const f0 = 40 * 2 ** ((i / n) * 7.2), f1 = 40 * 2 ** (((i + 1) / n) * 7.2)
      const a = Math.floor((f0 / nyq) * audio.freq.length), b = Math.max(a + 1, Math.floor((f1 / nyq) * audio.freq.length))
      let peak = 0; for (let k = a; k < b && k < audio.freq.length; k++) peak = Math.max(peak, audio.freq[k])
      spec[i] += (peak / 255 - spec[i]) * 0.5; sum += peak
    }
    live = sum > 0
  }
  if (!live) {
    const target = new Float32Array(n)
    for (const s of active) {
      const age = now - s.t, env = s.kind === 'chord' ? 0.4 * Math.max(0, 1 - age / (s.dur + 300)) : Math.exp(-age / (s.kind === 'bass' ? 620 : 430)) * (s.kind === 'kick' ? 1 : 1.15) * Math.min(1, 0.45 + (s.vel ?? 1) * 0.6)
      if (env < 0.01) continue
      for (const [mult, gain] of [[1, 1], [2, 0.5], [3, 0.28], [4, 0.16]]) {
        const pos = (Math.log2((hz(s.m) * mult) / 40) / 7.2) * n
        for (let d = -2; d <= 2; d++) { const i = Math.round(pos) + d; if (i >= 0 && i < n) target[i] = Math.max(target[i], env * gain * Math.exp(-(d * d) / 1.6)) }
      }
    }
    for (let i = 0; i < n; i++) spec[i] += (target[i] - spec[i]) * (target[i] > spec[i] ? 0.55 : 0.12)
  }
  const chip = $('audioChip'), want = live ? 'live' : audio?.on ? 'on' : 'off'
  if (chip.dataset.s !== want) { chip.dataset.s = want; chip.classList.toggle('live', live); $('audioNote').textContent = live ? 'sound is on · the spectrum is live from the speakers' : audio?.on ? 'sound is on · waiting for the first note' : 'sound is off · the spectrum is drawn from the notes' }
  const bw = (x1 - x0) / n
  for (let i = 0; i < n; i++) {
    const v = clamp(spec[i], 0, 1), bh = Math.max(2, v * h * 0.78)
    const grad = g.createLinearGradient(0, y + h * 0.8, 0, y + h * 0.8 - bh); grad.addColorStop(0, rgba(col, 0.25)); grad.addColorStop(1, rgba(col, 0.95))
    g.fillStyle = grad; rr(x0 + i * bw + 1, y + h * 0.8 - bh, bw - 2, bh, 2); g.fill()
    g.fillStyle = rgba(col, 0.1 * v + 0.03); g.fillRect(x0 + i * bw + 1, y + h * 0.8 + 2, bw - 2, bh * 0.22)
  }
  if (live) {
    audio.analyser.getByteTimeDomainData(audio.wave)
    g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2; g.beginPath()
    for (let i = 0; i < 256; i++) { const v = (audio.wave[i * 4] - 128) / 128, px = x0 + (i / 255) * (x1 - x0), py = y + h * 0.32 + v * h * 0.3; i ? g.lineTo(px, py) : g.moveTo(px, py) }
    g.stroke()
  }
}

// ---------------------------------------------------------------- the person plays
const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('sound').onclick = () => {
  const b = $('sound')
  if (audio?.on) { stopAudio(); b.textContent = 'Sound on'; b.classList.remove('live') } else if (startAudio()) { b.textContent = 'Sound is on'; b.classList.add('live') }
}
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('onemore').onclick = () => post({ cmd: 'onemore' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('noMood').onclick = () => post({ cmd: 'request', mood: null })
$('tempo').oninput = (e) => { $('tempoVal').textContent = e.target.value + ' bpm'; post({ cmd: 'set', key: 'tempo', value: Number(e.target.value) }) }
$('memory').oninput = (e) => { const v = Number(e.target.value); $('memoryVal').textContent = v === 1 ? '1 bar' : v + ' bars' }
$('memory').onchange = (e) => { post({ cmd: 'set', key: 'memory', value: Number(e.target.value) }); e.target.blur() }
$('tempo').onchange = (e) => e.target.blur()
for (const b of document.querySelectorAll('[data-inst]')) b.onclick = () => {
  inst = b.dataset.inst
  for (const o of document.querySelectorAll('[data-inst]')) o.classList.toggle('on', o === b)
  // re-voice what has not sounded yet, so the change is heard at once
  const now = performance.now()
  for (const e of timeline) { e.events = null; if (e.end > now) { silence(e, now); e.voices.length = 0; e.scheduled = false; scheduleAudio(e) } }
}

async function pollJev() {
  try {
    const s = await (await fetch('/jev', { cache: 'no-store' })).json()
    $('s-rate').textContent = s.questionsPerSec >= 10 ? Math.round(s.questionsPerSec) : s.questionsPerSec.toFixed(1)
    $('s-dec').textContent = s.questions.toLocaleString('en-US'); $('s-cost').textContent = fmtMoney(s.costUsd)
  } catch { /* viewer restarting */ }
  setTimeout(pollJev, 300)
}

fit()
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
pollJev()
requestAnimationFrame(draw)
