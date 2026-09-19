// sim.mjs — the arena. A small, deterministic first-person-shooter world on a tile map: one marine
// (driven by Jev), demons that path-find to the marine, hitscan shots, pickups and waves.
// Pure functions over a plain `world` object so tests can drive it without a server.
import { mulberry32 } from './kit.mjs'

export const FOV_DEG = 66
export const WALLS = '#%='
// Turn rates in degrees per second; the per-decision amount is rate * tickMs / 1000.
export const TURN_RATE = { LEFT_HARD: -330, LEFT: -120, LEFT_FINE: -36, AHEAD: 0, RIGHT_FINE: 36, RIGHT: 120, RIGHT_HARD: 330 }
export const TURNS = Object.keys(TURN_RATE)
export const MOVES = ['FORWARD', 'BACK', 'STRAFE_LEFT', 'STRAFE_RIGHT', 'HOLD']
const FIRE_COOLDOWN = 3 // decisions between shots
const MOVE_SPEED = { FORWARD: 3.2, BACK: 2.2, STRAFE_LEFT: 2.6, STRAFE_RIGHT: 2.6, HOLD: 0 } // tiles per second

export const DEFAULT_MAP = [
  '########################',
  '#P.....#.......%.......#',
  '#......#.......%...D...#',
  '#..##..#..###..%%%..%%%#',
  '#..##.....#A#..........#',
  '#.........###....M.....#',
  '####..#..........####..#',
  '#.....#..%%..%%..#.....#',
  '#..M..#..%....%..#..A..#',
  '#.....#..%....%........#',
  '#..####..%%..%%..####..#',
  '#......................#',
  '#..D.......==.......D..#',
  '#..........==..........#',
  '#......A..........M....#',
  '########################',
]

export const DEFAULT = {
  title: 'Jev FPS',
  description: 'Jev is the marine. It reads the fight as text about nine times a second and decides where to turn, how to move and when to fire.',
  map: DEFAULT_MAP,
  tickMs: 110,        // one Jev decision per tick
  demons: 4,          // alive at once in wave 1 (+1 per wave)
  demonSpeed: 1.2,    // tiles per second in wave 1 (+12% per wave) — the honest dial
  demonHealth: 60,
  demonDamage: 9,     // per bite, about two bites a second in reach
  kills: 12,          // kills to clear wave 1 (+4 per wave)
  ammo: 60,
  seed: 7,
  style: 'Stay alive. Face the nearest demon, fire only when it is in your crosshair, keep your distance, and fetch a medkit when your health is low.',
}

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const normDeg = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d }

/** Parse and validate the ASCII map. Returns { ok, error, w, h, rows, start, spawns, pickups }. */
export function parseMap(lines) {
  const bad = (error) => ({ ok: false, error })
  if (!Array.isArray(lines) || lines.length < 8 || lines.length > 40) return bad('map must be 8 to 40 rows of text')
  const w = String(lines[0]).length
  if (w < 8 || w > 64) return bad('map rows must be 8 to 64 characters wide')
  const rows = []
  let start = null
  const spawns = [], pickups = []
  for (let y = 0; y < lines.length; y++) {
    const line = String(lines[y])
    if (line.length !== w) return bad(`map row ${y + 1} is ${line.length} wide, expected ${w}`)
    for (let x = 0; x < w; x++) {
      const c = line[x]
      if (!'#%=.PDMA'.includes(c)) return bad(`map row ${y + 1} has an unknown tile "${c}" (use # % = . P D M A)`)
      const edge = y === 0 || x === 0 || y === lines.length - 1 || x === w - 1
      if (edge && !WALLS.includes(c)) return bad(`the map border must be wall; row ${y + 1} column ${x + 1} is "${c}"`)
      if (c === 'P') { if (start) return bad('the map needs exactly one P (player start)'); start = { x: x + 0.5, y: y + 0.5 } }
      if (c === 'D') spawns.push({ x: x + 0.5, y: y + 0.5 })
      if (c === 'M') pickups.push({ x: x + 0.5, y: y + 0.5, kind: 'medkit' })
      if (c === 'A') pickups.push({ x: x + 0.5, y: y + 0.5, kind: 'ammo' })
    }
    rows.push(line)
  }
  if (!start) return bad('the map needs exactly one P (player start)')
  if (!spawns.length) return bad('the map needs at least one D (demon spawn)')
  const map = { ok: true, error: null, w, h: rows.length, rows, start, spawns, pickups }
  const dist = flood(map, start.x | 0, start.y | 0)
  for (const s of spawns) if (dist[(s.y | 0) * w + (s.x | 0)] < 0) return bad('a demon spawn (D) is walled off from the player start (P)')
  return map
}

