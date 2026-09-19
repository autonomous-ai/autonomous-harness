#!/usr/bin/env node
// check.mjs — validate a shopper.json for the Jev Shopper harness.
// Enforces the shape the viewer needs: title, products, tick interval, volatility.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'shopper.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read shopper.json: ${e.message}`)
  process.exit(1)
}

if (!p.title || typeof p.title !== 'string') bad('warn  no title')
if (!Array.isArray(p.products) || p.products.length < 2) bad('error  products must have at least 2 entries')
for (const [i, prod] of (p.products || []).entries()) {
  if (!prod || typeof prod.name !== 'string' || !prod.name.trim()) bad(`error  products[${i}].name must be a non-empty string`)
  if (typeof prod.price !== 'number' || prod.price <= 0) bad(`error  products[${i}].price must be a positive number`)
}
const names = new Set((p.products || []).map((x) => x.name))
if (names.size !== (p.products || []).length) bad('error  product names must be unique')
if (typeof p.tickMs !== 'number' || p.tickMs < 100 || p.tickMs > 5000) bad('error  tickMs must be ms 100..5000')
if (typeof p.vol !== 'number' || p.vol < 0 || p.vol > 0.5) bad('error  vol must be a rate 0..0.5 per tick')
if (!p.style || typeof p.style !== 'string') bad('warn  a style line helps Jev buy coherently')

console.log(fail ? 'fail  invalid shopper.json' : 'ok   shopper.json is valid')
process.exit(fail ? 1 : 0)
