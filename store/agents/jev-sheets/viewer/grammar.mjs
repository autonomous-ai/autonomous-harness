// grammar.mjs — the header grammar of Jev Sheets. ONE parser, shared by the viewer server, the pane
// (it shows a live hint while a person types a header) and toolchain/check.mjs.
//
// A Jev column is a typed question, written as a spreadsheet header:
//   Urgent?                                   ends with "?"            -> noul   (yes / no)
//   Team: billing | tech | sales              name: a | b | c          -> choice (2..255 options)
//   Team: billing = invoices | tech = bugs    option = what it means   -> choice with descriptions
//   Anger: calm < annoyed < furious           name: low < ... < high   -> score  (2..10 ordered levels)
//   Urgency                                   a bare word              -> score  low < medium < high

export const LIMITS = {
  maxRows: 2000, maxColumns: 12, maxHeader: 20000, maxName: 80,
  minOptions: 2, maxOptions: 255, minLevels: 2, maxLevels: 10,
}

export const BARE_LEVELS = ['low', 'medium', 'high']

/** A stable id from a name: "Churn risk" -> "churn_risk". */
export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'col'
}

const fail = (error) => ({ ok: false, error })
const dupe = (list) => { const seen = new Set(); for (const x of list) { const k = x.toLowerCase(); if (seen.has(k)) return x; seen.add(k) } return null }

/**
 * Parse one header into a column definition.
 * @returns {{ok:true, column:{id,header,name,type,options?,descriptions?,levels?,bare?}} | {ok:false, error:string}}
 */
export function parseHeader(input, id = undefined) {
  if (typeof input !== 'string') return fail('a header must be text')
  const header = input.replace(/\s+/g, ' ').trim()
  if (!header) return fail('type a header first')
  if (header.length > LIMITS.maxHeader) return fail(`a header can be at most ${LIMITS.maxHeader} characters`)

  const colon = header.indexOf(':')
  const name = (colon > 0 ? header.slice(0, colon) : header).trim()
  const body = colon > 0 ? header.slice(colon + 1).trim() : ''
  const done = (col) => {
    if (col.name.length > LIMITS.maxName) return fail(`keep the column name under ${LIMITS.maxName} characters`)
    return { ok: true, column: { id: id ? slug(id) : slug(col.name), header, ...col } }
  }

  if (colon > 0 && body.includes('<') && body.includes('|')) return fail('use "|" for a choice or "<" for a score, not both')

  if (colon > 0 && body.includes('<')) {
    const levels = body.split('<').map((s) => s.trim())
    if (levels.some((l) => !l)) return fail('a score has an empty level. Write low < medium < high')
    if (levels.length < LIMITS.minLevels || levels.length > LIMITS.maxLevels) return fail(`a score needs ${LIMITS.minLevels} to ${LIMITS.maxLevels} levels`)
    const d = dupe(levels); if (d) return fail(`level "${d}" is listed twice`)
    return done({ name, type: 'score', levels })
  }

  if (colon > 0 && body.includes('|')) {
    const options = [], descriptions = {}
    for (const part of body.split('|')) {
      const eq = part.indexOf('=')
      const opt = (eq >= 0 ? part.slice(0, eq) : part).trim()
      const desc = eq >= 0 ? part.slice(eq + 1).trim() : ''
      if (!opt) return fail('a choice has an empty option. Write a | b | c')
      options.push(opt)
      if (desc) descriptions[opt] = desc
    }
    if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) return fail(`a choice needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options`)
    const d = dupe(options); if (d) return fail(`option "${d}" is listed twice`)
    return done({ name, type: 'choice', options, descriptions })
  }

  if (header.endsWith('?')) return done({ name: header.replace(/\s*\?+$/, '').trim() || header, type: 'noul' })

  if (colon > 0) return fail(body ? 'after the colon, list options with "|" or levels with "<"' : 'after the colon, list options (a | b) or levels (low < high)')

  return done({ name, type: 'score', levels: [...BARE_LEVELS], bare: true })
}

/** A short plain-English reading of a header, for the live hint under the add box. */
export function describeColumn(col) {
  if (col.type === 'noul') return 'yes / no question'
  if (col.type === 'choice') return `choice of ${col.options.length}${Object.keys(col.descriptions ?? {}).length ? ', with descriptions' : ''}`
  return `score with ${col.levels.length} levels${col.bare ? ' (a bare word)' : ''}`
}

/** The cache identity of a column: two headers that ask the same thing share answers. */
export function columnKey(col) {
  if (col.type === 'noul') return `noul|${col.header}`
  if (col.type === 'choice') return `choice|${col.name}|${col.options.map((o) => `${o}=${col.descriptions?.[o] ?? ''}`).join('|')}`
  return `score|${col.name}|${col.levels.join('<')}`
}

