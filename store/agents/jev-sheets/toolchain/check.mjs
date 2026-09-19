#!/usr/bin/env node
// check.mjs — validate a sheet.json for the Jev Sheets harness.
// Uses the same header parser as the viewer, so what passes here is what the pane can show.
//   node toolchain/check.mjs            checks $HARNESS_WORKSPACE/sheet.json (or ./sheet.json)
//   node toolchain/check.mjs path.json  checks that file
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { parseHeader, LIMITS } from '../viewer/grammar.mjs'
import { loadSource } from '../viewer/source.mjs'

const file = process.argv[2] || join(process.env.HARNESS_WORKSPACE || '.', 'sheet.json')
let errors = 0, warnings = 0
const error = (msg) => { errors++; console.log(`error  ${msg}`) }
const warn = (msg) => { warnings++; console.log(`warn   ${msg}`) }

let sheet
try {
  sheet = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.log(`error  cannot read sheet.json: ${e.message}`)
  process.exit(1)
}
if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) { console.log('error  sheet.json must be a JSON object'); process.exit(1) }

if (!sheet.title || typeof sheet.title !== 'string') warn('no title')
if (!sheet.description || !/made.?up|synthetic|fictional|not real/i.test(String(sheet.description))) warn('say in "description" that the data is made up')

// ---- columns: 0 to 12 valid headers ------------------------------------------------------------
const columns = new Map()
const rawCols = sheet.columns ?? []
if (!Array.isArray(rawCols)) error('"columns" must be a list')
else {
  if (rawCols.length > LIMITS.maxColumns) error(`at most ${LIMITS.maxColumns} Jev columns (found ${rawCols.length})`)
  rawCols.forEach((c, i) => {
    const header = typeof c === 'string' ? c : c?.header
    const parsed = parseHeader(header, c && typeof c === 'object' ? c.id : undefined)
    if (!parsed.ok) return error(`column ${i + 1}: ${parsed.error}`)
    const col = parsed.column
    if (columns.has(col.id)) return error(`column ${i + 1}: id "${col.id}" is used twice`)
    columns.set(col.id, col)
    if (col.type === 'choice' && Object.keys(col.descriptions).length < col.options.length) warn(`column "${col.name}": give every option a meaning (option = what it means). It makes Jev sharper`)
    if (col.bare) warn(`column "${col.name}": a bare word becomes low < medium < high. Name your own levels for a sharper scale`)
  })
}

// ---- rows: 1 to 2000, each with text -----------------------------------------------------------
// A sheet may take its rows from the person's own file in the workspace: "source": "leads.csv".
let sourceRows = 0
if (sheet.source !== undefined) {
  if (typeof sheet.source !== 'string' || !sheet.source.trim()) error('"source" must be a file name inside the workspace')
  else {
    const got = loadSource(resolve(dirname(file)), sheet.source.trim(), { textColumn: sheet.textColumn, limit: LIMITS.maxRows })
    if (got.error) error(got.error)
    else { sourceRows = got.rows.length; console.log(`info   source ${got.info.name}: ${got.info.used} of ${got.info.total} rows, text column "${got.info.textColumn}"`) }
  }
}
const rows = sheet.rows === undefined && sheet.source !== undefined ? [] : sheet.rows
if (!Array.isArray(rows)) error('"rows" must be a list')
else {
  if (rows.length + sourceRows < 1 || rows.length > LIMITS.maxRows) error(`rows must number 1 to ${LIMITS.maxRows} (found ${rows.length + sourceRows})`)
  const ids = new Set()
  let labelled = 0
  rows.forEach((r, i) => {
    const where = `row ${i + 1}${r?.id ? ` (${r.id})` : ''}`
    if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !r.text.trim()) return error(`${where}: needs a non-empty "text"`)
    if (r.id != null) { if (ids.has(String(r.id))) error(`${where}: id is used twice`); ids.add(String(r.id)) }
    if (r.truth == null) return
    if (typeof r.truth !== 'object' || Array.isArray(r.truth)) return error(`${where}: "truth" must be an object of columnId -> value`)
    labelled++
    for (const [cid, v] of Object.entries(r.truth)) {
      const col = columns.get(cid)
      if (!col) { warn(`${where}: truth for "${cid}", but there is no column with that id`); continue }
      if (col.type === 'noul' && typeof v !== 'boolean') error(`${where}: truth.${cid} must be true or false`)
      if (col.type === 'choice' && !col.options.some((o) => o.toLowerCase() === String(v).toLowerCase())) error(`${where}: truth.${cid} "${v}" is not one of ${col.options.join(' | ')}`)
      if (col.type === 'score' && !(Number.isInteger(v) ? v >= 0 && v < col.levels.length : col.levels.some((l) => l.toLowerCase() === String(v).toLowerCase()))) error(`${where}: truth.${cid} "${v}" is not one of ${col.levels.join(' < ')}`)
    }
  })
  if (rows.length && !labelled && !sourceRows) warn('no truth labels, so the pane cannot show accuracy')
}

// ---- settings ----------------------------------------------------------------------------------
if (sheet.reviewBelow != null && !(typeof sheet.reviewBelow === 'number' && sheet.reviewBelow >= 0 && sheet.reviewBelow <= 1)) error('reviewBelow must be a number from 0 to 1')
if (sheet.concurrency != null && !(Number.isInteger(sheet.concurrency) && sheet.concurrency >= 1 && sheet.concurrency <= 32)) error('concurrency must be a whole number from 1 to 32')
if (sheet.suggestions != null) {
  if (!Array.isArray(sheet.suggestions)) error('"suggestions" must be a list of headers')
  else sheet.suggestions.forEach((s, i) => { const p = parseHeader(s); if (!p.ok) error(`suggestion ${i + 1}: ${p.error}`) })
}

if (errors) { console.log(`fail   invalid sheet.json (${errors} error${errors > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'})`); process.exit(1) }
console.log(`ok     sheet.json is valid: ${rows.length} rows, ${columns.size} Jev columns${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`)
