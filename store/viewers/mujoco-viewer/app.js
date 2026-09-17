// The pane itself: MuJoCo compiled to WebAssembly, drawn with three.js, in the browser.
//
// Two modes over one model. REPLAY plays the trajectory the harness recorded (out/rollout.qpos.json:
// a qpos row per frame) by writing each row into data.qpos and calling mj_forward — scrub it, slow
// it down, run it back. LIVE steps mj_step in the animation loop from whatever pose is on screen, so
// the robot falls, settles and drifts under the physics the harness is using. Orbit and zoom are the
// same in both.
//
// Everything MuJoCo reads is in its own in-memory filesystem: the page fetches every file of the
// model's directory from the server (GET /list, then GET /ws/… or /menagerie/…) and writes it into
// MEMFS at the same relative path, so <include>, meshdir and every mesh resolve exactly as they do
// on disk. Geometry is read out of the compiled model — mesh_vert/mesh_face for meshes, geom_size
// for primitives — so what is drawn is what MuJoCo simulates.
//
// MuJoCo is Z-up. So is this scene: the camera's up is (0, 0, 1) and no axis is swizzled, which is
// the convention of MuJoCo's own web demo.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import loadMujoco from '/vendor/mujoco/mujoco.js'

const params = new URLSearchParams(location.search)
const FILE = (params.get('file') || '').replace(/^\/+/, '')
const FALLBACK = 'out/rollout.qpos.json'
const WANTED_MODEL = (params.get('model') || '').replace(/^\/+/, '')

const el = {
  name: document.getElementById('name'), hud: document.getElementById('hud'),
  reset: document.getElementById('reset'), live: document.getElementById('live'),
  canvas: document.getElementById('view'), transport: document.getElementById('transport'),
  play: document.getElementById('play'), scrub: document.getElementById('scrub'),
  clock: document.getElementById('clock'), speed: document.getElementById('speed'),
  overlay: document.getElementById('overlay'),
}

const EMPTY = `<div><b>No rollout yet.</b><br>The pane plays <code>out/rollout.qpos.json</code> — the trajectory <code>record()</code> writes beside the video — and lets you orbit it, scrub it, and step the physics live.</div>`

let mujoco = null
let model = null, data = null
let loadedPath = null            // the model path currently compiled into WASM
let traj = null                  // { model, dt, nq, qpos: [[…], …] }
let trajPath = null, trajSignature = null
let live = false, playing = true, speed = 1
let cursor = 0, shownFrame = -1
let lastTick = performance.now()

let renderer = null, scene = null, camera = null, controls = null
let root = null                  // the group every body hangs from
const bodyGroups = new Map()     // body id → THREE.Group
const owned = { geometries: new Set(), materials: new Set() }

function overlay(html) { el.overlay.innerHTML = html; el.overlay.hidden = false }
function hideOverlay() { el.overlay.hidden = true }
/** Paths and MuJoCo's errors are workspace content; they go on screen as text, never as markup. */
function escape(text) { return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) }

/** A model-namespace path → the URL that serves it. `menagerie/…` is the harness's, the rest the workspace's. */
function fileUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return path.startsWith('menagerie/') ? '/' + encoded : '/ws/' + encoded
}

// ─── MuJoCo's filesystem ────────────────────────────────────────────────────────────────────────

function vfsMkdirp(dir) {
  let acc = ''
  for (const part of dir.split('/')) {
    if (!part) continue
    acc += '/' + part
    try { mujoco.FS.mkdir(acc) } catch { /* exists */ }
  }
}

function vfsWrite(path, bytes) {
  const full = '/working/' + path
  vfsMkdirp(full.slice(0, full.lastIndexOf('/')))
  mujoco.FS.writeFile(full, bytes)
}

/** Copy every model file under `dir` into MEMFS at the same relative path. */
async function copyTree(dir, onProgress) {
  const res = await fetch('/list?dir=' + encodeURIComponent(dir))
  if (!res.ok) throw new Error(`the viewer cannot list ${dir || 'the workspace'} (${res.status})`)
  const listing = await res.json()
  const files = listing.files ?? []
  let done = 0
  const queue = files.slice()
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const file = await fetch(fileUrl(next.path))
      if (!file.ok) throw new Error(`${next.path} (${file.status})`)
      vfsWrite(next.path, new Uint8Array(await file.arrayBuffer()))
      onProgress(++done, files.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker))
  return listing
}

