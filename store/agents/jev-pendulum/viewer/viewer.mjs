// Jev Pendulum viewer — a loopback server running a live balancing demo. A stiff rod stands on a
// pivot and Jev (TypeSafe's System One model) decides the corrective torque every `pendulum.stepMs`
// to keep it upright. The agent shapes pendulum.json (gravity, torque authority, gust strength) —
// turn it up and watch Jev go from steady to scrambling. The physics is honest but simulated.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds pendulum.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'The Balance Rod',
  description: 'Jev keeps a stiff rod upright on a pivot — a live balancing act.',
  instrument: 'ROD',
  gravity: 7, length: 1.0, damping: 0.5, maxTorque: 0.8,
  stepMs: 80, gustEvery: 10, gustStrength: 0.5, fallDeg: 60,
  style: 'Keep the rod upright. Correct every lean immediately, shrink the swing, and never let it drift past the edge. You are a fast, steady balancer.',
}

const ORDER = ['LEFT_HARD', 'LEFT', 'CENTER', 'RIGHT', 'RIGHT_HARD']
const TQ = { LEFT_HARD: -1, LEFT: -0.5, CENTER: 0, RIGHT: 0.5, RIGHT_HARD: 1 }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stateBlock(p, angle, vel) {
  const deg = (angle * 180) / Math.PI
  const hardness = Math.max(0, Math.min(1, ((p.gravity || 7) - 4) / 6))
  return `${p.style}
A stiff rod of length ${p.length} stands on a pivot. You apply a torque every tick to keep it upright.
angle: ${deg.toFixed(1)}°  velocity: ${vel.toFixed(2)} rad/s   (falls at ±${p.fallDeg}°)
hardness: ${hardness.toFixed(2)}
Choose the torque that corrects the lean and steadies the rod. Be decisive.`
}

export async function startPendulumViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let p = readCfg(join(workspace, 'pendulum.json'))
  let rng = mulberry32(303)
  // physical state
  let angle = 0, vel = 0
  let clients = new Set()
  let stopped = false
  let salt = 1
  let error = null
  let step = 0
  let running = false
  let falls = 0
  let bestRun = 0
  let thisRun = 0
  let history = []   // per-decision samples of |angle| in degrees, capped
  let lastAction = 'CENTER'
  let lastConf = 0
  let notifiedFall = false

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return { ...DEFAULT, ...raw }
    } catch (e) {
      error = clean(e.message)
      return DEFAULT
    }
  }

  function resetState() {
    angle = (rng() - 0.5) * 0.12
    vel = (rng() - 0.5) * 0.4
    falls = 0
    bestRun = 0
    thisRun = 0
    history = []
    notifiedFall = false
    step = 0
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    const minutes = (bestRun * p.stepMs / 1000 / 60)
    const state = history.length === 0 ? 'learning' : notifiedFall ? 'fell' : 'balancing'
    return {
      spec: 1,
      ready: history.length > 0,
      summary: error
        ? 'Jev Pendulum needs a fix'
        : notifiedFall
          ? `${p.title || 'Balance Rod'} · fell after ${thisRun} ticks · best ${minutes.toFixed(1)} min · Jev lost its balance at gravity ${p.gravity}`
          : `${p.title || 'Balance Rod'} · balancing · ${Math.round((angle * 180) / Math.PI)}° tilt · best ${minutes.toFixed(1)} min`,
      findings: (error ? [{ severity: 'error', kind: 'pendulum', message: error }] : []).concat(
        notifiedFall ? [{ severity: 'warn', kind: 'pendulum', message: `Jev fell at gravity ${p.gravity} after ${thisRun} ticks — dial gravity down or it keeps losing it` }] : []
      ),
      artifact: 'pendulum.json',
      phases: [
        { id: 'learn', name: 'Learning', state: history.length < 5 ? 'active' : 'done' },
        { id: 'balance', name: 'Balancing', state: history.length >= 5 && !notifiedFall ? 'active' : notifiedFall ? 'done' : 'pending' },
        { id: 'marginal', name: 'At the edge', state: notifiedFall ? 'active' : 'pending' },
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
      angle: (angle * 180) / Math.PI, vel, step, running, error,
      falls, bestRun, thisRun, lastAction, lastConf,
      history: history.slice(-240),
    })
  }

  async function decide() {
    if (stopped) return
    try {
      // A gust kicks the rod every gustEvery decisions — Jev must recover before the next.
      if (step > 0 && p.gustEvery > 0 && step % p.gustEvery === 0) {
        vel += p.gustStrength * (rng() < 0.5 ? -1 : 1)
        notifiedFall = false
      }
      const res = await evaluate({
        state: stateBlock(p, angle, vel),
        questions: {
          action: { type: 'choice', instructions: 'Which torque steadies the rod right now?', options: ORDER },
          conf: { type: 'noul', instructions: 'Is the rod under control?' },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      lastAction = String(res.answers.action?.choice || 'CENTER')
      lastConf = typeof res.answers.conf?.noul === 'number' ? res.answers.conf.noul : 0.5
      const tau = (TQ[lastAction] ?? 0) * (p.maxTorque || 2.0)

      // Integrate the rod for one decision interval.
      const I = (p.length || 1.0) ** 2
      const GT = (3 * (p.gravity || 7)) / 2
      const c = p.damping || 0.5
      const dt = 0.01
      const nSub = Math.max(1, Math.round((p.stepMs || 80) / 10))
      for (let s = 0; s < nSub; s++) {
        const acc = GT * Math.sin(angle) + (3 * tau) / I - c * vel
        vel += acc * dt
        angle += vel * dt
      }
      step++
      thisRun++
      if (bestRun < thisRun) bestRun = thisRun

      const absDeg = Math.abs(angle) * 180 / Math.PI
      history.push({ step, deg: absDeg, action: lastAction, conf: lastConf })
      if (history.length > 300) history.splice(0, history.length - 300)

      if (absDeg > (p.fallDeg || 60)) {
        falls++
        notifiedFall = true
        thisRun = 0
        // put it back near vertical, with a fresh small tilt
        angle = (rng() - 0.5) * 0.1
        vel = 0
        step++ // count the fall tick
      } else if (notifiedFall) {
        notifiedFall = false
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, p.stepMs) }
  async function run() { if (stopped) return; await decide(); schedule() }
  function start() { if (!running) { running = true; schedule() } }
  function pause() { running = false; clearTimeout(timer) }
  function reset() { resetState(); tail(); if (running) schedule() }

  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'pendulum.json') {
      p = readCfg(join(workspace, 'pendulum.json'))
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, angle: (angle * 180) / Math.PI, vel, step, running, error, falls, bestRun, thisRun, lastAction, lastConf, history: history.slice(-240) })) }
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
  const viewer = await startPendulumViewer({ workspace, port })
  console.log(`Jev Pendulum listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
