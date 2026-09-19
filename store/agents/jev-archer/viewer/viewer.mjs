// Jev Archer viewer — a loopback server running a live archery demo. A target slides along a rail
// and Jev (TypeSafe's System One model) reads the aim point and the target every tick and nudges the
// aim to track it. Every few ticks the arrow releases and lands where the aim is: on the gold it is
// a bullseye, anywhere else it is a miss. The agent shapes archer.json (how fast the target slides,
// how big the gold is). The pane can also poke the range live: sliders, a shove, a gust of wind,
// slow motion. The range is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds archer.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const FILES = { 'index.html': 'text/html; charset=utf-8', 'studio.css': 'text/css; charset=utf-8', 'studio.js': 'text/javascript; charset=utf-8', 'jev-hud.js': 'text/javascript; charset=utf-8' }

const DEFAULT = {
  title: 'Jev Archer',
  description: 'Jev is the archer — track the sliding target and plant every arrow in the bullseye.',
  instrument: 'ARCHER',
  tickMs: 150, speed: 0.6, bullHalf: 1.0, targetWidth: 24, shots: 16,
  style: 'You are the archer. A target slides across the line — read its position and nudge your aim to track it, then release. Land the arrow in the bullseye to score; miss and it flies by. Keep your aim glued to the moving target.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const AIM = { LEFT_FAST: -1.6, LEFT: -0.8, HOLD: 0, RIGHT: 0.8, RIGHT_FAST: 1.6 }
const FUSE = 6            // ticks between arrows
const RESULT_MS = 3000    // how long a finished range stays on screen before the next one starts
const SLOWMO = 3          // slow motion stretches every tick by this factor
// Runtime dials the pane may override with a slider. An edit to archer.json clears them.
const DIALS = { speed: [0.05, 4], bullHalf: [0.2, 4] }

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

/** Keep a wild config from breaking the range. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: 'ARCHER',
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    tickMs: num(raw.tickMs, 60, 2000, DEFAULT.tickMs),
    speed: num(raw.speed, DIALS.speed[0], DIALS.speed[1], DEFAULT.speed),
    bullHalf: num(raw.bullHalf, DIALS.bullHalf[0], DIALS.bullHalf[1], DEFAULT.bullHalf),
    targetWidth: Math.round(num(raw.targetWidth, 6, 60, DEFAULT.targetWidth)),
    shots: Math.round(num(raw.shots, 1, 100, DEFAULT.shots)),
  }
}

/** The whole target face, in slots. The gold in the middle is bullHalf wide; this is the straw around it. */
const faceRadius = (c) => Math.max(2.6, c.bullHalf * 1.35)

function stateBlock(p, s) {
  return `${p.style}
Aim is at x ${s.aim.toFixed(1)}; the target is at x ${s.target.toFixed(1)} (speed ${p.speed.toFixed(2)}), releasing in ${s.fuse} ticks.
aim x ${s.aim.toFixed(1)}   target x ${s.target.toFixed(1)}   in ${s.fuse} ticks
Which way do you nudge the aim? ${MOVES.join(' / ')}`
}

export async function startArcherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const cfgFile = join(workspace, 'archer.json')

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
  let state = null      // {aim, target, dir, fuse, gust, hits, misses, score, streak, arrows[]}
  let move = 'HOLD'
  let probs = {}, conf = 0
  let stateText = ''
  let episode = 0       // bumps each time a range restarts, so the next one differs
  let finished = null   // {ok, ticks, hits, misses, score, left}
  let history = []      // {step, aim, move}
  let events = []       // {seq, e, ...} short-lived things the pane animates (release, gust, shove)
  let shotLog = []      // the last arrows of the whole session, newest last
  let recent = []       // 1 / 0 for the last 20 arrows, the rolling bullseye rate
  let rng = mulberry32(8817)
  let fxRng = mulberry32(4242) // pokes from the pane draw from their own stream
  let chain = Promise.resolve() // decisions run one at a time, in order
  const session = { decisions: 0, arrows: 0, hits: 0, points: 0, ranges: 0, cleanRanges: 0, bestStreak: 0, shoves: 0, gusts: 0 }

  const cfg = () => sanitize({ ...fileCfg, ...overrides })
  const delay = () => cfg().tickMs * (slowmo ? SLOWMO : 1)

  function loadCfg() {
    try {
      const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('archer.json must be a JSON object')
      const before = state ? cfg() : null
      fileCfg = { ...DEFAULT, ...raw }
      overrides = {} // the file is the source of truth again
      cfgError = null
      const now = cfg()
      if (!before || ['speed', 'bullHalf', 'targetWidth', 'shots'].some((k) => before[k] !== now[k])) newEpisode()
    } catch (e) {
      cfgError = clean(`archer.json: ${e.message}`) // keep the last good config and keep playing
    }
  }

  function newEpisode() {
    const c = cfg()
    rng = mulberry32(8817 + episode * 97)
    const W = c.targetWidth
    state = { aim: W / 2, target: W / 2, dir: rng() < 0.5 ? 1 : -1, fuse: FUSE, gust: 0, hits: 0, misses: 0, score: 0, streak: 0, arrows: [] }
    move = 'HOLD'; probs = {}; conf = 0
    finished = null
    history = []
    step = 0
    error = null
    stateText = stateBlock(c, state)
    emit({ e: 'range', episode })
  }

  function emit(ev) { events.push({ seq: ++seq, ...ev }); if (events.length > 12) events.shift() }

  function frame() {
    const c = cfg()
    return {
      type: 'tick', title: c.title, description: c.description, instrument: c.instrument,
      tickMs: delay(), slowmo, speed: c.speed, bullHalf: c.bullHalf, targetWidth: c.targetWidth, shots: c.shots,
      faceR: faceRadius(c), fuseMax: FUSE, nudge: AIM,
      aim: state.aim, target: state.target, dir: state.dir, fuse: state.fuse, gust: state.gust,
      move, probs, conf, step, episode, running, error, cfgError, overrides,
      finished: finished ? { ...finished, leftMs: Math.max(0, finished.left) * delay() } : null,
      hits: state.hits, misses: state.misses, score: state.score, streak: state.streak,
      arrows: state.arrows, events, session,
      recentRate: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null, recentN: recent.length,
      log: shotLog.slice(-24), stateText,
    }
  }
  const fullState = () => ({ ...frame(), history: history.slice(-300), defaults: sanitize(fileCfg) })

  function verdict() {
    const c = cfg()
    const problem = cfgError || error
    const shotNo = Math.min(state.hits + state.misses + 1, c.shots)
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null || session.decisions > 0,
      summary: problem
        ? `Jev Archer needs a fix: ${problem}`
        : finished
          ? `${c.title} · ${finished.ok ? 'clean day, ' + finished.hits + ' bullseyes' : finished.hits + ' bullseyes, ' + finished.misses + ' missed'} · ${finished.score} points`
          : `${c.title} · arrow ${shotNo}/${c.shots} · ${state.hits} bullseyes · ${state.misses} missed`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'archer', message: problem }] : []),
        ...(finished ? [{ severity: finished.ok ? 'info' : 'warning', kind: 'archer', message: finished.ok ? `Jev sank ${finished.hits} of ${finished.hits + finished.misses} bullseyes` : `Jev missed ${finished.misses} of ${finished.hits + finished.misses} shots` }] : []),
        { severity: 'info', kind: 'session', message: `${session.decisions} decisions, ${session.arrows} arrows, ${session.hits} bullseyes (${session.arrows ? Math.round((session.hits / session.arrows) * 100) : 0}%) at target speed ${c.speed.toFixed(2)} and gold half-width ${c.bullHalf.toFixed(2)}` },
      ],
      artifact: 'archer.json',
      phases: [
        { id: 'learn', name: 'Reading', state: session.decisions < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Aiming', state: session.decisions >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Range done', state: finished ? 'active' : session.ranges > 0 ? 'done' : 'pending' },
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

  /** One decision: ask Jev, move the aim, slide the target, maybe release an arrow. */
  async function decideOnce() {
    if (stopped) return
    const c = cfg()
    if (finished) {
      // Never sit on a finished screen: hold the result about three seconds, then a new range.
      if (--finished.left <= 0) { episode++; newEpisode() }
      return
    }
    try {
      stateText = stateBlock(c, state)
      const res = await evaluate({
        state: stateText,
        questions: { aim: { type: 'choice', instructions: 'Which way do you nudge the aim this tick?', options: MOVES } },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const ans = res.answers.aim ?? {}
      const pick = String(ans.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      probs = Object.fromEntries(MOVES.map((m) => [m, Number(ans.probabilities?.[m] ?? 0)]))
      conf = Number(ans.confidence ?? 0)
      session.decisions++
      // physics: nudge the aim, slide the target one tick (plus any gust), count down the fuse
      const W = c.targetWidth
      state.aim = clamp(state.aim + AIM[move], 1, W - 1)
      state.target = clamp(state.target + state.dir * c.speed + state.gust, 1, W - 1)
      if (state.target <= 1.2) state.dir = 1
      else if (state.target >= W - 1.2) state.dir = -1
      state.gust = Math.abs(state.gust) < 0.06 ? 0 : state.gust * 0.7
      state.fuse--
      step++
      history.push({ step, aim: state.aim, move })
      if (history.length > 400) history.splice(0, history.length - 400)
      if (state.fuse <= 0) release(c)
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
  }

  /** The arrow lands where the aim is right now. Gold = bullseye; the rest of the face scores less. */
  function release(c) {
    const off = state.aim - state.target
    const dist = Math.abs(off)
    const hit = dist <= c.bullHalf + 1e-9 // an arrow exactly on the edge of the gold counts
    const faceR = faceRadius(c)
    let points = 0
    if (hit) points = 10
    else if (dist <= faceR) points = [8, 6, 4, 2][Math.min(3, Math.floor(((dist - c.bullHalf) / Math.max(0.01, faceR - c.bullHalf)) * 4))] // red, blue, black, white
    if (hit) { state.hits++; state.streak++ } else { state.misses++; state.streak = 0 }
    state.score += points
    session.arrows++; session.points += points
    if (hit) session.hits++
    session.bestStreak = Math.max(session.bestStreak, state.streak)
    recent.push(hit ? 1 : 0); if (recent.length > 20) recent.shift()
    const n = state.hits + state.misses
    const arrow = { n, off: Number(off.toFixed(2)), x: Number(state.aim.toFixed(2)), hit, points }
    state.arrows.push(arrow)
    shotLog.push({ ...arrow, episode, speed: c.speed })
    if (shotLog.length > 60) shotLog.shift()
    emit({ e: 'release', ...arrow, streak: state.streak })
    state.fuse = FUSE
    state.dir = rng() < 0.5 ? 1 : -1
    if (n >= c.shots) {
      finished = { ok: state.misses === 0, ticks: step, hits: state.hits, misses: state.misses, score: state.score, left: Math.max(1, Math.ceil(RESULT_MS / delay())) }
      session.ranges++
      if (finished.ok) session.cleanRanges++
      emit({ e: 'finished', ok: finished.ok })
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
        overrides = {}; slowmo = false; salt = 1; episode = 0; recent = []; shotLog = []
        Object.assign(session, { decisions: 0, arrows: 0, hits: 0, points: 0, ranges: 0, cleanRanges: 0, bestStreak: 0, shoves: 0, gusts: 0 })
        fxRng = mulberry32(4242)
        newEpisode()
      })
    } else if (cmd === 'tick') {
      const n = Math.round(num(body.n, 1, 5000, 1))
      await locked(async () => { for (let i = 0; i < n; i++) await decideOnce() })
    } else if (cmd === 'set') {
      const lim = DIALS[body.key]
      if (!lim || !Number.isFinite(Number(body.value))) return { ok: false, error: 'unknown dial' }
      overrides = { ...overrides, [body.key]: clamp(Number(body.value), lim[0], lim[1]) }
    } else if (cmd === 'slowmo') {
      slowmo = body.on === undefined ? !slowmo : !!body.on
      if (running) schedule()
    } else if (cmd === 'shove') {
      // A hand on the rail: the target jumps to where the person clicked. Jev has to find it again.
      if (!finished && Number.isFinite(Number(body.x))) {
        state.target = clamp(Number(body.x), 1, cfg().targetWidth - 1)
        session.shoves++
        emit({ e: 'shove', x: state.target })
      }
    } else if (cmd === 'gust') {
      // Wind catches the target and pushes it along the rail for a few ticks.
      if (!finished) {
        const dir = body.dir === -1 || body.dir === 1 ? body.dir : (fxRng() < 0.5 ? -1 : 1)
        state.gust = clamp(state.gust + dir * (1.1 + fxRng() * 0.7), -3, 3)
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
  const viewer = await startArcherViewer({ workspace, port })
  console.log(`Jev Archer listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
