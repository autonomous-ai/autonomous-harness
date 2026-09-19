// Jev Blocks viewer — a loopback server that runs a falling-blocks puzzle and lets Jev (TypeSafe's
// System One model) play it. For every new piece the viewer lists every legal placement and asks
// Jev ONE call with three parallel questions: `place` (a choice over the placements), `danger`
// (a score) and `go_for_four` (a yes/no). The piece really falls while Jev decides and while the
// piece is moved into place, so the honest limit is time: turn gravity up and placements start to
// land short. The game is synthetic. The decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. The workspace holds blocks.json (watched live).

import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, telemetry } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, mulberry32, clean } from './kit.mjs'
import {
  W, H, TYPES, CODE, SHAPES, spawnOf, rotationPath, emptyBoard, collide, dropRow, clearLines, measure,
  enumerate, buildState, buildQuestions, blocksMock, DANGER_LEVELS,
} from './game.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'blocks.json'

export const DEFAULTS = {
  title: 'Jev Blocks',
  description: 'Jev plays a falling-blocks puzzle. One call per piece picks the placement.',
  seed: 7,
  gravity: 2,
  speedup: 0.5,
  decisionMs: 110,
  moveMs: 35,
  garbageRows: 0,
  weights: { I: 1, O: 1, T: 1, S: 1, Z: 1, J: 1, L: 1 },
  board: [],
  style: 'Keep the stack low, flat and free of holes. Leave the right column open and go for four lines at once when it is safe. When the stack gets high, stop waiting and clear lines.',
}

const LIMITS = { gravity: [0.2, 40], speedup: [0, 2], decisionMs: [30, 1000], moveMs: [5, 500], garbageRows: [0, 12] }
const MAX_GRAVITY = 120     // rows per second, after the level speedup
const CLEAR_MS = 220        // pause while cleared lines flash, before the next piece
const SPAWN_MS = 45         // pause between a lock and the next piece
const RESULT_MS = 3000      // how long a finished game stays on screen
const LOOP_MS = 20
const LINE_SCORE = [0, 100, 300, 500, 800]

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, [lo, hi], d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d)