// ─── Geometry out of the compiled model ─────────────────────────────────────────────────────────

/**
 * A mesh as three.js sees it. MuJoCo's arrays are views straight into the WASM heap and are
 * invalidated the moment it grows, so every buffer is copied out before it reaches a BufferAttribute.
 */
function meshGeometry(id) {
  const va = model.mesh_vertadr[id], vn = model.mesh_vertnum[id]
  const na = model.mesh_normaladr[id], nn = model.mesh_normalnum[id]
  const fa = model.mesh_faceadr[id], fn = model.mesh_facenum[id]
  const vert = model.mesh_vert.subarray(va * 3, (va + vn) * 3)
  const norm = model.mesh_normal.subarray(na * 3, (na + nn) * 3)
  const face = model.mesh_face.subarray(fa * 3, (fa + fn) * 3)
  const fnorm = model.mesh_facenormal.subarray(fa * 3, (fa + fn) * 3)

  // A mesh whose normals are indexed per face exactly as its vertices are (every OBJ Menagerie
  // ships, as it happens) can stay indexed; anything else is expanded triangle by triangle so hard
  // edges survive.
  let aligned = nn === vn
  for (let k = 0; aligned && k < face.length; k++) if (face[k] !== fnorm[k]) aligned = false

  const geometry = new THREE.BufferGeometry()
  if (aligned) {
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vert), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(face), 1))
  } else {
    const position = new Float32Array(face.length * 3)
    const normal = new Float32Array(face.length * 3)
    for (let k = 0; k < face.length; k++) {
      const v = face[k] * 3, n = fnorm[k] * 3, o = k * 3
      position[o] = vert[v]; position[o + 1] = vert[v + 1]; position[o + 2] = vert[v + 2]
      normal[o] = norm[n]; normal[o + 1] = norm[n + 1]; normal[o + 2] = norm[n + 2]
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  }
  geometry.computeBoundingSphere()
  return geometry
}

/** A primitive geom, in MuJoCo's own convention: half-sizes, and Z for the axis of revolution. */
function primitiveGeometry(type, size) {
  const T = mujoco.mjtGeom
  switch (type) {
    case T.mjGEOM_PLANE.value: {
      // size 0 means an infinite plane; draw a generous patch of it rather than a horizon.
      const far = Math.max(6, Number(model.stat.extent) * 9)
      return new THREE.PlaneGeometry(2 * (size[0] > 0 ? size[0] : far), 2 * (size[1] > 0 ? size[1] : far))
    }
    case T.mjGEOM_SPHERE.value: return new THREE.SphereGeometry(size[0], 32, 16)
    case T.mjGEOM_CAPSULE.value: return new THREE.CapsuleGeometry(size[0], 2 * size[1], 8, 24).rotateX(Math.PI / 2)
    case T.mjGEOM_CYLINDER.value: return new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 32).rotateX(Math.PI / 2)
    case T.mjGEOM_BOX.value: return new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2])
    case T.mjGEOM_ELLIPSOID.value: return new THREE.SphereGeometry(1, 32, 16).scale(size[0], size[1], size[2])
    default: return null   // height fields and SDFs are not drawn
  }
}

function geomColor(g) {
  const matid = model.geom_matid[g]
  const rgba = matid >= 0 ? model.mat_rgba : model.geom_rgba
  const base = (matid >= 0 ? matid : g) * 4
  return [rgba[base], rgba[base + 1], rgba[base + 2], rgba[base + 3]]
}

// ─── The scene ──────────────────────────────────────────────────────────────────────────────────

function disposeScene() {
  if (root) scene.remove(root)
  for (const geometry of owned.geometries) geometry.dispose()
  for (const material of owned.materials) material.dispose()
  owned.geometries.clear(); owned.materials.clear(); bodyGroups.clear()
  root = null
}

