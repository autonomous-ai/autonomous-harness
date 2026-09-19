// game.mjs — the pure rules of the falling-blocks puzzle, with no server and no timers:
// piece shapes, the well, legal placements, the state text Jev reads, and the offline reader
// (`blocksMock`) that stands in for Jev when no API key is set.
//
// The offline reader gets ONLY the state text and the option descriptions, the same words live Jev
// gets. It never touches the simulator's variables.

export const W = 10
export const H = 20
export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
export const CODE = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7, garbage: 8, junk: 9 }

const BASE = {
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], states: 2 },
  O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], states: 1 },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], states: 4 },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], states: 2 },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], states: 2 },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], states: 4 },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], states: 4 },
}

/** SHAPES[type][rot] = list of [dx, dy] cells inside the piece's box. Rotation is clockwise. */
export const SHAPES = {}
for (const t of TYPES) {
  const { n, cells, states } = BASE[t]
  const rots = []
  let cur = cells
  for (let r = 0; r < states; r++) {
    rots.push(cur.map(([x, y]) => [x, y]))
    cur = cur.map(([x, y]) => [n - 1 - y, x])
  }
  SHAPES[t] = rots
}

/** Where a fresh piece appears: box x, box y. The I piece starts one row up so it shows in row 0. */
export const spawnOf = (type) => ({ x: type === 'O' ? 4 : 3, y: type === 'I' ? -1 : 0 })

/** Fewest rotate presses from rotation 0, and the rotation states passed through. */
export function rotationPath(type, rot) {
  const n = SHAPES[type].length
  if (rot <= 0 || rot >= n) return []
  if (n === 4 && rot === 3) return [3] // one press the other way
  const path = []
  for (let r = 1; r <= rot; r++) path.push(r)
  return path
}

export const emptyBoard = () => Array.from({ length: H }, () => new Array(W).fill(0))
export const cloneBoard = (b) => b.map((row) => row.slice())

export function collide(board, type, rot, x, y) {
  for (const [dx, dy] of SHAPES[type][rot]) {
    const cx = x + dx, cy = y + dy
    if (cx < 0 || cx >= W || cy >= H) return true
    if (cy >= 0 && board[cy][cx]) return true
  }
  return false
}

export function dropRow(board, type, rot, x, y) {
  while (!collide(board, type, rot, x, y + 1)) y++
  return y
}

export function extent(type, rot) {
  let minX = 9, maxX = 0
  for (const [dx] of SHAPES[type][rot]) { if (dx < minX) minX = dx; if (dx > maxX) maxX = dx }
  return { minX, maxX }
}

/** Remove full rows. Returns the row indexes that were full (top to bottom). */
export function clearLines(board) {
  const cleared = []
  for (let y = 0; y < H; y++) if (board[y].every((c) => c)) cleared.push(y)
  for (const y of cleared) { board.splice(y, 1); board.unshift(new Array(W).fill(0)) }
  return cleared
}

/** Column heights, holes, bumpiness and wells of a board. */
export function measure(board) {
  const heights = new Array(W).fill(0)
  let holes = 0
  for (let x = 0; x < W; x++) {
    let seen = false
    for (let y = 0; y < H; y++) {
      if (board[y][x]) { if (!seen) { heights[x] = H - y; seen = true } } else if (seen) holes++
    }
  }
  return { heights, holes, ...surface(heights) }
}

/** Facts that follow from column heights alone. A well is a column 2+ lower than both sides. */
export function surface(heights) {
  let total = 0, max = 0, bump = 0, wells = 0, deepest = 0, deepestCol = -1
  for (let x = 0; x < W; x++) {
    const h = heights[x]
    total += h
    if (h > max) max = h
    if (x < W - 1) bump += Math.abs(h - heights[x + 1])
    const left = x === 0 ? H : heights[x - 1], right = x === W - 1 ? H : heights[x + 1]
    const depth = Math.min(left, right) - h
    if (depth >= 2) wells++
    if (depth > deepest) { deepest = depth; deepestCol = x }
  }
  return { total, max, bump, wells, deepest, deepestCol }
}

/** How ragged the stack is: filled/empty changes along rows and down columns (walls and floor count as filled). */
export function breaks(board) {
  let rowBreaks = 0, colBreaks = 0
  for (let y = 0; y < H; y++) {
    let prev = 1
    for (let x = 0; x < W; x++) { const c = board[y][x] ? 1 : 0; if (c !== prev) rowBreaks++; prev = c }
    if (!prev) rowBreaks++
  }
  for (let x = 0; x < W; x++) {
    let prev = 0
    for (let y = 0; y < H; y++) { const c = board[y][x] ? 1 : 0; if (c !== prev) colBreaks++; prev = c }
    if (!prev) colBreaks++
  }
  return { rowBreaks, colBreaks }
}

