// MuJoCo Viewer: simulate, in the pane.
//
// One model, three views of it. SIMULATE steps mj_step live — from the rollout's first frame with
// the controls the agent's controller produced (so the robot does what it did, for real, and keeps
// going), or from a keyframe — and the user can shove bodies, drive actuators, pose joints. REPLAY
// plays the recorded trajectory exactly, scrubbable; "Simulate from here" hands any frame to the
// physics. VIDEO is the mp4, when there is one, and never the default.
//
// The pane follows the agent: the server streams workspace changes, and a new rollout, an edited
// scene or a recompiled model reloads in place, keeping the camera, selection and panel.
import { Engine } from './engine.js'
import { Stage } from './scene.js'
import { Panel } from './panel.js'
import { Plot, fmt } from './plot.js'

const params = new URLSearchParams(location.search)
const FILE = (params.get('file') || '').replace(/^\/+/, '')
let pickedModel = params.get('model') || null

const $ = (id) => document.getElementById(id)
const body = document.body

// ─── Preferences (this browser) and session state (this pane, across reloads) ─────────────────

const PREFS_KEY = 'mujoco-viewer:prefs:v1'
const DEFAULT_VIS = {
  contactpoint: false, contactforce: false, joint: false, actuator: false, tendon: true, com: false, inertia: false,
  frame: 'none', sites: false, transparent: false, wireframe: false, shadows: true, reflections: true, skybox: true,
  groups: [1, 1, 1, 0, 0, 0],
}
function readStore(store, key, fallback) { try { return JSON.parse(store.getItem(key)) ?? fallback } catch { return fallback } }
function writeStore(store, key, value) { try { store.setItem(key, JSON.stringify(value)) } catch { /* private mode */ } }
const prefs = readStore(localStorage, PREFS_KEY, {})
const vis = { ...DEFAULT_VIS, ...(prefs.vis ?? {}) }
function savePrefs() { writeStore(localStorage, PREFS_KEY, { ...prefs, vis }) }
const cameraKey = (model) => `mujoco-viewer:camera:${model}`
const SESSION_KEY = 'mujoco-viewer:session'

// ─── State ────────────────────────────────────────────────────────────────────────────────────

const state = {
  mode: 'sim',
  playing: true,
  speed: Number(prefs.speed) || 1,
  resolved: null,
  modelKey: null,
  modelPath: null,
  traj: null,
  trajKey: null,
  follow: null,             // the rollout whose controls the live simulation replays
  cursor: 0,
  ctrlSource: 'keyframe',   // recording | keyframe | manual
  start: 'rollout',         // what Reset returns to: 'rollout' | 'key:<n>' | 'qpos0'
  simSnapshot: null,        // the live state, kept while replay borrows the data
  selected: -1,
  selectedJoint: -1,
  selectedActuator: -1,
  selectedSensor: -1,
  lastInteraction: 0,
  rtf: 1,
  slow: false,
  warnings: 0,
  perturb: null,
  videoStamp: null,
  error: null,
}

let engine = null
let stage = null
let panel = null
let plot = null

// ─── Small UI helpers ─────────────────────────────────────────────────────────────────────────

function overlay(content, { progress = null, spinner = true } = {}) {
  const card = $('overlay').querySelector('.card')
  if (typeof content === 'string') {
    card.replaceChildren()
    if (spinner) card.append(Object.assign(document.createElement('div'), { className: 'spinner' }))
    const text = document.createElement('div'); text.id = 'overlay-text'; text.textContent = content
    card.append(text)
    if (progress !== null) {
      const bar = document.createElement('div'); bar.className = 'progress'
      const fill = document.createElement('i'); fill.id = 'overlay-bar'; fill.style.width = `${Math.round(progress * 100)}%`
      bar.append(fill); card.append(bar)
    }
  } else {
    card.replaceChildren(...content)
  }
  $('overlay').hidden = false
}
function hideOverlay() { $('overlay').hidden = true }

function node(tag, props = {}, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v)
  }
  n.append(...children)
  return n
}

function toast(text, ms = 2600) {
  const t = node('div', { class: 'toast', text })
  $('toasts').append(t)
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320) }, ms)
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove()
}

function notice(content) {
  const n = $('notice')
  if (!content) { n.hidden = true; n.replaceChildren(); return }
  n.replaceChildren(...content)
  n.hidden = false
}

function touch() { state.lastInteraction = performance.now() }

// ─── Loading ──────────────────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error || `${url} → ${res.status}`)
  return body
}

