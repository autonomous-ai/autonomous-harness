// source.mjs — bring your own messages. firehose.json may name a file in the workspace:
//
//   { "source": "inbox.jsonl", "textColumn": "body", ... }
//
// A .csv or .tsv file (header row first), a .jsonl file (one JSON object or string per line) or a
// .json file (a list) becomes the stream. One column is the message text, and ONLY that text is
// sent to Jev. Every other column is kept exactly as it was and copied into triage.csv.
// The file must live inside the workspace. Adapted from the Jev Sheets loader.
import { readFileSync, statSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'

export const SOURCE_LIMITS = { bytes: 8 * 1024 * 1024, messages: 20000, text: 4000, fields: 40, nested: 2000 }
export const SOURCE_EXTENSIONS = ['.csv', '.tsv', '.jsonl', '.ndjson', '.json']
export const OUTPUT_FILE = 'triage.csv'
const TEXT_NAMES = ['text', 'message', 'body', 'content', 'description', 'comment', 'note', 'notes', 'review', 'subject', 'title', 'summary']
const ID_NAMES = ['id', 'message_id', 'ticket_id', 'ticket', 'uuid', 'key']

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

/**
 * One CSV cell, RFC 4180: quote when it holds a quote, a comma, a line break or outer spaces.
 * The person's messages are untrusted text: a cell starting with = + - @ would run as a formula in
 * a spreadsheet, so it gets a leading single quote, unless it is only a number.
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const csvLine = (cells) => cells.map(csvCell).join(',')

function pickTextColumn(headers, records, wanted) {
  const lower = headers.map((h) => h.toLowerCase())
  if (wanted) { const i = lower.indexOf(String(wanted).toLowerCase()); if (i >= 0) return { index: i }; return { index: -1, error: `textColumn "${wanted}" is not a column of the file (columns: ${headers.join(', ')})` } }
  for (const name of TEXT_NAMES) { const i = lower.indexOf(name); if (i >= 0) return { index: i } }
  // Otherwise the column whose values are longest on average is the prose.
  let best = 0, bestLen = -1
  headers.forEach((_, i) => { const avg = records.slice(0, 200).reduce((a, r) => a + String(r[i] ?? '').length, 0) / Math.max(1, Math.min(200, records.length)); if (avg > bestLen) { bestLen = avg; best = i } })
  return { index: best }
}

/** A column value exactly as the person had it (nested JSON becomes its JSON text). */
function keep(v) {
  if (v == null) return ''
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, SOURCE_LIMITS.nested) } catch { return '' } }
  return String(v)
}

/**
 * Load messages from a workspace file. Never throws: returns { rows, error, file, info }.
 * Each row is { row, id, text, cells } where `row` is the 1-based data row in the file, `id` is the
 * file's own id column when it has one (else the row number), and `cells` are the original values
 * in the order of `info.columns`.
 * @param {string} workspace  absolute workspace path
 * @param {string} name       the file, relative to the workspace
 */
export function loadSource(workspace, name, { textColumn, limit = SOURCE_LIMITS.messages } = {}) {
  const root = resolve(workspace)
  const fail = (error) => ({ rows: [], error, file: null, info: null })
  if (typeof name !== 'string' || !name.trim()) return fail('source must be a file name')
  const file = resolve(root, name)
  if (file !== root && !file.startsWith(root + sep)) return fail(`source "${name}" must be a file inside the workspace`)
  if (file === root) return fail(`source "${name}" must be a file inside the workspace`)
  if (file.split(sep).includes('.harness')) return fail('source must not be inside .harness')
  if (file === resolve(root, OUTPUT_FILE)) return fail(`source cannot be ${OUTPUT_FILE}, that is the file the results are written to`)
  const ext = extname(file).toLowerCase()
  if (!SOURCE_EXTENSIONS.includes(ext)) return fail(`source "${name}" must be a .csv, .tsv, .jsonl or .json file`)
  let raw, stamp
  try {
    const st = statSync(file)
    if (!st.isFile()) return fail(`source "${name}" is not a file`)
    if (st.size > SOURCE_LIMITS.bytes) return fail(`source "${name}" is over ${SOURCE_LIMITS.bytes / 1024 / 1024} MB`)
    stamp = `${st.mtimeMs}:${st.size}`
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) { return fail(`source "${name}" cannot be read: ${e.code ?? e.message}`) }

  let headers, table // table: list of cell lists, aligned with headers
  try {
    if (ext === '.csv' || ext === '.tsv') {
      const all = parseDelimited(raw, ext === '.tsv' ? '\t' : undefined)
      if (all.length < 2) return fail(`source "${name}" needs a header row and at least one data row`)
      headers = all[0].map((h, i) => String(h).trim() || `column_${i + 1}`)
      table = all.slice(1)
    } else {
      const list = ext === '.json' ? JSON.parse(raw) : raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      if (!Array.isArray(list)) return fail(`source "${name}" must hold a list`)
      const seen = new Set()
      for (const o of list.slice(0, 500)) if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) seen.add(k)
      headers = [...seen]
      if (!headers.length) headers = ['text']
      table = list.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? headers.map((h) => item[h]) : { bare: typeof item === 'string' ? item : '' }))
    }
  } catch (e) { return fail(`source "${name}" could not be parsed: ${e.message}`) }

  const pick = pickTextColumn(headers, table.map((cells) => (Array.isArray(cells) ? cells.map((c) => (typeof c === 'string' ? c : '')) : [])), textColumn)
  if (pick.error) return fail(pick.error)
  const textName = headers[pick.index]
  const lower = headers.map((h) => h.toLowerCase())
  let idIndex = -1
  for (const n of ID_NAMES) { const i = lower.indexOf(n); if (i >= 0 && i !== pick.index) { idIndex = i; break } }
  const colIndex = headers.map((_, i) => i).filter((i) => i !== idIndex).slice(0, SOURCE_LIMITS.fields)

  const rows = []
  let skipped = 0
  for (let r = 0; r < table.length; r++) {
    // a bare string in a list is the message itself: it goes in the text column
    const cells = Array.isArray(table[r]) ? table[r] : headers.map((_, i) => (i === pick.index ? table[r].bare : ''))
    const text = keep(cells[pick.index]).trim()
    if (!text) { skipped++; continue }
    const ownId = idIndex >= 0 ? keep(cells[idIndex]).trim() : ''
    rows.push({ row: r + 1, id: ownId || String(r + 1), text: text.slice(0, SOURCE_LIMITS.text), cells: colIndex.map((i) => keep(cells[i])) })
    if (rows.length >= limit) break
  }
  if (!rows.length) return fail(`source "${name}" has no rows with text in column "${textName}"`)
  return {
    rows, error: null, file,
    info: { name, textColumn: textName, idColumn: idIndex >= 0 ? headers[idIndex] : null, columns: colIndex.map((i) => headers[i]), total: table.length, used: rows.length, skipped, truncated: table.length - skipped > rows.length, stamp },
  }
}
