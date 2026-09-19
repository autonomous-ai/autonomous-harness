// Jev Duel viewer — a loopback server running a live Reversi battle where Jev (TypeSafe's System
// One model) plays BOTH sides and a third Jev referees. The agent shapes battle.json (board size,
// the two rivals' names and "personalities" rendered as state-flavor, referee focus). The viewer
// runs the game loop, asks each side to choose a move, applies the flips, asks the referee to judge
// every move, and streams it all to the pane over SSE.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. The workspace holds battle.json which the
// viewer watches (live edit of rivals/personality reframes both Jevs).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]

// Fresh 6x6 board with Othello's starting four disks (O in the upper-left diagonal of the center).
function newBoard(n) {
  const b = Array.from({ length: n }, () => Array(n).fill('.'))
  const h = n / 2
  b[h - 1][h - 1] = 'O'; b[h - 1][h] = 'X'; b[h][h - 1] = 'X'; b[h][h] = 'O'
  return b
}

function clone(b) { return b.map((r) => r.slice()) }

function legalMoves(b, me) {
  const n = b.length
  const them = me === 'O' ? 'X' : 'O'
  const out = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (b[y][x] !== '.') continue
    let flips = 0
    for (const [dx, dy] of DIRS) {
      let nx = x + dx, ny = y + dy, c = 0
      while (nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === them) { c++; nx += dx; ny += dy }
      if (c > 0 && nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === me) flips += c
    }
    if (flips > 0) out.push({ x, y, flips })
  }
  return out
}

function applyMove(b, x, y, me) {
  const n = b.length
  const them = me === 'O' ? 'X' : 'O'
  b[y][x] = me
  for (const [dx, dy] of DIRS) {
    let nx = x + dx, ny = y + dy, chain = []
    while (nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === them) { chain.push([nx, ny]); nx += dx; ny += dy }
    if (chain.length && nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === me) {
      for (const [cx, cy] of chain) b[cy][cx] = me
    }
  }
}

function count(b) {
  let o = 0, x = 0
  for (const r of b) for (const c of r) { if (c === 'O') o++; else if (c === 'X') x++ }
  return { O: o, X: x }
}

function boardText(b, me) {
  // Rendered as a plain grid the mock's Reversi reader parses; the "you play O/X" line names the
  // side Jev is being asked to move for.
  let s = `you play ${me}\n`
  s += b.map((r) => r.join('')).join('\n')
  s += '\n'
  return s
}

function stateBlock(battle, board, side, love) {
  return `Two rivals are playing a live game of Reversi (Othello) on a ${battle.size}x${battle.size} board.
You are ${side.name}, playing ${side.disk}. ${side.personality}
Your rival is ${side.rival}, playing ${side.rivalDisk}. ${battle.rivals[side.rival]?.personality || ''}

The board, '.' empty, O and X are claimed disks:
${boardText(board, side.disk)}

Legal moves and the disks each flips:
${love.map((m) => `  ${m.x},${m.y} flips ${m.flips}`).join('\n')}

Current score — O: ${count(board).O}, X: ${count(board).X}.

Choose the move that best serves your personality and wins the game. Prefer corners. Never play a legal-move
coordinate that isn't listed.`
}

function refState(battle, board, move, side) {
  const c = count(board)
  return `You are the referee of a live Reversi battle between ${battle.rivals.O.name} (O) and ${battle.rivals.X.name} (X).

Board just after ${side.name} (${side.disk}) played ${move.x},${move.y} (flipping ${move.flips} disks):
${boardText(board, 'O')}

Score — O: ${c.O}, X: ${c.X}.

Referee focus: ${battle.referee}`

}

function verdict(battle, c, filled, gameOver, winner, state) {
  const leader = c.O === c.X ? 'tied' : (c.O > c.X ? `${battle.rivals.O.name} leads` : `${battle.rivals.X.name} leads`)
  const total = c.O + c.X
  return {
    spec: 1,
    ready: true,
    summary: state.error
      ? 'Duel needs a fix'
      : gameOver
        ? `${winner ?? 'Draw'} — final ${c.O}–${c.X}`
        : `${battle.rivals.O.name} (O) vs ${battle.rivals.X.name} (X) — ${leader} ${c.O}–${c.X}`,
    findings: state.error ? [{ severity: 'error', kind: 'duel', message: state.error }] : [],
    artifact: 'battle.json',
    phases: [
      { id: 'open', name: 'Opening', state: total <= 12 ? 'active' : 'done' },
      { id: 'midgame', name: 'Midgame', state: total > 12 && !gameOver ? 'active' : total > 12 ? 'done' : 'pending' },
      { id: 'endgame', name: 'Endgame', state: gameOver ? 'done' : total >= filled * 0.8 ? 'active' : 'pending' },
    ],
    updatedAt: new Date().toISOString(),
  }
}

