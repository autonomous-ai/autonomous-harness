// studio.js — the Jev Sheets pane. A DOM spreadsheet (virtual rows, sticky header and first column)
// fed by the viewer server over SSE: `state` (the whole sheet), `cells` (answers as they land),
// `view` (sort, filter, review line, numbers) and `ghost` (the demo typist).
import { parseHeader, describeColumn } from '/grammar.mjs'

const $ = (id) => document.getElementById(id)
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const ROW_H = 46, HEAD_H = 52, NUM_W = 44, OVERSCAN = 4, SEP = '\u0001'
const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#5eead4', '#f87171', '#a3e635', '#e879f9', '#38bdf8', '#fda4af', '#fcd34d']
const HINT = '<b>Type a header</b> and press Enter: Jev fills every row. <b>Click a header</b> to sort. <b>Click a cell</b> to inspect. <b>Double-click a message</b> to edit it.'

const grid = $('grid'), ghead = $('ghead'), gbody = $('gbody'), input = $('addInput'), addBox = $('addBox'), hint = $('hint')
const root = document.documentElement

// Every piece of state is declared here, before anything can run.
let S = null
let rowIndex = new Map(), colIndex = new Map(), posOf = new Map(), order = []
let recs = new Map()           // row id -> { id, el, num, text, msg, cells: Map(col id -> {el, sig}), y, dying }
let headCells = new Map(), headNum = null, headText = null, headAdd = null
let held = new Map()           // "row SEP col" -> time when the answer may flip in
let colBorn = new Map()        // col id -> time first seen (new columns unfold)
let lastRevealAt = 0
let selected = null, inspSeq = 0, inspTimer = null
let editing = null
let ghostInfo = { enabled: true, phase: 'idle', pausedMs: 0 }, ghostInfoAt = 0, ghostRun = null, ghostOwnsInput = false
let lastTouch = -1e9, lastTour = 0, hintErrorUntil = 0, reviewPostTimer = null, draggingReview = false
let dirty = { rows: false, head: false, top: false, hist: false }
const tw = { rows: { v: 0, t: 0 }, cols: { v: 0, t: 0 }, cells: { v: 0, t: 0 }, rate: { v: 0, t: 0 }, cost: { v: 0, t: 0 }, flag: { v: 0, t: 0 } }

async function post(cmd, body = {}) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
    return await r.json()
  } catch { return { ok: false, error: 'the viewer is restarting' } }
}

// ---- colours ----------------------------------------------------------------------------------
// One stable colour per option: its place in the column's option list picks it.
const optTone = (col, i) => PALETTE[Math.max(0, i) % PALETTE.length]
const lvlTone = (f) => `hsl(${Math.round(50 - 34 * f)} 94% ${Math.round(66 - 8 * f)}%)`
function toneOf(col, cell) {
  if (col.type === 'choice') return optTone(col, cell.v)
  if (col.type === 'noul') return cell.v ? '#34d399' : '#9aa2ba'
  return lvlTone(col.levels.length > 1 ? cell.v / (col.levels.length - 1) : 0)
}
const pctText = (c) => `${Math.round(c * 100)}%`

// ---- layout -----------------------------------------------------------------------------------
function layout() {
  if (!S) return
  const n = S.columns.length, avail = grid.clientWidth
  const colw = avail < 800 ? 126 : 142
  const textw = Math.round(clamp(avail - NUM_W - n * colw - 12, avail < 800 ? 250 : 300, 640))
  root.style.setProperty('--colw', `${colw}px`)
  root.style.setProperty('--textw', `${textw}px`)
  const total = NUM_W + textw + n * colw
  gbody.style.width = ghead.style.width = `${total}px`
}

// ---- header -----------------------------------------------------------------------------------
function placeAfter(prev, el) {
  let next = prev.nextSibling
  while (next && next.classList?.contains('leave')) next = next.nextSibling
  if (next !== el) prev.after(el)
}
function leave(el) { el.classList.remove('enter'); el.classList.add('leave'); setTimeout(() => el.remove(), 250) }
const newborn = (id) => performance.now() - (colBorn.get(id) ?? -1e9) < 600

