#!/usr/bin/env node
// check.mjs — validate a pendulum.json for the Jev Pendulum harness.
// Enforces the shape the viewer needs: title, gravity, torque authority, interval, interval.
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

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (typeof p.gravity !== 'number' || p.gravity <= 0) bad('error  gravity must be a positive number')
if (p.gravity < 4) console.log('hint  gravity < 4 is very easy — Jev will never fall')
if (p.gravity > 10) console.log('hint  gravity > 10 is nearly unbalanceable — Jev will topple fast')
if (typeof p.maxTorque !== 'number' || p.maxTorque <= 0) bad('error  maxTorque must be a positive number')
if (typeof p.stepMs !== 'number' || p.stepMs < 30 || p.stepMs > 2000) bad('error  stepMs must be ms 30..2000')
if (typeof p.length !== 'number' || p.length <= 0) bad('error  length must be a positive number')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev balance coherently')

console.log(fail ? 'fail  invalid pendulum.json' : 'ok   pendulum.json is valid')
process.exit(fail ? 1 : 0)
