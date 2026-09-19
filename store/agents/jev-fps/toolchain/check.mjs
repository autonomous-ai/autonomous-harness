#!/usr/bin/env node
// check.mjs — validate a level.json for the Jev FPS harness: the map's shape and reachability, and
// every number's range. Prints one line per problem and exits 1 on any error.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { parseMap } = await import(join(HERE, '../viewer/sim.mjs'))
const ws = process.env.HARNESS_WORKSPACE || '.'

let errors = 0
const error = (msg) => { errors++; console.log(`error  ${msg}`) }
const warn = (msg) => console.log(`warn   ${msg}`)

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'level.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read level.json: ${e.message}`)
  process.exit(1)
}

const map = parseMap(p.map)
if (!map.ok) error(`map: ${map.error}`)
else {
  if (map.spawns.length < 2) warn('only one demon spawn (D): demons will always come from the same side')
  if (!map.pickups.some((k) => k.kind === 'medkit')) warn('no medkit (M) on the map: every run ends fast')
  if (!map.pickups.some((k) => k.kind === 'ammo')) warn('no ammo (A) on the map')
}

const range = (key, lo, hi, what) => {
  if (p[key] === undefined) return
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) error(`${key} (${what}) must be a number from ${lo} to ${hi}`)
}
range('tickMs', 60, 1000, 'milliseconds per Jev decision')
range('demons', 1, 24, 'demons alive at once in wave 1')
range('demonSpeed', 0.2, 6, 'tiles per second in wave 1')
range('demonHealth', 10, 400, 'a shot does 34')
range('demonDamage', 1, 60, 'per bite')
range('kills', 1, 200, 'kills to clear wave 1')
range('ammo', 0, 99, 'starting ammo')
range('seed', 0, 1e9, 'random seed')
if (!p.title || typeof p.title !== 'string') warn('no title')
if (!p.style || typeof p.style !== 'string') warn('no style line: tell Jev how to fight')
else if (p.style.length > 600) error('style must be 600 characters or fewer')

console.log(errors ? `fail   level.json has ${errors} error${errors > 1 ? 's' : ''}` : 'ok     level.json is valid')
process.exit(errors ? 1 : 0)
