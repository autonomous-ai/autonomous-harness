// Doc Viewer, the page. pdf.js's own viewer components (PDFViewer: lazy page rendering, HiDPI
// canvases, the text layer, links, find) wrapped in a reader that behaves like Preview: a
// thumbnail and outline sidebar, zoom modes, spreads, a find bar, present mode, shortcuts — and
// that stays live: every new PDF is rendered off-screen and swapped in at the same page, offset
// and zoom, with the pages that changed marked, while the server's state says when a compile is
// on its way or failed.
//
// pdf.js's modern build leans on JavaScript that only this year's WebKit has (Map.getOrInsertComputed,
// Math.sumPrecise, RegExp.escape…). The pane is whatever WKWebView the Mac ships, so an older macOS
// gets pdf.js's legacy build — same version, transpiled and polyfilled — instead of a blank pane.
const MODERN = !new URLSearchParams(location.search).has('legacy') && [
  Map.prototype.getOrInsertComputed, Math.sumPrecise, RegExp.escape, Promise.try, Promise.withResolvers,
  Uint8Array.fromBase64, Uint8Array.prototype.toHex, globalThis.Float16Array, URL.parse,
].every((f) => typeof f === 'function')
const PDFJS = MODERN ? '/vendor/' : '/vendor/legacy/'
const pdfjs = await import(PDFJS + 'build/pdf.min.mjs')
const { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer, RenderingStates, ScrollMode, SpreadMode } = await import(PDFJS + 'web/pdf_viewer.mjs')

pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.mjs'
const worker = new pdfjs.PDFWorker({ name: 'doc-viewer' })

