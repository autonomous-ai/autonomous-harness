// Jev Slalom viewer — a loopback server running a live slalom demo. The skier descends a valley and
// gates sweep toward it; Jev (TypeSafe's System One model) reads the skier's x and the next gate
// every tick and steers left/right to thread each gap. Clip a gate or hit the net and the run ends.
// The agent shapes slalom.json (the descent speed, the valley width, how many gates, the gap). The
// pane can also poke the run live: sliders, a click that plants an extra gate, a gust of wind that
// shoves the skier sideways, slow motion. The course is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds slalom.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const FILES = { 'index.html': 'text/html; charset=utf-8', 'studio.css': 'text/css; charset=utf-8', 'studio.js': 'text/javascript; charset=utf-8', 'jev-hud.js': 'text/javascript; charset=utf-8' }

const DEFAULT = {
  title: 'Jev Slalom',
  description: 'Jev is the racer — carve a slalom line and thread every gate.',
  instrument: 'SLALOM',
  tickMs: 160, speed: 2.2, gates: 18, valleyWidth: 18,
  style: 'You are skiing the slalom. A line of gates sweeps toward you as you descend — steer left and right to thread each gap, lining up early and committing as each gate arrives. Clip a gate or hit the wall and you fall. Clean, decisive turns win the run.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const MV = { LEFT_FAST: -1.9, LEFT: -1.0, HOLD: 0, RIGHT: 1.0, RIGHT_FAST: 1.9 }
const RESULT_MS = 3000    // how long a finished run stays on screen before the next one starts
const SLOWMO = 3          // slow motion stretches every tick by this factor
const PLANT_MIN = 5       // a planted gate must be at least this many rows ahead, and this far from another gate
const PLANT_MAX = 70
// Runtime dials the pane may override with a slider. An edit to slalom.json clears them.
const DIALS = { speed: [0.4, 6], gateGap: [2, 10] }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : d }