function buildScene() {
  disposeScene()
  root = new THREE.Group()
  scene.add(root)

  const extent = Number(model.stat.extent) || 1
  const meshCache = new Map()
  let groundZ = null

  for (let g = 0; g < model.ngeom; g++) {
    if (model.geom_group[g] >= 3) continue          // group 3+ is collision geometry, as in simulate
    const type = model.geom_type[g]
    const size = [model.geom_size[g * 3], model.geom_size[g * 3 + 1], model.geom_size[g * 3 + 2]]
    const [r, gg, b, a] = geomColor(g)
    if (a <= 0) continue

    let geometry = null
    if (type === mujoco.mjtGeom.mjGEOM_MESH.value) {
      const id = model.geom_dataid[g]
      if (id < 0) continue
      if (!meshCache.has(id)) { const made = meshGeometry(id); owned.geometries.add(made); meshCache.set(id, made) }
      geometry = meshCache.get(id)
    } else {
      geometry = primitiveGeometry(type, size)
      if (!geometry) continue
      owned.geometries.add(geometry)
    }

    const plane = type === mujoco.mjtGeom.mjGEOM_PLANE.value
    const material = new THREE.MeshStandardMaterial({
      roughness: plane ? 0.95 : 0.55, metalness: plane ? 0 : 0.12,
      transparent: a < 1, opacity: a, side: plane ? THREE.DoubleSide : THREE.FrontSide,
    })
    material.color.setRGB(r, gg, b, THREE.SRGBColorSpace)
    if (plane) material.color.multiplyScalar(0.1)      // the floor sits behind the robot, not beside it
    owned.materials.add(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = !plane
    mesh.receiveShadow = true
    mesh.position.set(model.geom_pos[g * 3], model.geom_pos[g * 3 + 1], model.geom_pos[g * 3 + 2])
    mesh.quaternion.set(model.geom_quat[g * 4 + 1], model.geom_quat[g * 4 + 2], model.geom_quat[g * 4 + 3], model.geom_quat[g * 4])

    const body = model.geom_bodyid[g]
    if (!bodyGroups.has(body)) { const group = new THREE.Group(); bodyGroups.set(body, group); root.add(group) }
    bodyGroups.get(body).add(mesh)
    if (plane && groundZ === null) groundZ = mesh.position.z
  }

  const span = Math.max(4, extent * 8)
  const divisions = Math.min(80, Math.max(8, Math.round(span / Math.max(extent / 2, 0.05))))
  const grid = new THREE.GridHelper(span, divisions, 0x44444e, 0x2a2a31)
  grid.rotateX(Math.PI / 2)
  grid.position.z = (groundZ ?? 0) + extent * 0.001
  grid.material.transparent = true
  grid.material.opacity = 0.6
  owned.materials.add(grid.material)
  owned.geometries.add(grid.geometry)
  root.add(grid)

  frameCamera(extent)
  syncBodies()
}

function frameCamera(extent) {
  const c = model.stat.center
  const target = new THREE.Vector3(c[0], c[1], c[2])
  controls.target.copy(target)
  camera.near = extent / 100
  camera.far = extent * 400
  camera.position.set(target.x + extent * 1.25, target.y - extent * 1.35, target.z + extent * 0.8)
  camera.updateProjectionMatrix()
  controls.update()

  const key = scene.getObjectByName('key-light')
  key.position.set(target.x + extent * 1.5, target.y - extent * 2, target.z + extent * 3)
  key.target.position.copy(target)
  key.target.updateMatrixWorld()
  const shadow = key.shadow.camera
  shadow.left = -extent * 2; shadow.right = extent * 2; shadow.top = extent * 2; shadow.bottom = -extent * 2
  shadow.near = extent * 0.2; shadow.far = extent * 12
  shadow.updateProjectionMatrix()
  key.shadow.bias = -0.0015 * Math.max(extent, 0.2)
}

/** The one thing every frame does: MuJoCo's body frames into the three.js groups. */
function syncBodies() {
  const xpos = data.xpos, xquat = data.xquat
  for (const [body, group] of bodyGroups) {
    group.position.set(xpos[body * 3], xpos[body * 3 + 1], xpos[body * 3 + 2])
    group.quaternion.set(xquat[body * 4 + 1], xquat[body * 4 + 2], xquat[body * 4 + 3], xquat[body * 4])
  }
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111114)

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
  camera.up.set(0, 0, 1)                    // MuJoCo is Z-up, and so is everything here
  camera.position.set(2, -2, 1.4)

  controls = new OrbitControls(camera, el.canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08

  const hemi = new THREE.HemisphereLight(0xa8bcd8, 0x1b1b20, 1.5)
  hemi.position.set(0, 0, 1)
  scene.add(hemi)
  const key = new THREE.DirectionalLight(0xffffff, 2.1)
  key.name = 'key-light'
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  scene.add(key)
  scene.add(key.target)

  resize()
  addEventListener('resize', resize)
}

function resize() {
  const width = el.canvas.clientWidth || innerWidth
  const height = el.canvas.clientHeight || Math.max(1, innerHeight - 30)
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}

// ─── Loading ────────────────────────────────────────────────────────────────────────────────────

async function loadModel(path) {
  const shown = escape(path)
  overlay(`<div>Loading <b>${shown}</b>…</div>`)
  const listing = await copyTree(path.startsWith('menagerie/') ? path.split('/').slice(0, 2).join('/') : '', (done, total) => {
    overlay(`<div>Loading <b>${shown}</b><br>${done} / ${total} files</div>`)
  })
  if (!listing.files.some((f) => f.path === path)) throw new Error(`${path} is not in ${listing.dir || 'the workspace'}`)

  if (data) { data.delete(); data = null }
  if (model) { model.delete(); model = null }
  loadedPath = null
  model = mujoco.MjModel.mj_loadXML('/working/' + path)
  data = new mujoco.MjData(model)
  loadedPath = path
  resetState()
  buildScene()
  hideOverlay()
}

function resetState() {
  mujoco.mj_resetData(model, data)
  if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0)
  mujoco.mj_forward(model, data)
  shownFrame = -1
}

