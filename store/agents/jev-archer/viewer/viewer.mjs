// Jev Archer viewer — a loopback server running a live archery demo. A target slides across a line
// and Jev (TypeSafe's System One model) reads its position and the aim point every tick and nudges
// the aim to track it, releasing an arrow each window. The arrow flies to where the aim is when it
// releases — a fast, drifting target makes the arrow land off-center and miss. The agent shapes
// archer.json (how fast the target slides, the bullseye size) — crank the target speed up and Jev's
// aim trails and the misses pile up. The range is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds archer.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Archer',
  description: 'Jev is the archer — track the sliding target and plant every arrow in the bullseye.',
  instrument: 'ARCHER',
  tickMs: 150, speed: 0.6, bullHalf: 1.0, targetWidth: 24, shots: 16,
  style: 'You are the archer. A target slides across the line — read its position and nudge your aim to track it, then release. Land the arrow in the bullseye to score; miss and it flies by. Keep your aim glued to the moving target.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const AIM = { LEFT_FAST: -1.6, LEFT: -0.8, HOLD: 0, RIGHT: 0.8, RIGHT_FAST: 1.6 }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function stateBlock(p, s) {
  return `${p.style}
Aim is at x ${s.aim.toFixed(1)}; the target is at x ${s.target.toFixed(1)} (speed ${p.speed.toFixed(2)}), releasing in ${s.fuse} ticks.
aim x ${s.aim.toFixed(1)}   target x ${s.target.toFixed(1)}   in ${s.fuse} ticks
Which way do you nudge the aim? ${MOVES.join(' / ')}`
}

export async function startArcherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let error = null
  let clients = new Set()
  let stopped = false
  let salt = 1
  let step = 0
  let running = false
  let state = null // {aim, target, dir, fuse, hits, misses}
  let move = 'HOLD'
  let finished = null // {ok, ticks, hits, misses}
  let history = []    // {step, aim, move}
  let notified = false
  let lastHit = null  // result of the most recent released arrow (true/false)
  let rng
  let _fuse = 6       // declared BEFORE the first readCfg/resetStateNow below (TDZ guard)

  let lastCfg = null
  let p = readCfg(join(workspace, 'archer.json'))

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const merged = { ...DEFAULT, ...raw }
      if (!lastCfg || merged.speed !== lastCfg.speed || merged.targetWidth !== lastCfg.targetWidth || merged.shots !== lastCfg.shots || merged.bullHalf !== lastCfg.bullHalf || !state) {
        resetStateNow(merged)
      }
      lastCfg = merged
      return merged
    } catch (e) {
      error = clean(e.message)
      return lastCfg || DEFAULT
    }
  }

  function resetStateNow(cfg) {
    rng = mulberry32(8817)
    const W = cfg.targetWidth ?? DEFAULT.targetWidth
    const FUSE = 6
    state = { aim: W / 2, target: W / 2, dir: rng() < 0.5 ? 1 : -1, fuse: FUSE, hits: 0, misses: 0 }
    _fuse = FUSE
    move = 'HOLD'
    finished = null
    history = []
    notified = false
    step = 0
    error = null
  }
  function resetState() { resetStateNow(p) }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null,
      summary: error
        ? 'Jev Archer needs a fix'
        : finished
          ? `${p.title} · ${finished.ok ? 'clean day, ' + finished.hits + ' bullseyes' : finished.hits + ' bullseyes, ' + finished.misses + ' missed'}`
          : `${p.title} · arrow ${Math.min(Math.floor((step + 1) / _fuse), p.shots) + 1}/${p.shots} · ${state.hits} bullseyes · ${state.misses} missed`,
      findings: (error ? [{ severity: 'error', kind: 'archer', message: error }] : []).concat(
        finished
          ? [{ severity: finished.ok ? 'info' : 'error', kind: 'archer', message: finished.ok ? `Jev sank ${finished.hits} of ${finished.hits + finished.misses} bullseyes` : `Jev missed ${finished.misses} of ${finished.hits + finished.misses} shots` }]
          : []
      ),
      artifact: 'archer.json',
      phases: [
        { id: 'learn', name: 'Reading', state: history.length < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Aiming', state: history.length >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Range done', state: finished ? 'active' : 'pending' },
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
      speed: p.speed, targetWidth: p.targetWidth, bullHalf: p.bullHalf,
      aim: state?.aim, target: state?.target, dir: state?.dir, fuse: state?.fuse,
      move, step, running, error, finished, lastHit,
      hits: state?.hits, misses: state?.misses, history: history.slice(-300),
    })
  }

  function reset() { resetState(); tail(); if (running) schedule() }
  function pause() { running = false; clearTimeout(timer) }
  function start() { if (!running) { running = true; schedule() } }
  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, p.tickMs) }
  async function run() {
    if (stopped) return
    if (finished) { tail(); schedule(); return }
    await decide()
    schedule()
  }

  async function decide() {
    if (stopped) return
    try {
      const res = await evaluate({
        state: stateBlock(p, state),
        questions: {
          aim: { type: 'choice', instructions: 'Which way do you nudge the aim this tick?', options: MOVES },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const pick = String(res.answers.aim?.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      // physics: nudge the aim, slide the target one tick, count down the fuse
      const W = p.targetWidth ?? DEFAULT.targetWidth
      state.aim = clamp(state.aim + AIM[move], 1, W - 1)
      state.target = clamp(state.target + state.dir * (p.speed ?? DEFAULT.speed), 1, W - 1)
      if (state.target <= 1.2) state.dir = 1
      else if (state.target >= W - 1.2) state.dir = -1
      state.fuse--
      step++
      history.push({ step, aim: state.aim, move })
      if (history.length > 400) history.splice(0, history.length - 400)
      if (state.fuse <= 0) {
        // arrow releases: flies to where the aim currently tracks; bullseye if it lands on the target
        lastHit = Math.abs(state.aim - state.target) <= (p.bullHalf ?? DEFAULT.bullHalf)
        if (lastHit) state.hits++
        else state.misses++
        state.fuse = _fuse
        state.dir = rng() < 0.5 ? 1 : -1
        if (state.hits + state.misses >= (p.shots ?? DEFAULT.shots)) {
          finished = { ok: state.misses === 0, ticks: step, hits: state.hits, misses: state.misses }
          notified = true
        }
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'archer.json'), () => {
    p = readCfg(join(workspace, 'archer.json'))
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, speed: p.speed, targetWidth: p.targetWidth, bullHalf: p.bullHalf, aim: state?.aim, target: state?.target, dir: state?.dir, fuse: state?.fuse, move, step, running, error, finished, hits: state?.hits, misses: state?.misses, history: history.slice(-300) })) }
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
  const viewer = await startArcherViewer({ workspace, port })
  console.log(`Jev Archer listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
