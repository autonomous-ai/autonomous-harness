// game.mjs — Reversi rules and the text Jev reads. Pure logic: no I/O, no timers, no randomness.
//
// The honest dial is `insight`, per player: how much the text tells Jev about each legal move.
//   0  the move and how many disks it flips
//   1  plus where the square sits (corner, edge, next to an open corner)
//   2  plus what the rival can do in reply (best reply, a corner handed over, moves left)
// A player that reads more plays better. Nothing random is added.

export const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]
export const other = (d) => (d === 'O' ? 'X' : 'O')

export const DEFAULT = {
  title: 'Jev vs Jev',
  description: 'A Reversi duel between two minds, with a third one as referee.',
  size: 6,
  speed: 700,
  rivals: {
    O: { name: 'Jev·O', personality: 'A patient, positional player who loves the corners.', insight: 2 },
    X: { name: 'Jev·X', personality: 'A greedy opportunist who grabs flips and attacks the center.', insight: 2 },
  },
  referee: 'Call it fairly: is the move strong, is it aggressive, how decided is the game?',
}

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

/** Keep a wild battle.json from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  let size = Math.round(num(raw.size, 4, 12, DEFAULT.size))
  if (size % 2) size += 1
  const rival = (d) => {
    const r = raw.rivals?.[d] ?? {}, def = DEFAULT.rivals[d]
    return {
      name: String(r.name ?? def.name).slice(0, 40) || def.name,
      personality: String(r.personality ?? def.personality).replace(/\s+/g, ' ').slice(0, 500),
      insight: Math.round(num(r.insight, 0, 2, 2)),
    }
  }
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    size, speed: Math.round(num(raw.speed, 60, 5000, DEFAULT.speed)),
    rivals: { O: rival('O'), X: rival('X') },
    referee: String(raw.referee ?? DEFAULT.referee).replace(/\s+/g, ' ').slice(0, 400),
  }
}

export function newBoard(n) {
  const b = Array.from({ length: n }, () => Array(n).fill('.'))
  const h = n / 2
  b[h - 1][h - 1] = 'O'; b[h - 1][h] = 'X'; b[h][h - 1] = 'X'; b[h][h] = 'O'
  return b
}
export const clone = (b) => b.map((r) => r.slice())

/** The disks a move would turn, nearest first, so the pane can flip them one after the other. */
export function flipsFor(b, x, y, me) {
  const n = b.length, them = other(me), out = []
  if (b[y]?.[x] !== '.') return out
  for (const [dx, dy] of DIRS) {
    let nx = x + dx, ny = y + dy
    const chain = []
    while (nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === them) { chain.push([nx, ny]); nx += dx; ny += dy }
    if (chain.length && nx >= 0 && ny >= 0 && nx < n && ny < n && b[ny][nx] === me) out.push(...chain)
  }
  return out.sort((p, q) => Math.max(Math.abs(p[0] - x), Math.abs(p[1] - y)) - Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y)))
}

export function legalMoves(b, me) {
  const out = []
  for (let y = 0; y < b.length; y++) for (let x = 0; x < b.length; x++) {
    const f = flipsFor(b, x, y, me).length
    if (f) out.push({ x, y, flips: f })
  }
  return out
}

export function applyMove(b, x, y, me) {
  const turned = flipsFor(b, x, y, me)
  b[y][x] = me
  for (const [cx, cy] of turned) b[cy][cx] = me
  return turned
}

export function count(b) {
  let O = 0, X = 0
  for (const r of b) for (const c of r) { if (c === 'O') O++; else if (c === 'X') X++ }
  return { O, X }
}

const isCorner = (n, x, y) => (x === 0 || x === n - 1) && (y === 0 || y === n - 1)
const isEdge = (n, x, y) => x === 0 || y === 0 || x === n - 1 || y === n - 1
/** Next to a corner that is still empty: the classic way to hand the corner over. */
function nearOpenCorner(b, x, y) {
  const n = b.length
  for (const [cx, cy] of [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1]])
    if (b[cy][cx] === '.' && Math.max(Math.abs(cx - x), Math.abs(cy - y)) === 1) return true
  return false
}

/** Everything the text can say about one move. What is actually written depends on `insight`. */
export function describeMove(b, m, me) {
  const n = b.length
  const after = clone(b)
  applyMove(after, m.x, m.y, me)
  const replies = legalMoves(after, other(me))
  return {
    ...m,
    corner: isCorner(n, m.x, m.y), edge: !isCorner(n, m.x, m.y) && isEdge(n, m.x, m.y), risky: !isCorner(n, m.x, m.y) && nearOpenCorner(b, m.x, m.y),
    replyBest: replies.reduce((a, r) => Math.max(a, r.flips), 0),
    givesCorner: replies.some((r) => isCorner(n, r.x, r.y)),
    replyCount: replies.length,
  }
}

export function moveLine(d, insight) {
  let s = `  ${d.x},${d.y} flips ${d.flips}`
  if (insight >= 1) s += d.corner ? ' · corner' : d.risky ? ' · next to an open corner' : d.edge ? ' · edge' : ' · inner square'
  if (insight >= 2) s += ` · rival's best reply flips ${d.replyBest} · ${d.givesCorner ? 'hands your rival a corner' : 'no corner for your rival'} · leaves your rival ${d.replyCount} moves`
  return s
}

const boardText = (b) => b.map((r) => r.join('')).join('\n')

/** What the player to move reads. */
export function sideState(cfg, board, disk, moves) {
  const me = cfg.rivals[disk], rival = cfg.rivals[other(disk)], c = count(board)
  const reads = ['Each move is listed with the disks it flips.', 'Each move is listed with the disks it flips and where the square sits.', 'Each move is listed with the disks it flips, where the square sits, and what your rival can do in reply.'][me.insight]
  return `Two rivals are playing a live game of Reversi (Othello) on a ${cfg.size}x${cfg.size} board.
You are ${me.name}, playing ${disk}. ${me.personality}
Your rival is ${rival.name}, playing ${other(disk)}.

The board, '.' empty, O and X are claimed disks:
you play ${disk}
${boardText(board)}

Legal moves and the disks each flips. ${reads}
${moves.map((m) => moveLine(describeMove(board, m, disk), me.insight)).join('\n')}

Current score: O ${c.O}, X ${c.X}. Empty squares: ${cfg.size * cfg.size - c.O - c.X}.

Choose the move that best serves your personality and wins the game. Only play a move from the list.`
}

/** What the referee reads, just after a move. */
export function refState(cfg, board, move, disk) {
  const c = count(board), d = move.detail
  const where = d.corner ? 'a corner' : d.risky ? 'next to an open corner' : d.edge ? 'an edge square' : 'an inner square'
  return `You are the referee of a live Reversi battle between ${cfg.rivals.O.name} (O) and ${cfg.rivals.X.name} (X).

${cfg.rivals[disk].name} (${disk}) just played ${move.x},${move.y}, flipping ${move.flips} disks. That square is ${where}.
The rival can now flip at most ${d.replyBest} disks in reply, has ${d.replyCount} moves, and ${d.givesCorner ? 'can take a corner next' : 'cannot take a corner next'}.

The board now:
${boardText(board)}

Score: O ${c.O}, X ${c.X}. Empty squares: ${cfg.size * cfg.size - c.O - c.X} of ${cfg.size * cfg.size}.

Referee focus: ${cfg.referee}`
}
