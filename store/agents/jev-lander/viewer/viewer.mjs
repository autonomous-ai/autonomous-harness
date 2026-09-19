// Jev Lander viewer — a loopback server running a live landing demo. A booster falls out of the
// sky. Every tick the telemetry is written out as text and Jev (TypeSafe's System One model)
// answers two typed questions in ONE call: which throttle to set (CUT / COAST / HOVER / BURN), and
// whether this touchdown will be soft. The flight is synthetic; the decision loop is the demo.
//
// The chat agent edits lander.json (gravity, fuel, drop height). The pane can also poke the flight
// live: shove the booster with a gust, spring a fuel leak, put the engine out, change the dials.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds lander.json (watched live).

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, clean } from './serve.mjs'
import { DEFAULT, ACTIONS, THRUST, sanitize, createWorld, newFlight, step, stateText, shove, leak, flameout, brakeOf, stopDistance } from './sim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

const QUESTIONS = {
  thrust: jev.choice({
    CUT: 'engine off, free fall',
    COAST: 'idle, a small push that barely slows the fall',
    HOVER: 'a medium push, about enough to hold the speed under normal gravity',
    BURN: 'full power, the hardest braking',
  }, 'Which throttle do you set for this tick?'),
  soft: jev.noul('Will the touchdown be soft?'),
}

/** Dials the pane may override while it runs. An edit to lander.json resets them. */
const DIALS = { gravity: [0.1, 5], fuel: [5, 2000], altitude: [10, 400], safeSpeed: [0.2, 10] }

