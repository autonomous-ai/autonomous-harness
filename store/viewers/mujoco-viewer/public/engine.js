// MuJoCo, compiled to WebAssembly: the model, its state, and everything simulate does to them.
//
// Files: MuJoCo reads from its own in-memory filesystem (MEMFS at /working). The server says which
// files a model needs (GET /api/files, a scan of its MJCF) and the page copies each one in at its
// namespace path, so <include>, meshdir and every mesh resolve exactly as on disk. A file already
// there with the same size and mtime is not fetched again, so reloading an edited scene is quick.
//
// A rollout may carry a snapshot of the compiled model (`model_xml`: MjSpec edits written back as
// MJCF) and a patch of runtime edits (`model_patch`). The snapshot is written beside the source model,
// so its relative asset paths resolve the same way; the patch is applied to the compiled model.
import loadMujoco from '/vendor/mujoco/mujoco.js'

export const SNAPSHOT_NAME = '__harness_rollout_model__.xml'

function fileUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return path.startsWith('menagerie/') ? `/${encoded}` : `/ws/${encoded}`
}

export class Engine {
  static async create() {
    const mujoco = await loadMujoco()
    try { mujoco.FS.mkdir('/working') } catch { /* exists */ }
    mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working')
    return new Engine(mujoco)
  }

  constructor(mujoco) {
    this.mujoco = mujoco
    this.model = null
    this.data = null
    this.option = null     // MjvOption: what mjv_updateScene draws
    this.perturb = null    // MjvPerturb: the body being pushed
    this.scene = null      // MjvScene: decorations (contacts, forces, frames…)
    this.camera = null     // MjvCamera: kept in step with the three.js camera, for perturbation scale
    this.stamps = new Map()  // path → "size:mtime" for what is in MEMFS
    this.path = null
    this.info = null
  }

  get version() { return this.mujoco.mj_versionString() }

  enumValue(group, name) { return this.mujoco[group]?.[name]?.value }

  mkdirp(dir) {
    let acc = ''
    for (const part of dir.split('/')) {
      if (!part) continue
      acc += `/${part}`
      try { this.mujoco.FS.mkdir(acc) } catch { /* exists */ }
    }
  }

  write(path, bytes) {
    const full = `/working/${path}`
    this.mkdirp(full.slice(0, full.lastIndexOf('/')))
    this.mujoco.FS.writeFile(full, bytes)
  }

