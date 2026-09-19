// Jev Lander viewer — a loopback server running a live landing demo. A booster falls out of the sky
// under gravity; Jev (TypeSafe's System One model) reads altitude, vertical speed and fuel every tick
// and picks a throttle (CUT / COAST / HOVER / BURN) to bring it down soft. The agent shapes lander.json
// (the gravity, the fuel budget, the launch height) — crank the gravity up and watch Jev's burns get
// twitchy and the landings start to crash. The physics is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds lander.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Lander',
  description: 'Jev is the flight computer: throttle a booster down to a soft landing.',
  instrument: 'LANDER',
  tickMs: 300, gravity: 1.2, fuel: 260, altitude: 80, safeSpeed: 2.0,
  style: 'The booster is falling under gravity. Bring it down to the pad gently: watch altitude and vertical speed, burn early and hard enough to keep descent in check, and ease off so you touch down soft. A fast touchdown is a crash — go for the gentle landing.',
}

// per-tick vertical acceleration from each throttle setting (minus gravity + drag applied in sim)
const THRUST = { CUT: 0, COAST: 0.4, HOVER: 1.15, BURN: 2.6 }
const ACTIONS = ['CUT', 'COAST', 'HOVER', 'BURN']

function stateBlock(p, s) {
  return `${p.style}
Telemetry (alt above pad, vertical speed, gravity, fuel remaining):
ALT ${s.y.toFixed(1)} VY ${s.v.toFixed(1)} G ${p.gravity.toFixed(2)} FUEL ${(s.fuel / p.fuel * 100).toFixed(0)}%
Which throttle do you set for this tick? ${ACTIONS.join(' / ')}`
}

export async function startLanderViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let error = null
  let clients = new Set()
  let stopped = false
  let salt = 1
  let step = 0
  let running = false
  let state = null // {y, v, fuel}
  let thrust = 'COAST'
  let episode = 0 // bumps each time an episode restarts on its own, so the next one differs
  let finished = null // {ok, ticks, vy, fuelLeft, crashSpeed}
  let history = []    // {step, y, v, action}
  let notified = false

  let p = readCfg(join(workspace, 'lander.json'))

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return { ...DEFAULT, ...raw }  // `altitude` and `startAlt` fall back via DEFAULT
    } catch (e) {
      error = clean(e.message)
      return p || DEFAULT
    }
  }

  function resetState() {
    const y0 = p.altitude ?? p.startAlt ?? DEFAULT.altitude
    const fuel0 = p.fuel ?? DEFAULT.fuel
    state = { y: y0, v: 0, fuel: fuel0 }
    thrust = 'COAST'
    finished = null
    history = []
    notified = false
    step = 0
    error = null
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    const last = history[history.length - 1]
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null,
      summary: error
        ? 'Jev Lander needs a fix'
        : finished
          ? `${p.title} · ${finished.ok ? 'landed soft' : 'crashed at ' + finished.crashSpeed.toFixed(1)} · ${finished.ticks} ticks · ${finished.fuelLeft} fuel left`
          : `${p.title} · alt ${state.y.toFixed(0)} · vy ${state.v.toFixed(1)} · ${history.length} ticks`,
      findings: (error ? [{ severity: 'error', kind: 'lander', message: error }] : []).concat(
        finished
          ? [{ severity: finished.ok ? 'info' : 'error', kind: 'lander', message: finished.ok ? `Jev landed soft after ${finished.ticks} burns` : `Jev crashed at ${finished.crashSpeed.toFixed(1)} after ${finished.ticks} burns` }]
          : []
      ),
      artifact: 'lander.json',
      phases: [
        { id: 'learn', name: 'Watching', state: history.length < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Guiding down', state: history.length >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'land', name: 'Landed', state: finished ? 'active' : 'pending' },
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
      gravity: p.gravity, fuel: p.fuel, safeSpeed: p.safeSpeed,
      y: state?.y, v: state?.v, fuel: state?.fuel, thrust, step, running, error,
      finished, history: history.slice(-200),
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
          thrust: { type: 'choice', instructions: 'Which throttle do you set for this tick?', options: ACTIONS },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const pick = String(res.answers.thrust?.choice || 'COAST')
      thrust = ACTIONS.includes(pick) ? pick : 'COAST'
      // integrate physics with throttle, gravity and drag
      const a = THRUST[thrust] - p.gravity
      state.v += a
      state.v -= Math.sign(state.v) * state.v * state.v * 0.004 // drag self-limits fall
      state.y += state.v
      state.fuel = Math.max(0, state.fuel - THRUST[thrust])
      step++
      history.push({ step, y: state.y, v: state.v, action: thrust })
      if (history.length > 300) history.splice(0, history.length - 300)
      if (state.y <= 0) {
        state.y = 0
        const ok = Math.abs(state.v) <= p.safeSpeed
        finished = { ok, ticks: step, vy: state.v, fuelLeft: Math.round(state.fuel), crashSpeed: Math.abs(state.v) }
        notified = true
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'lander.json'), () => {
    p = readCfg(join(workspace, 'lander.json'))
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, gravity: p.gravity, fuel: p.fuel, safeSpeed: p.safeSpeed, y: state?.y, v: state?.v, fuel: state?.fuel, thrust, step, running, error, finished, history: history.slice(-200) })) }
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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
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