// ---------------------------------------------------------------------------------------------
// small things
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'
const CSS_UNITS = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS
const THUMB_W = 116
const THUMB_PX = 232
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('dv:' + key); return v == null ? fallback : JSON.parse(v) } catch { return fallback } },
  set(key, value) { try { localStorage.setItem('dv:' + key, JSON.stringify(value)) } catch { /* private mode */ } },
}
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k === 'style') node.style.cssText = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null) node.append(c)
  return node
}
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')
const baseName = (p) => (p || '').split('/').pop()
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB' }
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return s + ' s ago'
  const m = Math.round(s / 60)
  if (m < 60) return m + ' min ago'
  const h = Math.round(m / 60)
  return h < 24 ? h + ' h ago' : new Date(ms).toLocaleDateString()
}
function ranges(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const out = []
  for (const n of sorted) {
    const last = out[out.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  const parts = out.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`))
  return parts.length > 4 ? parts.slice(0, 3).join(', ') + ` +${parts.length - 3} more` : parts.join(', ')
}
function fnv(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16) + ':' + bytes.length
}

const ICONS = {
  sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 3v10"/>',
  'chevron-up': '<path d="M4 10l4-4 4 4"/>',
  'chevron-down': '<path d="M4 6l4 4 4-4"/>',
  'chevron-left': '<path d="M10 4L6 8l4 4"/>',
  'chevron-right': '<path d="M6 4l4 4-4 4"/>',
  minus: '<path d="M3.5 8h9"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/>',
  present: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  more: '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
  close: '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  download: '<path d="M8 2.5v8M4.75 7.25L8 10.5l3.25-3.25M3 13.5h10"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  folder: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>',
  print: '<path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.75h.01M6.5 6.75h.01M9 6.75h.01M11.5 6.75h.01M5 9.5h6"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>',
  moon: '<path d="M13.25 9.5A5.5 5.5 0 0 1 6.5 2.75a5.5 5.5 0 1 0 6.75 6.75z"/>',
  monitor: '<rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.75h5"/>',
  back: '<path d="M6 3.5L2.5 7 6 10.5"/><path d="M3 7h6.5a3.25 3.25 0 0 1 0 6.5H7.5"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5"/>',
  file: '<path d="M4 1.75h5l3.25 3.25v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z"/><path d="M9 1.75V5h3.25"/>',
  continuous: '<rect x="4.25" y="1.5" width="7.5" height="5.75" rx="1"/><rect x="4.25" y="8.75" width="7.5" height="5.75" rx="1"/>',
  single: '<rect x="3.75" y="2" width="8.5" height="12" rx="1"/>',
  two: '<rect x="1.5" y="3" width="6" height="10" rx="1"/><rect x="8.5" y="3" width="6" height="10" rx="1"/>',
  book: '<rect x="8.5" y="3" width="6" height="10" rx="1"/><rect x="1.5" y="3" width="6" height="10" rx="1" stroke-dasharray="1.6 1.6"/>',
  twisty: '<path d="M6 4l4 4-4 4"/>',
}
const icon = (name) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
for (const node of $$('[data-icon]')) node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon))

// ---------------------------------------------------------------------------------------------
// elements and state
const app = $('#app'), stage = $('#stage'), sidebar = $('#sidebar'), thumbsEl = $('#thumbs'), outlineEl = $('#outline')
const pageInput = $('#page-input'), pageCount = $('#page-count'), zoomBtn = $('#btn-zoom'), titleBtn = $('#doc-title')
const buildPill = $('#build-pill'), busyBar = $('#busy-bar'), errorCard = $('#error-card'), emptyEl = $('#empty')
const findbar = $('#findbar'), findInput = $('#find-input'), findCount = $('#find-count')

const params = new URLSearchParams(location.search)
let requested = params.get('file') || ''
let S = null                 // the server's last state
let cur = null               // the live document instance
let layout = store.get('layout', 'continuous')   // continuous | single | two | book
let zoom = { mode: 'auto', scale: 1 }            // auto | width | page | actual | custom
let presenting = false
let sidebarPref = store.get('sidebar', null)     // null = decide by width
let sideTab = store.get('tab', 'pages')
let theme = store.get('theme', 'auto')
let errorHiddenFor = null    // the failure (its `since`) the user tucked away
const find = { open: false, caseSensitive: false, entireWord: false }

// ---------------------------------------------------------------------------------------------
// theme
function applyTheme() {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}
applyTheme()

// ---------------------------------------------------------------------------------------------
// the server
let events = null
function connect() {
  events?.close()
  events = new EventSource('/events?file=' + encodeURIComponent(requested))
  events.addEventListener('state', (e) => onState(JSON.parse(e.data)))
}

async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-doc-viewer': '1' }, body: JSON.stringify(body) })
    return r.ok
  } catch { return false }
}

function onState(state) {
  S = state
  app.classList.remove('booting')
  renderBuild()
  renderTitle()
  if (state.pdf) {
    if (!cur || cur.path !== state.pdf.path || cur.mtimeMs !== state.pdf.mtimeMs || cur.size !== state.pdf.size) scheduleLoad(state.pdf)
  } else if (!cur) {
    renderEmpty()
  }
}

// ---------------------------------------------------------------------------------------------
// loading: fetch the bytes (whole, or wait: a compiler may be mid-write), parse, lay out off-screen
// at the live view's place, wait until the visible pages are painted, swap
let wanted = null, loader = null, restoreOnce = true
function scheduleLoad(info) {
  wanted = info
  if (!loader) loader = (async () => { while (wanted) { const next = wanted; wanted = null; try { await loadVersion(next) } catch (e) { console.error('[doc-viewer]', e) } } })().finally(() => { loader = null })
}

function looksComplete(buf) {
  if (buf.length < 64) return false
  const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(1024, buf.length)))
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)))
  return head.includes('%PDF') && tail.includes('%%EOF')
}

async function fetchBytes(info) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch('/ws/' + encodePath(info.path) + '?v=' + Math.round(info.mtimeMs) + '-' + attempt, { cache: 'no-store' })
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer())
        if (looksComplete(buf)) return buf
      }
    } catch { /* server restarting */ }
    if (wanted && wanted.path === info.path && wanted.mtimeMs !== info.mtimeMs) return null
    await sleep(120 + attempt * 80)
  }
  return null
}

async function loadVersion(info) {
  const bytes = await fetchBytes(info)
  if (!bytes) {
    if (!wanted) failRead(info, 'the file never finished writing')
    return
  }
  const hash = fnv(bytes)
  if (cur && cur.path === info.path && cur.hash === hash) { Object.assign(cur, { mtimeMs: info.mtimeMs, size: info.size }); return }
  let doc
  try {
    doc = await pdfjs.getDocument({
      data: bytes, worker, isEvalSupported: false, enableXfa: false,
      cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl: '/vendor/wasm/', iccUrl: '/vendor/iccs/',
    }).promise
  } catch (error) {
    if (!wanted) failRead(info, error?.message || String(error))
    return
  }
  const old = cur && cur.path === info.path ? cur : null
  const inst = await mount(doc, { ...info, hash }, old)
  if (!inst) return
  if (cur && cur !== old) retire(cur)
  swapIn(inst, old)
}

function failRead(info, why) {
  if (cur) toast({ text: `Could not read ${baseName(info.path)}`, sub: 'showing the previous version', tone: 'danger', ms: 4000 })
  else renderEmpty({ unreadable: `${info.path} could not be read (${why}).` })
}

function makeInstance() {
  const container = el('div', { class: 'viewerContainer pending', tabindex: '-1' })
  const viewer = el('div', { class: 'pdfViewer' })
  container.append(viewer)
  stage.prepend(container)
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' })
  const findController = new PDFFindController({ eventBus, linkService })
  const ac = new AbortController()
  const pdfViewer = new PDFViewer({
    container, viewer, eventBus, linkService, findController, abortSignal: ac.signal,
    removePageBorders: true, textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.ENABLE,
    annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
  })
  linkService.setViewer(pdfViewer)
  linkService.setHistory(navHistory)
  // A live reload re-runs the search; it must not yank the view to the first match.
  const scrollMatch = findController.scrollMatchIntoView.bind(findController)
  findController.scrollMatchIntoView = (args) => { if (inst.quietFind) { findController._scrollMatches = false; return } scrollMatch(args) }
  const inst = {
    container, viewer, eventBus, linkService, findController, pdfViewer, ac, doc: null,
    path: '', mtimeMs: 0, size: 0, hash: '', title: '', thumbs: new Map(), changed: new Set(),
    prevHashes: null, prevCount: 0, isUpdate: false, dead: false, quietFind: false, outline: null, shownAt: 0,
  }
  wireInstance(inst)
  return inst
}

async function mount(doc, info, old) {
  const inst = makeInstance()
  Object.assign(inst, { doc, path: info.path, mtimeMs: info.mtimeMs, size: info.size, hash: info.hash })
  const pagesInit = new Promise((r) => inst.eventBus.on('pagesinit', r, { once: true }))
  inst.linkService.setDocument(doc)
  inst.pdfViewer.setDocument(doc)
  await pagesInit
  if (inst.dead) return null
  applyLayout(inst)
  if (old) {
    // Same file, new version: take the live view's zoom and place.
    applyZoom(inst, { keepPlace: false })
    const seen = { top: old.container.scrollTop, left: old.container.scrollLeft }
    await placeLike(inst, old)
    inst.pdfViewer.update()
    await visiblePainted(inst, 1800)
    if (inst.dead) return null
    // The reader may have scrolled while we painted: follow once more.
    if (old.container.scrollTop !== seen.top || old.container.scrollLeft !== seen.left) {
      await placeLike(inst, old)
      await visiblePainted(inst, 500)
    }
    inst.isUpdate = true
    inst.prevHashes = new Map([...old.thumbs].map(([n, t]) => [n, t.hash]))
    inst.prevCount = old.doc.numPages
  } else {
    const saved = restoreOnce ? store.get(viewKey(info.path), null) : null
    restoreOnce = false
    if (saved?.zoom) zoom = saved.zoom
    applyZoom(inst, { keepPlace: false })
    if (saved?.loc) placeAt(inst, saved.loc)
  }
  return inst
}

// Put a new version at the old one's place. The same pixels when the pages kept their shape; the same
// PDF point otherwise; and then, when the line of text at the top of the view still exists nearby,
// that line exactly where it was — so a paragraph the agent adds above what you are reading pushes
// nothing out of view.
async function placeLike(inst, old) {
  const sameShape = old.doc.numPages === inst.doc.numPages && Math.abs(old.container.scrollHeight - inst.container.scrollHeight) < 2
  if (sameShape) { inst.container.scrollTop = old.container.scrollTop; inst.container.scrollLeft = old.container.scrollLeft }
  else placeAt(inst, old.pdfViewer._location)
  if (presenting || inst.pdfViewer.scrollMode === ScrollMode.PAGE) return
  try {
    const anchors = await textAnchors(old)
    if (!anchors.length || inst.dead) return
    const hit = await findAnchor(inst, anchors)
    if (!hit || inst.dead) return
    const view = inst.pdfViewer.getPageView(hit.pageNumber - 1)
    const y = view.div.offsetTop + view.viewport.convertToViewportPoint(hit.x, hit.y)[1]
    inst.container.scrollTop = Math.max(0, y - hit.offset)
    inst.container.scrollLeft = old.container.scrollLeft
  } catch (error) {
    console.warn('[doc-viewer] anchor', error)
  }
}

async function pageText(inst, n) {
  const page = await inst.doc.getPage(n)
  const { items } = await page.getTextContent()
  let text = ''
  const starts = []
  for (const it of items) { starts.push(text.length); text += it.str ?? '' }
  return { items, text, starts }
}
const count = (hay, needle) => { let n = 0, at = hay.indexOf(needle); while (at >= 0) { n++; at = hay.indexOf(needle, at + 1) } return n }

// Lines near the top of the view whose text appears once on their page: candidates to hold still.
async function textAnchors(inst) {
  const pv = inst.pdfViewer, top = inst.container.scrollTop, bottom = top + inst.container.clientHeight
  const out = []
  for (const { id } of [...pv._getVisiblePages().views].sort((a, b) => a.id - b.id).slice(0, 2)) {
    const view = pv.getPageView(id - 1)
    const { items, text, starts } = await pageText(inst, id)
    for (let i = 0; i < items.length && out.length < 6; i++) {
      const it = items[i]
      if (!it.str?.trim() || !it.transform) continue
      const y = view.div.offsetTop + view.viewport.convertToViewportPoint(it.transform[4], it.transform[5])[1]
      if (y - top < 14 || y > bottom) continue
      const snippet = text.slice(starts[i], starts[i] + 64)
      if (snippet.trim().length < 20 || count(text, snippet) !== 1) continue
      out.push({ pageNumber: id, text: snippet, offset: y - top })
      i += 8
    }
    if (out.length >= 6) break
  }
  return out
}

// The first candidate found exactly once within six pages of where it was.
async function findAnchor(inst, anchors) {
  const total = inst.doc.numPages, cache = new Map()
  const textOf = (n) => { if (!cache.has(n)) cache.set(n, pageText(inst, n)); return cache.get(n) }
  for (const anchor of anchors) {
    const hits = []
    for (let n = Math.max(1, anchor.pageNumber - 6); n <= Math.min(total, anchor.pageNumber + 6); n++) {
      const { items, text, starts } = await textOf(n)
      let at = text.indexOf(anchor.text)
      while (at >= 0 && hits.length < 2) {
        let lo = 0, hi = starts.length - 1
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1 }
        if (items[lo]?.transform) hits.push({ pageNumber: n, x: items[lo].transform[4], y: items[lo].transform[5], offset: anchor.offset, exact: starts[lo] === at })
        at = text.indexOf(anchor.text, at + 1)
      }
      if (hits.length > 1) break
    }
    if (hits.length === 1 && hits[0].exact) return hits[0]
  }
  return null
}

function placeAt(inst, loc) {
  if (!loc) return
  const n = clamp(loc.pageNumber | 0, 1, inst.doc.numPages)
  if (inst.pdfViewer.scrollMode === ScrollMode.PAGE || presenting) { inst.pdfViewer.currentPageNumber = n; return }
  inst.pdfViewer.scrollPageIntoView({ pageNumber: n, destArray: [null, { name: 'XYZ' }, loc.left, loc.top, null], allowNegativeOffset: true, ignoreDestinationZoom: true })
}

function visiblePainted(inst, timeout) {
  return new Promise((resolve) => {
    let timer = null
    const done = () => { clearTimeout(timer); inst.eventBus.off('pagerendered', check); resolve() }
    const check = () => requestAnimationFrame(() => {
      if (inst.dead) return done()
      const { views } = inst.pdfViewer._getVisiblePages()
      if (views.length && views.every((v) => v.view.renderingState === RenderingStates.FINISHED)) done()
    })
    timer = setTimeout(done, timeout)
    inst.eventBus.on('pagerendered', check)
    check()
  })
}

function swapIn(inst, old) {
  const hadFocus = old && old.container.contains(document.activeElement)
  inst.container.classList.remove('pending')
  inst.container.classList.add('live')
  inst.shownAt = performance.now()
  cur = inst
  if (old) retire(old)
  if (hadFocus) inst.container.focus({ preventScroll: true })
  if (changeToastEl) { dismiss(changeToastEl); changeToastEl = null }
  app.classList.remove('no-doc')
  emptyEl.hidden = true
  renderTitle()
  renderBuild()
  updatePageUI()
  updateZoomUI()
  syncSidebar()
  buildThumbs(inst)
  buildOutline(inst)
  if (find.open && findInput.value) { inst.quietFind = true; dispatchFind(''); setTimeout(() => { inst.quietFind = false }, 1500) }
  thumbPass(inst)
  loadTitle(inst)
}

function retire(inst) {
  if (!inst || inst.dead) return
  inst.dead = true
  inst.container.remove()
  try { inst.pdfViewer.setDocument(null); inst.linkService.setDocument(null) } catch { /* already gone */ }
  inst.ac.abort()
  for (const t of inst.thumbs.values()) if (t.url && !shownUrls.has(t.url)) URL.revokeObjectURL(t.url)
  inst.doc?.loadingTask?.destroy().catch(() => {})
}

async function loadTitle(inst) {
  try {
    const { info } = await inst.doc.getMetadata()
    const title = typeof info?.Title === 'string' ? info.Title.trim() : ''
    inst.title = title && !/^untitled/i.test(title) ? title : ''
  } catch { inst.title = '' }
  if (inst === cur) renderTitle()
}

// ---------------------------------------------------------------------------------------------
// per-instance events
function wireInstance(inst) {
  const { eventBus, container } = inst
  eventBus.on('pagechanging', () => { if (inst === cur) { updatePageUI(); markCurrentThumb(); scheduleOutlineSync() } })
  eventBus.on('scalechanging', () => { if (inst === cur) updateZoomUI() })
  eventBus.on('updateviewarea', ({ location }) => { if (inst === cur) { saveView(location); scheduleOutlineSync() } })
  eventBus.on('pagerendered', ({ pageNumber }) => { if (inst === cur && inst.changed.has(pageNumber) && performance.now() - inst.shownAt < 6000) flashPage(inst, pageNumber) })
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => { if (inst === cur) renderFindCount(matchesCount) })
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount, previous }) => { if (inst === cur) renderFindState(state, matchesCount, previous) })
  container.addEventListener('wheel', onWheel, { passive: false })
  container.addEventListener('click', onDocClick, true)
  container.addEventListener('mouseover', onLinkHover)
  container.addEventListener('mouseout', (e) => { if (e.target.closest?.('.annotationLayer a')) hideLinkStatus() })
}

// ---------------------------------------------------------------------------------------------
// layout and zoom
function applyLayout(inst = cur) {
  if (!inst) return
  const mode = presenting ? 'single' : layout
  const pv = inst.pdfViewer
  pv.scrollMode = mode === 'single' ? ScrollMode.PAGE : ScrollMode.VERTICAL
  pv.spreadMode = mode === 'two' ? SpreadMode.ODD : mode === 'book' ? SpreadMode.EVEN : SpreadMode.NONE
}

function setLayout(next) {
  if (!cur) { layout = next; store.set('layout', next); return }
  const page = cur.pdfViewer.currentPageNumber
  layout = next
  store.set('layout', next)
  applyLayout()
  applyZoom(cur, { keepPlace: false })
  goToPage(page, { history: false })
}

function pageBox(inst) {
  const pv = inst.pdfViewer
  const view = pv.getPageView(Math.max(0, pv.currentPageNumber - 1)) ?? pv.getPageView(0)
  let w = view.width / view.scale, h = view.height / view.scale
  if (pv.spreadMode !== SpreadMode.NONE && pv.scrollMode !== ScrollMode.PAGE) {
    const other = pv.getPageView(pv.currentPageNumber) ?? view
    w = w + other.width / other.scale + 12
  }
  return { w, h }
}

function targetScale(inst, mode = zoom.mode) {
  if (!inst) return 1
  const { w, h } = pageBox(inst)
  const padX = presenting ? 0 : 28, padY = presenting ? 0 : 36
  const cw = Math.max(80, inst.container.clientWidth - padX * 2), ch = Math.max(80, inst.container.clientHeight - padY)
  const fitW = cw / w, fitP = Math.min(fitW, ch / h)
  if (presenting) return fitP
  switch (mode) {
    case 'width': return fitW
    case 'page': return fitP
    case 'actual': return 1
    case 'custom': return zoom.scale
    default: return w > h * 1.15 ? Math.min(fitP, 1.5) : Math.min(fitW, 1.25)
  }
}

function applyZoom(inst = cur, { keepPlace = true } = {}) {
  if (!inst) return
  const s = clamp(targetScale(inst), 0.1, 10)
  if (Math.abs(inst.pdfViewer.currentScale - s) < 1e-3 && inst.pdfViewer.currentScaleValue) return
  if (keepPlace) inst.pdfViewer.currentScale = s
  else inst.pdfViewer.currentScaleValue = String(s)
  if (inst === cur) updateZoomUI()
}

function setZoom(mode, scale) {
  zoom = mode === 'custom' ? { mode, scale: clamp(scale, 0.1, 10) } : { mode, scale: 1 }
  applyZoom()
  saveView()
}

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.5, 8, 10]
function zoomStep(dir, origin = null) {
  if (!cur) return
  const now = cur.pdfViewer.currentScale
  const next = dir > 0 ? (STEPS.find((s) => s > now * 1.02) ?? 10) : ([...STEPS].reverse().find((s) => s < now / 1.02) ?? 0.1)
  zoom = { mode: 'custom', scale: next }
  if (origin) cur.pdfViewer.updateScale({ scaleFactor: next / now, origin, drawingDelay: 150 })
  else cur.pdfViewer.currentScale = next
  updateZoomUI()
  saveView()
}

let pinch = 1, pinchTimer = null
function zoomBy(factor, origin) {
  if (!cur) return
  pinch *= factor
  const now = cur.pdfViewer.currentScale
  const target = clamp(now * pinch, 0.1, 10)
  if (Math.abs(Math.round(target * 100) - Math.round(now * 100)) < 1) return
  cur.pdfViewer.updateScale({ scaleFactor: target / now, origin, drawingDelay: 250 })
  pinch = 1
  zoom = { mode: 'custom', scale: cur.pdfViewer.currentScale }
  updateZoomUI()
  clearTimeout(pinchTimer)
  pinchTimer = setTimeout(saveView, 400)
}

function onWheel(e) {
  if (presenting) {
    e.preventDefault()
    presentWheel(e.deltaY)
    return
  }
  if (!(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
  const pinch = e.ctrlKey && !e.metaKey && Math.abs(delta) < 50 && e.deltaMode === 0
  if (pinch) return zoomBy(Math.exp(-delta / 100), [e.clientX, e.clientY])
  const now = performance.now()
  if (now - (onWheel.last ?? 0) < 90 || !delta) return
  onWheel.last = now
  zoomStep(delta < 0 ? 1 : -1, [e.clientX, e.clientY])
}
// Safari and WKWebView pinch
let gestureBase = 1
document.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureBase = cur?.pdfViewer.currentScale ?? 1 })
document.addEventListener('gesturechange', (e) => {
  e.preventDefault()
  if (!cur || presenting) return
  const want = clamp(gestureBase * e.scale, 0.1, 10)
  zoomBy(want / cur.pdfViewer.currentScale, [e.clientX, e.clientY])
})
document.addEventListener('gestureend', (e) => e.preventDefault())

let resizeRaf = 0
new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    syncSidebar()
    if (cur && (presenting || zoom.mode !== 'custom')) applyZoom()
  })
}).observe(stage)

// ---------------------------------------------------------------------------------------------
// pages and places
function goToPage(n, { history = true } = {}) {
  if (!cur) return
  const pv = cur.pdfViewer
  n = clamp(n | 0, 1, cur.doc.numPages)
  if (history && n !== pv.currentPageNumber) navHistory.remember()
  pv.currentPageNumber = n
  if (pv.scrollMode !== ScrollMode.PAGE && cur.container.scrollTop > 0) cur.container.scrollTop = Math.max(0, cur.container.scrollTop - 12)
  if (history && navHistory.pending) navHistory.commit(n)
}
function nextPage() { if (cur) { cur.pdfViewer.nextPage(); nudge() } }
function prevPage() { if (cur) { cur.pdfViewer.previousPage(); nudge() } }
function nudge() { if (cur && cur.pdfViewer.scrollMode !== ScrollMode.PAGE && cur.container.scrollTop > 0) cur.container.scrollTop = Math.max(0, cur.container.scrollTop - 12) }

function updatePageUI() {
  if (!cur) return
  const n = cur.pdfViewer.currentPageNumber, total = cur.doc.numPages
  if (document.activeElement !== pageInput) pageInput.value = String(n)
  pageInput.style.width = Math.max(2, String(total).length) + 1.2 + 'ch'
  pageCount.textContent = '/ ' + total
  $('#btn-prev').disabled = n <= 1
  $('#btn-next').disabled = n >= total
  $('#hud-page').textContent = `${n} / ${total}`
}

pageInput.addEventListener('focus', () => pageInput.select())
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const n = parseInt(pageInput.value, 10)
    if (Number.isFinite(n)) goToPage(n)
    pageInput.blur()
    cur?.container.focus({ preventScroll: true })
  } else if (e.key === 'Escape') { pageInput.blur() }
  e.stopPropagation()
})
pageInput.addEventListener('blur', updatePageUI)
$('#btn-prev').addEventListener('click', prevPage)
$('#btn-next').addEventListener('click', nextPage)

function updateZoomUI() {
  if (!cur) return
  zoomBtn.textContent = Math.round(cur.pdfViewer.currentScale * 100) + '%'
}

// Back after following a link: pdf.js tells its history where it was before every jump.
const navHistory = {
  stack: [], pending: null,
  remember() { if (cur?.pdfViewer._location) this.pending = { ...cur.pdfViewer._location, zoom: { ...zoom } } },
  commit(toPage) {
    const from = this.pending
    this.pending = null
    if (!from || from.pageNumber === toPage) return
    this.stack.push(from)
    if (this.stack.length > 50) this.stack.shift()
    renderBackChip()
  },
  pushCurrentPosition() { this.remember() },
  push({ pageNumber }) { this.commit(pageNumber); breathe() },
  pushPage(pageNumber) { this.commit(pageNumber) },
  back() { goBack() },
  forward() {},
}
// pdf.js puts a destination flush with the top edge; a heading reads better with a little air.
function breathe() {
  const inst = cur
  queueMicrotask(() => { if (inst === cur && inst.pdfViewer.scrollMode !== ScrollMode.PAGE && inst.container.scrollTop > 0) inst.container.scrollTop = Math.max(0, inst.container.scrollTop - 20) })
}
function goBack() {
  const loc = navHistory.stack.pop()
  renderBackChip()
  if (!loc || !cur) return
  placeAt(cur, loc)
}
// The chip offers the way back right after a jump, then gets out of the way (⌘[ still works).
let backChipTimer = null
function renderBackChip(fresh = true) {
  const chip = $('#back-chip')
  const top = navHistory.stack[navHistory.stack.length - 1]
  chip.hidden = !top || presenting || !fresh
  clearTimeout(backChipTimer)
  if (!top || chip.hidden) return
  chip.innerHTML = icon('back') + `<span>Back to page ${top.pageNumber}</span>`
  backChipTimer = setTimeout(() => { if (!chip.matches(':hover')) chip.hidden = true }, 12_000)
}
$('#back-chip').addEventListener('click', goBack)

function saveView(location) {
  if (!cur) return
  clearTimeout(saveView.t)
  saveView.t = setTimeout(() => {
    const loc = location ?? cur.pdfViewer._location
    if (loc) store.set(viewKey(cur.path), { loc: { pageNumber: loc.pageNumber, left: loc.left, top: loc.top }, zoom })
  }, 400)
}
const viewKey = (path) => 'view:' + (S?.workspace ?? '') + '/' + path

// ---------------------------------------------------------------------------------------------
// what changed: every page is drawn small once per version (the thumbnail), and its pixels hashed;
// a page whose hash differs from the previous version's is a page the agent just changed
const shownUrls = new Set()
let thumbObserver = null
const visibleThumbs = new Set()

async function thumbPass(inst) {
  const total = inst.doc.numPages
  const pending = new Set(Array.from({ length: total }, (_, i) => i + 1))
  let lastToast = 0
  while (pending.size && !inst.dead) {
    if (inst !== cur) return
    await mainIdle(inst)
    if (inst.dead) return
    const n = pickNext(inst, pending)
    pending.delete(n)
    try {
      const t = await renderThumb(inst, n)
      if (inst.dead) { URL.revokeObjectURL(t.url); return }
      inst.thumbs.set(n, t)
      showThumb(inst, n)
      if (inst.isUpdate) {
        const before = inst.prevHashes.get(n)
        if (n > inst.prevCount || (before && before !== t.hash)) {
          inst.changed.add(n)
          markChanged(inst, n)
        }
        if (performance.now() - inst.shownAt > 1600 && performance.now() - lastToast > 1500 && inst.changed.size) { lastToast = performance.now(); changeToast(inst, false) }
      }
    } catch (error) {
      if (!inst.dead) console.warn('[doc-viewer] thumbnail', n, error)
    }
  }
  if (!inst.dead && inst.isUpdate) changeToast(inst, true)
}

function pickNext(inst, pending) {
  const pv = inst.pdfViewer
  for (const { id } of pv._getVisiblePages().views) if (pending.has(id)) return id
  if (!sidebar.hidden && sideTab === 'pages') for (const n of [...visibleThumbs].sort((a, b) => a - b)) if (pending.has(n)) return n
  const here = pv.currentPageNumber
  let best = null, dist = Infinity
  for (const n of pending) { const d = Math.abs(n - here); if (d < dist) { dist = d; best = n } }
  return best
}

async function mainIdle(inst) {
  for (let i = 0; i < 40; i++) {
    const { views } = inst.pdfViewer._getVisiblePages()
    if (views.every((v) => v.view.renderingState === RenderingStates.FINISHED || v.view.renderingState === RenderingStates.PAUSED)) break
    await sleep(60)
  }
  await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 120 }) : setTimeout(r, 16)))
}

async function renderThumb(inst, n) {
  const page = await inst.doc.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: THUMB_PX / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_PX
  canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
  const hash = fnv(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  canvas.width = canvas.height = 0
  return { hash, url: URL.createObjectURL(blob), ratio: base.width / base.height }
}

function buildThumbs(inst) {
  const total = inst.doc.numPages
  const items = $$('.thumb', thumbsEl)
  for (let i = items.length; i > total; i--) {
    const img = items[i - 1].querySelector('img')
    if (img) { shownUrls.delete(img.src); URL.revokeObjectURL(img.src) }
    items[i - 1].remove()
  }
  const ratio = (() => { const v = inst.pdfViewer.getPageView(0); return v ? v.width / v.height : 0.707 })()
  thumbObserver?.disconnect()
  visibleThumbs.clear()
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) { const n = Number(e.target.dataset.page); if (e.isIntersecting) visibleThumbs.add(n); else visibleThumbs.delete(n) }
  }, { root: thumbsEl, rootMargin: '200px 0px' })
  for (let n = 1; n <= total; n++) {
    let item = thumbsEl.children[n - 1]
    if (!item) {
      item = el('div', { class: 'thumb', 'data-page': n, role: 'button', 'aria-label': `Page ${n}` },
        el('div', { class: 'thumb-frame', style: `width:${THUMB_W}px;aspect-ratio:${ratio}` }),
        el('span', { class: 'thumb-num', text: String(n) }))
      item.addEventListener('click', () => { goToPage(n, { history: false }); if (app.classList.contains('side-overlay')) setSidebar(false, false) })
      thumbsEl.append(item)
    }
    item.classList.remove('changed')
    thumbObserver.observe(item)
  }
  markCurrentThumb()
}

function showThumb(inst, n) {
  if (inst !== cur) return
  const item = thumbsEl.children[n - 1]
  if (!item) return
  const t = inst.thumbs.get(n)
  const frame = item.firstElementChild
  frame.style.aspectRatio = String(t.ratio)
  let img = frame.querySelector('img')
  if (img && img.src === t.url) return
  const next = el('img', { alt: '', draggable: 'false' })
  next.src = t.url
  shownUrls.add(t.url)
  const swap = () => {
    if (img) { shownUrls.delete(img.src); const stale = img.src; img.replaceWith(next); if (![...inst.thumbs.values()].some((x) => x.url === stale)) URL.revokeObjectURL(stale) }
    else frame.append(next)
  }
  if (next.decode) next.decode().then(swap, swap)
  else swap()
}

function markCurrentThumb() {
  if (!cur) return
  const n = cur.pdfViewer.currentPageNumber
  const prev = $('.thumb.current', thumbsEl)
  const item = thumbsEl.children[n - 1]
  if (prev === item) return
  prev?.classList.remove('current')
  if (!item) return
  item.classList.add('current')
  if (!sidebar.hidden && sideTab === 'pages' && !thumbsEl.matches(':hover')) item.scrollIntoView({ block: 'nearest' })
}

function markChanged(inst, n) {
  thumbsEl.children[n - 1]?.classList.add('changed')
  if (performance.now() - inst.shownAt < 6000) flashPage(inst, n)
}

function flashPage(inst, n) {
  const view = inst.pdfViewer.getPageView(n - 1)
  if (!view?.div || view.div.dataset.flashed === inst.hash) return
  const { ids } = inst.pdfViewer._getVisiblePages()
  if (!ids.has(n)) return
  view.div.dataset.flashed = inst.hash
  view.div.classList.remove('dv-changed')
  void view.div.offsetWidth
  view.div.classList.add('dv-changed')
  setTimeout(() => view.div.classList.remove('dv-changed'), 3000)
}

let changeToastEl = null
function changeToast(inst, final) {
  if (inst !== cur) return
  const total = inst.doc.numPages, before = inst.prevCount
  const changed = inst.changed
  if (!changed.size && total === before) return
  const visible = inst.pdfViewer._getVisiblePages().ids
  const offscreen = [...changed].filter((n) => !visible.has(n)).sort((a, b) => a - b)
  let text
  const delta = total - before
  if (delta && !changed.size) text = `${Math.abs(delta)} page${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'added' : 'removed'}`
  else if (changed.size === 1) text = `Page ${[...changed][0]} updated`
  else text = `Pages ${ranges(changed)} updated`
  const sub = delta && changed.size ? `${Math.abs(delta)} page${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'added' : 'removed'}` : final ? '' : 'checking…'
  const action = offscreen.length === changed.size ? { label: offscreen.length === changed.size && changed.size > 1 ? 'Show first' : 'Show', run: () => goToPage(offscreen[0]) } : null
  changeToastEl = toast({ text, sub, action, ms: action ? 7000 : 3200, replace: changeToastEl, dot: true })
}

// ---------------------------------------------------------------------------------------------
// sidebar
function wantsSidebar() {
  if (!cur) return false
  if (sidebarPref !== null) return sidebarPref
  return stage.parentElement.clientWidth >= 900 && cur.doc.numPages > 1
}
function syncSidebar() {
  const overlay = app.clientWidth < 700
  app.classList.toggle('side-overlay', overlay)
  const open = !presenting && wantsSidebar()
  sidebar.hidden = !open
  $('#sidebar-scrim').hidden = !(open && overlay)
  $('#btn-sidebar').setAttribute('aria-pressed', String(open))
  for (const b of $$('.seg button')) b.setAttribute('aria-selected', String(b.dataset.tab === sideTab))
  thumbsEl.hidden = sideTab !== 'pages'
  outlineEl.hidden = sideTab !== 'outline'
  if (open) { markCurrentThumb(); syncOutline(true) }
}
function setSidebar(open, remember = true) {
  if (remember || app.classList.contains('side-overlay')) sidebarPref = open
  if (remember) store.set('sidebar', open)
  syncSidebar()
}
function setTab(tab) { sideTab = tab; store.set('tab', tab); if (sidebar.hidden) setSidebar(true); else syncSidebar() }
$('#btn-sidebar').addEventListener('click', () => setSidebar(sidebar.hidden))
$('#sidebar-scrim').addEventListener('click', () => setSidebar(false, false))
for (const b of $$('.seg button')) b.addEventListener('click', () => setTab(b.dataset.tab))

// ---------------------------------------------------------------------------------------------
// outline (the PDF's bookmarks; Typst writes one per heading)
let outlineRows = []
async function buildOutline(inst) {
  let items = null
  try { items = await inst.doc.getOutline() } catch { items = null }
  if (inst.dead || inst !== cur) return
  const signature = JSON.stringify(items?.map(function strip(i) { return [i.title, (i.items || []).map(strip)] }) ?? null)
  const openKeys = new Set(outlineRows.filter((r) => r.open).map((r) => r.key))
  const firstBuild = outlineEl.dataset.sig === undefined
  if (outlineEl.dataset.sig === signature) {
    await resolveOutline(inst, items, outlineRows)
    return syncOutline(true)
  }
  outlineEl.dataset.sig = signature
  outlineEl.replaceChildren()
  outlineRows = []
  if (!items?.length) {
    outlineEl.append(el('div', { class: 'ol-empty', text: 'This document has no outline. Headings become bookmarks here when the PDF carries them.' }))
    return
  }
  const count = (list) => list.reduce((s, i) => s + 1 + count(i.items || []), 0)
  const expandAll = count(items) <= 40
  const build = (list, parent, level, prefix) => {
    const box = el('div', { class: 'ol-children' })
    list.forEach((item, i) => {
      const key = prefix + '/' + i + ':' + item.title
      const kids = item.items || []
      const row = { key, item, level, parent, pageNumber: null, y: null, el: null, childrenEl: null, open: false }
      const btn = el('button', { class: `ol-row level-${Math.min(level, 3)}`, style: `padding-left:${4 + level * 14}px`, title: item.title })
      const twisty = el('span', { class: 'twisty', html: kids.length ? icon('twisty') : '' })
      btn.append(twisty, el('span', { class: 'ol-title', text: item.title || '(untitled)' }), el('span', { class: 'ol-page' }))
      btn.addEventListener('click', (e) => {
        if (kids.length && e.target.closest('.twisty')) { toggleRow(row); return }
        openOutlineItem(row)
      })
      btn.addEventListener('dblclick', () => kids.length && toggleRow(row))
      row.el = btn
      outlineRows.push(row)
      box.append(btn)
      if (kids.length) {
        row.childrenEl = build(kids, row, level + 1, key)
        row.open = firstBuild ? expandAll || level === 0 && kids.length <= 12 : openKeys.has(key)
        row.childrenEl.hidden = !row.open
        btn.classList.toggle('open', row.open)
        box.append(row.childrenEl)
      }
    })
    return box
  }
  outlineEl.append(build(items, null, 0, ''))
  await resolveOutline(inst, items, outlineRows)
  syncOutline(true)
}

async function resolveOutline(inst, items, rows) {
  const flat = []
  const walk = (list) => list.forEach((i) => { flat.push(i); walk(i.items || []) })
  walk(items || [])
  await Promise.all(rows.map(async (row, idx) => {
    const item = flat[idx]
    row.item = item
    row.pageNumber = null; row.y = null
    try {
      let dest = item.dest
      if (typeof dest === 'string') dest = await inst.doc.getDestination(dest)
      if (Array.isArray(dest)) {
        const ref = dest[0]
        row.pageNumber = typeof ref === 'object' && ref ? (await inst.doc.getPageIndex(ref)) + 1 : Number.isInteger(ref) ? ref + 1 : null
        if (dest[1]?.name === 'XYZ' && typeof dest[3] === 'number') row.y = dest[3]
      }
    } catch { /* a dangling bookmark */ }
    row.el.querySelector('.ol-page').textContent = row.pageNumber ?? (item.url ? '↗' : '')
  }))
}

function toggleRow(row, open = !row.open) {
  row.open = open
  row.childrenEl.hidden = !open
  row.el.classList.toggle('open', open)
}

function openOutlineItem(row) {
  if (!cur) return
  const { item } = row
  if (item.url) return openExternal(item.url)
  if (item.dest) cur.linkService.goToDestination(item.dest)
  else if (row.pageNumber) goToPage(row.pageNumber)
  if (app.classList.contains('side-overlay')) setSidebar(false, false)
}

let outlineRaf = 0
function scheduleOutlineSync() { cancelAnimationFrame(outlineRaf); outlineRaf = requestAnimationFrame(() => syncOutline(false)) }
function syncOutline(reveal) {
  if (!cur || !outlineRows.length) return
  const pv = cur.pdfViewer
  const { views, ids } = pv._getVisiblePages()
  if (!views.length) return
  const first = Math.min(...ids), readLine = cur.container.clientHeight * 0.3
  let hit = null
  for (const row of outlineRows) {
    if (!row.pageNumber) continue
    let passed
    if (row.pageNumber < first) passed = true
    else if (!ids.has(row.pageNumber)) passed = false
    else {
      const view = pv.getPageView(row.pageNumber - 1)
      const y = row.y == null ? 0 : view.viewport.convertToViewportPoint(0, row.y)[1]
      passed = view.div.offsetTop + y - cur.container.scrollTop <= readLine
    }
    if (passed) hit = row
  }
  if (!hit && outlineRows[0]?.pageNumber === first) hit = outlineRows[0]
  const prev = outlineRows.find((r) => r.el.classList.contains('current'))
  if (prev === hit && !reveal) return
  prev?.el.classList.remove('current')
  if (!hit) return
  hit.el.classList.add('current')
  if (!sidebar.hidden && sideTab === 'outline') {
    for (let p = hit.parent; p; p = p.parent) if (!p.open) toggleRow(p, true)
    if (!outlineEl.matches(':hover')) hit.el.scrollIntoView({ block: 'nearest' })
  }
}

// ---------------------------------------------------------------------------------------------
// find
function openFind() {
  if (!cur || presenting) return
  find.open = true
  findbar.hidden = false
  findInput.focus()
  findInput.select()
  if (findInput.value) dispatchFind('again')
}
function closeFind() {
  if (!find.open) return
  find.open = false
  findbar.hidden = true
  cur?.eventBus.dispatch('findbarclose', { source: null })
  cur?.container.focus({ preventScroll: true })
}
function dispatchFind(type, findPrevious = false) {
  if (!cur) return
  const query = findInput.value
  if (!query) { findCount.textContent = ''; findCount.classList.remove('none') }
  cur.eventBus.dispatch('find', { source: null, type, query, caseSensitive: find.caseSensitive, entireWord: find.entireWord, highlightAll: true, findPrevious, matchDiacritics: false })
}
function renderFindCount({ current, total }) {
  if (!findInput.value) { findCount.textContent = ''; return }
  findCount.classList.toggle('none', total === 0)
  findCount.textContent = total ? `${current} of ${total}${total >= 1000 ? '+' : ''}` : 'No matches'
}
function renderFindState(state, matchesCount) {
  if (!findInput.value) { findCount.textContent = ''; return }
  if (state === FindState.NOT_FOUND) { findCount.classList.add('none'); findCount.textContent = 'No matches' }
  else if (state === FindState.PENDING && !findCount.textContent) findCount.textContent = '…'
  else if (matchesCount) renderFindCount(matchesCount)
}
findInput.addEventListener('input', () => dispatchFind(''))
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); dispatchFind('again', e.shiftKey) }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); dispatchFind('again', e.shiftKey) }
  e.stopPropagation()
})
$('#find-next').addEventListener('click', () => dispatchFind('again', false))
$('#find-prev').addEventListener('click', () => dispatchFind('again', true))
$('#find-close').addEventListener('click', closeFind)
$('#find-case').addEventListener('click', (e) => { find.caseSensitive = !find.caseSensitive; e.currentTarget.setAttribute('aria-pressed', String(find.caseSensitive)); dispatchFind('casesensitivitychange') })
$('#find-word').addEventListener('click', (e) => { find.entireWord = !find.entireWord; e.currentTarget.setAttribute('aria-pressed', String(find.entireWord)); dispatchFind('entirewordchange') })
$('#btn-find').addEventListener('click', () => (find.open ? closeFind() : openFind()))

// ---------------------------------------------------------------------------------------------
// links
async function openExternal(url) {
  const ok = S?.canOpen && await post('/api/open', { kind: 'url', url })
  if (ok) toast({ text: url.startsWith('mailto:') ? `Writing to ${url.slice(7).split('?')[0]}` : `Opened ${hostOf(url)} in your browser`, ms: 2200 })
  else window.open(url, '_blank', 'noopener')
}
const hostOf = (url) => { try { return new URL(url).host || url } catch { return url } }

function onDocClick(e) {
  if (presenting && !e.target.closest('.annotationLayer a')) {
    if (window.getSelection()?.toString()) return
    const rect = stage.getBoundingClientRect()
    return e.clientX < rect.left + rect.width * 0.25 ? prevPage() : nextPage()
  }
  const a = e.target.closest('.annotationLayer a')
  if (!a) return
  const href = a.getAttribute('href') || ''
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault()
    e.stopPropagation()
    openExternal(href)
  } else if (href.startsWith('#')) {
    navHistory.remember()
  }
}

async function onLinkHover(e) {
  const a = e.target.closest?.('.annotationLayer a')
  if (!a || !cur) return
  const href = a.getAttribute('href') || ''
  const status = $('#link-status')
  let text = ''
  if (/^mailto:/i.test(href)) text = 'Email ' + decodeURIComponent(href.slice(7).split('?')[0])
  else if (/^https?:/i.test(href)) text = href
  else if (href.startsWith('#')) {
    text = 'Go to a place in this document'
    try {
      let dest = unescape(href.slice(1))
      try { dest = JSON.parse(dest) } catch { /* a named destination */ }
      if (typeof dest === 'string') dest = await cur.doc.getDestination(dest)
      if (Array.isArray(dest) && typeof dest[0] === 'object') text = `Go to page ${(await cur.doc.getPageIndex(dest[0])) + 1}`
    } catch { /* keep the generic text */ }
  }
  if (!a.matches(':hover')) return
  status.textContent = text
  status.hidden = !text
}
function hideLinkStatus() { $('#link-status').hidden = true }

// ---------------------------------------------------------------------------------------------
// build state: compiling, failed, warnings
function renderBuild() {
  if (!S) return
  const verdict = S.verdict
  const errors = (verdict?.findings ?? []).filter((f) => f.severity === 'error')
  const current = verdict && S.pdf && verdict.mtimeMs >= S.pdf.mtimeMs - 1
  const warnings = current ? verdict.findings.filter((f) => f.severity === 'warning') : []
  const age = S.since ? Date.now() - S.since : 0
  buildPill.className = 'pill'
  buildPill.hidden = false
  busyBar.hidden = true
  buildPill.onclick = null
  if (S.build === 'building' && age < 45_000) {
    buildPill.classList.add('building')
    buildPill.innerHTML = `<span class="spinner"></span><span class="label">Compiling</span>`
    buildPill.dataset.tip = `${S.source?.path ?? 'The source'} changed — waiting for the new PDF`
    busyBar.hidden = !cur
    clearTimeout(renderBuild.t)
    renderBuild.t = setTimeout(renderBuild, 45_000 - age + 50)
    busyBar.hidden = !cur
  } else if (S.build === 'building') {
    buildPill.classList.add('stale')
    buildPill.innerHTML = `<span class="dot"></span><span class="label">Source changed</span>`
    buildPill.dataset.tip = `${S.source?.path ?? 'The source'} changed ${ago(S.since)}; the PDF has not been rebuilt yet`
  } else if (S.build === 'failed') {
    buildPill.classList.add('failed')
    buildPill.innerHTML = `<span class="dot"></span><span class="label">${errors.length > 1 ? errors.length + ' errors' : 'Error'}</span>`
    buildPill.dataset.tip = cur ? 'The last compile failed — the page shows the last good PDF' : 'The last compile failed'
    buildPill.onclick = () => { errorHiddenFor = errorHiddenFor === S.since ? null : S.since; renderBuild() }
  } else if (warnings.length) {
    buildPill.classList.add('warnings')
    buildPill.innerHTML = `<span class="dot"></span><span class="label">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`
    buildPill.dataset.tip = 'Typst compiled with warnings'
    buildPill.onclick = () => openMenu(buildPill, warnings.map((w) => ({ label: w.message, sub: w.ref ?? '', tall: true, run: () => {} })), { align: 'right' })
  } else {
    buildPill.hidden = true
  }
  // The error card: over the last good pages, or in place of the empty state.
  if (S.build === 'failed' && cur) {
    errorCard.hidden = errorHiddenFor === S.since
    if (!errorCard.hidden) errorCard.replaceChildren(...errorContent(errors, true))
  } else {
    errorCard.hidden = true
  }
  if (!cur) renderEmpty()
}

function errorContent(errors, floating) {
  const head = el('div', { class: 'ec-head' },
    el('span', { class: 'badge' }, el('span', { class: 'dot' }), errors.length > 1 ? `${errors.length} errors` : 'Compile failed'),
    el('span', { class: 'sub', text: cur ? `showing the last good PDF · built ${ago(cur.mtimeMs)}` : S.verdict?.summary ?? '' }),
    floating ? el('button', { class: 'card-btn', text: 'Hide', onclick: () => { errorHiddenFor = S.since; renderBuild() } }) : null)
  const body = el('div', { class: 'ec-body' })
  errors.slice(0, 6).forEach((f) => body.append(errorItem(f)))
  if (errors.length > 6) body.append(el('div', { class: 'ec-more', text: `+ ${errors.length - 6} more` }))
  return [head, body]
}

function errorItem(f) {
  const item = el('div', { class: 'ec-item' }, el('div', { class: 'ec-msg', text: f.message }))
  if (f.ref) item.append(el('div', { class: 'ec-ref', text: f.ref }))
  const sn = f.snippet
  if (sn) {
    const code = el('div', { class: 'ec-code' })
    for (const { n, text } of sn.lines) {
      code.append(el('div', { class: 'ln' + (n === sn.line ? ' hit' : '') }, el('span', { class: 'n', text: String(n) }), el('span', { text: text || ' ' })))
      if (n === sn.line) {
        // Typst reports a 0-based column; underline the token that starts there.
        const rest = text.slice(sn.col)
        const m = /^("[^"]*"?|[\p{L}\p{N}_.-]+|\S)/u.exec(rest)
        const len = Math.max(1, m ? m[0].length : 1)
        code.append(el('div', { class: 'ln' }, el('span', { class: 'n', text: '' }), el('span', { class: 'caret', text: ' '.repeat(Math.min(sn.col, text.length)) + '^'.repeat(len) })))
      }
    }
    item.append(code)
  }
  for (const h of f.hints ?? []) item.append(el('div', { class: 'ec-hint', text: h }))
  return item
}

// ---------------------------------------------------------------------------------------------
// empty state
function renderEmpty(extra = {}) {
  if (cur) { emptyEl.hidden = true; return }
  app.classList.add('no-doc')
  emptyEl.hidden = false
  const art = el('div', { class: 'empty-art' },
    el('div', { class: 'sheet back' }, el('div', { class: 'bar h' }), el('div', { class: 'bar' }), el('div', { class: 'bar' }), el('div', { class: 'bar s' })),
    el('div', { class: 'sheet front' }, el('div', { class: 'bar h' }), el('div', { class: 'bar' }), el('div', { class: 'bar' }), el('div', { class: 'bar s' }), el('div', { class: 'bar' }), el('div', { class: 'bar s' })))
  const want = S?.file ?? (requested || null)
  const inner = el('div', { class: 'empty-inner' })
  if (S?.build === 'failed') {
    const errors = (S.verdict?.findings ?? []).filter((f) => f.severity === 'error')
    emptyEl.replaceChildren(el('div', { class: 'empty-error' }, el('div', { class: 'ec-card' }, ...errorContent(errors, false)),
      el('div', { class: 'empty-foot', text: 'The document appears here as soon as it compiles.' })))
    return
  }
  if (extra.unreadable) {
    inner.append(art, el('div', { class: 'empty-title', text: 'This PDF could not be opened' }), el('div', { class: 'empty-text', text: extra.unreadable }))
  } else if (S?.build === 'building' && Date.now() - S.since < 45_000) {
    inner.classList.add('building')
    inner.append(art, el('div', { class: 'empty-title', text: 'Compiling…' }),
      el('div', { class: 'empty-text', text: `${S.source?.path ?? 'The source'} changed. The document appears here the moment the PDF is written.` }))
    if (want) inner.append(el('div', { class: 'empty-meta', html: `<span class="spinner"></span> waiting for <code>${escapeHtml(want)}</code>` }))
  } else {
    inner.append(art, el('div', { class: 'empty-title', text: 'No document yet' }),
      el('div', { class: 'empty-text', text: 'Ask the agent for a paper, a spec sheet, a report or a letter. The PDF appears here as soon as it compiles, and updates live on every save.' }))
    const waiting = S?.build === 'building' && S.source ? `${icon('file')} <code>${escapeHtml(S.source.path)}</code> is not compiled yet` : null
    inner.append(el('div', { class: 'empty-meta', html: waiting ?? (want ? `${icon('file')} watching <code>${escapeHtml(want)}</code>` : `${icon('folder')} watching <code>${escapeHtml(S?.workspace ?? 'the workspace')}</code> for PDFs`) }))
    inner.append(el('div', { class: 'empty-tips' },
      el('div', { html: `<kbd>${MOD}F</kbd> find in the document` }),
      el('div', { html: '<kbd>S</kbd> pages and outline' }),
      el('div', { html: '<kbd>?</kbd> every shortcut' })))
  }
  emptyEl.replaceChildren(inner)
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// ---------------------------------------------------------------------------------------------
// title and file switcher
function renderTitle() {
  const text = $('.title-text', titleBtn)
  const multi = (S?.pdfs?.length ?? 0) > 1
  const path = cur?.path ?? S?.file ?? ''
  text.textContent = cur ? (cur.title || baseName(path)) : (path ? baseName(path) : 'Doc Viewer')
  $('.title-caret', titleBtn).hidden = !multi
  titleBtn.classList.toggle('switchable', multi)
  titleBtn.dataset.tip = cur ? `${path} · ${cur.doc.numPages} page${cur.doc.numPages === 1 ? '' : 's'} · ${fmtBytes(cur.size)} · built ${ago(cur.mtimeMs)}` : path
  document.title = cur ? `${text.textContent} — Doc Viewer` : 'Doc Viewer'
}
titleBtn.addEventListener('click', () => {
  if (!S || (S.pdfs?.length ?? 0) < 2) return
  openMenu(titleBtn, [{ head: 'PDFs in this workspace' }, ...S.pdfs.map((p) => ({
    label: baseName(p.path), sub: `${p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/') + 1) + ' · ' : ''}${ago(p.mtimeMs)}`, tall: true,
    checked: p.path === (cur?.path ?? S.file), run: () => switchFile(p.path),
  }))])
})
function switchFile(path) {
  if (path === cur?.path) return
  requested = path
  const url = new URL(location.href)
  url.searchParams.set('file', path)
  history.replaceState(null, '', url)
  restoreOnce = true
  navHistory.stack = []
  renderBackChip(false)
  connect()
}

