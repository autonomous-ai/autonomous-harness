// The pane: follows the workspace live, loads the newest glTF into the viewport, and wires the
// header, toolbar, tools, outliner, timeline, keyboard and the Turntable / Render views around it.
import * as THREE from 'three'
import { Viewport, AXIS_DIR } from './viewport.js'
import { Outliner } from './outliner.js'
import { Measure } from './measure.js'
import { ENVIRONMENTS, BACKGROUNDS } from './env.js'
import { $, $$, el, put, icon, mm, int, bytes, ago, debounce, store, save } from './util.js'

const params = new URLSearchParams(location.search)
const fileParam = (params.get('file') || '').replace(/^\/+/, '')
const isModel = (p) => /\.(glb|gltf)$/i.test(p || '')
const isVideo = (p) => /\.(mp4|m4v|webm|mov)$/i.test(p || '')
const isStill = (p) => /\.(png|jpe?g|webp)$/i.test(p || '')
const wsUrl = (path, v) => `/ws/${path.split('/').map(encodeURIComponent).join('/')}${v ? `?v=${v}` : ''}`

for (const node of $$('[data-icon]')) node.insertAdjacentHTML('afterbegin', icon[node.dataset.icon] ?? '')

const app = {
  state: null,
  current: null, // { path, mtime, size }
  pinned: null, // a model the user picked from the menu
  loading: null,
  report: null,
  view: 'model',
  sidebar: store('mv:sidebar', window.innerWidth > 900),
  tools: { measure: false, section: false, explode: false },
  lastUpdate: null,
}

// ---------------------------------------------------------------------------------------------------
// The viewport and its companions

const stage = $('#stage')
const viewport = new Viewport(stage, $('#gl'), {
  gizmoHost: $('#gizmo'),
  click: (e) => onViewportClick(e),
  dblclick: (e) => {
    if (measure.enabled) return
    const hit = viewport.pick(e.clientX, e.clientY)
    if (hit) { viewport.select(hit.item); viewport.frameSelected() } else viewport.frameAll()
  },
  hover: (e) => onViewportHover(e),
  userInput: () => {},
  afterRender: (camera) => afterRender(camera),
  selectionChanged: () => { outliner.render(); renderHud(); persist() },
  visibilityChanged: () => { outliner.renderTree(); renderHud(); persist() },
  backgroundChanged: (bg, dark) => { stage.dataset.bg = bg; stage.dataset.dark = dark ? '1' : '' },
  cameraViewChanged: (item) => { $('#frame').hidden = !item; $('#frame-name').textContent = item?.name ?? ''; $('#nav-camera').classList.toggle('on', !!item); stage.classList.toggle('camera-view', !!item); renderHud() },
  animationChanged: () => renderTimelineTime(),
})
const outliner = new Outliner(viewport, { tree: $('#tree'), props: $('#props'), card: $('#card'), filter: $('#filter') }, {
  isolate: (item) => { viewport.select(item); if (viewport.localView) viewport.toggleLocalView(); viewport.toggleLocalView(); renderHud() },
  lookThrough: (item) => { viewport.enterCameraView(item) },
  openSidebar: () => setSidebar(true),
  sidebarOpen: () => app.sidebar,
  modelName: () => app.current?.path.split('/').pop() ?? 'Scene',
})
const measure = new Measure(viewport, $('#labels'), () => renderPanels())

// options persist per machine; view state per model, per session
const saved = store('mv:options', {})
for (const [key, value] of Object.entries(saved)) if (key in viewport.options) viewport.options[key] = value
viewport.grid.mesh.visible = viewport.options.grid
viewport.applyShading()

const persistOptions = () => save('mv:options', viewport.options)
const persist = debounce(() => { if (app.current && viewport.items.length) save(`mv:view:${app.current.path}`, viewport.captureState(), sessionStorage) }, 300)

