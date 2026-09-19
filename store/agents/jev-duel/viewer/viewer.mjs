// Jev Duel viewer — a loopback server running a live Reversi battle where Jev (TypeSafe's System
// One model) plays BOTH sides and a third Jev referees. The chat agent shapes battle.json (board
// size, the two rivals' names, personalities and insight, the referee's focus). The viewer runs the
// game, and right after every move it already asks the NEXT player, so the pane can show that
// player's whole probability spread on the board before the disk lands.
//
// The honest dial is `insight` (0..2) per player: how much the text tells Jev about each legal move.
//
// The pane lets a person force the next move, swap the two sides, change the board size, the pace
// and each player's insight. It never idles: a finished game shows the winner for about five
// seconds, then a new game starts.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds battle.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { DEFAULT, sanitize, newBoard, legalMoves, applyMove, count, other, describeMove, sideState, refState } from './game.mjs'
import { duelMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = new Set(['index.html', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const REST_MS = 5000
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export { sanitize }

export async function startDuelViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const file = join(workspace, 'battle.json')

  // Every binding is declared before anything can call into the closures below.
  let raw = { ...DEFAULT }
  let cfgError = null
  let overrides = {} // { size, speed, insightO, insightX, swapped }
  let board = newBoard(DEFAULT.size)
  let toMove = 'O'
  let pending = null // the player to move has already answered: { disk, moves:[{x,y,flips,p}], choice, confidence }
  let stateText = ''
  let stopped = false, running = false, busy = false
  let timer = null, watchTimer = null, salt = 1, lastVerdictAt = 0
  let gameOver = false, winner = null, rest = 0, error = null
  let history = [] // [{ n, side, disk, x, y, flips, flipped, ref, human, at }]
  let moveCount = 0, game = 1
  const clients = new Set()
  const totals = { games: 0, winsO: 0, winsX: 0, draws: 0, moves: 0, forced: 0, results: [] }

  function load() {
    try { raw = { ...DEFAULT, ...JSON.parse(readFileSync(file, 'utf8')) }; cfgError = null } catch (e) {
      cfgError = existsSync(file) ? clean(`battle.json: ${e.message}`) : null
    }
  }
  function cfg() {
    const c = sanitize(raw)
    if (overrides.size != null) c.size = overrides.size
    if (overrides.speed != null) c.speed = overrides.speed
    if (overrides.swapped) c.rivals = { O: c.rivals.X, X: c.rivals.O }
    if (overrides.insightO != null) c.rivals.O = { ...c.rivals.O, insight: overrides.insightO }
    if (overrides.insightX != null) c.rivals.X = { ...c.rivals.X, insight: overrides.insightX }
    return c
  }

  /** Ask the player to move. Its full answer is kept so the pane can draw it on the board. */
  async function think() {
    pending = null
    if (gameOver) return
    const c = cfg()
    const moves = legalMoves(board, toMove)
    if (!moves.length) return
    stateText = sideState(c, board, toMove, moves)
    const options = Object.fromEntries(moves.map((m) => [`${m.x},${m.y}`, `play column ${m.x}, row ${m.y}, flipping ${m.flips}`]))
    const res = await evaluate({
      state: stateText,
      questions: {
        move: jev.choice(options, 'Choose the strongest Reversi move for your side and your personality, as an "x,y" coordinate from the list.'),
        confident: jev.noul('Is this a move you feel confident about, rather than a forced one?'),
      },
      salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: duelMock,
    })
    const a = res.answers.move ?? {}
    const probs = a.probabilities ?? {}
    const pick = moves.find((m) => `${m.x},${m.y}` === String(a.choice)) ?? moves[0]
    pending = {
      disk: toMove, choice: [pick.x, pick.y], confidence: Number(a.confidence ?? 0), sure: Number(res.answers.confident?.noul ?? 0.5),
      moves: moves.map((m) => ({ x: m.x, y: m.y, flips: m.flips, p: Number(probs[`${m.x},${m.y}`] ?? 0) })),
      client: res.client, model: res.model,
    }
  }

  async function referee(c, move, disk) {
    const res = await evaluate({
      state: refState(c, board, move, disk),
      questions: {
        strong: jev.score({ 0: 'blunder', 1: 'solid', 2: 'brilliant' }, 'How strong was this move tactically?'),
        aggressive: jev.noul('Was this an aggressive, disk-taking move rather than a quiet positional one?'),
        decided: jev.score({ 0: 'wide open', 1: 'leaning', 2: 'decided' }, 'How decided is the game right now?'),
      },
      salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: duelMock,
    })
    const a = res.answers
    return {
      strong: typeof a.strong?.score === 'number' ? a.strong.score : 1,
      aggressive: a.aggressive?.noul ?? 0.5,
      decided: typeof a.decided?.score === 'number' ? a.decided.score : 0,
    }
  }

  function newGame() {
    const c = cfg()
    board = newBoard(c.size); toMove = 'O'; gameOver = false; winner = null; rest = 0
    history = []; moveCount = 0; pending = null; error = null; salt += 10
  }

  function endGame(c) {
    const n = count(board)
    gameOver = true; rest = 0
    winner = n.O === n.X ? null : n.O > n.X ? 'O' : 'X'
    totals.games++
    if (winner === 'O') totals.winsO++; else if (winner === 'X') totals.winsX++; else totals.draws++
    totals.results.push({ game, winner, name: winner ? c.rivals[winner].name : 'Draw', O: n.O, X: n.X, moves: moveCount })
    if (totals.results.length > 30) totals.results.shift()
  }

  /** One move: the pending answer (or a person's pick) lands, the referee judges it, the next player is asked. */
  async function step(forced = null) {
    if (busy || stopped) return false
    busy = true
    try {
      const c = cfg()
      if (gameOver) {
        rest++
        if (rest * c.speed >= REST_MS) { game++; newGame(); await think() }
        return true
      }
      if (!pending || pending.disk !== toMove) await think()
      const legal = legalMoves(board, toMove)
      let pick = null
      if (forced) pick = legal.find((m) => m.x === forced.x && m.y === forced.y) ?? null
      if (forced && !pick) return false
      if (!pick && pending) pick = legal.find((m) => m.x === pending.choice[0] && m.y === pending.choice[1]) ?? legal[0]
      if (pick) {
        const disk = toMove
        const detail = describeMove(board, pick, disk)
        const flipped = applyMove(board, pick.x, pick.y, disk)
        moveCount++; totals.moves++
        if (forced) totals.forced++
        const ref = await referee(c, { ...pick, detail }, disk)
        const p = pending?.moves.find((m) => m.x === pick.x && m.y === pick.y)?.p ?? null
        history.push({ n: moveCount, side: c.rivals[disk].name, disk, x: pick.x, y: pick.y, flips: pick.flips, flipped, ref, p, human: !!forced, at: new Date().toISOString() })
        if (history.length > 200) history.splice(0, history.length - 200)
      }
      // Pass when the next side has no move; the game is over when neither side can move.
      const next = other(toMove)
      if (legalMoves(board, next).length) toMove = next
      else if (!legalMoves(board, toMove).length) endGame(c)
      await think()
      error = null
      return true
    } catch (e) {
      error = clean(e?.message ?? String(e))
      return false
    } finally {
      busy = false
    }
  }

  function frame() {
    const c = cfg(), n = count(board)
    return {
      type: 'frame', title: c.title, description: c.description, size: c.size, speed: c.speed,
      board: board.map((r) => r.join('')), toMove, counts: n, running, gameOver, winner,
      winnerName: winner ? c.rivals[winner].name : null, restLeftMs: gameOver ? Math.max(0, REST_MS - rest * c.speed) : 0,
      error, cfgError, rivals: c.rivals, refereeFocus: c.referee,
      history: history.slice(-30), quality: history.map((h) => [h.disk, Number(h.ref.strong.toFixed(2))]),
      moveCount, game, pending, totals: { ...totals, results: totals.results.slice(-8) }, stateText, overrides,
    }
  }

  function verdict() {
    const c = cfg(), n = count(board), total = n.O + n.X, cells = c.size * c.size
    const problem = cfgError || error
    const leader = n.O === n.X ? 'tied' : n.O > n.X ? `${c.rivals.O.name} leads` : `${c.rivals.X.name} leads`
    const v = {
      spec: 1,
      ready: !problem,
      summary: problem
        ? `Duel needs a fix: ${problem}`
        : gameOver
          ? `${winner ? c.rivals[winner].name : 'Draw'} — final ${n.O}–${n.X} · game ${game}`
          : `${c.rivals.O.name} (O) vs ${c.rivals.X.name} (X) — ${leader} ${n.O}–${n.X} · game ${game}, ${totals.winsO}–${totals.winsX} in games`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'duel', message: problem }] : []),
        { severity: 'info', kind: 'duel', message: `insight O ${c.rivals.O.insight}, X ${c.rivals.X.insight} · ${c.size}x${c.size} · ${c.speed} ms per move · ${totals.forced} moves forced by a person` },
      ],
      artifact: 'battle.json',
      phases: [
        { id: 'open', name: 'Opening', state: total <= 12 ? 'active' : 'done' },
        { id: 'midgame', name: 'Midgame', state: total > 12 && !gameOver ? 'active' : total > 12 ? 'done' : 'pending' },
        { id: 'endgame', name: 'Endgame', state: gameOver ? 'done' : total >= cells * 0.8 ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
    const out = join(workspace, '.harness/verdict.json')
    writeFileSync(out + '.tmp', JSON.stringify(v))
    renameSync(out + '.tmp', out)
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    if (!clients.size) return
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().speed) }
  async function run() {
    const t0 = Date.now(), was = gameOver
    await step()
    push(was !== gameOver)
    if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().speed - (Date.now() - t0)))
  }

  /** A dial or the sides changed: the player to move reads new text, so ask it again. */
  async function rethink() { if (!busy) { busy = true; try { await think() } catch (e) { error = clean(e.message) } finally { busy = false } } }

  async function control(cmd, body) {
    let ok = true
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') {
      Object.assign(totals, { games: 0, winsO: 0, winsX: 0, draws: 0, moves: 0, forced: 0, results: [] })
      overrides = {}; game = 1; salt = 1; newGame(); await rethink()
    }
    else if (cmd === 'tick' || cmd === 'step') { const n = Math.round(num(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await step() }
    else if (cmd === 'play') { ok = await step({ x: Math.round(Number(body.x)), y: Math.round(Number(body.y)) }); if (ok && running) schedule() }
    else if (cmd === 'swap') { overrides = { ...overrides, swapped: !overrides.swapped, insightO: overrides.insightX, insightX: overrides.insightO }; await rethink() }
    else if (cmd === 'set') {
      const v = Number(body.value)
      if (body.key === 'speed') { overrides = { ...overrides, speed: Math.round(num(v, 60, 5000, 700)) }; if (running) schedule() }
      else if (body.key === 'size' && [4, 6, 8, 10, 12].includes(v)) { overrides = { ...overrides, size: v }; game++; newGame(); await rethink() }
      else if (body.key === 'insightO' || body.key === 'insightX') { overrides = { ...overrides, [body.key]: Math.round(num(v, 0, 2, 2)) }; await rethink() }
      else ok = false
    } else ok = false
    push(true)
    return { ok, moveCount, game, gameOver }
  }

  load()
  newGame()
  salt = 1
  await think()

  // Watch the folder, not the file: an editor that saves by rename would drop a file watch.
  const watcher = watch(workspace, (_, name) => {
    if (name && String(name) !== 'battle.json') return
    clearTimeout(watchTimer)
    watchTimer = setTimeout(async () => {
      if (stopped) return
      const before = JSON.stringify(raw), sizeBefore = cfg().size
      load()
      if (JSON.stringify(raw) !== before) {
        overrides = {}
        if (cfg().size !== sizeBefore) { game++; newGame() }
        await rethink()
      }
      push(true)
    }, 40)
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        if (FILES.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] }); return res.end(readFileSync(join(HERE, name))) }
        if (url.pathname === '/state') {
          // Keeps the keys older tools read (board as rows of cells, counts, history) and adds the rest.
          const f = frame()
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ...f, board: board.map((r) => r.slice()), rows: f.board }))
        }
        if (url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (url.pathname === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(frame())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && url.pathname === '/control') {
        let body = ''
        for await (const c of req) { body += c; if (body.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(j?.cmd ?? ''), j && typeof j === 'object' ? j : {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(reply))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ok) })

  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false
      clearTimeout(timer); clearTimeout(watchTimer)
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
  const viewer = await startDuelViewer({ workspace, port })
  console.log(`Jev Duel listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