export const isWall = (map, x, y) => x < 0 || y < 0 || x >= map.w || y >= map.h || WALLS.includes(map.rows[y | 0][x | 0])

/** Breadth-first distances (in steps) from a cell to every floor cell; -1 where unreachable. */
export function flood(map, sx, sy) {
  const dist = new Int16Array(map.w * map.h).fill(-1)
  const q = [sx, sy]
  dist[sy * map.w + sx] = 0
  for (let i = 0; i < q.length; i += 2) {
    const x = q[i], y = q[i + 1], d = dist[y * map.w + x]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (isWall(map, nx, ny) || dist[ny * map.w + nx] >= 0) continue
      dist[ny * map.w + nx] = d + 1
      q.push(nx, ny)
    }
  }
  return dist
}

/** Distance along a ray to the first wall (tile DDA). */
export function rayWall(map, px, py, ang, max = 40) {
  const dx = Math.cos(ang), dy = Math.sin(ang)
  let mx = px | 0, my = py | 0
  const ddx = Math.abs(1 / (dx || 1e-9)), ddy = Math.abs(1 / (dy || 1e-9))
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
  let sdx = dx < 0 ? (px - mx) * ddx : (mx + 1 - px) * ddx
  let sdy = dy < 0 ? (py - my) * ddy : (my + 1 - py) * ddy
  let d = 0
  while (d < max) {
    if (sdx < sdy) { d = sdx; sdx += ddx; mx += sx } else { d = sdy; sdy += ddy; my += sy }
    if (isWall(map, mx, my)) return d
  }
  return max
}

export const lineOfSight = (map, ax, ay, bx, by) => {
  const d = Math.hypot(bx - ax, by - ay)
  return d < 1e-6 || rayWall(map, ax, ay, Math.atan2(by - ay, bx - ax), d + 0.01) >= d
}

/** Waypoint bearing: follow the flood field from `from` toward the cell the field was grown from. */
function routeToward(map, field, fx, fy, steps = 2) {
  let x = fx | 0, y = fy | 0
  const path = [[x, y]]
  for (let i = 0; i < 64; i++) {
    const d = field[y * map.w + x]
    if (d <= 0) break
    let best = null
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nd = isWall(map, x + dx, y + dy) ? -1 : field[(y + dy) * map.w + (x + dx)]
      if (nd >= 0 && nd < d && (!best || nd < best.d)) best = { x: x + dx, y: y + dy, d: nd }
    }
    if (!best) break
    x = best.x; y = best.y
    path.push([x, y])
  }
  // Aim at the farthest of the next few cells that is still in a straight clear line.
  let aim = path[Math.min(1, path.length - 1)]
  for (let i = Math.min(steps + 2, path.length - 1); i >= 1; i--) {
    if (lineOfSight(map, fx, fy, path[i][0] + 0.5, path[i][1] + 0.5)) { aim = path[i]; break }
  }
  return { path, aim: { x: aim[0] + 0.5, y: aim[1] + 0.5 } }
}

export function createWorld(cfg, waveNo = 1, carry = null, life = 0) {
  const parsed = parseMap(cfg.map)
  const map = parsed.ok ? parsed : parseMap(DEFAULT_MAP)
  const seed = (Number(cfg.seed) || 7) + waveNo * 101 + life * 7919
  return {
    map, mapError: parsed.ok ? null : parsed.error,
    rng: mulberry32(seed),
    step: 0, time: 0, waveNo,
    need: Math.round(cfg.kills + 4 * (waveNo - 1)),
    maxAlive: Math.round(cfg.demons + (waveNo - 1)),
    demonSpeed: cfg.demonSpeed * (1 + 0.12 * (waveNo - 1)),
    status: 'playing', statusAt: 0,
    player: {
      x: map.start.x, y: map.start.y, a: 0, hp: carry ? clamp(carry.hp + 30, 0, 100) : 100,
      ammo: carry ? carry.ammo + 20 : cfg.ammo, kills: 0, cooldown: 0, hurtAt: -99, moving: false,
    },
    demons: [], nextDemonId: 1, spawnTimer: 0.4,
    pickups: map.pickups.map((p, i) => ({ id: i + 1, ...p, respawn: 0 })),
    totals: { shots: 0, hits: 0, kills: 0, deaths: 0, damage: 0 },
    field: null, fieldCell: -1, events: [],
  }
}

