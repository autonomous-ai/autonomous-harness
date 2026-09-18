#!/usr/bin/env node
// check.mjs — validate a lander.json for the Jev Lander harness.
// Enforces the shape the viewer needs: title, mission profile, tick interval.
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

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (p.instrument && p.instrument !== 'LANDER') bad('warn  instrument should be LANDER')
if (typeof p.gravity !== 'number' || p.gravity <= 0) bad('error  gravity must be a positive number')
if (typeof p.fuel !== 'number' || p.fuel <= 0) bad('error  fuel must be a positive number')
const alt = p.altitude ?? p.startAlt
if (typeof alt !== 'number' || alt <= 0) bad('error  altitude must be a positive number')
if (typeof p.tickMs !== 'number' || p.tickMs < 100 || p.tickMs > 5000) bad('error  tickMs must be ms 100..5000')
if (typeof p.safeSpeed !== 'number' || p.safeSpeed <= 0) bad('error  safeSpeed must be a positive number')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev fly coherently')

console.log(fail ? 'fail  invalid lander.json' : 'ok   lander.json is valid')
process.exit(fail ? 1 : 0)
