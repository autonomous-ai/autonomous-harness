#!/usr/bin/env node
// check.mjs — validate a pong.json for the Jev Pong harness.
// Enforces the shape the viewer needs: title, court, paddle, speed, step interval.
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

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (typeof p.courtW !== 'number' || p.courtW <= 0) bad('error  courtW must be a positive number')
if (typeof p.courtH !== 'number' || p.courtH <= 0) bad('error  courtH must be a positive number')
if (typeof p.paddleH !== 'number' || p.paddleH <= 0) bad('error  paddleH must be a positive number')
if (typeof p.speed !== 'number' || p.speed <= 0) bad('error  speed must be a positive number')
if (p.speed < 4) console.log('hint  speed < 4 is very easy — Jev will never miss')
if (p.speed > 12) console.log('hint  speed > 12 is nearly impossible — Jev misses constantly')
if (typeof p.stepMs !== 'number' || p.stepMs < 30 || p.stepMs > 2000) bad('error  stepMs must be ms 30..2000')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev defend coherently')

console.log(fail ? 'fail  invalid pong.json' : 'ok   pong.json is valid')
process.exit(fail ? 1 : 0)
