// Navigation, the way Blender's viewport does it: a turntable orbit that keeps Z up, pan, zoom to the
// point under the cursor, the numpad views with smooth transitions and auto-perspective (axis views
// go orthographic, orbiting brings perspective back), and the axis gizmo in the corner.
//
// Coordinates: the glTF is Y-up (Blender's exporter converts), so Blender's X is three's +X, Blender's
// Y is three's −Z and Blender's Z is three's +Y. Every label in the pane speaks Blender's axes.
import * as THREE from 'three'

const FOV = 32
const DEG = Math.PI / 180
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

export const VIEWS = {
  front: { yaw: 0, pitch: 0, name: 'Front' },
  back: { yaw: Math.PI, pitch: 0, name: 'Back' },
  right: { yaw: Math.PI / 2, pitch: 0, name: 'Right' },
  left: { yaw: -Math.PI / 2, pitch: 0, name: 'Left' },
  top: { yaw: 0, pitch: -Math.PI / 2, name: 'Top' },
  bottom: { yaw: 0, pitch: Math.PI / 2, name: 'Bottom' },
  iso: { yaw: 38 * DEG, pitch: -26 * DEG, name: 'User' },
}

// Blender's axes as three.js directions, and the gizmo's colours for them.
const AXES = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#f0414f', view: 'right', opposite: 'left' },
  { label: 'Y', dir: new THREE.Vector3(0, 0, -1), color: '#7cc31f', view: 'back', opposite: 'front' },
  { label: 'Z', dir: new THREE.Vector3(0, 1, 0), color: '#2f86f0', view: 'top', opposite: 'bottom' },
]

