// Jev Conductor viewer — a loopback server where Jev (TypeSafe's System One model) is the composer.
// The agent defines a piece.json (scale, tempo, mood, style). This server runs a bar clock and asks
// Jev to choose the chord, bass note, lead note and dynamics for the NEXT bar, then streams a
// rolling score + the chosen notes to the pane. The pane renders the score as a scrolling marquee
// and performs it with the Web Audio API. Watching Jev write a tune live is the experience.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. The workspace holds piece.json which the
// viewer watches (live edit of mood/style/tempo reshapes Jev's choices).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT_PIECE = {
  title: 'Jev in Blue',
  description: 'A tune Jev composes live.',
  tempo: 96,                 // bpm
  beatsPerBar: 4,
  swing: 0.2,
  scale: ['C4', 'D4', 'E4', 'G4', 'A4'],
  bassScale: ['C2', 'G2', 'A2', 'F2'],
  chords: ['Cmaj7', 'Am7', 'Fmaj7', 'G7'],   // pool Jev picks from
  moods: ['brooding', 'hopeful', 'driving'],
  leadNotes: 8,              // notes per bar
  volume: 0.6,
}

const VALID_BASS = ['C2', 'C#2', 'D2', 'D#2', 'E2', 'F2', 'F#2', 'G2', 'G#2', 'A2', 'A#2', 'B2', 'C3', 'G2']
const VALID_SCALE = ['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5']

