// Jev Pong viewer — a loopback server running a live paddle-defence rally. A ball ricochets around
// a neon court; about sixteen times a second the court is written out as text and Jev (TypeSafe's
// System One model) answers two typed questions in ONE call: which paddle move to make, and whether
// the paddle will reach the ball at all. Every return makes the ball faster. The paddle never gets
// faster. The court is synthetic; the decision loop is the demo.
//
// The chat agent edits pong.json (court, pace, paddle). The pane can also poke the rally live:
// shove the ball, make it faster, change the dials.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds pong.json (watched live).

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, clean } from './serve.mjs'
import { DEFAULT, MOVES, MV, PADDLE_X, sanitize, createWorld, serve, step, stateText, predict, applyPace, shove, burst } from './sim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

const QUESTIONS = {
  move: jev.choice({
    MOVE_UP_FAST: 'slide the paddle up (toward y 0) at full speed',
    MOVE_UP: 'slide the paddle up (toward y 0) at plain speed',
    HOLD: 'keep the paddle where it is',
    MOVE_DOWN: 'slide the paddle down (toward larger y) at plain speed',
    MOVE_DOWN_FAST: 'slide the paddle down (toward larger y) at full speed',
  }, 'Which paddle move gets you to the ball in time?'),
  reach: jev.noul('Will the paddle reach the ball in time?'),
}

/** Dials the pane may override while it runs. An edit to pong.json resets them. */
const DIALS = { speed: [1, 60], maxSpeed: [0.25, 20], paddleH: [6, 96], accel: [0, 10] }

