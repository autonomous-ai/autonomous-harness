// source.mjs — bring your own rows. sheet.json may name a file in the workspace:
//
//   { "source": "leads.csv", "textColumn": "message", ... }
//
// A .csv or .tsv file (header row first), a .jsonl file (one JSON object or string per line) or a
// .json file (a list) becomes the sheet's rows. One column is the row's text; the other columns
// ride along as plain fields that Jev also reads. The file must live inside the workspace.
import { readFileSync, statSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'

export const SOURCE_LIMITS = { bytes: 8 * 1024 * 1024, field: 300, fields: 24 }
const TEXT_NAMES = ['text', 'message', 'body', 'content', 'description', 'comment', 'note', 'notes', 'review', 'subject', 'title', 'summary']

/** A small RFC 4180 reader: quoted fields, doubled quotes, CRLF, and a guessed delimiter. */
export function parseDelimited(src, delimiter) {
  const firstLine = src.slice(0, src.indexOf('\n') < 0 ? src.length : src.indexOf('\n'))
  const d = delimiter ?? [',', '\t', ';', '|'].map((c) => [c, firstLine.split(c).length]).sort((a, b) => b[1] - a[1])[0][0]
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === d) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function pickTextColumn(headers, records, wanted) {
  const lower = headers.map((h) => h.toLowerCase())
  if (wanted) { const i = lower.indexOf(String(wanted).toLowerCase()); if (i >= 0) return { index: i } ; return { index: -1, error: `textColumn "${wanted}" is not a column of the file (columns: ${headers.join(', ')})` } }
  for (const name of TEXT_NAMES) { const i = lower.indexOf(name); if (i >= 0) return { index: i } }
  // Otherwise the column whose values are longest on average is the prose.
  let best = 0, bestLen = -1
  headers.forEach((_, i) => { const avg = records.slice(0, 200).reduce((a, r) => a + String(r[i] ?? '').length, 0) / Math.max(1, Math.min(200, records.length)); if (avg > bestLen) { bestLen = avg; best = i } })
  return { index: best }
}

const tidyKey = (k) => String(k).trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '').slice(0, 40)
function tidyValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  const s = String(v ?? '').trim()
  if (s === '') return undefined
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s)
  return s.slice(0, SOURCE_LIMITS.field)
}

/**
 * Load rows from a workspace file. Never throws: returns { rows, error, file, info }.
 * @param {string} workspace  absolute workspace path
 * @param {string} name       the file, relative to the workspace
 */
export function loadSource(workspace, name, { textColumn, limit = 2000 } = {}) {
  const root = resolve(workspace)
  const file = resolve(root, String(name))
  const fail = (error) => ({ rows: [], error, file: null, info: null })
  if (file !== root && !file.startsWith(root + sep)) return fail(`source "${name}" must be a file inside the workspace`)
  if (file.split(sep).includes('.harness')) return fail('source must not be inside .harness')
  let raw
  try {
    if (statSync(file).size > SOURCE_LIMITS.bytes) return fail(`source "${name}" is over ${SOURCE_LIMITS.bytes / 1024 / 1024} MB`)
    raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch (e) { return fail(`source "${name}" cannot be read: ${e.code ?? e.message}`) }

  const ext = extname(file).toLowerCase()
  let records // list of { text, ...fields }
  let textName = 'text'
  try {
    if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      const table = parseDelimited(raw, ext === '.tsv' ? '\t' : undefined)
      if (table.length < 2) return fail(`source "${name}" needs a header row and at least one data row`)
      const headers = table[0].map((h, i) => String(h).trim() || `column_${i + 1}`)
      const body = table.slice(1)
      const pick = pickTextColumn(headers, body, textColumn)
      if (pick.error) return fail(pick.error)
      textName = headers[pick.index]
      records = body.map((cells) => {
        const rec = { text: String(cells[pick.index] ?? '').trim() }
        headers.forEach((h, i) => { if (i !== pick.index && Object.keys(rec).length <= SOURCE_LIMITS.fields) { const v = tidyValue(cells[i]); if (v !== undefined) rec[tidyKey(h) || `column_${i + 1}`] = v } })
        return rec
      })
    } else if (ext === '.jsonl' || ext === '.ndjson' || ext === '.json') {
      const list = ext === '.json' ? JSON.parse(raw) : raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      if (!Array.isArray(list)) return fail(`source "${name}" must hold a list`)
      const objs = list.filter((x) => x && typeof x === 'object')
      const keys = [...new Set(objs.slice(0, 200).flatMap((o) => Object.keys(o)))]
      const pick = keys.length ? pickTextColumn(keys, objs.map((o) => keys.map((k) => (typeof o[k] === 'string' ? o[k] : ''))), textColumn) : { index: -1 }
      if (pick.error) return fail(pick.error)
      textName = keys[pick.index] ?? 'text'
      records = list.map((item) => {
        if (typeof item === 'string') return { text: item.trim() }
        if (!item || typeof item !== 'object') return { text: '' }
        const rec = { text: String(item[textName] ?? '').trim() }
        for (const [k, v] of Object.entries(item)) if (k !== textName && ['string', 'number', 'boolean'].includes(typeof v) && Object.keys(rec).length <= SOURCE_LIMITS.fields) { const t = tidyValue(v); if (t !== undefined) rec[tidyKey(k)] = t }
        return rec
      })
    } else return fail(`source "${name}" must be a .csv, .tsv, .jsonl or .json file`)
  } catch (e) { return fail(`source "${name}" could not be parsed: ${e.message}`) }

  const total = records.length
  const rows = []
  for (const rec of records) {
    if (!rec.text) continue
    // `id`, `truth` and `group` mean something to the sheet; a data column with that name is renamed.
    const row = { text: rec.text }
    for (const [k, v] of Object.entries(rec)) if (k !== 'text') row[['id', 'truth', 'group'].includes(k) ? `${k}_` : k] = v
    rows.push(row)
    if (rows.length >= limit) break
  }
  if (!rows.length) return fail(`source "${name}" has no rows with text in column "${textName}"`)
  return { rows, error: null, file, info: { name: String(name), textColumn: textName, total, used: rows.length } }
}
