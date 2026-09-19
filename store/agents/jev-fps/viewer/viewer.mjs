// Jev FPS viewer — a loopback server running a first-person arena shooter that Jev plays live.
// About nine times a second the marine's situation is written out as text (HUD, what is in sight,
// what it hears, wall distances, the automap route) and Jev (TypeSafe's System One model) answers
// four typed questions in ONE call: where to turn, how to move, whether to fire, and how dangerous
// this instant is. The arena is synthetic; the decision loop is the demo.
//
// The chat agent edits level.json (the ASCII map, the demons, the pace). The pane can also poke the
// fight live: spawn demons, drop medkits, change demon speed, or grab the controls for a moment.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds level.json (watched live).

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, clean } from './kit.mjs'
import { DEFAULT, TURN_RATE, TURNS, MOVES, createWorld, observe, tick, spawnDemon, isWall } from './sim.mjs'
import { fpsMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

/** Keep a wild config from breaking the arena. check.mjs reports the same ranges to the agent. */
export function sanitize(raw) {
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    map: Array.isArray(raw.map) ? raw.map : DEFAULT.map,
    tickMs: clampN(raw.tickMs, 60, 1000, DEFAULT.tickMs),
    demons: Math.round(clampN(raw.demons, 1, 24, DEFAULT.demons)),
    demonSpeed: clampN(raw.demonSpeed, 0.2, 6, DEFAULT.demonSpeed),
    demonHealth: clampN(raw.demonHealth, 10, 400, DEFAULT.demonHealth),
    demonDamage: clampN(raw.demonDamage, 1, 60, DEFAULT.demonDamage),
    kills: Math.round(clampN(raw.kills, 1, 200, DEFAULT.kills)),
    ammo: Math.round(clampN(raw.ammo, 0, 99, DEFAULT.ammo)),
    seed: Math.round(clampN(raw.seed, 0, 1e9, DEFAULT.seed)),
  }
}

function questions(cfg) {
  const deg = (name) => Math.abs(Math.round(TURN_RATE[name] * cfg.tickMs / 1000))
  return {
    turn: jev.choice({
      LEFT_HARD: `snap ${deg('LEFT_HARD')} degrees to the left`, LEFT: `turn ${deg('LEFT')} degrees to the left`, LEFT_FINE: `nudge ${deg('LEFT_FINE')} degrees to the left`,
      AHEAD: 'keep facing the same way',
      RIGHT_FINE: `nudge ${deg('RIGHT_FINE')} degrees to the right`, RIGHT: `turn ${deg('RIGHT')} degrees to the right`, RIGHT_HARD: `snap ${deg('RIGHT_HARD')} degrees to the right`,
    }, 'Which way do you turn this instant? Put your crosshair on the threat you must deal with first.'),
    move: jev.choice({
      FORWARD: 'advance the way you face', BACK: 'back away while still facing forward', STRAFE_LEFT: 'sidestep to the left', STRAFE_RIGHT: 'sidestep to the right', HOLD: 'stand still',
    }, 'How do you move this instant?'),
    fire: jev.noul('Fire now? Yes only when a demon is in your crosshair and you have ammo.'),
    threat: jev.score(['calm: nothing close', 'watchful: a demon is around', 'pressed: demons are closing in', 'critical: about to die'], 'How dangerous is this instant?'),
  }
}

