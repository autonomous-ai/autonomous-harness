#!/usr/bin/env node
// check.mjs — validate a market.json for the Jev Trader harness.
// Enforces the shape the viewer needs: instrument name, sane price/volatility/drift/stepMs/capital.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let market
try {
  market = JSON.parse(readFileSync(join(ws, 'market.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read market.json: ${e.message}`)
  process.exit(1)
}

if (!market.instrument || typeof market.instrument !== 'string') bad('error  instrument (a ticker string) is required')
if (!market.title || typeof market.title !== 'string') bad('warn  no title')
if (typeof market.startPrice !== 'number' || market.startPrice <= 0) bad('error  startPrice must be a positive number')
if (typeof market.volatility !== 'number' || market.volatility < 0 || market.volatility > 0.2) bad('warn  volatility should be 0..0.2 per step')
if (typeof market.stepMs !== 'number' || market.stepMs < 200 || market.stepMs > 20000) bad('error  stepMs must be ms 200..20000')
if (typeof market.capital !== 'number' || market.capital <= 0) bad('error  capital must be a positive number')
if (!market.style || typeof market.style !== 'string') bad('warn  a style line helps Jev trade coherently')

console.log(fail ? 'fail  invalid market.json' : 'ok   market.json is valid')
process.exit(fail ? 1 : 0)