const RESERVED = new Set(['id', 'text', 'truth', 'group'])

/**
 * Turn raw sheet.json into a clean sheet. Never throws: problems come back as `errors` (the bad
 * item is skipped) so one bad row or header cannot take the demo down.
 */
export function normalizeSheet(raw) {
  const errors = []
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (src !== raw) errors.push('sheet.json must be a JSON object')

  const rows = []
  const ids = new Set()
  const rawRows = Array.isArray(src.rows) ? src.rows : []
  if (!Array.isArray(src.rows)) errors.push('"rows" must be a list')
  if (rawRows.length > LIMITS.maxRows) errors.push(`only the first ${LIMITS.maxRows} rows are used`)
  rawRows.slice(0, LIMITS.maxRows).forEach((r, i) => {
    const row = typeof r === 'string' ? { text: r } : r
    if (!row || typeof row !== 'object' || typeof row.text !== 'string' || !row.text.trim()) { errors.push(`row ${i + 1} has no text`); return }
    let rid = String(row.id ?? `r${i + 1}`)
    while (ids.has(rid)) rid += '_'
    ids.add(rid)
    const meta = {}
    for (const [k, v] of Object.entries(row)) if (!RESERVED.has(k) && ['string', 'number', 'boolean'].includes(typeof v)) meta[k] = v
    rows.push({
      id: rid, text: row.text.trim().slice(0, 4000), meta,
      group: typeof row.group === 'string' ? row.group : null,
      truth: row.truth && typeof row.truth === 'object' && !Array.isArray(row.truth) ? { ...row.truth } : null,
    })
  })

  const columns = []
  const colIds = new Set()
  const rawCols = Array.isArray(src.columns) ? src.columns : []
  if (src.columns != null && !Array.isArray(src.columns)) errors.push('"columns" must be a list')
  if (rawCols.length > LIMITS.maxColumns) errors.push(`only the first ${LIMITS.maxColumns} columns are used`)
  rawCols.slice(0, LIMITS.maxColumns).forEach((c, i) => {
    const header = typeof c === 'string' ? c : c?.header
    const parsed = parseHeader(header, typeof c === 'object' && c ? c.id : undefined)
    if (!parsed.ok) { errors.push(`column ${i + 1}: ${parsed.error}`); return }
    if (colIds.has(parsed.column.id)) { errors.push(`column ${i + 1}: id "${parsed.column.id}" is used twice`); return }
    colIds.add(parsed.column.id)
    columns.push(parsed.column)
  })

  let reviewBelow = Number(src.reviewBelow ?? 0.65)
  if (!Number.isFinite(reviewBelow) || reviewBelow < 0 || reviewBelow > 1) { errors.push('reviewBelow must be between 0 and 1'); reviewBelow = 0.65 }
  let concurrency = Math.round(Number(src.concurrency ?? 8))
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 32) { errors.push('concurrency must be 1 to 32'); concurrency = 8 }

  return {
    title: typeof src.title === 'string' && src.title.trim() ? src.title.trim().slice(0, 120) : 'Untitled sheet',
    description: typeof src.description === 'string' ? src.description.slice(0, 400) : '',
    context: typeof src.context === 'string' ? src.context.trim().slice(0, 600) : '',
    textLabel: typeof src.textLabel === 'string' && src.textLabel.trim() ? src.textLabel.trim().slice(0, 40) : 'Text',
    suggestions: Array.isArray(src.suggestions) ? src.suggestions.filter((s) => typeof s === 'string' && parseHeader(s).ok).slice(0, 24) : [],
    demo: src.demo !== false,
    reviewBelow, concurrency, rows, columns, errors,
  }
}

/** The level a score answer lands on (nearest whole level). */
export function levelOf(col, answer) {
  return Math.max(0, Math.min(col.levels.length - 1, Math.round(Number(answer?.score ?? 0))))
}

/** Compare an answer with a truth label. Returns true / false, or null when there is no label. */
export function judge(col, answer, truth) {
  if (truth == null || !answer) return null
  if (col.type === 'noul') return (answer.noul >= 0.5) === (truth === true || truth === 'yes' || truth === 1)
  if (col.type === 'choice') return String(answer.choice).toLowerCase() === String(truth).toLowerCase()
  const want = typeof truth === 'number' ? truth : col.levels.findIndex((l) => l.toLowerCase() === String(truth).toLowerCase())
  if (want < 0) return null
  return levelOf(col, answer) === want
}

/** How sure Jev is of the answer it shows: the probability of that answer. */
export function confidenceOf(col, answer) {
  if (!answer) return 0
  if (col.type === 'noul') return Math.max(answer.noul, 1 - answer.noul)
  return Math.max(0, Math.min(1, Number(answer.confidence ?? 0)))
}