async function readTrajectory(path) {
  try {
    const res = await fetch(`/ws/${path.split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const t = await res.json()
    if (!t || !Array.isArray(t.qpos) || !t.qpos.length) return null
    const dt = Number(t.dt) > 0 ? Number(t.dt) : 1 / 30
    const n = t.qpos.length
    return {
      path, raw: t, model: t.model, dt, n, status: t.status || 'done',
      time0: Array.isArray(t.time) && t.time.length ? Number(t.time[0]) : 0,
      qpos: t.qpos, qvel: Array.isArray(t.qvel) && t.qvel.length === n ? t.qvel : null,
      ctrl: Array.isArray(t.ctrl) && t.ctrl.length === n && t.ctrl[0]?.length ? t.ctrl : null,
      act: Array.isArray(t.act) && t.act.length === n ? t.act : null,
      expected: Number(t.frames_expected) || n, seconds: Number(t.seconds) || (n - 1) * dt,
      track: typeof t.track === 'string' ? t.track : null, patch: t.model_patch && typeof t.model_patch === 'object' ? t.model_patch : null,
    }
  } catch { return null }
}

let refreshing = false
let refreshQueued = false

async function refresh({ initial = false } = {}) {
  if (refreshing) { refreshQueued = true; return }
  refreshing = true
  try {
    const r = await getJson(`/api/resolve?file=${encodeURIComponent(FILE)}${pickedModel ? `&model=${encodeURIComponent(pickedModel)}` : ''}`)
    state.resolved = r
    updateVideo(r)

    const trajKey = r.trajectory ? `${r.trajectory}|${r.stamps.trajectory}` : null
    let traj = state.traj
    const trajChanged = trajKey !== state.trajKey
    if (trajChanged) traj = r.trajectory ? await readTrajectory(r.trajectory) : null
    if (traj && traj.model !== r.model) traj = null

    if (!r.model) {
      state.trajKey = trajKey
      await showEmpty(r)
      return
    }
    const modelKey = [r.model, r.modelXml, r.stamps.model, r.stamps.modelXml, JSON.stringify(traj?.patch ?? null)].join('|')
    let reloaded = false
    if (modelKey !== state.modelKey) {
      const ok = await loadModel(r, traj, { initial })
      if (!ok) { state.trajKey = trajKey; return }
      state.modelKey = modelKey
      reloaded = true
    }
    if (traj && traj.qpos[0].length !== engine.model.nq) {
      toast(`The rollout has ${traj.qpos[0].length} qpos per frame but the model has ${engine.model.nq}; replay is off until they match`, 4200)
      traj = null
    }
    if (trajChanged || reloaded) applyTrajectory(traj, { fresh: trajChanged && !initial, initial, reloaded })
    state.trajKey = trajKey
    renderTitle()
  } catch (error) {
    console.error(error)
    if (!engine?.model) showError('The viewer could not open this workspace', String(error.message ?? error))
    else toast(`Could not refresh: ${String(error.message ?? error).slice(0, 120)}`, 4000)
  } finally {
    refreshing = false
    if (refreshQueued) { refreshQueued = false; refresh() }
  }
}

async function loadModel(r, traj, { initial }) {
  const first = !engine.model
  const sameModel = state.modelPath === r.model
  const label = r.model.startsWith('menagerie/') ? r.model.split('/')[1] : r.model
  if (first) overlay(`Loading ${label}…`, { progress: 0 })
  else notice([node('div', { class: 'text' }, node('b', { text: 'Reloading the model' }), node('span', { text: ` · ${label}` }))])
  try {
    const { files } = await getJson(`/api/files?model=${encodeURIComponent(r.model)}${r.modelXml ? `&xml=${encodeURIComponent(r.modelXml)}` : ''}`)
    await engine.sync(files, (done, total, bytes, allBytes) => {
      if (first) overlay(`Loading ${label}… ${done} / ${total} files`, { progress: allBytes ? bytes / allBytes : done / total })
    })
    const saved = first ? null : captureSession()
    try {
      engine.load({ model: r.model, modelXml: r.modelXml, patch: traj?.patch })
    } catch (error) {
      // An asset the MJCF scan missed (a <model> attachment, an unusual path): copy the whole directory and try once more.
      if (!/open|resource|file/i.test(String(error.message))) throw error
      const dir = r.model.includes('/') ? r.model.slice(0, r.model.lastIndexOf('/')) : ''
      const listing = await getJson(`/api/list?dir=${encodeURIComponent(dir)}`)
      await engine.sync(listing.files)
      engine.load({ model: r.model, modelXml: r.modelXml, patch: traj?.patch })
    }
    state.modelPath = r.model
    state.selected = state.selectedJoint = state.selectedActuator = state.selectedSensor = -1
    state.warnings = 0
    stage.build(engine, { keepCamera: sameModel && !first })
    if (!sameModel || first) {
      const camera = readStore(sessionStorage, cameraKey(r.model), null)
      if (camera) stage.restoreCamera(camera)
      stage.setCameraMode({ kind: 'free' }, engine)
    }
    panel.setModel(engine.info)
    fillKeyframes()
    fillCameraMenu()
    choosePlotSignals()
    state.error = null
    if (saved) restoreSession(saved)
    else if (initial) restoreSession(readStore(sessionStorage, SESSION_KEY, null), { onlyView: true })
    hideOverlay()
    notice(null)
    if (!first) toast(sameModel ? 'Model reloaded' : `Opened ${label}`)
    body.classList.add('loaded')
    body.classList.remove('no-model')
    return true
  } catch (error) {
    console.error(error)
    const message = String(error.message ?? error).replace(/^MuJoCo Error:\s*/, '')
    if (first) showError(`${label} did not compile`, message, 'The agent may be mid-edit; this pane reloads when the file changes.')
    else {
      notice([
        node('div', { class: 'text' }, node('b', { text: `${label} does not compile yet` }), node('span', { text: ` · ${message.slice(0, 140)}` })),
        node('button', { type: 'button', text: 'Dismiss', onclick: () => notice(null) }),
      ])
    }
    return false
  }
}

function showError(title, message, hint = '') {
  overlay([
    node('h2', { text: title }),
    node('pre', { text: message.slice(0, 1200) }),
    ...(hint ? [node('p', { text: hint })] : []),
  ])
  if (!engine?.model) body.classList.add('no-model', 'loaded')
}

async function showEmpty(r) {
  let models = { robots: [], scenes: [] }
  try { models = await getJson('/api/models') } catch { /* no picker then */ }
  const pick = (path) => { pickedModel = path; syncUrl(); refresh() }
  const items = [
    node('h2', { text: r.missing ? `${r.missing} is not there` : 'Nothing to simulate yet' }),
    node('p', { text: 'Ask the agent for a robot and a behaviour — “make the Go2 stand up”, “a pendulum on a cart” — and it opens here as a live simulation you can push around.' }),
  ]
  if (models.scenes.length) {
    items.push(node('p', { text: 'Scenes in this workspace:' }))
    items.push(node('div', { class: 'robots' }, ...models.scenes.slice(0, 8).map((s) => node('button', { type: 'button', text: s.name, onclick: () => pick(s.path) }))))
  }
  if (models.robots.length) {
    items.push(node('p', { text: 'Or look at a Menagerie robot now:' }))
    items.push(node('div', { class: 'robots' }, ...models.robots.map((s) => node('button', { type: 'button', text: s.name, onclick: () => pick(s.path) }))))
  }
  overlay(items)
  body.classList.add('no-model')
  if (!engine?.model) body.classList.add('loaded')
  renderTitle()
}

function syncUrl() {
  const url = new URL(location.href)
  if (pickedModel) url.searchParams.set('model', pickedModel); else url.searchParams.delete('model')
  history.replaceState(null, '', url)
}

// ─── Trajectory ───────────────────────────────────────────────────────────────────────────────

function applyTrajectory(traj, { fresh, initial, reloaded }) {
  const previous = state.traj
  state.traj = traj
  $('modes').querySelector('[data-mode=replay]').disabled = !traj
  renderAgent()
  if (!traj) {
    if (state.mode === 'replay') setMode('sim')
    if (initial || reloaded) { state.start = engine.model.nkey ? 'key:0' : 'qpos0'; resetSim() }
    renderTimeline()
    return
  }
  $('scrub').max = String(traj.n - 1)
  const recording = traj.status === 'recording'
  if (initial || (reloaded && !fresh)) {
    state.start = 'rollout'
    if (state.mode !== 'replay') { resetSim(); state.playing = !recording || true }
    else showFrame(state.cursor)
  } else if (fresh) {
    const wasRecording = previous?.status === 'recording'
    if (recording) {
      if (!wasRecording) toast('The agent is recording a new rollout')
      if (state.mode === 'replay') { state.cursor = Math.min(state.cursor, traj.n - 1) }
    } else {
      const idle = performance.now() - state.lastInteraction > 6000
      const summary = `${fmt((traj.n - 1) * traj.dt)} s rollout`
      state.start = 'rollout'
      if (state.mode === 'replay') {
        state.cursor = 0; state.playing = true
        toast(`New ${summary} from the agent`)
      } else if (idle || reloaded) {
        resetSim()
        state.playing = true
        toast(traj.ctrl ? `New ${summary} — simulating it live` : `New ${summary}`)
      } else {
        notice([
          node('div', { class: 'text' }, node('b', { text: `New ${summary} from the agent` })),
          node('button', { type: 'button', class: 'accent', text: 'Simulate it', onclick: () => { notice(null); state.start = 'rollout'; resetSim(); state.playing = true; setMode('sim') } }),
          node('button', { type: 'button', text: 'Replay', onclick: () => { notice(null); state.cursor = 0; state.playing = true; setMode('replay') } }),
          node('button', { type: 'button', text: '×', onclick: () => notice(null) }),
        ])
      }
    }
  }
  fillKeyframes()
  renderTimeline()
  if (state.mode === 'replay') replayPlot()
}

/** Row `i` of the rollout as MuJoCo state; velocities from the recording, or differenced from qpos. */
function frameState(i) {
  const t = state.traj
  const k = Math.max(0, Math.min(t.n - 1, Math.round(i)))
  let qvel = t.qvel ? t.qvel[k] : null
  if (!qvel && t.n > 1) {
    const a = t.qpos[Math.max(0, k - 1)], b = t.qpos[Math.min(t.n - 1, Math.max(1, k))]
    try {
      const m = engine.mujoco
      const out = new m.DoubleBuffer(engine.model.nv)
      m.mj_differentiatePos(engine.model, out, t.dt, a, b)
      qvel = Array.from(out.GetView())
      out.delete()
    } catch { qvel = null }
  }
  return { qpos: t.qpos[k], qvel, act: t.act?.[k], ctrl: t.ctrl?.[k], time: t.time0 + k * t.dt }
}

/** The controls the live simulation follows: the rollout it started from, interpolated between frames. */
function recordedCtrl(time) {
  const t = state.follow
  const ctrl = engine.data.ctrl
  if (!t?.ctrl || t.ctrl[0].length !== ctrl.length) return
  const u = (time - t.time0) / t.dt
  if (u >= t.n - 1) { const last = t.ctrl[t.n - 1]; for (let i = 0; i < ctrl.length; i++) ctrl[i] = last[i]; return }
  const k = Math.max(0, Math.floor(u)), f = Math.max(0, u - k)
  const a = t.ctrl[k], b = t.ctrl[k + 1]
  for (let i = 0; i < ctrl.length; i++) ctrl[i] = a[i] + (b[i] - a[i]) * f
}

// ─── Simulation ───────────────────────────────────────────────────────────────────────────────

function resetSim() {
  if (!engine.model) return
  engine.endPerturb()
  engine.clearPerturbForce()
  const start = state.start
  if (start === 'rollout' && state.traj) {
    engine.resetTo(-1)
    engine.setState(frameState(0))
    state.follow = state.traj
    state.ctrlSource = state.traj.ctrl ? 'recording' : (engine.model.nkey ? 'keyframe' : 'manual')
    if (!state.traj.ctrl && engine.model.nkey) { const kc = engine.model.key_ctrl; engine.data.ctrl.set(kc.subarray(0, engine.model.nu)) }
  } else if (start.startsWith('key:')) {
    engine.resetTo(Number(start.slice(4)))
    state.ctrlSource = 'keyframe'
  } else {
    engine.resetTo(-1)
    state.ctrlSource = 'manual'
  }
  plot.clear()
  state.warnings = engine.warnings()
  renderTimeline()
}

function simulateFrom(frame) {
  if (!state.traj) return
  const s = frameState(frame)
  engine.setState(s)
  state.follow = state.traj
  state.ctrlSource = state.traj.ctrl ? 'recording' : 'manual'
  state.simSnapshot = null
  state.playing = true
  setMode('sim', { keepState: true })
  plot.clear()
  toast(`Simulating from ${fmt(s.time)} s`)
}

const BUDGET_MS = 9

/**
 * Step until simulated time catches up with wall time × speed, within a per-frame budget so a model
 * too heavy for real time runs in slow motion (and says so) instead of stalling the page. At most
 * 0.25 s is made up per frame (a slow renderer still gets real-time physics); a pane that was hidden resumes, it does not fast-forward.
 */
function stepSim(elapsed, wallElapsed = elapsed) {
  const m = engine.mujoco, model = engine.model, d = engine.data
  const perturbing = Boolean(engine.perturb?.active)
  if (!state.playing) {
    if (perturbing) engine.applyPerturbPose()
    state.rtf = 0
    return
  }
  const target = Math.min(elapsed, 0.25) * state.speed
  const t0 = d.time
  const wall = performance.now()
  const following = state.ctrlSource === 'recording' && state.follow?.ctrl
  let steps = 0
  state.slow = false
  while (d.time - t0 < target) {
    if (following) recordedCtrl(d.time)
    if (perturbing) engine.applyPerturbForce()
    m.mj_step(model, d)
    steps++
    if (d.time < t0) break                              // MuJoCo reset the data after an instability
    if ((steps & 3) === 0 && performance.now() - wall > BUDGET_MS) { state.slow = true; break }
  }
  const advanced = d.time - t0
  if (wallElapsed > 0 && wallElapsed < 0.3) {           // a hidden or throttled pane gives no reading
    state.rtf = state.rtf * 0.85 + (advanced / wallElapsed) * 0.15
  }
  const warnings = engine.warnings()
  if (warnings > state.warnings) {
    state.warnings = warnings
    toast('The simulation went unstable and MuJoCo reset it')
    plot.clear()
  }
}

function singleStep() {
  touch()
  if (state.mode === 'video') { const v = $('video'); v.pause(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 1 / 30); return }
  if (state.mode === 'replay') { state.playing = false; showFrame(Math.floor(state.cursor) + 1); renderTransport(); return }
  if (state.mode !== 'sim') return
  state.playing = false
  if (state.ctrlSource === 'recording' && state.follow?.ctrl) recordedCtrl(engine.data.time)
  if (engine.perturb?.active) engine.applyPerturbForce()
  engine.mujoco.mj_step(engine.model, engine.data)
  renderTransport()
}

// ─── Replay ───────────────────────────────────────────────────────────────────────────────────

let shownFrame = -1
function showFrame(cursor) {
  const t = state.traj
  if (!t) return
  state.cursor = Math.max(0, Math.min(t.n - 1, cursor))
  const k = Math.floor(state.cursor)
  if (k === shownFrame && Number.isInteger(state.cursor)) return
  shownFrame = k
  const s = frameState(k)
  engine.setState(s)
}

function captureSim() {
  const d = engine.data
  return { qpos: Array.from(d.qpos), qvel: Array.from(d.qvel), act: Array.from(d.act), ctrl: Array.from(d.ctrl), time: d.time, ctrlSource: state.ctrlSource }
}

/** Replay plots the whole recording, computed frame by frame through mj_forward; the cursor follows the scrubber. */
function replayPlot() {
  const t = state.traj
  const signal = plot.signal
  if (!t || !signal || state.mode !== 'replay') return
  const step = Math.max(1, Math.floor(t.n / 700))
  const samples = []
  for (let k = 0; k < t.n; k += step) {
    engine.setState(frameState(k))
    samples.push([t.time0 + k * t.dt, ...signal.series.map((x) => { const v = x.get(); return Number.isFinite(v) ? v : NaN })])
  }
  shownFrame = -1
  showFrame(state.cursor)
  plot.setStatic(samples)
}

function setMode(mode, { keepState = false } = {}) {
  if (mode === 'replay' && !state.traj) return
  if (mode === 'video' && !state.resolved?.video) return
  const from = state.mode
  if (from === mode) return
  touch()
  if (from === 'sim' && mode !== 'sim' && engine.model) state.simSnapshot = captureSim()
  engine.endPerturb?.()
  state.mode = mode
  if (mode === 'sim' && !keepState && state.simSnapshot) {
    const snap = state.simSnapshot
    engine.setState(snap)
    state.ctrlSource = snap.ctrlSource
    state.simSnapshot = null
  }
  if (mode === 'replay') { shownFrame = -1; showFrame(state.cursor); replayPlot() }
  if (from === 'replay' && mode !== 'replay') plot.clear()
  const video = $('video')
  if (mode === 'video') { video.hidden = false; video.play().catch(() => {}) } else { video.pause(); video.hidden = true }
  if (from === 'video' && mode !== 'video') state.playing = true
  $('hud').hidden = mode === 'video'
  $('camera-chip').hidden = mode === 'video' || stage.cameraMode.kind === 'free'
  if (mode === 'video') { $('chip').hidden = true; notice(null) } else renderChip()
  $('modes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode))
  body.classList.toggle('mode-sim', mode === 'sim')
  body.classList.toggle('mode-replay', mode === 'replay')
  body.classList.toggle('mode-video', mode === 'video')
  renderTransport()
  renderTimeline()
  saveSession()
}

// ─── Perturbation: double-click to select, ⌘/Ctrl-drag to push, ⇧ to twist ────────────────────

function visibleGroups() { return vis.groups.map((g) => (g ? 1 : 0)) }

function select(bodyId, { point = null, joint = -1, actuator = -1, sensor = -1, quiet = false } = {}) {
  state.selected = bodyId > 0 ? bodyId : -1
  state.selectedJoint = joint
  state.selectedActuator = actuator
  state.selectedSensor = sensor
  if (state.selected > 0) {
    const d = engine.data
    const p = point ?? [d.xipos[3 * bodyId], d.xipos[3 * bodyId + 1], d.xipos[3 * bodyId + 2]]
    engine.select(bodyId, p)
  } else if (engine.perturb) {
    engine.select(0, [0, 0, 0])
  }
  stage.highlight(state.selected)
  panel.markSelection({ body: state.selected, joint, actuator, sensor })
  if (!quiet) panel.scrollToSelection()
  choosePlotSignals()
  renderChip()
  saveSession()
}

function renderChip() {
  const chip = $('chip')
  if (state.selected <= 0 || !engine.info || state.mode === 'video') { chip.hidden = true; return }
  const b = engine.info.bodies[state.selected]
  $('chip-name').textContent = b.name
  $('chip-meta').textContent = `${fmt(b.mass)} kg${b.joints.length ? ` · ${b.joints.map((j) => engine.info.joints[j].type).join('+')}` : ''}`
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  $('chip-hint').textContent = state.mode === 'sim' ? `${mac ? '⌘' : 'Ctrl'}-drag to push · ⇧ to twist` : 'Switch to Simulate to push it'
  $('chip-track').classList.toggle('on', stage.cameraMode.kind === 'track' && stage.cameraMode.body === state.selected)
  chip.hidden = false
}

function installPointer() {
  const canvas = $('view')
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('dblclick', (e) => {
    if (!engine?.model || state.mode === 'video') return
    touch()
    const { origin, direction } = stage.rayFrom(e.clientX, e.clientY)
    const hit = engine.ray(origin, direction, visibleGroups())
    if (e.altKey) {
      if (hit) { stage.controls.target.set(...hit.point); stage.controls.update(); toast('Looking at that point') }
      return
    }
    if (hit && hit.body > 0) select(hit.body, { point: hit.point })
    else select(-1)
  })
  canvas.addEventListener('pointerdown', (e) => {
    if (!engine?.model || !(e.ctrlKey || e.metaKey) || e.button !== 0) return
    e.preventDefault(); e.stopImmediatePropagation()
    touch()
    if (state.mode !== 'sim') { toast('Switch to Simulate to push the model'); return }
    const { origin, direction } = stage.rayFrom(e.clientX, e.clientY)
    const hit = engine.ray(origin, direction, visibleGroups())
    if (hit && hit.body > 0 && hit.body !== state.selected) select(hit.body, { point: hit.point, quiet: true })
    else if (hit && hit.body === state.selected) engine.select(hit.body, hit.point)
    if (state.selected <= 0) return
    stage.syncMjCamera(engine)
    const kind = e.shiftKey ? 'rotate' : 'translate'
    if (!engine.beginPerturb(kind)) return
    const p = engine.perturb
    const d = engine.data, b = state.selected, R = d.xmat, o = 9 * b, lp = p.localpos
    const grab = [
      d.xpos[3 * b] + R[o] * lp[0] + R[o + 1] * lp[1] + R[o + 2] * lp[2],
      d.xpos[3 * b + 1] + R[o + 3] * lp[0] + R[o + 4] * lp[1] + R[o + 5] * lp[2],
      d.xpos[3 * b + 2] + R[o + 6] * lp[0] + R[o + 7] * lp[1] + R[o + 8] * lp[2],
    ]
    const forward = stage.camera.getWorldDirection(new stage.camera.position.constructor())
    state.perturb = {
      kind, x: e.clientX, y: e.clientY, grab, normal: forward.toArray(),
      refpos: Array.from(p.refpos), refselpos: Array.from(p.refselpos), refquat: Array.from(p.refquat),
    }
    stage.controls.enabled = false
    canvas.classList.add('perturbing')
    canvas.setPointerCapture(e.pointerId)
  }, { capture: true })
  canvas.addEventListener('pointermove', (e) => {
    const drag = state.perturb
    if (!drag) return
    const p = engine.perturb
    if (drag.kind === 'translate') {
      const { origin, direction } = stage.rayFrom(e.clientX, e.clientY)
      const n = drag.normal
      const denom = n[0] * direction[0] + n[1] * direction[1] + n[2] * direction[2]
      if (Math.abs(denom) < 1e-6) return
      const s = ((drag.grab[0] - origin[0]) * n[0] + (drag.grab[1] - origin[1]) * n[1] + (drag.grab[2] - origin[2]) * n[2]) / denom
      const hit = [origin[0] + direction[0] * s, origin[1] + direction[1] * s, origin[2] + direction[2] * s]
      for (let i = 0; i < 3; i++) {
        const delta = hit[i] - drag.grab[i]
        p.refselpos[i] = drag.refselpos[i] + delta
        p.refpos[i] = drag.refpos[i] + delta
      }
    } else {
      const dx = (e.clientX - drag.x) * 0.012, dy = (e.clientY - drag.y) * 0.012
      const cam = stage.camera
      const up = cam.up.clone().applyQuaternion(cam.quaternion.clone()).normalize()
      const camUp = new cam.up.constructor(0, 1, 0).applyQuaternion(cam.quaternion)
      const right = new cam.up.constructor(1, 0, 0).applyQuaternion(cam.quaternion)
      void up
      const q0 = drag.refquat
      const qa = axisAngle(camUp.toArray(), dx), qb = axisAngle(right.toArray(), dy)
      const q = quatMul(quatMul(qa, qb), q0)
      for (let i = 0; i < 4; i++) p.refquat[i] = q[i]
    }
  })
  const end = (e) => {
    if (!state.perturb) return
    state.perturb = null
    engine.endPerturb()
    engine.clearPerturbForce()
    stage.controls.enabled = stage.cameraMode.kind !== 'fixed'
    canvas.classList.remove('perturbing')
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
  stage.controls.addEventListener('start', touch)
}

function axisAngle(axis, angle) {
  const s = Math.sin(angle / 2)
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}
function quatMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]
}

// ─── Visualization flags → MjvOption ──────────────────────────────────────────────────────────

function decorNeeded() {
  const info = engine.info
  return vis.contactpoint || vis.contactforce || vis.joint || vis.actuator || vis.com || vis.inertia
    || vis.frame !== 'none' || vis.sites || (vis.tendon && info.ntendon > 0) || Boolean(engine.perturb?.active)
}

function configureOption() {
  const m = engine.mujoco, o = engine.option, V = m.mjtVisFlag
  const flags = o.flags
  flags.fill(0)
  const on = (name, value = 1) => { const f = V[name]; if (f) flags[f.value] = value ? 1 : 0 }
  on('mjVIS_TEXTURE'); on('mjVIS_STATIC'); on('mjVIS_SKIN'); on('mjVIS_PERTFORCE'); on('mjVIS_PERTOBJ')
  on('mjVIS_CONTACTPOINT', vis.contactpoint); on('mjVIS_CONTACTFORCE', vis.contactforce); on('mjVIS_JOINT', vis.joint)
  on('mjVIS_ACTUATOR', vis.actuator); on('mjVIS_TENDON', vis.tendon); on('mjVIS_COM', vis.com); on('mjVIS_INERTIA', vis.inertia)
  on('mjVIS_RANGEFINDER')
  const F = m.mjtFrame
  o.frame = { none: F.mjFRAME_NONE, body: F.mjFRAME_BODY, site: F.mjFRAME_SITE, world: F.mjFRAME_WORLD }[vis.frame]?.value ?? 0
  for (let i = 0; i < 6; i++) {
    o.geomgroup[i] = vis.groups[i] ? 1 : 0
    o.sitegroup[i] = vis.sites && i < 3 ? 1 : 0
    o.tendongroup[i] = vis.tendon ? 1 : 0
    o.actuatorgroup[i] = vis.actuator ? 1 : 0
    o.jointgroup[i] = 1
  }
}

let decorShown = false
function drawDecor() {
  if (!decorNeeded() || state.mode === 'video') {
    if (decorShown) { stage.decor.hideAll(); decorShown = false }
    return
  }
  const m = engine.mujoco
  configureOption()
  m.mjv_updateScene(engine.model, engine.data, engine.option, engine.perturb, engine.camera, m.mjtCatBit.mjCAT_DECOR.value, engine.scene)
  stage.decor.draw(engine, stage.extent)
  decorShown = true
}

// ─── Rendering the chrome ─────────────────────────────────────────────────────────────────────

function renderTitle() {
  const r = state.resolved
  const name = $('model-name'), sub = $('model-sub')
  if (!r?.model) { name.textContent = 'MuJoCo'; sub.textContent = ''; document.title = 'MuJoCo'; return }
  const parts = r.model.split('/')
  const label = parts[0] === 'menagerie' ? parts[1] : parts[parts.length - 1]
  name.textContent = label
  const bits = []
  if (engine.info?.modelName && engine.info.modelName !== label) bits.push(engine.info.modelName)
  if (r.modelXml) bits.push('as the agent compiled it')
  else if (r.source === 'script') bits.push('from sim/, before the first rollout')
  else if (r.source === 'picked') bits.push('picked here')
  sub.textContent = bits.join(' · ')
  document.title = `${label} · MuJoCo`
}

function renderAgent() {
  const t = state.traj
  const box = $('agent')
  if (t?.status === 'recording') {
    const done = (t.n - 1) * t.dt
    $('agent-text').textContent = `Agent recording · ${done.toFixed(1)} / ${Number(t.seconds).toFixed(1)} s`
    box.hidden = false
  } else {
    box.hidden = true
  }
}

function renderTimeline() {
  const t = state.traj
  const timeline = $('timeline')
  const scrub = $('scrub')
  if (state.mode === 'video') {
    const video = $('video')
    const fraction = video.duration ? video.currentTime / video.duration : 0
    timeline.classList.remove('empty')
    scrub.disabled = false
    scrub.max = '1000'
    $('track-recorded').style.width = '100%'
    $('track-progress').style.width = `${fraction * 100}%`
    timeline.style.setProperty('--head', `${fraction * 100}%`)
    if (document.activeElement !== scrub) scrub.value = String(Math.round(fraction * 1000))
    return
  }
  if (t) scrub.max = String(t.n - 1)
  if (!t || !engine?.model) {
    timeline.classList.add('empty')
    $('track-recorded').style.width = '0%'
    $('track-progress').style.width = '0%'
    scrub.disabled = true
    return
  }
  scrub.disabled = false
  timeline.classList.remove('empty')
  const recordedFraction = t.status === 'recording' ? Math.min(1, t.n / Math.max(t.n, t.expected)) : 1
  $('track-recorded').style.width = `${recordedFraction * 100}%`
  let fraction
  if (state.mode === 'replay') fraction = (state.cursor / Math.max(1, t.expected - 1))
  else fraction = (engine.data.time - t.time0) / Math.max(1e-9, (t.expected - 1) * t.dt)
  fraction = Math.max(0, Math.min(1, fraction))
  $('track-progress').style.width = `${fraction * 100}%`
  timeline.style.setProperty('--head', `${fraction * 100}%`)
  if (document.activeElement !== scrub) scrub.value = String(Math.round(state.mode === 'replay' ? state.cursor : Math.min(t.n - 1, (engine.data.time - t.time0) / t.dt)))
}

function renderTransport() {
  const video = $('video')
  body.classList.toggle('playing', state.mode === 'video' ? !video.paused : state.playing)
  body.classList.toggle('paused', state.mode === 'video' ? video.paused : !state.playing)
  const d = engine?.data
  if (!d) return
  const clock = $('clock')
  if (state.mode === 'video') {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    clock.textContent = `${fmt(video.currentTime || 0)} / ${fmt(duration)} s`
  } else if (state.mode === 'replay' && state.traj) {
    const k = Math.floor(state.cursor)
    clock.textContent = `${fmt(state.traj.time0 + k * state.traj.dt)} s · ${k + 1}/${state.traj.n}`
  } else {
    const past = state.traj && d.time > state.traj.time0 + (state.traj.n - 1) * state.traj.dt + 1e-6
    clock.textContent = `${d.time.toFixed(2)} s${past ? ' · live' : ''}`
  }
  $('btn-from-here').hidden = state.mode !== 'replay'
  $('btn-step').disabled = false
  $('btn-reset').disabled = false
  $('btn-play').disabled = false
  $('key-wrap').hidden = state.mode === 'video'
}

function renderHud() {
  const d = engine.data
  const hud = $('hud')
  if (state.mode === 'video' || !engine.model) { hud.hidden = true; return }
  hud.hidden = false
  $('hud-time').textContent = `t ${d.time.toFixed(2)} s`
  const rtf = $('hud-rtf')
  if (state.mode === 'sim') {
    const shown = state.playing ? state.rtf : 0
    rtf.textContent = state.playing ? `${shown.toFixed(2)}× real time` : 'paused'
    rtf.classList.toggle('slow', state.playing && (state.slow || shown < state.speed * 0.85))
    rtf.hidden = false
  } else {
    rtf.textContent = state.playing ? `replay ${state.speed === 1 ? '1×' : `${state.speed}×`}` : 'replay paused'
    rtf.classList.remove('slow')
  }
  $('hud-extra').textContent = `${d.ncon} contact${d.ncon === 1 ? '' : 's'}`
}

function sourceBox() {
  if (!engine.info) return
  if (state.mode === 'replay') {
    panel.setSource({ kind: 'replay', title: 'Replaying the recording', detail: 'Controls show what the agent’s controller sent.', action: { label: 'Simulate from here', title: 'Continue with live physics (Enter)', run: () => simulateFrom(state.cursor) } })
    return
  }
  if (state.ctrlSource === 'recording' && state.follow?.ctrl) {
    const end = state.follow.time0 + (state.follow.n - 1) * state.follow.dt
    const past = engine.data.time > end
    panel.setSource({ kind: 'recording', title: past ? 'Holding the last recorded controls' : 'Following the recorded controls', detail: 'Live physics; move any slider to take over.', action: { label: 'Take over', title: 'Drive the actuators yourself', run: () => { state.ctrlSource = 'manual'; touch() } } })
  } else if (state.ctrlSource === 'keyframe') {
    panel.setSource({ kind: 'keyframe', title: 'Holding the keyframe’s controls', detail: 'Live physics; move a slider to drive an actuator.', action: state.traj?.ctrl ? { label: 'Follow recording', run: () => { state.ctrlSource = 'recording'; state.start = 'rollout'; resetSim() } } : null })
  } else {
    panel.setSource({ kind: 'manual', title: 'You are driving the controls', detail: engine.model.nu ? 'Sliders write data.ctrl every step.' : 'No actuators — push bodies with ⌘-drag.', action: state.traj?.ctrl ? { label: 'Follow recording', title: 'Restart from the rollout with its controls', run: () => { state.start = 'rollout'; resetSim() } } : null })
  }
}

// ─── Keyframes, cameras, plot signals ─────────────────────────────────────────────────────────

function fillKeyframes() {
  const select = $('keyframe')
  if (!engine.info) return
  select.replaceChildren()
  if (state.traj) select.append(node('option', { value: 'rollout', text: 'Rollout start' }))
  for (const k of engine.info.keys) select.append(node('option', { value: `key:${k.id}`, text: `Key: ${k.name}` }))
  select.append(node('option', { value: 'qpos0', text: 'Model default' }))
  select.value = [...select.options].some((o) => o.value === state.start) ? state.start : select.options[0].value
  state.start = select.value
}

function fillCameraMenu() {
  const list = $('camera-list')
  list.replaceChildren(node('div', { class: 'label', text: 'Camera' }))
  const mode = stage.cameraMode
  const row = (text, sub, on, run) => node('button', { type: 'button', class: `row${on ? ' on' : ''}`, onclick: () => { run(); fillCameraMenu(); renderCameraChip(); renderChip(); $('menu-camera').hidden = true } }, document.createTextNode(text), node('span', { class: 'sub', text: sub }))
  list.append(row('Free', 'orbit', mode.kind === 'free', () => stage.setCameraMode({ kind: 'free' }, engine)))
  const trackBody = state.selected > 0 ? state.selected : trackDefault()
  if (trackBody > 0) {
    list.append(row(`Track ${engine.info.bodies[trackBody].name}`, state.selected > 0 ? 'selected' : 'root', mode.kind === 'track', () => stage.setCameraMode({ kind: 'track', body: trackBody }, engine)))
  }
  for (const c of engine.info?.cameras ?? []) {
    list.append(row(c.name, 'fixed', mode.kind === 'fixed' && mode.camera === c.id, () => stage.setCameraMode({ kind: 'fixed', camera: c.id }, engine)))
  }
}

function trackDefault() {
  const info = engine.info
  if (!info) return -1
  if (state.traj?.track) { const b = info.bodies.find((x) => x.name === state.traj.track); if (b) return b.id }
  const root = info.bodies.find((b) => b.id > 0 && b.parent === 0 && b.joints.some((j) => info.joints[j].type === 'free'))
  return root ? root.id : -1
}

function renderCameraChip() {
  const mode = stage.cameraMode
  const chip = $('camera-chip')
  $('btn-camera').classList.toggle('on', mode.kind !== 'free')
  if (mode.kind === 'fixed') { chip.textContent = `${engine.info.cameras[mode.camera]?.name ?? 'camera'} · Esc for free camera`; chip.hidden = false }
  else if (mode.kind === 'track') { chip.textContent = `Tracking ${engine.info.bodies[mode.body]?.name ?? 'body'}`; chip.hidden = false }
  else chip.hidden = true
}

function cycleCamera(direction) {
  const cams = engine.info?.cameras ?? []
  const options = [{ kind: 'free' }, ...cams.map((c) => ({ kind: 'fixed', camera: c.id }))]
  const mode = stage.cameraMode
  let index = mode.kind === 'fixed' ? cams.findIndex((c) => c.id === mode.camera) + 1 : 0
  index = (index + direction + options.length) % options.length
  stage.setCameraMode(options[index], engine)
  renderCameraChip(); fillCameraMenu()
}

let plotSignals = []
function choosePlotSignals() {
  if (!engine.info) return
  const info = engine.info
  const d = () => engine.data
  const signals = []
  const joint = state.selectedJoint >= 0 ? info.joints[state.selectedJoint]
    : state.selected > 0 ? info.joints.find((j) => j.body === state.selected && (j.type === 'hinge' || j.type === 'slide')) : null
  if (joint && (joint.type === 'hinge' || joint.type === 'slide')) {
    const unit = joint.type === 'hinge' ? 'rad' : 'm'
    signals.push({ id: `joint:${joint.id}`, label: `${joint.name}: position & velocity`, stacked: true, series: [
      { name: 'qpos', unit, get: () => d().qpos[joint.qpos] },
      { name: 'qvel', unit: `${unit}/s`, get: () => d().qvel[joint.dof] },
    ] })
  }
  if (state.selectedActuator >= 0) {
    const a = info.actuators[state.selectedActuator]
    signals.push({ id: `act:${a.id}`, label: `${a.name}: control & force`, stacked: true, series: [
      { name: 'ctrl', unit: '', get: () => d().ctrl[a.id] },
      { name: 'force', unit: '', get: () => d().actuator_force[a.id] },
    ] })
  }
  const heightBody = state.selected > 0 ? state.selected : trackDefault()
  if (heightBody > 0) {
    signals.push({ id: `height:${heightBody}`, label: `${info.bodies[heightBody].name}: height`, series: [{ name: 'z', unit: 'm', get: () => d().xpos[3 * heightBody + 2] }] })
  }
  signals.push({ id: 'energy', label: 'Energy: potential & kinetic', series: [
    { name: 'potential', unit: 'J', get: () => d().energy[0] },
    { name: 'kinetic', unit: 'J', get: () => d().energy[1] },
  ] })
  signals.push({ id: 'contacts', label: 'Contacts', series: [{ name: 'contacts', unit: '', get: () => d().ncon }] })
  signals.push({ id: 'rtf', label: 'Real-time factor', series: [{ name: 'rtf', unit: '×', get: () => (state.mode === 'sim' && state.playing ? state.rtf : NaN) }] })
  for (const s of info.sensors) {
    const dims = Math.min(2, s.dim)
    signals.push({ id: `sensor:${s.id}`, label: `Sensor ${s.name} (${s.type})`, stacked: dims > 1, series: Array.from({ length: dims }, (_, k) => ({ name: dims > 1 ? `${s.name}[${k}]` : s.name, unit: '', get: () => d().sensordata[s.adr + k] })) })
  }
  plotSignals = signals
  const select = $('plot-signal')
  const want = state.selectedSensor >= 0 ? `sensor:${state.selectedSensor}` : (state.selectedActuator >= 0 ? `act:${state.selectedActuator}` : joint ? `joint:${joint.id}` : (select.value && signals.some((s) => s.id === select.value) ? select.value : (prefs.plot && signals.some((s) => s.id === prefs.plot) ? prefs.plot : (heightBody > 0 ? `height:${heightBody}` : 'energy'))))
  select.replaceChildren(...signals.map((s) => node('option', { value: s.id, text: s.label })))
  select.value = want
  plot.setSignal(signals.find((s) => s.id === select.value) ?? signals[0])
  if (state.mode === 'replay' && !plot.static) replayPlot()
}

// ─── Video ────────────────────────────────────────────────────────────────────────────────────

function updateVideo(r) {
  const button = $('modes').querySelector('[data-mode=video]')
  button.hidden = !r.video
  const video = $('video')
  const stamp = r.video ? `${r.video}|${r.stamps.video}` : null
  if (stamp !== state.videoStamp) {
    state.videoStamp = stamp
    if (r.video) { video.src = `/ws/${r.video.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(r.stamps.video ?? '')}`; button.title = `${r.video} (V)` }
    else { video.removeAttribute('src'); video.load() }
  }
  if (!r.video && state.mode === 'video') setMode('sim')
}

// ─── Session: what survives a page reload (Harness navigates the pane when the artifact changes) ──

function captureSession() {
  return {
    mode: state.mode, playing: state.playing, selected: engine.info?.bodies[state.selected]?.name ?? null,
    camera: stage.saveCamera(), cameraMode: stage.cameraMode.kind === 'track' ? { kind: 'track', body: engine.info?.bodies[stage.cameraMode.body]?.name }
      : stage.cameraMode.kind === 'fixed' ? { kind: 'fixed', camera: engine.info?.cameras[stage.cameraMode.camera]?.name } : { kind: 'free' },
    panel: !$('panel').hidden, tab: panel.tab, cursor: state.cursor,
  }
}

function restoreSession(s, { onlyView = false } = {}) {
  if (!s || !engine.info) return
  const info = engine.info
  if (s.selected) { const b = info.bodies.find((x) => x.name === s.selected); if (b) select(b.id, { quiet: true }) }
  if (s.cameraMode?.kind === 'track') { const b = info.bodies.find((x) => x.name === s.cameraMode.body); if (b) stage.setCameraMode({ kind: 'track', body: b.id }, engine) }
  if (s.cameraMode?.kind === 'fixed') { const c = info.cameras.find((x) => x.name === s.cameraMode.camera); if (c) stage.setCameraMode({ kind: 'fixed', camera: c.id }, engine) }
  if (!onlyView && s.camera) stage.restoreCamera(s.camera)
  if (typeof s.cursor === 'number') state.cursor = s.cursor
  if (s.mode === 'replay' && onlyView) state.pendingMode = 'replay'
  renderCameraChip()
  fillCameraMenu()
}

let lastSessionSave = 0
function saveSession(force = false) {
  const now = performance.now()
  if (!engine?.info || (!force && now - lastSessionSave < 800)) return
  lastSessionSave = now
  writeStore(sessionStorage, SESSION_KEY, captureSession())
  if (state.modelPath) writeStore(sessionStorage, cameraKey(state.modelPath), stage.saveCamera())
}

// ─── The loop ─────────────────────────────────────────────────────────────────────────────────

let last = performance.now()
function frame(now) {
  requestAnimationFrame(frame)
  const wallElapsed = Math.max(0, (now - last) / 1000)
  const elapsed = Math.min(0.25, wallElapsed)
  last = now
  if (engine?.model) {
    if (state.mode === 'sim') stepSim(elapsed, wallElapsed)
    else if (state.mode === 'replay' && state.traj) {
      if (state.playing) {
        let next = state.cursor + (elapsed * state.speed) / state.traj.dt
        if (next > state.traj.n - 1) next = state.traj.status === 'recording' ? state.traj.n - 1 : 0
        showFrame(next)
      } else {
        showFrame(state.cursor)
      }
    }
    if (state.mode !== 'video') {
      stage.sync(engine)
      drawDecor()
      stage.updateCamera(engine)
      stage.render()
      renderHud()
      renderTransport()
      renderTimeline()
      if (state.mode === 'sim') plot.sample(engine.data.time)
      else if (state.traj) plot.setCursor(state.traj.time0 + Math.floor(state.cursor) * state.traj.dt)
      plot.draw(now)
      panel.update(engine, { editable: state.mode === 'sim' && !state.playing })
      sourceBox()
      saveSession()
    } else {
      const video = $('video')
      if (video.playbackRate !== state.speed) video.playbackRate = state.speed
      renderTransport()
      renderTimeline()
    }
  }
}

// ─── Wiring ───────────────────────────────────────────────────────────────────────────────────

function setVis(key, value) {
  vis[key] = value
  savePrefs()
  renderShowMenu()
  stage.applySettings(vis)
  touch()
}

function renderShowMenu() {
  const menu = $('menu-show')
  menu.querySelectorAll('input[data-vis]').forEach((input) => { input.checked = Boolean(vis[input.dataset.vis]) })
  menu.querySelectorAll('[data-radio=frame] button').forEach((b) => b.classList.toggle('on', b.dataset.value === vis.frame))
  menu.querySelectorAll('[data-groups] button').forEach((b) => b.classList.toggle('on', Boolean(vis.groups[Number(b.dataset.group)])))
  const active = ['contactpoint', 'contactforce', 'joint', 'actuator', 'com', 'inertia', 'transparent', 'wireframe', 'sites'].some((k) => vis[k]) || vis.frame !== 'none'
  $('btn-show').classList.toggle('on', active)
}

function togglePanel(open = $('panel').hidden) {
  $('panel').hidden = !open
  $('btn-panel').classList.toggle('on', open)
  prefs.panel = open
  savePrefs()
  requestAnimationFrame(applyInset)
  if (open && engine?.data) panel.update(engine, { editable: state.mode === 'sim' && !state.playing, force: true })
}

function layout() {
  const w = innerWidth
  body.classList.toggle('narrow', w < 860)
  body.classList.toggle('tiny', w < 560)
}

/** In a narrow pane the panel floats over the stage; the picture slides left so the model stays in view. */
function applyInset() {
  const floating = body.classList.contains('narrow') && !$('panel').hidden
  const inset = floating ? $('panel').offsetWidth : 0
  stage.setInset(inset)
  body.style.setProperty('--inset', `${inset}px`)
}

function closeMenus(except) {
  for (const id of ['menu-show', 'menu-camera', 'menu-model']) if (id !== except) $(id).hidden = true
}

/** The model picker: the rollout's model, every MJCF in the workspace, every Menagerie robot. */
async function openModelMenu() {
  const menu = $('menu-model')
  if (!menu.hidden) { menu.hidden = true; return }
  closeMenus('menu-model')
  let models = { robots: [], scenes: [] }
  try { models = await getJson('/api/models') } catch { /* offline server: show what we have */ }
  const current = state.resolved?.model
  const choose = (path) => { menu.hidden = true; if (path === current && !pickedModel) return; pickedModel = path; syncUrl(); touch(); refresh() }
  const row = (label, path, sub) => node('button', { type: 'button', class: `row${path === current ? ' on' : ''}`, title: path ?? '', onclick: () => choose(path) },
    document.createTextNode(label), node('span', { class: 'path', text: sub }))
  const groups = []
  if (pickedModel) {
    groups.push(node('div', { class: 'group' }, node('div', { class: 'label', text: 'The agent’s' }),
      node('button', { type: 'button', class: 'row', onclick: () => { menu.hidden = true; pickedModel = null; syncUrl(); touch(); refresh() } }, document.createTextNode('Back to the agent’s rollout'))))
  }
  if (models.scenes.length) groups.push(node('div', { class: 'group' }, node('div', { class: 'label', text: 'This workspace' }), ...models.scenes.map((x) => row(x.path.split('/').pop(), x.path, x.path))))
  if (models.robots.length) groups.push(node('div', { class: 'group' }, node('div', { class: 'label', text: 'Menagerie' }), ...models.robots.map((x) => row(x.name, x.path, x.path.split('/').pop()))))
  if (!groups.length) groups.push(node('div', { class: 'group' }, node('div', { class: 'label', text: 'No other models here' })))
  menu.replaceChildren(...groups)
  menu.hidden = false
}

function wire() {
  addEventListener('resize', () => { layout(); applyInset() })
  layout()
  $('modes').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b && !b.disabled) setMode(b.dataset.mode) })
  $('btn-play').addEventListener('click', () => {
    touch()
    if (state.mode === 'video') { const v = $('video'); if (v.paused) v.play().catch(() => {}); else v.pause(); return }
    state.playing = !state.playing
    renderTransport()
  })
  $('btn-step').addEventListener('click', singleStep)
  $('btn-reset').addEventListener('click', () => {
    touch()
    if (state.mode === 'video') { $('video').currentTime = 0; return }
    if (state.mode === 'replay') { showFrame(0); return }
    resetSim()
    toast(state.start === 'rollout' ? 'Reset to the rollout’s first frame' : state.start === 'qpos0' ? 'Reset to the model default' : `Reset to ${$('keyframe').selectedOptions[0]?.textContent ?? 'keyframe'}`, 1600)
  })
  $('btn-from-here').addEventListener('click', () => simulateFrom(state.cursor))
  $('keyframe').addEventListener('change', (e) => {
    touch()
    state.start = e.target.value
    if (state.mode !== 'sim') setMode('sim', { keepState: true })
    resetSim()
    e.target.blur()
  })
  $('speed').value = String(state.speed)
  if ($('speed').value !== String(state.speed)) { state.speed = 1; $('speed').value = '1' }
  $('speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); prefs.speed = state.speed; savePrefs(); e.target.blur() })
  const scrub = $('scrub')
  scrub.addEventListener('input', () => {
    touch()
    if (state.mode === 'video') { const v = $('video'); if (v.duration) v.currentTime = (Number(scrub.value) / 1000) * v.duration; return }
    if (!state.traj) return
    if (state.mode !== 'replay') setMode('replay')
    state.playing = false
    showFrame(Number(scrub.value))
  })
  scrub.addEventListener('change', () => scrub.blur())

  $('btn-show').addEventListener('click', (e) => { e.stopPropagation(); closeMenus('menu-show'); $('menu-show').hidden = !$('menu-show').hidden; renderShowMenu() })
  $('btn-camera').addEventListener('click', (e) => { e.stopPropagation(); closeMenus('menu-camera'); fillCameraMenu(); $('menu-camera').hidden = !$('menu-camera').hidden })
  $('menu-show').addEventListener('click', (e) => e.stopPropagation())
  $('menu-camera').addEventListener('click', (e) => e.stopPropagation())
  addEventListener('click', () => closeMenus())
  $('menu-show').querySelectorAll('input[data-vis]').forEach((input) => input.addEventListener('change', () => setVis(input.dataset.vis, input.checked)))
  $('menu-show').querySelectorAll('[data-radio=frame] button').forEach((b) => b.addEventListener('click', () => setVis('frame', b.dataset.value)))
  $('menu-show').querySelectorAll('[data-groups] button').forEach((b) => b.addEventListener('click', () => { const g = [...vis.groups]; g[Number(b.dataset.group)] = g[Number(b.dataset.group)] ? 0 : 1; setVis('groups', g) }))
  $('camera-reset').addEventListener('click', () => { stage.setCameraMode({ kind: 'free' }, engine); stage.frameDefault(engine); renderCameraChip(); $('menu-camera').hidden = true })
  $('btn-panel').addEventListener('click', () => togglePanel())
  $('btn-help').addEventListener('click', () => { $('help').hidden = false })
  $('title').addEventListener('click', (e) => { e.stopPropagation(); openModelMenu() })
  $('menu-model').addEventListener('click', (e) => e.stopPropagation())
  $('help-close').addEventListener('click', () => { $('help').hidden = true })
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true })
  $('chip-close').addEventListener('click', () => select(-1))
  $('chip-track').addEventListener('click', () => {
    const tracking = stage.cameraMode.kind === 'track' && stage.cameraMode.body === state.selected
    stage.setCameraMode(tracking ? { kind: 'free' } : { kind: 'track', body: state.selected }, engine)
    renderCameraChip(); renderChip()
  })
  $('plot-signal').addEventListener('change', (e) => {
    const s = plotSignals.find((x) => x.id === e.target.value)
    if (s) { plot.setSignal(s); prefs.plot = s.id; savePrefs(); replayPlot() }
  })

  addEventListener('keydown', (e) => {
    const target = e.target
    if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox')) return
    if (!$('help').hidden && e.key === 'Escape') { $('help').hidden = true; return }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key
    const handled = () => { e.preventDefault(); touch() }
    if (key === ' ') { handled(); if (state.mode !== 'video') { state.playing = !state.playing; renderTransport() } else { const v = $('video'); v.paused ? v.play() : v.pause() } }
    else if (key === 'ArrowRight') { handled(); singleStep() }
    else if (key === 'ArrowLeft') { if (state.mode === 'replay') { handled(); state.playing = false; showFrame(Math.ceil(state.cursor) - 1) } }
    else if (key === 'Backspace' || key === 'Delete') { handled(); $('btn-reset').click() }
    else if (key === 'Enter') { if (state.mode === 'replay') { handled(); simulateFrom(state.cursor) } }
    else if (key === 'Tab') { handled(); togglePanel() }
    else if (key === 'Escape') { handled(); closeMenus(); if (stage.cameraMode.kind !== 'free') { stage.setCameraMode({ kind: 'free' }, engine); renderCameraChip(); renderChip() } else select(-1) }
    else if (key === '-' || key === '_') { handled(); stepSpeed(1) }
    else if (key === '=' || key === '+') { handled(); stepSpeed(-1) }
    else if (key === '[') { handled(); cycleCamera(-1) }
    else if (key === ']') { handled(); cycleCamera(1) }
    else if (key === '0') { handled(); stage.setCameraMode({ kind: 'free' }, engine); stage.frameDefault(engine); renderCameraChip() }
    else if (key === '?' || key === '/') { handled(); $('help').hidden = !$('help').hidden }
    else {
      const lower = key.toLowerCase()
      const toggles = { c: 'contactpoint', f: 'contactforce', j: 'joint', u: 'actuator', v: null, m: 'com', i: 'inertia', t: 'transparent', w: 'wireframe', h: 'shadows', e: 'reflections', k: 'skybox' }
      if (lower === 's') { handled(); setMode('sim') }
      else if (lower === 'r') { handled(); setMode('replay') }
      else if (lower === 'v') { handled(); setMode('video') }
      else if (lower === 'b') { handled(); const order = ['none', 'body', 'site', 'world']; setVis('frame', order[(order.indexOf(vis.frame) + 1) % order.length]); toast(`Frames: ${vis.frame}`, 1200) }
      else if (toggles[lower]) {
        handled()
        const name = toggles[lower]
        setVis(name, !vis[name])
        const label = { contactpoint: 'Contact points', contactforce: 'Contact forces', joint: 'Joint axes', actuator: 'Actuators', com: 'Center of mass', inertia: 'Inertia boxes', transparent: 'Transparent', wireframe: 'Wireframe', shadows: 'Shadows', reflections: 'Reflections', skybox: 'Skybox' }[name]
        toast(`${label} ${vis[name] ? 'on' : 'off'}`, 1200)
      }
    }
  })
  addEventListener('pagehide', () => saveSession(true))
}

function stepSpeed(direction) {
  const options = [...$('speed').options].map((o) => Number(o.value))
  const index = options.indexOf(state.speed)
  const next = options[Math.max(0, Math.min(options.length - 1, index + direction))]
  state.speed = next
  $('speed').value = String(next)
  prefs.speed = next
  savePrefs()
  toast(`Speed ${$('speed').selectedOptions[0].textContent}`, 1000)
}

// ─── Live: the agent's writes ─────────────────────────────────────────────────────────────────

let pendingPaths = new Set()
let refreshTimer = null
function onWorkspaceChange(paths) {
  const interesting = paths.filter((p) => /\.(xml|json|mp4|webm|mov|obj|stl|msh|png|py)$/i.test(p) && !p.startsWith('.harness/'))
  if (!interesting.length) return
  for (const p of interesting) pendingPaths.add(p)
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    const changed = [...pendingPaths]
    pendingPaths = new Set()
    const r = state.resolved
    const relevant = !r?.model || changed.some((p) => p === r.trajectory || p === r.modelXml || p === r.video || p.startsWith('out/')
      || p.endsWith('.xml') || p.endsWith('.json') || (!r.model.startsWith('menagerie/') && p.startsWith(r.model.slice(0, r.model.lastIndexOf('/') + 1))) || (r.source === 'script' && p.endsWith('.py')))
    if (relevant) refresh()
  }, 180)
}

// ─── Start ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  try {
    stage = new Stage($('view'))
  } catch (error) {
    showError('This pane needs WebGL', String(error.message ?? error))
    return
  }
  panel = new Panel($('panel'), {
    onTab: (tab) => { prefs.tab = tab; savePrefs() },
    onSelectBody: (id, extra = {}) => { touch(); select(id, extra) },
    onTrackBody: (id) => { stage.setCameraMode({ kind: 'track', body: id }, engine); renderCameraChip(); renderChip() },
    onCtrl: (a, value) => { touch(); if (state.mode === 'replay') setMode('sim'); state.ctrlSource = 'manual'; engine.data.ctrl[a] = value },
    onZero: () => { touch(); if (state.mode === 'replay') setMode('sim'); state.ctrlSource = 'manual'; engine.data.ctrl.fill(0) },
    onKeyCtrl: () => {
      touch()
      const model = engine.model
      if (!model.nkey) { toast('This model has no keyframes'); return }
      const k = state.start.startsWith('key:') ? Number(state.start.slice(4)) : 0
      if (state.mode === 'replay') setMode('sim')
      state.ctrlSource = 'manual'
      engine.data.ctrl.set(model.key_ctrl.subarray(k * model.nu, (k + 1) * model.nu))
    },
    onJoint: (j, value) => {
      touch()
      const joint = engine.info.joints[j]
      engine.data.qpos[joint.qpos] = value
      engine.data.qvel[joint.dof] = 0
      engine.forward()
    },
    onCamera: (c) => { stage.setCameraMode({ kind: 'fixed', camera: c }, engine); renderCameraChip(); fillCameraMenu() },
    onKeyframe: (k) => { touch(); state.start = `key:${k}`; $('keyframe').value = state.start; if (state.mode !== 'sim') setMode('sim', { keepState: true }); resetSim() },
    onSensor: (s) => { touch(); const sensor = engine.info.sensors[s]; select(sensor.body, { sensor: s, quiet: true }) },
  })
  if (prefs.tab) panel.showTab(prefs.tab)
  plot = new Plot($('plot-canvas'), $('plot-readout'))
  wire()
  renderShowMenu()
  stage.applySettings(vis)
  const openPanel = prefs.panel ?? innerWidth >= 1100
  togglePanel(openPanel)
  body.classList.add('mode-sim', 'playing')
  installPointer()

  overlay('Starting MuJoCo…')
  engine = await Engine.create()
  // For tests and the curious: the live objects, read-only by convention.
  window.__mujocoViewer = { get engine() { return engine }, get stage() { return stage }, state, vis }
  await refresh({ initial: true })
  if (state.pendingMode === 'replay' && state.traj) setMode('replay')
  state.pendingMode = null
  requestAnimationFrame(frame)
  if (engine.model && !prefs.hinted) {
    // Once per browser: the two things nobody guesses.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    setTimeout(() => toast(`Double-click a body, then ${mac ? '⌘' : 'Ctrl'}-drag to push it · Tab for controls · ? for keys`, 7000), 1200)
    prefs.hinted = true
    savePrefs()
  }
  const events = new EventSource('/api/events')
  events.addEventListener('change', (e) => {
    try { onWorkspaceChange(JSON.parse(e.data).paths ?? []) } catch { refresh() }
  })
}

main().catch((error) => {
  console.error(error)
  showError('The viewer could not start', String(error.message ?? error))
})
