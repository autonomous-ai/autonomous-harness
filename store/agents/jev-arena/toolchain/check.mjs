// check.mjs — validate the workspace's arena.json. Exits non-zero when the world is invalid or cannot
// be played. Read-only: it never writes the verdict (the viewer owns that).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.env.HARNESS_WORKSPACE || process.cwd()
const file = join(workspace, 'arena.json')

const problems = []
const fail = (tag, msg) => { console.error(`fail  ${msg}`); problems.push(tag) }
if (!existsSync(file)) {
  console.error('fail  arena.json is missing')
  process.exit(1)
}

let world
try {
  world = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`fail  arena.json is not valid JSON: ${e.message}`)
  process.exit(1)
}

const dim = (v, name) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 2 || n > 32) { fail(name, `${name} must be a whole number from 2 to 32 (got ${v})`); return 12 }
  return n
}
const size = world.size === undefined && world.width !== undefined && world.height !== undefined ? 12 : dim(world.size, 'size')
const width = world.width === undefined ? size : dim(world.width, 'width')
const height = world.height === undefined ? size : dim(world.height, 'height')
const inB = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height
if (!world.hero || !inB(world.hero)) fail('hero', 'hero is missing or out of bounds')
if (!world.goal || !inB(world.goal)) fail('goal', 'goal is missing or out of bounds')
for (const w of world.walls || []) if (!inB(w)) fail('wall', `wall out of bounds: ${w?.x},${w?.y}`)
for (const c of world.coins || []) if (!inB(c)) fail('coin', `coin out of bounds: ${c?.x},${c?.y}`)
if (!world.rules) console.warn('warn  no rules text')
const speed = Number(world.speed ?? 300)
if (!Number.isFinite(speed) || speed < 60 || speed > 2000) fail('speed', `speed must be 60 to 2000 ms per decision (got ${world.speed})`)
if (world.sight !== undefined && (!Number.isInteger(world.sight) || world.sight < 1 || world.sight > 99)) fail('sight', `sight must be a whole number from 1 to 99, where 99 means the whole board (got ${world.sight})`)
if (world.remix !== undefined && typeof world.remix !== 'boolean') fail('remix', `remix must be true or false (got ${world.remix})`)
if (world.seed !== undefined && (!Number.isInteger(world.seed) || world.seed < 0 || world.seed > 1e9)) fail('seed', `seed must be a whole number from 0 to 1000000000 (got ${world.seed})`)

const wallAt = (p) => (world.walls || []).some((w) => w && p && w.x === p.x && w.y === p.y)
if (world.goal && wallAt(world.goal)) fail('goal-in-wall', 'the goal is inside a wall, so Jev can never reach it')
if (world.hero && wallAt(world.hero)) fail('hero-in-wall', 'the hero is inside a wall, so Jev starts stuck')
if (world.hero && world.goal && world.hero.x === world.goal.x && world.hero.y === world.goal.y) fail('hero-on-goal', 'the hero starts on the goal')

// Can the goal be reached at all? (A flood fill over the open floor.)
if (!problems.length) {
  const blocked = new Set((world.walls || []).map((w) => `${w.x},${w.y}`))
  const seen = new Set([`${world.hero.x},${world.hero.y}`]), queue = [world.hero]
  while (queue.length) {
    const p = queue.shift()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: p.x + dx, y: p.y + dy }, k = `${n.x},${n.y}`
      if (!inB(n) || blocked.has(k) || seen.has(k)) continue
      seen.add(k); queue.push(n)
    }
  }
  if (!seen.has(`${world.goal.x},${world.goal.y}`)) fail('no-way', 'walls cut the goal off from the hero')
  const lost = (world.coins || []).filter((c) => !seen.has(`${c.x},${c.y}`)).length
  if (lost) console.warn(`warn  ${lost} coin(s) cannot be reached`)
}

if (problems.length) {
  console.error(`fail  ${problems.join(', ')}`)
  process.exit(1)
}

const sight = world.sight === undefined ? 4 : world.sight
console.log(`ok   ${world.title || 'untitled'} · ${width}x${height} · goal at (${world.goal.x},${world.goal.y}) · ${(world.walls || []).length} walls · ${(world.coins || []).length} coins · ${speed}ms/step · sight ${sight >= 99 ? 'whole board' : sight} · ${world.remix === false ? 'replays this layout' : 'fresh layout after each run'}`)
process.exit(0)