// ---------------------------------------------------------------------------------------------
// menus, tooltips, toasts, help
const menuEl = $('#menu')
let menuFor = null
function openMenu(anchor, items, { align = 'auto' } = {}) {
  if (menuFor === anchor && !menuEl.hidden) return closeMenu()
  menuEl.replaceChildren()
  hideTip()
  for (const item of items) {
    if (item === '-') { menuEl.append(el('div', { class: 'm-sep' })); continue }
    if (item.head) { menuEl.append(el('div', { class: 'm-head', text: item.head })); continue }
    const b = el('button', { class: 'mi' + (item.tall ? ' tall' : ''), role: 'menuitem', disabled: item.disabled })
    b.append(el('span', { class: 'check', html: item.checked ? icon('check') : '' }))
    if (item.icon) b.append(el('span', { class: 'mi-icon', html: icon(item.icon) }))
    const label = el('span', { class: 'mi-label' }, el('span', { text: item.label }))
    if (item.sub) label.append(el('span', { class: 'mi-sub', text: item.sub }))
    b.append(label)
    if (item.key) b.append(el('span', { class: 'mi-key', text: item.key }))
    b.addEventListener('click', () => { closeMenu(); item.run?.() })
    menuEl.append(b)
  }
  menuEl.hidden = false
  menuFor = anchor
  const r = anchor.getBoundingClientRect(), m = menuEl.getBoundingClientRect()
  let left = align === 'right' || r.left + m.width > innerWidth - 8 ? r.right - m.width : r.left
  left = clamp(left, 8, innerWidth - m.width - 8)
  menuEl.style.left = left + 'px'
  menuEl.style.top = Math.min(r.bottom + 6, innerHeight - m.height - 8) + 'px'
}
function closeMenu() { menuEl.hidden = true; menuFor = null }
document.addEventListener('pointerdown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target) && !menuFor?.contains(e.target)) closeMenu() }, true)
menuEl.addEventListener('keydown', (e) => {
  const items = $$('.mi:not(:disabled)', menuEl)
  const i = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
  else if (e.key === 'Escape') { e.preventDefault(); closeMenu() }
})

const tipEl = $('#tooltip')
let tipTimer = null, tipFor = null
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest?.('[data-tip]')
  if (t === tipFor) return
  hideTip()
  if (!t || !menuEl.hidden) return
  tipFor = t
  tipTimer = setTimeout(() => {
    if (!t.isConnected || !t.dataset.tip) return
    tipEl.replaceChildren(el('span', { text: t.dataset.tip }), t.dataset.key ? el('span', { class: 'k', text: t.dataset.key }) : null)
    tipEl.hidden = false
    const r = t.getBoundingClientRect(), m = tipEl.getBoundingClientRect()
    tipEl.style.left = clamp(r.left + r.width / 2 - m.width / 2, 6, innerWidth - m.width - 6) + 'px'
    tipEl.style.top = (r.bottom + 6 + m.height > innerHeight ? r.top - m.height - 6 : r.bottom + 6) + 'px'
  }, 550)
})
document.addEventListener('pointerdown', hideTip, true)
function hideTip() { clearTimeout(tipTimer); tipTimer = null; tipFor = null; tipEl.hidden = true }