/**
 * Every legal placement of `type`: each rotation in each column it can slide to along its spawn
 * row, dropped straight down. Returns [{ id, rot, x, y, col0, col1, moves, lines, holes, ... }].
 */
export function enumerate(board, type) {
  const out = []
  const sp = spawnOf(type)
  const before = measure(board)
  for (let rot = 0; rot < SHAPES[type].length; rot++) {
    if (collide(board, type, rot, sp.x, sp.y)) continue
    const { minX, maxX } = extent(type, rot)
    const presses = rotationPath(type, rot).length
    for (const dir of [-1, 1]) {
      for (let x = dir < 0 ? sp.x : sp.x + 1; x + minX >= 0 && x + maxX < W; x += dir) {
        if (collide(board, type, rot, x, sp.y)) break // the stack is in the way along the top row
        const y = dropRow(board, type, rot, x, sp.y)
        const after = cloneBoard(board)
        let above = false
        for (const [dx, dy] of SHAPES[type][rot]) { if (y + dy < 0) above = true; else after[y + dy][x + dx] = CODE[type] }
        let top = H, bottom = 0
        for (const [, dy] of SHAPES[type][rot]) { top = Math.min(top, y + dy); bottom = Math.max(bottom, y + dy) }
        const lines = clearLines(after).length
        const m = measure(after)
        out.push({
          id: `r${rot}c${x + minX}`, rot, x, y, col0: x + minX, col1: x + maxX,
          moves: presses + Math.abs(x - sp.x), lines, holes: m.holes, newHoles: m.holes - before.holes,
          heights: m.heights, max: m.max, total: m.total, bump: m.bump, wells: m.wells, above,
          landing: H - 1 - (top + bottom) / 2, ...breaks(after),
        })
      }
    }
  }
  out.sort((a, b) => a.rot - b.rot || a.x - b.x)
  return out
}

/** One short factual line per placement. This is the option description Jev reads. */
export function describePlacement(type, c) {
  const sign = c.newHoles > 0 ? `+${c.newHoles}` : String(c.newHoles)
  return `${type} rotation ${c.rot} over columns ${c.col0}-${c.col1}, lands at height ${c.landing}: clears ${c.lines} lines, holes ${c.holes} (${sign}), ` +
    `heights ${c.heights.join(',')}, max ${c.max}, bumpiness ${c.bump}, wells ${c.wells}, row breaks ${c.rowBreaks}, column breaks ${c.colBreaks}, ${c.moves} moves` +
    (c.above ? ', sticks out over the top' : '')
}

export function boardRows(board) {
  return board.map((row, y) => `${String(H - 1 - y).padStart(2)} |${row.map((c) => (c ? '#' : '.')).join('')}|`)
}

/** The shared state block: style line, the well as ASCII, the pieces, the clock, the placements. */
export function buildState({ style, board, type, next, level, lines, gravity, decisionMs, moveMs, cands }) {
  const m = measure(board)
  const table = cands.map((c) => `${c.id.padEnd(5)} ${`${c.col0}-${c.col1}`.padEnd(4)} ${String(c.lines).padEnd(5)} ${String(c.holes).padEnd(5)} ${String(c.max).padEnd(3)} ${String(c.bump).padEnd(4)} ${c.moves}`)
  return [
    String(style || '').trim(),
    '',
    `Falling-blocks puzzle, a synthetic game. The well is ${W} columns (0-${W - 1}) by ${H} rows. '#' is filled, '.' is empty. Top row first.`,
    '    0123456789',
    ...boardRows(board),
    `Column heights: ${m.heights.join(' ')}`,
    `Stack: max height ${m.max}, holes ${m.holes}, bumpiness ${m.bump}, deepest well ${m.deepest}${m.deepestCol >= 0 ? ` at column ${m.deepestCol}` : ''}.`,
    `Current piece: ${type}. Next pieces: ${next.join(', ')}.`,
    `Level ${level}, lines ${lines}. Gravity ${gravity.toFixed(1)} rows per second. A decision costs about ${Math.round(decisionMs)} ms, then each rotate or shift costs ${Math.round(moveMs)} ms while the piece keeps falling.`,
    'Placements (id = rotation r, leftmost column c):',
    'id    cols lines holes max bump moves',
    ...table,
  ].join('\n')
}

export const DANGER_LEVELS = [
  'safe: the stack sits in the bottom third of the well',
  'building: the stack is near the middle of the well',
  'high: the stack is in the upper half and has holes',
  'critical: about to top out',
]