export async function startFpsViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)

  // Every binding is declared before anything can call into the closures below.
  let world = null
  let stopped = false, running = false, busy = false
  let timer = null, salt = 1, mapRev = 0, lastVerdictAt = 0
  let overrides = {}
  let human = null // { turn, move, fire, until }
  let decision = { turn: 'AHEAD', move: 'HOLD', fire: false, pFire: 0, threat: 0, probs: { turn: {}, move: {} }, conf: { turn: 0, move: 0 } }
  let obs = null
  let error = null
  let server = null
  const session = { kills: 0, deaths: 0, bestWave: 1, decisions: 0, shots: 0, hits: 0, wavesCleared: 0 }

  const cfgWatch = watchConfig(join(workspace, 'level.json'), DEFAULT, () => { overrides = {}; restart(1); push() })
  const cfg = () => sanitize({ ...cfgWatch.get(), ...overrides })

  function restart(waveNo, carry = null) {
    world = createWorld(cfg(), waveNo, carry, session.deaths)
    mapRev++
    obs = observe(world, cfg())
  }

  function frame() {
    const c = cfg()
    const p = world.player
    const humanOn = !!human && human.until > Date.now()
    return {
      t: world.step, tickMs: c.tickMs, mapRev, title: c.title,
      wave: world.waveNo, need: world.need, status: world.status,
      statusLeftMs: world.status === 'playing' ? 0 : Math.max(0, 3000 - (world.step - world.statusAt) * c.tickMs),
      player: { x: p.x, y: p.y, a: p.a, hp: p.hp, ammo: p.ammo, kills: p.kills, moving: p.moving, hurt: world.step - p.hurtAt <= 1 },
      demons: world.demons.map((d) => ({ id: d.id, x: d.x, y: d.y, hp: d.hp, st: d.state, hurt: d.hurt > 0 })),
      pickups: world.pickups.map((k) => ({ id: k.id, x: k.x, y: k.y, k: k.kind, on: k.respawn <= 0 })),
      events: world.events,
      decision, driver: humanOn ? 'human' : 'jev',
      route: obs?.route?.path ?? [], routeKind: obs?.route?.kind ?? null, crosshair: obs?.crosshair ?? null,
      stateText: obs?.text ?? '',
      demonSpeed: world.demonSpeed, maxAlive: world.maxAlive,
      session, running, error, cfgError: cfgWatch.error(), mapError: world.mapError, overrides,
    }
  }
  const fullState = () => ({ ...frame(), description: cfg().description, map: world.map.rows, cfg: { demons: cfg().demons, demonSpeed: cfg().demonSpeed, kills: cfg().kills, tickMs: cfg().tickMs } })

  function verdict() {
    const c = cfg()
    const problem = cfgWatch.error() || world.mapError || error
    const acc = session.shots ? Math.round((session.hits / session.shots) * 100) : 0
    writeVerdict(workspace, {
      ready: session.decisions > 0,
      summary: problem
        ? `Jev FPS needs a fix: ${problem}`
        : `${c.title} · wave ${world.waveNo} · ${session.kills} kills · ${session.deaths} deaths · best wave ${session.bestWave} · ${acc}% shots on target`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'level', message: problem }] : []),
        { severity: 'info', kind: 'fight', message: `${session.decisions} decisions, ${session.wavesCleared} waves cleared, demon speed ${world.demonSpeed.toFixed(2)} tiles/s with ${world.maxAlive} alive at once` },
      ],
      artifact: 'level.json',
      phases: [
        { id: 'spawn', name: 'Arena up', state: 'done' },
        { id: 'fight', name: 'Fighting', state: session.decisions > 0 ? 'active' : 'pending' },
        { id: 'waves', name: 'Waves cleared', state: session.wavesCleared > 0 ? 'done' : 'pending' },
      ],
    })
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    server?.broadcast(frame())
  }

  async function decide() {
    if (busy || stopped) return
    busy = true
    try {
      const c = cfg()
      if (world.status !== 'playing') {
        tick(world, c, decision)
        if ((world.step - world.statusAt) * c.tickMs >= 3000) {
          if (world.status === 'cleared') restart(world.waveNo + 1, { hp: world.player.hp, ammo: world.player.ammo })
          else restart(1)
        }
        return
      }
      obs = observe(world, c)
      const res = await evaluate({ state: obs.text, questions: questions(c), salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: fpsMock })
      const a = res.answers
      const turn = TURNS.includes(a.turn?.choice) ? a.turn.choice : 'AHEAD'
      const move = MOVES.includes(a.move?.choice) ? a.move.choice : 'HOLD'
      const pFire = Number(a.fire?.noul ?? 0)
      decision = {
        turn, move, fire: pFire >= 0.5, pFire, threat: Number(a.threat?.score ?? 0),
        probs: { turn: a.turn?.probabilities ?? {}, move: a.move?.probabilities ?? {} },
        conf: { turn: Number(a.turn?.confidence ?? 0), move: Number(a.move?.confidence ?? 0) },
      }
      session.decisions++
      const humanOn = !!human && human.until > Date.now()
      const events = tick(world, c, humanOn ? human : decision)
      for (const ev of events) {
        if (ev.e === 'shot') { session.shots++; if (ev.hit) session.hits++; if (ev.kill) session.kills++ }
        if (ev.e === 'dead') session.deaths++
        if (ev.e === 'cleared') { session.wavesCleared++; session.bestWave = Math.max(session.bestWave, world.waveNo + 1) }
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? String(e))
    } finally {
      busy = false
    }
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().tickMs) }
  async function run() { const t0 = Date.now(); await decide(); push(); if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().tickMs - (Date.now() - t0))) }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { Object.assign(session, { kills: 0, deaths: 0, bestWave: 1, decisions: 0, shots: 0, hits: 0, wavesCleared: 0 }); overrides = {}; human = null; salt = 1; restart(1) }
    else if (cmd === 'tick') { const n = Math.round(clampN(body.n, 1, 5000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'spawn') {
      const x = Number(body.x), y = Number(body.y)
      if (Number.isFinite(x) && Number.isFinite(y) && !isWall(world.map, x, y) && world.demons.length < 40) spawnDemon(world, cfg(), { x: (x | 0) + 0.5, y: (y | 0) + 0.5 })
    } else if (cmd === 'swarm') { for (let i = 0; i < 5 && world.demons.length < 40; i++) spawnDemon(world, cfg()) }
    else if (cmd === 'medkit') {
      const x = Number(body.x), y = Number(body.y)
      if (Number.isFinite(x) && Number.isFinite(y) && !isWall(world.map, x, y) && world.pickups.length < 60) world.pickups.push({ id: world.pickups.length + 1, x: (x | 0) + 0.5, y: (y | 0) + 0.5, kind: body.kind === 'ammo' ? 'ammo' : 'medkit', respawn: 0, once: true })
    } else if (cmd === 'set') {
      const allowed = { demonSpeed: [0.2, 6], demons: [1, 24], tickMs: [60, 1000] }
      if (allowed[body.key]) {
        overrides = { ...overrides, [body.key]: clampN(body.value, allowed[body.key][0], allowed[body.key][1], cfg()[body.key]) }
        const c = cfg()
        world.demonSpeed = c.demonSpeed * (1 + 0.12 * (world.waveNo - 1))
        world.maxAlive = Math.round(c.demons + (world.waveNo - 1))
      }
    } else if (cmd === 'human') {
      human = { turn: TURNS.includes(body.turn) ? body.turn : 'AHEAD', move: MOVES.includes(body.move) ? body.move : 'HOLD', fire: !!body.fire, until: Date.now() + 400 }
      return null // key events are frequent; the next frame shows the effect
    }
    push(true)
    return { step: world.step }
  }

  restart(1)
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
  const viewer = await startFpsViewer({ workspace, port })
  console.log(`Jev FPS listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
