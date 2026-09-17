// The Outliner and the Properties panel: the scene as Blender names it — collections, objects, their
// children — with eyes to hide, a click to select, a double-click to frame; and for the selection its
// dimensions in millimetres, transform, mesh counts, modifiers, materials and custom properties.
import * as THREE from 'three'
import { el, put, icon, int, mm, deg } from './util.js'
import { toBlender } from './viewport.js'

const TYPE_ICON = { COLLECTION: 'collection', MESH: 'mesh', CURVE: 'mesh', FONT: 'mesh', SURFACE: 'mesh', META: 'mesh', EMPTY: 'empty', CAMERA: 'camObj', LIGHT: 'light', SCENE: 'collection', ARMATURE: 'empty' }
const TYPE_NAME = { COLLECTION: 'Collection', MESH: 'Mesh', CURVE: 'Curve', FONT: 'Text', EMPTY: 'Empty', CAMERA: 'Camera', LIGHT: 'Light', SCENE: 'Scene', ARMATURE: 'Armature', SURFACE: 'Surface', META: 'Metaball' }

const hex = (color) => `#${color.getHexString(THREE.SRGBColorSpace)}`

export class Outliner {
  constructor(viewport, { tree, props, card, filter }, actions) {
    this.vp = viewport
    this.treeEl = tree
    this.propsEl = props
    this.cardEl = card
    this.filterEl = filter
    this.actions = actions
    this.collapsed = new Set()
    this.query = ''
    filter.addEventListener('input', () => { this.query = filter.value.trim().toLowerCase(); this.renderTree() })
    tree.addEventListener('click', (e) => this.onTreeClick(e))
    tree.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row')
      if (!row || e.target.closest('.eye, .twisty')) return
      const item = this.byId(row.dataset.id)
      if (!item) return
      if (item.object.isCamera) this.actions.lookThrough(item)
      else { this.vp.select(item); this.vp.frameSelected() }
    })
    tree.addEventListener('pointerover', (e) => {
      const row = e.target.closest('.row')
      this.vp.setHover(row ? this.byId(row.dataset.id) : null)
    })
    tree.addEventListener('pointerleave', () => this.vp.setHover(null))
  }

  byId(id) { return this.vp.items.find((i) => String(i.id) === String(id)) }

  rebuild() {
    // collapse objects with children by default; collections stay open, as in Blender
    const keep = new Set([...this.collapsed])
    this.collapsed = new Set()
    for (const item of this.vp.items) {
      if (keep.has(item.path) || (item.children.length && item.type !== 'COLLECTION' && this.vp.items.length > 40)) this.collapsed.add(item.path)
    }
    this.render()
  }

  render() { this.renderTree(); this.renderProps(); this.renderCard() }

  onTreeClick(e) {
    const row = e.target.closest('.row')
    if (!row) return
    const item = this.byId(row.dataset.id)
    if (!item) return
    if (e.target.closest('.twisty')) {
      if (this.collapsed.has(item.path)) this.collapsed.delete(item.path)
      else this.collapsed.add(item.path)
      this.renderTree()
      return
    }
    if (e.target.closest('.eye')) {
      if (e.altKey) this.actions.isolate(item)
      else this.vp.setHidden(item, !item.hidden)
      return
    }
    if (e.target.closest('.solo')) { this.actions.isolate(item); return }
    const extend = e.shiftKey || e.metaKey || e.ctrlKey
    this.vp.select(item, { extend, toggle: extend })
  }

  renderTree() {
    const vp = this.vp
    const rows = []
    const q = this.query
    const matches = (item) => !q || item.name.toLowerCase().includes(q) || item.children.some(matches)
    const walk = (item, depth) => {
      if (!matches(item)) return
      const hasKids = item.children.length > 0
      const open = q ? true : !this.collapsed.has(item.path)
      const selected = vp.selection.has(item)
      const effective = item.shown !== false
      const kind = TYPE_ICON[item.type] ?? 'empty'
      const count = item.type === 'COLLECTION' ? item.children.length : item.stats?.triangles ? shortInt(item.stats.triangles) : ''
      rows.push(el('div', {
        class: `row${selected ? ' selected' : ''}${vp.active === item ? ' active' : ''}${effective ? '' : ' dim'}${item.hidden ? ' hidden-self' : ''}`,
        'data-id': item.id, style: { '--depth': depth }, title: item.type === 'COLLECTION' ? `${item.name} — collection` : item.name,
      },
      hasKids ? el('button', { class: `twisty${open ? ' open' : ''}`, html: icon.chevron, 'aria-label': open ? 'Collapse' : 'Expand' }) : el('span', { class: 'twisty-space' }),
      el('span', { class: `ticon t-${kind}`, html: icon[kind] }),
      el('span', { class: 'name', text: item.name }),
      count !== '' ? el('span', { class: 'count', text: count, title: item.type === 'COLLECTION' ? `${count} children` : `${int(item.stats.triangles)} triangles` }) : null,
      item.meshes.length || item.type === 'COLLECTION' ? el('button', { class: 'solo', html: icon.isolate, title: 'Show only this (Alt-click the eye)' }) : null,
      el('button', { class: `eye${item.hidden ? ' off' : ''}`, html: item.hidden ? icon.eyeOff : icon.eye, title: item.hidden ? 'Show' : 'Hide (H)' })))
      if (hasKids && open) item.children.forEach((c) => walk(c, depth + 1))
    }
    const root = vp.root
    if (!root) { put(this.treeEl, el('div', { class: 'tree-empty', text: 'No scene loaded' })); return }
    if (root.type === 'SCENE') root.children.forEach((c) => walk(c, 0))
    else walk(root, 0)
    if (!rows.length) rows.push(el('div', { class: 'tree-empty', text: q ? `Nothing named “${q}”` : 'The scene is empty' }))
    put(this.treeEl, ...rows)
    // keep the active row in view — inside the tree only; scrollIntoView would scroll the page
    const active = this.treeEl.querySelector('.row.active')
    if (active) {
      const top = active.offsetTop, bottom = top + active.offsetHeight, t = this.treeEl
      if (top < t.scrollTop) t.scrollTop = top - 4
      else if (bottom > t.scrollTop + t.clientHeight) t.scrollTop = bottom - t.clientHeight + 4
    }
  }

  // ---- the facts about one item -------------------------------------------------------------------

  facts(item) {
    const vp = this.vp
    const k = vp.mmPerUnit
    const f = item.facts ?? {}
    const o = item.object
    const out = { type: TYPE_NAME[item.type] ?? item.type }
    const pos = o.position.clone().sub(item.explodeApplied ?? new THREE.Vector3())
    out.location = f.location_mm ?? toBlender(pos).map((v) => v * k)
    if (f.rotation_deg) out.rotation = f.rotation_deg
    else {
      const q = o.quaternion
      const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q.x, -q.z, q.y, q.w), 'ZYX')
      out.rotation = [e.x, e.y, e.z].map((r) => THREE.MathUtils.radToDeg(r))
    }
    out.scale = f.scale ?? [o.scale.x, o.scale.z, o.scale.y]
    if (item.meshes.length) {
      if (f.dimensions_mm) out.dimensions = f.dimensions_mm
      else {
        const box = new THREE.Box3()
        const inv = new THREE.Matrix4().copy(o.matrixWorld).invert()
        for (const m of item.meshes) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
          const local = m === o ? new THREE.Matrix4() : new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
          box.union(m.geometry.boundingBox.clone().applyMatrix4(local))
        }
        const s = box.getSize(new THREE.Vector3())
        out.dimensions = [s.x * o.scale.x * k, s.z * o.scale.z * k, s.y * o.scale.y * k]
      }
    }
    const worldBox = vp.boxOf(vp.descendants(item), false)
    if (!worldBox.isEmpty()) { const s = worldBox.getSize(new THREE.Vector3()); out.bounds = [s.x * k, s.z * k, s.y * k] }
    return out
  }

  materialsOf(item) {
    const seen = new Map()
    for (const m of item.meshes) for (const mat of [].concat(m.userData.__orig ?? [])) if (mat && !seen.has(mat.uuid)) seen.set(mat.uuid, mat)
    return [...seen.values()]
  }

  // ---- properties ---------------------------------------------------------------------------------

  renderProps() {
    const vp = this.vp
    const item = vp.active
    if (!vp.root) { put(this.propsEl, ); return }
    if (!item) { put(this.propsEl, ...this.sceneSummary()); return }
    const f = this.facts(item)
    const kind = TYPE_ICON[item.type] ?? 'empty'
    const parts = [
      el('div', { class: 'p-title' }, el('span', { class: `ticon t-${kind}`, html: icon[kind] }), el('span', { class: 'p-name', text: item.name }), el('span', { class: 'p-type', text: f.type })),
    ]
    const multi = vp.selection.size > 1 ? el('div', { class: 'p-note', text: `${vp.selection.size} selected · showing the active one` }) : null
    if (multi) parts.push(multi)
    if (f.dimensions || f.bounds) {
      const d = f.dimensions ?? f.bounds
      parts.push(section('Dimensions', axisGrid(d.map((v) => mm(v)), true)))
    }
    if (item.type !== 'COLLECTION') {
      parts.push(section('Transform',
        el('div', { class: 'p-sub', text: 'Location' }), axisGrid(f.location.map((v) => mm(v))),
        el('div', { class: 'p-sub', text: 'Rotation' }), axisGrid(f.rotation.map((v) => deg(v))),
        el('div', { class: 'p-sub', text: 'Scale' }), axisGrid(f.scale.map((v) => fmtScale(v))),
      ))
    }
    const fa = item.facts ?? {}
    if (item.meshes.length) {
      const rows = [
        ['Vertices', int(fa.vertices ?? item.stats.vertices)],
        fa.faces !== undefined ? ['Faces', int(fa.faces)] : null,
        ['Triangles', int(fa.triangles ?? item.stats.triangles)],
        fa.edges !== undefined ? ['Edges', int(fa.edges)] : null,
        item.meshName || fa.mesh ? ['Mesh data', fa.mesh ?? item.meshName] : null,
      ].filter(Boolean)
      const body = [kv(rows)]
      if (fa.modifiers?.length) body.push(el('div', { class: 'chips' }, fa.modifiers.map((m) => el('span', { class: 'chip', title: m.type, text: m.name }))))
      parts.push(section('Mesh', ...body))
      const mats = this.materialsOf(item)
      if (mats.length) parts.push(section(`Material${mats.length > 1 ? 's' : ''}`, ...mats.map((m) => this.materialRow(m))))
    }
    if (item.type === 'COLLECTION') {
      const all = vp.descendants(item).filter((i) => i.meshes.length)
      const tris = all.reduce((n, i) => n + i.stats.triangles, 0)
      parts.push(section('Contents', kv([['Objects', int(all.length)], ['Triangles', int(tris)]])))
    }
    if (item.object.isCamera) {
      const c = item.object
      const cf = fa.camera ?? {}
      parts.push(section('Camera', kv([
        cf.lens_mm ? ['Focal length', `${cf.lens_mm} mm`] : null,
        c.isPerspectiveCamera ? ['Field of view', deg(c.fov)] : ['Type', 'Orthographic'],
        cf.scene_camera ? ['Scene camera', 'yes'] : null,
      ].filter(Boolean)), el('button', { class: 'p-action', html: `${icon.camera}<span>Look through</span><kbd>0</kbd>`, onclick: () => this.actions.lookThrough(item) })))
    }
    if (item.object.isLight) {
      const l = item.object
      const lf = fa.light ?? {}
      parts.push(section('Light', kv([
        ['Type', lf.type ? cap(lf.type) : l.type.replace('Light', '')],
        lf.energy_w !== undefined ? ['Power', lf.type === 'SUN' ? `${lf.energy_w} W/m²` : `${lf.energy_w} W`] : null,
        ['Colour', el('span', { class: 'swatch-inline' }, el('i', { class: 'swatch', style: { background: hex(l.color) } }), hex(l.color))],
      ].filter(Boolean))))
    }
    const where = [
      fa.collections?.length ? ['Collection', fa.collections.join(', ')] : item.parent?.type === 'COLLECTION' ? ['Collection', item.parent.name] : null,
      fa.parent ? ['Parent', fa.parent] : item.parent && item.parent.type !== 'COLLECTION' && item.parent.type !== 'SCENE' ? ['Parent', item.parent.name] : null,
      item.children.length && item.type !== 'COLLECTION' ? ['Children', int(item.children.length)] : null,
    ].filter(Boolean)
    if (where.length) parts.push(section('Relations', kv(where)))
    const custom = Object.entries(item.extras ?? {}).filter(([key]) => !key.startsWith('__'))
    if (custom.length) parts.push(section('Custom properties', kv(custom.map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]))))
    put(this.propsEl, ...parts)
  }

  materialRow(m) {
    const facts = this.vp.sceneExtras?.materials?.[m.name]
    const color = m.color ? hex(m.color) : '#cccccc'
    const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'].filter((k) => m[k]).map((k) => ({ map: 'base colour', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metal', emissiveMap: 'emission', aoMap: 'AO', alphaMap: 'alpha' }[k]))
    const bits = []
    if (m.metalness !== undefined) bits.push(`metal ${fmt(m.metalness)}`)
    if (m.roughness !== undefined) bits.push(`rough ${fmt(m.roughness)}`)
    if (m.transmission) bits.push(`transmission ${fmt(m.transmission)}`)
    if (m.opacity < 1 || m.transparent) bits.push(`alpha ${fmt(m.opacity)}`)
    if (m.emissive && m.emissive.getHex() !== 0) bits.push('emissive')
    return el('div', { class: 'mat' },
      el('i', { class: 'swatch big', style: { background: color }, title: `base colour ${color}${facts?.viewport_color ? ` · viewport ${hex(new THREE.Color().setRGB(...facts.viewport_color.slice(0, 3), THREE.LinearSRGBColorSpace))}` : ''}` }),
      el('div', { class: 'mat-text' }, el('div', { class: 'mat-name', text: m.name || 'Material' }), el('div', { class: 'mat-meta', text: [bits.join(' · '), maps.length ? `maps: ${maps.join(', ')}` : ''].filter(Boolean).join(' — ') })))
  }

  sceneSummary() {
    const vp = this.vp
    const meshes = vp.items.filter((i) => i.meshes.length)
    const tris = meshes.reduce((n, i) => n + i.stats.triangles, 0)
    const verts = meshes.reduce((n, i) => n + (i.facts?.vertices ?? i.stats.vertices), 0)
    const collections = vp.items.filter((i) => i.type === 'COLLECTION' && i.name !== 'Scene Collection')
    const materials = new Map()
    for (const i of meshes) for (const m of this.materialsOf(i)) materials.set(m.name || m.uuid, m)
    const cams = vp.items.filter((i) => i.object.isCamera)
    const lights = vp.items.filter((i) => i.object.isLight)
    const x = vp.sceneExtras ?? {}
    const box = vp.bounds
    const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3())
    const units = { file: 'from the export', report: 'from report.json', guess: 'guessed — set in Shading ▾', chosen: 'chosen' }[vp.unitSource]
    const parts = [
      el('div', { class: 'p-title' }, el('span', { class: 'ticon t-collection', html: icon.model }), el('span', { class: 'p-name', text: this.actions.modelName() }), el('span', { class: 'p-type', text: 'Scene' })),
      el('div', { class: 'p-note', text: 'Click an object in the viewport or the outliner to inspect it.' }),
    ]
    if (size) parts.push(section('Size', axisGrid([size.x, size.z, size.y].map((v) => mm(v * vp.mmPerUnit)), true), el('div', { class: 'p-foot', text: `Units ${units}` })))
    parts.push(section('Scene', kv([
      ['Objects', int(meshes.length)],
      collections.length ? ['Collections', int(collections.length)] : null,
      ['Vertices', int(verts)],
      ['Triangles', int(tris)],
      cams.length ? ['Cameras', cams.map((c) => c.name).join(', ')] : null,
      lights.length ? ['Lights', lights.map((c) => c.name).join(', ')] : null,
      vp.anim ? ['Animation', `${vp.anim.clips.length} action${vp.anim.clips.length > 1 ? 's' : ''} · ${Math.round((vp.anim.end - vp.anim.start) * vp.anim.fps)} frames`] : null,
      x.blender ? ['Blender', x.blender] : null,
    ].filter(Boolean))))
    if (materials.size) parts.push(section(`Materials`, ...[...materials.values()].slice(0, 12).map((m) => this.materialRow(m))))
    return parts
  }

  /** The small card for narrow panes, where the sidebar is closed. */
  renderCard() {
    const vp = this.vp
    const item = vp.active
    const open = this.actions.sidebarOpen()
    if (!item || open) { this.cardEl.hidden = true; return }
    const f = this.facts(item)
    const kind = TYPE_ICON[item.type] ?? 'empty'
    const mats = item.meshes.length ? this.materialsOf(item) : []
    const d = f.dimensions ?? f.bounds
    put(this.cardEl, 
      el('div', { class: 'c-head' }, el('span', { class: `ticon t-${kind}`, html: icon[kind] }), el('span', { class: 'c-name', text: item.name }),
        vp.selection.size > 1 ? el('span', { class: 'c-more', text: `+${vp.selection.size - 1}` }) : null,
        el('button', { class: 'c-open', text: 'Details', onclick: () => this.actions.openSidebar() })),
      d ? el('div', { class: 'c-dims' }, ...['X', 'Y', 'Z'].flatMap((a, i) => [el('b', { class: `ax ax-${a.toLowerCase()}`, text: a }), el('span', { text: mm(d[i], false) })]), el('span', { class: 'c-unit', text: 'mm' })) : null,
      el('div', { class: 'c-meta' },
        item.meshes.length ? el('span', { text: `${int(item.stats.triangles)} tris` }) : el('span', { text: f.type }),
        ...mats.slice(0, 3).map((m) => el('span', { class: 'swatch-inline' }, el('i', { class: 'swatch', style: { background: m.color ? hex(m.color) : '#ccc' } }), m.name || 'Material'))),
    )
    this.cardEl.hidden = false
  }
}

function section(title, ...children) {
  return el('section', { class: 'p-sec' }, el('h4', { text: title }), ...children)
}

function axisGrid(values, strong = false) {
  // a value may carry its unit ("12.5 mm"): the number reads first, the unit small and faint
  const cell = (v) => { const m = /^(.*?)\s(mm)$/.exec(v); return m ? [el('span', { class: 'n', text: m[1] }), el('i', { class: 'u', text: m[2] })] : [el('span', { class: 'n', text: v })] }
  return el('div', { class: `axes${strong ? ' strong' : ''}` }, ...['X', 'Y', 'Z'].map((a, i) => el('div', { class: 'axis', title: `${a} ${values[i]}` }, el('b', { class: `ax ax-${a.toLowerCase()}`, text: a }), ...cell(values[i]))))
}

function kv(rows) {
  return el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), typeof v === 'string' ? el('dd', { text: v }) : el('dd', {}, v)]))
}

const fmt = (v) => (Math.round(v * 100) / 100).toString()
const fmtScale = (v) => (Math.abs(v - Math.round(v)) < 1e-4 ? Math.round(v).toString() : v.toFixed(3).replace(/0+$/, ''))
const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase()
const shortInt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
