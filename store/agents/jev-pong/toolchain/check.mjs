#!/usr/bin/env node
// check.mjs — validate a pong.json for the Jev Pong harness.
// The ranges are the same ones the viewer clamps to (viewer/sim.mjs, sanitize).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'pong.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read pong.json: ${e.message}`)
  process.exit(1)
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { console.log('error  pong.json must hold one JSON object'); process.exit(1) }

const range = (key, lo, hi, required = false) => {
  if (p[key] === undefined) { if (required) bad(`error  ${key} is required (${lo}..${hi})`); return }
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) bad(`error  ${key} must be a number ${lo}..${hi}, got ${JSON.stringify(p[key])}`)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
range('courtW', 100, 600, true)
range('courtH', 60, 400, true)
range('paddleH', 6, 320, true)
range('ballR', 1, 8)
range('speed', 1, 60, true)
range('maxSpeed', 0.25, 20)
range('accel', 0, 10)
range('topSpeed', 1, 80)
range('stepMs', 30, 2000, true)
range('seed', 0, 1e9)
if (typeof p.paddleH === 'number' && typeof p.courtH === 'number' && p.paddleH > p.courtH * 0.8) bad('error  paddleH must be at most 80% of courtH')
if (typeof p.topSpeed === 'number' && typeof p.speed === 'number' && p.topSpeed < p.speed) bad('error  topSpeed must not be below speed')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev defend coherently')

// A hint about the pace where the paddle is outrun, so the agent can reason about the dial.
if (!fail) {
  const r = p.ballR ?? 3, maxSpeed = p.maxSpeed ?? 2
  const outrun = (2 * maxSpeed * 2 * (p.courtW - r - (8 + r))) / Math.max(1, p.courtH - p.paddleH)
  console.log(`hint  a ball at the far end of the wall is out of reach past pace ${outrun.toFixed(1)} (start pace ${p.speed}, +${p.accel ?? 1} per return, cap ${p.topSpeed ?? 40})`)
  if ((p.topSpeed ?? 40) < outrun) console.log('hint  topSpeed is below that pace, so Jev may never miss. Raise topSpeed or lower maxSpeed.')
  if (p.speed > outrun * 1.5) console.log('hint  the start pace is far past that, so most rallies will end after a few returns.')
}

console.log(fail ? 'fail  invalid pong.json' : 'ok   pong.json is valid')
process.exit(fail ? 1 : 0)