export function spawnDemon(world, cfg, at = null) {
  const { map, player } = world
  let spot = at
  if (!spot) {
    // The spawn that is farthest from the marine and, if possible, out of sight.
    const ranked = map.spawns.map((s) => ({ s, d: Math.hypot(s.x - player.x, s.y - player.y), seen: lineOfSight(map, s.x, s.y, player.x, player.y) }))
      .sort((a, b) => (a.seen - b.seen) || (b.d - a.d))
    spot = ranked[Math.floor(world.rng() * Math.min(2, ranked.length))].s
  }
  if (isWall(map, spot.x, spot.y)) return null
  const d = { id: world.nextDemonId++, x: spot.x + (world.rng() - 0.5) * 0.3, y: spot.y + (world.rng() - 0.5) * 0.3, hp: cfg.demonHealth, pace: 0.88 + world.rng() * 0.24, bite: 0, hurt: 0, state: 'walk' }
  world.demons.push(d)
  world.events.push({ e: 'spawn', id: d.id, x: d.x, y: d.y })
  return d
}

function moveCircle(map, o, dx, dy, r) {
  const nx = o.x + dx
  if (!isWall(map, nx + Math.sign(dx) * r, o.y - r * 0.7) && !isWall(map, nx + Math.sign(dx) * r, o.y + r * 0.7)) o.x = nx
  const ny = o.y + dy
  if (!isWall(map, o.x - r * 0.7, ny + Math.sign(dy) * r) && !isWall(map, o.x + r * 0.7, ny + Math.sign(dy) * r)) o.y = ny
}

/** What a shot along the current facing would hit right now: { demon, dist } or { wall: dist }. */
export function aimHit(world) {
  const { map, player } = world
  const wall = rayWall(map, player.x, player.y, player.a)
  let best = null
  for (const d of world.demons) {
    if (d.state === 'dead') continue
    const dist = Math.hypot(d.x - player.x, d.y - player.y)
    if (dist > wall + 0.3) continue
    const off = Math.abs(normDeg((Math.atan2(d.y - player.y, d.x - player.x) - player.a) / DEG))
    const half = Math.atan2(0.34, Math.max(0.3, dist)) / DEG
    if (off <= half && (!best || dist < best.dist) && lineOfSight(map, player.x, player.y, d.x, d.y)) best = { demon: d, dist }
  }
  return best ?? { wall }
}

/**
 * What Jev gets to read. Everything a player could know: the HUD, what is in view, what it hears,
 * distances to walls, and the automap route. Bearings are degrees off the crosshair, negative = left.
 */