export class Navigator {
  /**
   * @param {HTMLElement} surface the element that takes pointer input (the canvas)
   * @param {object} hooks { changed(), click(event), dblclick(event), pick(x, y) → Vector3|null, userInput() }
   */
  constructor(surface, hooks) {
    this.surface = surface
    this.hooks = hooks
    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000)
    this.target = new THREE.Vector3()
    this.yaw = VIEWS.iso.yaw
    this.pitch = VIEWS.iso.pitch
    this.distance = 10
    this.orthographic = false
    this.autoOrtho = false // orthographic because an axis view asked for it; orbiting undoes it
    this.radius = 1
    this.width = 1
    this.height = 1
    this.tween = null
    this.spin = false
    this.quaternion = new THREE.Quaternion()
    this._bind()
    this.apply()
  }

  get camera() { return this.orthographic ? this.ortho : this.persp }

  setSize(width, height) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.apply()
  }

  setSceneRadius(radius) { this.radius = Math.max(radius, 1e-6); this.apply() }

  // ---- state ------------------------------------------------------------------------------------

  snapshot() {
    return { target: this.target.toArray(), yaw: this.yaw, pitch: this.pitch, distance: this.distance, orthographic: this.orthographic, autoOrtho: this.autoOrtho }
  }

  restore(s, animate = false) {
    if (!s || !Array.isArray(s.target)) return
    const to = { target: new THREE.Vector3().fromArray(s.target), yaw: s.yaw, pitch: s.pitch, distance: s.distance }
    this.orthographic = !!s.orthographic
    this.autoOrtho = !!s.autoOrtho
    if (animate) this.animateTo(to)
    else { this.tween = null; this.target.copy(to.target); this.yaw = to.yaw; this.pitch = to.pitch; this.distance = to.distance; this.apply() }
  }

  animateTo(to, duration = 420) {
    const from = { target: this.target.clone(), yaw: this.yaw, pitch: this.pitch, distance: this.distance }
    const goal = {
      target: (to.target ?? this.target).clone(),
      yaw: from.yaw + wrap((to.yaw ?? from.yaw) - from.yaw),
      pitch: to.pitch ?? from.pitch,
      distance: to.distance ?? from.distance,
    }
    this.tween = { from, to: goal, start: performance.now(), duration }
    this.hooks.changed()
  }

  /** Advance a transition or a spin; true while the view is moving. */
  update(now, dt) {
    let moving = false
    if (this.tween) {
      const { from, to, start, duration } = this.tween
      const t = Math.min(1, (now - start) / duration)
      const k = ease(t)
      this.target.lerpVectors(from.target, to.target, k)
      this.yaw = from.yaw + (to.yaw - from.yaw) * k
      this.pitch = from.pitch + (to.pitch - from.pitch) * k
      // distance eases in log space, so a big zoom-out does not rush the first frames
      this.distance = Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * k)
      if (t >= 1) this.tween = null
      moving = true
    }
    if (this.spin && !this.drag) {
      this.yaw = wrap(this.yaw + dt * 0.45)
      moving = true
    }
    if (moving) this.apply()
    return moving || !!this.tween
  }

  apply() {
    this.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion)
    const aspect = this.width / this.height
    const r = this.radius
    this.persp.aspect = aspect
    this.persp.fov = FOV
    this.persp.position.copy(this.target).addScaledVector(back, this.distance)
    this.persp.quaternion.copy(this.quaternion)
    this.persp.near = Math.max(this.distance * 0.002, r * 0.0002, 1e-5)
    this.persp.far = this.distance + r * 60 + this.distance * 40
    this.persp.updateProjectionMatrix()
    const half = this.distance * Math.tan((FOV * DEG) / 2)
    const standoff = Math.max(this.distance, r * 6)
    this.ortho.left = -half * aspect; this.ortho.right = half * aspect
    this.ortho.top = half; this.ortho.bottom = -half
    this.ortho.position.copy(this.target).addScaledVector(back, standoff)
    this.ortho.quaternion.copy(this.quaternion)
    this.ortho.near = standoff * 0.001
    this.ortho.far = standoff + r * 60 + this.distance * 40
    this.ortho.updateProjectionMatrix()
    this.persp.updateMatrixWorld(); this.ortho.updateMatrixWorld()
    this.hooks.changed()
  }

  /** World units per screen pixel at the target's depth. */
  worldPerPixel() { return (2 * this.distance * Math.tan((FOV * DEG) / 2)) / this.height }

  /** Where the view is looking, in Blender's words. */
  viewName() {
    const near = (a, b) => Math.abs(wrap(a - b)) < 0.002
    let name = 'User'
    if (near(this.pitch, -Math.PI / 2)) name = 'Top'
    else if (near(this.pitch, Math.PI / 2)) name = 'Bottom'
    else if (near(this.pitch, 0)) {
      for (const key of ['front', 'back', 'right', 'left']) if (near(this.yaw, VIEWS[key].yaw)) name = VIEWS[key].name
    }
    return `${name} ${this.orthographic ? 'Orthographic' : 'Perspective'}`
  }

  // ---- commands ---------------------------------------------------------------------------------

  view(key, { opposite = false } = {}) {
    let v = VIEWS[key]
    if (!v) return
    if (opposite) v = { yaw: v.yaw + Math.PI, pitch: -v.pitch }
    if (key !== 'iso') { if (!this.orthographic) this.autoOrtho = true; this.orthographic = true }
    else if (this.autoOrtho) { this.orthographic = false; this.autoOrtho = false }
    this.animateTo({ yaw: v.yaw, pitch: v.pitch })
  }

  opposite() { this.animateTo({ yaw: this.yaw + Math.PI, pitch: -this.pitch }) }

  orbitStep(dYaw, dPitch) {
    this.leaveAutoOrtho()
    this.animateTo({ yaw: this.yaw + dYaw, pitch: THREE.MathUtils.clamp(this.pitch + dPitch, -Math.PI / 2, Math.PI / 2) }, 220)
  }

  toggleOrtho() { this.orthographic = !this.orthographic; this.autoOrtho = false; this.apply() }

  leaveAutoOrtho() { if (this.autoOrtho) { this.orthographic = false; this.autoOrtho = false } }

  /** Fit a sphere in the narrower field of view. */
  frame(center, radius, { animate = true, margin = 1.08 } = {}) {
    const vfov = FOV * DEG
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (this.width / this.height))
    const fit = Math.min(vfov, hfov)
    const distance = (Math.max(radius, 1e-6) * margin) / Math.sin(fit / 2)
    if (animate) this.animateTo({ target: center, distance })
    else { this.tween = null; this.target.copy(center); this.distance = distance; this.apply() }
  }

  /** Fit a box snugly: every corner inside the frame, with a margin, from the current direction. */
  fitBox(box, { animate = true, margin = 1.2 } = {}) {
    const center = box.getCenter(new THREE.Vector3())
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.tween ? this.tween.to.pitch : this.pitch, this.tween ? this.tween.to.yaw : this.yaw, 0, 'YXZ'))
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const tv = Math.tan((FOV * DEG) / 2) / margin
    const th = tv * (this.width / this.height)
    let distance = 0
    let half = 0
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const d = new THREE.Vector3(x, y, z).sub(center)
      const px = Math.abs(d.dot(right)), py = Math.abs(d.dot(up)), pz = d.dot(back)
      distance = Math.max(distance, py / tv + pz, px / th + pz)
      half = Math.max(half, py / tv, px / th)
    }
    if (this.orthographic) distance = half
    distance = Math.max(distance, 1e-4)
    if (animate) this.animateTo({ target: center, distance })
    else { this.tween = null; this.target.copy(center); this.distance = distance; this.apply() }
  }

  /** Take the pose of a scene camera: the orbit centre sits in front of it at `depth`. */
  fromCamera(position, quaternion, depth) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion)
    this.tween = null
    this.yaw = Math.atan2(-forward.x, -forward.z)
    this.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1))
    this.distance = Math.max(depth, 1e-4)
    this.target.copy(position).addScaledVector(forward, this.distance)
    this.orthographic = false
    this.autoOrtho = false
    this.apply()
  }

  orbit(dx, dy) {
    this.leaveAutoOrtho()
    this.yaw = wrap(this.yaw - dx * 0.0085)
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0085, -Math.PI / 2, Math.PI / 2)
    this.apply()
  }

  pan(dx, dy) {
    const wpp = this.worldPerPixel()
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion)
    this.target.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp)
    this.apply()
  }

  zoom(factor, clientX, clientY) {
    const min = this.radius * 0.0015, max = this.radius * 400
    const next = THREE.MathUtils.clamp(this.distance * factor, min, max)
    const k = next / this.distance
    if (k === 1) return
    let anchor = null
    if (clientX !== undefined) anchor = this.hooks.pick(clientX, clientY) ?? this.pointOnTargetPlane(clientX, clientY)
    if (anchor) this.target.sub(anchor).multiplyScalar(k).add(anchor)
    this.distance = next
    this.apply()
  }

  pointOnTargetPlane(clientX, clientY) {
    const rect = this.surface.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.target)
    return ray.ray.intersectPlane(plane, new THREE.Vector3())
  }

  // ---- input ------------------------------------------------------------------------------------

  _bind() {
    const s = this.surface
    s.addEventListener('contextmenu', (e) => e.preventDefault())
    s.addEventListener('pointerdown', (e) => {
      if (this.drag) return
      s.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: e.button, moved: false, mode: null, e }
    })
    s.addEventListener('pointermove', (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) { this.hooks.hover?.(e); return }
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      d.x = e.clientX; d.y = e.clientY
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return
        d.moved = true
        d.mode = this.modeFor(d.button, e)
        this.tween = null
        this.hooks.userInput?.()
        s.classList.add('dragging')
      }
      if (d.mode === 'orbit') this.orbit(dx, dy)
      else if (d.mode === 'pan') this.pan(dx, dy)
      else if (d.mode === 'zoom') this.zoom(Math.exp(dy * 0.01), d.x0, d.y0)
    })
    const end = (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      this.drag = null
      s.classList.remove('dragging')
      if (!d.moved && e.type === 'pointerup' && d.button === 0) this.hooks.click(e)
    }
    s.addEventListener('pointerup', end)
    s.addEventListener('pointercancel', end)
    s.addEventListener('dblclick', (e) => this.hooks.dblclick(e))

    let lastKind = null, lastAt = 0
    s.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.tween = null
      if (e.ctrlKey) {
        // Chrome reports a pinch as ctrl+wheel; Safari as gesture events (below) — never both at once
        if (this.gesturing) return
        this.hooks.userInput?.(); this.zoom(Math.exp(e.deltaY * 0.012), e.clientX, e.clientY); return
      }
      const now = performance.now()
      let kind = lastKind
      if (!kind || now - lastAt > 250) {
        // A trackpad or Magic Mouse scrolls in small pixel steps, often sideways; a wheel in notches.
        const wheel = e.deltaMode !== 0 || (e.deltaX === 0 && (Math.abs(e.wheelDeltaY) % 120 === 0 && Math.abs(e.wheelDeltaY) >= 120))
        kind = wheel ? 'wheel' : 'trackpad'
      }
      lastKind = kind; lastAt = now
      this.hooks.userInput?.()
      if (kind === 'wheel') { const lines = e.deltaMode === 1 ? 30 : 1; this.zoom(Math.exp(e.deltaY * lines * 0.0016), e.clientX, e.clientY) }
      else if (e.shiftKey) this.pan(e.deltaX, e.deltaY)
      else this.orbit(e.deltaX * 0.75, e.deltaY * 0.75)
    }, { passive: false })

    // Safari's trackpad pinch
    let gestureScale = 1
    s.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; this.gesturing = true })
    s.addEventListener('gestureend', (e) => { e.preventDefault(); this.gesturing = false })
    s.addEventListener('gesturechange', (e) => {
      e.preventDefault()
      this.hooks.userInput?.()
      this.zoom(gestureScale / e.scale, e.clientX, e.clientY)
      gestureScale = e.scale
    })
  }

  modeFor(button, e) {
    if (button === 2) return 'pan'
    if (button === 1) return e.shiftKey ? 'pan' : e.ctrlKey || e.metaKey ? 'zoom' : 'orbit'
    if (e.shiftKey) return 'pan'
    if (e.ctrlKey || e.metaKey) return 'zoom'
    return 'orbit'
  }
}

