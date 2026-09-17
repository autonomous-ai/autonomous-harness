// The side panel: what simulate keeps in its right-hand UI. Controls (every actuator as a slider on
// data.ctrl, every joint's position — editable while paused), the model (bodies as a tree, cameras,
// keyframes) and sensors with their live values. Names are workspace content: they go in as text.
import { fmt } from './plot.js'

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function head(title, count, ...buttons) {
  const row = el('div', 'section-head')
  const b = el('b', '', title)
  row.append(b)
  if (count !== undefined) row.append(el('span', '', String(count)))
  row.append(el('span', 'grow'))
  for (const button of buttons) row.append(button)
  return row
}

function miniButton(text, title, onClick) {
  const button = el('button', '', text)
  button.type = 'button'
  if (title) button.title = title
  button.addEventListener('click', onClick)
  return button
}

export class Panel {
  constructor(root, handlers) {
    this.root = root
    this.h = handlers
    this.tabs = { controls: root.querySelector('#tab-controls'), model: root.querySelector('#tab-model'), sensors: root.querySelector('#tab-sensors') }
    this.info = null
    this.rows = { actuators: [], joints: [], sensors: [], bodies: new Map(), cameras: [], keys: [] }
    this.tab = 'controls'
    root.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => this.showTab(button.dataset.tab)))
    this.lastUpdate = 0
    this.source = null
  }

  showTab(tab) {
    this.tab = tab
    this.root.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
    for (const [name, node] of Object.entries(this.tabs)) node.classList.toggle('on', name === tab)
    this.h.onTab?.(tab)
    this.lastUpdate = 0
  }

  setModel(info) {
    this.info = info
    this.buildControls(info)
    this.buildModel(info)
    this.buildSensors(info)
  }

  // ─── Controls ──────────────────────────────────────────────────────────────────────────────

  buildControls(info) {
    const tab = this.tabs.controls
    tab.replaceChildren()
    this.source = el('div', 'source')
    tab.append(this.source)

    this.rows.actuators = []
    const zero = miniButton('Zero', 'Set every control to 0', () => this.h.onZero())
    const fromKey = miniButton('Keyframe', 'Controls from the selected keyframe', () => this.h.onKeyCtrl())
    tab.append(head('Actuators', info.actuators.length, ...(info.actuators.length ? [fromKey, zero] : [])))
    if (!info.actuators.length) tab.append(el('div', 'empty', 'This model has no actuators. Push a body instead: double-click it, then ⌘-drag.'))
    for (const a of info.actuators) {
      const row = el('div', 'row-ctl')
      const name = el('span', 'name', a.name)
      name.title = `${a.name} · ${a.transmission}${a.range ? ` · ctrlrange ${fmt(a.range[0])} … ${fmt(a.range[1])}` : ' · unlimited'}`
      name.addEventListener('click', () => this.h.onSelectBody(a.body, { actuator: a.id }))
      const val = el('span', 'val', '0')
      const slider = document.createElement('input')
      slider.type = 'range'
      const [lo, hi] = a.range ?? [-1, 1]
      slider.min = String(lo); slider.max = String(hi); slider.step = String((hi - lo) / 1000)
      slider.addEventListener('input', () => this.h.onCtrl(a.id, Number(slider.value)))
      slider.addEventListener('pointerdown', () => { row.dataset.dragging = '1' })
      slider.addEventListener('pointerup', () => { delete row.dataset.dragging })
      const range = el('div', 'range')
      range.append(el('span', '', fmt(lo)), el('span', '', a.range ? fmt(hi) : `${fmt(hi)} (unlimited)`))
      row.append(name, val, slider)
      if (a.range) row.append(range)
      tab.append(row)
      this.rows.actuators.push({ a, row, val, slider })
    }

    this.rows.joints = []
    this.jointHint = el('div', 'hint', '')
    tab.append(head('Joints', info.joints.length))
    tab.append(this.jointHint)
    for (const j of info.joints) {
      const row = el('div', 'row-ctl')
      const name = el('span', 'name', `${j.name}`)
      name.title = `${j.name} · ${j.type} joint on ${info.bodies[j.body]?.name ?? 'body'}`
      name.addEventListener('click', () => this.h.onSelectBody(j.body, { joint: j.id }))
      const val = el('span', 'val', '')
      row.append(name, val)
      let slider = null
      if (j.type === 'hinge' || j.type === 'slide') {
        slider = document.createElement('input')
        slider.type = 'range'
        const [lo, hi] = j.range ?? (j.type === 'hinge' ? [-Math.PI, Math.PI] : [-1, 1])
        slider.min = String(lo); slider.max = String(hi); slider.step = String((hi - lo) / 1000)
        slider.addEventListener('input', () => this.h.onJoint(j.id, Number(slider.value)))
        row.append(slider)
      } else {
        row.classList.add('readonly')
      }
      tab.append(row)
      this.rows.joints.push({ j, row, val, slider })
    }
  }

  /** `source`: { kind: 'recording'|'manual'|'keyframe'|'replay', label } */
  setSource(source) {
    const box = this.source
    if (!box) return
    const key = JSON.stringify(source)
    if (this.sourceKey === key) return
    this.sourceKey = key
    box.replaceChildren()
    const text = el('div', 'grow')
    const title = el('b', '', source.title)
    text.append(title, document.createElement('br'), document.createTextNode(source.detail))
    box.append(text)
    if (source.action) {
      const button = miniButton(source.action.label, source.action.title, source.action.run)
      box.append(button)
    }
  }

  // ─── Model ─────────────────────────────────────────────────────────────────────────────────

  buildModel(info) {
    const tab = this.tabs.model
    tab.replaceChildren()
    const summary = el('div', 'summary')
    const cell = (value, label) => { const c = el('div'); c.append(el('b', '', value), el('span', '', label)); return c }
    summary.append(
      cell(String(info.bodies.length - 1), 'bodies'), cell(String(info.joints.length), `joints · ${info.nq} qpos`),
      cell(String(info.actuators.length), 'actuators'), cell(String(info.sensors.length), 'sensors'),
      cell(`${fmt(info.totalMass)} kg`, 'total mass'), cell(`${fmt(info.timestep * 1000)} ms`, 'timestep'),
    )
    tab.append(summary)
    if (info.patched?.length) tab.append(el('div', 'hint', `Includes the agent's runtime edits: ${info.patched.join(', ')}`))

    this.rows.bodies = new Map()
    tab.append(head('Bodies', info.bodies.length - 1))
    const walk = (id, depth) => {
      const body = info.bodies[id]
      const row = el('div', 'tree-row')
      row.style.paddingLeft = `${12 + depth * 12}px`
      const glyph = el('span', 'glyph', body.children.length ? '▾' : '·')
      const nm = el('span', 'nm', body.name)
      const joints = body.joints.map((j) => info.joints[j])
      const meta = el('span', 'meta', `${joints.length ? `${joints.map((j) => j.type).join('+')} · ` : ''}${id === 0 ? '' : `${fmt(body.mass)} kg`}`)
      row.append(glyph, nm, meta)
      row.title = `${body.name} · ${body.geoms} geoms${joints.length ? ` · joints: ${joints.map((j) => j.name).join(', ')}` : ''}`
      row.addEventListener('click', () => this.h.onSelectBody(id))
      row.addEventListener('dblclick', () => this.h.onTrackBody(id))
      tab.append(row)
      this.rows.bodies.set(id, row)
      for (const child of body.children) walk(child, depth + 1)
    }
    walk(0, 0)

    if (info.cameras.length) {
      tab.append(head('Cameras', info.cameras.length))
      for (const c of info.cameras) {
        const row = el('div', 'tree-row sub')
        row.append(el('span', 'glyph', '◧'), el('span', 'nm', c.name), el('span', 'meta', `${fmt(c.fovy)}°`))
        row.addEventListener('click', () => this.h.onCamera(c.id))
        tab.append(row)
      }
    }
    if (info.keys.length) {
      tab.append(head('Keyframes', info.keys.length))
      for (const k of info.keys) {
        const row = el('div', 'tree-row sub')
        row.append(el('span', 'glyph', '◆'), el('span', 'nm', k.name), el('span', 'meta', 'load'))
        row.addEventListener('click', () => this.h.onKeyframe(k.id))
        tab.append(row)
      }
    }
  }

  // ─── Sensors ───────────────────────────────────────────────────────────────────────────────

  buildSensors(info) {
    const tab = this.tabs.sensors
    tab.replaceChildren()
    this.rows.sensors = []
    if (!info.sensors.length) {
      tab.append(el('div', 'empty', 'This model declares no <sensor>. The plot below still shows energy, contacts and any joint you select.'))
      return
    }
    tab.append(head('Sensors', info.sensors.length))
    for (const s of info.sensors) {
      const row = el('div', 'sensor')
      row.append(el('span', 'nm', s.name), el('span', 'ty', `${s.type}${s.dim > 1 ? ` · ${s.dim}` : ''}`))
      const v = el('div', 'v', '')
      row.append(v)
      row.addEventListener('click', () => this.h.onSensor(s.id))
      tab.append(row)
      this.rows.sensors.push({ s, row, v })
    }
  }

  // ─── Live values ───────────────────────────────────────────────────────────────────────────

  markSelection({ body = -1, joint = -1, actuator = -1, sensor = -1 }) {
    for (const [id, row] of this.rows.bodies) row.classList.toggle('sel', id === body && body > 0)
    for (const { j, row } of this.rows.joints) row.classList.toggle('sel', joint >= 0 ? j.id === joint : (body > 0 && j.body === body))
    for (const { a, row } of this.rows.actuators) row.classList.toggle('sel', actuator >= 0 ? a.id === actuator : (body > 0 && a.body === body))
    for (const { s, row } of this.rows.sensors) row.classList.toggle('sel', s.id === sensor)
  }

  scrollToSelection() {
    const tab = this.tabs[this.tab]
    const row = tab?.querySelector('.sel')
    if (row) row.scrollIntoView({ block: 'nearest' })
  }

  update(engine, { editable, force = false }) {
    const now = performance.now()
    if (!force && now - this.lastUpdate < 90) return
    this.lastUpdate = now
    const d = engine.data
    if (!d || this.root.hidden) return
    if (this.tab === 'controls') {
      for (const { a, row, val, slider } of this.rows.actuators) {
        const v = d.ctrl[a.id]
        val.textContent = fmt(v)
        if (!row.dataset.dragging && document.activeElement !== slider) slider.value = String(v)
      }
      this.jointHint.textContent = editable ? 'Paused: drag a joint to pose the model.' : 'Pause (Space) to pose joints by hand.'
      for (const { j, val, slider } of this.rows.joints) {
        const q = d.qpos
        if (j.type === 'free') val.textContent = `${fmt(q[j.qpos])} ${fmt(q[j.qpos + 1])} ${fmt(q[j.qpos + 2])}`
        else if (j.type === 'ball') val.textContent = `${fmt(q[j.qpos])} ${fmt(q[j.qpos + 1])}…`
        else val.textContent = fmt(q[j.qpos])
        if (slider) {
          slider.disabled = !editable
          if (document.activeElement !== slider) slider.value = String(q[j.qpos])
        }
      }
    } else if (this.tab === 'sensors') {
      const data = d.sensordata
      for (const { s, v } of this.rows.sensors) {
        const parts = []
        for (let k = 0; k < Math.min(s.dim, 6); k++) parts.push(fmt(data[s.adr + k]))
        v.textContent = parts.join('  ') + (s.dim > 6 ? '  …' : '')
      }
    }
  }
}