function toast({ text, sub = '', action = null, ms = 3000, replace = null, dot = false, tone = '' }) {
  const host = $('#toasts')
  const node = el('div', { class: 'toast' + (action ? '' : ' no-action') })
  if (dot || tone) node.append(el('span', { class: 't-dot', style: tone === 'danger' ? 'background:var(--danger)' : '' }))
  node.append(el('span', { class: 't-text' }, text, sub ? el('span', { class: 't-sub', text: ' · ' + sub }) : null))
  if (action) node.append(el('button', { text: action.label, onclick: () => { action.run(); dismiss(node) } }))
  if (replace?.isConnected) replace.replaceWith(node)
  else host.append(node)
  while (host.children.length > 3) host.firstElementChild.remove()
  clearTimeout(node._t)
  node._t = setTimeout(() => dismiss(node), ms)
  node.addEventListener('pointerenter', () => clearTimeout(node._t))
  node.addEventListener('pointerleave', () => { node._t = setTimeout(() => dismiss(node), 1800) })
  return node
}
function dismiss(node) {
  if (!node.isConnected) return
  node.classList.add('leaving')
  setTimeout(() => node.remove(), 200)
}

const SHORTCUTS = [
  ['Move around', [
    ['Next / previous page', ['→', '←']],
    ['First / last page', ['Home', 'End']],
    ['Go to page…', ['G']],
    ['Back after following a link', [`${MOD}[`]],
    ['Scroll', ['Space', '⇧Space']],
  ]],
  ['Zoom', [
    ['Zoom in / out', [`${MOD}+`, `${MOD}−`]],
    ['Actual size', [`${MOD}1`]],
    ['Fit width', [`${MOD}2`]],
    ['Fit page', [`${MOD}0`]],
    ['Zoom at the pointer', ['pinch', `${MOD}scroll`]],
  ]],
  ['Find', [
    ['Find in document', [`${MOD}F`, '/']],
    ['Next / previous match', ['↵', '⇧↵']],
    ['Close find', ['Esc']],
  ]],
  ['View', [
    ['Sidebar', ['S']],
    ['Pages / outline', ['T', 'O']],
    ['Continuous / two pages', ['D']],
    ['Present', ['F']],
    ['Shortcuts', ['?']],
  ]],
]
function openHelp() {
  closeMenu()
  const body = $('#help-body')
  body.replaceChildren(...SHORTCUTS.map(([title, rows]) => el('div', { class: 'hk-group' }, el('h3', { text: title }),
    ...rows.map(([label, keys]) => el('div', { class: 'hk' }, el('span', { text: label }), el('span', { class: 'keys' }, ...keys.map((k) => el('kbd', { text: k }))))))))
  $('#help').hidden = false
  $('#help-close').focus()
}
function closeHelp() { $('#help').hidden = true }
$('#help-close').addEventListener('click', closeHelp)
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') closeHelp() })

