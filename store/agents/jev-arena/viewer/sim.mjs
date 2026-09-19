// sim.mjs — the arena world. Pure logic: no I/O, no timers, every random choice comes from a seed.
//
// The hero only knows what it has seen. It sees `sight` cells around itself and remembers them.
// Each decision the world is written out as text (the grid with `?` for floor it has not seen, plus
// how many steps each move leaves to the nearest coin and to the goal, counting `?` as open floor).
// Jev reads that text and picks a move. With a short sight the numbers point through walls the hero
// has not seen yet, so it walks into dead ends and has to back out. That is the honest dial.

export const ACTIONS = ['up', 'down', 'left', 'right', 'wait']
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], wait: [0, 0] }
export const SEE_ALL = 99

export const DEFAULT = {
  title: 'Jev Arena',
  description: 'A small living grid world. Jev decides every move.',
  size: 12,
  hero: { x: 1, y: 1 },
  goal: { x: 10, y: 10 },
  walls: [],
  coins: [{ x: 6, y: 6 }],
  rules: 'Collect the coins, then reach the goal. Move one cell at a time. Walls block the way.',
  speed: 300, // ms per decision
  sight: 4, // cells the hero can see around itself; 99 means the whole board
  remix: true, // after each run, build a fresh layout from the seed (false replays this one)
  seed: 7,
}

const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const cell = (p, w, h) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
  ? { x: int(p.x, 0, w - 1, 0), y: int(p.y, 0, h - 1, 0) } : null

/** Keep a wild arena.json from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const size = int(raw.size, 2, 32, DEFAULT.size)
  const w = int(raw.width ?? size, 2, 32, size), h = int(raw.height ?? size, 2, 32, size)
  const hero = cell(raw.hero, w, h) ?? cell(DEFAULT.hero, w, h)
  let goal = cell(raw.goal, w, h) ?? { x: w - 1, y: h - 1 }
  if (goal.x === hero.x && goal.y === hero.y) goal = { x: w - 1 - hero.x, y: h - 1 - hero.y }
  const taken = new Set([`${hero.x},${hero.y}`, `${goal.x},${goal.y}`])
  const list = (arr, max) => {
    const out = []
    for (const p of Array.isArray(arr) ? arr : []) {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue
      const k = `${p.x},${p.y}`
      if (taken.has(k)) continue
      taken.add(k); out.push({ x: p.x, y: p.y })
      if (out.length >= max) break
    }
    return out
  }
  const walls = list(raw.walls, 1024)
  const coins = list(raw.coins ?? DEFAULT.coins, 60)
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    rules: String(raw.rules ?? DEFAULT.rules).slice(0, 400),
    w, h, hero, goal, walls, coins,
    speed: int(raw.speed, 60, 2000, DEFAULT.speed),
    sight: int(raw.sight, 1, SEE_ALL, DEFAULT.sight),
    remix: raw.remix !== false,
    seed: int(raw.seed, 0, 1e9, DEFAULT.seed),
    density: raw.density == null ? null : Math.max(0, Math.min(0.4, Number(raw.density) || 0)),
  }
}

/** Deterministic PRNG so every layout can be replayed from its seed. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Steps from every cell to the nearest source. `blocked(i)` says which cells cannot be entered. */
function distMap(w, h, sources, blocked) {
  const d = new Int16Array(w * h).fill(-1)
  const q = []
  for (const s of sources) { const i = s.y * w + s.x; if (!blocked(i) && d[i] < 0) { d[i] = 0; q.push(i) } }
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w, y = (i - x) / w
    if (x > 0 && d[i - 1] < 0 && !blocked(i - 1)) { d[i - 1] = d[i] + 1; q.push(i - 1) }
    if (x < w - 1 && d[i + 1] < 0 && !blocked(i + 1)) { d[i + 1] = d[i] + 1; q.push(i + 1) }
    if (y > 0 && d[i - w] < 0 && !blocked(i - w)) { d[i - w] = d[i] + 1; q.push(i - w) }
    if (y < h - 1 && d[i + w] < 0 && !blocked(i + w)) { d[i + w] = d[i] + 1; q.push(i + w) }
  }
  return d
}

const openCount = (wall) => { let n = 0; for (const v of wall) if (!v) n++; return n }
function allConnected(wall, w, h, from) {
  const d = distMap(w, h, [from], (i) => wall[i] === 1)
  let reach = 0
  for (const v of d) if (v >= 0) reach++
  return reach === openCount(wall)
}