async function readTrajectory(path) {
  let body
  try {
    const res = await fetch(fileUrl(path) + '?t=' + Date.now())
    if (!res.ok) return null
    body = await res.json()
  } catch { return null }
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.qpos) || !body.qpos.length) return null
  const dt = Number(body.dt) > 0 ? Number(body.dt) : 1 / 30
  const qpos = body.qpos
  return {
    path, model: body.model.replace(/^\/+/, ''), dt, nq: Number(body.nq) || qpos[0].length, qpos,
    // Enough to tell one rollout from the next without walking every frame: a re-record restarts
    // playback, a change to some other file in the workspace does not.
    signature: `${body.model}|${dt}|${qpos.length}|${String(qpos[0])}|${String(qpos[qpos.length - 1])}`,
  }
}

async function refresh() {
  let found = FILE ? await readTrajectory(FILE) : null
  // ?file= may name something that is not a trajectory (the newest .json in the workspace is not
  // necessarily the rollout), so fall back to the one record() writes — unless a model was asked for
  // by name, which wins over a rollout nobody pointed at.
  if (!found && !WANTED_MODEL && FILE !== FALLBACK) found = await readTrajectory(FALLBACK)
  const wanted = found ? found.model : (WANTED_MODEL || null)
  if (!wanted) {
    traj = null; trajPath = null; trajSignature = null
    el.transport.hidden = true; el.name.textContent = 'MuJoCo'; el.hud.textContent = ''
    el.reset.disabled = el.live.disabled = true
    overlay(EMPTY)
    return
  }

  const started = found && found.signature !== trajSignature
  traj = found
  trajPath = found ? found.path : null
  trajSignature = found ? found.signature : null
  try {
    if (wanted !== loadedPath) await loadModel(wanted)
  } catch (error) {
    traj = null; trajSignature = null
    overlay(`<div><b>${escape(wanted)}</b> did not load.<br><code>${escape(String(error.message ?? error)).slice(0, 500)}</code></div>`)
    return
  }
  hideOverlay()

  el.name.textContent = trajPath ?? wanted
  el.transport.hidden = false
  el.reset.disabled = el.live.disabled = false
  el.scrub.hidden = !traj
  if (traj) {
    el.scrub.max = String(traj.qpos.length - 1)
    if (started) { cursor = 0; shownFrame = -1; playing = true }
    cursor = Math.min(cursor, traj.qpos.length - 1)
  } else if (!live) {
    setLive(true)
  }
  drawTransport()
}

// ─── Modes ──────────────────────────────────────────────────────────────────────────────────────