// ---------------------------------------------------------------------------------------------
// toolbar menus
zoomBtn.addEventListener('click', () => {
  if (!cur) return
  const s = Math.round(cur.pdfViewer.currentScale * 100)
  openMenu(zoomBtn, [
    { label: 'Automatic', checked: zoom.mode === 'auto', run: () => setZoom('auto') },
    { label: 'Fit width', key: `${MOD}2`, checked: zoom.mode === 'width', run: () => setZoom('width') },
    { label: 'Fit page', key: `${MOD}0`, checked: zoom.mode === 'page', run: () => setZoom('page') },
    { label: 'Actual size', key: `${MOD}1`, checked: zoom.mode === 'actual', run: () => setZoom('actual') },
    '-',
    ...[50, 75, 100, 125, 150, 200, 300, 400].map((p) => ({ label: p + '%', checked: zoom.mode === 'custom' && s === p, run: () => setZoom('custom', p / 100) })),
  ], { align: 'right' })
})
$('#btn-zoom-in').addEventListener('click', () => zoomStep(1))
$('#btn-zoom-out').addEventListener('click', () => zoomStep(-1))
$('#btn-present').addEventListener('click', () => (presenting ? exitPresent() : enterPresent()))

const inBrowser = /Safari\/|Chrome\/|Firefox\//.test(navigator.userAgent)
$('#btn-more').addEventListener('click', () => {
  const path = cur?.path ?? S?.file
  const items = [
    { head: 'Layout' },
    { label: 'Continuous', icon: 'continuous', checked: layout === 'continuous', run: () => setLayout('continuous') },
    { label: 'Single page', icon: 'single', checked: layout === 'single', run: () => setLayout('single') },
    { label: 'Two pages', key: 'D', icon: 'two', checked: layout === 'two', run: () => setLayout('two') },
    { label: 'Two pages, cover alone', icon: 'book', checked: layout === 'book', run: () => setLayout('book') },
    '-',
    { label: 'Present', key: 'F', icon: 'present', disabled: !cur, run: enterPresent },
    { label: sidebar.hidden ? 'Show sidebar' : 'Hide sidebar', key: 'S', icon: 'sidebar', disabled: !cur, run: () => setSidebar(sidebar.hidden) },
    '-',
    { head: 'Appearance' },
    { label: 'Light', icon: 'sun', checked: theme === 'light', run: () => setTheme('light') },
    { label: 'Dark', icon: 'moon', checked: theme === 'dark', run: () => setTheme('dark') },
    { label: 'Match system', icon: 'monitor', checked: theme === 'auto', run: () => setTheme('auto') },
    '-',
  ]
  if (S?.canOpen) {
    items.push({ label: 'Open in default app', sub: 'to print or annotate', tall: true, icon: 'external', disabled: !path, run: () => openFile('open') })
    items.push({ label: isMac ? 'Show in Finder' : 'Show in folder', icon: 'folder', disabled: !path, run: () => openFile('reveal') })
  }
  if (inBrowser) {
    items.push({ label: 'Download PDF', icon: 'download', disabled: !path, run: download })
    items.push({ label: 'Print…', key: `${MOD}P`, icon: 'print', disabled: !path, run: printDoc })
  }
  items.push({ label: 'Copy file path', icon: 'copy', disabled: !path, run: () => copyText(path) })
  items.push('-', { label: 'Keyboard shortcuts', key: '?', icon: 'keyboard', run: openHelp })
  openMenu($('#btn-more'), items, { align: 'right' })
})
function setTheme(t) { theme = t; store.set('theme', t); applyTheme() }
async function openFile(kind) {
  const path = cur?.path ?? S?.file
  if (!path) return
  const ok = await post('/api/open', { kind, path })
  toast({ text: ok ? (kind === 'reveal' ? `Showing ${baseName(path)}` : `Opened ${baseName(path)}`) : 'Could not open it here', ms: 2200 })
}
function download() {
  const path = cur?.path ?? S?.file
  if (!path) return
  const a = el('a', { href: '/ws/' + encodePath(path) + '?download=1', download: baseName(path) })
  document.body.append(a); a.click(); a.remove()
}
function printDoc() {
  const path = cur?.path ?? S?.file
  if (!path) return
  if (!inBrowser && S?.canOpen) return openFile('open')
  const frame = el('iframe', { style: 'position:fixed;width:0;height:0;border:0;right:0;bottom:0', src: '/ws/' + encodePath(path) })
  frame.addEventListener('load', () => { try { frame.contentWindow.print() } catch { window.open(frame.src) } setTimeout(() => frame.remove(), 60_000) })
  document.body.append(frame)
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast({ text: 'Copied', sub: text, ms: 1800 }) } catch { toast({ text: text, ms: 3000 }) }
}

