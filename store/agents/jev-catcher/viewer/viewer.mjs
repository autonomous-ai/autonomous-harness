// Jev Catcher viewer — a loopback server running a live fielding demo. A fielder guards the outfield:
// balls pop up at random spots and fall; Jev (TypeSafe's System One model) reads the glove's x and
// the next ball's landing spot every tick and slides the glove to catch it. A ball it isn't under
// drops. The agent shapes catcher.json (how many ticks a ball takes to fall, the glove's reach) —
// speed the falls up and Jev's glove can't keep up and the drops pile up. The field is synthetic;
// the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds catcher.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Catcher',
  description: 'Jev is the fielder — slide the glove and catch every pop fly.',
  instrument: 'CATCHER',
  tickMs: 140, fallTicks: 10, gloveReach: 1.6, fieldWidth: 24, balls: 14,
  style: 'You are the fielder. A ball pops up and falls to a spot on the line — slide the glove to be right under it when it lands. Get there in time and it is an out; miss and it drops. Be decisive, read the landing spot early.',
}

const MOVES = ['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST']
const MV = { LEFT_FAST: -1.2, LEFT: -0.6, HOLD: 0, RIGHT: 0.6, RIGHT_FAST: 1.2 }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

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

function stateBlock(p, s, ball) {
  return `${p.style}
A ball lands at x ${ball.land.toFixed(1)} in ${s.ballTicks} ticks.
glove x ${s.glove.toFixed(1)}   ball lands ${ball.land.toFixed(1)}   in ${s.ballTicks} ticks
Which way do you slide the glove? ${MOVES.join(' / ')}`
}

export async function startCatcherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let error = null
  let clients = new Set()
  let lastLine = null // the last frame sent, replayed to a pane that connects later
  let stopped = false
  let salt = 1
  let step = 0
  let running = false
  let state = null // {glove, ballTicks, balls, next}
  let move = 'HOLD'
  let episode = 0 // bumps each time an episode restarts on its own, so the next one differs
  let finished = null // {ok, ticks, caught, dropped, drops}
  let history = []    // {step, glove, move, caught, dropped}
  let notified = false
  let rng

  let lastCfg = null
  let p = readCfg(join(workspace, 'catcher.json'))

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const merged = { ...DEFAULT, ...raw }
      if (!lastCfg || merged.fallTicks !== lastCfg.fallTicks || merged.fieldWidth !== lastCfg.fieldWidth || merged.balls !== lastCfg.balls || !state) {
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
    rng = mulberry32(5039 + episode * 97)
    const W = cfg.fieldWidth ?? DEFAULT.fieldWidth
    state = { glove: W / 2, ballTicks: cfg.fallTicks ?? DEFAULT.fallTicks, balls: makeBalls(cfg.balls ?? DEFAULT.balls, W, rng), next: 0, catches: 0, drops: 0 }
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
    lastLine = line
    for (const c of clients) c.write(line)
  }

  function verdict() {
    return {
      spec: 1,
      ready: history.length > 0 || finished !== null,
      summary: error
        ? 'Jev Catcher needs a fix'
        : finished
          ? `${p.title} · ${finished.ok ? 'clean session, ' + finished.caught + ' caught' : finished.caught + ' caught, ' + finished.dropped + ' dropped'}`
          : `${p.title} · ball ${Math.min(state.next + 1, state.balls.length)}/${state.balls.length} · ${state.catches} caught · ${state.drops} dropped`,
      findings: (error ? [{ severity: 'error', kind: 'catcher', message: error }] : []).concat(
        finished
          ? [{ severity: finished.ok ? 'info' : 'error', kind: 'catcher', message: finished.ok ? `Jev caught all ${finished.caught} pop flies` : `Jev dropped ${finished.dropped} of ${finished.caught + finished.dropped}` }]
          : []
      ),
      artifact: 'catcher.json',
      phases: [
        { id: 'learn', name: 'Reading', state: history.length < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Fielding', state: history.length >= 5 && !finished ? 'active' : finished ? 'done' : 'pending' },
        { id: 'finish', name: 'Session done', state: finished ? 'active' : 'pending' },
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
      fallTicks: p.fallTicks, fieldWidth: p.fieldWidth, gloveReach: p.gloveReach,
      glove: state?.glove, move, step, running, error, finished,
      balls: state?.balls, next: state?.next, catches: state?.catches, drops: state?.drops, ballTicks: state?.ballTicks,
      history: history.slice(-300),
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
      const ball = state.balls[state.next]
      const res = await evaluate({
        state: stateBlock(p, state, ball),
        questions: {
          move: { type: 'choice', instructions: 'Which way do you slide the glove this tick?', options: MOVES },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const pick = String(res.answers.move?.choice || 'HOLD')
      move = MOVES.includes(pick) ? pick : 'HOLD'
      // physics: slide and let the ball fall one tick closer
      state.glove = clamp(state.glove + MV[move], 1, p.fieldWidth - 1)
      state.ballTicks--
      step++
      history.push({ step, glove: state.glove, move, in: state.ballTicks })
      if (history.length > 400) history.splice(0, history.length - 400)
      if (state.ballTicks <= 0) {
        // ball lands: glove must be under it (within reach)
        if (Math.abs(state.glove - ball.land) <= p.gloveReach) {
          ball.caught = true; ball.done = true; state.catches++
        } else {
          ball.done = true; state.drops++
        }
        state.next++
        if (state.next < state.balls.length) {
          state.ballTicks = p.fallTicks
        } else {
          finished = { ok: state.drops === 0, ticks: step, caught: state.catches, dropped: state.drops }
          notified = true
        }
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'catcher.json'), () => {
    p = readCfg(join(workspace, 'catcher.json'))
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, fallTicks: p.fallTicks, fieldWidth: p.fieldWidth, gloveReach: p.gloveReach, glove: state?.glove, move, step, running, error, finished, balls: state?.balls, next: state?.next, catches: state?.catches, drops: state?.drops, ballTicks: state?.ballTicks, history: history.slice(-300) })) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      if (lastLine) res.write(lastLine)
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
  const viewer = await startCatcherViewer({ workspace, port })
  console.log(`Jev Catcher listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
