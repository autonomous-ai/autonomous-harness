// Jev Conductor viewer — a loopback server where Jev (TypeSafe's System One model) is the composer.
// The chat agent defines piece.json (scale, chords, moods, tempo, memory). This server runs a bar
// clock. For every bar it makes two Jev calls: one picks the chord, the mood and the energy; the
// other picks the bass note and EVERY lead note (one typed question per note, all in one call). The
// full probability spread of each answer goes to the pane, which draws it on the piano roll as a
// cloud of possible notes and plays the bar with Web Audio.
//
// The honest dial is `memory`: how many of its own last bars the text shows Jev.
//
// The pane lets a person ask for a mood (it is written into the state as the audience's request),
// change the tempo and the memory, and ask for one more bar. The music never stops by itself.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds piece.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { DEFAULT, sanitize, barMs, parseChord, harmonyState, notesState, measure, strongMove } from './music.mjs'
import { conductorMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = new Set(['index.html', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export { sanitize }

export async function startConductorViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const file = join(workspace, 'piece.json')

  // Every binding is declared before anything can call into the closures below.
  let raw = { ...DEFAULT }
  let cfgError = null
  let overrides = {} // { tempo, memory }
  let request = null // the mood the audience asked for, or null
  let plan = [] // [{ bar, chord, bass, lead[], mood, energy, tones[], pos, request, probs, confidence, at }]
  let stateText = ''
  let stopped = false, running = false, busy = false
  let timer = null, watchTimer = null, salt = 1, barCount = 0, lastVerdictAt = 0, cut = 0
  let error = null
  const clients = new Set()
  const ZERO = { bars: 0, notes: 0, rests: 0, requests: 0, changes: 0, strong: 0, repeats: 0, moodFlips: 0, confidence: 0 }
  const totals = { ...ZERO }
  /** The whole session: share of chord changes that lead on, repeats, unasked mood changes, mean chord confidence. */
  const longRun = () => { const n = Math.max(1, totals.changes); return { changes: totals.changes, flow: totals.strong / n, repeats: totals.repeats / n, moodFlips: totals.moodFlips / n, confidence: totals.confidence / n } }

  function load() {
    try { raw = { ...DEFAULT, ...JSON.parse(readFileSync(file, 'utf8')) }; cfgError = null } catch (e) {
      cfgError = existsSync(file) ? clean(`piece.json: ${e.message}`) : null
    }
  }
  const piece = () => sanitize({ ...raw, ...overrides })

  /** One bar: two calls. The harmony first, then every note, with the chosen chord written into the text. */
  async function composeBar() {
    if (busy || stopped) return false
    busy = true
    try {
      const p = piece()
      if (request && !p.moods.includes(request)) request = null
      const barNo = barCount + 1
      const model = process.env.JEV_MODEL || 'jev-latest'
      stateText = harmonyState(p, plan, barNo, request)
      const h = await evaluate({
        state: stateText,
        questions: {
          chord: jev.choice(Object.fromEntries(p.chords.map((c) => [c, `${c}, tones ${parseChord(c).tones.join(' ')}`])), 'Choose the chord for this bar. Keep the harmony flowing: leave home, move on by strong steps, and come back.'),
          mood: jev.choice(p.moods, 'Choose the mood of this bar. Follow the audience if they asked for one.'),
          energy: jev.score({ 0: 'sparse', 1: 'flowing', 2: 'driving' }, 'How intense should this bar be?'),
        },
        salt: salt++, model, mock: conductorMock,
      })
      const bar = {
        bar: barNo,
        chord: p.chords.includes(h.answers.chord?.choice) ? h.answers.chord.choice : p.chords[0],
        mood: p.moods.includes(h.answers.mood?.choice) ? h.answers.mood.choice : p.moods[0],
        energy: num(h.answers.energy?.score, 0, 2, 1),
      }
      const options = Object.fromEntries([...p.scale.map((n) => [n, n]), ['rest', 'play nothing in this slot']])
      const questions = { bass: jev.choice(p.bassScale, 'Choose the bass note for this bar. The root of the chord is the safe choice.') }
      for (let k = 1; k <= p.leadNotes; k++) questions[`lead${k}`] = jev.choice(options, `Note ${k} of ${p.leadNotes} in this bar's lead phrase (${k % 2 ? 'a strong beat' : 'an off beat'}). Pick a note of the scale, or rest.`)
      const n = await evaluate({ state: notesState(p, plan, barNo, request, bar), questions, salt: salt++, model, mock: conductorMock })
      bar.bass = p.bassScale.includes(n.answers.bass?.choice) ? n.answers.bass.choice : p.bassScale[0]
      bar.lead = []
      const leadProbs = []
      for (let k = 1; k <= p.leadNotes; k++) {
        const a = n.answers[`lead${k}`] ?? {}
        bar.lead.push(a.choice === 'rest' || p.scale.includes(a.choice) ? a.choice : p.scale[0])
        leadProbs.push(a.probabilities ?? {})
      }
      Object.assign(bar, {
        tones: parseChord(bar.chord)?.tones ?? [], pos: ((barNo - 1) % p.phrase) + 1, request,
        confidence: Number(h.answers.chord?.confidence ?? 0),
        probs: { chord: h.answers.chord?.probabilities ?? {}, mood: h.answers.mood?.probabilities ?? {}, lead: leadProbs },
        at: new Date().toISOString(), model: h.model, client: h.client,
      })
      barCount = barNo
      plan.push(bar)
      if (plan.length > 64) plan.splice(0, plan.length - 64)
      totals.bars++
      for (const x of bar.lead) { if (x === 'rest') totals.rests++; else totals.notes++ }
      // Long-run counts, so the dial can be judged over the whole session and not one lucky window.
      const before = plan[plan.length - 2]
      if (before) {
        totals.changes++
        if (before.chord === bar.chord) totals.repeats++; else if (strongMove(before.chord, bar.chord)) totals.strong++
        if (before.mood !== bar.mood && !bar.request) totals.moodFlips++
        totals.confidence += bar.confidence
      }
      error = null
      return true
    } catch (e) {
      error = clean(e?.message ?? String(e))
      return false
    } finally {
      busy = false
    }
  }

  function frame() {
    const p = piece()
    const recent = plan.slice(-24)
    return {
      type: 'bar', title: p.title, description: p.description, running, error, cfgError, bar: barCount, cut,
      piece: { tempo: p.tempo, beatsPerBar: p.beatsPerBar, swing: p.swing, scale: p.scale, bassScale: p.bassScale, chords: p.chords, moods: p.moods, leadNotes: p.leadNotes, volume: p.volume, memory: p.memory, phrase: p.phrase },
      // The probability clouds are only drawn for the newest bars, so older bars travel light.
      plan: recent.map((b, i) => (i >= recent.length - 4 ? b : { ...b, probs: null })),
      request, measure: measure(p, plan.slice(-33)), longRun: longRun(), totals, stateText, overrides, barMs: barMs(p),
    }
  }

  function verdict() {
    const p = piece(), problem = cfgError || error, m = measure(p, plan.slice(-33))
    const v = {
      spec: 1,
      ready: !problem && barCount > 0,
      summary: problem
        ? `Conductor needs a fix: ${problem}`
        : `${p.title} · Jev has written ${barCount} bars${plan.length ? ` · now in ${plan[plan.length - 1].mood} · harmony flow ${Math.round(m.flow * 100)}%` : ''}`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'conductor', message: problem }] : []),
        { severity: 'info', kind: 'piece', message: `memory ${p.memory} bars, ${p.tempo} bpm, ${totals.notes} notes and ${totals.rests} rests written${request ? `, the audience asked for ${request}` : ''}` },
      ],
      artifact: 'piece.json',
      phases: [
        { id: 'theme', name: 'Theme', state: barCount ? 'done' : 'active' },
        { id: 'compose', name: 'Compose', state: barCount ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
    const out = join(workspace, '.harness/verdict.json')
    writeFileSync(out + '.tmp', JSON.stringify(v))
    renameSync(out + '.tmp', out)
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    if (!clients.size) return
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, barMs(piece())) }
  async function run() { await composeBar(); push(true); schedule() }

  /** A person changed what Jev faces: write two bars now, and tell the pane to cut over to them. */
  async function respond() { cut++; await composeBar(); await composeBar(); if (running) schedule() }

  async function control(cmd, body) {
    let ok = true
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { barCount = 0; plan = []; salt = 1; error = null; overrides = {}; request = null; cut++; Object.assign(totals, ZERO); await composeBar(); await composeBar(); if (running) schedule() }
    else if (cmd === 'tick') { const n = Math.round(num(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await composeBar() }
    else if (cmd === 'onemore') { cut++; ok = await composeBar(); if (running) schedule() }
    else if (cmd === 'request') {
      const mood = body.mood == null || body.mood === '' ? null : String(body.mood)
      if (mood && !piece().moods.includes(mood)) ok = false
      else { request = mood; if (mood) totals.requests++; await respond() }
    } else if (cmd === 'set') {
      if (body.key === 'tempo') { overrides = { ...overrides, tempo: Math.round(num(body.value, 30, 240, 96)) }; if (running) schedule() }
      else if (body.key === 'memory') { overrides = { ...overrides, memory: Math.round(num(body.value, 0, 8, 4)) }; await respond() }
      else ok = false
    } else ok = false
    push(true)
    return { ok, bar: barCount }
  }

  load()
  await composeBar(); await composeBar() // two bars in hand, so the pane always has the next bar to show

  // Watch the folder, not the file: an editor that saves by rename would drop a file watch.
  const watcher = watch(workspace, (_, name) => {
    if (name && String(name) !== 'piece.json') return
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      if (stopped) return
      const before = JSON.stringify(raw)
      load()
      if (JSON.stringify(raw) !== before) { overrides = {}; if (running) schedule() }
      push(true)
    }, 40)
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        if (FILES.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] }); return res.end(readFileSync(join(HERE, name))) }
        if (url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(frame())) }
        if (url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (url.pathname === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(frame())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && url.pathname === '/control') {
        let body = ''
        for await (const c of req) { body += c; if (body.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(j?.cmd ?? ''), j && typeof j === 'object' ? j : {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(reply))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ok) })

  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false
      clearTimeout(timer); clearTimeout(watchTimer)
      watcher.close()
      for (const c of clients) c.end()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startConductorViewer({ workspace, port })
  console.log(`Jev Conductor listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