function renderHead() {
  if (!headNum) {
    headNum = h('div', 'hc num', '#')
    headText = h('div', 'hc text')
    headText.append(h('div', 'h-name'), h('div', 'h-sub'))
    ghead.append(headNum, headText)
  }
  headText.children[0].textContent = S.textLabel
  const shownRows = order.length === S.rows.length ? `${S.rows.length} rows` : `${order.length} of ${S.rows.length} rows`
  headText.children[1].textContent = `${shownRows} · made-up data · double-click to edit`
  for (const [id, el] of headCells) if (!colIndex.has(id)) { leave(el); headCells.delete(id) }
  let prev = headText
  for (const col of S.columns) {
    let el = headCells.get(col.id)
    if (!el) {
      el = h('div', 'hc jev'); el.dataset.col = col.id
      const top = h('div', 'h-top'); top.append(h('span', 'h-name'), h('span', 'h-sort'), h('button', 'h-x', '×'))
      top.lastChild.title = 'Remove this column'
      el.append(top, h('div', 'h-sub'), h('div', 'h-fill'))
      if (newborn(col.id)) el.classList.add('enter')
      headCells.set(col.id, el)
    }
    placeAfter(prev, el); prev = el
    const st = S.colStats[col.id] ?? { filled: 0, flagged: 0 }
    el.title = `${col.header}\n\nClick to sort. ${col.kind}.`
    el.classList.toggle('demo', col.source === 'demo')
    el.classList.toggle('sorted', S.sort?.col === col.id)
    el.querySelector('.h-name').textContent = col.type === 'noul' ? `${col.name}?` : col.name
    el.querySelector('.h-sort').textContent = S.sort?.col === col.id ? (S.sort.dir === 'desc' ? '▼' : '▲') : ''
    const sub = el.querySelector('.h-sub')
    sub.textContent = ''
    sub.append(h('span', 'tag', col.type))
    if (col.source === 'demo') sub.append(h('span', 'tag demo', 'demo'))
    if (st.acc != null) { const a = h('span', `h-acc ${st.acc >= 0.85 ? '' : st.acc >= 0.7 ? 'mid' : 'low'}`, `✓ ${Math.round(st.acc * 100)}%`); a.title = `${st.correct} of ${st.labelled} rows match the made-up truth labels`; sub.append(a) }
    if (st.flagged) { const f = h('span', 'h-flag', `?${st.flagged}`); f.title = `${st.flagged} cells under the review line`; sub.append(f) }
    const fill = el.querySelector('.h-fill')
    const frac = S.rows.length ? st.filled / S.rows.length : 1
    fill.style.width = `${frac * 100}%`
    fill.classList.toggle('done', frac >= 1)
  }
  if (!headAdd) {
    headAdd = h('div', 'hc add')
    headAdd.append(h('span', '', '+'), document.createTextNode('ask another question'))
    headAdd.title = 'Type a header in the box above and press Enter'
    headAdd.addEventListener('click', () => { dropGhostText(); input.focus() })
  }
  const used = NUM_W + parseFloat(root.style.getPropertyValue('--textw') || '0') + S.columns.length * parseFloat(root.style.getPropertyValue('--colw') || '0')
  headAdd.classList.toggle('hidden', S.columns.length >= S.limits.maxColumns || used + 150 > grid.clientWidth) // only where there is spare room
  if (ghead.lastChild !== headAdd) ghead.append(headAdd)
}