/** Keep a wild config from breaking the course. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const valleyWidth = Math.round(num(raw.valleyWidth, 6, 60, DEFAULT.valleyWidth))
  const autoGap = Math.min(6, valleyWidth * 0.34) // the gap when slalom.json does not name one
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: 'SLALOM',
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    tickMs: num(raw.tickMs, 60, 2000, DEFAULT.tickMs),
    speed: num(raw.speed, DIALS.speed[0], DIALS.speed[1], DEFAULT.speed),
    gates: Math.round(num(raw.gates, 2, 60, DEFAULT.gates)),
    valleyWidth,
    gateGap: Math.min(num(raw.gateGap, DIALS.gateGap[0], DIALS.gateGap[1], autoGap), valleyWidth - 3),
  }
}

function makeGates(count, W, gap, rng) {
  // a regular course: gates alternate sides of the valley at a fixed spacing, so difficulty is
  // purely a function of speed (fewer ticks between gates). rng only picks the first side.
  const gates = []
  let y = 12 + rng() * 3
  const step = Math.max(13, W * 0.72)
  let side = rng() < 0.5 ? -1 : 1
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
  const cfgFile = join(workspace, 'slalom.json')

  // Every binding is declared before anything can call into the closures below (no TDZ surprises).
  let fileCfg = { ...DEFAULT }
  let cfgError = null
  let overrides = {}
  let slowmo = false
  let error = null
  const clients = new Set()
  let stopped = false, running = false
  let timer = null, watchTimer = null
  let salt = 1, seq = 0, lastVerdictAt = 0
  let step = 0
  let state = null      // {x, rows, gates[], next, gust, finishRow}
  let move = 'HOLD'
  let probs = {}, conf = 0
  let stateText = ''
  let episode = 0       // bumps each time a run restarts, so the next one differs
  let finished = null   // {ok, ticks, gates, reason, atGate, left, hold}
  let history = []      // {step, x, rows, move}
  let events = []       // {seq, e, ...} short-lived things the pane animates
  let runLog = []       // the last runs of the whole session, newest last
  let recent = []       // 1 / 0 for the last 20 gates faced, the rolling threading rate
  let rng = mulberry32(2719)
  let fxRng = mulberry32(4244) // pokes from the pane draw from their own stream
  let chain = Promise.resolve() // decisions run one at a time, in order
  const session = { decisions: 0, runs: 0, cleanRuns: 0, gatesPassed: 0, gatesFaced: 0, bestGates: 0, planted: 0, gusts: 0 }

  const cfg = () => sanitize({ ...fileCfg, ...overrides })
  const delay = () => cfg().tickMs * (slowmo ? SLOWMO : 1)

  function loadCfg() {
    try {
      const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('slalom.json must be a JSON object')
      const before = state ? cfg() : null
      fileCfg = { ...DEFAULT, ...raw }
      overrides = {} // the file is the source of truth again
      cfgError = null
      const now = cfg()
      if (!before || ['speed', 'valleyWidth', 'gates', 'gateGap'].some((k) => before[k] !== now[k])) newEpisode()
    } catch (e) {
      cfgError = clean(`slalom.json: ${e.message}`) // keep the last good config and keep skiing
    }
  }

  function emit(ev) { events.push({ seq: ++seq, ...ev }); if (events.length > 16) events.shift() }

  function newEpisode() {
    const c = cfg()
    rng = mulberry32(2719 + episode * 97)
    const W = c.valleyWidth
    const gates = makeGates(c.gates, W, c.gateGap, rng)
    state = { x: W / 2, rows: 0, gates, next: 0, gust: 0, finishRow: gates[gates.length - 1].y + 10 }
    move = 'HOLD'; probs = {}; conf = 0
    finished = null
    history = []
    step = 0
    error = null
    stateText = stateBlock(c, state)
    emit({ e: 'run', episode })
  }

  /** A gap slider move re-cuts every gate the skier has not reached yet. */
  function applyGap() {
    const c = cfg()
    for (const g of state.gates) if (!g.passed) { g.gap = c.gateGap; g.x = clamp(g.x, g.gap / 2 + 0.5, c.valleyWidth - g.gap / 2 - 0.5) }
  }

  function frame() {
    const c = cfg()
    return {
      type: 'tick', title: c.title, description: c.description, instrument: c.instrument,
      tickMs: delay(), slowmo, speed: c.speed, valleyWidth: c.valleyWidth, gateGap: c.gateGap, gatesTotal: state.gates.length,
      nudge: MV, x: state.x, rows: state.rows, gust: state.gust, finishRow: state.finishRow,
      move, probs, conf, step, episode, running, error, cfgError, overrides,
      finished: finished ? { ...finished, leftMs: Math.max(0, finished.left) * delay() } : null,
      gates: state.gates, next: state.next, events, session,
      recentRate: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null, recentN: recent.length,
      log: runLog.slice(-16), stateText,
    }
  }
  const fullState = () => ({ ...frame(), history: history.slice(-300), defaults: sanitize(fileCfg) })

  function verdict() {
    const c = cfg()
    const problem = cfgError || error
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null || session.decisions > 0,
      summary: problem
        ? `Jev Slalom needs a fix: ${problem}`
        : finished
          ? `${c.title} · ${finished.ok ? 'clean run, ' + finished.gates + ' gates' : 'fell at gate ' + (finished.atGate + 1) + ' after ' + finished.gates + ' · ' + finished.reason}`
          : `${c.title} · threading gate ${Math.min(state.next + 1, state.gates.length)}/${state.gates.length} · ${step} ticks`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'slalom', message: problem }] : []),
        ...(finished ? [{ severity: finished.ok ? 'info' : 'warning', kind: 'slalom', message: finished.ok ? `Jev carved a clean ${finished.gates}-gate run` : `Jev fell at gate ${finished.atGate + 1}: ${finished.reason}` }] : []),
        { severity: 'info', kind: 'session', message: `${session.decisions} decisions, ${session.runs} runs, ${session.cleanRuns} clean, ${session.gatesPassed} of ${session.gatesFaced} gates threaded at ${c.speed.toFixed(1)} rows a tick with a ${c.gateGap.toFixed(1)} gap` },
      ],
      artifact: 'slalom.json',
      phases: [
        { id: 'learn', name: 'Carving', state: session.decisions < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Threading gates', state: session.decisions >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Run done', state: finished ? 'active' : session.runs > 0 ? 'done' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 800) {
      lastVerdictAt = now
      try {
        const file = join(workspace, '.harness/verdict.json')
        writeFileSync(file + '.tmp', JSON.stringify(verdict()))
        renameSync(file + '.tmp', file)
      } catch (e) { error = clean(e.message) }
    }
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function finish(ok, reason) {
    finished = { ok, ticks: step, gates: ok ? state.gates.length : state.next, reason, atGate: ok ? state.gates.length : state.next, left: Math.max(1, Math.ceil(RESULT_MS / delay())) }
    finished.hold = finished.left
    session.runs++
    if (ok) session.cleanRuns++
    session.bestGates = Math.max(session.bestGates, finished.gates)
    runLog.push({ run: session.runs, ok, gates: finished.gates, of: state.gates.length, reason, speed: cfg().speed, ticks: step })
    if (runLog.length > 40) runLog.shift()
    emit({ e: ok ? 'finish' : 'crash', reason, x: state.x, rows: state.rows, gate: state.next })
  }

  /** One decision: ask Jev, steer, descend one tick, then check the gate and the nets. */
  async function decideOnce() {
    if (stopped) return
    const c = cfg()
    if (finished) {
      // Never sit on a finished screen: hold the result about three seconds, then a new run.
      // A clean run coasts on through the finish banner while it slows down.
      if (finished.ok) state.rows += c.speed * Math.max(0, finished.left / finished.hold) * 0.9
      if (--finished.left <= 0) { episode++; newEpisode() }
      return
    }
    try {
      stateText = stateBlock(c, state)
      const res = await evaluate({
        state: stateText,
        questions: { steer: { type: 'choice', instructions: 'Which way do you steer this tick?', options: MOVES } },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const ans = res.answers.steer ?? {}
      const pick = String(ans.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      probs = Object.fromEntries(MOVES.map((m) => [m, Number(ans.probabilities?.[m] ?? 0)]))
      conf = Number(ans.confidence ?? 0)
      session.decisions++
      // physics: advance the skier one tick (the wind, if any, pushes sideways)
      state.x = clamp(state.x + MV[move] + state.gust, 1, c.valleyWidth - 1)
      state.gust = Math.abs(state.gust) < 0.08 ? 0 : state.gust * 0.6
      state.rows += c.speed
      step++
      history.push({ step, x: state.x, rows: state.rows, move })
      if (history.length > 400) history.splice(0, history.length - 400)
      // check the current gate
      const g = state.gates[state.next]
      if (g && g.y - state.rows <= 0 && !g.passed) {
        g.passed = true
        const ok = Math.abs(state.x - g.x) <= g.gap / 2
        g.result = ok ? 'ok' : 'clip'; g.hitX = Number(state.x.toFixed(2))
        session.gatesFaced++
        if (ok) session.gatesPassed++
        recent.push(ok ? 1 : 0); if (recent.length > 20) recent.shift()
        emit({ e: 'gate', i: state.next, ok, gx: g.x, gy: g.y, gap: g.gap, x: state.x })
        if (ok) state.next++
        else finish(false, 'clipped the gate')
      }
      // net check
      if (!finished && (state.x <= 1.05 || state.x >= c.valleyWidth - 1.05)) finish(false, 'hit the wall')
      // clean finish
      if (!finished && state.next >= state.gates.length) finish(true, 'clean run')
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
  }

  const locked = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next }
  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, delay()) }
  async function run() {
    if (stopped || !running) return
    const t0 = Date.now()
    const wasFinished = !!finished
    await locked(decideOnce)
    push(wasFinished !== !!finished)
    if (running && !stopped) { clearTimeout(timer); timer = setTimeout(run, Math.max(0, delay() - (Date.now() - t0))) }
  }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') {
      await locked(() => {
        overrides = {}; slowmo = false; salt = 1; episode = 0; recent = []; runLog = []
        Object.assign(session, { decisions: 0, runs: 0, cleanRuns: 0, gatesPassed: 0, gatesFaced: 0, bestGates: 0, planted: 0, gusts: 0 })
        fxRng = mulberry32(4244)
        newEpisode()
      })
    } else if (cmd === 'tick') {
      const n = Math.round(num(body.n, 1, 5000, 1))
      await locked(async () => { for (let i = 0; i < n; i++) await decideOnce() })
    } else if (cmd === 'set') {
      const lim = DIALS[body.key]
      if (!lim || !Number.isFinite(Number(body.value))) return { ok: false, error: 'unknown dial' }
      overrides = { ...overrides, [body.key]: clamp(Number(body.value), lim[0], lim[1]) }
      if (body.key === 'gateGap') applyGap()
    } else if (cmd === 'slowmo') {
      slowmo = body.on === undefined ? !slowmo : !!body.on
      if (running) schedule()
    } else if (cmd === 'plant') {
      // Someone plants an extra gate on the slope. It has to be ahead of the skier and clear of the others.
      const c = cfg(), x = Number(body.x), y = Number(body.y)
      if (finished || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'nothing to plant on' }
      if (y < state.rows + PLANT_MIN || y > state.rows + PLANT_MAX) return { ok: false, error: `plant it ${PLANT_MIN} to ${PLANT_MAX} rows ahead of the skier` }
      if (state.gates.some((g) => Math.abs(g.y - y) < PLANT_MIN)) { emit({ e: 'refused', x, y }); push(true); return { ok: false, error: 'too close to another gate' } }
      if (state.gates.length >= 90) return { ok: false, error: 'the course is full' }
      const gap = c.gateGap
      const gate = { y, x: clamp(x, gap / 2 + 0.5, c.valleyWidth - gap / 2 - 0.5), gap, passed: false, planted: true }
      const at = state.gates.findIndex((g) => g.y > y)
      state.gates.splice(at < 0 ? state.gates.length : at, 0, gate)
      state.finishRow = state.gates[state.gates.length - 1].y + 10
      session.planted++
      emit({ e: 'plant', x: gate.x, y })
    } else if (cmd === 'gust') {
      // Wind shoves the skier sideways for a few ticks. Jev reads the new x and has to steer back.
      if (!finished) {
        const dir = body.dir === -1 || body.dir === 1 ? body.dir : (fxRng() < 0.5 ? -1 : 1)
        state.gust = clamp(state.gust + dir * (1.0 + fxRng() * 0.6), -2.5, 2.5)
        session.gusts++
        emit({ e: 'gust', v: state.gust })
      }
    } else return { ok: false, error: 'unknown command' }
    push(true)
    return { step, episode }
  }

  loadCfg()
  if (!state) newEpisode()

  let watcher = null
  try {
    watcher = watch(cfgFile, () => { clearTimeout(watchTimer); watchTimer = setTimeout(() => { if (stopped) return; locked(() => { loadCfg() }).then(() => push(true)) }, 40) })
  } catch { /* no file yet: defaults stand */ }

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        if (FILES[name] && extname(name)) { res.writeHead(200, { 'content-type': FILES[name] }); return res.end(readFileSync(join(HERE, name))) }
        if (url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(fullState())) }
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
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(j?.cmd ?? ''), j ?? {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...reply }))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false
      clearTimeout(timer); clearTimeout(watchTimer); watcher?.close()
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
  const viewer = await startSlalomViewer({ workspace, port })
  console.log(`Jev Slalom listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
