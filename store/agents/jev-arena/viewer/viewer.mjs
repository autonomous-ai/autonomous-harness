// Jev Arena viewer — a loopback server that renders a live grid game where Jev (TypeSafe's System One
// model) is the brain. The agent designs the world (nodes, goals, walls, rules) as JSON; this server
// runs the game loop and calls Jev at a tunable cadence to pick the next move. Every decision's
// probability distribution and confidence streams to the pane over SSE, so the user *watches Jev
// think* — the decisions are the experience.
//
// Harness runs this for the life of the agent's pane with:
//   HARNESS_VIEWER_PORT   loopback port
//   HARNESS_WORKSPACE     the workspace folder (the agent's cwd)
//   HARNESS_DSH_DIR       this install dir
//
// The workspace holds arena.json (the world + rules). The viewer watches it; the agent edits it and
// the game adapts live. No external runtime dependencies.

import { createServer } from 'node:http'
import { watch, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 3000)

const DEFAULT_WORLD = {
  title: 'Jev Arena',
  description: 'A tiny grid world where Jev decides each move.',
  size: 12,
  hero: { x: 1, y: 1, emoji: '🤖', label: 'Jev' },
  goal: { x: 10, y: 10, emoji: '⭐', label: 'goal' },
  walls: [],
  coins: [{ x: 6, y: 6, emoji: '🪙', value: 1 }],
  rules: 'Reach the goal in as few steps as possible. Move one cell at a time (up/down/left/right).',
  speed: 300, // ms per decision
  movesPerStep: 1,
}

const ACTIONS = ['up', 'down', 'left', 'right', 'wait']

function stateBlock(world, hero) {
  // Build the state text Jev reads: the world grid, the hero, remaining coins, known obstacles.
  const { size, walls, coins, goal, rules } = world
  const grid = Array.from({ length: size }, () => Array(size).fill('.'))
  const isWall = (x, y) => walls.some((w) => w.x === x && w.y === y)
  for (const w of walls) if (inBounds(w, size)) grid[w.y] && (grid[w.y][w.x] = '#')
  const remaining = coins.filter((c) => inBounds(c, size) && !(c.x === hero.x && c.y === hero.y))
  for (const c of remaining) grid[c.y][c.x] = '$'
  if (inBounds(goal, size)) grid[goal.y][goal.x] = 'G'
  grid[hero.y] = grid[hero.y] || []
  grid[hero.y][hero.x] = '@'
  const rows = grid.map((r) => r.join('')).join('\n')
  const distToGoal = Math.abs(hero.x - goal.x) + Math.abs(hero.y - goal.y)
  return `You are the @ on this grid. # is a wall, $ is a coin, G is the goal.\n${rows}\n\nPosition: (${hero.x},${hero.y}). Goal: (${goal.x},${goal.y}). Manhattan distance to goal: ${distToGoal}. Coins remaining to collect: ${remaining.length}. Obstacles are impassable; collect coins and reach G.`
}

function inBounds(pos, size) {
  return pos && pos.x >= 0 && pos.y >= 0 && pos.x < size && pos.y < size
}

function moveLegal(world, pos, action) {
  const { size, walls } = world
  let [x, y] = [pos.x, pos.y]
  if (action === 'up') y -= 1
  else if (action === 'down') y += 1
  else if (action === 'left') x -= 1
  else if (action === 'right') x += 1
  else return { x, y, legal: true } // wait
  const blocked = x < 0 || y < 0 || x >= size || y >= size || walls.some((w) => w.x === x && w.y === y)
  return { x, y, legal: !blocked }
}

async function decide(world, hero, salt) {
  const questions = {
    move: {
      type: 'choice',
      instructions: 'Choose the best next move to reach the goal (collect coins first), without walking into walls.',
      options: ACTIONS,
    },
    confidence_full: {
      type: 'noul',
      instructions: 'Is the selected move clearly the best choice, with high certainty?',
    },
  }
  // Pass obstacles/awareness to state. The mock and live model both read the state.
  try {
    const res = await evaluate({
      state: stateBlock(world, hero),
      questions,
      salt,
      model: process.env.JEV_MODEL || 'jev-latest',
    })
    const moveAns = res.answers.move || {}
    const probs = moveAns.probabilities || {}
    const best = moveAns.choice || pickBestByProbs(probs)
    return {
      action: best,
      probabilities: probs,
      confidence: moveAns.confidence ?? Math.max(...Object.values(probs), 0),
      client: res.client,
      model: res.model,
    }
  } catch (err) {
    return { action: 'wait', probabilities: {}, confidence: 0, error: clean(err.message), client: 'error' }
  }
}

function pickBestByProbs(probs) {
  let best = 'wait', bestP = -1
  for (const [a, p] of Object.entries(probs)) if (p > bestP) { best = a; bestP = p }
  return best
}