// ---- rows (virtual) ---------------------------------------------------------------------------
function visibleRange() {
  const top = grid.scrollTop, viewH = Math.max(0, grid.clientHeight - HEAD_H)
  return [Math.max(0, Math.floor(top / ROW_H) - OVERSCAN), Math.min(order.length - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN)]
}
function createRow(id, y) {
  const el = h('div', 'row'); el.dataset.row = id
  const num = h('div', 'cell c-num'), text = h('div', 'cell c-text'), msg = h('div', 'msg')
  text.append(msg); el.append(num, text)
  el.style.transform = `translateY(${y}px)`
  gbody.append(el)
  const rec = { id, el, num, text, msg, cells: new Map(), y, textSig: null, dying: false }
  recs.set(id, rec)
  return rec
}
function placeRow(rec, y) { if (rec.y !== y) { rec.y = y; rec.el.style.transform = `translateY(${y}px)` } }
function fillRow(rec, i) {
  const r = rowIndex.get(rec.id)
  if (!r) return
  rec.el.classList.toggle('odd', i % 2 === 1)
  rec.num.textContent = r.n
  const sig = `${r.text}|${r.edited}|${r.group}`
  if (sig !== rec.textSig && editing?.id !== rec.id) {
    rec.textSig = sig
    rec.msg.textContent = ''
    const who = r.meta?.from ?? Object.values(r.meta ?? {})[0]
    if (who != null) rec.msg.append(h('span', 'who', String(who).split(',')[0]))
    if (r.group === 'mixed') { const t = h('span', 'tag mixed', 'mixed'); t.title = 'This row was written with mixed signals on purpose'; rec.msg.append(t) }
    if (r.edited) { const t = h('span', 'tag edited', 'edited'); t.title = 'Edited in the pane. Its truth label no longer applies.'; rec.msg.append(t) }
    rec.msg.append(document.createTextNode(r.text))
    rec.text.title = [r.text, '', ...Object.entries(r.meta ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n')
  }
  for (const [cid, c] of rec.cells) if (!colIndex.has(cid)) { leave(c.el); rec.cells.delete(cid) }
  let prev = rec.text
  for (const col of S.columns) {
    let c = rec.cells.get(col.id)
    if (!c) {
      c = { el: h('div', 'cell c-jev'), sig: null }
      c.el.dataset.col = col.id
      if (newborn(col.id)) c.el.classList.add('enter')
      rec.cells.set(col.id, c)
    }
    placeAfter(prev, c.el); prev = c.el
    paintCell(rec, col, c, false)
  }
}
function paintCell(rec, col, c, land) {
  const cell = held.has(rec.id + SEP + col.id) ? null : S.cells[rec.id]?.[col.id]
  const sig = cell ? `${col.type}${JSON.stringify(cell)}` : 'wait'
  const el = c.el
  if (sig !== c.sig) {
    c.sig = sig
    el.textContent = ''
    const ci = h('div', 'ci')
    if (!cell) ci.append(h('div', 'sk a'), h('div', 'sk b'))
    else {
      const tone = toneOf(col, cell)
      el.style.setProperty('--tone', tone)
      el.style.setProperty('--conf', String(cell.c))
      const cv = h('div', 'cv')
      if (col.type === 'choice') cv.append(h('span', 'opt', col.options[cell.v] ?? '?'))
      else if (col.type === 'noul') cv.append(h('span', `chip ${cell.v ? 'yes' : 'no'}`, cell.v ? 'yes' : 'no'))
      else cv.append(h('span', 'lvl', col.levels[cell.v] ?? '?'))
      cv.append(h('span', 'cn', pctText(cell.c)))
      ci.append(cv)
      if (col.type === 'score') {
        const m = h('div', 'meter'), n = col.levels.length
        for (let i = 0; i < n; i++) { const seg = h('i', i <= cell.v ? 'on' : ''); seg.style.setProperty('--seg', lvlTone(n > 1 ? i / (n - 1) : 0)); m.append(seg) }
        ci.append(m)
      } else {
        const bar = h('div', 'cbar'), fill = h('i'); fill.style.width = `${cell.c * 100}%`; bar.append(fill); ci.append(bar)
      }
    }
    el.append(ci)
  }
  el.classList.toggle('wait', !cell)
  el.classList.toggle('flag', !!cell && cell.c < S.reviewBelow)
  el.classList.toggle('wrong', !!cell && cell.ok === 0)
  const sel = selected && selected.row === rec.id && selected.col === col.id
  el.classList.toggle('sel', !!sel)
  el.classList.toggle('bydemo', !!sel && selected.by === 'demo')
  if (land && cell) { el.classList.remove('land'); void el.offsetWidth; el.classList.add('land') }
}
function renderRows() {
  if (!S) return
  const [a, b] = visibleRange()
  const want = new Set()
  for (let i = a; i <= b; i++) want.add(order[i])
  for (const [id, rec] of recs) {
    if (want.has(id)) { if (rec.dying) { rec.dying = false; rec.el.classList.remove('gone') } continue }
    if (rec.dying || editing?.id === id) continue
    rec.el.remove(); recs.delete(id)
  }
  for (let i = a; i <= b; i++) {
    const id = order[i]
    const rec = recs.get(id) ?? createRow(id, i * ROW_H)
    placeRow(rec, i * ROW_H)
    fillRow(rec, i)
  }
  const none = order.length === 0
  $('empty').classList.toggle('hidden', !none)
  if (none) $('empty').innerHTML = S.rows.length ? '<b>Nothing under the review line</b>Drag the line to the right to see what Jev is least sure about.' : '<b>No rows yet</b>Ask the agent to build a sheet in sheet.json.'
}
/** Re-order rows. Rows slide to their new places; rows entering or leaving slide across the edge. */
function setOrder(next, animate) {
  const old = posOf
  order = next
  posOf = new Map(next.map((id, i) => [id, i]))
  gbody.style.height = `${next.length * ROW_H}px`
  if (!animate || !recs.size) return
  const top = grid.scrollTop, lo = top - 2 * ROW_H, hi = top + grid.clientHeight + ROW_H
  const [a, b] = visibleRange()
  for (let i = a; i <= b; i++) {
    const id = next[i], oi = old.get(id)
    if (recs.has(id) || oi == null) continue
    const rec = createRow(id, clamp(oi * ROW_H, lo, hi)); fillRow(rec, i)
  }
  void gbody.offsetHeight // commit the start positions so the move animates
  for (const [id, rec] of recs) {
    const ni = posOf.get(id)
    if (ni != null && ni >= a && ni <= b) {
      if (rec.y !== ni * ROW_H) { rec.el.classList.add('moving'); setTimeout(() => rec.el.classList.remove('moving'), 600) }
      continue
    }
    if (editing?.id === id) continue
    rec.dying = true
    if (ni == null) rec.el.classList.add('gone'); else placeRow(rec, clamp(ni * ROW_H, lo, hi))
    setTimeout(() => { if (rec.dying) { rec.el.remove(); if (recs.get(id) === rec) recs.delete(id) } }, ni == null ? 320 : 580)
  }
}

// ---- server frames ----------------------------------------------------------------------------
function applyState(s) {
  const first = !S
  const hadCols = new Set(S ? S.columns.map((c) => c.id) : [])
  S = s
  rowIndex = new Map(s.rows.map((r) => [r.id, r]))
  colIndex = new Map(s.columns.map((c) => [c.id, c]))
  const now = performance.now()
  let grew = false
  for (const c of s.columns) if (!colBorn.has(c.id)) { colBorn.set(c.id, first ? -1e9 : now); if (!first && !hadCols.has(c.id)) grew = true }
  for (const id of [...colBorn.keys()]) if (!colIndex.has(id)) colBorn.delete(id)
  for (const key of [...held.keys()]) { const [rid, cid] = key.split(SEP); if (!s.cells[rid]?.[cid]) held.delete(key) }
  $('sheetTitle').textContent = s.title
  $('sheetTitle').title = s.description
  $('synthPill').title = s.description || 'Every row in this sheet is made up.'
  document.title = `Jev Sheets · ${s.title}`
  layout()
  const sameOrder = order.length === s.order.length && order.every((id, i) => id === s.order[i])
  setOrder(s.order, !first && !sameOrder)
  if (first) {
    // The sheet is usually full by the time the pane opens. Let it arrive as a wave anyway.
    const [a, b] = visibleRange()
    for (let i = a; i <= b; i++) s.columns.forEach((c, j) => { if (s.cells[s.order[i]]?.[c.id]) held.set(s.order[i] + SEP + c.id, now + 260 + (i - a) * 30 + j * 55) })
  }
  renderHead(); renderRows(); renderChips(); applyShared(s)
  if (grew) grid.scrollTo({ left: grid.scrollWidth, behavior: 'smooth' })
  if (selected) { if (rowIndex.has(selected.row) && colIndex.has(selected.col)) inspectSoon(); else select(null) }
}
function applyShared(v) {
  $('cfgError').classList.toggle('hidden', !(v.error || v.jevError))
  $('cfgError').textContent = v.error || (v.jevError ? `Jev: ${v.jevError}` : '')
  $('reviewOnlyBtn').classList.toggle('on', !!S.reviewOnly)
  if (!draggingReview) { $('reviewRange').value = S.reviewBelow; $('reviewVal').textContent = S.reviewBelow.toFixed(2) }
  if (v.ghost) applyGhost(v.ghost)
  dirty.top = dirty.hist = true
}
function applyView(v) {
  if (!S) return
  const orderChanged = v.order.length !== order.length || v.order.some((id, i) => id !== order[i])
  const lineMoved = v.reviewBelow !== S.reviewBelow
  Object.assign(S, { reviewBelow: draggingReview ? S.reviewBelow : v.reviewBelow, reviewOnly: v.reviewOnly, sort: v.sort, order: v.order, colStats: v.colStats, groups: v.groups, stats: v.stats, running: v.running, error: v.error, jevError: v.jevError })
  if (orderChanged) setOrder(v.order, true)
  renderHead(); renderRows(); applyShared(v)
  if (lineMoved && selected) inspectSoon()
}
function applyCells(m) {
  if (!S || m.rev !== S.rev) return
  const now = performance.now()
  const touched = new Map()
  for (const [rid, cid, cell] of m.patches) {
    (S.cells[rid] ??= {})[cid] = cell
    const rec = recs.get(rid)
    if (rec && !rec.dying) (touched.get(rid) ?? touched.set(rid, []).get(rid)).push(cid)
    if (selected && selected.row === rid && selected.col === cid) inspectSoon()
  }
  // Answers land faster than the eye can follow. Let the visible ones flip in top to bottom.
  const step = lastRevealAt - now > 700 ? 7 : 24
  for (const rid of [...touched.keys()].sort((x, y) => (posOf.get(x) ?? 0) - (posOf.get(y) ?? 0))) {
    lastRevealAt = Math.max(now, lastRevealAt + step)
    touched.get(rid).forEach((cid, k) => held.set(rid + SEP + cid, lastRevealAt + k * 40))
  }
  S.colStats = m.colStats; S.groups = m.groups; S.stats = m.stats
  dirty.head = dirty.top = dirty.hist = true
}

// ---- top bar ----------------------------------------------------------------------------------
const fmtCost = (v) => (v <= 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`)
function localFlags() {
  let n = 0, rowsN = 0
  for (const rid in S.cells) { let any = false; for (const cid in S.cells[rid]) if (colIndex.has(cid) && S.cells[rid][cid].c < S.reviewBelow) { n++; any = true } if (any) rowsN++ }
  return [n, rowsN]
}
function renderTop() {
  const st = S.stats
  const [flagged, flaggedRows] = localFlags()
  tw.rows.t = st.rows; tw.cols.t = st.columns; tw.cells.t = st.cellsFilled; tw.rate.t = st.cellsPerSec; tw.cost.t = st.costUsd; tw.flag.t = flagged
  $('sCellsOf').textContent = `/${st.cellsTotal}`
  $('rateStat').classList.toggle('hot', !!st.busy)
  $('rateStat').title = st.waveMs ? `Last wave: ${st.computed} cells so far, ${st.calls} calls. The last burst took ${st.waveMs} ms.` : ''
  $('flagStat').classList.toggle('some', flagged > 0)
  $('reviewOnlyN').textContent = flaggedRows
}
function stepTweens() {
  for (const [k, t] of Object.entries(tw)) {
    if (t.v === t.t && t.shown === t.t) continue
    const eps = k === 'cost' ? 1e-7 : 0.5
    t.v = Math.abs(t.t - t.v) < eps ? t.t : t.v + (t.t - t.v) * 0.2
    const text = k === 'cost' ? fmtCost(t.v) : String(Math.round(t.v))
    if (text !== t.text) { t.text = text; $({ rows: 'sRows', cols: 'sCols', cells: 'sCells', rate: 'sRate', cost: 'sCost', flag: 'sFlag' }[k]).textContent = text }
    if (t.v === t.t) t.shown = t.t
  }
}

// ---- confidence histogram under the review slider ---------------------------------------------
function drawHist() {
  const cv = $('hist'), dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth, hh = cv.clientHeight
  if (!w || !hh) return
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr) }
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, hh)
  const N = 28, bins = new Array(N).fill(0)
  for (const rid in S.cells) for (const cid in S.cells[rid]) if (colIndex.has(cid)) bins[Math.min(N - 1, Math.floor(S.cells[rid][cid].c * N))]++
  const max = Math.max(1, ...bins), bw = w / N
  for (let i = 0; i < N; i++) {
    if (!bins[i]) continue
    const bh = Math.max(2, Math.sqrt(bins[i] / max) * (hh - 1)) // square root, so small bins still show
    g.fillStyle = (i + 0.5) / N < S.reviewBelow ? 'rgba(251,191,36,.95)' : 'rgba(52,211,153,.5)'
    g.fillRect(i * bw + 0.5, hh - bh, bw - 1, bh)
  }
  g.fillStyle = '#fbbf24'
  g.fillRect(clamp(S.reviewBelow * w - 0.5, 0, w - 1), 0, 1, hh)
}

// ---- inspector --------------------------------------------------------------------------------
function select(next) {
  selected = next
  for (const rec of recs.values()) for (const [cid, c] of rec.cells) {
    const on = !!next && next.row === rec.id && next.col === cid
    c.el.classList.toggle('sel', on); c.el.classList.toggle('bydemo', on && next.by === 'demo')
  }
  if (!next) { inspSeq++; $('inspTag').textContent = ''; $('inspBody').className = 'insp-empty'; $('inspBody').textContent = 'Click any cell to see what Jev was asked and its full answer.'; return }
  inspectNow()
}
const inspectSoon = () => { clearTimeout(inspTimer); inspTimer = setTimeout(inspectNow, 60) }
async function inspectNow() {
  if (!selected) return
  const seq = ++inspSeq
  const d = await post('inspect', { row: selected.row, col: selected.col })
  if (seq !== inspSeq || !selected) return
  if (!d.ok) return select(null)
  renderInspector(d)
}
function bar(label, p, top, tone, desc) {
  const b = h('div', `bar${top ? ' top' : ''}`)
  if (tone) b.style.setProperty('--tone', tone)
  const track = h('div', 'bt'), fill = h('i')
  track.append(fill)
  const l = h('span', 'bl', label); l.title = desc ? `${label}: ${desc}` : label
  b.append(l, track, h('span', 'bv', p >= 0.995 ? '1.00' : p.toFixed(2)))
  if (desc) b.append(h('span', 'bd', desc))
  requestAnimationFrame(() => (fill.style.width = `${Math.max(1.5, p * 100)}%`))
  return b
}
function renderInspector(d) {
  const body = $('inspBody'), col = d.column, cell = d.cell
  body.className = ''
  body.textContent = ''
  const tag = $('inspTag'); tag.textContent = ''
  if (selected.by === 'demo') tag.append(h('span', 'tag demo', 'demo tour'))
  const rowLine = h('div', 'insp-row')
  rowLine.append(h('b', '', `#${d.row.n}`), document.createTextNode(Object.values(d.row.meta ?? {}).join(' · ')))
  if (d.row.group === 'mixed') rowLine.append(h('span', 'tag mixed', 'mixed signals'))
  if (d.row.edited) rowLine.append(h('span', 'tag edited', 'edited'))
  body.append(rowLine, h('div', 'insp-text', d.row.text))
  const q = h('div', 'insp-q'); q.append(h('span', 'tag', col.type), h('span', 'qn', col.type === 'noul' ? col.header : col.name)); q.lastChild.title = col.header
  const asked = String(d.question.instructions ?? '')
  const askedEl = h('div', 'insp-asked', `Jev was asked: ${d.context && asked.startsWith(d.context) ? asked.slice(d.context.length).trim() : asked}`)
  askedEl.title = asked
  body.append(q, askedEl)
  const bars = h('div', 'bars')
  if (!cell) bars.append(h('div', 'insp-empty', 'Jev is judging this row…'))
  else if (col.type === 'noul') {
    const p = cell.answer.noul
    bars.append(bar('yes', p, p >= 0.5, '#34d399'), bar('no', 1 - p, p < 0.5, '#9aa2ba'))
  } else if (col.type === 'choice') {
    let entries = col.options.map((o, i) => [o, cell.answer.probabilities?.[o] ?? 0, i])
    if (entries.length > 8) entries = entries.sort((x, y) => y[1] - x[1]).slice(0, 8)
    for (const [o, p, i] of entries) bars.append(bar(o, p, o === cell.answer.choice, optTone(col, i), col.descriptions?.[o]))
    if (col.options.length > entries.length) bars.append(h('div', 'insp-more', `and ${col.options.length - entries.length} more options`))
  } else {
    const n = col.levels.length, lv = Math.round(cell.answer.score)
    col.levels.forEach((l, i) => bars.append(bar(l, cell.answer.probabilities?.[String(i)] ?? 0, i === lv, lvlTone(n > 1 ? i / (n - 1) : 0))))
    bars.append(h('div', 'insp-more', `score ${Number(cell.answer.score).toFixed(2)} on a 0 to ${n - 1} scale`))
  }
  body.append(bars)
  if (cell) {
    const foot = h('div', 'insp-foot')
    foot.append(h('span', `pill ${cell.conf < S.reviewBelow ? 'warn' : 'ok'}`, cell.conf < S.reviewBelow ? `${cell.conf.toFixed(2)} · under the ${S.reviewBelow.toFixed(2)} line` : `confidence ${cell.conf.toFixed(2)}`))
    if (cell.truth != null) foot.append(h('span', `pill ${cell.ok ? 'ok' : 'bad'}`, cell.ok ? `matches truth: ${fmtTruth(cell.truth)}` : `truth label says ${fmtTruth(cell.truth)}`))
    else foot.append(h('span', 'pill', d.row.edited ? 'edited row, no truth' : 'no truth label'))
    foot.append(document.createTextNode(`${cell.cached ? 'from cache' : cell.latencyMs < 1 ? '<1 ms' : `${Math.round(cell.latencyMs)} ms`} · ~${cell.tokens ?? '?'} tokens for the row · ${S.client === 'mock' ? 'offline stand-in' : 'live Jev'}`))
    body.append(foot)
  }
}
const fmtTruth = (t) => (t === true ? 'yes' : t === false ? 'no' : String(t))

// ---- suggested headers ------------------------------------------------------------------------
function renderChips() {
  const box = $('chips')
  box.textContent = ''
  for (const s of S.suggestions) {
    const p = parseHeader(s)
    if (!p.ok) continue
    const b = h('button', colIndex.has(p.column.id) ? 'have' : '', s)
    b.title = colIndex.has(p.column.id) ? 'Already in the sheet' : `${s}\n${describeColumn(p.column)}`
    b.addEventListener('click', () => { if (!colIndex.has(p.column.id)) submit(s) })
    box.append(b)
  }
}

// ---- the add box ------------------------------------------------------------------------------
function updateHint(text = input.value) {
  if (performance.now() < hintErrorUntil) return
  const t = text.trim()
  if (!t) { hint.className = 'hint'; hint.innerHTML = HINT; return }
  const p = parseHeader(t)
  if (!p.ok) { hint.className = 'hint err'; hint.textContent = p.error; return }
  hint.className = 'hint ok'
  hint.textContent = ''
  const c = p.column
  const detail = c.type === 'choice' ? c.options.join(' · ') : c.type === 'score' ? c.levels.join(' < ') : 'Jev gives the probability of yes for every row'
  hint.append(document.createTextNode('→'), h('b', '', describeColumn(c)), document.createTextNode(detail))
  if (!ghostRun) hint.append(h('em', '', 'press Enter'))
}
function flashError(msg) {
  hintErrorUntil = 0
  hint.className = 'hint err'; hint.textContent = msg
  hintErrorUntil = performance.now() + 3500
  addBox.classList.remove('bad'); void addBox.offsetWidth; addBox.classList.add('bad')
  setTimeout(() => addBox.classList.remove('bad'), 400)
}
async function submit(header) {
  const t = String(header ?? '').trim()
  if (!t) return
  const p = parseHeader(t)
  if (!p.ok) return flashError(p.error)
  const r = await post('addColumn', { header: t })
  if (!r.ok) return flashError(r.error || 'could not add that column')
  if (header === input.value) input.value = ''
  hintErrorUntil = 0; updateHint()
}
function dropGhostText() { if (ghostOwnsInput) { input.value = ''; ghostOwnsInput = false } ghostRun = null; addBox.classList.remove('ghosting'); $('ghostTag').classList.add('hidden') }
input.addEventListener('pointerdown', dropGhostText)
input.addEventListener('focus', dropGhostText)
input.addEventListener('input', () => { hintErrorUntil = 0; updateHint() })
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submit(input.value) }
  else if (e.key === 'Escape') { input.value = ''; updateHint(); input.blur() }
})
for (const b of document.querySelectorAll('.gex')) b.addEventListener('click', () => { dropGhostText(); input.value = b.dataset.ex; input.focus(); updateHint() })