export function buildQuestions(type, cands) {
  const options = {}
  for (const c of cands) options[c.id] = describePlacement(type, c)
  return {
    place: { type: 'choice', instructions: `Which placement of the ${type} piece keeps the stack lowest, flattest and free of holes?`, options: Object.keys(options), descriptions: options },
    danger: { type: 'score', instructions: 'How close is the stack to topping out?', legend: Object.fromEntries(DANGER_LEVELS.map((l, i) => [String(i), l])) },
    go_for_four: { type: 'noul', instructions: 'Is it worth keeping one column open for an I piece to clear four lines at once?', criteria: { true: 'the stack is low and clean, and there is time to wait', false: 'the stack is high, has holes, or the piece falls too fast' } },
  }
}

// ---------------------------------------------------------------------------
// The offline reader. Parses the state text and the option descriptions, nothing else.
// ---------------------------------------------------------------------------
const WELL_COL = W - 1
/** Weights of the offline reader's stack score. */
export const TUNE = {
  landing: 4.5, cleared: 3.42, rowBreaks: 3.22, colBreaks: 9.35, holeCost: 7.9, wellSum: 3.39, wellCap: 3,
  wellHit: 40, four: 60, skim: 8, planMax: 8, planHoles: 0, panic: 13, calmGravity: 14, late: 12, gapScale: 8,
}