export function observe(world, cfg) {
  const { map, player } = world
  const bearingTo = (x, y) => normDeg((Math.atan2(y - player.y, x - player.x) - player.a) / DEG)
  const seen = [], heard = []
  for (const d of world.demons) {
    if (d.state === 'dead') continue
    const dist = Math.hypot(d.x - player.x, d.y - player.y)
    const b = bearingTo(d.x, d.y)
    if (Math.abs(b) <= FOV_DEG / 2 + 4 && lineOfSight(map, player.x, player.y, d.x, d.y)) seen.push({ id: d.id, b, dist, biting: d.state === 'attack' })
    else if (dist < 9) heard.push({ id: d.id, b, dist })
  }
  seen.sort((a, b) => a.dist - b.dist); heard.sort((a, b) => a.dist - b.dist)
  const walls = { ahead: rayWall(map, player.x, player.y, player.a), left: rayWall(map, player.x, player.y, player.a - Math.PI / 2), right: rayWall(map, player.x, player.y, player.a + Math.PI / 2), behind: rayWall(map, player.x, player.y, player.a + Math.PI) }
  const hit = aimHit(world)

  // Route: to a medkit when hurt, to ammo when dry, else to the nearest demon by walking distance.
  const want = player.hp < 40 ? 'medkit' : player.ammo < 15 ? 'ammo' : 'demon'
  let goal = null
  if (want !== 'demon') {
    const field = flood(map, player.x | 0, player.y | 0)
    const live = world.pickups.filter((p) => p.kind === want && p.respawn <= 0).map((p) => ({ p, d: field[(p.y | 0) * map.w + (p.x | 0)] })).filter((o) => o.d >= 0).sort((a, b) => a.d - b.d)
    if (live.length) goal = { kind: want, x: live[0].p.x, y: live[0].p.y, steps: live[0].d }
  }
  if (!goal) {
    const field = flood(map, player.x | 0, player.y | 0)
    const live = world.demons.filter((d) => d.state !== 'dead').map((d) => ({ d, steps: field[(d.y | 0) * map.w + (d.x | 0)] })).filter((o) => o.steps >= 0).sort((a, b) => a.steps - b.steps)
    if (live.length) goal = { kind: 'demon', x: live[0].d.x, y: live[0].d.y, steps: live[0].steps }
  }
  let route = null
  if (goal) {
    const r = routeToward(map, flood(map, goal.x | 0, goal.y | 0), player.x, player.y)
    route = { kind: goal.kind, steps: goal.steps, b: bearingTo(r.aim.x, r.aim.y), path: r.path.slice(0, 24) }
  }

  const per = (name) => Math.abs(TURN_RATE[name] * cfg.tickMs / 1000)
  const f1 = (n) => n.toFixed(1), sg = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(0)}`
  const lines = [
    `You are the marine in a first-person arena shooter. ${cfg.style}`,
    `wave ${world.waveNo}   kills ${player.kills}/${world.need}   health ${Math.round(player.hp)}/100   ammo ${player.ammo}`,
    `walls: ahead ${f1(walls.ahead)}  left ${f1(walls.left)}  right ${f1(walls.right)}  behind ${f1(walls.behind)}`,
    `one decision turns you: HARD ${per('LEFT_HARD').toFixed(0)} deg, normal ${per('LEFT').toFixed(0)} deg, FINE ${per('LEFT_FINE').toFixed(0)} deg`,
    seen.length ? 'demons in sight (bearing in degrees off your crosshair, negative is left):' : 'demons in sight: none',
    ...seen.slice(0, 6).map((s) => `  demon#${s.id} bearing ${sg(s.b)} distance ${f1(s.dist)}${s.biting ? ' BITING YOU' : ''}`),
    heard.length ? `heard but not seen: demon#${heard[0].id} bearing ${sg(heard[0].b)} distance ${f1(heard[0].dist)}` : 'heard but not seen: nothing',
    route ? `route to nearest ${route.kind}: bearing ${sg(route.b)} steps ${route.steps}` : 'route: none',
    hit.demon ? `crosshair on: demon#${hit.demon.id} distance ${f1(hit.dist)}` : 'crosshair on: nothing',
  ]
  return { text: lines.join('\n'), seen, heard, walls, route, crosshair: hit.demon ? hit.demon.id : null }
}