/**
 * Build a layout from a seed. Start from a maze (rooms on the even cells, carved by a random walk),
 * then knock walls out at random until only `nWalls` are left. Taking walls away can never cut the
 * floor in two, so every coin and the goal can always be reached. Few walls leave bars and pockets;
 * many walls leave a real maze.
 */
export function generate({ w, h, hero, goal, nWalls, nCoins, rng }) {
  const wall = new Uint8Array(w * h).fill(1)
  const pick = (n) => Math.floor(rng() * n)
  const at = (x, y) => y * w + x
  const rw = Math.ceil(w / 2), rh = Math.ceil(h / 2)
  const seenRoom = new Uint8Array(rw * rh)
  const stack = [[pick(rw), pick(rh)]]
  seenRoom[stack[0][1] * rw + stack[0][0]] = 1
  wall[at(stack[0][0] * 2, stack[0][1] * 2)] = 0
  while (stack.length) {
    const [rx, ry] = stack[stack.length - 1]
    const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [rx + dx, ry + dy, dx, dy])
      .filter(([x, y]) => x >= 0 && y >= 0 && x < rw && y < rh && !seenRoom[y * rw + x])
    if (!next.length) { stack.pop(); continue }
    const [nx, ny, dx, dy] = next[pick(next.length)]
    seenRoom[ny * rw + nx] = 1
    wall[at(rx * 2 + dx, ry * 2 + dy)] = 0
    wall[at(nx * 2, ny * 2)] = 0
    stack.push([nx, ny])
  }
  // The hero and the goal always stand on floor that joins the rest.
  for (const p of [hero, goal]) {
    wall[at(p.x, p.y)] = 0
    if (p.x % 2 === 1) wall[at(p.x - 1, p.y)] = 0
    if (p.y % 2 === 1) wall[at(p.x - (p.x % 2), p.y - 1)] = 0
  }
  const left = []
  for (let i = 0; i < w * h; i++) if (wall[i]) left.push(i)
  for (let k = left.length - 1; k > 0; k--) { const j = pick(k + 1); [left[k], left[j]] = [left[j], left[k]] }
  for (let k = 0; k < left.length - nWalls; k++) wall[left[k]] = 0
  const free = (x, y) => !(x === hero.x && y === hero.y) && !(x === goal.x && y === goal.y)
  let tries = 0
  const coins = []
  while (coins.length < nCoins && tries++ < 600) {
    const x = Math.floor(rng() * w), y = Math.floor(rng() * h)
    if (wall[y * w + x] || !free(x, y)) continue
    const gap = tries < 300 ? 3 : 1
    if (coins.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < gap)) continue
    coins.push({ x, y })
  }
  return { wall, coins }
}

/** A far-away goal for the next layout, so the hero always has somewhere to go. */
function farGoal(w, h, hero, rng) {
  const cells = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x, y, d: Math.abs(x - hero.x) + Math.abs(y - hero.y) })
  cells.sort((a, b) => b.d - a.d)
  const pool = cells.slice(0, Math.max(1, Math.floor(cells.length * 0.12)))
  const g = pool[Math.floor(rng() * pool.length)]
  return { x: g.x, y: g.y }
}

/**
 * Start an episode. Episode 0 (and every episode when remix is off) is the layout in arena.json.
 * Later episodes are built from seed + episode, and the hero carries on from where it stands.
 */
export function createWorld(cfg, episode = 0, from = null, forceFresh = false) {
  const { w, h } = cfg
  const fresh = forceFresh || (episode > 0 && cfg.remix)
  const nWallsCfg = cfg.density == null ? cfg.walls.length : Math.round(cfg.density * w * h)
  let hero, goal, wall, coins
  if (fresh || (cfg.density != null)) {
    const rng = mulberry32((cfg.seed + episode * 7919) >>> 0)
    hero = from && from.x < w && from.y < h ? { x: from.x, y: from.y } : { ...cfg.hero }
    goal = fresh ? farGoal(w, h, hero, rng) : { ...cfg.goal }
    if (goal.x === hero.x && goal.y === hero.y) goal = farGoal(w, h, hero, rng)
    const made = generate({ w, h, hero, goal, nWalls: Math.min(nWallsCfg, Math.floor(w * h * 0.4)), nCoins: cfg.coins.length, rng })
    wall = made.wall; coins = made.coins
  } else {
    hero = { ...cfg.hero }; goal = { ...cfg.goal }
    wall = new Uint8Array(w * h)
    for (const p of cfg.walls) wall[p.y * w + p.x] = 1
    coins = cfg.coins.map((c) => ({ ...c }))
  }
  const world = {
    w, h, wall, coins, hero, goal, start: { ...hero },
    memory: new Uint8Array(w * h), // 0 not seen, 1 floor, 2 wall
    trail: [], lastMove: 'wait', moves: 0, bumps: 0, coinsCollected: 0, coinsTotal: coins.length,
    status: 'play', result: null, rest: 0, episode, seed: cfg.seed + episode * 7919,
    maxMoves: Math.max(60, Math.round(w * h * 1.5)), par: 0,
  }
  look(world, cfg.sight)
  world.par = Math.max(0, tourLength(world, hero))
  return world
}

