// Jev Pong viewer — a loopback server running a live paddle-defense demo. A ball ricochets
// around a slim court; Jev (TypeSafe's System One model) decides the paddle's vertical move every
// `pong.stepMs` to keep a rally alive. The agent shapes pong.json (ball speed, paddle authority) —
// turn the speed up and watch Jev chase, wobble and finally drop it. The physics is honest but toy.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds pong.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Pong',
  description: 'Jev is the paddle — keep the rally alive as the ball speeds up.',
  instrument: 'PONG',
  courtW: 200, courtH: 120, paddleH: 26, ballR: 3,
  speed: 6, maxSpeed: 3, accel: 0.5, topSpeed: 14, stepMs: 60,
  style: 'Keep the rally alive. Track the ball, predict where it will cross your wall, and get the paddle there in time. Be decisive.',
}

const MOVES = ['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST']
const MV = { MOVE_UP_FAST: -2, MOVE_UP: -1, HOLD: 0, MOVE_DOWN: 1, MOVE_DOWN_FAST: 2 }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fold a trajectory's y onto the court (bounce off floor/ceiling) at a given travel distance dx.
function bounceY(y0, dy, H, r) {
  const span = H - 2 * r
  let u = (y0 - r + dy) % (2 * span)
  if (u < 0) u += 2 * span
  return u <= span ? u + r : 2 * H - r - u - r + r // reflect off far edge
}

function stateBlock(p, ball, paddleY, speed) {
  const b = ball
  const hardness = Math.max(0, Math.min(1, (speed - 3) / 9))
  const dir = b.vx < 0 ? 'toward you' : 'away'
  return `${p.style}
A paddle on the left wall (centre y ${paddleY.toFixed(1)}, half-height ${(p.paddleH / 2).toFixed(0)}) defends a ${p.courtW}×${p.courtH} court.
ball: x ${b.x.toFixed(1)}  y ${b.y.toFixed(1)}  vx ${b.vx.toFixed(1)}  vy ${b.vy.toFixed(1)}  (${dir})
speed: ${speed.toFixed(1)}   hardness: ${hardness.toFixed(2)}
Move the paddle to meet the ball when it crosses your wall. Be decisive.`
}

function penalty(streak) {
  return streak <= 2 ? ' · Jev keeps dropping it, dial the speed down' : ''
}

export async function startPongViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let p = readCfg(join(workspace, 'pong.json'))
  let rng = mulberry32(90210)
  // court state
  let ball = { x: p.courtW * 0.7, y: p.courtH / 2, vx: -p.speed, vy: (rng() - 0.5) * p.speed }
  let paddleY = p.courtH / 2
  let clients = new Set()
  let stopped = false
  let salt = 1
  let error = null
  let step = 0
  let running = false
  let misses = 0
  let bestRally = 0
  let rally = 0
  let history = []   // per-decision {step, ballY, paddleY, move, conf}
  let lastMove = 'HOLD'
  let lastConf = 0
  let notifiedMiss = false

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
    ball = { x: p.courtW * 0.7, y: p.courtH / 2, vx: -p.speed, vy: (rng() - 0.5) * p.speed }
    paddleY = p.courtH / 2
    misses = 0; bestRally = 0; rally = 0; history = []; notifiedMiss = false; step = 0
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    const state = history.length === 0 ? 'learning' : notifiedMiss ? 'missed' : 'rallying'
    return {
      spec: 1,
      ready: history.length > 0,
      summary: error
        ? 'Jev Pong needs a fix'
        : notifiedMiss
          ? `${p.title} · dropped after ${rally} hits · best ${bestRally} · Jev lost the rally at speed ${p.speed}`
          : `${p.title} · rally ${rally} · best ${bestRally} · Jev defending at speed ${p.speed}`,
      findings: (error ? [{ severity: 'error', kind: 'pong', message: error }] : []).concat(
        notifiedMiss ? [{ severity: 'warn', kind: 'pong', message: `Jev missed the ball at speed ${p.speed} after ${rally} hits — dial the speed down or it keeps dropping it` }] : []
      ),
      artifact: 'pong.json',
      phases: [
        { id: 'learn', name: 'Learning', state: history.length < 5 ? 'active' : 'done' },
        { id: 'rally', name: 'Rallying', state: history.length >= 5 && !notifiedMiss ? 'active' : notifiedMiss ? 'done' : 'pending' },
        { id: 'edge', name: 'At the edge', state: notifiedMiss ? 'active' : 'pending' },
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
      ball, paddleY, speed: p.speed, step, running, error, misses, bestRally, rally, lastMove, lastConf,
      history: history.slice(-240),
    })
  }

  function reset() { resetState(); tail(); if (running) schedule() }
  function pause() { running = false; clearTimeout(timer) }
  function start() { if (!running) { running = true; schedule() } }
  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, p.stepMs) }
  async function run() { if (stopped) return; await decide(); schedule() }

  function integrate() {
    const W = p.courtW, H = p.courtH, r = p.ballR
    // paddle velocity from the last move, integrated before Jev's next read
    const half = p.paddleH / 2
    paddleY += (MV[lastMove] ?? 0) * (p.maxSpeed || 2.4)
    paddleY = Math.max(half, Math.min(H - half, paddleY))
    ball.x += ball.vx
    ball.y += ball.vy
    if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy) }
    if (ball.y > H - r) { ball.y = H - r; ball.vy = -Math.abs(ball.vy) }
    if (ball.x > W - r) { ball.x = W - r; ball.vx = -Math.abs(ball.vx) } // right wall
    // left wall: paddle hit or miss
    if (ball.x <= r) {
      if (Math.abs(ball.y - paddleY) <= half) {
        ball.x = r
        rally++
        if (rally > bestRally) bestRally = rally
        notifiedMiss = false
        // the rally accelerates: each hit speeds the ball up, so a long rally gets harder and harder
        ball.vx = Math.sign(ball.vx) * Math.min(p.speed + (p.accel ?? 0.5) * rally, (p.topSpeed ?? p.speed + 8))
      } else {
        misses++
        notifiedMiss = true
        rally = 0
        // restart far on the right with a fresh-ish aim at the dial speed
        ball = { x: W * 0.75, y: r + rng() * (H - 2 * r), vx: -p.speed, vy: (rng() - 0.5) * p.speed }
        ball.vx = -p.speed
      }
    }
  }

  async function decide() {
    if (stopped) return
    try {
      const res = await evaluate({
        state: stateBlock(p, ball, paddleY, p.speed),
        questions: {
          move: { type: 'choice', instructions: 'Which paddle move keeps the rally alive?', options: MOVES },
          conf: { type: 'noul', instructions: 'Is the ball under control?' },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      lastMove = String(res.answers.move?.choice || 'HOLD')
      lastConf = typeof res.answers.conf?.noul === 'number' ? res.answers.conf.noul : 0.5
      step++
      integrate()
      history.push({ step, ballY: ball.y, paddleY, move: lastMove, conf: lastConf })
      if (history.length > 300) history.splice(0, history.length - 300)
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'pong.json'), () => {
    p = readCfg(join(workspace, 'pong.json'))
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
    if (req.method === 'GET' && url.pathname === '/studio.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.css'))) }
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, ball, paddleY, speed: p.speed, step, running, error, misses, bestRally, rally, lastMove, lastConf, history: history.slice(-240) })) }
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
  const viewer = await startPongViewer({ workspace, port })
  console.log(`Jev Pong listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
