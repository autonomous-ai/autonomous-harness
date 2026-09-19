#!/usr/bin/env node
// check.mjs — validate a launcher.json for the Jev Launcher harness.
// Enforces the shape the viewer needs: a title, a palette of named launch targets (each with a
// category and aliases), and a description of what kind of launcher this is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let launcher
try {
  launcher = JSON.parse(readFileSync(join(ws, 'launcher.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read launcher.json: ${e.message}`)
  process.exit(1)
}

if (!launcher.title || typeof launcher.title !== 'string') bad('error  a title is required')
if (!Array.isArray(launcher.targets) || launcher.targets.length < 2) bad('error  targets must be a list of at least 2 launch targets')
if (Array.isArray(launcher.targets) && launcher.targets.length > 30) bad('error  targets should be 30 or fewer (Jev ranks one choice per target per keystroke)')
const seen = new Set()
const targetList = Array.isArray(launcher.targets) ? launcher.targets : []
targetList.forEach((t, i) => {
  if (!t || typeof t !== 'object' || !t.name || typeof t.name !== 'string') bad(`error  target ${i} needs a name`)
  if (seen.has(t.name)) bad(`error  duplicate target name: ${t.name}`)
  seen.add(t.name)
  if (!Array.isArray(t.aliases) || !t.aliases.length) bad(`warn  target "${t.name}" has no aliases — give it a few so Jev has something to fuzzy-match`)
})
// The demo typist's dials. All optional. The viewer clamps them; this says what it clamped.
const num = (key, lo, hi) => {
  const v = launcher[key]
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)) bad('error  ' + key + ' must be a number ' + lo + '..' + hi + ' (got ' + JSON.stringify(v) + ')')
}
num('typos', 0, 1)            // chance the demo typist fumbles a letter. A difficulty dial
num('chars', 1, 12)           // the demo typist launches after at most this many letters. A difficulty dial
num('lookalikes', 0, 6)       // how many targets get a near-duplicate twin. A difficulty dial
num('stepMs', 40, 2000)       // demo typist pace, ms per keystroke
num('idleMs', 1000, 120000)   // the demo typist comes back after this long without a human key
num('seed', 0, 1e9)
if (Array.isArray(launcher.targets) && launcher.targets.length > 12) console.log('hint  many targets — Jev will rank them all; keep names and aliases distinct so the ranking reads clearly')

console.log(fail ? 'fail  invalid launcher.json' : 'ok   launcher.json is valid')
process.exit(fail ? 1 : 0)