export function readState(text) {
  const rows = []
  for (const m of text.matchAll(/^\s*\d+ \|([.#]{10})\|$/gm)) rows.push(m[1])
  const board = emptyBoard()
  rows.slice(-H).forEach((r, i, all) => { const y = H - all.length + i; for (let x = 0; x < W; x++) board[y][x] = r[x] === '#' ? 1 : 0 })
  const num = (re, d) => { const m = text.match(re); return m ? Number(m[1]) : d }
  const next = (text.match(/Next pieces: ([A-Z, ]+)\./)?.[1] ?? '').split(/,\s*/).filter(Boolean)
  return {
    board, m: measure(board),
    type: text.match(/Current piece: ([A-Z])/)?.[1] ?? '',
    next,
    gravity: num(/Gravity ([\d.]+) rows per second/, 1),
    decisionMs: num(/decision costs about (\d+) ms/, 110),
    moveMs: num(/shift costs (\d+) ms/, 35),
    style: text.split('\n\n')[0] ?? '',
  }
}

/**
 * Should we keep the right-hand column open for an I piece? `place` and `go_for_four` cannot see
 * each other, so both read the same facts from the state text and reach the same plan.
 */
export function fourPlan(s) {
  const left = s.m.heights.slice(0, WELL_COL)
  const maxLeft = Math.max(...left), minLeft = Math.min(...left)
  let holesLeft = 0 // holes outside the open column
  for (let x = 0; x < WELL_COL; x++) { let seen = false; for (let y = 0; y < H; y++) { if (s.board[y][x]) seen = true; else if (seen) holesLeft++ } }
  let wellHoles = 0
  { let seen = false; for (let y = 0; y < H; y++) { if (s.board[y][WELL_COL]) seen = true; else if (seen) wellHoles++ } }
  const wants = /\bfour\b/i.test(s.style) && !/\b(never|no|avoid|without|not)\b[^.]*\bfour\b/i.test(s.style)
  const calm = s.gravity <= TUNE.calmGravity
  const clean = holesLeft <= TUNE.planHoles && wellHoles === 0 && s.m.heights[WELL_COL] <= minLeft
  const panic = maxLeft >= TUNE.panic
  const high = maxLeft > TUNE.planMax
  const iSoon = s.type === 'I' || s.next.includes('I')
  const on = wants && calm && clean && !panic
  let z = -2.4
  if (wants) z += 1.2
  if (calm) z += 1.0; else z -= 2.0
  if (clean) z += 1.6; else z -= 1.6
  if (high) z -= 1.0; else z += 0.8
  if (panic) z -= 2.5
  if (iSoon) z += 0.5
  const p = 1 / (1 + Math.exp(-z))
  return { on, high, depth: minLeft - s.m.heights[WELL_COL], p: Math.min(0.97, Math.max(0.03, p)), maxLeft }
}

function parseOption(desc) {
  const n = (re) => { const m = desc.match(re); return m ? Number(m[1]) : 0 }
  const heights = (desc.match(/heights ([\d,]+)/)?.[1] ?? '').split(',').filter(Boolean).map(Number)
  const cols = desc.match(/columns (\d+)-(\d+)/)
  return {
    lines: n(/clears (\d+) lines/), holes: n(/holes (\d+)/), newHoles: Number(desc.match(/holes \d+ \(([+-]?\d+)\)/)?.[1] ?? 0), moves: n(/, (\d+) moves/),
    landing: n(/lands at height ([\d.]+)/), rowBreaks: n(/row breaks (\d+)/), colBreaks: n(/column breaks (\d+)/),
    heights: heights.length === W ? heights : new Array(W).fill(0),
    col0: cols ? Number(cols[1]) : 0, col1: cols ? Number(cols[2]) : 0,
    above: /sticks out over the top/.test(desc),
  }
}

/**
 * A sound, well-known stack score (landing height, lines, row and column breaks, holes, well depth).
 * With the four-line plan on, the right-hand column is left out and guarded.
 */
function stackScore(o, plan, s) {
  const n = plan.on ? WELL_COL : W
  let wellSum = 0
  for (let x = 0; x < n; x++) {
    const h = o.heights[x]
    const left = x === 0 ? H : o.heights[x - 1], right = x === n - 1 ? H : o.heights[x + 1]
    const depth = Math.min(left, right) - h
    if (depth > 0) { const d = Math.min(depth, TUNE.wellCap); wellSum += (d * (d + 1)) / 2 + (depth - d) }
  }
  let v = -TUNE.landing * o.landing + TUNE.cleared * o.lines - TUNE.rowBreaks * o.rowBreaks - TUNE.colBreaks * o.colBreaks - TUNE.holeCost * o.holes - TUNE.wellSum * wellSum
  if (plan.on && o.col1 >= WELL_COL) {
    // The open column is for the I piece. When the stack is high, a clean skim off its top is fine too.
    if (o.lines >= 4) v += TUNE.four
    else if (plan.high && o.lines >= 1 && o.newHoles <= 0) v += TUNE.skim * o.lines
    else v -= TUNE.wellHit
  }
  if (o.above) v -= 400
  // Time: a far placement is no good if the piece lands before it gets there.
  const needMs = s.decisionMs + (o.moves + 1) * s.moveMs
  const rowsFree = Math.max(1, H - 2 - s.m.max)
  const haveMs = (rowsFree / Math.max(0.2, s.gravity)) * 1000
  if (needMs > haveMs) v -= TUNE.late * ((needMs - haveMs) / Math.max(1, s.moveMs))
  return v
}

function spread(scores, floorTop = 0.5, capTop = 0.85) {
  const sorted = [...scores].sort((a, b) => b - a)
  const gap = sorted.length > 1 ? sorted[0] - sorted[1] : 9
  const target = Math.min(capTop, Math.max(floorTop, floorTop + (capTop - floorTop) * (1 - Math.exp(-gap / TUNE.gapScale))))
  const best = Math.max(...scores)
  const soft = (t) => { const e = scores.map((v) => Math.exp((v - best) / t)); const sum = e.reduce((a, b) => a + b, 0); return e.map((v) => v / sum) }
  let lo = 0.01, hi = 200
  for (let i = 0; i < 48; i++) { const mid = Math.sqrt(lo * hi); if (Math.max(...soft(mid)) > target) lo = mid; else hi = mid }
  return soft(hi)
}

export function blocksMock(text, id, q) {
  const s = readState(text)
  if (!s.type) return null
  const plan = fourPlan(s)

  if (id === 'place' && q.type === 'choice' && q.options?.length) {
    const scores = q.options.map((opt) => stackScore(parseOption(String(q.descriptions?.[opt] ?? '')), plan, s))
    const probs = spread(scores)
    const probabilities = {}
    q.options.forEach((opt, i) => (probabilities[opt] = probs[i]))
    const bi = probs.indexOf(Math.max(...probs))
    return { type: 'choice', choice: q.options[bi], confidence: probs[bi], probabilities }
  }

  if (id === 'danger' && q.type === 'score') {
    const n = q.levels?.length || DANGER_LEVELS.length
    const pos = Math.min(n - 1, Math.max(0, ((s.m.max - 4) / 13) * (n - 1) + Math.min(0.6, s.m.holes * 0.06)))
    const raw = Array.from({ length: n }, (_, i) => Math.exp(-((i - pos) ** 2) / 0.55))
    const sum = raw.reduce((a, b) => a + b, 0)
    const probabilities = {}
    raw.forEach((v, i) => (probabilities[String(i)] = v / sum))
    const score = raw.reduce((acc, v, i) => acc + (v / sum) * i, 0)
    return { type: 'score', score, confidence: Math.max(...raw) / sum, legend: q.legend, probabilities }
  }

  if (id === 'go_for_four' && q.type === 'noul') return { type: 'noul', noul: plan.p }
  return null
}
