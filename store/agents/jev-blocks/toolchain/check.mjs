#!/usr/bin/env node
// check.mjs — validate a blocks.json for the Jev Blocks harness.
// Enforces the ranges the viewer clamps to, so a challenge means what its numbers say.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'
const file = process.argv[2] || join(ws, 'blocks.json')
const PIECES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

let fail = false
const bad = (msg) => { fail = true; console.log(`error  ${msg}`) }
const warn = (msg) => console.log(`warn   ${msg}`)

let p
try {
  p = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.log(`error  cannot read blocks.json: ${e.message}`)
  process.exit(1)
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { console.log('error  blocks.json must be a JSON object'); process.exit(1) }

const range = (key, lo, hi, required = false) => {
  if (p[key] === undefined) { if (required) bad(`${key} is required (${lo}..${hi})`); return }
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) bad(`${key} must be a number ${lo}..${hi} (got ${JSON.stringify(p[key])})`)
}

if (!p.title || typeof p.title !== 'string') warn('no title')
range('gravity', 0.2, 40, true)
range('speedup', 0, 2)
range('decisionMs', 30, 1000)
range('moveMs', 5, 500)
range('garbageRows', 0, 12)
if (p.garbageRows !== undefined && !Number.isInteger(p.garbageRows)) bad('garbageRows must be a whole number')
if (p.seed !== undefined && !Number.isInteger(p.seed)) bad('seed must be a whole number')

if (p.weights !== undefined) {
  if (!p.weights || typeof p.weights !== 'object' || Array.isArray(p.weights)) bad('weights must be an object like { "I": 1, "O": 1, ... }')
  else {
    let sum = 0
    for (const [k, v] of Object.entries(p.weights)) {
      if (!PIECES.includes(k)) bad(`weights has an unknown piece "${k}" (use ${PIECES.join(', ')})`)
      else if (!Number.isInteger(v) || v < 0 || v > 9) bad(`weights.${k} must be a whole number 0..9`)
      else sum += v
    }
    if (!fail && sum === 0) bad('weights are all zero: at least one piece needs a weight above 0')
  }
}

let boardRows = 0
if (p.board !== undefined) {
  if (!Array.isArray(p.board)) bad('board must be a list of rows, top row first')
  else {
    if (p.board.length > 20) bad(`board has ${p.board.length} rows, the well is only 20 tall`)
    p.board.forEach((row, i) => { if (typeof row !== 'string' || !/^[.#]{10}$/.test(row)) bad(`board row ${i + 1} must be exactly 10 characters of '.' or '#'`) })
    boardRows = p.board.length
    if (p.board.some((row) => row === '##########')) warn('a full board row is cleared before the game starts')
  }
}
if (boardRows + (p.garbageRows || 0) > 16) warn(`board (${boardRows} rows) plus garbage (${p.garbageRows || 0} rows) leaves almost no room: Jev may top out at once`)

if (!p.style || typeof p.style !== 'string') warn('a style line tells Jev how to play')
else if (p.style.length > 600) warn('style is cut at 600 characters')

console.log(fail ? 'fail   invalid blocks.json' : 'ok     blocks.json is valid')
process.exit(fail ? 1 : 0)
