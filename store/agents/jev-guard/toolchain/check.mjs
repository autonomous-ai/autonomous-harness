#!/usr/bin/env node
// check.mjs — validate a Jev Guard workspace: goal.json present + readable, project/ exists with a
// test.js that actually runs (the viewer's test runner must work, else Jev has nothing to judge).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ws = process.env.HARNESS_WORKSPACE || '.'

let fail = false
let warnCount = 0
const bad = (msg) => { fail = true; console.log(msg) }
const warn = (msg) => { warnCount++; console.log(msg) }

let goal
try {
  goal = JSON.parse(readFileSync(join(ws, 'goal.json'), 'utf8'))
} catch (e) {
  bad(`error  cannot read goal.json: ${e.message}`)
}
if (goal && (!goal.goal || typeof goal.goal !== 'string')) bad('error  goal.json needs a string "goal"')
// The dials. All optional. The viewer clamps them; this says what it clamped.
const num = (key, lo, hi) => {
  const v = goal?.[key]
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)) bad('error  ' + key + ' must be a number ' + lo + '..' + hi + ' (got ' + JSON.stringify(v) + ')')
}
num('strictness', 0, 1)      // where REVIEW and BLOCK start. Strict catches more and raises more false alarms
num('subtlety', 0, 1)        // how well the planted risks in the demo stream are hidden. The difficulty dial
num('stepMs', 60, 5000)      // pace of the demo stream, ms per made-up edit
num('diffBudget', 300, 8000) // characters of a diff Jev gets to read
num('seed', 0, 1e9)

if (!existsSync(join(ws, 'project', 'test.js'))) {
  bad('error  project/test.js is required (the viewer runs it to judge the agent)')
} else {
  const res = spawnSync('node', [join(ws, 'project', 'test.js')], { encoding: 'utf8', timeout: 15000 })
  if (res.error) bad(`error  project/test.js could not run: ${res.error.message}`)
  else if (res.status !== 0) warn('warn  project/test.js currently fails (expected at the start — the agent is meant to fix it)')
}

console.log(fail ? 'fail  invalid Jev Guard workspace' : 'ok   Jev Guard workspace is valid')
process.exit(fail ? 1 : 0)