// ---- the ghost typist -------------------------------------------------------------------------
function applyGhost(g) {
  ghostInfo = g; ghostInfoAt = performance.now()
  if (g.phase === 'typing' && g.header && document.activeElement !== input) {
    if (!ghostRun || ghostRun.header !== g.header) ghostRun = { header: g.header, typeMs: g.typeMs, t0: performance.now() - g.elapsedMs }
  } else if (ghostRun) {
    const committed = g.phase === 'dwell'
    if (committed) { $('enterKey').classList.add('pressed'); setTimeout(() => $('enterKey').classList.remove('pressed'), 320) }
    dropGhostText(); updateHint()
  }
  $('demoBtn').classList.toggle('on', !!g.enabled)
}
function stepGhost(now) {
  const left = ghostInfo.enabled ? Math.max(0, ghostInfo.pausedMs - (now - ghostInfoAt)) : 0
  const label = !ghostInfo.enabled ? 'off' : left > 0 ? `rests ${Math.ceil(left / 1000)}s` : 'on'
  if ($('demoState').textContent !== label) $('demoState').textContent = label
  $('demoBtn').classList.toggle('resting', left > 0)
  if (!ghostRun) return
  const f = clamp((now - ghostRun.t0) / ghostRun.typeMs, 0, 1)
  const typed = ghostRun.header.slice(0, Math.floor(f * ghostRun.header.length))
  const caret = f < 1 && Math.floor(now / 380) % 2 === 0 ? '▍' : ''
  if (input.value !== typed + caret) {
    input.value = typed + caret; ghostOwnsInput = true
    if (typed !== ghostRun.typed) { ghostRun.typed = typed; updateHint(typed) }
  }
  addBox.classList.add('ghosting'); $('ghostTag').classList.remove('hidden')
}
/** While the ghost is awake and nobody has picked a cell, it also walks the inspector around. */
function stepTour(now) {
  if (!S || !ghostInfo.enabled || now - lastTour < 3600 || editing) return
  if (ghostInfo.pausedMs - (now - ghostInfoAt) > 0 || held.size) return // resting: the person is playing
  lastTour = now
  const pool = [], flagged = []
  const sticky = NUM_W + parseFloat(root.style.getPropertyValue('--textw') || '300'), colw = parseFloat(root.style.getPropertyValue('--colw') || '142')
  for (const rec of recs.values()) if (!rec.dying) for (const cid of rec.cells.keys()) {
    const cell = S.cells[rec.id]?.[cid]
    if (!cell || (selected && selected.row === rec.id && selected.col === cid)) continue
    const top = rec.y - grid.scrollTop
    if (top < 0 || top > grid.clientHeight - HEAD_H - ROW_H) continue
    const left = sticky + S.columns.findIndex((c) => c.id === cid) * colw - grid.scrollLeft // only cells in full view
    if (left < sticky - 2 || left + colw > grid.clientWidth + 2) continue
    pool.push([rec.id, cid]); if (cell.c < S.reviewBelow || cell.ok === 0) flagged.push([rec.id, cid])
  }
  const from = flagged.length && Math.random() < 0.7 ? flagged : pool
  if (!from.length) return
  const [row, col] = from[Math.floor(Math.random() * from.length)]
  select({ row, col, by: 'demo' })
}
function userTouch() {
  const now = performance.now()
  if (now - lastTouch < 1500) return
  lastTouch = now
  ghostInfo = { ...ghostInfo, pausedMs: 60000 }; ghostInfoAt = now
  post('touch')
}
for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, (e) => { if (e.isTrusted) userTouch() }, { capture: true, passive: true })

