#!/usr/bin/env node
// check.mjs — validate a firehose.json for the Jev Firehose harness.
//
//   node toolchain/check.mjs [path/to/firehose.json]
//
// Errors (exit code 1): values the viewer would have to clamp or drop.
// Warnings (exit code 0): words that make the desk harder to route than you meant, for example a
// phrase that shares more words with another team's description than with its own.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stems } from './jev.mjs'

const ws = process.env.HARNESS_WORKSPACE || '.'
const file = process.argv[2] || join(ws, 'firehose.json')

let errors = 0, warns = 0
const error = (msg) => { errors++; console.log(`error  ${msg}`) }
const warn = (msg) => { warns++; console.log(`warn   ${msg}`) }

let p
try {
  p = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.log(`error  cannot read firehose.json: ${e.message}`)
  process.exit(1)
}

const RANGES = {
  noise: [0, 1], threshold: [0, 1], targetAccuracy: [0.5, 1], ratePerSec: [1, 400], concurrency: [1, 64],
  batch: [50, 100000], llmSecondsPerItem: [0.1, 120], spamRate: [0, 0.5],
}
const REQUIRED = ['noise', 'threshold', 'ratePerSec', 'concurrency', 'batch']
const WHOLE = ['concurrency', 'batch']
for (const [key, [lo, hi]] of Object.entries(RANGES)) {
  const v = p[key]
  if (v === undefined) { if (REQUIRED.includes(key)) error(`${key} is missing (${lo}..${hi})`); continue }
  if (typeof v !== 'number' || !Number.isFinite(v)) { error(`${key} must be a number ${lo}..${hi}`); continue }
  if (v < lo || v > hi) error(`${key} is ${v}, must be ${lo}..${hi}`)
  else if (WHOLE.includes(key) && !Number.isInteger(v)) error(`${key} must be a whole number`)
}
if (p.seed !== undefined && !Number.isInteger(p.seed)) error('seed must be a whole number')
if (!p.title || typeof p.title !== 'string') warn('no title')
if (!p.desk || typeof p.desk !== 'string') warn('no desk line. Say what the desk is and that it is made up.')
else if (!/made[- ]up|synthetic|fictional|pretend|invented/i.test(p.desk)) warn('the desk line should say the data is made up (for example "a made-up bike shop")')

const teams = Array.isArray(p.teams) ? p.teams : null
if (!teams) error('teams must be a list of 2 to 24 teams')
else {
  if (teams.length < 2 || teams.length > 24) error(`teams has ${teams.length} entries, must be 2..24`)
  const seen = new Set()
  const desc = []
  teams.forEach((t, i) => {
    const id = typeof t?.id === 'string' ? t.id.trim() : ''
    const name = id || `#${i + 1}`
    if (!id) error(`team ${name} needs an id`)
    else if (id.length > 28) error(`team id "${id}" is longer than 28 characters`)
    else if (seen.has(id)) error(`team id "${id}" is used twice`)
    seen.add(id)
    if (typeof t?.description !== 'string' || !t.description.trim()) error(`team ${name} needs a description`)
    const phrases = Array.isArray(t?.phrases) ? t.phrases.filter((x) => typeof x === 'string' && x.trim()) : []
    if (phrases.length < 4) error(`team ${name} has ${phrases.length} phrases, needs at least 4`)
    if (t?.weight !== undefined && (typeof t.weight !== 'number' || t.weight < 0.1 || t.weight > 10)) error(`team ${name} weight must be 0.1..10`)
    desc.push(new Set(stems(`${id.replace(/[_-]+/g, ' ')} ${t?.description ?? ''}`)))
  })
  // Vocabulary lint. The offline stand-in routes by shared words, and sharp, distinct wording
  // helps live Jev too.
  let thin = 0, crossed = 0
  teams.forEach((t, i) => {
    for (const ph of Array.isArray(t?.phrases) ? t.phrases : []) {
      if (typeof ph !== 'string') continue
      const s = new Set(stems(ph))
      const hits = desc.map((d) => [...d].filter((w) => s.has(w)).length)
      const own = hits[i]
      let rival = -1
      hits.forEach((h, j) => { if (j !== i && (rival < 0 || h > hits[rival])) rival = j })
      if (rival >= 0 && hits[rival] >= own && hits[rival] > 0) { crossed++; if (crossed <= 8) warn(`"${ph}" (${t.id}) shares as many words with ${teams[rival].id}'s description (${hits[rival]}) as with its own (${own})`) }
      else if (own < 2) { thin++; if (thin <= 8) warn(`"${ph}" (${t.id}) shares only ${own} word(s) with its own description`) }
    }
  })
  if (crossed > 8) warn(`${crossed - 8} more phrases lean toward another team`)
  if (thin > 8) warn(`${thin - 8} more phrases share under 2 words with their own description`)
  for (let i = 0; i < desc.length; i++) for (let j = i + 1; j < desc.length; j++) {
    const shared = [...desc[i]].filter((w) => desc[j].has(w))
    if (shared.length >= 3) warn(`${teams[i].id} and ${teams[j].id} descriptions share ${shared.length} words (${shared.slice(0, 5).join(', ')}). Expect them to be confused.`)
  }
}

if (errors) { console.log(`fail   invalid firehose.json (${errors} error${errors > 1 ? 's' : ''}, ${warns} warning${warns === 1 ? '' : 's'})`); process.exit(1) }
console.log(`ok     firehose.json is valid (${teams.length} teams, ${teams.reduce((a, t) => a + t.phrases.length, 0)} phrases, ${warns} warning${warns === 1 ? '' : 's'})`)