// ---------------------------------------------------------------------------------------------
// present
let presentSaved = null, hudTimer = null, wheelAcc = 0, wheelLock = 0
function enterPresent() {
  if (!cur || presenting) return
  closeFind(); closeMenu(); closeHelp()
  presentSaved = { page: cur.pdfViewer.currentPageNumber }
  presenting = true
  app.classList.add('presenting')
  syncSidebar()
  renderBackChip(false)
  applyLayout()
  applyZoom(cur, { keepPlace: false })
  cur.pdfViewer.currentPageNumber = presentSaved.page
  updatePageUI()
  pokeHud()
  document.documentElement.requestFullscreen?.().catch(() => {})
  cur.container.focus({ preventScroll: true })
}
function exitPresent() {
  if (!presenting) return
  const page = cur?.pdfViewer.currentPageNumber
  presenting = false
  app.classList.remove('presenting', 'hud-hidden')
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  applyLayout()
  syncSidebar()
  applyZoom(cur, { keepPlace: false })
  if (page) goToPage(page, { history: false })
}
function pokeHud() {
  if (!presenting) return
  app.classList.remove('hud-hidden')
  clearTimeout(hudTimer)
  hudTimer = setTimeout(() => app.classList.add('hud-hidden'), 1800)
}
function presentWheel(dy) {
  const now = performance.now()
  if (now < wheelLock) return
  wheelAcc += dy
  if (Math.abs(wheelAcc) > 40) { wheelAcc > 0 ? nextPage() : prevPage(); wheelAcc = 0; wheelLock = now + 380 }
}
stage.addEventListener('pointermove', () => presenting && pokeHud())
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && presenting) exitPresent() })
$('#hud-prev').addEventListener('click', (e) => { e.stopPropagation(); prevPage() })
$('#hud-next').addEventListener('click', (e) => { e.stopPropagation(); nextPage() })
$('#hud-exit').addEventListener('click', (e) => { e.stopPropagation(); exitPresent() })

