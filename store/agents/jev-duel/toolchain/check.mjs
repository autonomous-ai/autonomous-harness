#!/usr/bin/env node
// check.mjs — validate a battle.json for the Jev Duel harness.
// Enforces the shape the viewer needs: board size, speed, two rivals with names/personalities,
// referee focus.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let battle
try {
  battle = JSON.parse(readFileSync(join(ws, 'battle.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read battle.json: ${e.message}`)
  process.exit(1)
}

if (!battle.title || typeof battle.title !== 'string') bad('warn  no title')
if (!Number.isInteger(battle.size) || battle.size < 4 || battle.size > 12 || battle.size % 2 !== 0) bad('error  size must be an even integer 4..12')
if (typeof battle.speed !== 'number' || battle.speed < 200 || battle.speed > 5000) bad('warn  speed should be ms 200..5000')
if (!battle.rivals || typeof battle.rivals !== 'object') bad('error  rivals must be an object')
for (const disk of ['O', 'X']) {
  const r = battle.rivals?.[disk]
  if (!r) { bad(`error  rivals.${disk} is required`); continue }
  if (!r.name || typeof r.name !== 'string') bad(`error  rivals.${disk}.name is required`)
  if (!r.personality || typeof r.personality !== 'string') bad(`error  rivals.${disk}.personality is required`)
  if (!/^[ox]$/i.test(String(r.name).replace(/[^oxO]/g, '')) && /(O|X)/.test(r.name)) {
    // names like "Patience (O)" are fine; flag nothing, keep it permissive
  }
}
if (!battle.referee || typeof battle.referee !== 'string') bad('warn  referee focus is a nice-to-have')

console.log(fail ? 'fail  invalid battle.json' : 'ok   battle.json is valid')
process.exit(fail ? 1 : 0)