function setLive(on) {
  live = Boolean(on)
  el.live.checked = live
  if (!model) return
  if (live) {
    // Carry the pose on screen into the physics: the rollout's last frame becomes the state it
    // steps from, at rest, holding the model's own first control vector if it has one.
    data.qvel.fill(0)
    data.qacc.fill(0)
    if (model.nu > 0 && model.nkey > 0) { const ctrl = data.ctrl; for (let u = 0; u < model.nu; u++) ctrl[u] = model.key_ctrl[u] }
    data.time = traj ? cursor * traj.dt : data.time
    mujoco.mj_forward(model, data)
  } else {
    shownFrame = -1
  }
  drawTransport()
}

function showFrame(index) {
  const i = Math.max(0, Math.min(index, traj.qpos.length - 1))
  if (i === shownFrame) return
  const row = traj.qpos[i], qpos = data.qpos
  const n = Math.min(row.length, qpos.length)
  for (let k = 0; k < n; k++) qpos[k] = row[k]
  data.time = i * traj.dt
  mujoco.mj_forward(model, data)
  shownFrame = i
}

function drawTransport() {
  el.play.textContent = playing ? '▮▮' : '▶'
  el.play.disabled = !model
  if (!model) return
  if (traj) {
    el.scrub.value = String(Math.round(cursor))
    el.scrub.disabled = live
  }
  el.clock.textContent = live || !traj
    ? `${Number(data.time).toFixed(2)} s · live`
    : `${(cursor * traj.dt).toFixed(2)} s · ${Math.round(cursor) + 1}/${traj.qpos.length}`
}

function drawHud() {
  if (!model) return
  const t = Number(data.time)
  el.hud.textContent = `${t.toFixed(2)} s · ${model.nbody} bodies · ${model.nu} actuators · ${live ? 'live physics' : 'replay'}`
}

// ─── The loop ───────────────────────────────────────────────────────────────────────────────────

function tick(now) {
  requestAnimationFrame(tick)
  const elapsed = Math.min((now - lastTick) / 1000, 0.25)
  lastTick = now
  if (model) {
    if (live) {
      if (playing) {
        // Catch up at most ~35 ms of simulated time per frame: a model too slow to run in real time
        // runs in slow motion instead of freezing the page trying to catch up.
        const budget = Math.min(elapsed * speed, 0.035)
        const start = Number(data.time)
        let guard = 0
        while (Number(data.time) - start < budget && guard++ < 20000) mujoco.mj_step(model, data)
      }
    } else if (traj) {
      if (playing) {
        cursor += (elapsed * speed) / traj.dt
        if (cursor >= traj.qpos.length) cursor = 0
      }
      showFrame(Math.floor(cursor))
    }
    syncBodies()
    drawHud()
    if (playing) drawTransport()
  }
  controls.update()
  renderer.render(scene, camera)
}

// ─── Wiring ─────────────────────────────────────────────────────────────────────────────────────

el.play.addEventListener('click', () => { playing = !playing; drawTransport() })
el.scrub.addEventListener('input', () => { playing = false; cursor = Number(el.scrub.value); if (traj) showFrame(Math.floor(cursor)); drawTransport() })
el.speed.addEventListener('change', () => { speed = Number(el.speed.value) })
el.live.addEventListener('change', () => setLive(el.live.checked))
el.reset.addEventListener('click', () => {
  if (!model) return
  resetState()
  cursor = 0
  if (!live && traj) showFrame(0)
  drawTransport()
})
addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
  if (event.code === 'Space') { event.preventDefault(); el.play.click() }
  else if (event.key === 'r' || event.key === 'R') el.reset.click()
  else if (event.key === 'l' || event.key === 'L') setLive(!live)
})

async function main() {
  try {
    initThree()
  } catch (error) {
    overlay(`<div><b>This pane needs WebGL.</b><br><code>${String(error.message ?? error).slice(0, 200)}</code></div>`)
    return
  }
  overlay('<div>Starting MuJoCo…</div>')
  mujoco = await loadMujoco()
  try { mujoco.FS.mkdir('/working') } catch { /* already there */ }
  mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working')
  await refresh()
  requestAnimationFrame(tick)
  new EventSource('/events').addEventListener('change', () => { refresh().catch((error) => console.error(error)) })
}

main().catch((error) => {
  console.error(error)
  overlay(`<div><b>The viewer could not start.</b><br><code>${String(error.message ?? error).slice(0, 400)}</code></div>`)
})
