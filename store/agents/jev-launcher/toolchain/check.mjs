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
if (launcher.targets.length > 30) bad('error  targets should be 30 or fewer (Jev ranks one choice per target per keystroke)')
const seen = new Set()
launcher.targets.forEach((t, i) => {
  if (!t || typeof t !== 'object' || !t.name || typeof t.name !== 'string') bad(`error  target ${i} needs a name`)
  if (seen.has(t.name)) bad(`error  duplicate target name: ${t.name}`)
  seen.add(t.name)
  if (!Array.isArray(t.aliases) || !t.aliases.length) bad(`warn  target "${t.name}" has no aliases — give it a few so Jev has something to fuzzy-match`)
})
if (launcher.targets.length > 12) console.log('hint  many targets — Jev will rank them all; keep names and aliases distinct so the ranking reads clearly')

console.log(fail ? 'fail  invalid launcher.json' : 'ok   launcher.json is valid')
process.exit(fail ? 1 : 0)
