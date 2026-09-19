#!/usr/bin/env node
// check.mjs — validate a pendulum.json for the Jev Pendulum harness.
// The ranges are the same ones the viewer clamps to (viewer/sim.mjs, sanitize).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'pendulum.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read pendulum.json: ${e.message}`)
  process.exit(1)
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { console.log('error  pendulum.json must hold one JSON object'); process.exit(1) }

const range = (key, lo, hi, required = false) => {
  if (p[key] === undefined) { if (required) bad(`error  ${key} is required (${lo}..${hi})`); return }
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) bad(`error  ${key} must be a number ${lo}..${hi}, got ${JSON.stringify(p[key])}`)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
range('gravity', 0.5, 30, true)
range('length', 0.2, 3, true)
range('maxTorque', 0.05, 10, true)
range('stepMs', 30, 2000, true)
range('damping', 0, 5)
range('gustEvery', 0, 1000)
range('gustStrength', 0, 5)
range('fallDeg', 10, 85)
range('seed', 0, 1e9)
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev balance coherently')

// A hint about the honest limit, so the agent can reason about the dial.
if (!fail) {
  const noReturn = Math.atan((2 * p.maxTorque) / p.gravity) * 180 / Math.PI
  console.log(`hint  past a lean of ${noReturn.toFixed(1)}° gravity beats the hardest shove (gravity ${p.gravity}, shove ${(2 * p.maxTorque).toFixed(2)} m/s²)`)
  if (noReturn > 20) console.log('hint  that is a wide margin: Jev will rarely or never fall')
  if (noReturn < 8) console.log('hint  that is a thin margin: one gust can topple the rod')
}

console.log(fail ? 'fail  invalid pendulum.json' : 'ok   pendulum.json is valid')
process.exit(fail ? 1 : 0)