export async function startLanderViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)

  // Every binding is declared before anything can call into the closures below.
  let world = null
  let stopped = false, running = false
  let timer = null, salt = 1, lastVerdictAt = 0
  let queue = Promise.resolve()
  let overrides = {}
  let decision = { thrust: 'CUT', probs: {}, conf: 0, soft: 0.5 }
  let text = ''
  let error = null
  let server = null
  let history = [] // per decision of this flight: { step, y, v, action }
  const session = { decisions: 0 }

  const cfgWatch = watchConfig(join(workspace, 'lander.json'), DEFAULT, () => { overrides = {}; restart(); push(true) })
  const cfg = () => sanitize({ ...cfgWatch.get(), ...overrides })

  function restart() {
    world = createWorld(cfg())
    history = []
    text = stateText(world, cfg())
  }

  function frame() {
    const c = cfg(), w = world
    return {
      t: w.t, tickMs: c.tickMs, title: c.title, episode: w.episode,
      y: w.y, v: w.v, fromY: w.from.y, fuel: w.fuel, tank: c.fuel, startAlt: w.startAlt,
      thrust: w.thrust, fired: w.fired, flameout: w.flameout, dry: !!w.dry,
      phase: w.phase, hold: w.hold, ticks: w.ticks, finished: w.finished,
      landed: w.landed, crashed: w.crashed, streak: w.streak, bestStreak: w.bestStreak, flights: w.flights,
      dials: { gravity: c.gravity, fuel: c.fuel, altitude: c.altitude, safeSpeed: c.safeSpeed },
      levels: THRUST, brake: brakeOf(c), stopDistance: Number.isFinite(stopDistance(w, c)) ? stopDistance(w, c) : null,
      decision, events: w.events, stateText: text, trace: w.trace.slice(-220),
      running, error, cfgError: cfgWatch.error(), overrides,
    }
  }
  // /state also keeps the older field names (step, gravity, safeSpeed, history).
  const fullState = () => ({
    ...frame(), description: cfg().description, instrument: cfg().instrument,
    step: world.ticks, gravity: cfg().gravity, safeSpeed: cfg().safeSpeed, history: history.slice(-200),
  })

  function verdict() {
    const c = cfg(), w = world, f = w.finished
    const problem = cfgWatch.error() || error
    writeVerdict(workspace, {
      ready: session.decisions > 0,
      summary: problem
        ? `Jev Lander needs a fix: ${problem}`
        : f
          ? `${c.title} · ${f.ok ? `landed soft at ${f.crashSpeed.toFixed(1)}` : `crashed at ${f.crashSpeed.toFixed(1)}`} · ${f.fuelLeft} fuel left · ${w.landed} landed, ${w.crashed} crashed`
          : `${c.title} · alt ${w.y.toFixed(0)} · vy ${w.v.toFixed(1)} · fuel ${w.fuel.toFixed(0)} · ${w.landed} landed, ${w.crashed} crashed`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'lander', message: problem }] : []),
        { severity: 'info', kind: 'lander', message: `${session.decisions} decisions, ${w.landed} soft landings, ${w.crashed} crashes. Gravity ${c.gravity}, tank ${c.fuel}, drop from ${c.altitude}. Full BURN brakes by ${brakeOf(c).toFixed(2)} per tick${brakeOf(c) <= 0 ? ': the booster cannot slow down at all' : ''}.` },
        ...(f && !f.ok ? [{ severity: 'warn', kind: 'lander', message: `The last flight crashed at ${f.crashSpeed.toFixed(1)} (soft is ${c.safeSpeed} or less) with ${f.fuelLeft} fuel left` }] : []),
      ],
      artifact: 'lander.json',
      phases: [
        { id: 'drop', name: 'Booster released', state: 'done' },
        { id: 'guide', name: 'Guiding down', state: session.decisions > 0 ? (w.phase === 'flight' ? 'active' : 'done') : 'pending' },
        { id: 'land', name: 'Touchdown', state: w.landed + w.crashed > 0 ? 'done' : 'pending' },
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
      if (world.phase !== 'flight') { // the result is on screen: nothing to ask
        const before = world.episode
        step(world, c, 'CUT')
        if (world.episode !== before) history = []
        text = stateText(world, c)
        return
      }
      text = stateText(world, c)
      const res = await evaluate({ state: text, questions: QUESTIONS, salt: salt++, model: process.env.JEV_MODEL || 'jev-latest' })
      const a = res.answers
      const thrust = ACTIONS.includes(a.thrust?.choice) ? a.thrust.choice : 'COAST'
      decision = { thrust, probs: a.thrust?.probabilities ?? {}, conf: Number(a.thrust?.confidence ?? 0), soft: Number(a.soft?.noul ?? 0.5) }
      session.decisions++
      step(world, c, thrust)
      history.push({ step: world.ticks, y: world.y, v: world.v, action: thrust })
      if (history.length > 300) history.splice(0, history.length - 300)
      text = stateText(world, c)
      error = null
    } catch (e) {
      error = clean(e?.message ?? String(e))
    }
  }
  /** Decisions never overlap: a `tick` from a test waits for the timer's decision, and the other way round. */
  function decide() { queue = queue.then(decideOnce, decideOnce); return queue }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().tickMs) }
  async function run() { const t0 = Date.now(); await decide(); push(); if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().tickMs - (Date.now() - t0))) }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { overrides = {}; salt = 1; session.decisions = 0; await queue; restart() }
    else if (cmd === 'tick') { const n = Math.round(clampN(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'set') {
      const range = DIALS[body.key]
      if (range) {
        const before = cfg().fuel
        overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], cfg()[body.key]) }
        // A new tank size keeps the same share of fuel in it, so the gauge moves at once.
        if (body.key === 'fuel' && world.phase === 'flight') world.fuel = (world.fuel / before) * cfg().fuel
      }
    } else if (cmd === 'shove') shove(world, cfg(), clampN(body.dv, -8, 8, -3))
    else if (cmd === 'leak') leak(world, cfg(), clampN(body.share, 0.05, 0.9, 0.3))
    else if (cmd === 'flameout') flameout(world, cfg(), clampN(body.ticks, 1, 20, 4))
    else if (cmd === 'launch') { newFlight(world, cfg()); history = [] }
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
  const viewer = await startLanderViewer({ workspace, port })
  console.log(`Jev Lander listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