/** One decision tick: fire at the instant of deciding, then turn and move through `sub` sub-steps. */
export function tick(world, cfg, decision, sub = 4) {
  const { map, player } = world
  world.events = []
  world.step++
  const dt = cfg.tickMs / 1000 / sub

  if (world.status !== 'playing') { world.time += cfg.tickMs / 1000; return world.events }

  // Fire first: the "crosshair on" line Jev read describes this exact instant.
  player.cooldown = Math.max(0, player.cooldown - 1)
  if (decision.fire && player.cooldown === 0 && player.ammo > 0) {
    player.ammo--; player.cooldown = FIRE_COOLDOWN; world.totals.shots++
    const hit = aimHit(world)
    const range = hit.demon ? hit.dist : hit.wall
    const ev = { e: 'shot', x: player.x + Math.cos(player.a) * range, y: player.y + Math.sin(player.a) * range, hit: hit.demon ? hit.demon.id : 0 }
    if (hit.demon) {
      world.totals.hits++
      hit.demon.hp -= 34; hit.demon.hurt = 2
      if (hit.demon.hp <= 0) { hit.demon.state = 'dead'; player.kills++; world.totals.kills++; ev.kill = true; player.ammo = Math.min(99, player.ammo + 2) }
    }
    world.events.push(ev)
  } else if (decision.fire && player.ammo <= 0 && player.cooldown === 0) { player.cooldown = FIRE_COOLDOWN; world.events.push({ e: 'click' }) }

  const turnRate = (TURN_RATE[decision.turn] ?? 0) * DEG
  const speed = MOVE_SPEED[decision.move] ?? 0
  player.moving = speed > 0
  for (let i = 0; i < sub; i++) {
    player.a += turnRate * dt
    let mx = 0, my = 0
    if (decision.move === 'FORWARD') { mx = Math.cos(player.a); my = Math.sin(player.a) }
    else if (decision.move === 'BACK') { mx = -Math.cos(player.a); my = -Math.sin(player.a) }
    else if (decision.move === 'STRAFE_LEFT') { mx = Math.sin(player.a); my = -Math.cos(player.a) }
    else if (decision.move === 'STRAFE_RIGHT') { mx = -Math.sin(player.a); my = Math.cos(player.a) }
    moveCircle(map, player, mx * speed * dt, my * speed * dt, 0.22)

    // Demons chase along a flood field grown from the marine's cell.
    const cell = (player.y | 0) * map.w + (player.x | 0)
    if (cell !== world.fieldCell) { world.field = flood(map, player.x | 0, player.y | 0); world.fieldCell = cell }
    for (const d of world.demons) {
      if (d.state === 'dead') continue
      const dist = Math.hypot(player.x - d.x, player.y - d.y)
      d.bite = Math.max(0, d.bite - dt)
      if (dist < 0.85) {
        d.state = 'attack'
        if (d.bite === 0) { d.bite = 0.5; player.hp -= cfg.demonDamage; player.hurtAt = world.step; world.totals.damage += cfg.demonDamage; world.events.push({ e: 'bite', id: d.id }) }
        continue
      }
      d.state = 'walk'
      let tx = player.x, ty = player.y
      if (!(dist < 6 && lineOfSight(map, d.x, d.y, player.x, player.y))) {
        const r = routeToward(map, world.field, d.x, d.y, 1)
        tx = r.aim.x; ty = r.aim.y
      }
      const len = Math.hypot(tx - d.x, ty - d.y) || 1
      const v = world.demonSpeed * d.pace * (d.hurt > 0 ? 0.5 : 1) * dt
      // Demons weave side to side as they charge. The faster they are, the faster they cross the
      // crosshair, so a marine that decides only ~9 times a second starts to miss. That is the dial.
      const ux = (tx - d.x) / len, uy = (ty - d.y) / len
      const weave = Math.sin(world.time * 5.2 * d.pace + d.id * 1.7) * 0.8
      moveCircle(map, d, (ux - uy * weave) * v, (uy + ux * weave) * v, 0.28)
    }
    // Demons shoulder each other apart so a pack does not stack into one sprite.
    for (let a = 0; a < world.demons.length; a++) for (let b = a + 1; b < world.demons.length; b++) {
      const A = world.demons[a], B = world.demons[b]
      if (A.state === 'dead' || B.state === 'dead') continue
      const dx = B.x - A.x, dy = B.y - A.y, dd = Math.hypot(dx, dy)
      if (dd > 0 && dd < 0.6) { const push = (0.6 - dd) / 2 / dd; moveCircle(map, A, -dx * push, -dy * push, 0.28); moveCircle(map, B, dx * push, dy * push, 0.28) }
    }
  }
  for (const d of world.demons) if (d.hurt > 0) d.hurt--
  world.demons = world.demons.filter((d) => d.state !== 'dead')
  player.a = normDeg(player.a / DEG) * DEG

  // Pickups.
  for (const p of world.pickups) {
    if (p.respawn > 0) { p.respawn -= cfg.tickMs / 1000; continue }
    if (Math.hypot(p.x - player.x, p.y - player.y) > 0.6) continue
    if (p.kind === 'medkit' && player.hp < 100) { player.hp = Math.min(100, player.hp + 35); p.respawn = p.once ? 1e9 : 14; world.events.push({ e: 'pickup', kind: 'medkit' }) }
    if (p.kind === 'ammo' && player.ammo < 99) { player.ammo = Math.min(99, player.ammo + 20); p.respawn = p.once ? 1e9 : 12; world.events.push({ e: 'pickup', kind: 'ammo' }) }
  }

  // Keep the pack topped up until the wave's kill count is met.
  world.spawnTimer -= cfg.tickMs / 1000
  const remaining = world.need - player.kills
  if (world.spawnTimer <= 0 && world.demons.length < Math.min(world.maxAlive, remaining)) { spawnDemon(world, cfg); world.spawnTimer = 1.1 }

  world.time += cfg.tickMs / 1000
  if (player.hp <= 0) { player.hp = 0; world.status = 'dead'; world.statusAt = world.step; world.totals.deaths++; world.events.push({ e: 'dead' }) }
  else if (player.kills >= world.need) { world.status = 'cleared'; world.statusAt = world.step; world.events.push({ e: 'cleared' }) }
  return world.events
}
