// check.mjs — validate the workspace's arena.json and report the viewer's current state.
// Exits non-zero when the world is invalid or unplayable. Read-only: never writes the verdict
// (the viewer owns that).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.env.HARNESS_WORKSPACE || process.cwd()
const file = join(workspace, 'arena.json')

const problems = []
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

const size = Number(world.size)
if (!Number.isInteger(size) || size < 2 || size > 32) {
  console.error(`fail  size must be an integer 2..32 (got ${world.size})`)
  problems.push('size')
}
const inB = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < size && p.y < size
if (!world.hero || !inB(world.hero)) { console.error('fail  hero is missing or out of bounds'); problems.push('hero') }
if (!world.goal || !inB(world.goal)) { console.error('fail  goal is missing or out of bounds'); problems.push('goal') }
for (const w of world.walls || []) if (!inB(w)) { console.error(`fail  wall out of bounds: ${w.x},${w.y}`); problems.push('wall') }
for (const c of world.coins || []) if (!inB(c)) { console.error(`fail  coin out of bounds: ${c.x},${c.y}`); problems.push('coin') }
if (!world.rules) { console.warn('warn  no rules text'); }
const speed = Number(world.speed)
if (!Number.isFinite(speed) || speed < 60) console.warn('warn  speed below 60ms may be frantic')

// Goal covered by a wall?
if (world.goal && world.walls && world.walls.some((w) => w.x === world.goal.x && w.y === world.goal.y)) {
  console.error('fail  the goal is inside a wall — Jev can never reach it')
  problems.push('goal-in-wall')
}
// Hero covered by a wall?
if (world.hero && world.walls && world.walls.some((w) => w.x === world.hero.x && w.y === world.hero.y)) {
  console.error('fail  the hero is inside a wall — Jev starts stuck')
  problems.push('hero-in-wall')
}

if (problems.length) {
  console.error(`fail  ${problems.join(', ')}`)
  process.exit(1)
}

console.log(`ok   ${world.title || 'untitled'} · ${size}x${size} · goal at (${world.goal.x},${world.goal.y}) · ${(world.walls||[]).length} walls · ${(world.coins||[]).length} coins · ${speed}ms/step`)
process.exit(0)
