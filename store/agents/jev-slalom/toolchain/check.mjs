#!/usr/bin/env node
// check.mjs — validate a slalom.json for the Jev Slalom harness.
// Enforces the shape the viewer needs: title, course profile, tick interval.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'slalom.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read slalom.json: ${e.message}`)
  process.exit(1)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (p.instrument && p.instrument !== 'SLALOM') bad('warn  instrument should be SLALOM')
if (typeof p.speed !== 'number' || p.speed <= 0) bad('error  speed must be a positive number')
if (typeof p.gates !== 'number' || p.gates < 2 || p.gates > 60) bad('error  gates should be 2..60')
const W = p.valleyWidth ?? 18
if (typeof W !== 'number' || W < 6 || W > 60) bad('error  valleyWidth should be 6..60')
if (typeof p.tickMs !== 'number' || p.tickMs < 60 || p.tickMs > 2000) bad('error  tickMs must be ms 60..2000')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev line up coherently')

console.log(fail ? 'fail  invalid slalom.json' : 'ok   slalom.json is valid')
process.exit(fail ? 1 : 0)
