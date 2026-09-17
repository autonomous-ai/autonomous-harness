// Measure: click two points on the model for the distance between them in millimetres. Points snap
// to a vertex of the face under the cursor, and stick to the object they were placed on — explode
// the model and the measurement travels with its parts.
import * as THREE from 'three'
import { el, put, mm } from './util.js'
import { toBlender } from './viewport.js'

const SNAP_PX = 12

export class Measure {
  constructor(viewport, layer, onChange) {
    this.vp = viewport
    this.layer = layer
    this.onChange = onChange
    this.enabled = false
    this.list = []
    this.pending = null
    this.cursor = null
    const material = new THREE.LineBasicMaterial({ color: 0x2f5bea, depthTest: false, transparent: true, toneMapped: false })
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), material)
    this.lines.renderOrder = 999
    this.lines.frustumCulled = false
    this.preview = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x2f5bea, depthTest: false, transparent: true, opacity: 0.8, dashSize: 1, gapSize: 1, toneMapped: false }))
    this.preview.renderOrder = 999
    this.preview.frustumCulled = false
    viewport.overlay.add(this.lines, this.preview)
  }

  setEnabled(on) {
    this.enabled = on
    if (!on) { this.pending = null; this.cursor = null }
    this.vp.canvas.classList.toggle('measuring', on)
    this.sync()
  }

  /** A point on the surface under the cursor, snapped to the nearest corner of the face when close. */
  probe(e) {
    const hit = this.vp.pick(e.clientX, e.clientY)
    if (!hit) return null
    let world = hit.point.clone()
    let snapped = false
    const g = hit.object.geometry
    if (hit.face && g?.attributes?.position) {
      const rect = this.vp.canvas.getBoundingClientRect()
      const cam = this.vp.camera
      let best = SNAP_PX
      for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(g.attributes.position, index)
        hit.object.localToWorld(v)
        const s = v.clone().project(cam)
        const px = ((s.x + 1) / 2) * rect.width + rect.left, py = ((1 - s.y) / 2) * rect.height + rect.top
        const d = Math.hypot(px - e.clientX, py - e.clientY)
        if (d < best) { best = d; world = v; snapped = true }
      }
    }
    return { object: hit.object, local: hit.object.worldToLocal(world.clone()), snapped, item: hit.item }
  }

  worldOf(p) { return p.object.localToWorld(p.local.clone()) }

  hover(e) {
    if (!this.enabled) return
    this.cursor = this.probe(e)
    this.sync()
  }

  click(e) {
    const p = this.probe(e)
    if (!p) { this.pending = null; this.sync(); return }
    if (!this.pending) this.pending = p
    else { this.list.push({ a: this.pending, b: p }); this.pending = null }
    this.sync()
  }

  undo() {
    if (this.pending) this.pending = null
    else this.list.pop()
    this.sync()
  }

  clear() { this.list = []; this.pending = null; this.sync() }
  remove(i) { this.list.splice(i, 1); this.sync() }

  /** Distance and per-axis deltas (Blender axes) in millimetres. */
  measure(m) {
    const a = this.worldOf(m.a), b = this.worldOf(m.b)
    const k = this.vp.mmPerUnit
    const d = toBlender(b.clone().sub(a)).map((v) => v * k)
    return { a, b, distance: a.distanceTo(b) * k, dx: d[0], dy: d[1], dz: d[2] }
  }

  /** The model was reloaded: points on objects that no longer exist are dropped, the rest re-found. */
  rebind() {
    const byPath = new Map()
    for (const item of this.vp.items) for (const [i, mesh] of item.meshes.entries()) byPath.set(`${item.path}#${i}`, mesh)
    const find = (p) => {
      const item = p.object.userData.__item
      if (!item) return null
      const index = item.meshes.indexOf(p.object)
      const mesh = byPath.get(`${item.path}#${Math.max(0, index)}`)
      return mesh ? { ...p, object: mesh } : null
    }
    this.list = this.list.map((m) => ({ a: find(m.a), b: find(m.b) })).filter((m) => m.a && m.b)
    this.pending = null
    this.cursor = null
    this.sync()
  }

  sync() {
    const positions = []
    for (const m of this.list) { const r = this.measure(m); positions.push(...r.a.toArray(), ...r.b.toArray()) }
    this.lines.geometry.dispose()
    this.lines.geometry = new THREE.BufferGeometry()
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const preview = []
    if (this.enabled && this.pending && this.cursor) preview.push(...this.worldOf(this.pending).toArray(), ...this.worldOf(this.cursor).toArray())
    this.preview.geometry.dispose()
    this.preview.geometry = new THREE.BufferGeometry()
    this.preview.geometry.setAttribute('position', new THREE.Float32BufferAttribute(preview, 3))
    if (preview.length) {
      this.preview.computeLineDistances()
      const wpp = this.vp.nav.worldPerPixel()
      this.preview.material.dashSize = wpp * 6
      this.preview.material.gapSize = wpp * 4
    }
    this.onChange?.()
    this.vp.invalidate()
  }

  /** Dots and labels follow the camera; called after every render. */
  place(camera) {
    const rect = this.vp.canvas.getBoundingClientRect()
    const toScreen = (v) => {
      const s = v.clone().project(camera)
      return { x: ((s.x + 1) / 2) * rect.width, y: ((1 - s.y) / 2) * rect.height, behind: s.z > 1 }
    }
    const nodes = []
    this.list.forEach((m, i) => {
      const r = this.measure(m)
      const a = toScreen(r.a), b = toScreen(r.b)
      nodes.push(el('i', { class: 'mdot', style: { left: `${a.x}px`, top: `${a.y}px` } }), el('i', { class: 'mdot', style: { left: `${b.x}px`, top: `${b.y}px` } }))
      if (!a.behind && !b.behind) {
        nodes.push(el('span', { class: 'mlabel', style: { left: `${(a.x + b.x) / 2}px`, top: `${(a.y + b.y) / 2}px` }, title: `ΔX ${mm(r.dx)}  ΔY ${mm(r.dy)}  ΔZ ${mm(r.dz)}` }, el('b', { text: `${i + 1}` }), mm(r.distance)))
      }
    })
    if (this.enabled && this.pending) {
      const p = toScreen(this.worldOf(this.pending))
      nodes.push(el('i', { class: 'mdot pending', style: { left: `${p.x}px`, top: `${p.y}px` } }))
      if (this.cursor) {
        const c = toScreen(this.worldOf(this.cursor))
        const d = this.worldOf(this.pending).distanceTo(this.worldOf(this.cursor)) * this.vp.mmPerUnit
        nodes.push(el('span', { class: 'mlabel live', style: { left: `${(p.x + c.x) / 2}px`, top: `${(p.y + c.y) / 2}px` } }, mm(d)))
      }
    }
    if (this.enabled && this.cursor) {
      const c = toScreen(this.worldOf(this.cursor))
      nodes.push(el('i', { class: `mcursor${this.cursor.snapped ? ' snapped' : ''}`, style: { left: `${c.x}px`, top: `${c.y}px` } }))
    }
    put(this.layer, ...nodes)
  }
}