/** The axis gizmo: three coloured balls that turn with the view; click one to look along it. */
export class Gizmo {
  constructor(host, nav, onView) {
    this.nav = nav
    this.onView = onView
    this.size = 84
    this.el = host
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.svg.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`)
    this.svg.setAttribute('width', this.size)
    this.svg.setAttribute('height', this.size)
    this.svg.classList.add('gizmo-svg')
    host.prepend(this.svg)
    this.balls = []
    let drag = null
    this.svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false }; this.svg.setPointerCapture(e.pointerId) })
    this.svg.addEventListener('pointermove', (e) => {
      if (!drag) { this.hover(e); return }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y
      drag.x = e.clientX; drag.y = e.clientY
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 3) { drag.moved = true; nav.tween = null; nav.hooks.userInput?.() }
      if (drag.moved) nav.orbit(dx * 1.4, dy * 1.4)
    })
    this.svg.addEventListener('pointerup', (e) => {
      const d = drag; drag = null
      if (d && !d.moved) {
        const hit = this.hit(e)
        if (hit) onView(hit.view)
      }
    })
    this.svg.addEventListener('pointerleave', () => { this.hovered = null; this.draw() })
  }

  hit(e) {
    const rect = this.svg.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    let best = null
    for (const b of this.balls) {
      const d = Math.hypot(b.x - x, b.y - y)
      if (d <= b.r + 3 && (!best || b.z > best.z)) best = b
    }
    return best
  }

  hover(e) {
    const hit = this.hit(e)
    const key = hit ? hit.key : null
    if (key !== this.hovered) { this.hovered = key; this.draw() }
  }

  draw() {
    const c = this.size / 2, R = this.size / 2 - 11
    const inv = this.nav.quaternion.clone().invert()
    const items = []
    for (const axis of AXES) {
      for (const sign of [1, -1]) {
        const v = axis.dir.clone().multiplyScalar(sign).applyQuaternion(inv)
        // Clicking +X looks from +X (Blender's Right view); a ball already facing you flips the view.
        const facing = v.z > 0.999
        const view = sign > 0 ? (facing ? axis.opposite : axis.view) : (facing ? axis.view : axis.opposite)
        items.push({ key: `${sign > 0 ? '' : '-'}${axis.label}`, label: axis.label, sign, color: axis.color, x: c + v.x * R, y: c - v.y * R, z: v.z, view, r: sign > 0 ? 8.5 : 6.5 })
      }
    }
    items.sort((a, b) => a.z - b.z)
    this.balls = items
    let out = `<circle cx="${c}" cy="${c}" r="${c - 1}" class="gizmo-bg"/>`
    for (const b of items) {
      if (b.sign > 0) out += `<line x1="${c}" y1="${c}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" stroke="${b.color}" stroke-width="2" stroke-linecap="round" opacity="${b.z < -0.2 ? 0.55 : 1}"/>`
    }
    for (const b of items) {
      const hot = this.hovered === b.key
      if (b.sign > 0) {
        out += `<circle cx="${b.x.toFixed(2)}" cy="${b.y.toFixed(2)}" r="${b.r + (hot ? 1 : 0)}" fill="${b.color}" ${hot ? 'stroke="#fff" stroke-width="1.5"' : ''}/>`
        out += `<text x="${b.x.toFixed(2)}" y="${(b.y + 3.3).toFixed(2)}" text-anchor="middle" class="gizmo-label">${b.label}</text>`
      } else {
        out += `<circle cx="${b.x.toFixed(2)}" cy="${b.y.toFixed(2)}" r="${b.r + (hot ? 1 : 0)}" fill="${b.color}" fill-opacity="${hot ? 0.75 : 0.32}" stroke="${b.color}" stroke-width="1.2"/>`
        if (hot) out += `<text x="${b.x.toFixed(2)}" y="${(b.y + 3).toFixed(2)}" text-anchor="middle" class="gizmo-label small">-${b.label}</text>`
      }
    }
    this.svg.innerHTML = out
  }
}