function midi(note) {
  const map = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
  const m = String(note).match(/^([A-G]#?)(\d)$/)
  if (!m) return null
  return map[m[1]] + (Number(m[2]) + 1) * 12
}

function stateBlock(piece, plan) {
  // Jev reads the piece + the last few bars it wrote, so its choices are coherent with its own work.
  const recent = plan.slice(-4).map((b) => `${b.chord} · bass ${b.bass} · lead ${b.lead.join(' ')} · ${b.mood}`).join('\n')
  return `You are composing a live piece.
Title: ${piece.title}. Mood: ${piece.moods.join('/')}. Tempo ${piece.tempo} bpm, ${piece.beatsPerBar} beats/bar, swing ${piece.swing}.
Available chords: ${piece.chords.join(', ')}. Scale: ${piece.scale.join(', ')}. Bass options: ${piece.bassScale.join(', ')}.
Last bars you wrote:
${recent || '(none yet — you are setting the tone)'}

Choose a chord, a bass note, a lead phrase (${piece.leadNotes} notes from the scale), and the mood for the next bar. Keep it musical, varied and coherent with what you just wrote.`
}

function buildQuestions(piece) {
  const moodOptions = piece.moods
  return {
    chord: {
      type: 'choice',
      instructions: 'Choose the next chord. Keep harmonic flow: resolve to the tonic, vary away, come back.',
      options: piece.chords,
    },
    bass: {
      type: 'choice',
      instructions: 'Choose the bass note for the bar, from the bass scale.',
      options: piece.bassScale,
    },
    lead: {
      type: 'choice',
      instructions: `Choose the first note of the ${piece.leadNotes}-note lead phrase, from the scale. A memorable phrase has a mix of steps and leaps.`,
      options: piece.scale,
    },
    mood: {
      type: 'choice',
      instructions: 'Choose the emotional mood of this bar.',
      options: moodOptions,
    },
    energy: {
      type: 'score',
      instructions: 'How intense vs calm should this bar be?',
      legend: { 0: 'sparse', 1: 'flowing', 2: 'driving' },
    },
  }
}

function leadPhrase(piece, seedNote, salt) {
  // Extend the chosen first note into a phrase of length piece.leadNotes using steps/leaps in the scale.
  const scale = piece.scale
  const start = Math.max(0, scale.indexOf(seedNote))
  const phrase = []
  let idx = start
  for (let i = 0; i < piece.leadNotes; i++) {
    phrase.push(scale[idx])
    // weighted random step in [-2, +2]
    const jump = [1, -1, 2, -2, 1, 1, 0][Math.floor(hash01(`lead${i}:${salt}`, i + 3) * 7)] || 1
    idx = Math.max(0, Math.min(scale.length - 1, idx + jump))
  }
  return phrase
}

function hash01(str, salt = 0) {
  let h = 2166136261 ^ salt
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

function verdict(piece, plan, state) {
  const bars = plan.length
  return {
    spec: 1,
    ready: bars > 0,
    summary: state.error ? 'Conductor needs a fix' : `${piece.title} · Jev has written ${bars} bars${plan.length ? ` · now in ${plan[plan.length - 1].mood}` : ''}`,
    findings: state.error ? [{ severity: 'error', kind: 'conductor', message: state.error }] : [],
    artifact: 'piece.json',
    phases: [
      { id: 'theme', name: 'Theme', state: bars ? 'done' : 'active' },
      { id: 'compose', name: 'Compose', state: bars ? 'active' : 'pending' },
    ],
    updatedAt: new Date().toISOString(),
  }
}

export async function startConductorViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let piece = readPiece(join(workspace, 'piece.json'))
  let plan = []           // [{bar, chord, bass, lead:[...], mood, energy, at}]
  let clients = new Set()
  let lastLine = null // the last frame sent, replayed to a pane that connects later
  let stopped = false
  let salt = 1
  let running = false
  let error = null
  let barCount = 0

  function readPiece(file) {
    try {
      return { ...DEFAULT_PIECE, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      return DEFAULT_PIECE
    }
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    lastLine = line
    for (const c of clients) c.write(line)
  }

  function tail() {
    const v = verdict(piece, plan, { error })
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'bar',
      title: piece.title,
      description: piece.description,
      running,
      error,
      bar: barCount,
      piece: {
        tempo: piece.tempo, beatsPerBar: piece.beatsPerBar, swing: piece.swing,
        scale: piece.scale, bassScale: piece.bassScale, chords: piece.chords,
        moods: piece.moods, leadNotes: piece.leadNotes, volume: piece.volume,
      },
      plan: plan.slice(-24),
    })
  }

  async function composeBar() {
    if (stopped || !running) return
    try {
      const questions = buildQuestions(piece)
      const res = await evaluate({ state: stateBlock(piece, plan), questions, salt: salt++, model: process.env.JEV_MODEL || 'jev-latest' })
      const a = res.answers
      const chord = a.chord?.choice || piece.chords[0]
      const bass = a.bass?.choice || piece.bassScale[0]
      const seed = a.lead?.choice || piece.scale[0]
      const mood = a.mood?.choice || piece.moods[0]
      const energy = typeof a.energy?.score === 'number' ? a.energy.score : 1
      const lead = leadPhrase(piece, seed, salt)
      plan.push({ bar: ++barCount, chord, bass, lead, mood, energy, at: new Date().toISOString(), model: res.model, client: res.client })
      if (plan.length > 60) plan.splice(0, plan.length - 60)
      error = null
    } catch (e) {
      error = clean(e.message)
    }
    tail()
  }

  let timer = null
  function barMs() { return Math.max(120, Math.round((60000 / Math.max(20, piece.tempo)) * piece.beatsPerBar)) }
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(runBar, barMs())
  }
  async function runBar() {
    if (stopped) return
    await composeBar()
    schedule()
  }
  function start() { if (!running) { running = true; schedule() } }
  // The show runs on its own: Jev improvises bar after bar on a clock. The pane's Play button only
  // unlocks the browser's audio (a user gesture is required to start a Web Audio context); the
  // composition itself flows whether or not audio is audible.
  function pause() { running = false; clearTimeout(timer) }
  function reset() {
    barCount = 0; plan = []; salt = 1; error = null
    tail()
    if (running) schedule()
  }

  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'piece.json') {
      piece = readPiece(join(workspace, 'piece.json'))
      tail()
      if (running) schedule()
    }
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'index.html'))) }
    if (req.method === 'GET' && url.pathname === '/studio.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.js'))) }
    if (req.method === 'GET' && url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
    if (req.method === 'GET' && url.pathname === '/jev-hud.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'jev-hud.js'))) }
    if (req.method === 'GET' && url.pathname === '/studio.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.css'))) }
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ piece, plan: plan.slice(-24), running, bar: barCount })) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      if (lastLine) res.write(lastLine)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = ''
      for await (const c of req) { body += c; if (body.length > 1024) break }
      const cmd = JSON.parse(body || '{}').cmd
      if (cmd === 'pause') pause()
      if (cmd === 'start') start()
      if (cmd === 'reset') reset()
      if (cmd === 'onemore') await composeBar()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  tail()
  start()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; clearTimeout(timer); watcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
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
