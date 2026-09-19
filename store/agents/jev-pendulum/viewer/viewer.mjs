// Jev Pendulum viewer — a loopback server running a live balancing rig. A stiff rod is hinged on a
// cart. About twelve times a second the rig is written out as text and Jev (TypeSafe's System One
// model) answers two typed questions in ONE call: which way to push the cart, and whether the rod
// is still under control. Gusts keep knocking it. The rig is synthetic; the decision loop is the demo.
//
// The chat agent edits pendulum.json (gravity, rod length, push authority, gusts). The pane can
// also poke the rig live: flick the rod, send a gust, change gravity or the rod's length.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds pendulum.json (watched live).

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, clean } from './serve.mjs'
import { DEFAULT, ORDER, PUSH, REST_DEG, sanitize, createWorld, newRun, step, stateText, kick, shoveOf, noReturnDeg, budgetOf } from './sim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEG = 180 / Math.PI
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

const QUESTIONS = {
  action: jev.choice({
    LEFT_HARD: 'shove the cart hard to the left',
    LEFT: 'push the cart gently to the left',
    CENTER: 'do not push the cart',
    RIGHT: 'push the cart gently to the right',
    RIGHT_HARD: 'shove the cart hard to the right',
  }, 'Which push steadies the rod right now?'),
  conf: jev.noul('Is the rod under control?'),
}

/** Dials the pane may override while it runs. An edit to pendulum.json resets them. */
const DIALS = { gravity: [0.5, 30], length: [0.2, 3], gustStrength: [0, 5], maxTorque: [0.05, 10] }

export async function startPendulumViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)

  // Every binding is declared before anything can call into the closures below.
  let world = null
  let stopped = false, running = false
  let timer = null, salt = 1, lastVerdictAt = 0
  let queue = Promise.resolve()
  let overrides = {}
  let decision = { action: 'CENTER', probs: {}, conf: 0, steady: 0.5 }
  let text = ''
  let error = null
  let server = null
  let history = [] // per decision: { step, deg (unsigned), tilt (signed), action, conf, gust }
  const session = { decisions: 0 }

  const cfgWatch = watchConfig(join(workspace, 'pendulum.json'), DEFAULT, () => { overrides = {}; restart(); push(true) })
  const cfg = () => sanitize({ ...cfgWatch.get(), ...overrides })

  function restart() {
    world = createWorld(cfg())
    history = []
    text = stateText(world, cfg())
  }

  function frame() {
    const c = cfg(), w = world
    return {
      t: w.t, tickMs: c.stepMs, title: c.title, episode: w.episode,
      angle: w.angle * DEG, vel: w.vel, x: w.x, vx: w.vx, push: w.push, from: { angle: w.from.angle * DEG, x: w.from.x },
      phase: w.phase, hold: w.hold,
      thisRun: w.run, bestRun: w.best, falls: w.falls, lastRun: w.lastRun, runs: w.runs,
      dials: { gravity: c.gravity, length: c.length, gustStrength: c.gustStrength, gustEvery: c.gustEvery, maxTorque: c.maxTorque, fallDeg: c.fallDeg, damping: c.damping },
      shove: shoveOf(c), pushes: Object.fromEntries(ORDER.map((a) => [a, PUSH[a] * shoveOf(c)])),
      noReturnDeg: noReturnDeg(c), budget: budgetOf(w, c), restDeg: REST_DEG,
      decision, events: w.events, stateText: text, trace: history.slice(-160).map((h) => [h.tilt, h.gust ? 1 : 0]),
      running, error, cfgError: cfgWatch.error(), overrides,
    }
  }
  // /state also keeps the older field names (step, lastAction, lastConf, history).
  const fullState = () => ({
    ...frame(), description: cfg().description, instrument: cfg().instrument,
    step: world.t, lastAction: decision.action, lastConf: decision.steady, history: history.slice(-240),
  })

  function verdict() {
    const c = cfg(), w = world
    const problem = cfgWatch.error() || error
    const secs = (ticks) => ((ticks * c.stepMs) / 1000).toFixed(1)
    writeVerdict(workspace, {
      ready: session.decisions > 0,
      summary: problem
        ? `Jev Pendulum needs a fix: ${problem}`
        : w.phase === 'fallen'
          ? `${c.title} · fell after ${secs(w.lastRun)} s · best ${secs(w.best)} s · ${w.falls} falls at gravity ${c.gravity}`
          : `${c.title} · balancing for ${secs(w.run)} s · tilt ${(w.angle * DEG).toFixed(1)}° · best ${secs(w.best)} s · ${w.falls} falls`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'pendulum', message: problem }] : []),
        { severity: 'info', kind: 'pendulum', message: `${session.decisions} decisions, ${w.falls} falls, best run ${secs(w.best)} s. Gravity ${c.gravity}, rod ${c.length}, hardest shove ${shoveOf(c).toFixed(2)} m/s²: a still rod cannot be held past ${noReturnDeg(c).toFixed(1)}°.` },
        ...(w.falls ? [{ severity: 'warn', kind: 'pendulum', message: `Jev lost the rod after ${secs(w.lastRun)} s at gravity ${c.gravity}` }] : []),
      ],
      artifact: 'pendulum.json',
      phases: [
        { id: 'stand', name: 'Rig up', state: 'done' },
        { id: 'balance', name: 'Balancing', state: session.decisions > 0 ? (w.phase === 'fallen' ? 'done' : 'active') : 'pending' },
        { id: 'edge', name: 'At the edge', state: w.falls ? 'done' : 'pending' },
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
      if (world.phase === 'fallen') { step(world, c, 'CENTER'); text = stateText(world, c); return } // the rod is down: nothing to ask
      text = stateText(world, c)
      const res = await evaluate({ state: text, questions: QUESTIONS, salt: salt++, model: process.env.JEV_MODEL || 'jev-latest' })
      const a = res.answers
      const action = ORDER.includes(a.action?.choice) ? a.action.choice : 'CENTER'
      decision = { action, probs: a.action?.probabilities ?? {}, conf: Number(a.action?.confidence ?? 0), steady: Number(a.conf?.noul ?? 0.5) }
      session.decisions++
      const evs = step(world, c, action)
      history.push({ step: world.t, deg: Math.abs(world.angle * DEG), tilt: world.angle * DEG, action, conf: decision.steady, gust: evs.some((e) => e.e === 'gust' || e.e === 'flick') })
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
      if (range) overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], cfg()[body.key]) }
    } else if (cmd === 'flick') kick(world, cfg(), clampN(body.v, -3, 3, 0.8), 'flick')
    else if (cmd === 'gust') kick(world, cfg(), (body.dir < 0 ? -1 : body.dir > 0 ? 1 : world.rng() < 0.5 ? -1 : 1) * Math.max(0.2, cfg().gustStrength), 'gust')
    else if (cmd === 'stand') newRun(world, cfg())
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
  const viewer = await startPendulumViewer({ workspace, port })
  console.log(`Jev Pendulum listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
