#!/usr/bin/env node
// check.mjs — validate a market.json for the Jev Trader harness.
// The viewer clamps wild values so the demo never breaks; this tells the agent what it clamped.
// The ranges here are the same ones viewer/sim.mjs uses.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(`error  ${msg}`) }
const warn = (msg) => console.log(`warn   ${msg}`)

let market
try {
  market = JSON.parse(readFileSync(join(ws, 'market.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read market.json: ${e.message}`)
  process.exit(1)
}

const num = (key, lo, hi, required = false) => {
  const v = market[key]
  if (v === undefined) { if (required) bad(`${key} is required (a number ${lo}..${hi})`); return }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) bad(`${key} must be a number ${lo}..${hi} (got ${JSON.stringify(v)})`)
}

if (!market.instrument || typeof market.instrument !== 'string') bad('instrument (a made-up ticker string) is required')
if (!market.title || typeof market.title !== 'string') warn('no title')
num('startPrice', 0.01, 1e6, true)
num('volatility', 0, 0.2, true)   // daily noise. The difficulty dial.
num('drift', -0.02, 0.02)
num('trend', 0, 0.02)             // strength of the hidden trend. 0 = a pure random walk
num('fee', 0, 0.05)               // cost of a trade, as a share of its value
num('stepMs', 60, 20000, true)    // milliseconds per trading day
num('capital', 100, 1e9, true)
num('episodeDays', 60, 2000)
num('seed', 0, 1e9)
if (!market.style || typeof market.style !== 'string') warn('a style line helps Jev trade coherently')
if (typeof market.volatility === 'number' && typeof market.trend === 'number' && market.trend === 0) warn('trend is 0: the price is a pure random walk, there is nothing to read on the tape')

console.log(fail ? 'fail  invalid market.json' : 'ok   market.json is valid')
process.exit(fail ? 1 : 0)