function afterRender(camera) {
  measure.place(camera)
  viewport.gizmo.draw()
  if (viewport.cameraView && viewport.cameraFrame) {
    const f = viewport.cameraFrame
    Object.assign($('#frame').style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` })
  }
  renderHudView()
  persist()
}

// ---------------------------------------------------------------------------------------------------
// Live state: server-sent events, with a poll as the fallback

function connect() {
  const source = new EventSource('/events')
  source.addEventListener('state', (e) => onState(JSON.parse(e.data)))
  source.onerror = () => { renderStatus('offline') }
}

function onState(state) {
  app.state = state
  const target = chooseModel(state)
  const same = (a, b) => a && b && a.path === b.path && a.mtime === b.mtime && a.size === b.size
  // state events arrive for every step of a build: never restart a load that is already on its way
  if (target && !same(target, app.current) && !same(target, app.loading?.entry)) {
    load(target)
  } else if (!target && !app.current) {
    renderEmpty()
  }
  renderViews()
  renderStatus()
  renderEmpty()
  renderModelButton()
}

function chooseModel(state) {
  const models = state.models ?? []
  if (app.pinned) { const m = models.find((x) => x.path === app.pinned); if (m) return m }
  if (isModel(fileParam)) { const m = models.find((x) => x.path === fileParam); if (m) return m }
  const artifact = state.verdict?.artifact
  if (isModel(artifact)) { const m = models.find((x) => x.path === artifact); if (m) return m }
  return models[0] ?? null
}

async function load(entry) {
  const token = Symbol('load')
  app.loading = { token, path: entry.path, entry }
  renderStatus()
  const keep = app.current && app.current.path === entry.path
  let gltf = null, error = null
  for (let attempt = 0; attempt < 4 && !gltf; attempt++) {
    try {
      const res = await fetch(wsUrl(entry.path, entry.mtime), { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const buffer = await res.arrayBuffer()
      const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : ''
      gltf = await viewport.parse(buffer, wsUrl(dir || '.').replace(/\.$/, ''))
    } catch (e) {
      error = e
      await new Promise((r) => setTimeout(r, 500 + attempt * 400))
    }
    if (app.loading?.token !== token) return
  }
  if (app.loading?.token !== token) return
  app.loading = null
  if (!gltf) {
    app.loadError = { path: entry.path, message: String(error?.message ?? error) }
    if (app.current) toast(`Could not read the new <b>${escapeHtml(entry.path.split('/').pop())}</b> — still showing the last good one`, { kind: 'warn' })
    renderStatus(); renderEmpty()
    return
  }
  app.loadError = null
  app.report = entry.report ? await findReport(entry.report) : null
  const diff = viewport.setModel(gltf, { report: app.report, keep })
  const first = !app.current
  app.current = { path: entry.path, mtime: entry.mtime, size: entry.size }
  app.lastUpdate = Date.now()
  if (!keep) {
    const saved = store(`mv:view:${entry.path}`, null, sessionStorage)
    if (saved) viewport.restoreState(saved)
    measure.clear()
  } else {
    measure.rebind()
  }
  outliner.rebuild()
  renderModelButton()
  renderTimeline()
  renderHud()
  renderPanels()
  renderStatus()
  renderEmpty()
  if (keep) {
    const summary = diff?.summary()
    toast(summary ? `<b>Updated</b> · ${escapeHtml(summary)}` : '<b>Updated</b> · nothing visible changed', { kind: 'ok' })
  } else if (!first) {
    toast(`Showing <b>${escapeHtml(entry.path)}</b>`)
  }
}

async function findReport(path) {
  try {
    const res = await fetch(wsUrl(path, Date.now()), { cache: 'no-store' })
    if (res.ok) return await res.json()
  } catch { /* no report: units fall back to the export or a guess */ }
  return null
}

// ---------------------------------------------------------------------------------------------------
// Header: model menu, status, view tabs

function renderModelButton() {
  const path = app.current?.path ?? ''
  const cut = path.lastIndexOf('/')
  $('#model-dir').textContent = cut >= 0 ? path.slice(0, cut + 1) : ''
  $('#model-name').textContent = path ? path.slice(cut + 1) : app.state ? 'No model yet' : 'Looking for a model…'
  stage.classList.toggle('no-model', !path)
}

$('#model-btn').addEventListener('click', (e) => {
  const models = app.state?.models ?? []
  openMenu(e.currentTarget, (menu) => {
    menu.append(el('div', { class: 'mh', text: models.length ? 'Models in this workspace' : 'No glTF in this workspace yet' }))
    for (const m of models.slice(0, 20)) {
      menu.append(el('button', { class: `mi${app.current?.path === m.path ? ' on' : ''}`, onclick: () => { app.pinned = m.path === models[0]?.path && !isModel(fileParam) ? null : m.path; closeMenu(); load(m) } },
        el('span', { class: 'mic', html: app.current?.path === m.path ? icon.check : '' }), el('span', { class: 'ml', text: m.path }), el('span', { class: 'ms', text: `${bytes(m.size)} · ${ago(m.mtime, app.state.now)}` })))
    }
    if (app.pinned) {
      menu.append(el('div', { class: 'msep' }), el('button', { class: 'mi', onclick: () => { app.pinned = null; closeMenu(); onState(app.state) } }, el('span', { class: 'mic', html: icon.follow }), el('span', { class: 'ml', text: 'Follow the newest export' })))
    }
  })
})

function buildState() {
  const s = app.state
  const b = s?.build
  if (b && b.state === 'building') return { kind: 'building', label: b.step || 'Building', progress: b.progress }
  if (s?.inferred) return { kind: 'building', label: s.inferred.step, progress: null }
  if (b && (b.state === 'failed' || b.state === 'stopped')) {
    const at = Date.parse(b.updatedAt || '') || 0
    if (!app.current || at > (app.current.mtime ?? 0)) return { kind: 'failed', label: b.state === 'stopped' ? 'Build stopped' : `Build failed${b.error ? ` · ${b.error}` : ''}` }
  }
  return null
}

function renderStatus(offline) {
  const node = $('#status')
  const label = node.querySelector('.label')
  const bar = $('#progress')
  const build = buildState()
  let kind = 'idle', text = 'Waiting for a model', progress = undefined
  if (offline === 'offline') { kind = 'failed'; text = 'Viewer disconnected — retrying' }
  else if (app.loading) { kind = 'loading'; text = app.current ? 'Loading the new export…' : 'Loading model…' }
  else if (build?.kind === 'building') { kind = 'building'; text = app.current ? `Rebuilding · ${build.label}` : build.label; progress = build.progress }
  else if (build?.kind === 'failed') { kind = 'failed'; text = build.label }
  else if (app.loadError && !app.current) { kind = 'failed'; text = 'Could not read the model' }
  else if (app.current) { kind = 'live'; text = `Live · updated ${ago(app.current.mtime, Date.now())}` }
  node.dataset.kind = kind
  label.textContent = text
  node.title = build?.label ?? text
  bar.hidden = !(kind === 'building' || kind === 'loading')
  bar.classList.toggle('indeterminate', progress === null || progress === undefined)
  bar.querySelector('i').style.width = progress !== null && progress !== undefined ? `${Math.round(progress * 100)}%` : ''
}
setInterval(() => { if (!app.loading && !buildState()) renderStatus() }, 15000)

function videoEntry() {
  const vids = app.state?.videos ?? []
  if (isVideo(fileParam)) { const v = vids.find((x) => x.path === fileParam); if (v) return v }
  return vids.find((v) => /turntable/i.test(v.path)) ?? vids[0] ?? null
}
function stillEntry() {
  const stills = (app.state?.stills ?? []).filter((s) => !/\/(snapshots?|screenshots?)\//.test(s.path))
  if (isStill(fileParam)) { const s = stills.find((x) => x.path === fileParam); if (s) return s }
  return stills.find((s) => /preview|render|still|beauty/i.test(s.path)) ?? null
}

function renderViews() {
  const video = videoEntry(), still = stillEntry()
  const vb = $('#views [data-view="video"]'), sb = $('#views [data-view="still"]')
  vb.hidden = !video; sb.hidden = !still
  vb.querySelector('.t').textContent = video && !/turntable/i.test(video.path) ? 'Video' : 'Turntable'
  $('#views').hidden = !video && !still
  if (app.view === 'video' && !video) setView('model')
  if (app.view === 'still' && !still) setView('model')
  if (app.view === 'video') showVideo(video)
  if (app.view === 'still') showStill(still)
}

function setView(view) {
  app.view = view
  for (const b of $$('#views button')) b.classList.toggle('on', b.dataset.view === view)
  $('#model-view').hidden = view !== 'model'
  $('#video-view').hidden = view !== 'video'
  $('#still-view').hidden = view !== 'still'
  const video = $('#video')
  if (view === 'video') showVideo(videoEntry())
  else video.pause()
  if (view === 'still') showStill(stillEntry())
  if (view === 'model') viewport.invalidate()
}

function showVideo(entry) {
  if (!entry) return
  const video = $('#video')
  const src = wsUrl(entry.path, entry.mtime)
  if (video.dataset.src !== src) {
    video.dataset.src = src
    video.src = src
    video.play().catch(() => {})
  }
  $('#video-name').textContent = entry.path
  $('#video-meta').textContent = `${bytes(entry.size)} · ${ago(entry.mtime, Date.now())}`
}

function showStill(entry) {
  if (!entry) return
  const img = $('#still')
  const src = wsUrl(entry.path, entry.mtime)
  if (img.dataset.src !== src) { img.dataset.src = src; img.src = src }
  $('#still-name').textContent = entry.path
  $('#still-meta').textContent = `${bytes(entry.size)} · ${ago(entry.mtime, Date.now())}`
}
$('#still').addEventListener('load', (e) => { $('#still-meta').textContent = `${e.target.naturalWidth}×${e.target.naturalHeight} · ${$('#still-meta').textContent.split(' · ').slice(-2).join(' · ')}` })
$('#still').addEventListener('click', (e) => e.target.classList.toggle('actual'))
$$('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)))
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)))

// ---------------------------------------------------------------------------------------------------
// Empty and building states

function renderEmpty() {
  const box = $('#empty')
  if (app.current) { box.hidden = true; return }
  const build = buildState()
  const video = videoEntry(), still = stillEntry()
  // progress arrives several times a second: update the card in place rather than restart its spinner
  const mode = app.loading ? 'loading' : build?.kind === 'building' ? 'building' : app.loadError ? 'error' : `idle:${!!video}:${!!still}`
  if (!box.hidden && box.dataset.mode === mode) {
    if (mode === 'building') {
      const step = box.querySelector('.empty-step'), fill = box.querySelector('.bar i')
      if (step) step.textContent = build.label
      if (fill && build.progress !== null && build.progress !== undefined) fill.style.width = `${Math.round(build.progress * 100)}%`
      if (!fill === (build.progress !== null && build.progress !== undefined)) box.dataset.mode = ''
      else return
    } else if (mode !== 'error') return
  }
  box.dataset.mode = mode
  let card
  if (app.loading) {
    card = emptyCard({ art: icon.model, spinning: true, title: 'Loading the model', body: app.loading.path })
  } else if (build?.kind === 'building') {
    const bar = build.progress !== null && build.progress !== undefined ? el('div', { class: 'bar' }, el('i', { style: { width: `${Math.round(build.progress * 100)}%` } })) : null
    card = emptyCard({ art: icon.model, spinning: true, title: 'Building the first model', step: build.label, bar, body: 'The 3D scene appears here the moment the agent exports its glTF.' })
  } else if (app.loadError) {
    card = emptyCard({ art: icon.model, title: 'This model could not be read', body: `${app.loadError.path}: ${app.loadError.message}`, hint: 'The pane retries on the next export.' })
  } else {
    card = emptyCard({
      art: icon.model, title: 'No model yet',
      body: 'Ask the agent for an object. Its glTF export shows up here as a live 3D scene you can orbit, measure and cut.',
      hint: el('span', {}, 'Watching this workspace for ', el('code', { text: '.glb' }), ' and ', el('code', { text: '.gltf' })),
      actions: [video ? el('button', { class: 'btn', html: `${icon.video}<span>Watch the turntable</span>`, onclick: () => setView('video') }) : null, still ? el('button', { class: 'btn', html: `${icon.image}<span>See the render</span>`, onclick: () => setView('still') }) : null].filter(Boolean),
    })
  }
  put(box, card)
  box.hidden = false
}

function emptyCard({ art, spinning, title, body, hint, step, bar, actions }) {
  return el('div', { class: 'empty-card' },
    el('div', { class: `empty-art${spinning ? ' spinning' : ''}`, html: art.replace('width="16" height="16"', 'width="64" height="64"').replace('stroke-width="1.35"', 'stroke-width="0.7"') }),
    el('h3', { text: title }),
    step ? el('div', { class: 'empty-step', text: step }) : null,
    bar ?? null,
    body ? el('p', { text: body }) : null,
    hint ? el('p', { class: 'hint' }, hint) : null,
    actions?.length ? el('div', { class: 'empty-actions' }, ...actions) : null)
}

// ---------------------------------------------------------------------------------------------------
// HUD: the view's name, where the active object lives, statistics

function renderHudView() {
  const node = $('#hud .h-view')
  if (!node) return
  const text = viewport.cameraView ? `Camera Perspective` : `${viewport.nav.viewName()}${viewport.localView ? ' (Local)' : ''}`
  if (node.textContent !== text) node.textContent = text
  const grid = $('#hud .h-grid')
  if (grid) {
    const g = viewport.options.grid && viewport.options.shading !== 'rendered' ? mm(viewport.grid.spacingMm) : '—'
    if (grid.textContent !== g) grid.textContent = g
  }
}

function renderHud() {
  const hud = $('#hud')
  if (!viewport.items.length) { put(hud, ); return }
  const active = viewport.active
  const collection = active ? viewport.ancestors(active).find((a) => a.type === 'COLLECTION')?.name ?? 'Scene Collection' : null
  const meshes = viewport.items.filter((i) => i.meshes.length)
  const shown = meshes.filter((i) => i.shown !== false)
  const sel = [...viewport.selection].flatMap((i) => viewport.descendants(i)).filter((i) => i.meshes.length)
  const tris = (list) => list.reduce((n, i) => n + i.stats.triangles, 0)
  const size = viewport.boxOf(viewport.items, true)
  const s = size.isEmpty() ? null : size.getSize(new THREE.Vector3()).multiplyScalar(viewport.mmPerUnit)
  const where = active ? `${collection} | ${active.name}` : app.current?.path.split('/').pop() ?? ''
  const stats = viewport.options.stats ? el('div', { class: 'h-stats' },
    el('span', { text: 'Objects' }), el('b', { text: sel.length ? `${sel.length}/${meshes.length}` : shown.length === meshes.length ? int(meshes.length) : `${shown.length}/${meshes.length}` }),
    el('span', { text: 'Triangles' }), el('b', { text: sel.length ? `${int(tris(sel))}/${int(tris(meshes))}` : int(tris(shown)) }),
    s ? el('span', { text: 'Size' }) : null, s ? el('b', { text: `${mm(s.x, false)} × ${mm(s.z, false)} × ${mm(s.y, false)} mm` }) : null,
    el('span', { text: 'Grid' }), el('b', { class: 'h-grid', text: '' }),
  ) : null
  put(hud, el('div', { class: 'h-view' }), el('div', { class: 'h-where', text: where }), stats)
  renderHudView()
}

// ---------------------------------------------------------------------------------------------------
// Toolbar: shading, x-ray, tools, view menu, sidebar

function syncToolbar() {
  const o = viewport.options
  for (const b of $$('[data-shading]')) b.classList.toggle('on', b.dataset.shading === o.shading)
  $('#xray-btn').classList.toggle('on', o.xray)
  $('#measure-btn').classList.toggle('on', app.tools.measure)
  $('#section-btn').classList.toggle('on', app.tools.section)
  $('#explode-btn').classList.toggle('on', app.tools.explode)
  $('#sidebar-btn').classList.toggle('on', app.sidebar)
  $('#nav-ortho').innerHTML = viewport.nav.orthographic ? icon.ortho : icon.persp
  $('#nav-ortho').classList.toggle('on', viewport.nav.orthographic)
  $('#nav-camera').disabled = !viewport.sceneCameraItems().length
}

function setShading(mode) {
  viewport.setOption('shading', mode)
  persistOptions(); syncToolbar(); renderHud()
}
$$('[data-shading]').forEach((b) => b.addEventListener('click', () => setShading(b.dataset.shading)))
$('#xray-btn').addEventListener('click', () => { viewport.setOption('xray', !viewport.options.xray); persistOptions(); syncToolbar() })
$('#look-btn').addEventListener('click', (e) => openMenu(e.currentTarget, buildLookMenu, { keepOpen: true }))
$('#view-btn').addEventListener('click', (e) => openMenu(e.currentTarget, buildViewMenu, { align: 'right' }))
$('#sidebar-btn').addEventListener('click', () => setSidebar(!app.sidebar))
$('#sidebar-close').addEventListener('click', () => setSidebar(false))
$('#measure-btn').addEventListener('click', () => setTool('measure', !app.tools.measure))
$('#section-btn').addEventListener('click', () => setTool('section', !app.tools.section))
$('#explode-btn').addEventListener('click', () => setTool('explode', !app.tools.explode))
$('#nav-frame').addEventListener('click', () => viewport.frameAll())
$('#nav-ortho').addEventListener('click', () => { viewport.nav.toggleOrtho(); syncToolbar() })
$('#nav-camera').addEventListener('click', () => toggleCameraView())
dragButton($('#nav-zoom'), (dx, dy) => viewport.nav.zoom(Math.exp(dy * 0.01)))
dragButton($('#nav-pan'), (dx, dy) => viewport.nav.pan(dx, dy))

function dragButton(button, fn) {
  let last = null
  button.addEventListener('pointerdown', (e) => { last = { x: e.clientX, y: e.clientY }; button.setPointerCapture(e.pointerId); if (viewport.cameraView) viewport.exitCameraView() })
  button.addEventListener('pointermove', (e) => { if (!last) return; fn(e.clientX - last.x, e.clientY - last.y); last = { x: e.clientX, y: e.clientY } })
  button.addEventListener('pointerup', () => { last = null })
}

function setSidebar(open) {
  app.sidebar = open
  save('mv:sidebar', open)
  $('#sidebar').classList.toggle('open', open)
  syncToolbar()
  outliner.renderCard()
}

function toggleCameraView() {
  if (viewport.cameraView) viewport.exitCameraView()
  else if (!viewport.enterCameraView()) toast('This export has no camera — export with the scene camera to look through it')
  syncToolbar()
}

function buildLookMenu(menu) {
  const o = viewport.options
  const set = (key, value) => { viewport.setOption(key, value); persistOptions(); syncToolbar(); rebuild() }
  const rebuild = () => { put(menu, ); buildLookMenu(menu) }
  const seg = (items, value, onPick) => el('div', { class: 'seg' }, ...items.map(([id, label]) => el('button', { class: value === id ? 'on' : '', text: label, onclick: () => onPick(id) })))
  const toggle = (label, key, hint) => el('div', { class: 'mrow clickable', onclick: () => set(key, !o[key]), title: hint ?? '' }, el('span', { text: label }), el('i', { class: `toggle${o[key] ? ' on' : ''}` }))
  const modeName = { wire: 'Wireframe', solid: 'Solid', material: 'Material preview', rendered: 'Rendered' }[o.shading]
  menu.append(el('div', { class: 'mh', text: modeName }))
  if (o.shading === 'solid') {
    menu.append(el('div', { class: 'mrow' }, el('span', { text: 'Lighting' }), seg([['studio', 'Studio'], ['matcap', 'Matcap'], ['flat', 'Flat']], o.solidLight, (v) => set('solidLight', v))))
    menu.append(el('div', { class: 'mrow' }, el('span', { text: 'Colour' }), seg([['material', 'Material'], ['object', 'Object'], ['single', 'Single']], o.solidColor, (v) => set('solidColor', v))))
  }
  if (o.shading === 'material' || o.shading === 'rendered') {
    menu.append(el('div', { class: 'mrow' }, el('span', { text: 'Environment' })))
    menu.append(el('div', { class: 'mrow' }, seg(ENVIRONMENTS.map((e) => [e.id, e.name]), o.env, (v) => set('env', v))))
    if (viewport.sceneLights?.length) menu.append(toggle('Scene lights', 'sceneLights', 'The lights exported with the scene'))
  }
  if (o.shading === 'rendered') {
    menu.append(toggle('Shadows', 'shadows'), toggle('Ambient occlusion', 'ao'))
  }
  menu.append(el('div', { class: 'msep' }), el('div', { class: 'mh', text: 'Background' }))
  const bgs = BACKGROUNDS.filter((b) => b.id !== 'world' || o.shading === 'material' || o.shading === 'rendered')
  menu.append(el('div', { class: 'mrow' }, el('div', { class: 'swatches' }, ...bgs.map((b) => el('button', { class: o.background === b.id ? 'on' : '', title: b.name, style: { background: b.swatch }, onclick: () => set('background', b.id) }))), el('span', { text: bgs.find((b) => b.id === o.background)?.name ?? '' })))
  menu.append(el('div', { class: 'msep' }), el('div', { class: 'mh', text: 'Overlays' }))
  menu.append(toggle('Grid', 'grid'), toggle('Statistics', 'stats'), toggle('Selection outline', 'outline'))
  menu.append(el('div', { class: 'msep' }), el('div', { class: 'mh', text: 'Units' }))
  const src = { file: 'from the export', report: 'from report.json', guess: 'guessed from the size', chosen: 'as chosen' }[viewport.unitSource]
  menu.append(el('div', { class: 'mrow' }, seg([['auto', 'Auto'], ['mm', 'mm'], ['cm', 'cm'], ['m', 'm'], ['in', 'in']], o.units, (v) => { viewport.setUnits(v, app.report); persistOptions(); renderHud(); outliner.render(); measure.sync(); rebuild() })))
  menu.append(el('div', { class: 'mrow' }, el('span', { class: 'ms', text: `1 unit = ${mm(viewport.mmPerUnit)} · ${src}` })))
  // live changes in the menu re-render the HUD
  renderHud(); outliner.render()
}

function buildViewMenu(menu) {
  const item = (label, keys, fn, { on = false, disabled = false, iconName = null } = {}) => el('button', { class: `mi${on ? ' on' : ''}`, disabled, onclick: () => { closeMenu(); fn() } },
    el('span', { class: 'mic', html: iconName ? icon[iconName] : on ? icon.check : '' }), el('span', { class: 'ml', text: label }), keys ? el('span', { class: 'ms' }, ...keys.split(' ').map((k) => el('kbd', { text: k }))) : null)
  const nav = viewport.nav
  const go = (v, opposite) => () => { if (viewport.cameraView) viewport.exitCameraView(); nav.view(v, { opposite }); syncToolbar() }
  menu.append(
    el('div', { class: 'mh', text: 'Viewpoint' }),
    item('Front', '1', go('front')), item('Back', 'Ctrl 1', go('back')),
    item('Right', '3', go('right')), item('Left', 'Ctrl 3', go('left')),
    item('Top', '7', go('top')), item('Bottom', 'Ctrl 7', go('bottom')),
    item('User (three-quarter)', '', () => { if (viewport.cameraView) viewport.exitCameraView(); nav.view('iso'); syncToolbar() }),
    el('div', { class: 'msep' }),
    item(nav.orthographic ? 'Perspective' : 'Orthographic', '5', () => { nav.toggleOrtho(); syncToolbar() }, { iconName: nav.orthographic ? 'persp' : 'ortho' }),
    item('Frame all', 'Home', () => viewport.frameAll(), { iconName: 'frame' }),
    item('Frame selected', '.', () => viewport.frameSelected(), { disabled: !viewport.selection.size }),
    item(viewport.localView ? 'Leave local view' : 'Local view (isolate selected)', '/', () => { toggleLocal() }, { disabled: !viewport.selection.size && !viewport.localView, on: !!viewport.localView }),
    item('Turntable spin', 'T', () => { nav.spin = !nav.spin; viewport.invalidate() }, { on: nav.spin }),
    el('div', { class: 'msep' }),
    el('div', { class: 'mh', text: 'Cameras' }),
  )
  const cams = viewport.sceneCameraItems()
  if (!cams.length) menu.append(el('div', { class: 'mrow' }, el('span', { class: 'ms', text: 'No camera in this export' })))
  for (const [i, cam] of cams.entries()) menu.append(item(`Look through ${cam.name}`, i === 0 ? '0' : '', () => { viewport.enterCameraView(cam); syncToolbar() }, { on: viewport.cameraView?.item === cam, iconName: 'camera' }))
  menu.append(el('div', { class: 'msep' }),
    item('Show everything', 'Alt H', () => viewport.unhideAll(), { iconName: 'eye' }),
    item('Screenshot', 'P', () => screenshot(), { iconName: 'shot' }),
    item('Keyboard shortcuts', '?', () => showHelp(), { iconName: 'help' }))
}

function toggleLocal() {
  const on = viewport.toggleLocalView()
  if (!on && !viewport.localView && !viewport.selection.size) toast('Select something first, then press / to isolate it')
  renderHud()
}

// ---------------------------------------------------------------------------------------------------
// Tools: measure, section, explode

function setTool(name, on) {
  app.tools[name] = on
  if (name === 'measure') measure.setEnabled(on)
  if (name === 'section') viewport.setSection({ enabled: on })
  if (name === 'explode' && !on && viewport.explode) animateExplode(0, true)
  if (name === 'explode' && on && !viewport.explode) animateExplode(0.5, true)
  syncToolbar()
  renderPanels()
}

function animateExplode(to, reframe = false) {
  const from = viewport.explode
  const start = performance.now()
  if (reframe) viewport.frameAll(true, to)
  const step = (now) => {
    const t = Math.min(1, (now - start) / 420)
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    viewport.setExplode(from + (to - from) * k)
    renderExplodeValue()
    if (t < 1) requestAnimationFrame(step)
    else persist()
  }
  requestAnimationFrame(step)
}

function renderExplodeValue() {
  const r = $('#explode-range'); const v = $('#explode-val')
  if (r && document.activeElement !== r) { r.value = viewport.explode; r.style.setProperty('--fill', `${viewport.explode * 100}%`) }
  if (v) v.textContent = `${Math.round(viewport.explode * 100)}%`
}

function renderPanels() {
  const panels = []
  const close = (name) => el('button', { class: 'mini', html: icon.close, title: 'Close', onclick: () => setTool(name, false) })
  if (app.tools.section) {
    const s = viewport.section
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: s.offset, 'aria-label': 'Section position' })
    range.style.setProperty('--fill', `${s.offset * 100}%`)
    range.addEventListener('input', () => { viewport.setSection({ offset: Number(range.value) }); range.style.setProperty('--fill', `${range.value * 100}%`); $('#section-val').textContent = sectionLabel() })
    panels.push(el('div', { class: 'tool' },
      el('div', { class: 'tool-head' }, el('span', { class: 'ti', html: icon.section }), el('span', { class: 'tt', text: 'Section' }), el('span', { class: 'th', text: 'cut away to look inside' }),
        el('button', { class: `mini${s.flip ? ' on' : ''}`, html: `${icon.flip}<span>Flip</span>`, onclick: () => { viewport.setSection({ flip: !s.flip }); renderPanels() } }), close('section')),
      el('div', { class: 'tool-row' },
        el('div', { class: 'seg' }, ...['x', 'y', 'z'].map((a) => el('button', { 'data-axis': a, class: s.axis === a ? 'on' : '', text: a.toUpperCase(), onclick: () => { viewport.setSection({ axis: a }); renderPanels() } }))),
        range, el('span', { class: 'val', id: 'section-val', text: sectionLabel() }))))
  }
  if (app.tools.explode) {
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: viewport.explode, id: 'explode-range', 'aria-label': 'Explode' })
    range.style.setProperty('--fill', `${viewport.explode * 100}%`)
    range.addEventListener('input', () => { viewport.setExplode(Number(range.value)); range.style.setProperty('--fill', `${range.value * 100}%`); renderExplodeValue(); persist() })
    range.addEventListener('change', () => viewport.frameAll(true))
    const parts = viewport.items.filter((i) => i.meshes.length).length
    panels.push(el('div', { class: 'tool' },
      el('div', { class: 'tool-head' }, el('span', { class: 'ti', html: icon.explode }), el('span', { class: 'tt', text: 'Explode' }), el('span', { class: 'th', text: parts > 1 ? `${parts} parts, pulled apart from the centre` : 'one part — nothing to pull apart' }), close('explode')),
      el('div', { class: 'tool-row' }, range, el('span', { class: 'val', id: 'explode-val', text: `${Math.round(viewport.explode * 100)}%` }))))
  }
  if (app.tools.measure) {
    const list = measure.list.map((m, i) => {
      const r = measure.measure(m)
      return el('div', { class: 'mitem' }, el('span', { class: 'n', text: i + 1 }), el('span', { class: 'd', text: mm(r.distance) }),
        el('span', { class: 'delta' }, el('i', { class: 'ax-x', text: 'X' }), `${mm(r.dx, false)}  `, el('i', { class: 'ax-y', text: 'Y' }), `${mm(r.dy, false)}  `, el('i', { class: 'ax-z', text: 'Z' }), mm(r.dz, false)),
        el('button', { class: 'mini', html: icon.trash, title: 'Remove', onclick: () => measure.remove(i) }))
    })
    const hint = measure.pending ? 'now click the second point · Esc cancels' : measure.list.length ? 'click two more points for another' : 'click two points on the model · snaps to corners'
    panels.push(el('div', { class: 'tool' },
      el('div', { class: 'tool-head' }, el('span', { class: 'ti', html: icon.measure }), el('span', { class: 'tt', text: 'Measure' }), el('span', { class: 'th', text: hint }),
        measure.list.length ? el('button', { class: 'mini', text: 'Clear', onclick: () => measure.clear() }) : null, close('measure')),
      list.length ? el('div', { class: 'mlist' }, ...list) : null))
  }
  put($('#panels'), ...panels)
  stage.classList.toggle('has-panels', panels.length > 0)
}

function sectionLabel() {
  const s = viewport.section
  if (s.at === undefined) return ''
  const value = (s.axis === 'y' ? -s.at : s.at) * viewport.mmPerUnit
  return `${s.axis.toUpperCase()} ${mm(value)}`
}

// ---------------------------------------------------------------------------------------------------
// Timeline

function renderTimeline() {
  const a = viewport.anim?.visible ? viewport.anim : null
  const bar = $('#timeline')
  bar.hidden = !a
  stage.classList.toggle('has-timeline', !!a)
  if (!a) return
  $('#tl-end').textContent = Math.round(a.end * a.fps)
  $('#tl-name').textContent = a.clips.map((c) => c.name).join(', ')
  $('#tl-name').title = `${a.clips.length} action${a.clips.length > 1 ? 's' : ''} at ${a.fps} fps`
  renderTimelineTime()
}

function renderTimelineTime() {
  const a = viewport.anim
  if (!a) return
  const scrub = $('#tl-scrub')
  const f = (a.time - a.start) / Math.max(a.end - a.start, 1e-6)
  if (document.activeElement !== scrub) scrub.value = f
  scrub.style.setProperty('--fill', `${f * 100}%`)
  $('#tl-frame').textContent = Math.round(a.time * a.fps)
  $('#tl-play').innerHTML = a.playing ? icon.pause : icon.play
  $('#tl-play').classList.toggle('on', a.playing)
}

function togglePlay() {
  const a = viewport.anim
  if (!a?.visible) return
  if (!a.playing && a.time >= a.end - 1e-4) viewport.setTime(a.start)
  a.playing = !a.playing
  viewport.invalidate()
  renderTimelineTime()
}
$('#tl-play').addEventListener('click', togglePlay)
$('#tl-scrub').addEventListener('input', (e) => { const a = viewport.anim; if (!a) return; a.playing = false; viewport.setTime(a.start + Number(e.target.value) * (a.end - a.start)) })
$('#tl-speed').addEventListener('change', (e) => { if (viewport.anim) viewport.anim.speed = Number(e.target.value) })

// ---------------------------------------------------------------------------------------------------
// Clicks in the viewport

function onViewportClick(e) {
  if (measure.enabled) { measure.click(e); return }
  const hit = viewport.pick(e.clientX, e.clientY)
  const extend = e.shiftKey || e.metaKey || e.ctrlKey
  if (!hit) { if (!extend) viewport.select(null); return }
  viewport.select(hit.item, { extend, toggle: extend })
}

let hoverFrame = 0, hoverEvent = null
function onViewportHover(e) {
  hoverEvent = e
  if (hoverFrame) return
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0
    if (measure.enabled) { measure.hover(hoverEvent); return }
    // a faint outline on what a click would select
    const hit = viewport.pick(hoverEvent.clientX, hoverEvent.clientY)
    viewport.setHover(hit?.item ?? null)
    $('#gl').classList.toggle('over-object', !!hit)
  })
}
$('#gl').addEventListener('pointerleave', () => { viewport.setHover(null); $('#gl').classList.remove('over-object') })

// ---------------------------------------------------------------------------------------------------
// Keyboard: Blender's numpad (and the top row, as Blender's "emulate numpad"), and the rest

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return }
  if ($('.menu') && e.key === 'Escape') { closeMenu(); return }
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') { hideHelp(); e.preventDefault() } return }
  const nav = viewport.nav
  const ctrl = e.ctrlKey || e.metaKey
  const code = e.code
  const digit = /^(Digit|Numpad)(\d)$/.exec(code)?.[2]
  const leaveCam = () => { if (viewport.cameraView) viewport.exitCameraView() }
  let handled = true
  if (app.view !== 'model') {
    if (e.key === 'v' || e.key === 'V' || e.key === 'Escape') setView('model')
    else if (e.key === ' ' && app.view === 'video') { const v = $('#video'); v.paused ? v.play() : v.pause() }
    else handled = false
    if (handled) e.preventDefault()
    return
  }
  if (digit && !e.altKey) {
    if (digit === '1') { leaveCam(); nav.view('front', { opposite: ctrl }) }
    else if (digit === '3') { leaveCam(); nav.view('right', { opposite: ctrl }) }
    else if (digit === '7') { leaveCam(); nav.view('top', { opposite: ctrl }) }
    else if (digit === '9') { leaveCam(); nav.opposite() }
    else if (digit === '5') nav.toggleOrtho()
    else if (digit === '0') toggleCameraView()
    else if (digit === '2') { leaveCam(); nav.orbitStep(0, -Math.PI / 12) }
    else if (digit === '8') { leaveCam(); nav.orbitStep(0, Math.PI / 12) }
    else if (digit === '4') { leaveCam(); nav.orbitStep(Math.PI / 12, 0) }
    else if (digit === '6') { leaveCam(); nav.orbitStep(-Math.PI / 12, 0) }
    else handled = false
    syncToolbar()
  } else if (code === 'NumpadDecimal' || (e.key === '.' && !ctrl) || (e.key === 'f' && !ctrl)) { leaveCam(); viewport.frameSelected() }
  else if (e.key === 'Home') { leaveCam(); viewport.frameAll() }
  else if (code === 'NumpadDivide' || e.key === '/') { toggleLocal() }
  else if (e.key === 'NumpadAdd' || code === 'NumpadAdd' || (e.key === '=' && !ctrl)) viewport.nav.zoom(0.8)
  else if (code === 'NumpadSubtract' || (e.key === '-' && !ctrl)) viewport.nav.zoom(1.25)
  else if (code === 'KeyH' && e.altKey) viewport.unhideAll()
  else if (code === 'KeyH' && e.shiftKey) viewport.hideUnselected()
  else if (code === 'KeyH' && !ctrl) viewport.hideSelected()
  else if (code === 'KeyA' && e.altKey) viewport.select(null)
  else if (code === 'KeyA' && !ctrl && !e.shiftKey) viewport.selectAll()
  else if (code === 'KeyZ' && e.altKey) { viewport.setOption('xray', !viewport.options.xray); persistOptions(); syncToolbar() }
  else if (code === 'KeyZ' && e.shiftKey) setShading(viewport.options.shading === 'wire' ? 'solid' : 'wire')
  else if (code === 'KeyZ' && !ctrl) { const order = ['solid', 'material', 'rendered', 'wire']; setShading(order[(order.indexOf(viewport.options.shading) + 1) % order.length]) }
  else if (code === 'KeyM' && !ctrl) setTool('measure', !app.tools.measure)
  else if (code === 'KeyC' && !ctrl) setTool('section', !app.tools.section)
  else if (code === 'KeyE' && !ctrl) setTool('explode', !app.tools.explode)
  else if (code === 'KeyN' && !ctrl) setSidebar(!app.sidebar)
  else if (code === 'KeyT' && !ctrl) { nav.spin = !nav.spin; viewport.invalidate() }
  else if (code === 'KeyP' && !ctrl) screenshot()
  else if (code === 'KeyV' && !ctrl) { if (videoEntry()) setView('video') }
  else if (code === 'KeyG' && !ctrl) { viewport.setOption('grid', !viewport.options.grid); persistOptions() }
  else if (e.key === ' ') togglePlay()
  else if (e.key === 'ArrowLeft' && viewport.anim) { viewport.anim.playing = false; viewport.setTime(e.shiftKey ? viewport.anim.start : viewport.anim.time - 1 / viewport.anim.fps) }
  else if (e.key === 'ArrowRight' && viewport.anim) { viewport.anim.playing = false; viewport.setTime(e.shiftKey ? viewport.anim.end : viewport.anim.time + 1 / viewport.anim.fps) }
  else if (e.key === '?' || e.key === 'F1') showHelp()
  else if ((e.key === 'Backspace' || (ctrl && code === 'KeyZ')) && measure.enabled) measure.undo()
  else if (e.key === 'Escape') {
    if (measure.enabled && measure.pending) measure.undo()
    else if (viewport.cameraView) viewport.exitCameraView()
    else if (app.tools.measure) setTool('measure', false)
    else if (viewport.selection.size) viewport.select(null)
    else if (viewport.localView) toggleLocal()
    else handled = false
  } else handled = false
  if (handled) { e.preventDefault(); syncToolbar() }
})

// ---------------------------------------------------------------------------------------------------
// Menus, toasts, help, screenshot

let openMenuEl = null
function openMenu(anchor, build, { align = 'left' } = {}) {
  closeMenu()
  const menu = el('div', { class: 'menu', role: 'menu' })
  build(menu)
  document.body.append(menu)
  const r = anchor.getBoundingClientRect()
  const w = menu.offsetWidth, h = menu.offsetHeight
  let left = align === 'right' ? r.right - w : r.left
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  let top = r.bottom + 6
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` })
  openMenuEl = { menu, anchor }
  anchor.classList.add('menu-open')
  setTimeout(() => document.addEventListener('pointerdown', outside, true))
}
function outside(e) { if (openMenuEl && !openMenuEl.menu.contains(e.target) && !openMenuEl.anchor.contains(e.target)) closeMenu() }
function closeMenu() {
  if (!openMenuEl) return
  openMenuEl.menu.remove()
  openMenuEl.anchor.classList.remove('menu-open')
  openMenuEl = null
  document.removeEventListener('pointerdown', outside, true)
}