// ---------------------------------------------------------------------------------------------
// keyboard
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  const key = e.key
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
  if (!$('#help').hidden) { if (key === 'Escape' || key === '?') { e.preventDefault(); closeHelp() } return }
  if (!menuEl.hidden && key === 'Escape') { e.preventDefault(); closeMenu(); return }
  if (mod && key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return }
  if (mod && key.toLowerCase() === 'g') { e.preventDefault(); if (!find.open) openFind(); else dispatchFind('again', e.shiftKey); return }
  if (typing) return
  if (presenting) {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'j', 'n'].includes(key) && !(key === ' ' && e.shiftKey)) { e.preventDefault(); nextPage(); pokeHud(); return }
    if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'k', 'p'].includes(key) || (key === ' ' && e.shiftKey)) { e.preventDefault(); prevPage(); pokeHud(); return }
    if (key === 'Home') { e.preventDefault(); goToPage(1, { history: false }); return }
    if (key === 'End') { e.preventDefault(); goToPage(cur.doc.numPages, { history: false }); return }
    if (key === 'Escape' || key === 'f' || key === 'q') { e.preventDefault(); exitPresent(); return }
    return
  }
  if (key === 'Escape') { if (find.open) { e.preventDefault(); closeFind() } else if (app.classList.contains('side-overlay') && !sidebar.hidden) setSidebar(false, false); return }
  if (!cur) { if (key === '?') { e.preventDefault(); openHelp() } return }
  if (mod) {
    if (key === '=' || key === '+') { e.preventDefault(); zoomStep(1) }
    else if (key === '-' || key === '_') { e.preventDefault(); zoomStep(-1) }
    else if (key === '0') { e.preventDefault(); setZoom('page') }
    else if (key === '1') { e.preventDefault(); setZoom('actual') }
    else if (key === '2') { e.preventDefault(); setZoom('width') }
    else if (key === '[') { e.preventDefault(); goBack() }
    else if (key === 'p') { e.preventDefault(); printDoc() }
    else if (key === 'ArrowUp') { e.preventDefault(); goToPage(1, { history: false }) }
    else if (key === 'ArrowDown') { e.preventDefault(); goToPage(cur.doc.numPages, { history: false }) }
    return
  }
  if (e.altKey) {
    if (key === 'ArrowLeft') { e.preventDefault(); goBack() }
    return
  }
  const horizontal = cur.container.scrollWidth > cur.container.clientWidth + 1
  switch (key) {
    case 'ArrowRight': if (!horizontal) { e.preventDefault(); nextPage() } break
    case 'ArrowLeft': if (!horizontal) { e.preventDefault(); prevPage() } break
    case 'PageDown': if (layout === 'single') { e.preventDefault(); nextPage() } break
    case 'PageUp': if (layout === 'single') { e.preventDefault(); prevPage() } break
    case 'n': case 'j': e.preventDefault(); nextPage(); break
    case 'p': case 'k': e.preventDefault(); prevPage(); break
    case 'Home': e.preventDefault(); goToPage(1, { history: false }); break
    case 'End': e.preventDefault(); goToPage(cur.doc.numPages, { history: false }); break
    case 'g': e.preventDefault(); pageInput.focus(); break
    case '/': e.preventDefault(); openFind(); break
    case '+': case '=': e.preventDefault(); zoomStep(1); break
    case '-': e.preventDefault(); zoomStep(-1); break
    case 's': e.preventDefault(); setSidebar(sidebar.hidden); break
    case 't': e.preventDefault(); setTab('pages'); break
    case 'o': e.preventDefault(); setTab('outline'); break
    case 'd': e.preventDefault(); setLayout(layout === 'two' || layout === 'book' ? 'continuous' : 'two'); break
    case 'f': e.preventDefault(); enterPresent(); break
    case '?': e.preventDefault(); openHelp(); break
    default: {
      // Scroll the document with the keyboard even when focus sits on the chrome.
      if (cur.container.contains(document.activeElement)) break
      const page = cur.container.clientHeight * 0.9
      const dy = { ' ': e.shiftKey ? -page : page, PageDown: page, PageUp: -page, ArrowDown: 48, ArrowUp: -48 }[key]
      if (dy === undefined) break
      e.preventDefault()
      cur.container.scrollBy({ top: dy, behavior: Math.abs(dy) > 48 ? 'smooth' : 'auto' })
      cur.container.focus({ preventScroll: true })
    }
  }
})

// Clicks on the page area give it focus, so arrows and Space scroll it.
stage.addEventListener('pointerdown', (e) => { if (cur && e.target.closest('.viewerContainer') && document.activeElement === document.body) cur.container.focus({ preventScroll: true }) })

// ---------------------------------------------------------------------------------------------
// go
connect()
setInterval(() => { if (S && (S.build !== 'idle' || cur)) { renderTitle() } }, 30_000)
// For tests and debugging: a read-only look at the reader.
Object.defineProperty(window, 'docViewer', { value: {
  get state() { return S },
  get page() { return cur?.pdfViewer.currentPageNumber ?? null },
  get pages() { return cur?.doc.numPages ?? 0 },
  get scale() { return cur?.pdfViewer.currentScale ?? null },
  get scrollTop() { return cur?.container.scrollTop ?? null },
  get changed() { return cur ? [...cur.changed].sort((a, b) => a - b) : [] },
  get hash() { return cur?.hash ?? null },
  get thumbsDone() { return cur ? cur.thumbs.size : 0 },
  get zoomMode() { return zoom.mode },
  get layout() { return layout },
  get build() { return MODERN ? 'modern' : 'legacy' },
} })
