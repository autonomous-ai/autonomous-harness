#!/usr/bin/env node
// check.mjs — validate a catcher.json for the Jev Catcher harness.
// Enforces the shape the viewer needs: title, field profile, tick interval.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'catcher.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read catcher.json: ${e.message}`)
  process.exit(1)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (p.instrument && p.instrument !== 'CATCHER') bad('warn  instrument should be CATCHER')
if (typeof p.fallTicks !== 'number' || p.fallTicks < 2 || p.fallTicks > 60) bad('error  fallTicks (balls per catch) should be 2..60')
if (typeof p.gloveReach !== 'number' || p.gloveReach <= 0 || p.gloveReach > 4) bad('error  gloveReach must be 0..4')
const W = p.fieldWidth ?? 24
if (typeof W !== 'number' || W < 6 || W > 60) bad('error  fieldWidth should be 6..60')
if (typeof p.balls !== 'number' || p.balls < 1 || p.balls > 100) bad('error  balls should be 1..100')
if (typeof p.tickMs !== 'number' || p.tickMs < 60 || p.tickMs > 2000) bad('error  tickMs must be ms 60..2000')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev field coherently')

console.log(fail ? 'fail  invalid catcher.json' : 'ok   catcher.json is valid')
process.exit(fail ? 1 : 0)