let toastTimer = null
function toast(html, { kind = 'info', action = null, ms = 2600 } = {}) {
  const t = $('#toast')
  put(t, 
    kind === 'ok' ? el('span', { class: 'ti', html: icon.check }) : null,
    el('span', { class: 'tmsg', html }),
    action ? el('button', { text: action.label, onclick: () => { action.run(); t.hidden = true } }) : null)
  t.hidden = false
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, ms)
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

const HELP = [
  ['Navigate', [['Drag', 'Orbit'], ['Shift Drag', 'Pan'], ['Right Drag', 'Pan'], ['Scroll · Pinch', 'Zoom to the cursor'], ['Two-finger swipe', 'Orbit (Shift: pan)'], ['Home', 'Frame all'], ['. F', 'Frame selected'], ['Double-click', 'Frame what you click']]],
  ['Views (numpad or top row)', [['1  3  7', 'Front · Right · Top'], ['Ctrl 1 3 7', 'Back · Left · Bottom'], ['9', 'Opposite side'], ['2 4 6 8', 'Orbit in 15° steps'], ['5', 'Perspective / orthographic'], ['0', 'Through the scene camera'], ['T', 'Turntable spin']]],
  ['Select and show', [['Click', 'Select'], ['Shift Click', 'Add to selection'], ['A · Alt A', 'Select all · none'], ['H', 'Hide selected'], ['Shift H', 'Hide the rest'], ['Alt H', 'Show everything'], ['/', 'Local view (isolate)'], ['N', 'Outliner and properties']]],
  ['Shading and tools', [['Z', 'Next shading mode'], ['Shift Z', 'Wireframe'], ['Alt Z', 'X-ray'], ['G', 'Grid'], ['M', 'Measure'], ['C', 'Section plane'], ['E', 'Exploded view'], ['P', 'Screenshot'], ['Space', 'Play the animation'], ['V', 'Turntable video']]],
]
function showHelp() {
  const box = $('#help')
  put(box, el('div', { class: 'help-card', onclick: (e) => e.stopPropagation() },
    el('h2', { text: 'Keyboard and mouse' }),
    el('div', { class: 'sub', text: 'Blender’s viewport keys. Editing happens in the chat — this pane is for looking closely.' }),
    el('div', { class: 'help-cols' }, ...HELP.map(([title, rows]) => el('div', {}, el('h5', { text: title }), el('dl', {}, ...rows.flatMap(([k, d]) => [el('dt', {}, ...k.split(/\s{2,}| (?=[A-Z0-9.\/])/).filter(Boolean).map((part) => el('kbd', { text: part }))), el('dd', { text: d })])))))))
  box.hidden = false
  box.onclick = hideHelp
}
function hideHelp() { $('#help').hidden = true }
$('#help-btn').addEventListener('click', showHelp)

