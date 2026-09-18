#!/usr/bin/env node
// check.mjs — validate an archer.json for the Jev Archer harness.
// Enforces the shape the viewer needs: title, range profile, tick interval.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'archer.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read archer.json: ${e.message}`)
  process.exit(1)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (p.instrument && p.instrument !== 'ARCHER') bad('warn  instrument should be ARCHER')
if (typeof p.speed !== 'number' || p.speed <= 0 || p.speed > 4) bad('error  speed (slots per tick) should be >0..4')
if (typeof p.bullHalf !== 'number' || p.bullHalf <= 0 || p.bullHalf > 4) bad('error  bullHalf must be >0..4')
const W = p.targetWidth ?? 24
if (typeof W !== 'number' || W < 6 || W > 60) bad('error  targetWidth should be 6..60')
if (typeof p.shots !== 'number' || p.shots < 1 || p.shots > 100) bad('error  shots should be 1..100')
if (typeof p.tickMs !== 'number' || p.tickMs < 60 || p.tickMs > 2000) bad('error  tickMs must be ms 60..2000')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev aim coherently')

console.log(fail ? 'fail  invalid archer.json' : 'ok   archer.json is valid')