// ---- interactions -----------------------------------------------------------------------------
ghead.addEventListener('click', (e) => {
  const cell = e.target.closest('.hc.jev')
  if (!cell || cell.classList.contains('leave')) return
  if (e.target.closest('.h-x')) post('removeColumn', { id: cell.dataset.col })
  else post('sort', { col: cell.dataset.col })
})
gbody.addEventListener('click', (e) => {
  const cell = e.target.closest('.c-jev')
  if (!cell || cell.classList.contains('leave')) return
  select({ row: cell.parentElement.dataset.row, col: cell.dataset.col, by: 'user' })
})
gbody.addEventListener('dblclick', (e) => {
  const t = e.target.closest('.c-text')
  if (t && !editing) startEdit(t.parentElement.dataset.row)
})
function startEdit(id) {
  const rec = recs.get(id), r = rowIndex.get(id)
  if (!rec || !r) return
  const ta = h('textarea', 'editor')
  ta.value = r.text
  rec.text.append(ta); rec.el.classList.add('editing')
  editing = { id, ta }
  ta.focus(); ta.select()
  const done = async (save) => {
    if (!editing || editing.ta !== ta) return
    editing = null
    const text = ta.value.replace(/\s+/g, ' ').trim()
    ta.remove(); rec.el.classList.remove('editing')
    if (save && text && text !== r.text) { const res = await post('editRow', { id, text }); if (!res.ok) flashError(res.error || 'could not edit that row') }
    dirty.rows = true
  }
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true) } else if (e.key === 'Escape') done(false) })
  ta.addEventListener('blur', () => done(true))
}
$('reviewOnlyBtn').addEventListener('click', () => post('reviewOnly', { on: !S?.reviewOnly }))
$('resetBtn').addEventListener('click', () => { select(null); post('reset') })
$('demoBtn').addEventListener('click', () => post('demo', { on: !ghostInfo.enabled }))
const range = $('reviewRange')
range.addEventListener('input', () => {
  if (!S) return
  draggingReview = true
  S.reviewBelow = Number(range.value)
  $('reviewVal').textContent = S.reviewBelow.toFixed(2)
  for (const rec of recs.values()) for (const [cid, c] of rec.cells) { const cell = S.cells[rec.id]?.[cid]; c.el.classList.toggle('flag', !!cell && !held.has(rec.id + SEP + cid) && cell.c < S.reviewBelow) }
  dirty.top = dirty.hist = true
  if (!reviewPostTimer) reviewPostTimer = setTimeout(() => { reviewPostTimer = null; post('setReview', { value: S.reviewBelow }) }, 70)
})
range.addEventListener('change', () => { draggingReview = false; post('setReview', { value: Number(range.value) }) })
window.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); input.focus() } })
grid.addEventListener('scroll', () => { dirty.rows = true; grid.classList.toggle('xscrolled', grid.scrollLeft > 0) }, { passive: true })
new ResizeObserver(() => { layout(); dirty.rows = dirty.hist = true }).observe(grid)

// ---- the frame loop ---------------------------------------------------------------------------
function frame(now) {
  if (S) {
    if (held.size) for (const [key, at] of held) {
      if (now < at) continue
      held.delete(key)
      const [rid, cid] = key.split(SEP)
      const rec = recs.get(rid), col = colIndex.get(cid), c = rec?.cells.get(cid)
      if (rec && col && c) paintCell(rec, col, c, true)
    }
    if (dirty.rows) { dirty.rows = false; renderRows() }
    if (dirty.head) { dirty.head = false; renderHead() }
    if (dirty.top) { dirty.top = false; renderTop() }
    if (dirty.hist) { dirty.hist = false; drawHist() }
    stepTweens(); stepGhost(now); stepTour(now)
  }
  requestAnimationFrame(frame)
}

updateHint()
const es = new EventSource('/events')
es.addEventListener('state', (e) => applyState(JSON.parse(e.data)))
es.addEventListener('cells', (e) => applyCells(JSON.parse(e.data)))
es.addEventListener('view', (e) => applyView(JSON.parse(e.data)))
es.addEventListener('ghost', (e) => applyGhost(JSON.parse(e.data)))
requestAnimationFrame(frame)
