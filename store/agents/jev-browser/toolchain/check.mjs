#!/usr/bin/env node
// check.mjs — validate a site.json for the Jev Browser harness: every number's range and every
// task's shape. Prints one line per problem and exits 1 on any error.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'
let errors = 0
const error = (msg) => { errors++; console.log(`error  ${msg}`) }
const warn = (msg) => console.log(`warn   ${msg}`)

let p
try {
  p = JSON.parse(readFileSync(join(ws, 'site.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read site.json: ${e.message}`)
  process.exit(1)
}

const range = (key, lo, hi, what) => {
  if (p[key] === undefined) return
  if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < lo || p[key] > hi) error(`${key} (${what}) must be a number from ${lo} to ${hi}`)
}
range('stepMs', 40, 2000, 'milliseconds per Jev decision')
range('distraction', 0, 1, 'the dial')
range('flights', 4, 9, 'result rows per search')
range('maxSteps', 12, 200, 'steps before a task fails')
range('seed', 0, 1e9, 'random seed')

if (!Array.isArray(p.tasks) || p.tasks.length < 1 || p.tasks.length > 40) error('tasks must be a list of 1 to 40 bookings')
else p.tasks.forEach((t, i) => {
  const at = `tasks[${i}]`
  for (const k of ['from', 'to', 'day', 'name', 'email']) if (typeof t?.[k] !== 'string' || !t[k].trim()) error(`${at}.${k} must be a non-empty string`)
  if (typeof t?.from === 'string' && !/^[A-Za-z]{2,4}$/.test(t.from.trim())) error(`${at}.from must be an airport code of 2 to 4 letters`)
  if (typeof t?.to === 'string' && !/^[A-Za-z]{2,4}$/.test(t.to.trim())) error(`${at}.to must be an airport code of 2 to 4 letters`)
  if (typeof t?.from === 'string' && t.from === t?.to) error(`${at}: from and to are the same airport`)
  if (!['cheapest', 'earliest', 'latest'].includes(t?.pick)) error(`${at}.pick must be "cheapest", "earliest" or "latest"`)
  if (typeof t?.nonstop !== 'boolean') error(`${at}.nonstop must be true or false`)
  if (!Number.isInteger(t?.bags) || t.bags < 0 || t.bags > 3) error(`${at}.bags must be a whole number from 0 to 3`)
  if (typeof t?.email === 'string' && !/@example\.(com|org|net)$/.test(t.email.trim())) warn(`${at}.email: use a made-up example.com address`)
  if (typeof t?.name === 'string' && /[()]/.test(t.name)) error(`${at}.name must not contain brackets`)
})
if (Array.isArray(p.tasks) && new Set(p.tasks.map((t) => t?.pick)).size === 1 && p.tasks.length > 2) warn('every task uses the same pick rule: mix cheapest, earliest and latest')
if (!p.title || typeof p.title !== 'string') warn('no title')
if (!p.style || typeof p.style !== 'string') warn('no style line: tell Jev how to work')
else if (p.style.length > 600) error('style must be 600 characters or fewer')

console.log(errors ? `fail   site.json has ${errors} error${errors > 1 ? 's' : ''}` : 'ok     site.json is valid')
process.exit(errors ? 1 : 0)
