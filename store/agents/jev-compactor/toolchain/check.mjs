#!/usr/bin/env node
// check.mjs — validate a session.json for the Jev Compactor harness.
// Usage: node check.mjs [path/to/session.json]   (default: $HARNESS_WORKSPACE/session.json, else ./session.json)
// Prints one line per problem. Exit code 1 when there is an error, 0 otherwise (warnings pass).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const file = process.argv[2] || join(process.env.HARNESS_WORKSPACE || '.', 'session.json')

let errors = 0, warnings = 0
const error = (msg) => { errors++; console.log(`error  ${msg}`) }
const warn = (msg) => { warnings++; console.log(`warn   ${msg}`) }

let p
try {
  p = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.log(`error  cannot read ${file}: ${e.message}`)
  console.log('fail   invalid session.json')
  process.exit(1)
}
if (!p || typeof p !== 'object' || Array.isArray(p)) { console.log('error  session.json must be one JSON object'); console.log('fail   invalid session.json'); process.exit(1) }

const range = (key, lo, hi, { required = false, integer = false } = {}) => {
  const v = p[key]
  if (v === undefined) { if (required) error(`${key} is required (${lo}..${hi})`); return }
  if (typeof v !== 'number' || !Number.isFinite(v)) return error(`${key} must be a number (${lo}..${hi})`)
  if (v < lo || v > hi) return error(`${key} is ${v}, it must be ${lo}..${hi}`)
  if (integer && !Number.isInteger(v)) warn(`${key} should be a whole number`)
}

if (!p.title || typeof p.title !== 'string') warn('no title')
if (p.repo !== undefined && (typeof p.repo !== 'string' || !p.repo)) error('repo must be a made-up repo name (text)')

range('budget', 20000, 2000000, { required: true, integer: true })
range('trimTo', 50, 5000, { required: true, integer: true })
range('distraction', 0, 1, { required: true })
range('eventsPerSec', 1, 60, { required: true })
range('target', 0.2, 0.9)
range('recallTarget', 0.5, 1)
range('noise', 0, 0.9)
range('focus', 0.1, 1)
range('summaryTokens', 200, 20000, { integer: true })
range('taskEvery', 0, 5000, { integer: true })
range('seed', 0, 2147483647, { integer: true })

// tasks: 2 to 12, each with an id, a title and at least 6 vocabulary words
const ids = new Set()
if (!Array.isArray(p.tasks)) error('tasks must be a list of 2 to 12 tasks')
else {
  if (p.tasks.length < 2 || p.tasks.length > 12) error(`tasks has ${p.tasks.length} entries, it must have 2 to 12`)
  const owner = new Map()
  p.tasks.forEach((t, i) => {
    const where = `tasks[${i}]`
    if (!t || typeof t !== 'object') return error(`${where} must be an object { id, title, vocabulary }`)
    if (typeof t.id !== 'string' || !t.id.trim()) error(`${where}.id is required`)
    else if (ids.has(t.id)) error(`${where}.id "${t.id}" is used twice`)
    else ids.add(t.id)
    if (typeof t.title !== 'string' || !t.title.trim()) error(`${where}.title is required`)
    if (!Array.isArray(t.vocabulary)) return error(`${where}.vocabulary must be a list of at least 6 words`)
    const words = [...new Set(t.vocabulary.filter((w) => typeof w === 'string').map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((w) => w.length > 1))]
    if (words.length < 6) error(`${where}.vocabulary has ${words.length} usable words, it needs at least 6`)
    if (t.vocabulary.some((w) => typeof w !== 'string' || /\s/.test(w.trim()))) warn(`${where}.vocabulary should be single words`)
    for (const w of words) {
      if (owner.has(w) && owner.get(w) !== t.id) warn(`the word "${w}" is in both "${owner.get(w)}" and "${t.id}". Shared words make Jev keep the wrong task's blocks`)
      else owner.set(w, t.id)
    }
  })
}
if (p.currentTask !== undefined && !ids.has(p.currentTask)) error(`currentTask "${p.currentTask}" is not one of the task ids`)

// event mix
const MIX = ['user', 'assistant', 'Read', 'Grep', 'Bash', 'Edit', 'WebFetch']
if (p.mix !== undefined) {
  if (!p.mix || typeof p.mix !== 'object' || Array.isArray(p.mix)) error('mix must be an object of weights')
  else {
    for (const [k, v] of Object.entries(p.mix)) {
      if (!MIX.includes(k)) warn(`mix.${k} is not a known event kind (${MIX.join(', ')})`)
      else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) error(`mix.${k} must be a number 0..1000`)
    }
    if (!['Read', 'Grep', 'Bash', 'Edit', 'WebFetch'].some((k) => (p.mix[k] ?? 1) > 0)) error('mix needs at least one tool with a weight above 0')
  }
}

if (typeof p.trimTo === 'number' && p.trimTo < 300) warn('trimTo is under 300, so trimmed "gist" results lose needle tokens')
if (typeof p.target === 'number' && typeof p.budget === 'number' && p.target * p.budget < 8000) warn('target x budget is very small, the pressure pass will cut needles')

console.log(errors ? `fail   invalid session.json (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})` : `ok     session.json is valid${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`)
process.exit(errors ? 1 : 0)
