// The Excalidraw pane. Excalidraw renders the canvas (view mode); this script owns everything around
// it: the file, the view (fit, zoom, follow), the outline, presenting frame by frame, export, theme,
// and the live link to the workspace. Plain DOM beside one React root, no build step.
(() => {
  'use strict'
  const { Excalidraw, exportToBlob, exportToSvg, getCommonBounds, restoreElements } = window.ExcalidrawLib
  const h = React.createElement
  const $ = (id) => document.getElementById(id)

  // ---------------------------------------------------------------- icons (drawn for this pane)
  const ICONS = {
    doc: '<path d="M6 2.5h5l3.5 3.5v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V4A1.5 1.5 0 0 1 6 2.5z"/><path d="M11 2.5V6h3.5"/>',
    chevron: '<path d="M5 7.5l5 5 5-5"/>',
    list: '<path d="M7.5 5h9M7.5 10h9M7.5 15h9"/><circle cx="4" cy="5" r=".9"/><circle cx="4" cy="10" r=".9"/><circle cx="4" cy="15" r=".9"/>',
    minus: '<path d="M5 10h10"/>',
    plus: '<path d="M10 5v10M5 10h10"/>',
    fit: '<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13"/><rect x="7" y="7.5" width="6" height="5" rx="1"/>',
    play: '<path d="M6.5 4.5v11l9-5.5z"/>',
    download: '<path d="M10 3v9.5M6 8.5l4 4 4-4M4 16.5h12"/>',
    moon: '<path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z"/>',
    sun: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3"/>',
    search: '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.2 12.2L16.5 16.5"/>',
    left: '<path d="M12.5 4.5L7 10l5.5 5.5"/>',
    right: '<path d="M7.5 4.5L13 10l-5.5 5.5"/>',
    close: '<path d="M5 5l10 10M15 5L5 15"/>',
    expand: '<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5L11.5 8.5M3.5 16.5l5-5"/>',
    laser: '<circle cx="6" cy="14" r="2.2"/><path d="M8 12l7.5-7.5M12.5 3.5h3v3"/>',
    image: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M3.5 14.5l4-4 3 3 2-2 4 4"/>',
    code: '<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>',
    copy: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/>',
    arrow: '<path d="M3 10h13M12 6l4 4-4 4"/>',
    check: '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>',
  }
  const svg = (name) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ''}</svg>`
  const paintIcons = (root = document) => root.querySelectorAll('i[data-icon]').forEach((i) => { i.innerHTML = svg(i.dataset.icon) })
  paintIcons()

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('harness.excalidraw.' + key); return v == null ? fallback : JSON.parse(v) } catch { return fallback } },
    set(key, value) { try { localStorage.setItem('harness.excalidraw.' + key, JSON.stringify(value)) } catch { /* private mode */ } },
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  // ---------------------------------------------------------------- state
  const params = new URLSearchParams(location.search)
  const S = {
    file: params.get('file') || '',
    api: null, root: null,
    data: null,              // the last scene that parsed
    theme: store.get('theme', 'light'),
    follow: true,            // refit after each save until the reader moves the view
    view: null,              // the view this script last set, to tell the reader's moves from ours
    anim: 0,                 // requestAnimationFrame id of a running fly
    keys: new Set(),         // content keys of the scene on screen, to spot what a save changed
    present: -1, steps: [], laser: false,
    rings: [],               // [{el, id}] rings to keep aligned while they fade
    retry: 0,
  }

  // ---------------------------------------------------------------- reading the file
  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')
  async function fetchScene(path) {
    const res = await fetch('/' + encodePath(path) + '?t=' + Date.now(), { cache: 'no-store' })
    if (res.status === 404) throw Object.assign(new Error(`${path} is not there yet`), { missing: true })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (!text.trim()) throw Object.assign(new Error('the file is empty'), { partial: true })
    let data
    try { data = JSON.parse(text) } catch { throw Object.assign(new Error('the file is not valid JSON'), { partial: true }) }
    if (!data || data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('the file is not an Excalidraw scene')
    return data
  }
  async function listFiles() {
    try { return (await (await fetch('/files.json', { cache: 'no-store' })).json()).files || [] } catch { return [] }
  }

  const live = (els) => els.filter((e) => e && !e.isDeleted)
  const round = (n) => Math.round((n || 0) * 10) / 10
  // What an element looks like, without its id: scene.py mints fresh ids on every run, so a
  // regenerated diagram would otherwise read as all-new.
  const contentKey = (e) => [e.type, round(e.x), round(e.y), round(e.width), round(e.height), e.text ?? '', e.strokeColor, e.backgroundColor, e.strokeStyle, e.name ?? '', JSON.stringify(e.points ?? '')].join('|')

  function describe(elements) {
    const count = (t) => elements.filter((e) => e.type === t).length
    const shapes = count('rectangle') + count('ellipse') + count('diamond')
    const bits = [plural(shapes, 'shape'), plural(count('arrow'), 'arrow')]
    const frames = count('frame') + count('magicframe')
    if (frames) bits.push(plural(frames, 'frame'))
    $('meta').textContent = bits.join(' · ')
    $('fileName').textContent = S.file ? S.file.split('/').pop() : 'No diagram'
  }

  function showEmpty(title, text) {
    $('emptyTitle').textContent = title
    $('emptyText').innerHTML = text
    $('empty').hidden = false
  }

  async function load({ first = false } = {}) {
    if (!S.file) {
      const files = await listFiles()
      if (files.length) { S.file = files[0].path; setUrl() } else {
        describe([]); $('meta').textContent = ''
        showEmpty('Waiting for the first stroke', 'Ask the agent for a diagram. It writes an <code>.excalidraw</code> file in this workspace, and every save draws in here: boxes first, then arrows, then frames.')
        return
      }
    }
    let data
    try {
      data = await fetchScene(S.file)
    } catch (error) {
      if (error.partial && S.retry < 6) { S.retry++; setTimeout(() => load({ first }), 250); return }
      S.retry = 0
      if (S.data) { toast(`Could not read the latest save (${error.message}); showing the previous one.`, { warn: true, ms: 5000 }); return }
      if (error.missing) {
        const files = (await listFiles()).filter((f) => f.path !== S.file)
        if (files.length) { S.file = files[0].path; setUrl(); return load({ first: true }) }
        describe([])
        showEmpty('Waiting for the first stroke', `The agent has not written <code>${esc(S.file)}</code> yet. It appears here with the first save, and redraws on every one after.`)
      } else {
        showEmpty('This file does not open as a diagram', `<code>${esc(S.file)}</code>: ${esc(error.message)}. The agent's next save will replace this message.`)
      }
      return
    }
    S.retry = 0
    $('empty').hidden = true
    apply(data, { first: first || !S.data })
  }

  // ---------------------------------------------------------------- the canvas
  function sceneAppState(data) {
    const a = data.appState || {}
    return { viewBackgroundColor: a.viewBackgroundColor || '#ffffff' }
  }

  function renderApp(initial) {
    const props = {
      viewModeEnabled: true, zenModeEnabled: true, gridModeEnabled: false, theme: S.theme,
      detectScroll: true, handleKeyboardGlobally: false, autoFocus: false,
      UIOptions: { canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false } },
      excalidrawAPI: (api) => { if (api && !S.api) { S.api = api; onReady() } },
      onChange: onCanvasChange,
    }
    if (initial) props.initialData = initial
    S.root.render(h(Excalidraw, props))
  }

  let pendingFirst = null
  // Excalidraw measures and caches text as it first draws it; a label drawn before Virgil arrives
  // stays in the fallback serif. Load the faces first (they are local, this takes milliseconds).
  let fontsReady = null
  function loadFonts() {
    const faces = ['20px Virgil', '20px Cascadia', '20px Assistant']
    const all = Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null)))
    return Promise.race([all, new Promise((ok) => setTimeout(ok, 2500))])
  }
  function apply(data, { first }) {
    const elements = live(data.elements)
    describe(elements)
    S.data = data
    if (!S.root) {
      if (!fontsReady) { fontsReady = loadFonts(); }
      if (fontsReady !== true) { fontsReady.then(() => { fontsReady = true; apply(S.data, { first: true }) }); return }
      S.root = ReactDOM.createRoot($('app'))
      pendingFirst = true
      S.keys = new Set(elements.map(contentKey))
      renderApp({ elements, appState: { ...sceneAppState(data), zenModeEnabled: true }, files: data.files || {}, scrollToContent: false })
      return
    }
    // A save that lands before the canvas is ready is applied when it is (see onReady).
    if (!S.api) { S.pendingData = data; return }
    const previous = S.keys
    S.keys = new Set(elements.map(contentKey))
    // restoreElements is what initialData goes through: it re-measures labels in their boxes with
    // the loaded font, so a save lands looking exactly like a fresh open.
    let next = elements
    try { next = restoreElements(elements, null, { refreshDimensions: true, repairBindings: true }) } catch { /* show as written */ }
    S.api.updateScene({ elements: next, appState: sceneAppState(data) })
    if (data.files) S.api.addFiles(Object.values(data.files))
    rebuildSteps()
    renderOutline()
    reinspect()
    if (first) { fit({ animate: false }); return }
    // What this save changed: new or altered elements, a label pointing at its box or arrow.
    const byId = new Map(elements.map((e) => [e.id, e]))
    const touched = new Map()
    for (const e of elements) {
      if (previous.has(contentKey(e))) continue
      const target = e.containerId && byId.get(e.containerId) ? byId.get(e.containerId) : e
      if (target.type === 'frame' && previous.size) continue
      touched.set(target.id, target)
    }
    pulseLive()
    const changed = [...touched.values()]
    if (S.present >= 0) { goStep(Math.min(S.present, S.steps.length - 1), { animate: false }); ringAll(changed); return }
    if (S.follow) {
      fit({ animate: true, then: () => ringAll(changed) })
    } else {
      ringAll(changed)
      const hidden = changed.filter((e) => !inView(e)).length
      if (hidden) toast(`${plural(hidden, 'change')} outside your view`, { action: 'Fit', run: () => fit({ animate: true }) })
    }
  }

  function onReady() {
    const wait = () => {
      const a = S.api.getAppState()
      if (!a.width || !a.height) { requestAnimationFrame(wait); return }
      rebuildSteps(); renderOutline()
      if (pendingFirst) { pendingFirst = null; fit({ animate: false }) }
      if (S.pendingData) { const d = S.pendingData; S.pendingData = null; apply(d, { first: false }) }
    }
    requestAnimationFrame(wait)
  }

  // ---------------------------------------------------------------- the view
  const MIN_ZOOM = 0.1, MAX_ZOOM = 30
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  function viewport() { const a = S.api.getAppState(); return { w: a.width, h: a.height, zoom: a.zoom.value, sx: a.scrollX, sy: a.scrollY } }
  function centerOf(v) { return { cx: v.w / 2 / v.zoom - v.sx, cy: v.h / 2 / v.zoom - v.sy } }
  function setView(cx, cy, zoom) {
    const { w, h } = viewport()
    const view = { scrollX: w / 2 / zoom - cx, scrollY: h / 2 / zoom - cy, zoom: { value: zoom } }
    S.view = { sx: view.scrollX, sy: view.scrollY, zoom }
    S.api.updateScene({ appState: view })
    updateZoomLabel(zoom)
  }
  function flyTo(cx, cy, zoom, { animate = true, duration = 460, then } = {}) {
    cancelAnimationFrame(S.anim)
    const from = centerOf(viewport()), z0 = viewport().zoom
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { setView(cx, cy, zoom); then?.(); return }
    const t0 = performance.now()
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const step = (now) => {
      const t = clamp((now - t0) / duration, 0, 1), k = ease(t)
      const z = Math.exp(Math.log(z0) + (Math.log(zoom) - Math.log(z0)) * k)
      setView(from.cx + (cx - from.cx) * k, from.cy + (cy - from.cy) * k, z)
      if (t < 1) S.anim = requestAnimationFrame(step); else { S.anim = 0; then?.() }
    }
    S.anim = requestAnimationFrame(step)
  }
  function boundsOf(els) {
    const list = [].concat(els).filter(Boolean)
    if (!list.length) return null
    const [x1, y1, x2, y2] = getCommonBounds(list)
    return { x1, y1, x2, y2 }
  }
  // Fit content with a margin that reads as breathing room in a narrow pane and a wide one alike,
  // and never blow a two-box sketch up past 1.5×.
  function fitBounds(b, { maxZoom = 1.5, animate = true, then, margin, right = 0 } = {}) {
    if (!b) return
    const { w, h } = viewport()
    const pad = margin ?? clamp(Math.min(w, h) * 0.07, 24, 64)
    const bottom = S.present >= 0 ? 64 : 0
    const zoom = clamp(Math.min((w - right - pad * 2) / Math.max(1, b.x2 - b.x1), (h - pad * 2 - bottom) / Math.max(1, b.y2 - b.y1)), MIN_ZOOM, maxZoom)
    flyTo((b.x1 + b.x2) / 2 + right / 2 / zoom, (b.y1 + b.y2) / 2 + bottom / 2 / zoom, zoom, { animate, then })
  }
  function fit({ animate = true, then } = {}) {
    if (!S.api) return
    S.follow = true; $('fitBtn').classList.remove('hint')
    fitBounds(boundsOf(S.api.getSceneElements()), { animate, then })
  }
  function zoomBy(factor) {
    if (!S.api) return
    const v = viewport(), c = centerOf(v)
    noteUserMove()
    flyTo(c.cx, c.cy, clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM), { duration: 160 })
  }
  function zoomTo(zoom) { if (!S.api) return; const c = centerOf(viewport()); noteUserMove(); flyTo(c.cx, c.cy, zoom, { duration: 200 }) }
  function updateZoomLabel(z) { $('zoomPct').textContent = Math.round(z * 100) + '%' }
  function noteUserMove() { if (S.follow) { S.follow = false; $('fitBtn').classList.add('hint') } }
  function inView(e) {
    const b = boundsOf(e); if (!b) return true
    const v = viewport(), c = centerOf(v)
    const hw = v.w / 2 / v.zoom, hh = v.h / 2 / v.zoom
    return b.x2 > c.cx - hw && b.x1 < c.cx + hw && b.y2 > c.cy - hh && b.y1 < c.cy + hh
  }

  let lastSize = ''
  function onCanvasChange(_elements, appState) {
    const z = appState.zoom.value
    updateZoomLabel(z)
    // A view we did not set is the reader moving: stop refitting on saves until they press Fit.
    if (!S.anim && S.view) {
      const moved = Math.abs(appState.scrollX - S.view.sx) > 0.5 || Math.abs(appState.scrollY - S.view.sy) > 0.5 || Math.abs(z - S.view.zoom) > 1e-4
      if (moved) { S.view = { sx: appState.scrollX, sy: appState.scrollY, zoom: z }; if (S.present < 0) noteUserMove() }
    }
    const size = appState.width + 'x' + appState.height
    if (size !== lastSize) {
      const firstSize = !lastSize
      lastSize = size
      if (!firstSize && S.api) {
        clearTimeout(onCanvasChange.t)
        onCanvasChange.t = setTimeout(() => { if (S.present >= 0) goStep(S.present, { animate: false }); else if (S.follow) fit({ animate: false }) }, 60)
      }
    }
    if (S.rings.length) placeRings()
  }

  // ---------------------------------------------------------------- rings
  function ringRect(e, pad = 8) {
    const b = boundsOf(e), v = viewport()
    return { left: (b.x1 + v.sx) * v.zoom - pad, top: (b.y1 + v.sy) * v.zoom - pad, width: (b.x2 - b.x1) * v.zoom + pad * 2, height: (b.y2 - b.y1) * v.zoom + pad * 2 }
  }
  function ring(e, { hover = false } = {}) {
    const el = document.createElement('div')
    el.className = 'ring' + (hover ? ' hover' : '')
    $('rings').append(el)
    const entry = { el, e }
    S.rings.push(entry)
    placeRing(entry)
    if (!hover) el.addEventListener('animationend', () => dropRing(entry))
    return entry
  }
  function dropRing(entry) { entry.el.remove(); S.rings = S.rings.filter((r) => r !== entry) }
  function placeRing({ el, e }) { const r = ringRect(e); Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }) }
  function placeRings() { S.rings.forEach(placeRing) }
  function ringAll(elements) { if (elements.length <= 40) elements.forEach((e) => ring(e)) }

  // ---------------------------------------------------------------- inspector
  // Reading, not editing: a click (not a drag) on the canvas names what is under the pointer — its
  // label, what it connects to and from, its frame, colours and size — and rings it.
  let inspectRing = null, down = null
  function sceneAt(clientX, clientY) {
    const r = $('app').getBoundingClientRect(), v = viewport()
    return { x: (clientX - r.left) / v.zoom - v.sx, y: (clientY - r.top) / v.zoom - v.sy, zoom: v.zoom }
  }
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy
    const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
  function hit(p) {
    const els = S.api.getSceneElements()
    const byId = new Map(els.map((e) => [e.id, e]))
    const within = (e, pad = 0) => { const b = boundsOf(e); return b && p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad }
    const tol = 10 / p.zoom
    for (let i = els.length - 1; i >= 0; i--) {
      let e = els[i]
      if (e.type === 'text' && e.containerId && byId.get(e.containerId)) e = byId.get(e.containerId)
      if (e.type === 'arrow' || e.type === 'line') {
        const pts = (e.points || []).map(([x, y]) => [e.x + x, e.y + y])
        if (pts.some((q, j) => j && distToSegment(p.x, p.y, pts[j - 1][0], pts[j - 1][1], q[0], q[1]) < tol)) return e
        continue
      }
      if (e.type === 'frame' || e.type === 'magicframe') continue
      if (within(e, 2 / p.zoom)) return e
    }
    // A frame answers for clicks on its name or its empty inside.
    return els.filter((e) => (e.type === 'frame' || e.type === 'magicframe') && (within(e) || (p.x >= e.x && p.x <= e.x + e.width && p.y >= e.y - 28 / p.zoom && p.y < e.y))).pop() || null
  }
  function closeInspect() { S.inspected = null; $('inspect').hidden = true; if (inspectRing) { dropRing(inspectRing); inspectRing = null } }
  // After a save, the card follows its element: same id, or (scene.py mints new ids) same kind and label.
  function reinspect() {
    const was = S.inspected
    if (!was) return
    const els = S.api.getSceneElements()
    const byContainer = new Map(els.filter((x) => x.type === 'text' && x.containerId).map((x) => [x.containerId, x]))
    const same = els.find((x) => x.id === was.id) || els.find((x) => x.type === was.type && String(labelOf(x, byContainer) || '') === was.label && was.label)
    if (same) inspect(same); else closeInspect()
  }
  function inspect(e) {
    const els = S.api.getSceneElements()
    const byId = new Map(els.map((x) => [x.id, x]))
    const byContainer = new Map(els.filter((x) => x.type === 'text' && x.containerId).map((x) => [x.containerId, x]))
    S.inspected = { id: e.id, type: e.type, label: String(labelOf(e, byContainer) || '') }
    const name = (x) => (x ? (String(labelOf(x, byContainer) || '').replace(/\s*\n\s*/g, ' ').trim() || x.type) : '·')
    const kinds = { rectangle: 'Box', ellipse: 'Ellipse', diamond: 'Diamond', text: 'Text', arrow: 'Arrow', line: 'Line', frame: 'Frame', magicframe: 'Frame', image: 'Image', freedraw: 'Sketch', embeddable: 'Embed' }
    const frame = e.frameId && byId.get(e.frameId)
    let links = []
    if (e.type === 'arrow' || e.type === 'line') {
      const a = e.startBinding && byId.get(e.startBinding.elementId), b = e.endBinding && byId.get(e.endBinding.elementId)
      links = [['from', a], ['to', b]].filter(([, x]) => x).map(([dir, x]) => ({ dir: dir === 'from' ? '↤' : '↦', target: x, note: dir }))
    } else if (e.type === 'frame' || e.type === 'magicframe') {
      links = els.filter((x) => x.frameId === e.id && ['rectangle', 'ellipse', 'diamond', 'image'].includes(x.type)).map((x) => ({ dir: '·', target: x, note: '' }))
    } else {
      for (const arrow of els.filter((x) => x.type === 'arrow')) {
        const from = arrow.startBinding && arrow.startBinding.elementId, to = arrow.endBinding && arrow.endBinding.elementId
        const label = String(labelOf(arrow, byContainer) || '').replace(/\s*\n\s*/g, ' ').trim()
        if (from === e.id && byId.get(to)) links.push({ dir: '→', target: byId.get(to), note: label })
        if (to === e.id && byId.get(from)) links.push({ dir: '←', target: byId.get(from), note: label })
      }
    }
    const title = e.type === 'arrow' || e.type === 'line' ? (name(e) !== e.type ? name(e) : 'Arrow') : name(e)
    const b = boundsOf(e)
    const swatch = (c) => (c && c !== 'transparent' ? `<span><i class="c" style="background:${esc(c)}"></i>${esc(c)}</span>` : '')
    const box = $('inspect')
    box.innerHTML = `<div class="top"><h4>${esc(title)}</h4><button class="x" title="Close (Esc)"><i data-icon="close"></i></button></div>
      <div class="kind">${esc(kinds[e.type] || e.type)}${frame ? ' in ' + esc(frame.name || 'a frame') : ''}${e.type === 'arrow' && e.strokeStyle !== 'solid' ? ' · ' + esc(e.strokeStyle) : ''}</div>
      ${links.length ? `<ul class="links">${links.slice(0, 8).map((l, j) => `<li><span class="dir">${l.dir}</span><button data-j="${j}">${esc(name(l.target))}</button>${l.note ? `<span class="d">${esc(l.note)}</span>` : ''}</li>`).join('')}${links.length > 8 ? `<li class="d">and ${links.length - 8} more</li>` : ''}</ul>` : ''}
      <div class="props">${swatch(e.strokeColor)}${swatch(e.backgroundColor)}<span>${Math.round(b.x2 - b.x1)} × ${Math.round(b.y2 - b.y1)}</span>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.link)}</a>` : ''}</div>`
    paintIcons(box)
    box.hidden = false
    box.querySelector('.x').onclick = closeInspect
    box.querySelectorAll('button[data-j]').forEach((btn) => { btn.onclick = () => { const t = links[Number(btn.dataset.j)].target; noteUserMove(); fitBounds(boundsOf(t), { maxZoom: 1.6, margin: 90, then: () => { inspect(t) } }) } })
    if (inspectRing) dropRing(inspectRing)
    inspectRing = ring(e, { hover: true })
  }
  $('app').addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() } }, true)
  $('app').addEventListener('pointerup', (ev) => {
    if (!down || !S.api || S.present >= 0) return
    const still = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5 && performance.now() - down.t < 500
    down = null
    if (!still) return
    const e = hit(sceneAt(ev.clientX, ev.clientY))
    if (e) inspect(e); else closeInspect()
  }, true)

  // ---------------------------------------------------------------- outline
  let hoverRing = null
  function labelOf(e, byContainer) {
    if (e.type === 'text') return e.text
    if (e.type === 'frame' || e.type === 'magicframe') return e.name || 'Frame'
    const t = byContainer.get(e.id)
    return t ? t.text : ''
  }
  function outlineModel() {
    if (!S.api) return { frames: [], shapes: [], links: [], texts: [] }
    const els = S.api.getSceneElements()
    const byId = new Map(els.map((e) => [e.id, e]))
    const byContainer = new Map(els.filter((e) => e.type === 'text' && e.containerId).map((e) => [e.containerId, e]))
    const clean = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim()
    const frames = els.filter((e) => e.type === 'frame' || e.type === 'magicframe').map((e) => ({ e, t: clean(e.name) || 'Frame', d: plural(els.filter((m) => m.frameId === e.id && m.type !== 'text').length, 'item') }))
    const shapes = els.filter((e) => ['rectangle', 'ellipse', 'diamond', 'image', 'embeddable'].includes(e.type)).map((e) => ({ e, t: clean(labelOf(e, byContainer)) || `(${e.type})`, d: e.frameId && byId.get(e.frameId)?.name ? byId.get(e.frameId).name : '' }))
    const links = els.filter((e) => e.type === 'arrow' || e.type === 'line').map((e) => {
      const a = e.startBinding && byId.get(e.startBinding.elementId), b = e.endBinding && byId.get(e.endBinding.elementId)
      const name = (x) => (x ? clean(labelOf(x, byContainer)) || x.type : '·')
      return { e, t: `${name(a)} → ${name(b)}`, d: clean(labelOf(e, byContainer)) }
    })
    const texts = els.filter((e) => e.type === 'text' && !e.containerId).map((e) => ({ e, t: clean(e.text), d: '' }))
    const order = (x, y) => (Math.abs(x.e.y - y.e.y) > 40 ? x.e.y - y.e.y : x.e.x - y.e.x)
    return { frames: frames.sort(order), shapes: shapes.sort(order), links, texts: texts.sort(order) }
  }
  function renderOutline() {
    if ($('outline').hidden) return
    const q = $('find').value.trim().toLowerCase()
    const m = outlineModel()
    const hit = (r) => !q || (r.t + ' ' + r.d).toLowerCase().includes(q)
    const mark = (s) => { const t = esc(s); if (!q) return t; const i = s.toLowerCase().indexOf(q); return i < 0 ? t : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length)) }
    const sw = (e) => {
      if (e.type === 'arrow' || e.type === 'line') return `<i class="sw arrow" data-icon="arrow"></i>`
      if (e.type === 'text') return `<span class="sw text">T</span>`
      const fill = e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : 'transparent'
      return `<span class="sw ${e.type}" style="background:${esc(fill)};border-color:${esc(e.strokeColor || '#1e1e1e')}"></span>`
    }
    const section = (title, rows) => {
      const shown = rows.filter(hit)
      if (!shown.length) return ''
      return `<h3>${title}</h3>` + shown.map((r) => `<button class="row" data-id="${esc(r.e.id)}">${sw(r.e)}<span class="t">${mark(r.t)}</span>${r.d ? `<span class="d">${mark(r.d)}</span>` : ''}</button>`).join('')
    }
    const html = section('Frames', m.frames) + section('Boxes', m.shapes) + section('Connections', m.links) + section('Text', m.texts)
    $('outlineList').innerHTML = html || `<div class="none">${q ? 'Nothing matches “' + esc(q) + '”.' : 'The diagram is empty so far.'}</div>`
    paintIcons($('outlineList'))
  }
  function toggleOutline(on = $('outline').hidden) {
    $('outline').hidden = !on
    $('outlineBtn').classList.toggle('on', on)
    if (on) { renderOutline(); setTimeout(() => $('find').focus(), 0); return }
    $('find').blur()
    if (hoverRing) { dropRing(hoverRing); hoverRing = null }
  }
  const elementById = (id) => S.api?.getSceneElements().find((e) => e.id === id)
  $('outlineList').addEventListener('click', (ev) => {
    const row = ev.target.closest('.row'); if (!row) return
    const e = elementById(row.dataset.id); if (!e) return
    if (document.activeElement === $('find')) $('find').blur() // shortcuts work again after a pick
    noteUserMove()
    $('outlineList').querySelectorAll('.row.active').forEach((r) => r.classList.remove('active'))
    row.classList.add('active')
    // A wide pane keeps the outline open and frames the pick in the space beside it.
    const panel = viewport().w >= 900 ? $('outline').offsetWidth + 20 : 0
    if (!panel) toggleOutline(false)
    fitBounds(boundsOf(e), { maxZoom: 1.6, margin: 90, right: panel, then: () => ring(e) })
  })
  $('outlineList').addEventListener('mouseover', (ev) => {
    const row = ev.target.closest('.row')
    const e = row && elementById(row.dataset.id)
    if (hoverRing && hoverRing.e === e) return
    if (hoverRing) { dropRing(hoverRing); hoverRing = null }
    if (e) hoverRing = ring(e, { hover: true })
  })
  $('outlineList').addEventListener('mouseleave', () => { if (hoverRing) { dropRing(hoverRing); hoverRing = null } })
  $('find').addEventListener('input', renderOutline)
  $('find').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); if ($('find').value) { $('find').value = ''; renderOutline() } else toggleOutline(false) }
    if (ev.key === 'Enter') { const first = $('outlineList').querySelector('.row'); if (first) first.click() }
  })

  // ---------------------------------------------------------------- present
  function rebuildSteps() {
    if (!S.api) return
    const frames = S.api.getSceneElements().filter((e) => e.type === 'frame' || e.type === 'magicframe')
    frames.sort((a, b) => (Math.abs(a.y - b.y) > 80 ? a.y - b.y : a.x - b.x))
    S.steps = [{ name: 'Whole diagram', e: null }, ...frames.map((e) => ({ name: e.name || 'Frame', e }))]
  }
  function goStep(i, { animate = true } = {}) {
    if (!S.api) return
    rebuildSteps()
    S.present = clamp(i, 0, S.steps.length - 1)
    const step = S.steps[S.present]
    const b = step.e ? boundsOf(step.e) : boundsOf(S.api.getSceneElements())
    fitBounds(b, { maxZoom: step.e ? 3 : 2, animate })
    const n = S.steps.length
    $('stepText').innerHTML = n > 1 ? `<b>${S.present + 1}</b> <span class="faint">/ ${n}</span> &nbsp;${esc(step.name)}` : `<b>${esc(step.name)}</b> <span class="faint">· no frames to step through</span>`
    $('prevStep').disabled = S.present === 0; $('nextStep').disabled = S.present === n - 1
    wakeDeck()
  }
  // The laser: a fading red trail over the canvas while presenting. Excalidraw 0.17's own laser
  // does not draw in view mode (its pan handler takes the drag first), so the pane draws its own.
  const laser = { points: [], down: false, raf: 0 }
  function setLaser(on) {
    S.laser = on
    $('laserBtn').classList.toggle('on', on)
    $('laser').hidden = !on
    if (on) sizeLaser()
  }
  function sizeLaser() {
    const c = $('laser'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr)
  }
  function drawLaser() {
    const c = $('laser'), ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1, now = performance.now()
    laser.points = laser.points.filter((p) => now - p.t < 650)
    ctx.clearRect(0, 0, c.width, c.height)
    const pts = laser.points
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], life = 1 - (now - b.t) / 650
      if (b.gap) continue
      ctx.strokeStyle = `rgba(255, 45, 45, ${0.9 * life})`
      ctx.lineWidth = (2 + 4 * life) * dpr
      ctx.lineCap = 'round'
      ctx.shadowColor = 'rgba(255, 60, 60, .8)'; ctx.shadowBlur = 10 * dpr * life
      ctx.beginPath(); ctx.moveTo(a.x * dpr, a.y * dpr); ctx.lineTo(b.x * dpr, b.y * dpr); ctx.stroke()
    }
    laser.raf = pts.length ? requestAnimationFrame(drawLaser) : 0
  }
  function laserPoint(ev, gap = false) {
    const r = $('laser').getBoundingClientRect()
    laser.points.push({ x: ev.clientX - r.left, y: ev.clientY - r.top, t: performance.now(), gap })
    if (!laser.raf) laser.raf = requestAnimationFrame(drawLaser)
  }
  $('laser').addEventListener('pointerdown', (ev) => { laser.down = true; $('laser').setPointerCapture(ev.pointerId); laserPoint(ev, true) })
  $('laser').addEventListener('pointermove', (ev) => { if (laser.down) laserPoint(ev) })
  $('laser').addEventListener('pointerup', () => { laser.down = false })
  window.addEventListener('resize', () => { if (S.laser) sizeLaser() })
  function present(on) {
    if (!S.api) return
    closeMenu(); toggleOutline(false)
    document.body.classList.toggle('presenting', on)
    $('deck').hidden = !on
    if (on) {
      S.present = 0
      setTimeout(() => goStep(0, { animate: false }), 30)
      setLaser(true)
    } else {
      S.present = -1
      setLaser(false)
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
      setTimeout(() => fit({ animate: false }), 30)
    }
  }
  let deckTimer = 0
  function wakeDeck() {
    $('deck').classList.remove('idle')
    clearTimeout(deckTimer)
    deckTimer = setTimeout(() => { if (!$('deck').matches(':hover')) $('deck').classList.add('idle') }, 2600)
  }
  document.addEventListener('mousemove', () => { if (S.present >= 0) wakeDeck() })
  $('prevStep').onclick = () => goStep(S.present - 1)
  $('nextStep').onclick = () => goStep(S.present + 1)
  $('exitPresent').onclick = () => present(false)
  $('laserBtn').onclick = () => setLaser(!S.laser)
  $('fullBtn').onclick = () => {
    const el = document.documentElement
    if (document.fullscreenElement) document.exitFullscreen?.()
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast('Full screen is not available in this pane; use the pane’s zoom button instead.', { ms: 3500 }))
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    else toast('Full screen is not available in this pane; use the pane’s zoom button instead.', { ms: 3500 })
  }

  // ---------------------------------------------------------------- menus
  let menuFor = null
  function closeMenu() {
    $('menu').hidden = true
    if (menuFor) menuFor.setAttribute('aria-expanded', 'false')
    menuFor = null
  }
  function openMenu(anchor, html, onPick) {
    if (menuFor === anchor) { closeMenu(); return }
    closeMenu()
    const menu = $('menu')
    menu.innerHTML = html
    paintIcons(menu)
    menu.hidden = false
    const r = anchor.getBoundingClientRect(), stage = $('stage').getBoundingClientRect()
    const left = clamp(r.left - stage.left, 8, stage.width - menu.offsetWidth - 8)
    Object.assign(menu.style, { left: left + 'px', top: '6px' })
    anchor.setAttribute('aria-expanded', 'true')
    menuFor = anchor
    menu.onclick = (ev) => { const b = ev.target.closest('button[data-pick]'); if (b) { closeMenu(); onPick(b.dataset.pick) } }
  }
  document.addEventListener('pointerdown', (ev) => { if (menuFor && !ev.target.closest('#menu') && !ev.target.closest('[aria-expanded="true"]')) closeMenu() })

  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago' }
  $('file').onclick = async () => {
    const files = await listFiles()
    const rows = files.length
      ? files.map((f) => `<button data-pick="${esc(f.path)}" class="${f.path === S.file ? 'current' : ''}"><i data-icon="${f.path === S.file ? 'check' : 'doc'}"></i><span class="t">${esc(f.path)}</span><span class="d">${ago(f.mtime)}</span></button>`).join('')
      : '<div class="label">No .excalidraw files yet</div>'
    openMenu($('file'), `<div class="label">Diagrams in this workspace</div>${rows}`, (path) => { if (path !== S.file) { S.file = path; setUrl(); S.follow = true; S.data = null; load({ first: true }) } })
  }
  function setUrl() { const u = new URL(location.href); u.searchParams.set('file', S.file); history.replaceState(null, '', u) }

  const stem = () => (S.file.split('/').pop() || 'diagram').replace(/\.excalidraw$/, '')
  function exportOpts() {
    const a = S.api.getAppState()
    return {
      elements: S.api.getSceneElements(), files: S.api.getFiles(),
      appState: { ...a, exportBackground: true, exportWithDarkMode: S.theme === 'dark', viewBackgroundColor: a.viewBackgroundColor },
      exportPadding: 32,
    }
  }
  async function pngBlob() { return exportToBlob({ ...exportOpts(), mimeType: 'image/png', getDimensions: (w, hgt) => ({ width: w * 2, height: hgt * 2, scale: 2 }) }) }
  async function save(name, body, type) {
    const res = await fetch('/export?name=' + encodeURIComponent(name), { method: 'POST', body, headers: { 'content-type': type } })
    const out = await res.json()
    if (!res.ok) throw new Error(out.error || 'HTTP ' + res.status)
    return out
  }
  const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
  async function doExport(kind) {
    if (!S.api || !S.api.getSceneElements().length) { toast('Nothing to export yet.'); return }
    try {
      if (kind === 'png') { const out = await save(stem() + '.png', await pngBlob(), 'image/png'); toast(`Saved ${out.path} · ${size(out.bytes)}`) }
      if (kind === 'svg') { const node = await exportToSvg(exportOpts()); const out = await save(stem() + '.svg', new Blob([node.outerHTML], { type: 'image/svg+xml' }), 'image/svg+xml'); toast(`Saved ${out.path} · ${size(out.bytes)}`) }
      if (kind === 'copy') {
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error('this pane cannot write images to the clipboard; use Save PNG')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })])
        toast('PNG copied to the clipboard')
      }
    } catch (error) { toast(`Export failed: ${error.message}`, { warn: true, ms: 5000 }) }
  }
  $('exportBtn').onclick = () => openMenu($('exportBtn'), `
    <div class="label">Export ${esc(S.file.split('/').pop() || '')}</div>
    <button data-pick="png"><i data-icon="image"></i><span class="t">Save PNG</span><span class="d">exports/${esc(stem())}.png</span></button>
    <button data-pick="svg"><i data-icon="code"></i><span class="t">Save SVG</span><span class="d">exports/${esc(stem())}.svg</span></button>
    <hr><button data-pick="copy"><i data-icon="copy"></i><span class="t">Copy PNG</span><span class="d">to the clipboard</span></button>`, doExport)

  // ---------------------------------------------------------------- toast, live, theme
  let toastTimer = 0
  function toast(text, { action, run, warn = false, ms = 3200 } = {}) {
    const t = $('toast')
    t.className = 'toast' + (warn ? ' warn' : '')
    t.innerHTML = `<span>${esc(text)}</span>` + (action ? `<button>${esc(action)}</button>` : '')
    if (action) t.querySelector('button').onclick = () => { t.hidden = true; run() }
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.hidden = true }, ms)
  }
  function pulseLive() { const l = $('live'); l.classList.remove('pulse'); void l.offsetWidth; l.classList.add('pulse'); $('liveText').textContent = 'Updated'; clearTimeout(pulseLive.t); pulseLive.t = setTimeout(() => { $('liveText').textContent = 'Live' }, 2500) }
  function setTheme(theme) {
    S.theme = theme; store.set('theme', theme)
    $('themeBtn').querySelector('i').dataset.icon = theme === 'dark' ? 'sun' : 'moon'
    $('themeBtn').title = theme === 'dark' ? 'Light canvas, as drawn (T)' : 'Dark canvas (T)'
    paintIcons($('themeBtn'))
    if (S.root && S.api) renderApp()
  }
  setTheme(S.theme)

  // ---------------------------------------------------------------- wiring
  $('outlineBtn').onclick = () => toggleOutline()
  $('zoomIn').onclick = () => zoomBy(1.25)
  $('zoomOut').onclick = () => zoomBy(1 / 1.25)
  $('zoomPct').onclick = () => zoomTo(1)
  $('fitBtn').onclick = () => fit({ animate: true })
  $('presentBtn').onclick = () => present(true)
  $('themeBtn').onclick = () => setTheme(S.theme === 'dark' ? 'light' : 'dark')
  $('help').onclick = () => { $('help').hidden = true }
  // A wheel or drag on the canvas is the reader taking the view.
  $('app').addEventListener('wheel', () => { if (S.present < 0) noteUserMove() }, { passive: true, capture: true })

  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest && ev.target.closest('input, textarea, [contenteditable="true"]')) return
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const k = ev.key
    if (!$('help').hidden) { $('help').hidden = true; ev.preventDefault(); return }
    if (S.present >= 0) {
      if (k === 'Escape') present(false)
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) goStep(S.present + 1)
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) goStep(S.present - 1)
      else if (k === 'Home') goStep(0)
      else if (k === 'End') goStep(1e9)
      else if (k === 'l' || k === 'L') setLaser(!S.laser)
      else if (k === 'f' || k === 'F') goStep(S.present, { animate: true })
      else return
      ev.preventDefault(); return
    }
    if (k === 'Escape') { closeMenu(); toggleOutline(false); closeInspect(); return }
    const act = {
      f: () => fit(), F: () => fit(), '!': () => fit(),
      '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(1 / 1.25), _: () => zoomBy(1 / 1.25), 0: () => zoomTo(1),
      o: () => toggleOutline(), O: () => toggleOutline(), '/': () => toggleOutline(true),
      p: () => present(true), P: () => present(true),
      e: () => $('exportBtn').click(), E: () => $('exportBtn').click(),
      t: () => setTheme(S.theme === 'dark' ? 'light' : 'dark'), T: () => setTheme(S.theme === 'dark' ? 'light' : 'dark'),
      '?': () => { $('help').hidden = false },
    }[k]
    if (act) { act(); ev.preventDefault() }
  })

  function connect() {
    const events = new EventSource('/events')
    events.onopen = () => { $('live').classList.remove('off'); $('liveText').textContent = 'Live'; $('live').title = 'Live: redraws on every save' }
    events.onerror = () => { $('live').classList.add('off'); $('liveText').textContent = 'Reconnecting…'; $('live').title = 'The pane lost its link to the workspace; retrying' }
    events.addEventListener('change', (ev) => {
      let path = ''
      try { path = JSON.parse(ev.data).path } catch { /* an old server */ }
      if (!S.file) { if (!path || path.endsWith('.excalidraw')) load({ first: true }); return }
      if (!path || path === S.file) load()
    })
  }
  connect()
  load({ first: true })
  window.__pane = S // for tests
})()