/** Mark what the hero can see right now, and remember it. */
export function look(world, sight) {
  const { w, h, hero, wall, memory } = world
  if (sight >= SEE_ALL) { for (let i = 0; i < w * h; i++) memory[i] = wall[i] ? 2 : 1; return }
  const r2 = (sight + 0.5) * (sight + 0.5)
  for (let y = Math.max(0, hero.y - sight); y <= Math.min(h - 1, hero.y + sight); y++)
    for (let x = Math.max(0, hero.x - sight); x <= Math.min(w - 1, hero.x + sight); x++)
      if ((x - hero.x) ** 2 + (y - hero.y) ** 2 <= r2) memory[y * w + x] = wall[y * w + x] ? 2 : 1
}

/** The shortest tour on the real map: nearest coin first, then the goal. -1 when the goal is cut off. */
export function tourLength(world, from) {
  const { w, h, wall } = world
  const goalAt = world.goal.y * w + world.goal.x
  const blocked = (i) => wall[i] === 1
  const offGoal = (i) => i === goalAt || wall[i] === 1
  let pos = { ...from }, total = 0
  const left = world.coins.map((c) => ({ ...c }))
  while (left.length) {
    const d = distMap(w, h, [pos], offGoal)
    let best = -1, bestD = Infinity
    left.forEach((c, k) => { const v = d[c.y * w + c.x]; if (v >= 0 && v < bestD) { bestD = v; best = k } })
    if (best < 0) break
    total += bestD; pos = left[best]; left.splice(best, 1)
  }
  const d = distMap(w, h, [world.goal], blocked)[pos.y * w + pos.x]
  return d < 0 ? -1 : total + d
}

/**
 * What Jev reads, plus the same numbers for the pane: steps left after each move through the floor
 * the hero knows about, and the route those numbers point along.
 */
export function observe(world, cfg) {
  look(world, cfg.sight)
  const { w, h, hero, goal, coins, memory } = world
  const blocked = (i) => memory[i] === 2
  const toGoal = distMap(w, h, [goal], blocked)
  // While coins are left the hero keeps off the goal cell, because stepping on it ends the run.
  const goalAt = goal.y * w + goal.x
  const toCoin = coins.length ? distMap(w, h, coins, (i) => i === goalAt || blocked(i)) : null
  const steps = (d) => {
    const out = {}
    for (const a of ACTIONS) {
      const x = hero.x + DIRS[a][0], y = hero.y + DIRS[a][1]
      if (x < 0 || y < 0 || x >= w || y >= h || memory[y * w + x] === 2) out[a] = 'wall'
      else out[a] = d && d[y * w + x] >= 0 ? d[y * w + x] : 'none'
    }
    return out
  }
  const goalSteps = steps(toGoal), coinSteps = steps(toCoin)
  const coinOpen = coins.length > 0 && Number.isFinite(coinSteps.wait)
  const goalOpen = Number.isFinite(goalSteps.wait)
  const rows = []
  for (let y = 0; y < h; y++) {
    let row = ''
    for (let x = 0; x < w; x++) {
      const m = memory[y * w + x]
      if (x === hero.x && y === hero.y) row += '@'
      else if (x === goal.x && y === goal.y) row += 'G'
      else if (coins.some((c) => c.x === x && c.y === y)) row += '$'
      else row += m === 2 ? '#' : m === 1 ? '.' : '?'
    }
    rows.push(row)
  }
  const line = (s) => ACTIONS.map((a) => `${a} ${s[a]}`).join(', ')
  const text = [
    'You are @ on a grid. # is a wall, $ is a coin, G is the goal, . is open floor, ? is floor you have not seen yet.',
    cfg.sight >= SEE_ALL ? 'You can see the whole board.' : `You see ${cfg.sight} cells around you and remember what you saw.`,
    rows.join('\n'),
    `You are at (${hero.x},${hero.y}). The goal is at (${goal.x},${goal.y}). Coins left: ${coins.length}${coins.length ? ' at ' + coins.map((c) => `(${c.x},${c.y})`).join(' ') : ''}.`,
    `Your last move: ${world.lastMove}.`,
    coins.length ? `Steps to the nearest coin after each move, counting ? as open: ${line(coinSteps)}.` : 'Steps to the nearest coin after each move: no coins left.',
    `Steps to the goal after each move, counting ? as open: ${line(goalSteps)}.`,
  ].join('\n')
  // The route the numbers point along (for the pane): walk downhill on the map Jev is heading for.
  const d = coinOpen ? toCoin : goalOpen ? toGoal : null
  const plan = []
  if (d) {
    let x = hero.x, y = hero.y
    for (let k = 0; k < 80 && d[y * w + x] > 0; k++) {
      const here = d[y * w + x]
      const next = [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => [x + dx, y + dy])
        .find(([nx, ny]) => nx >= 0 && ny >= 0 && nx < w && ny < h && d[ny * w + nx] === here - 1)
      if (!next) break
      x = next[0]; y = next[1]; plan.push([x, y])
    }
  }
  return { text, goalSteps, coinSteps, heading: coinOpen ? 'coin' : goalOpen ? 'goal' : 'none', plan }
}