/** Clamp a raw blocks.json into something the simulator can always run. */
export function sanitize(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const out = {
    title: clean(c.title || DEFAULTS.title).slice(0, 80),
    description: clean(c.description || '').slice(0, 300),
    style: clean(c.style || DEFAULTS.style).slice(0, 600),
    seed: Number.isFinite(Number(c.seed)) ? Math.floor(Number(c.seed)) : DEFAULTS.seed,
    warnings: [],
  }
  for (const k of Object.keys(LIMITS)) out[k] = num(c[k], LIMITS[k], DEFAULTS[k])
  out.garbageRows = Math.round(out.garbageRows)
  out.weights = {}
  let sum = 0
  for (const t of TYPES) { const w = Math.round(num(c.weights?.[t], [0, 9], c.weights && typeof c.weights === 'object' ? 0 : 1)); out.weights[t] = w; sum += w }
  if (!sum) { for (const t of TYPES) out.weights[t] = 1; out.warnings.push('weights were all zero, using an even mix') }
  out.board = []
  if (Array.isArray(c.board) && c.board.length) {
    const rows = c.board.map(String)
    if (rows.length > H || rows.some((r) => !/^[.#]{10}$/.test(r))) out.warnings.push(`board ignored: use up to ${H} rows of exactly ${W} characters, '.' or '#'`)
    else out.board = rows
  }
  return out
}

export async function startBlocksViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  // ---- every piece of mutable state is declared here, before any function below can run ----
  let stopped = false
  let running = true
  let slow = false            // slow motion: the game clock runs at a quarter of wall time
  let busy = false            // a step is in flight; the real-time loop stands back
  let cfg = sanitize({})
  let cfgKey = ''
  let cfgErr = null
  let overrides = {}          // runtime changes from the pane; an edit to blocks.json clears them
  let game = null
  let session = null
  let piece = null
  let pieceSeq = 0
  let mind = null
  let mindSeq = 0
  let lastDanger = null
  let lastFour = null
  let events = []
  let eventSeq = 0
  let log = []
  let logSeq = 0
  let finished = null
  let salt = 1
  let jevErr = null
  let decisions = 0           // decisions applied, over the whole session
  let recent = []             // last locks: true = missed
  let lastVerdictAt = 0
  let lastFrameAt = 0
  let lastWall = performance.now()
  let loop = null
  let chain = Promise.resolve()
  let viewer = null
  let sentMind = -1
  let sentLog = -1
  let watcher = null

  // ------------------------------------------------------------------ helpers
  const val = (k) => (overrides[k] ?? cfg[k])
  /** Rows per second right now. The pane can pin it; otherwise it climbs with the level. */
  const gravityNow = () => clamp(overrides.pin ?? cfg.gravity * (1 + cfg.speedup * ((game?.level ?? 1) - 1)), 0.2, MAX_GRAVITY)

  function say(text, kind = 'info') {
    log.push({ seq: ++logSeq, kind, text: clean(text).slice(0, 160), lines: game?.lines ?? 0 })
    if (log.length > 60) log.splice(0, log.length - 60)
  }
  function emit(kind, data = {}) {
    events.push({ seq: ++eventSeq, kind, ...data })
    if (events.length > 24) events.splice(0, events.length - 24)
  }

  // ------------------------------------------------------------------ game setup
  function refill() {
    while (game.queue.length < 5) {
      if (!game.bag.length) {
        for (const t of TYPES) for (let i = 0; i < cfg.weights[t]; i++) game.bag.push(t)
        for (let i = game.bag.length - 1; i > 0; i--) { const j = Math.floor(game.rng() * (i + 1)); [game.bag[i], game.bag[j]] = [game.bag[j], game.bag[i]] }
      }
      game.queue.push(game.bag.pop())
    }
  }

  function garbageRow() {
    let gap = Math.floor(game.rngG() * W)
    if (gap === game.lastGap) gap = (gap + 1 + Math.floor(game.rngG() * (W - 1))) % W
    game.lastGap = gap
    return { gap, row: Array.from({ length: W }, (_, x) => (x === gap ? 0 : CODE.garbage)) }
  }

  /** Push one garbage row in from the bottom. Returns false if that pushed blocks out of the top. */
  function pushGarbage() {
    const { gap, row } = garbageRow()
    const lost = game.board.shift()
    game.board.push(row)
    if (piece) while (collide(game.board, piece.type, piece.rot, piece.x, piece.y) && piece.y > -4) piece.y--
    return { gap, overflow: lost.some((c) => c) }
  }

  function newGame(why) {
    const n = (session.games += 1)
    const seed = (cfg.seed + n - 1) | 0
    game = {
      n, board: emptyBoard(), queue: [], bag: [], rng: mulberry32(seed), rngG: mulberry32(seed ^ 0x9e3779b9), lastGap: -1,
      score: 0, level: 1, lines: 0, pieces: 0, misses: 0, fours: 0, now: 0, nextSpawnAt: 0,
    }
    piece = null
    finished = null
    mind = null
    mindSeq++
    recent = []
    cfg.board.forEach((r, i) => { const y = H - cfg.board.length + i; for (let x = 0; x < W; x++) game.board[y][x] = r[x] === '#' ? CODE.garbage : 0 })
    clearLines(game.board)
    for (let i = 0; i < cfg.garbageRows; i++) pushGarbage()
    refill()
    emit('newgame', { n })
    say(`Game ${n} started${why ? ` (${why})` : ''} · gravity ${gravityNow().toFixed(1)} rows/s`, 'game')
  }

  function newSession(why) {
    session = { games: 0, best: 0, lines: 0, pieces: 0, topOuts: 0, misses: 0, fours: 0, lastTopOut: null }
    decisions = 0
    newGame(why)
  }

  function topOut(reason) {
    if (finished) return
    piece = null
    session.topOuts++
    const record = session.topOuts > 1 && game.lines > session.best
    session.best = Math.max(session.best, game.lines)
    finished = { lines: game.lines, pieces: game.pieces, score: game.score, level: game.level, gravity: gravityNow(), reason, record, wallAt: Date.now() }
    session.lastTopOut = { lines: game.lines, pieces: game.pieces, gravity: gravityNow() }
    emit('topout', { lines: game.lines, pieces: game.pieces })
    say(`Topped out · ${game.lines} lines, ${game.pieces} pieces at ${gravityNow().toFixed(1)} rows/s${record && game.lines ? ' · new best' : ''}`, 'bad')
    verdict(true)
  }

  // ------------------------------------------------------------------ one piece
  function spawn() {
    const type = game.queue.shift()
    refill()
    const sp = spawnOf(type)
    if (collide(game.board, type, 0, sp.x, sp.y)) { game.queue.unshift(type); return topOut('the stack reached the top') }
    const g = gravityNow()
    piece = {
      id: ++pieceSeq, type, rot: 0, x: sp.x, y: sp.y, g, phase: 'think', spawnAt: game.now, fallAt: game.now + 1000 / g,
      decideAt: game.now + val('decisionMs'), answer: null, answerAt: Infinity, asking: null, queue: [], target: null, moveAt: Infinity, moved: 0, blocked: 0,
    }
    ask(piece)
  }

  /** Ask Jev about this piece. One call, three parallel questions. The piece keeps falling meanwhile. */
  function ask(p, free = false) {
    const g = game
    const cands = enumerate(g.board, p.type)
    const state = buildState({ style: cfg.style, board: g.board, type: p.type, next: g.queue.slice(0, 3), level: g.level, lines: g.lines, gravity: p.g, decisionMs: val('decisionMs'), moveMs: val('moveMs'), cands })
    p.cands = cands
    p.asking = (async () => {
      if (!cands.length) { p.answer = { none: true }; p.answerAt = p.decideAt; return }
      try {
        const res = await evaluate({ state, questions: buildQuestions(p.type, cands), salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: blocksMock })
        if (stopped || piece !== p || game !== g) return
        jevErr = null
        p.answer = res
        const cost = Math.max(val('decisionMs'), res.client === 'typesafe' ? res.latencyMs : 0)
        p.answerAt = free ? g.now : Math.max(p.spawnAt + cost, g.now)
      } catch (e) {
        if (stopped || piece !== p) return
        if (!jevErr) say(`Jev call failed: ${clean(e?.message ?? e).slice(0, 110)}`, 'bad')
        jevErr = clean(e?.message ?? e)
        p.answer = { none: true }
        p.answerAt = Math.max(p.decideAt, g.now)
      }
    })()
  }

  /** Turn Jev's answer into a target and a list of moves, and publish its mind to the pane. */
  function applyDecision(p) {
    const res = p.answer
    p.phase = 'move'
    p.moveAt = game.now + val('moveMs')
    if (!res || res.none) { p.queue = []; p.target = null; return }
    const a = res.answers.place || {}
    const probs = a.probabilities || {}
    let pick = p.cands.find((c) => c.id === a.choice)
    if (!pick) pick = [...p.cands].sort((x, y) => (probs[y.id] ?? 0) - (probs[x.id] ?? 0))[0]
    p.target = pick
    const sp = spawnOf(p.type)
    p.queue = [...rotationPath(p.type, pick.rot).map((r) => ({ rot: r })), ...Array.from({ length: Math.abs(pick.x - sp.x) }, () => ({ dx: Math.sign(pick.x - sp.x) }))]
    decisions++
    const d = res.answers.danger || {}
    const four = Number(res.answers.go_for_four?.noul ?? 0)
    lastDanger = { score: Number(d.score ?? 0), label: DANGER_LEVELS[Math.round(Number(d.score ?? 0))]?.split(':')[0] ?? '', confidence: Number(d.confidence ?? 0) }
    lastFour = four
    const needMs = val('decisionMs') + (p.queue.length + 1) * val('moveMs')
    const rowsFree = Math.max(0, dropRow(game.board, p.type, 0, sp.x, sp.y) - sp.y)
    mind = {
      seq: ++mindSeq, pieceId: p.id, type: p.type, chosen: pick.id, confidence: Number(a.confidence ?? probs[pick.id] ?? 0),
      cands: p.cands.map((c) => ({ id: c.id, r: c.rot, x: c.x, y: c.y, p: +(Number(probs[c.id] ?? 0)).toFixed(4), lines: c.lines, holes: c.newHoles })).sort((x, y) => y.p - x.p),
      needMs: Math.round(needMs), haveMs: Math.round((rowsFree / p.g) * 1000), latencyMs: +Number(res.latencyMs ?? 0).toFixed(1), client: res.client,
    }
  }

  function lock(p, how) {
    const b = game.board
    let above = false
    for (const [dx, dy] of SHAPES[p.type][p.rot]) { if (p.y + dy < 0) above = true; else b[p.y + dy][p.x + dx] = CODE[p.type] }
    const onTarget = !!p.target && p.rot === p.target.rot && p.x === p.target.x
    const missed = !onTarget
    const cleared = clearLines(b)
    const n = cleared.length
    const gain = LINE_SCORE[n] * game.level
    game.score += gain
    game.lines += n; session.lines += n
    game.pieces++; session.pieces++
    if (n === 4) { game.fours++; session.fours++ }
    if (missed) { game.misses++; session.misses++ }
    recent.push(missed); if (recent.length > 50) recent.shift()
    emit('lock', { id: p.id, type: p.type, rot: p.rot, x: p.x, y: p.y, fromY: how.fromY ?? p.y, missed, cleared, gain, want: missed && p.target ? { rot: p.target.rot, x: p.target.x, y: p.target.y } : null })
    if (missed) {
      const off = p.target ? Math.abs(p.x - p.target.x) : 0
      say(p.target ? `Missed: ${p.type} wanted ${p.target.id}, landed ${off ? `${off} column${off > 1 ? 's' : ''} short` : 'with the wrong rotation'}` : `${p.type} landed before Jev could answer`, 'warn')
    }
    if (n >= 2) say(n === 4 ? `FOUR lines at once · +${gain}` : `${n} lines · +${gain}`, n === 4 ? 'four' : 'ok')
    const level = 1 + Math.floor(game.lines / 10)
    if (level > game.level) { game.level = level; emit('levelup', { level, g: +gravityNow().toFixed(2) }); say(`Level ${level} · gravity ${gravityNow().toFixed(1)} rows/s`, 'level') }
    piece = null
    game.nextSpawnAt = game.now + (n ? CLEAR_MS : SPAWN_MS)
    if (above) topOut('a piece locked above the top')
  }

  // ------------------------------------------------------------------ the clock (event driven, in game ms)
  function actionTime() {
    if (!piece) return Infinity
    if (piece.phase === 'think') return piece.answer ? Math.max(piece.decideAt, piece.answerAt) : Infinity
    return piece.moveAt
  }
  function nextEventTime() {
    if (finished) return Infinity
    if (!piece) return game.nextSpawnAt
    return Math.min(piece.fallAt, actionTime())
  }

  function processEvent() {
    if (!piece) return spawn()
    const p = piece
    if (actionTime() <= p.fallAt) {
      if (p.phase === 'think') return applyDecision(p)
      const m = p.queue[0]
      if (!m) { const fromY = p.y; p.y = dropRow(game.board, p.type, p.rot, p.x, p.y); return lock(p, { fromY }) } // aligned: hard drop
      const rot = m.rot ?? p.rot, x = p.x + (m.dx ?? 0)
      if (!collide(game.board, p.type, rot, x, p.y)) { p.rot = rot; p.x = x; p.queue.shift(); p.moved++ } else p.blocked++
      p.moveAt += val('moveMs')
      return
    }
    // gravity: one row down, or it has landed and locks where it is
    if (collide(game.board, p.type, p.rot, p.x, p.y + 1)) return lock(p, {})
    p.y++
    p.fallAt += 1000 / p.g
  }

  function advanceTo(t) {
    let guard = 0
    while (!finished && guard++ < 4000) {
      const te = nextEventTime()
      if (te > t) break
      game.now = Math.max(game.now, te)
      processEvent()
    }
    if (!finished) game.now = Math.max(game.now, t)
  }

  /** Advance until exactly one more decision has been applied (or the game ended). Never waits on timers. */
  async function stepDecision() {
    if (finished) newGame('next game')
    const want = decisions + 1
    let guard = 0
    while (decisions < want && !finished && !stopped && guard++ < 20000) {
      if (piece && piece.phase === 'think' && !piece.answer) await piece.asking
      const te = nextEventTime()
      if (te === Infinity) break
      game.now = Math.max(game.now, te)
      processEvent()
    }
  }

  // ------------------------------------------------------------------ what the pane sees
  function pieceView() {
    if (!piece) return null
    const p = piece
    const resting = collide(game.board, p.type, p.rot, p.x, p.y + 1)
    const frac = resting ? 0 : clamp(1 - (p.fallAt - game.now) / (1000 / p.g), 0, 1)
    return { id: p.id, type: p.type, rot: p.rot, x: p.x, y: p.y, frac: +frac.toFixed(3), phase: p.phase, left: p.queue.length, moved: p.moved, ghostY: dropRow(game.board, p.type, p.rot, p.x, p.y), target: p.target ? { id: p.target.id, rot: p.target.rot, x: p.target.x, y: p.target.y } : null }
  }

  function view(full) {
    const mins = game.now / 60000
    const m = measure(game.board)
    const f = {
      title: cfg.title, running, slow, client: telemetry.client, error: cfgErr, warnings: cfg.warnings, jevError: jevErr,
      cfg: { gravity: cfg.gravity, pinned: overrides.pin != null, maxGravity: MAX_GRAVITY, speedup: cfg.speedup, decisionMs: val('decisionMs'), baseDecisionMs: cfg.decisionMs, moveMs: val('moveMs'), garbageRows: cfg.garbageRows, weights: cfg.weights, overridden: Object.keys(overrides) },
      game: {
        n: game.n, board: game.board.map((r) => r.join('')).join(''), queue: game.queue.slice(0, 3), score: game.score, level: game.level, lines: game.lines, pieces: game.pieces,
        misses: game.misses, fours: game.fours, gravity: +gravityNow().toFixed(2), simMs: Math.round(game.now), lpm: game.now > 4000 ? +(game.lines / mins).toFixed(1) : 0, maxHeight: m.max, holes: m.holes,
      },
      piece: pieceView(),
      session: { ...session, decisions },
      danger: lastDanger, four: lastFour,
      finished: finished ? { ...finished, restartInMs: Math.max(0, RESULT_MS - (Date.now() - finished.wallAt)) } : null,
      events, mindSeq, logSeq,
    }
    if (full || sentMind !== mindSeq) f.mind = mind
    if (full || sentLog !== logSeq) f.log = log.slice(-40)
    if (full) { f.shapes = SHAPES; f.spawn = Object.fromEntries(TYPES.map((t) => [t, spawnOf(t)])); f.style = cfg.style; f.description = cfg.description; f.dangerLevels = DANGER_LEVELS }
    return f
  }

  function push() {
    if (!viewer) return
    const f = view(false)
    sentMind = mindSeq; sentLog = logSeq
    lastFrameAt = performance.now()
    viewer.broadcast(f)
  }

  function verdict(force) {
    const t = performance.now()
    if (!force && t - lastVerdictAt < 400) return
    lastVerdictAt = t
    const missN = recent.filter(Boolean).length
    const pressured = missN >= 3 || (lastDanger?.score ?? 0) >= 1.8
    const findings = []
    if (cfgErr) findings.push({ severity: 'error', kind: 'config', message: cfgErr })
    for (const w of cfg.warnings) findings.push({ severity: 'warning', kind: 'config', message: w })
    if (jevErr) findings.push({ severity: 'error', kind: 'jev', message: jevErr })
    if (recent.length >= 10) findings.push({ severity: missN / recent.length > 0.1 ? 'warning' : 'info', kind: 'timing', message: `${missN} of the last ${recent.length} pieces landed short of their target at ${gravityNow().toFixed(1)} rows/s` })
    if (session.lastTopOut) findings.push({ severity: 'info', kind: 'topout', message: `Topped out ${session.topOuts} time(s). Last: ${session.lastTopOut.lines} lines at ${session.lastTopOut.gravity.toFixed(1)} rows/s. Best ${session.best} lines.` })
    try {
      writeVerdict(workspace, {
        ready: decisions > 0 && !cfgErr,
        summary: cfgErr ? `Jev Blocks needs a fix: ${cfgErr}` : `${cfg.title} · game ${game.n} · ${game.lines} lines · level ${game.level} · ${gravityNow().toFixed(1)} rows/s · ${game.misses} missed · best ${Math.max(session.best, game.lines)}`,
        findings, artifact: MARKER,
        phases: [
          { id: 'play', name: 'Playing clean', state: finished || pressured ? 'done' : 'active' },
          { id: 'pressure', name: 'Under pressure', state: finished ? 'done' : pressured ? 'active' : 'pending' },
          { id: 'topout', name: 'Topped out', state: finished ? 'active' : session.topOuts ? 'done' : 'pending' },
        ],
      })
    } catch { /* the workspace may be going away on close */ }
  }

  // ------------------------------------------------------------------ the pane's controls
  async function rethinkIfPaused() {
    const p = piece
    if (running || !p || finished || p.moved > 0) return
    p.phase = 'think'; p.answer = null; p.queue = []; p.target = null; p.moveAt = Infinity
    ask(p, true)
    await p.asking
    if (piece === p && p.answer) applyDecision(p)
  }

  async function control(cmd, body) {
    const run = async () => {
      if (stopped) return null
      if (cmd === 'pause') running = false
      else if (cmd === 'start') { running = true; lastWall = performance.now() }
      else if (cmd === 'reset') { overrides = {}; slow = false; newSession('reset') }
      else if (cmd === 'tick') {
        running = false; busy = true
        try { const n = clamp(Math.floor(Number(body.n) || 1), 1, 1000); for (let i = 0; i < n && !stopped; i++) await stepDecision() } finally { busy = false }
      } else if (cmd === 'set') {
        for (const k of ['decisionMs', 'moveMs']) if (typeof body[k] === 'number' && Number.isFinite(body[k])) overrides[k] = clamp(body[k], ...LIMITS[k])
        if (typeof body.gravity === 'number' && Number.isFinite(body.gravity)) overrides.pin = clamp(body.gravity, 0.2, MAX_GRAVITY)
        if (body.gravity === null) delete overrides.pin
        if (typeof body.slow === 'boolean') slow = body.slow
        if (piece) { const g = gravityNow(); const left = clamp((piece.fallAt - game.now) / (1000 / piece.g), 0, 1); piece.g = g; piece.fallAt = game.now + left * (1000 / g) }
      } else if (cmd === 'garbage') {
        if (finished) return { done: false }
        const { gap, overflow } = pushGarbage()
        emit('garbage', { gap })
        say(`You pushed up a garbage row (gap at column ${gap})`, 'you')
        if (overflow) topOut('garbage pushed the stack over the top')
        else await rethinkIfPaused()
      } else if (cmd === 'junk') {
        const col = Math.floor(Number(body.col))
        if (finished || !(col >= 0 && col < W)) return { done: false }
        let top = 0
        while (top < H && !game.board[top][col]) top++
        if (top === 0) return { done: false }
        game.board[top - 1][col] = CODE.junk
        if (piece) while (collide(game.board, piece.type, piece.rot, piece.x, piece.y) && piece.y > -4) piece.y--
        const cleared = clearLines(game.board)
        emit('junk', { col, row: top - 1, cleared })
        say(`You dropped a junk block in column ${col}`, 'you')
        await rethinkIfPaused()
      } else if (cmd === 'cycleNext') {
        const i = Math.floor(Number(body.index))
        if (finished || !(i >= 0 && i < 3)) return { done: false }
        const to = TYPES[(TYPES.indexOf(game.queue[i]) + 1) % TYPES.length]
        game.queue[i] = to
        emit('cycle', { index: i, type: to })
        say(`You changed next piece ${i + 1} to ${to}`, 'you')
        await rethinkIfPaused()
      } else return { unknown: true }
      verdict(true)
      push()
      return { running, pieces: session.pieces, lines: session.lines, decisions }
    }
    const result = chain.then(run, run)
    chain = result.catch(() => {})
    return result
  }

  // ------------------------------------------------------------------ boot
  function applyConfig(raw, err) {
    cfgErr = err
    if (err) return false
    const key = JSON.stringify(raw)
    if (key === cfgKey) return false
    cfgKey = key
    cfg = sanitize(raw)
    overrides = {}
    slow = false
    return true
  }

  watcher = watchConfig(join(workspace, MARKER), {}, (raw, err) => {
    if (stopped) return
    const changed = applyConfig(raw, err)
    if (changed) { newSession('blocks.json edited'); say('blocks.json edited · pane changes cleared', 'you') } else if (err) say(`blocks.json has an error, keeping the last good one`, 'bad')
    verdict(true)
    push()
  })
  applyConfig(watcher.get(), watcher.error())
  newSession('')

  viewer = await serveViewer({ here: HERE, port, state: () => view(true), control })
  verdict(true)

  loop = setInterval(() => {
    if (stopped) return
    const t = performance.now()
    const dt = Math.min(120, t - lastWall)
    lastWall = t
    if (busy) return
    if (running) {
      if (finished) { if (Date.now() - finished.wallAt >= RESULT_MS) newGame('next game') } else advanceTo(game.now + dt * (slow ? 0.25 : 1))
      verdict(false)
      push()
    } else if (t - lastFrameAt > 1000) push()
  }, LOOP_MS)

  return {
    url: viewer.url,
    async close() { stopped = true; clearInterval(loop); watcher.close(); await viewer.close() },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startBlocksViewer({ workspace, port })
  console.log(`Jev Blocks listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