  /** Bring MEMFS up to date with a list of `{ path, size, mtime }`; returns how many were fetched. */
  async sync(files, onProgress = () => {}) {
    const todo = files.filter((f) => this.stamps.get(f.path) !== `${f.size}:${f.mtime}`)
    let done = 0
    let bytes = 0
    const total = todo.reduce((sum, f) => sum + f.size, 0)
    const queue = todo.slice()
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const res = await fetch(`${fileUrl(next.path)}?v=${next.mtime}`)
        if (!res.ok) throw new Error(`${next.path} could not be fetched (${res.status})`)
        const body = new Uint8Array(await res.arrayBuffer())
        this.write(next.path, body)
        this.stamps.set(next.path, `${next.size}:${next.mtime}`)
        bytes += next.size
        onProgress(++done, todo.length, bytes, total)
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker))
    return todo.length
  }

  /**
   * Compile a model. `modelXml` (a snapshot) is loaded in place of `model` from the model's directory.
   * Throws MuJoCo's own message on a compile error; the previous model stays loaded in that case.
   */
  load({ model, modelXml = null, patch = null }) {
    const m = this.mujoco
    let loadPath = `/working/${model}`
    if (modelXml) {
      const bytes = m.FS.readFile(`/working/${modelXml}`)
      const dir = model.includes('/') ? model.slice(0, model.lastIndexOf('/')) : ''
      const snapshotPath = `${dir ? `${dir}/` : ''}${SNAPSHOT_NAME}`
      this.write(snapshotPath, bytes)
      loadPath = `/working/${snapshotPath}`
    }
    const next = m.MjModel.mj_loadXML(loadPath)
    const data = new m.MjData(next)
    const applied = patch ? this.applyPatch(next, data, patch) : []
    // Kinematics before anyone reads data: lights, cameras and sites have no pose until mj_forward.
    if (next.nkey > 0) m.mj_resetDataKeyframe(next, data, 0)
    m.mj_forward(next, data)
    this.dispose()
    this.model = next
    this.data = data
    this._names = null
    this.path = model
    // Energy is off by default in MuJoCo; the plot and the model tab want it, and it costs almost nothing.
    next.opt.enableflags |= m.mjtEnableBit.mjENBL_ENERGY.value
    this.option = new m.MjvOption()
    m.mjv_defaultOption(this.option)
    this.perturb = new m.MjvPerturb()
    m.mjv_defaultPerturb(this.perturb)
    this.camera = new m.MjvCamera()
    m.mjv_defaultFreeCamera(next, this.camera)
    this.scene = new m.MjvScene(next, 4000)
    this.info = this.describe()
    this.info.patched = applied
    return this.info
  }

  applyPatch(model, data, patch) {
    const applied = []
    for (const [key, value] of Object.entries(patch)) {
      try {
        if (key.startsWith('opt.')) {
          const field = key.slice(4)
          const current = model.opt[field]
          if (ArrayBuffer.isView(current) && Array.isArray(value) && current.length === value.length) current.set(value)
          else if (typeof current === 'number' && typeof value === 'number') model.opt[field] = value
          else continue
        } else {
          const view = model[key]
          if (!ArrayBuffer.isView(view) || !Array.isArray(value) || view.length !== value.length) continue
          view.set(value)
        }
        applied.push(key)
      } catch { /* a field these bindings do not expose */ }
    }
    if (applied.length) this.mujoco.mj_setConst(model, data)
    return applied
  }

  dispose() {
    for (const key of ['scene', 'camera', 'perturb', 'option', 'data', 'model']) {
      try { this[key]?.delete() } catch { /* already gone */ }
      this[key] = null
    }
    this.info = null
  }

  /**
   * An object's name, read out of model.names at name_*adr. Not mj_id2name: for an unnamed object
   * MuJoCo returns NULL, and these bindings turn that into whatever bytes happen to be there.
   */
  name(type, id) {
    const field = { mjOBJ_BODY: 'name_bodyadr', mjOBJ_JOINT: 'name_jntadr', mjOBJ_ACTUATOR: 'name_actuatoradr', mjOBJ_SENSOR: 'name_sensoradr',
      mjOBJ_CAMERA: 'name_camadr', mjOBJ_KEY: 'name_keyadr', mjOBJ_GEOM: 'name_geomadr', mjOBJ_SITE: 'name_siteadr' }[type]
    try {
      const names = this._names ??= this.model.names
      const adr = this.model[field][id]
      let s = ''
      for (let i = adr; i < names.length && names[i] !== 0; i++) s += String.fromCharCode(names[i] & 0xff)
      try { return decodeURIComponent(escape(s)) } catch { return s }
    } catch { return '' }
  }

  /** Names, types and ranges, read once per compile: the panel and the picker work from this. */
  describe() {
    const model = this.model
    const m = this.mujoco
    const T = m.mjtJoint
    const jointType = { [T.mjJNT_FREE.value]: 'free', [T.mjJNT_BALL.value]: 'ball', [T.mjJNT_SLIDE.value]: 'slide', [T.mjJNT_HINGE.value]: 'hinge' }
    const sensorNames = {}
    for (const key of Object.keys(m.mjtSensor)) if (key.startsWith('mjSENS_')) sensorNames[m.mjtSensor[key].value] = key.slice(7).toLowerCase()
    const trn = {}
    for (const key of Object.keys(m.mjtTrn)) if (key.startsWith('mjTRN_')) trn[m.mjtTrn[key].value] = key.slice(6).toLowerCase()

    const bodies = []
    for (let b = 0; b < model.nbody; b++) {
      bodies.push({
        id: b, name: this.name('mjOBJ_BODY', b) || (b === 0 ? 'world' : `body ${b}`), parent: model.body_parentid[b],
        mass: model.body_mass[b], subtreeMass: model.body_subtreemass[b], root: model.body_rootid[b],
        joints: [], geoms: 0, children: [],
      })
    }
    for (const body of bodies) if (body.id > 0) bodies[body.parent].children.push(body.id)
    for (let g = 0; g < model.ngeom; g++) bodies[model.geom_bodyid[g]].geoms++

    const joints = []
    for (let j = 0; j < model.njnt; j++) {
      const type = jointType[model.jnt_type[j]] ?? 'hinge'
      const lo = model.jnt_range[2 * j], hi = model.jnt_range[2 * j + 1]
      const joint = {
        id: j, name: this.name('mjOBJ_JOINT', j) || `${bodies[model.jnt_bodyid[j]]?.name ?? `joint ${j}`} (${type})`, type, body: model.jnt_bodyid[j],
        qpos: model.jnt_qposadr[j], dof: model.jnt_dofadr[j], limited: hi > lo, range: hi > lo ? [lo, hi] : null,
        width: type === 'free' ? 7 : type === 'ball' ? 4 : 1, dofs: type === 'free' ? 6 : type === 'ball' ? 3 : 1,
      }
      joints.push(joint)
      bodies[joint.body].joints.push(j)
    }

    const actuators = []
    for (let a = 0; a < model.nu; a++) {
      const lo = model.actuator_ctrlrange[2 * a], hi = model.actuator_ctrlrange[2 * a + 1]
      const target = model.actuator_trnid[2 * a]
      const kind = trn[model.actuator_trntype[a]] ?? 'joint'
      actuators.push({
        id: a, name: this.name('mjOBJ_ACTUATOR', a) || `actuator ${a}`, limited: hi > lo, range: hi > lo ? [lo, hi] : null,
        transmission: kind, target, joint: kind === 'joint' || kind === 'jointinparent' ? target : -1,
        body: kind === 'joint' || kind === 'jointinparent' ? (joints[target]?.body ?? -1) : kind === 'body' ? target : -1,
      })
    }

    const sensors = []
    const objName = {}
    for (const key of Object.keys(m.mjtObj)) if (key.startsWith('mjOBJ_')) objName[m.mjtObj[key].value] = key
    for (let s = 0; s < model.nsensor; s++) {
      const objtype = model.sensor_objtype[s], objid = model.sensor_objid[s]
      let body = -1
      const kind = objName[objtype]
      if (kind === 'mjOBJ_BODY' || kind === 'mjOBJ_XBODY') body = objid
      else if (kind === 'mjOBJ_JOINT') body = joints[objid]?.body ?? -1
      else if (kind === 'mjOBJ_SITE') body = model.site_bodyid[objid]
      else if (kind === 'mjOBJ_GEOM') body = model.geom_bodyid[objid]
      else if (kind === 'mjOBJ_ACTUATOR') body = actuators[objid]?.body ?? -1
      sensors.push({
        id: s, name: this.name('mjOBJ_SENSOR', s) || `sensor ${s}`, type: sensorNames[model.sensor_type[s]] ?? 'sensor',
        adr: model.sensor_adr[s], dim: model.sensor_dim[s], body,
      })
    }

    const cameras = []
    for (let c = 0; c < model.ncam; c++) cameras.push({ id: c, name: this.name('mjOBJ_CAMERA', c) || `camera ${c}`, fovy: model.cam_fovy[c] })
    const keys = []
    for (let k = 0; k < model.nkey; k++) keys.push({ id: k, name: this.name('mjOBJ_KEY', k) || `key ${k}`, time: model.key_time[k] })

    let totalMass = 0
    for (const body of bodies) if (body.parent === 0 && body.id > 0) totalMass += body.subtreeMass

    return {
      modelName: (() => { try { const bytes = model.names; let s = ''; for (let i = 0; i < bytes.length && bytes[i]; i++) s += String.fromCharCode(bytes[i]); return s } catch { return '' } })(),
      bodies, joints, actuators, sensors, cameras, keys, totalMass,
      nq: model.nq, nv: model.nv, nu: model.nu, na: model.na, ngeom: model.ngeom, nsite: model.nsite, ntendon: model.ntendon,
      timestep: model.opt.timestep, extent: Number(model.stat.extent) || 1,
      center: [model.stat.center[0], model.stat.center[1], model.stat.center[2]],
    }
  }

  // ─── State ────────────────────────────────────────────────────────────────────────────────

  forward() { this.mujoco.mj_forward(this.model, this.data) }

  resetTo(key = -1) {
    const m = this.mujoco
    m.mj_resetData(this.model, this.data)
    if (key >= 0 && key < this.model.nkey) m.mj_resetDataKeyframe(this.model, this.data, key)
    this.forward()
  }

  /** qpos (and qvel, act, ctrl, time when given) into data, then forward kinematics. */
  setState({ qpos, qvel, act, ctrl, time }) {
    const d = this.data
    if (qpos) d.qpos.set(qpos.length === d.qpos.length ? qpos : qpos.slice(0, d.qpos.length))
    if (qvel && qvel.length === d.qvel.length) d.qvel.set(qvel)
    else if (qvel === null) d.qvel.fill(0)
    if (act && act.length === d.act.length) d.act.set(act)
    if (ctrl && ctrl.length === d.ctrl.length) d.ctrl.set(ctrl)
    if (typeof time === 'number') d.time = time
    d.qacc_warmstart.fill(0)
    this.forward()
  }

  /**
   * How many times MuJoCo has reset the simulation for a bad acceleration. data.warning is a view of
   * MjData's own storage: delete the element copy, never the vector, or MjData's memory goes with it.
   */
  warnings() {
    try {
      const bad = this.data.warning.get(this.mujoco.mjtWarning.mjWARN_BADQACC.value)
      const n = bad.number
      bad.delete()
      return n
    } catch { return 0 }
  }

  energy() { const e = this.data.energy; return [e[0], e[1]] }

  // ─── Perturbation, the way simulate does it ───────────────────────────────────────────────

  /** A ray from the camera: the body and point it hits, over geoms in the visible groups. */
  ray(origin, direction, groups) {
    const m = this.mujoco
    const geomid = new m.IntBuffer(1)
    try {
      const dist = m.mj_ray(this.model, this.data, origin, direction, groups, 1, -1, geomid, null)
      const geom = geomid.GetView()[0]
      if (dist < 0 || geom < 0) return null
      return { geom, body: this.model.geom_bodyid[geom], dist, point: [0, 1, 2].map((i) => origin[i] + direction[i] * dist) }
    } finally { geomid.delete() }
  }

  select(body, point) {
    const p = this.perturb
    const d = this.data
    p.select = body
    p.active = 0
    if (body <= 0) return
    // localpos: the grabbed point in the body's frame (xmat is row-major world-from-body).
    const x = [point[0] - d.xpos[3 * body], point[1] - d.xpos[3 * body + 1], point[2] - d.xpos[3 * body + 2]]
    const R = d.xmat
    const o = 9 * body
    p.localpos[0] = R[o] * x[0] + R[o + 3] * x[1] + R[o + 6] * x[2]
    p.localpos[1] = R[o + 1] * x[0] + R[o + 4] * x[1] + R[o + 7] * x[2]
    p.localpos[2] = R[o + 2] * x[0] + R[o + 5] * x[1] + R[o + 8] * x[2]
  }

  beginPerturb(kind) {
    const m = this.mujoco
    if (this.perturb.select <= 0) return false
    m.mjv_initPerturb(this.model, this.data, this.scene, this.perturb)
    this.perturb.active = kind === 'rotate' ? m.mjtPertBit.mjPERT_ROTATE.value : m.mjtPertBit.mjPERT_TRANSLATE.value
    return true
  }

  endPerturb() { if (this.perturb) this.perturb.active = 0 }

  /** Before each mj_step: the spring from the grabbed point to the mouse, as xfrc_applied. */
  applyPerturbForce() {
    const d = this.data
    if (!this.perturb?.active) return
    d.xfrc_applied.fill(0)
    this.mujoco.mjv_applyPerturbForce(this.model, d, this.perturb)
  }

  clearPerturbForce() { this.data?.xfrc_applied.fill(0) }

  /** Paused: drag the body itself (free-joint roots and mocap bodies), as simulate does. */
  applyPerturbPose() {
    if (!this.perturb?.active) return
    this.mujoco.mjv_applyPerturbPose(this.model, this.data, this.perturb, 1)
    this.forward()
  }

  contactForce(i, out) {
    const m = this.mujoco
    const buffer = this._forceBuffer ??= new m.DoubleBuffer(6)
    m.mj_contactForce(this.model, this.data, i, buffer)
    const view = buffer.GetView()
    for (let k = 0; k < 6; k++) out[k] = view[k]
    return out
  }
}
