// viewer.mjs — the Jev Sheets viewer server.
//
// A spreadsheet where a column header IS a question. The server owns the sheet: it watches
// sheet.json, keeps the runtime state a person builds in the pane (typed columns, row edits, sort,
// filter, the review line), and fills cells by asking Jev ONE call per row with every Jev column as
// a parallel question. A small pool of calls makes a new column fill in a wave, top to bottom.
// Answers are cached by row text plus column definition, so only missing cells are ever computed.
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, toWire, PRICE_PER_MTOK } from '../toolchain/jev.mjs'
import { serveViewer, writeVerdict, watchConfig, mulberry32, clean } from './kit.mjs'
import { parseHeader, normalizeSheet, columnKey, judge, confidenceOf, levelOf, describeColumn, LIMITS } from './grammar.mjs'
import { sheetMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'sheet.json'
const GHOST_PAUSE_MS = 60000
const FALLBACK_SUGGESTIONS = ['Urgency', 'Sentiment: negative < neutral < positive', 'Asks a question?', 'Complaint?']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const r3 = (x) => Math.round(x * 1000) / 1000

export async function startSheetsViewer({ workspace, port = 0, autostart = true, paceMs = Number(process.env.JEV_SHEETS_PACE_MS ?? 90) } = {}) {
  // Every `let` lives here, above the first call that could touch it.
  let server = null, watcher = null
  let sheet = normalizeSheet({ rows: [] }), configError = null, jevError = null
  let rows = [], rowById = new Map(), columns = []
  let cells = new Map()      // row id -> Map(column id -> cell)
  let cache = new Map()      // column key -> Map(row state -> answer)
  let todo = new Set()       // row ids with at least one missing cell
  let inflight = new Set()   // row objects being judged right now
  let order = [], sort = null, reviewOnly = false, reviewBelow = 0.65, fileReviewBelow = null, fileDemo = null
  let running = autostart, stopped = false, epoch = 0, rev = 0
  let counters = { calls: 0, cacheHits: 0, tokens: 0, costUsd: 0, errors: 0, computed: 0 }
  let burst = { active: false, startedAt: 0, cells: 0, rate: 0, ms: 0 }
  let patches = [], patchTimer = null, verdictTimer = null, retryTimer = null, ghostTimer = null
  let ghost = { enabled: true, phase: 'idle', header: '', typeMs: 0, startedAt: 0, nextAt: 0, removeAt: 0, pausedUntil: 0, cursor: 0, watching: false }
  const rng = mulberry32(20260919)
  const mockMode = !process.env.TYPESAFE_API_KEY
  const colById = (id) => columns.find((c) => c.id === id)
  const mock = sheetMock(colById)

  // ---- questions -----------------------------------------------------------------------------
  const rowState = (row) => ({ text: row.text, ...row.meta })
  function questionFor(col) {
    const ctx = sheet.context ? `${sheet.context} ` : ''
    if (col.type === 'noul') return jev.noul(`${ctx}${col.header}`)
    if (col.type === 'choice') return jev.choice(Object.fromEntries(col.options.map((o) => [o, col.descriptions?.[o] || o])), `${ctx}${col.name}: which option fits this row best?`)
    return jev.score(col.levels, `${ctx}${col.name}: where does this row sit on the scale?`)
  }

  // ---- cells ---------------------------------------------------------------------------------
  const cellOf = (rowId, colId) => cells.get(rowId)?.get(colId)
  const hasMissing = (row) => columns.some((c) => !cellOf(row.id, c.id))
  function compact(col, cell) {
    const a = cell.answer
    const out = { c: r3(cell.conf) }
    if (cell.ok != null) out.ok = cell.ok ? 1 : 0
    if (col.type === 'noul') { out.v = a.noul >= 0.5 ? 1 : 0; out.p = r3(a.noul) }
    else if (col.type === 'choice') out.v = col.options.indexOf(String(a.choice))
    else { out.v = levelOf(col, a); out.s = r3(Number(a.score ?? 0)) }
    return out
  }
  function setCell(row, col, answer, info) {
    let m = cells.get(row.id)
    if (!m) cells.set(row.id, (m = new Map()))
    const cell = { answer, conf: confidenceOf(col, answer), ok: judge(col, answer, row.truth?.[col.id]), at: Date.now(), ...info }
    m.set(col.id, cell)
    return cell
  }
  function cacheFor(col) {
    const k = columnKey(col)
    let m = cache.get(k)
    if (!m) cache.set(k, (m = new Map()))
    return m
  }
  /** Fill what the cache already knows, and list the rows that still need Jev. */
  function refill() {
    const old = cells
    cells = new Map()
    todo = new Set()
    for (const row of rows) {
      const key = JSON.stringify(rowState(row))
      for (const col of columns) {
        const hit = cacheFor(col).get(key)
        if (!hit) continue
        const prev = old.get(row.id)?.get(col.id)
        setCell(row, col, hit.answer, { cached: prev && prev.answer === hit.answer ? prev.cached : true, latencyMs: hit.latencyMs, tokens: hit.tokens })
      }
      if (hasMissing(row)) todo.add(row.id)
    }
  }

  // ---- the numbers ---------------------------------------------------------------------------
  function tally() {
    const colStats = {}, groups = {}
    for (const c of columns) colStats[c.id] = { filled: 0, flagged: 0, labelled: 0, correct: 0, conf: 0 }
    let filled = 0, flagged = 0
    for (const row of rows) {
      const m = cells.get(row.id)
      if (!m) continue
      for (const c of columns) {
        const cell = m.get(c.id)
        if (!cell) continue
        const s = colStats[c.id]
        s.filled++; s.conf += cell.conf; filled++
        if (cell.conf < reviewBelow) { s.flagged++; flagged++ }
        if (cell.ok != null) { s.labelled++; if (cell.ok) s.correct++ }
        if (row.group) {
          const g = (groups[row.group] ??= { cells: 0, conf: 0, labelled: 0, correct: 0 })
          g.cells++; g.conf += cell.conf
          if (cell.ok != null) { g.labelled++; if (cell.ok) g.correct++ }
        }
      }
    }
    for (const s of Object.values(colStats)) { s.avgConf = s.filled ? r3(s.conf / s.filled) : 0; s.acc = s.labelled ? r3(s.correct / s.labelled) : null; delete s.conf }
    for (const g of Object.values(groups)) { g.avgConf = g.cells ? r3(g.conf / g.cells) : 0; g.acc = g.labelled ? r3(g.correct / g.labelled) : null; delete g.conf }
    const total = rows.length * columns.length
    return {
      colStats, groups,
      stats: {
        rows: rows.length, columns: columns.length, cellsTotal: total, cellsFilled: filled, flagged,
        calls: counters.calls, cacheHits: counters.cacheHits, computed: counters.computed, tokens: counters.tokens, costUsd: Math.round(counters.costUsd * 1e8) / 1e8, errors: counters.errors,
        cellsPerSec: r3(burst.rate), waveMs: Math.round(burst.ms), busy: todo.size + inflight.size > 0,
      },
    }
  }

  // ---- order: sort and the "needs review only" filter -----------------------------------------
  function rowNeedsReview(row) {
    const m = cells.get(row.id)
    if (!m) return false
    for (const c of columns) { const cell = m.get(c.id); if (cell && cell.conf < reviewBelow) return true }
    return false
  }
  function sortKey(col, cell) {
    if (!cell) return null
    const a = cell.answer
    if (col.type === 'noul') return a.noul
    if (col.type === 'choice') { const i = col.options.indexOf(String(a.choice)); return -(i < 0 ? col.options.length : i) + cell.conf * 0.5 }
    return levelOf(col, a) + cell.conf * 0.5 // by level, the surest first
  }
  function computeOrder() {
    let list = rows
    if (reviewOnly) list = list.filter((r) => rowNeedsReview(r) || hasMissing(r))
    const col = sort && colById(sort.col)
    if (!col) { if (sort) sort = null; order = list.map((r) => r.id); return }
    const dir = sort.dir === 'asc' ? 1 : -1
    const keyed = list.map((r, i) => ({ id: r.id, k: sortKey(col, cellOf(r.id, col.id)), i }))
    keyed.sort((a, b) => (a.k == null) - (b.k == null) || (a.k == null ? 0 : dir * (a.k - b.k)) || a.i - b.i)
    order = keyed.map((x) => x.id)
  }

  // ---- what the pane gets ---------------------------------------------------------------------
  function ghostView() {
    const now = Date.now()
    return {
      enabled: ghost.enabled, phase: ghost.phase, header: ghost.phase === 'typing' ? ghost.header : '',
      typeMs: ghost.typeMs, elapsedMs: ghost.phase === 'typing' ? now - ghost.startedAt : 0,
      pausedMs: Math.max(0, ghost.pausedUntil - now),
    }
  }
  function lightView() {
    return { rev, running, reviewBelow, reviewOnly, sort, order, error: configError, jevError, ghost: ghostView(), ...tally() }
  }
  function fullState() {
    const cellsOut = {}
    for (const row of rows) {
      const m = cells.get(row.id)
      if (!m) continue
      const o = {}
      for (const c of columns) { const cell = m.get(c.id); if (cell) o[c.id] = compact(c, cell) }
      cellsOut[row.id] = o
    }
    return {
      title: sheet.title, description: sheet.description, textLabel: sheet.textLabel, client: mockMode ? 'mock' : 'typesafe',
      concurrency: sheet.concurrency, limits: LIMITS,
      suggestions: sheet.suggestions.length ? sheet.suggestions : FALLBACK_SUGGESTIONS,
      columns: columns.map((c) => ({ id: c.id, header: c.header, name: c.name, type: c.type, options: c.options, descriptions: c.descriptions, levels: c.levels, bare: !!c.bare, source: c.source, kind: describeColumn(c) })),
      rows: rows.map((r, i) => ({ id: r.id, n: i + 1, text: r.text, meta: r.meta, group: r.group, edited: !!r.edited, labelled: !!r.truth })),
      cells: cellsOut,
      ...lightView(),
    }
  }
  const pushState = () => server?.broadcast(fullState(), 'state')
  const pushView = () => server?.broadcast(lightView(), 'view')
  const pushGhost = () => server?.broadcast(ghostView(), 'ghost')
  function flushPatches() {
    clearTimeout(patchTimer); patchTimer = null
    if (!patches.length) return
    const out = patches; patches = []
    const t = tally()
    server?.broadcast({ rev, patches: out, colStats: t.colStats, groups: t.groups, stats: t.stats }, 'cells')
  }
  const queuePatch = (row, col, cell) => { patches.push([row.id, col.id, compact(col, cell)]); if (!patchTimer) patchTimer = setTimeout(flushPatches, 40) }

  // ---- the verdict ---------------------------------------------------------------------------
  function verdict() {
    const { colStats, groups, stats } = tally()
    const pct = (x) => `${Math.round(x * 100)}%`
    const accLine = columns.filter((c) => colStats[c.id].acc != null).map((c) => `${c.name} ${pct(colStats[c.id].acc)}`).join(', ')
    const findings = []
    if (configError) findings.push({ severity: 'error', kind: 'sheet', ref: MARKER, message: configError })
    if (jevError) findings.push({ severity: 'warning', kind: 'jev', message: jevError })
    const report = []
    for (const c of columns) {
      const s = colStats[c.id]
      // The rows worth a second look: wrong ones first, then the least sure.
      const weak = rows.map((r) => ({ r, cell: cellOf(r.id, c.id) })).filter((x) => x.cell && (x.cell.ok === false || x.cell.conf < reviewBelow))
        .sort((a, b) => (a.cell.ok === false ? 0 : 1) - (b.cell.ok === false ? 0 : 1) || a.cell.conf - b.cell.conf).slice(0, 5)
        .map(({ r, cell }) => ({ row: r.id, text: r.text.slice(0, 90), answered: shown(c, cell.answer), confidence: r3(cell.conf), truth: r.truth?.[c.id] ?? null }))
      report.push({ id: c.id, header: c.header, type: c.type, source: c.source, filled: s.filled, accuracy: s.acc, labelled: s.labelled, underReviewLine: s.flagged, avgConfidence: s.avgConf, weakest: weak })
      const share = s.filled ? s.flagged / s.filled : 0
      findings.push({
        severity: (s.acc != null && s.acc < 0.8) || share > 0.35 ? 'warning' : 'info', kind: 'column', ref: c.id,
        message: `${c.name} (${c.type}): ${s.acc == null ? 'no truth labels' : `${s.correct}/${s.labelled} right, ${pct(s.acc)}`}, ${s.flagged} of ${s.filled} cells under ${reviewBelow}, average confidence ${s.avgConf}.`,
      })
    }
    const g = Object.entries(groups).map(([k, v]) => `${k} ${v.avgConf}`).join(', ')
    if (g) findings.push({ severity: 'info', kind: 'confidence', message: `Average confidence by row group: ${g}.` })
    const full = stats.cellsTotal > 0 && stats.cellsFilled === stats.cellsTotal
    return {
      ready: !configError && full,
      summary: clean(configError ? `sheet.json needs a fix: ${configError}` : `${sheet.title}: ${stats.rows} rows x ${stats.columns} Jev columns, ${stats.cellsFilled}/${stats.cellsTotal} cells, ${stats.flagged} under ${reviewBelow}${accLine ? `. Right: ${accLine}` : ''}`).slice(0, 200),
      findings, artifact: MARKER,
      phases: [
        { id: 'load', name: 'Sheet loaded', state: configError ? 'failed' : 'done' },
        { id: 'fill', name: 'Cells filled', state: full ? 'done' : stats.cellsTotal ? 'active' : 'pending' },
        { id: 'review', name: 'Review', state: !full ? 'pending' : stats.flagged ? 'active' : 'done' },
      ],
      sheet: { client: mockMode ? 'mock' : 'typesafe', reviewBelow, rows: stats.rows, cellsFilled: stats.cellsFilled, cellsTotal: stats.cellsTotal, flagged: stats.flagged, costUsd: stats.costUsd, groups, columns: report },
    }
  }
  function shown(col, a) {
    if (col.type === 'noul') return a.noul >= 0.5 ? 'yes' : 'no'
    if (col.type === 'choice') return String(a.choice)
    return col.levels[levelOf(col, a)]
  }
  function saveVerdict() { clearTimeout(verdictTimer); verdictTimer = null; if (stopped) return; try { writeVerdict(workspace, verdict()) } catch { /* workspace gone */ } }
  const verdictSoon = () => { if (!verdictTimer) verdictTimer = setTimeout(saveVerdict, 250) }

  // ---- asking Jev: one call per row, every missing column as a parallel question ---------------
  function nextRow() {
    if (!todo.size) return null
    const now = Date.now()
    const busy = new Set([...inflight].map((r) => r.id))
    const pick = (id) => { const row = rowById.get(id); return row && todo.has(id) && !busy.has(id) && !(row.retryAt > now) ? row : null }
    for (const id of order) { const row = pick(id); if (row) return row }
    for (const id of todo) { const row = pick(id); if (row) return row }
    return null
  }
  async function judgeRow(row, fast) {
    const myEpoch = epoch
    const state = rowState(row)
    const key = JSON.stringify(state)
    const need = []
    for (const col of columns) {
      if (cellOf(row.id, col.id)) continue
      const hit = cacheFor(col).get(key)
      if (hit) { counters.cacheHits++; queuePatch(row, col, setCell(row, col, hit.answer, { cached: true, latencyMs: hit.latencyMs, tokens: hit.tokens })) } else need.push(col)
    }
    if (!need.length) { todo.delete(row.id); return }
    inflight.add(row)
    try {
      // Offline, a call returns in under a millisecond. Pace it like the live model (about 100 ms)
      // so the wave is visible. `tick` and `drain` skip the pacing.
      if (!fast && mockMode && paceMs > 0) await sleep(paceMs * (0.7 + 0.6 * rng()))
      const questions = Object.fromEntries(need.map((c) => [c.id, questionFor(c)]))
      const res = await evaluate({ state, questions, salt: 1, mock, model: process.env.JEV_MODEL || 'jev-latest' })
      if (stopped || myEpoch !== epoch || rowById.get(row.id) !== row || JSON.stringify(rowState(row)) !== key) return
      const real = Number(res.usage?.input_tokens)
      const tokens = Number.isFinite(real) && real > 0 ? real : Math.ceil((key.length + JSON.stringify(toWire(questions)).length) / 4)
      counters.calls++; counters.tokens += tokens; counters.costUsd = (counters.tokens * PRICE_PER_MTOK) / 1e6
      jevError = null
      let n = 0
      for (const col of need) {
        const answer = res.answers[col.id]
        if (!columns.includes(col) || !answer || answer.ok === false) continue
        cacheFor(col).set(key, { answer, latencyMs: res.latencyMs, tokens })
        queuePatch(row, col, setCell(row, col, answer, { cached: false, latencyMs: res.latencyMs, tokens }))
        n++
      }
      counters.computed += n
      const now = Date.now()
      if (!burst.active) burst = { active: true, startedAt: now - Math.max(1, res.latencyMs), cells: 0, rate: 0, ms: 0 }
      burst.cells += n; burst.ms = now - burst.startedAt; burst.rate = burst.cells / Math.max(0.03, burst.ms / 1000)
      if (!hasMissing(row)) todo.delete(row.id)
    } catch (e) {
      counters.errors++
      jevError = clean(e?.message ?? e)
      row.retryAt = Date.now() + 5000 // leave the cell waiting, show the error, try again in a while (see pump)
      pushView()
    } finally {
      inflight.delete(row)
    }
  }
  function settle() {
    if (todo.size || inflight.size) return
    const wasBusy = burst.active
    burst.active = false
    if (sort || reviewOnly) computeOrder()
    flushPatches()
    if (wasBusy || sort || reviewOnly) pushView()
    verdictSoon()
  }
  function pump() {
    if (stopped || !running) return
    while (inflight.size < sheet.concurrency) {
      const row = nextRow()
      if (!row) break
      judgeRow(row, false).then(() => { pump(); settle() })
    }
    // Rows that failed are parked for a few seconds. Wake up when the first of them is due.
    if (todo.size && !retryTimer) {
      const now = Date.now()
      let due = Infinity
      for (const id of todo) { const at = rowById.get(id)?.retryAt ?? 0; if (at > now) due = Math.min(due, at) }
      if (due < Infinity) retryTimer = setTimeout(() => { retryTimer = null; pump() }, Math.max(50, due - now + 20))
    }
    settle()
  }
  async function drain() {
    const worker = async () => { for (let row = nextRow(); row && !stopped; row = nextRow()) await judgeRow(row, true) }
    await Promise.all(Array.from({ length: sheet.concurrency }, worker))
    for (let i = 0; inflight.size && i < 400; i++) await sleep(5)
    settle()
  }

  // ---- changes -------------------------------------------------------------------------------
  function changed() { rev++; computeOrder(); pushState(); verdictSoon(); pump() }
  function addColumn(header, source = 'pane') {
    const parsed = parseHeader(header)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (columns.length >= LIMITS.maxColumns) return { ok: false, error: `a sheet holds at most ${LIMITS.maxColumns} Jev columns. Remove one first` }
    if (colById(parsed.column.id)) return { ok: false, error: `there is already a column called "${parsed.column.name}"` }
    columns.push({ ...parsed.column, source, addedAt: Date.now() })
    refill(); changed()
    return { id: parsed.column.id, type: parsed.column.type }
  }
  function removeColumn(id) {
    const col = colById(id)
    if (!col) return { ok: false, error: 'no such column' }
    columns = columns.filter((c) => c !== col)
    cache.delete(columnKey(col)) // its answers go with it; typing it again asks Jev again
    if (sort?.col === id) sort = null
    refill(); changed()
    return { removed: id }
  }
  function editRow(id, text) {
    const row = rowById.get(id)
    const next = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000)
    if (!row) return { ok: false, error: 'no such row' }
    if (!next) return { ok: false, error: 'a row needs some text' }
    if (next === row.text) return { unchanged: true }
    row.text = next; row.edited = true; row.truth = null; row.retryAt = 0 // the old truth label was for the old text
    refill(); changed()
    return { edited: id }
  }
  function applySheet(raw, fresh) {
    const next = normalizeSheet(raw)
    const problems = next.errors.slice(0, 3).join('; ')
    if (!next.rows.length && rows.length && !fresh) { configError = `${MARKER}: ${problems || 'needs at least one row with text'}. Showing the last good sheet`; pushView(); verdictSoon(); return }
    configError = problems ? `${MARKER}: ${problems}` : null
    sheet = next
    epoch++
    rows = next.rows.map((r) => ({ ...r, edited: false, retryAt: 0 }))
    rowById = new Map(rows.map((r) => [r.id, r]))
    inflight = new Set()
    const fileIds = new Set(next.columns.map((c) => c.id))
    const kept = fresh ? [] : columns.filter((c) => c.source !== 'file' && !fileIds.has(c.id))
    columns = [...next.columns.map((c) => ({ ...c, source: 'file', addedAt: 0 })), ...kept].slice(0, LIMITS.maxColumns)
    if (fresh || next.reviewBelow !== fileReviewBelow) reviewBelow = next.reviewBelow
    if (fresh || next.demo !== fileDemo) ghost.enabled = next.demo
    fileReviewBelow = next.reviewBelow; fileDemo = next.demo
    refill(); changed()
  }
  function reset() {
    cache = new Map(); sort = null; reviewOnly = false; jevError = null
    counters = { calls: 0, cacheHits: 0, tokens: 0, costUsd: 0, errors: 0, computed: 0 }
    burst = { active: false, startedAt: 0, cells: 0, rate: 0, ms: 0 }
    patches = []
    ghost = { ...ghost, phase: 'idle', header: '', pausedUntil: 0, nextAt: Date.now() + 5000, cursor: 0 }
    applySheet(watcher.get(), true)
    if (watcher.error()) { configError = `${watcher.error()}. Showing the last good sheet`; pushView() } // still broken on disk
  }

  // ---- the ghost typist: the demo loop that keeps the pane alive while nobody is playing -------
  function touch() {
    ghost.pausedUntil = Date.now() + GHOST_PAUSE_MS
    if (ghost.phase === 'typing') { ghost.phase = 'idle'; ghost.header = '' }
    ghost.nextAt = ghost.pausedUntil
    pushGhost()
  }
  const demoColumns = () => columns.filter((c) => c.source === 'demo').sort((a, b) => a.addedAt - b.addedAt)
  function nextSuggestion() {
    const list = sheet.suggestions.length ? sheet.suggestions : FALLBACK_SUGGESTIONS
    for (let i = 0; i < list.length; i++) {
      const h = list[(ghost.cursor + i) % list.length]
      const p = parseHeader(h)
      if (p.ok && !colById(p.column.id)) { ghost.cursor = (ghost.cursor + i + 1) % list.length; return h }
    }
    return null
  }
  function trimDemo(keep) { const d = demoColumns(); while (d.length > keep) removeColumn(d.shift().id) }
  function ghostTick() {
    if (stopped) return
    const now = Date.now()
    const watching = (server?.clients.size ?? 0) > 0
    if (watching && !ghost.watching) ghost.nextAt = Math.max(ghost.pausedUntil, now + 1400) // someone just opened the pane
    ghost.watching = watching
    if (!ghost.enabled || !running || !watching) { if (ghost.phase === 'typing') { ghost.phase = 'idle'; pushGhost() } return }
    if (now < ghost.pausedUntil || todo.size || inflight.size) return
    if (ghost.phase === 'idle' && now >= ghost.nextAt) {
      if (columns.length >= LIMITS.maxColumns) trimDemo(0)
      const h = columns.length < LIMITS.maxColumns ? nextSuggestion() : null
      if (!h) { trimDemo(0); ghost.nextAt = now + 6000; return }
      ghost = { ...ghost, phase: 'typing', header: h, startedAt: now, typeMs: Math.min(3600, Math.max(900, h.length * 58)) }
      pushGhost()
    } else if (ghost.phase === 'typing' && now >= ghost.startedAt + ghost.typeMs + 420) {
      const h = ghost.header
      ghost = { ...ghost, phase: 'dwell', header: '', removeAt: now + 7000 }
      addColumn(h, 'demo')
    } else if (ghost.phase === 'dwell' && now >= ghost.removeAt) {
      trimDemo(1)
      ghost = { ...ghost, phase: 'idle', nextAt: now + 8500 }
      pushGhost()
    }
  }
  /** One whole demo cycle at once, with no typing and no waiting. Tests use it. */
  async function ghostCycle() {
    const h = nextSuggestion()
    if (!h) return { ok: false, error: 'no suggestion left to type' }
    const added = addColumn(h, 'demo')
    await drain()
    const before = demoColumns().map((c) => c.id)
    trimDemo(1)
    const after = new Set(demoColumns().map((c) => c.id))
    return { typed: h, added: added.id, removed: before.filter((id) => !after.has(id)) }
  }

  // ---- inspector -----------------------------------------------------------------------------
  function inspect(rowId, colId) {
    const row = rowById.get(rowId), col = colById(colId)
    if (!row || !col) return { ok: false, error: 'no such cell' }
    const cell = cellOf(rowId, colId)
    const wire = toWire({ [col.id]: questionFor(col) })[col.id]
    return {
      row: { id: row.id, n: rows.indexOf(row) + 1, text: row.text, meta: row.meta, group: row.group, edited: !!row.edited },
      column: { id: col.id, header: col.header, name: col.name, type: col.type, options: col.options, descriptions: col.descriptions, levels: col.levels, source: col.source },
      question: wire, context: sheet.context,
      cell: cell ? { answer: cell.answer, shown: shown(col, cell.answer), conf: r3(cell.conf), ok: cell.ok, truth: row.truth?.[col.id] ?? null, cached: !!cell.cached, latencyMs: cell.latencyMs, tokens: cell.tokens, flagged: cell.conf < reviewBelow } : null,
      reviewBelow,
    }
  }

  // ---- control -------------------------------------------------------------------------------
  async function control(cmd, body) {
    switch (cmd) {
      case 'pause': running = false; pushView(); return { running }
      case 'start': running = true; pushView(); pump(); return { running }
      case 'reset': reset(); return { rev }
      case 'tick': {
        // One tick judges exactly one row, with no pacing. { n } runs several ticks in a row.
        const n = Math.max(1, Math.min(5000, Math.floor(Number(body.n) || 1)))
        let last = null
        for (let i = 0; i < n; i++) { const row = nextRow(); if (!row) break; await judgeRow(row, true); last = row.id }
        flushPatches(); settle()
        return last == null ? { idle: true } : { row: last }
      }
      case 'drain': await drain(); return { filled: tally().stats.cellsFilled }
      case 'touch': touch(); return null
      case 'addColumn': { touch(); return addColumn(body.header, 'pane') }
      case 'removeColumn': { touch(); return removeColumn(String(body.id ?? '')) }
      case 'editRow': { touch(); return editRow(String(body.id ?? ''), body.text) }
      case 'sort': {
        touch()
        const id = String(body.col ?? '')
        if (!colById(id)) sort = null
        else if (body.dir === 'asc' || body.dir === 'desc') sort = { col: id, dir: body.dir }
        else sort = sort?.col !== id ? { col: id, dir: 'desc' } : sort.dir === 'desc' ? { col: id, dir: 'asc' } : null
        computeOrder(); pushView(); return { sort }
      }
      case 'reviewOnly': touch(); reviewOnly = !!body.on; computeOrder(); pushView(); return { reviewOnly }
      case 'setReview': {
        touch()
        const v = Number(body.value)
        if (!Number.isFinite(v) || v < 0 || v > 1) return { ok: false, error: 'reviewBelow must be between 0 and 1' }
        reviewBelow = r3(v)
        if (reviewOnly) computeOrder()
        pushView(); verdictSoon(); return { reviewBelow }
      }
      case 'demo': ghost.enabled = !!body.on; ghost.pausedUntil = 0; ghost.nextAt = Date.now() + 1200; if (!ghost.enabled && ghost.phase === 'typing') ghost.phase = 'idle'; pushGhost(); return { demo: ghost.enabled }
      case 'ghost': return ghostCycle()
      case 'inspect': return inspect(String(body.row ?? ''), String(body.col ?? ''))
      default: return { ok: false, error: `unknown command "${cmd}"` }
    }
  }

  // ---- go ------------------------------------------------------------------------------------
  watcher = watchConfig(join(workspace, MARKER), {}, (cfg, err) => {
    if (stopped) return
    if (err) { configError = `${err}. Showing the last good sheet`; pushView(); verdictSoon(); return }
    applySheet(cfg, false)
  })
  server = await serveViewer({ here: HERE, port, files: ['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js', 'grammar.mjs'], state: fullState, control })
  applySheet(watcher.get(), true)
  if (watcher.error()) configError = watcher.error()
  saveVerdict()
  ghostTimer = setInterval(ghostTick, 200)

  return {
    url: server.url,
    async close() {
      stopped = true
      clearInterval(ghostTimer); clearTimeout(patchTimer); clearTimeout(verdictTimer); clearTimeout(retryTimer)
      watcher.close()
      await server.close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startSheetsViewer({ workspace, port })
  console.log(`Jev Sheets listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