/** Apply one move. Returns what happened, for the pane. */
export function act(world, action) {
  if (world.status !== 'play') return null
  const [dx, dy] = DIRS[action] ?? DIRS.wait
  const from = { ...world.hero }
  const x = from.x + dx, y = from.y + dy
  const blocked = x < 0 || y < 0 || x >= world.w || y >= world.h || world.wall[y * world.w + x] === 1
  const ev = { move: action, from, to: from, bumped: false, coin: null }
  world.moves++
  world.lastMove = action
  if (blocked) { world.bumps++; ev.bumped = true } else if (dx || dy) {
    world.hero = { x, y }; ev.to = { x, y }
    world.trail.push([from.x, from.y]); if (world.trail.length > 48) world.trail.shift()
    const k = world.coins.findIndex((c) => c.x === x && c.y === y)
    if (k >= 0) { world.coins.splice(k, 1); world.coinsCollected++; ev.coin = { x, y } }
    if (x === world.goal.x && y === world.goal.y) finish(world, 'won')
  }
  if (world.status === 'play' && world.moves >= world.maxMoves) finish(world, 'timeout')
  return ev
}

export function finish(world, status) {
  world.status = status
  world.result = { status, moves: world.moves, par: world.par, coins: world.coinsCollected, coinsTotal: world.coinsTotal }
}

/** True when the hero knows there is nothing left it can reach. Unseen floor counts as open, so this is never a false alarm. */
export function walledIn(o) { return o.heading === 'none' }

// ---- things a person can do to the world -------------------------------------------------------
const inside = (world, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < world.w && y < world.h
const isHero = (world, x, y) => world.hero.x === x && world.hero.y === y
const isGoal = (world, x, y) => world.goal.x === x && world.goal.y === y

function reprice(world) { const t = tourLength(world, world.hero); if (t >= 0) world.par = world.moves + t }

export function toggleWall(world, x, y) {
  if (world.status !== 'play' || !inside(world, x, y) || isHero(world, x, y) || isGoal(world, x, y)) return false
  if (world.coins.some((c) => c.x === x && c.y === y)) return false
  const i = y * world.w + x
  world.wall[i] = world.wall[i] ? 0 : 1
  reprice(world)
  return true
}
export function toggleCoin(world, x, y) {
  if (world.status !== 'play' || !inside(world, x, y) || isHero(world, x, y) || isGoal(world, x, y) || world.wall[y * world.w + x]) return false
  const k = world.coins.findIndex((c) => c.x === x && c.y === y)
  if (k >= 0) { world.coins.splice(k, 1); world.coinsTotal = Math.max(world.coinsCollected, world.coinsTotal - 1) } else {
    if (world.coins.length >= 60) return false
    world.coins.push({ x, y }); world.coinsTotal++
  }
  reprice(world)
  return true
}
export function moveGoal(world, x, y) {
  if (world.status !== 'play' || !inside(world, x, y) || isHero(world, x, y) || world.wall[y * world.w + x]) return false
  if (world.coins.some((c) => c.x === x && c.y === y)) return false
  world.goal = { x, y }
  reprice(world)
  return true
}