async function screenshot() {
  if (!app.current) { toast('Nothing to capture yet'); return }
  const bg = viewport.options.background
  const blob = await viewport.capture(2, (g, w, h) => paintBackground(g, w, h, stage.dataset.bg || bg))
  if (!blob) { toast('Could not capture the view'); return }
  const name = `${(app.current.path.split('/').pop() || 'model').replace(/\.[^.]+$/, '')}-${viewport.nav.viewName().split(' ')[0].toLowerCase()}.png`
  const download = () => { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove() }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    toast('<b>Screenshot copied</b> to the clipboard', { kind: 'ok', action: { label: 'Save PNG', run: download }, ms: 4000 })
  } catch {
    download()
    toast(`<b>Screenshot saved</b> · ${escapeHtml(name)}`, { kind: 'ok' })
  }
}
$('#shot-btn').addEventListener('click', screenshot)

function paintBackground(g, w, h, id) {
  if (id === 'dark') { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#474747'); gr.addColorStop(0.55, '#3a3a3a'); gr.addColorStop(1, '#2f2f2f'); g.fillStyle = gr }
  else if (id === 'white') g.fillStyle = '#ffffff'
  else if (id === 'black') { const gr = g.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.7); gr.addColorStop(0, '#232326'); gr.addColorStop(0.7, '#141416'); gr.addColorStop(1, '#0c0c0d'); g.fillStyle = gr }
  else if (id === 'world') return
  else { const gr = g.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h * 0.38, Math.max(w, h) * 0.66); gr.addColorStop(0, '#fbfbfa'); gr.addColorStop(0.55, '#efefec'); gr.addColorStop(1, '#e2e2de'); g.fillStyle = gr }
  g.fillRect(0, 0, w, h)
}

// ---------------------------------------------------------------------------------------------------
// Boot

setSidebar(app.sidebar)
syncToolbar()
renderStatus()
if (params.get('view') === 'video' || params.get('view') === 'still') setView(params.get('view'))
connect()
// A test and debugging handle; nothing in the page depends on it.
window.__viewer = { app, viewport, outliner, measure, setTool, setShading, setView, toggleCameraView, AXIS_DIR }
