#!/usr/bin/env node
// check.mjs — validate a lander.json for the Jev Lander harness.
// The ranges are the same ones the viewer clamps to (viewer/sim.mjs, sanitize).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'lander.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read lander.json: ${e.message}`)
  process.exit(1)
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { console.log('error  lander.json must hold one JSON object'); process.exit(1) }

const range = (key, lo, hi, required = false) => {
  if (p[key] === undefined) { if (required) bad(`error  ${key} is required (${lo}..${hi})`); return }
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) bad(`error  ${key} must be a number ${lo}..${hi}, got ${JSON.stringify(p[key])}`)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
range('gravity', 0.1, 5, true)
range('fuel', 5, 2000, true)
if (p.altitude === undefined && p.startAlt === undefined) bad('error  altitude is required (10..400)')
range('altitude', 10, 400)
range('startAlt', 10, 400)
range('safeSpeed', 0.2, 10, true)
range('tickMs', 30, 2000, true)
range('seed', 0, 1e9)
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev fly coherently')

// A hint about the honest limit, so the agent can reason about the dial.
if (!fail) {
  const brake = 2.6 - p.gravity
  if (brake <= 0) console.log(`hint  gravity ${p.gravity} is at or past full BURN (2.6): the booster cannot slow down at all, every flight crashes`)
  else console.log(`hint  full BURN brakes by ${brake.toFixed(2)} per tick at gravity ${p.gravity}. Every tick in the air costs about ${p.gravity} of fuel; the tank holds ${p.fuel}.`)
}

console.log(fail ? 'fail  invalid lander.json' : 'ok   lander.json is valid')
process.exit(fail ? 1 : 0)