export async function startPongViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)

  // Every binding is declared before anything can call into the closures below.
  let world = null
  let stopped = false, running = false
  let timer = null, salt = 1, lastVerdictAt = 0
  let queue = Promise.resolve()
  let overrides = {}
  let decision = { move: 'HOLD', probs: {}, conf: 0, reach: 0.5 }
  let text = ''
  let error = null
  let server = null
  let history = [] // per decision: { step, ballY, paddleY, move, conf }
  const session = { decisions: 0 }

  const cfgWatch = watchConfig(join(workspace, 'pong.json'), DEFAULT, () => { overrides = {}; restart(); push(true) })
  const cfg = () => sanitize({ ...cfgWatch.get(), ...overrides })

  function restart() {
    world = createWorld(cfg())
    history = []
    text = stateText(world, cfg())
  }

  /** The pace past which a ball at the far end of the wall cannot be reached, even moving FAST all the way. */
  function outrunPace(c) {
    const roundTrip = 2 * (c.courtW - c.ballR - (PADDLE_X + c.ballR))
    return (2 * c.maxSpeed * roundTrip) / Math.max(1, c.courtH - c.paddleH)
  }

  function frame() {
    const c = cfg(), w = world, half = c.paddleH / 2
    const ghosts = {}
    // The options Jev chose between for the move now on screen: one decision of travel from where the paddle was.
    for (const m of MOVES) ghosts[m] = Math.max(half, Math.min(c.courtH - half, w.paddleFrom + MV[m] * c.maxSpeed))
    return {
      t: w.t, tickMs: c.stepMs, title: c.title, episode: w.episode,
      court: { W: c.courtW, H: c.courtH, paddleH: c.paddleH, r: c.ballR, px: PADDLE_X },
      ball: w.ball, path: w.path, paddleY: w.paddleY, paddleFrom: w.paddleFrom,
      phase: w.phase, hold: w.hold,
      rally: w.rally, bestRally: w.best, misses: w.misses, returns: w.returns,
      speedNow: w.speedNow, lastRally: w.lastRally, lastMissSpeed: w.lastMissSpeed, rallies: w.rallies,
      dials: { speed: c.speed, maxSpeed: c.maxSpeed, paddleH: c.paddleH, accel: c.accel, topSpeed: c.topSpeed },
      outrunPace: outrunPace(c),
      decision, ghosts, intercept: predict(w, c), events: w.events, stateText: text,
      running, error, cfgError: cfgWatch.error(), overrides,
    }
  }
  // /state also keeps the older field names (step, speed, lastMove, lastConf, history).
  const fullState = () => ({
    ...frame(), description: cfg().description, instrument: cfg().instrument,
    step: world.t, speed: cfg().speed, lastMove: decision.move, lastConf: decision.conf, history: history.slice(-240),
  })

  function verdict() {
    const c = cfg(), w = world
    const problem = cfgWatch.error() || error
    const mean = w.rallies.length ? w.rallies.reduce((a, r) => a + r.n, 0) / w.rallies.length : 0
    writeVerdict(workspace, {
      ready: session.decisions > 0,
      summary: problem
        ? `Jev Pong needs a fix: ${problem}`
        : w.misses
          ? `${c.title} · rally ${w.rally} · best ${w.best} · ${w.misses} misses · last ball got past at pace ${w.lastMissSpeed.toFixed(1)}`
          : `${c.title} · rally ${w.rally} · best ${w.best} · no misses yet at pace ${w.speedNow.toFixed(1)}`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'pong', message: problem }] : []),
        { severity: 'info', kind: 'pong', message: `${session.decisions} decisions, ${w.returns} returns, ${w.misses} misses, mean rally ${mean.toFixed(1)}. Start pace ${c.speed}, +${c.accel} per return, paddle ${2 * c.maxSpeed} per decision at most. A far ball is out of reach past pace ${outrunPace(c).toFixed(1)}.` },
        ...(w.misses ? [{ severity: 'warn', kind: 'pong', message: `Jev lost the last rally after ${w.lastRally} returns, at pace ${w.lastMissSpeed.toFixed(1)}` }] : []),
      ],
      artifact: 'pong.json',
      phases: [
        { id: 'serve', name: 'Court up', state: 'done' },
        { id: 'rally', name: 'Rallying', state: session.decisions > 0 ? (w.phase === 'missed' ? 'done' : 'active') : 'pending' },
        { id: 'edge', name: 'Outrun', state: w.misses ? 'done' : 'pending' },
      ],
    })
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    server?.broadcast(frame())
  }

  async function decideOnce() {
    if (stopped) return
    try {
      const c = cfg()
      if (world.phase === 'missed') { step(world, c, 'HOLD'); text = stateText(world, c); return } // the ball is gone: nothing to ask
      text = stateText(world, c)
      const res = await evaluate({ state: text, questions: QUESTIONS, salt: salt++, model: process.env.JEV_MODEL || 'jev-latest' })
      const a = res.answers
      const move = MOVES.includes(a.move?.choice) ? a.move.choice : 'HOLD'
      decision = { move, probs: a.move?.probabilities ?? {}, conf: Number(a.move?.confidence ?? 0), reach: Number(a.reach?.noul ?? 0.5) }
      session.decisions++
      step(world, c, move)
      history.push({ step: world.t, ballY: world.ball.y, paddleY: world.paddleY, move, conf: decision.conf })
      if (history.length > 300) history.splice(0, history.length - 300)
      text = stateText(world, c)
      error = null
    } catch (e) {
      error = clean(e?.message ?? String(e))
    }
  }
  /** Decisions never overlap: a `tick` from a test waits for the timer's decision, and the other way round. */
  function decide() { queue = queue.then(decideOnce, decideOnce); return queue }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().stepMs) }
  async function run() { const t0 = Date.now(); await decide(); push(); if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().stepMs - (Date.now() - t0))) }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { overrides = {}; salt = 1; session.decisions = 0; await queue; restart() }
    else if (cmd === 'tick') { const n = Math.round(clampN(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'set') {
      const range = DIALS[body.key]
      if (range) { overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], cfg()[body.key]) }; applyPace(world, cfg()) }
    } else if (cmd === 'shove') {
      const c = cfg()
      shove(world, c, clampN(body.x, 0, c.courtW, c.courtW / 2), clampN(body.y, 0, c.courtH, c.courtH / 2))
    } else if (cmd === 'burst') burst(world, cfg(), Math.round(clampN(body.n, 1, 20, 4)))
    else if (cmd === 'serve') serve(world, cfg())
    text = stateText(world, cfg())
    push(true)
    return { step: world.t }
  }

  restart()
  server = await serveViewer({ here: HERE, port, state: fullState, control })
  push(true)
  running = true
  schedule()

  return {
    url: server.url,
    async close() { stopped = true; running = false; clearTimeout(timer); cfgWatch.close(); await server.close() },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startPongViewer({ workspace, port })
  console.log(`Jev Pong listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