function verdict(world, state) {
  const ready = state.error ? false : state.moves > 0
  return {
    spec: 1,
    ready,
    summary: state.error
      ? 'Arena needs a fix'
      : `${world.title} · Jev has made ${state.moves} decisions · reached goal ${state.reachedGoal ? 'yes' : 'not yet'}`,
    findings: state.error ? [{ severity: 'error', kind: 'arena', message: state.error }] : [],
    artifact: 'arena.json',
    phases: [
      { id: 'world', name: 'World', state: state.reachedGoal ? 'done' : 'active' },
      { id: 'play', name: 'Play', state: state.reachedGoal ? 'done' : 'pending' },
    ],
    updatedAt: new Date().toISOString(),
  }
}

export async function startArenaViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let world = readWorld(join(workspace, 'arena.json'))
  let hero = { ...world.hero }
  let state = { moves: 0, reachedGoal: false, coinsCollected: 0, error: null, running: false }
  let clients = new Set()
  let stopped = false
  const decisionLog = []
  let salt = 1

  function readWorld(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return { ...DEFAULT_WORLD, ...raw }
    } catch {
      return DEFAULT_WORLD
    }
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function tail() {
    const gameOver = state.reachedGoal
    state.running = !gameOver && !stopped
    const summary = { title: world.title, description: world.description, hero, goal: world.goal, walls: world.walls, coins: world.coins, size: world.size, rules: world.rules, speed: world.speed }
    broadcast({ type: 'frame', moves: state.moves, reachedGoal: state.reachedGoal, coinsCollected: state.coinsCollected, gameOver, running: state.running, hero, coins: world.coins, goal: world.goal, walls: world.walls, size: world.size, decisionLog: decisionLog.slice(-20), speed: world.speed, model: state.model, client: state.client })
    // write verdict
    const v = verdict(world, state)
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    void summary
  }

  async function step() {
    if (stopped || state.reachedGoal) return
    // Ask Jev for the next move.
    const d = await decide(world, hero, salt++)
    state.model = d.model
    state.client = d.client
    if (d.error) { state.error = d.error; tail(); return }
    // Apply the move.
    const mv = moveLegal(world, hero, d.action)
    if (mv.legal) {
      hero = { x: mv.x, y: mv.y }
      // Collect coins.
      const coinAt = world.coins.findIndex((c) => c.x === hero.x && c.y === hero.y)
      if (coinAt >= 0) { world.coins.splice(coinAt, 1); state.coinsCollected++ }
      // Reached goal?
      if (hero.x === world.goal.x && hero.y === world.goal.y) state.reachedGoal = true
    }
    state.moves++
    if (state.moves > 4 && !state.reachedGoal) {
      // Safety: Jev shouldn't be stuck. Let the world know via the panel, but keep moving.
    }
    decisionLog.push({ move: d.action, probabilities: d.probabilities, confidence: d.confidence, at: state.moves, hero: { ...hero } })
    if (decisionLog.length > 200) decisionLog.splice(0, decisionLog.length - 200)
    tail()
  }

  let timer = null
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(run, Math.max(60, Number(world.speed) || 300))
  }
  async function run() {
    if (stopped) return
    await step()
    if (!state.reachedGoal) schedule()
  }

  function start() {
    if (state.reachedGoal) return
    schedule()
  }
  function pause() {
    clearTimeout(timer)
  }
  function reset() {
    state = { moves: 0, reachedGoal: false, coinsCollected: 0, error: null, running: false }
    hero = { ...world.hero }
    // restore coins from world (we mutate world.coins in place; keep a pristine copy)
    world = readWorld(join(workspace, 'arena.json'))
    // re-read resets coins to the file. good.
    hero = { ...world.hero }
    decisionLog.length = 0
    salt = 1
    tail()
    if (state.running) schedule()
  }

  // Watch the workspace for world edits.
  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    name = String(name).split('/').join('/')
    if (name === 'arena.json') {
      const got = readWorld(join(workspace, 'arena.json'))
      const changed = JSON.stringify(got.size) !== JSON.stringify(world.size) ||
        JSON.stringify(got.goal) !== JSON.stringify(world.goal) ||
        JSON.stringify(got.walls) !== JSON.stringify(world.walls) ||
        JSON.stringify(got.hero) !== JSON.stringify(world.hero)
      world = got
      // Keep existing coins only if the file didn't redefine them; re-read does.
      if (changed) { /* keep world as read; reset hero if it moved? leave */ }
      tail()
      schedule()
    }
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(HERE, 'index.html')))
    }
    if (req.method === 'GET' && url.pathname === '/studio.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(readFileSync(join(HERE, 'studio.js')))
    }
    if (req.method === 'GET' && url.pathname === '/studio.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      return res.end(readFileSync(join(HERE, 'studio.css')))
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ world, state, decisionLog: decisionLog.slice(-20) }))
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      res.write(`event: state\ndata: ${JSON.stringify({ type: 'frame', moves: state.moves, reachedGoal: state.reachedGoal, running: state.running, hero, coins: world.coins, goal: world.goal, walls: world.walls, size: world.size, decisionLog: decisionLog.slice(-20), speed: world.speed, model: state.model, client: state.client })}\n\n`)
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
      if (cmd === 'step') await step()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404)
    res.end('Not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  tail()
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true
      clearTimeout(timer)
      watcher.close()
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
  const viewer = await startArenaViewer({ workspace, port })
  console.log(`Jev Arena listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
