// Jev Catcher viewer — a loopback server running a live fielding demo. A fielder guards the outfield:
// pop flies go up and come down at a spot on the line; Jev (TypeSafe's System One model) reads the
// glove's x and the next landing spot every tick and slides the glove under it. A ball it is not
// under drops. The agent shapes catcher.json (how many ticks a ball takes to fall, the glove's
// reach). The pane can also poke the field live: sliders, a click that pops an extra fly, a gust of
// wind that moves the landing spots, slow motion. The field is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds catcher.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const FILES = { 'index.html': 'text/html; charset=utf-8', 'studio.css': 'text/css; charset=utf-8', 'studio.js': 'text/javascript; charset=utf-8', 'jev-hud.js': 'text/javascript; charset=utf-8' }

const DEFAULT = {
  title: 'Jev Catcher',
  description: 'Jev is the fielder — slide the glove and catch every pop fly.',
  instrument: 'CATCHER',
  tickMs: 140, fallTicks: 10, gloveReach: 1.6, fieldWidth: 24, balls: 14,
  style: 'You are the fielder. A ball pops up and falls to a spot on the line — slide the glove to be right under it when it lands. Get there in time and it is an out; miss and it drops. Be decisive, read the landing spot early.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const MV = { LEFT_FAST: -1.2, LEFT: -0.6, HOLD: 0, RIGHT: 0.6, RIGHT_FAST: 1.2 }
const RESULT_MS = 3000    // how long a finished session stays on screen before the next one starts
const SLOWMO = 3          // slow motion stretches every tick by this factor
const MAX_AIR = 6         // balls in the air at once, counting the ones a person popped
// Runtime dials the pane may override with a slider. An edit to catcher.json clears them.
const DIALS = { fallTicks: [2, 60], gloveReach: [0.2, 4] }

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

/** Keep a wild config from breaking the field. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: 'CATCHER',
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    tickMs: num(raw.tickMs, 60, 2000, DEFAULT.tickMs),
    fallTicks: Math.round(num(raw.fallTicks, DIALS.fallTicks[0], DIALS.fallTicks[1], DEFAULT.fallTicks)),
    gloveReach: num(raw.gloveReach, DIALS.gloveReach[0], DIALS.gloveReach[1], DEFAULT.gloveReach),
    fieldWidth: Math.round(num(raw.fieldWidth, 6, 60, DEFAULT.fieldWidth)),
    balls: Math.round(num(raw.balls, 1, 100, DEFAULT.balls)),
  }
}

function makeBalls(count, W, rng) {
  // a stream of pop flies: each lands at a spot within reach of where the glove will be
  const balls = []
  let x = W / 2
  for (let i = 0; i < count; i++) {
    const land = clamp(x + (rng() - 0.5) * 2 * Math.min(W * 0.4, 10), 1, W - 1)
    balls.push({ land, phase: 0, done: false, caught: false })
    x = land
  }
  return balls
}

/** What Jev reads. The first ball is the one landing soonest; any others are named after it. */
function stateBlock(p, glove, ball, others) {
  const also = others.length ? `\nAlso falling: ${others.map((o) => `x ${o.land.toFixed(1)}, ${o.ticks} away`).join('; ')}.` : ''
  return `${p.style}
A ball lands at x ${ball.land.toFixed(1)} in ${ball.ticks} ticks.
glove x ${glove.toFixed(1)}   ball lands ${ball.land.toFixed(1)}   in ${ball.ticks} ticks${also}
Which way do you slide the glove? ${MOVES.join(' / ')}`
}

export async function startCatcherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const cfgFile = join(workspace, 'catcher.json')

  // Every binding is declared before anything can call into the closures below (no TDZ surprises).
  let fileCfg = { ...DEFAULT }
  let cfgError = null
  let overrides = {}
  let slowmo = false
  let error = null
  const clients = new Set()
  let stopped = false, running = false
  let timer = null, watchTimer = null
  let salt = 1, seq = 0, ballId = 0, lastVerdictAt = 0
  let step = 0
  let state = null      // {glove, balls[], next, air[], gust, catches, drops, streak}
  let move = 'HOLD'
  let probs = {}, conf = 0
  let stateText = ''
  let episode = 0       // bumps each time a session restarts, so the next one differs
  let finished = null   // {ok, ticks, caught, dropped, left}
  let history = []      // {step, glove, move, in}
  let events = []       // {seq, e, ...} short-lived things the pane animates
  let playLog = []      // the last balls of the whole session, newest last
  let recent = []       // 1 / 0 for the last 20 balls, the rolling catch rate
  let rng = mulberry32(5039)
  let fxRng = mulberry32(4243) // pokes from the pane draw from their own stream
  let chain = Promise.resolve() // decisions run one at a time, in order
  const session = { decisions: 0, balls: 0, caught: 0, sessions: 0, cleanSessions: 0, bestStreak: 0, extras: 0, gusts: 0 }

  const cfg = () => sanitize({ ...fileCfg, ...overrides })
  const delay = () => cfg().tickMs * (slowmo ? SLOWMO : 1)

  function loadCfg() {
    try {
      const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('catcher.json must be a JSON object')
      const before = state ? cfg() : null
      fileCfg = { ...DEFAULT, ...raw }
      overrides = {} // the file is the source of truth again
      cfgError = null
      const now = cfg()
      if (!before || ['fallTicks', 'gloveReach', 'fieldWidth', 'balls'].some((k) => before[k] !== now[k])) newEpisode()
    } catch (e) {
      cfgError = clean(`catcher.json: ${e.message}`) // keep the last good config and keep playing
    }
  }

  function emit(ev) { events.push({ seq: ++seq, ...ev }); if (events.length > 16) events.shift() }

  function launch(land, extra, index = -1) {
    const c = cfg()
    const ball = { id: ++ballId, land, ticks: c.fallTicks, total: c.fallTicks, extra, index }
    state.air.push(ball)
    emit({ e: 'launch', id: ball.id, land, total: ball.total, extra })
    return ball
  }

  function newEpisode() {
    const c = cfg()
    rng = mulberry32(5039 + episode * 97)
    const W = c.fieldWidth
    state = { glove: W / 2, balls: makeBalls(c.balls, W, rng), next: 0, air: [], gust: 0, catches: 0, drops: 0, streak: 0 }
    move = 'HOLD'; probs = {}; conf = 0
    finished = null
    history = []
    step = 0
    error = null
    emit({ e: 'session', episode })
    launch(state.balls[0].land, false, 0)
    stateText = stateBlock(c, state.glove, state.air[0], [])
  }

  /** The ball Jev must deal with first: the one landing soonest. */
  const soonest = () => state.air.slice().sort((a, b) => a.ticks - b.ticks || a.id - b.id)

  function frame() {
    const c = cfg()
    const order = state ? soonest() : []
    return {
      type: 'tick', title: c.title, description: c.description, instrument: c.instrument,
      tickMs: delay(), slowmo, fallTicks: c.fallTicks, gloveReach: c.gloveReach, fieldWidth: c.fieldWidth, ballsTotal: c.balls,
      nudge: MV, glove: state.glove, gust: state.gust,
      air: state.air.map((b) => ({ id: b.id, land: b.land, ticks: b.ticks, total: b.total, extra: b.extra })),
      primary: order[0]?.id ?? null, ballTicks: order[0]?.ticks ?? 0,
      move, probs, conf, step, episode, running, error, cfgError, overrides,
      finished: finished ? { ...finished, leftMs: Math.max(0, finished.left) * delay() } : null,
      balls: state.balls, next: state.next, catches: state.catches, drops: state.drops, streak: state.streak,
      events, session,
      recentRate: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null, recentN: recent.length,
      log: playLog.slice(-24), stateText,
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
        ? `Jev Catcher needs a fix: ${problem}`
        : finished
          ? `${c.title} · ${finished.ok ? 'clean session, ' + finished.caught + ' caught' : finished.caught + ' caught, ' + finished.dropped + ' dropped'}`
          : `${c.title} · ball ${Math.min(state.next + 1, state.balls.length)}/${state.balls.length} · ${state.catches} caught · ${state.drops} dropped`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'catcher', message: problem }] : []),
        ...(finished ? [{ severity: finished.ok ? 'info' : 'warning', kind: 'catcher', message: finished.ok ? `Jev caught all ${finished.caught} pop flies` : `Jev dropped ${finished.dropped} of ${finished.caught + finished.dropped}` }] : []),
        { severity: 'info', kind: 'session', message: `${session.decisions} decisions, ${session.balls} balls, ${session.caught} caught (${session.balls ? Math.round((session.caught / session.balls) * 100) : 0}%) with ${c.fallTicks} ticks of fall and a glove reach of ${c.gloveReach.toFixed(2)}` },
      ],
      artifact: 'catcher.json',
      phases: [
        { id: 'learn', name: 'Reading', state: session.decisions < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Fielding', state: session.decisions >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Session done', state: finished ? 'active' : session.sessions > 0 ? 'done' : 'pending' },
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

  /** One decision: ask Jev, slide the glove, let every ball fall one tick, settle the ones that land. */
  async function decideOnce() {
    if (stopped) return
    const c = cfg()
    if (finished) {
      // Never sit on a finished screen: hold the result about three seconds, then a new session.
      if (--finished.left <= 0) { episode++; newEpisode() }
      return
    }
    try {
      const order = soonest()
      stateText = stateBlock(c, state.glove, order[0], order.slice(1))
      const res = await evaluate({
        state: stateText,
        questions: { move: { type: 'choice', instructions: 'Which way do you slide the glove this tick?', options: MOVES } },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const ans = res.answers.move ?? {}
      const pick = String(ans.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      probs = Object.fromEntries(MOVES.map((m) => [m, Number(ans.probabilities?.[m] ?? 0)]))
      conf = Number(ans.confidence ?? 0)
      session.decisions++
      // physics: slide the glove, let the wind carry the landing spots, drop every ball one tick
      const W = c.fieldWidth
      state.glove = clamp(state.glove + MV[move], 1, W - 1)
      if (state.gust) {
        for (const b of state.air) b.land = clamp(b.land + state.gust, 1, W - 1)
        state.gust = Math.abs(state.gust) < 0.08 ? 0 : state.gust * 0.6
      }
      for (const b of state.air) b.ticks--
      step++
      history.push({ step, glove: state.glove, move, in: order[0].ticks })
      if (history.length > 400) history.splice(0, history.length - 400)
      for (const b of state.air.filter((x) => x.ticks <= 0)) land(b, c)
      state.air = state.air.filter((x) => x.ticks > 0)
      if (state.next >= state.balls.length && state.air.length === 0) {
        finished = { ok: state.drops === 0, ticks: step, caught: state.catches, dropped: state.drops, left: Math.max(1, Math.ceil(RESULT_MS / delay())) }
        session.sessions++
        if (finished.ok) session.cleanSessions++
        emit({ e: 'finished', ok: finished.ok })
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
  }

  /** A ball reaches the grass: it is an out only if the glove is within reach of the spot. */
  function land(b, c) {
    const gap = Math.abs(state.glove - b.land)
    const caught = gap <= c.gloveReach + 1e-9
    if (caught) { state.catches++; state.streak++; session.caught++ } else { state.drops++; state.streak = 0 }
    session.balls++
    session.bestStreak = Math.max(session.bestStreak, state.streak)
    recent.push(caught ? 1 : 0); if (recent.length > 20) recent.shift()
    const dive = caught && (gap > c.gloveReach * 0.5 || move.endsWith('FAST'))
    const play = { id: b.id, land: Number(b.land.toFixed(2)), glove: Number(state.glove.toFixed(2)), gap: Number(gap.toFixed(2)), caught, dive, extra: b.extra, episode, fall: b.total }
    playLog.push(play); if (playLog.length > 60) playLog.shift()
    emit({ e: caught ? 'catch' : 'drop', ...play, streak: state.streak, dir: Math.sign(MV[move]) })
    if (!b.extra) {
      const rec = state.balls[b.index]
      if (rec) { rec.done = true; rec.caught = caught; rec.land = b.land }
      state.next++
      if (state.next < state.balls.length) launch(state.balls[state.next].land, false, state.next)
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
        overrides = {}; slowmo = false; salt = 1; episode = 0; recent = []; playLog = []
        Object.assign(session, { decisions: 0, balls: 0, caught: 0, sessions: 0, cleanSessions: 0, bestStreak: 0, extras: 0, gusts: 0 })
        fxRng = mulberry32(4243)
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
    } else if (cmd === 'drop') {
      // Someone pops an extra fly to where they clicked. Jev now has more than one ball to read.
      if (!finished && Number.isFinite(Number(body.x)) && state.air.length < MAX_AIR) {
        launch(clamp(Number(body.x), 1, cfg().fieldWidth - 1), true)
        session.extras++
      }
    } else if (cmd === 'gust') {
      // Wind carries every ball in the air sideways for a few ticks, so the landing spots move.
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
  const viewer = await startCatcherViewer({ workspace, port })
  console.log(`Jev Catcher listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