export async function startDuelViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let battle = readBattle(join(workspace, 'battle.json'))
  let board = newBoard(battle.size)
  let toMove = 'O'
  let clients = new Set()
  let lastLine = null // the last frame sent, replayed to a pane that connects later
  let stopped = false
  let salt = 1
  let running = false
  let gameOver = false
  let gameOverAt = 0 // when the last game ended; a new one starts by itself a few seconds later
  let winner = null
  let error = null
  let history = []   // [{n, side, disk, x, y, flips, ref:[...], at}]
  let moveCount = 0

  function readBattle(file) {
    try {
      return { ...DEFAULT_BATTLE, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      return DEFAULT_BATTLE
    }
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    lastLine = line
    for (const c of clients) c.write(line)
  }

  function tail() {
    const c = count(board)
    const v = verdict(battle, c, board.length * board.length, gameOver, winner, { error })
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'frame',
      title: battle.title,
      description: battle.description,
      size: battle.size,
      board,
      toMove,
      counts: c,
      running,
      gameOver,
      winner,
      error,
      rivals: battle.rivals,
      refereeFocus: battle.referee,
      history: history.slice(-30),
      moveCount,
    })
  }

  async function askSide(side) {
    const love = legalMoves(board, side.disk)
    if (!love.length) return null
    const res = await evaluate({
      state: stateBlock(battle, board, side, love),
      questions: {
        move: {
          type: 'choice',
          instructions: 'Choose the strongest Reversi move for your side, as a "x,y" coordinate.',
          options: love.map((m) => `${m.x},${m.y}`),
        },
        confident: {
          type: 'noul',
          instructions: 'Is this a move you feel confident about, or a defensively forced one?',
        },
      },
      salt: salt++,
      model: process.env.JEV_MODEL || 'jev-latest',
    })
    const picked = res.answers.move?.choice
    const chosen = love.find((m) => `${m.x},${m.y}` === String(picked)) || love[0]
    return { ...chosen, confidence: res.answers.confident?.noul ?? 0.5, client: res.client, model: res.model, probs: res.answers.move?.probabilities }
  }

  async function referee(move, side) {
    const res = await evaluate({
      state: refState(battle, board, move, side),
      questions: {
        strong: {
          type: 'score',
          instructions: 'How strong was this move tactically?',
          legend: { 0: 'blunder', 1: 'solid', 2: 'brilliant' },
        },
        aggressive: {
          type: 'noul',
          instructions: 'Was this an aggressive, material-taking move or a quiet positional one?',
        },
        decided: {
          type: 'score',
          instructions: 'How decided is the game right now for the side that just moved?',
          legend: { 0: 'wide open', 1: 'leaning', 2: 'decided' },
        },
      },
      salt: salt++,
      model: process.env.JEV_MODEL || 'jev-latest',
    })
    const a = res.answers
    return {
      strong: typeof a.strong?.score === 'number' ? a.strong.score : 1,
      aggressive: a.aggressive?.noul ?? 0.5,
      decided: typeof a.decided?.score === 'number' ? a.decided.score : 0,
    }
  }

  async function step() {
    if (stopped || gameOver) return
    try {
      const side = { disk: toMove, name: battle.rivals[toMove]?.name || toMove, personality: battle.rivals[toMove]?.personality || '', rival: toMove === 'O' ? 'X' : 'O', rivalDisk: toMove === 'O' ? 'X' : 'O' }
      const move = await askSide(side)
      if (move) {
        applyMove(board, move.x, move.y, side.disk)
        moveCount++
        const ref = await referee(move, side)
        history.push({ n: moveCount, side: side.name, disk: side.disk, x: move.x, y: move.y, flips: move.flips, ref, at: new Date().toISOString() })
        if (history.length > 200) history.splice(0, history.length - 200)
      }
      // Pass if no legal move; game over when neither side can move.
      const next = toMove === 'O' ? 'X' : 'O'
      if (!legalMoves(board, next).length) {
        if (!legalMoves(board, toMove).length) {
          const c = count(board)
          if (c.O !== c.X) winner = c.O > c.X ? battle.rivals.O?.name || 'O' : battle.rivals.X?.name || 'X'
          gameOver = true
          gameOverAt = Date.now()
        }
        // else: stick (both effectively stalled but next side has no move -> keep current side) — handled by loop guard
      } else {
        toMove = next
      }
      error = null
    } catch (e) {
      error = clean(e.message)
    }
    tail()
  }

  let timer = null
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(run, battle.speed ?? 700)
  }
  async function run() {
    if (stopped) return
    // Never sit on a finished board: show the result for a few seconds, then play again.
    if (gameOver) { if (Date.now() - gameOverAt > 5000) reset(); else schedule(); return }
    await step()
    schedule()
  }
  function start() { if (!running) { running = true; schedule() } }
  function pause() { running = false; clearTimeout(timer) }
  function reset() {
    board = newBoard(battle.size); toMove = 'O'; gameOver = false; winner = null; history = []; moveCount = 0; salt += 10; error = null
    tail()
    if (running) schedule()
  }

  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'battle.json') {
      battle = readBattle(join(workspace, 'battle.json'))
      if (battle.size !== board.length) { board = newBoard(battle.size); toMove = 'O'; moveCount = 0; history = [] }
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: battle.title, size: battle.size, board, toMove, counts: count(board), running, gameOver, winner, history: history.slice(-30), rivals: battle.rivals })) }
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
      if (cmd === 'step') await step()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  tail()
  start()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; clearTimeout(timer); watcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
  }
}

// The default battle is used when battle.json is absent; the workspace template ships the real one.
const DEFAULT_BATTLE = {
  title: 'Jev vs Jev',
  description: 'A Reversi duel between two minds.',
  size: 6,
  speed: 700,
  rivals: {
    O: { name: 'Jev·O', personality: 'A patient, positional player who loves the corners.' },
    X: { name: 'Jev·X', personality: 'A greedy opportunist who grabs flips and attacks the center.' },
  },
  referee: 'Call it fairly — is the move strong, is it aggressive, how decided is the game?',
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startDuelViewer({ workspace, port })
  console.log(`Jev Duel listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
