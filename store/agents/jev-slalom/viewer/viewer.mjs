// Jev Slalom viewer — a loopback server running a live slalom demo. The skier descends a valley and
// gates sweep toward it; Jev (TypeSafe's System One model) reads the skier's x and the next gate
// every tick and steers left/right to thread each gap. Clip a gate or hit the wall and the run ends.
// The agent shapes slalom.json (the descent speed, the valley width, how many gates) — crank the
// speed up and Jev's aim starts to wobble and it falls. The course is synthetic; the decision loop
// is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds slalom.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Slalom',
  description: 'Jev is the racer — carve a slalom line and thread every gate.',
  instrument: 'SLALOM',
  tickMs: 160, speed: 2.2, gates: 18, valleyWidth: 18,
  style: 'You are skiing the slalom. A line of gates sweeps toward you as you descend — steer left and right to thread each gap, lining up early and committing as each gate arrives. Clip a gate or hit the wall and you fall. Clean, decisive turns win the run.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const MV = { LEFT_FAST: -1.9, LEFT: -1.0, HOLD: 0, RIGHT: 1.0, RIGHT_FAST: 1.9 }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function makeGates(count, W, rng) {
  // a regular course: gates alternate sides of the valley at a fixed spacing, so difficulty is
  // purely a function of speed (fewer ticks between gates). rng only picks the first side.
  const gates = []
  let y = 12 + rng() * 3
  const step = Math.max(13, W * 0.72)
  let side = rng() < 0.5 ? -1 : 1
  const gap = Math.min(6, W * 0.34)
  const off = Math.min(W * 0.3, W / 2 - gap / 2 - 0.5)
  for (let i = 0; i < count; i++) {
    const center = W / 2 + side * off
    gates.push({ y, x: clamp(center, gap / 2 + 0.5, W - gap / 2 - 0.5), gap, passed: false })
    side = -side
    y += step
  }
  return gates
}

function stateBlock(p, s) {
  const g = s.gates[s.next]
  const rowGap = Math.max(0, g.y - s.rows)
  return `${p.style}
The skier descends at ${p.speed.toFixed(1)} rows/tick (reaction lag ${Math.max(0, Math.floor((p.speed - 1.8) * 1.7))} ticks).
Next gate: x ${g.x.toFixed(1)}, gap ${g.gap.toFixed(1)}, ROWS ${rowGap.toFixed(1)} ahead.
skier x ${s.x.toFixed(1)}   gate x ${g.x.toFixed(1)}   row gap ${rowGap.toFixed(1)}
Which way do you steer? ${MOVES.join(' / ')}`
}

export async function startSlalomViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let error = null
  let clients = new Set()
  let stopped = false
  let salt = 1
  let step = 0
  let running = false
  let state = null // {x, rows, gates, next}
  let move = 'HOLD'
  let episode = 0 // bumps each time an episode restarts on its own, so the next one differs
  let finished = null // {ok, ticks, gates, reason, atGate}
  let history = []    // {step, x, rows, move}
  let notified = false
  let rng

  let lastCfg = null
  let p = readCfg(join(workspace, 'slalom.json'))

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const merged = { ...DEFAULT, ...raw }
      if (!lastCfg || merged.speed !== lastCfg.speed || merged.valleyWidth !== lastCfg.valleyWidth || merged.gates !== lastCfg.gates || !state) {
        resetStateNow(merged)
      }
      lastCfg = merged
      return merged
    } catch (e) {
      error = clean(e.message)
      return lastCfg || DEFAULT
    }
  }

  function resetStateNow(cfg) {
    rng = mulberry32(2719 + episode * 97)
    const W = cfg.valleyWidth ?? DEFAULT.valleyWidth
    state = { x: W / 2, rows: 0, gates: makeGates(cfg.gates ?? DEFAULT.gates, W, rng), next: 0 }
    move = 'HOLD'
    finished = null
    history = []
    notified = false
    step = 0
    error = null
  }
  function resetState() { resetStateNow(p) }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null,
      summary: error
        ? 'Jev Slalom needs a fix'
        : finished
          ? `${p.title} · ${finished.ok ? 'clean run, ' + finished.gates + ' gates' : 'fell at gate ' + (finished.atGate + 1) + ' after ' + finished.gates + ' · ' + finished.reason}`
          : `${p.title} · threading gate ${Math.min(state.next + 1, state.gates.length)}/${state.gates.length} · ${step} ticks`,
      findings: (error ? [{ severity: 'error', kind: 'slalom', message: error }] : []).concat(
        finished
          ? [{ severity: finished.ok ? 'info' : 'error', kind: 'slalom', message: finished.ok ? `Jev carved a clean ${finished.gates}-gate run` : `Jev fell at gate ${finished.atGate + 1}: ${finished.reason}` }]
          : []
      ),
      artifact: 'slalom.json',
      phases: [
        { id: 'learn', name: 'Carving', state: history.length < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Threading gates', state: history.length >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Run done', state: finished ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
  }

  function tail() {
    const v = verdict()
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'tick', title: p.title, description: p.description, instrument: p.instrument,
      speed: p.speed, valleyWidth: p.valleyWidth,
      x: state?.x, rows: state?.rows, move, step, running, error, finished,
      gates: state?.gates, next: state?.next, history: history.slice(-300),
    })
  }

  function reset() { resetState(); tail(); if (running) schedule() }
  function pause() { running = false; clearTimeout(timer) }
  function start() { if (!running) { running = true; schedule() } }
  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, p.tickMs) }
  async function run() {
    if (stopped) return
    if (finished) {
      // Never sit on a finished screen: show the result briefly, then play again.
      finished.shownAt ??= Date.now()
      if (Date.now() - finished.shownAt > 3500) { episode++; resetState() }
      tail(); schedule(); return
    }
    await decide()
    schedule()
  }

  async function decide() {
    if (stopped) return
    try {
      const res = await evaluate({
        state: stateBlock(p, state),
        questions: {
          steer: { type: 'choice', instructions: 'Which way do you steer this tick?', options: MOVES },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const pick = String(res.answers.steer?.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      // physics: advance the skier one tick
      state.x = clamp(state.x + MV[move], 1, p.valleyWidth - 1)
      state.rows += p.speed
      step++
      history.push({ step, x: state.x, rows: state.rows, move })
      if (history.length > 400) history.splice(0, history.length - 400)
      // check the current gate
      const g = state.gates[state.next]
      if (g && g.y - state.rows <= 0 && !g.passed) {
        g.passed = true
        if (Math.abs(state.x - g.x) > g.gap / 2) {
          finished = { ok: false, ticks: step, gates: state.next, reason: 'clipped the gate', atGate: state.next }
          notified = true
        } else {
          state.next++
        }
      }
      // wall check
      if (state.x <= 1.05 || state.x >= p.valleyWidth - 1.05) {
        finished = { ok: false, ticks: step, gates: state.next, reason: 'hit the wall', atGate: state.next }
        notified = true
      }
      // clean finish
      if (!finished && state.next >= state.gates.length) {
        finished = { ok: true, ticks: step, gates: state.gates.length, reason: 'clean run', atGate: state.gates.length }
        notified = true
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'slalom.json'), () => {
    p = readCfg(join(workspace, 'slalom.json'))
    tail()
    if (running) schedule()
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, speed: p.speed, valleyWidth: p.valleyWidth, x: state?.x, rows: state?.rows, move, step, running, error, finished, gates: state?.gates, next: state?.next, history: history.slice(-300) })) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
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
      if (cmd === 'tick') await decide()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  resetState()
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
  const viewer = await startSlalomViewer({ workspace, port })
  console.log(`Jev Slalom listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
