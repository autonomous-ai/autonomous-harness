// The schematic: one module at a time, drawn by netlistsvg on the server from the `yosys prep`
// netlist, with the hierarchy beside it. Pan and zoom, hover to name a cell or a net, click a net
// to trace it, search, and open an instance to walk down into it.
import { h, ICONS, emptyState, ART, showTip, hideTip, esc, getText } from './util.js'

const SVGNS = 'http://www.w3.org/2000/svg'

function srcRef(src) {
  // "rtl/uart_tx.v:23.27-23.31" or "rtl/a.v:1.1-2.2|rtl/b.v:3.1-4.4"
  const m = /^([^:|]+):(\d+)/.exec(src ?? '')
  return m ? { path: m[1], line: Number(m[2]) } : null
}

function cleanName(name) {
  if (!name) return ''
  if (name.startsWith('$')) {
    // $procmux$123, $and$rtl/foo.v:12$4 → "$and (rtl/foo.v:12)"
    const m = /^\$(\w+)\$([^$]*\.s?v:\d+)/.exec(name)
    if (m) return `$${m[1]} · ${m[2]}`
    return name.replace(/\$\d+$/, '')
  }
  return name.replace(/^\\/, '')
}

export class SchematicTab {
  constructor(root, ctx) {
    this.root = root
    this.ctx = ctx
    this.tree = null
    this.stamp = null
    this.path = '' // instance path of the module on screen ('' = top)
    this.index = null
    this.svg = null
    this.view = null
    this.selected = null
    this.visible = false
    this.treeOpen = null
    this.build()
  }

  build() {
    const r = this.root
    r.innerHTML = ''
    this.btnTree = h('button.btn', { title: 'Hierarchy', onclick: () => this.toggleTree() }, h('span', { html: ICONS.tree }), h('span', 'Hierarchy'))
    this.crumbs = h('div.crumbs')
    this.search = h('input.search', { placeholder: 'Find a net, cell or port', spellcheck: 'false', style: { maxWidth: '240px', flex: '0 1 240px' } })
    this.busy = h('span.pill.busy', { hidden: true }, 'synthesizing')
    this.count = h('span.pill', { hidden: true })
    r.append(h('div.toolbar',
      this.btnTree, h('span.sep'), this.crumbs, h('span.grow'), this.busy, this.count, this.search,
      h('button.icon-btn', { title: 'Up one level (U)', onclick: () => this.up(), html: ICONS.up }),
      h('button.icon-btn', { title: 'Fit (F)', onclick: () => this.fit(), html: ICONS.fit })))
    this.treeEl = h('div.sch-tree')
    this.stage = h('div.sch-stage')
    this.info = h('div.sch-info')
    this.overlay = h('div', { style: { position: 'absolute', inset: 0, background: 'var(--bg)' }, hidden: true })
    this.stageWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex' } }, this.stage, this.info, this.overlay)
    this.body = h('div.sch-body', this.treeEl, this.stageWrap)
    r.append(this.body)
    this.suggest = h('div.suggest', { hidden: true })
    document.body.append(this.suggest)
    this.wire()
  }

  show() {
    this.visible = true
    this.layoutTree()
    if (this.svg && (!this.view || this.fitPending)) this.fit()
    else this.apply()
  }
  hide() { this.visible = false; hideTip(); this.suggest.hidden = true }
  resize() { this.layoutTree(); this.apply() }
  reset() { this.stamp = null; this.path = ''; this.tree = null; this.svg = null; this.view = null }

  update(state, paths) {
    const f = state.files?.schematic
    const synthRunning = ['synth', 'schematic', 'svg'].some((s) => this.ctx.stepRunning(s))
    this.busy.hidden = !synthRunning
    if (!f) {
      if (synthRunning) this.empty({ spinner: true, title: 'Synthesizing…', body: 'The schematic appears when <code>yosys prep</code> has written the netlist.' })
      else {
        const failed = this.ctx.step('schematic')?.state === 'failed' || this.ctx.step('synth')?.state === 'failed'
        this.empty(failed
          ? { icon: ART.schematic, title: 'Synthesis failed', body: h('p', this.ctx.step('synth')?.error ?? '', h('br'), h('br'), h('button.btn', { onclick: () => this.ctx.openLog('synth') }, 'Open the log')) }
          : { icon: ART.schematic, title: 'No schematic yet', body: 'The flow draws each module of <code>rtl/*.v</code> here once it has synthesised them.' })
      }
      return
    }
    const stamp = `${f.mtime}:${f.size}`
    if (stamp === this.stamp) return
    // The netlist is rewritten in one go by yosys; wait for the step to finish writing it.
    if (this.ctx.stepRunning('schematic') && this.tree) return
    this.stamp = stamp
    this.load()
    void paths
  }

  empty(opts) {
    this.overlay.hidden = false
    this.overlay.innerHTML = ''
    this.overlay.append(emptyState(opts))
  }

  async load() {
    let res
    try { res = await this.ctx.api('netlist') } catch (e) {
      this.empty({ icon: ART.schematic, title: 'Could not read the netlist', body: esc(e.message) })
      return
    }
    this.tree = res.tree
    this.searchAll = null
    this.ctx.api('netlist/names').then((r) => { this.searchAll = r.names }).catch(() => {})
    if (!this.nodeAt(this.path)) this.path = ''
    this.renderTree()
    this.layoutTree()
    await this.open(this.path, { keepView: true })
  }

  nodeAt(path) {
    if (!this.tree) return null
    if (!path) return this.tree
    let node = this.tree
    for (const part of path.split('.')) {
      node = node.children.find((c) => c.name === part)
      if (!node) return null
    }
    return node
  }

  // ------------------------------------------------------------------------------- hierarchy

  layoutTree() {
    const wide = this.root.clientWidth >= 900
    const hasKids = Boolean(this.tree?.children?.length)
    const open = this.treeOpen ?? (wide && hasKids)
    this.treeEl.hidden = !open || !this.tree
    this.treeEl.classList.toggle('overlay', !wide)
    this.btnTree.setAttribute('aria-pressed', String(open && Boolean(this.tree)))
  }
  toggleTree() { this.treeOpen = this.treeEl.hidden; this.layoutTree() }

  renderTree() {
    const t = this.treeEl
    t.innerHTML = ''
    const walk = (node, depth) => {
      t.append(h(`div.tr${node.path === this.path ? '.cur' : ''}`, {
        style: { paddingLeft: `${8 + depth * 14}px` },
        title: `${node.path || node.name} · ${node.label}${node.params && Object.keys(node.params).length ? `\n${Object.entries(node.params).map(([k, v]) => `${k} = ${v}`).join('\n')}` : ''}`,
        onclick: () => { this.open(node.path); if (this.treeEl.classList.contains('overlay')) { this.treeOpen = false; this.layoutTree() } },
      },
      h('span.scope-ic', { html: ICONS.module }),
      h('span.nm', depth === 0 ? node.label : node.name),
      depth ? h('span.typ', node.label) : null,
      h('span.cnt', String(node.cells))))
      for (const c of node.children) walk(c, depth + 1)
    }
    if (this.tree) walk(this.tree, 0)
  }

  renderCrumbs() {
    const c = this.crumbs
    c.innerHTML = ''
    const parts = this.path ? this.path.split('.') : []
    const nodes = [this.tree]
    let n = this.tree
    for (const p of parts) { n = n?.children.find((x) => x.name === p); nodes.push(n) }
    nodes.forEach((node, k) => {
      if (!node) return
      if (k) c.append(h('span.sl', '›'))
      const path = parts.slice(0, k).join('.')
      c.append(h('button', { onclick: () => this.open(path), title: node.module }, k ? node.name : node.label, k === nodes.length - 1 && k ? h('span.ty', node.label) : null))
    })
  }

  up() {
    if (!this.path) return
    const parts = this.path.split('.')
    const child = parts.pop()
    this.open(parts.join('.'), { focusCell: child })
  }

  // --------------------------------------------------------------------------------- module

  async open(path, { keepView = false, focusCell = null } = {}) {
    const node = this.nodeAt(path)
    if (!node) return
    const changed = path !== this.path
    this.path = path
    this.renderTree()
    this.renderCrumbs()
    this.clearSelection()
    const token = (this.token = Symbol('open'))
    const slow = setTimeout(() => {
      if (token === this.token) this.empty({ spinner: true, title: `Laying out ${node.label}…`, body: `${node.cells} cells · netlistsvg + ELK` })
    }, 150)
    let svgText, index
    try {
      ;[svgText, index] = await Promise.all([
        getText(`/api/schematic.svg?${new URLSearchParams({ top: this.ctx.top, module: node.module })}`),
        this.ctx.api('netlist/module', { module: node.module }),
      ])
    } catch (e) {
      clearTimeout(slow)
      if (token === this.token) this.empty({ icon: ART.schematic, title: `Could not draw ${node.label}`, body: esc(e.message) })
      return
    }
    clearTimeout(slow)
    if (token !== this.token) return
    this.index = index
    this.mount(svgText, node)
    this.overlay.hidden = true
    this.count.hidden = false
    const nCells = Object.values(index.cells).length
    this.count.textContent = `${nCells} cell${nCells === 1 ? '' : 's'} · ${Object.keys(index.ports).length} ports`
    if (changed || !keepView || !this.view) this.fit()
    else this.apply()
    if (focusCell) this.selectCell(focusCell, true)
  }

  mount(text, node) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const src = doc.documentElement
    const svg = document.importNode(src, true)
    svg.querySelectorAll('style').forEach((s) => s.remove())
    svg.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'))
    const w = parseFloat(svg.getAttribute('width')) || 800
    const hgt = parseFloat(svg.getAttribute('height')) || 600
    svg.removeAttribute('width'); svg.removeAttribute('height')
    svg.setAttribute('class', 'sheet')
    this.size = { w, h: hgt }

    // cells: hover target, and instances of other modules marked so they read as openable
    this.cellEls = new Map()
    for (const g of svg.querySelectorAll('g[id^="cell_"]')) {
      const name = g.id.slice(5)
      g.classList.add('cellg')
      const type = g.getAttribute('s:type') ?? g.getAttributeNS('https://github.com/nturley/netlistsvg', 'type')
      if (type) g.classList.add(`t-${type.replace(/[^\w-]/g, '_')}`)
      g.dataset.cell = name
      const info = this.index.cells[name]
      if (info?.module) g.classList.add('sub')
      this.cellEls.set(name, g)
    }
    // nets: every wire segment carries class net_<bits>; give each an invisible wide twin to hover
    this.netEls = new Map()
    const hits = []
    for (const el of svg.querySelectorAll('line, path, polyline')) {
      const cls = [...el.classList].find((c) => c.startsWith('net_'))
      if (!cls) continue
      const key = cls.slice(4)
      if (!this.netEls.has(key)) this.netEls.set(key, [])
      this.netEls.get(key).push(el)
      const hit = el.cloneNode()
      hit.setAttribute('class', 'hit')
      hit.dataset.net = key
      hits.push(hit)
    }
    const hitLayer = document.createElementNS(SVGNS, 'g')
    hits.forEach((x) => hitLayer.append(x))
    svg.append(hitLayer)
    this.stage.innerHTML = ''
    this.stage.append(svg)
    this.svg = svg
    this.node = node
  }

  // ------------------------------------------------------------------------------ pan/zoom

  fit() {
    if (!this.svg) return
    // hidden, the stage has no size to fit to: fit again when it is shown
    this.fitPending = !this.stage.clientWidth
    const W = this.stage.clientWidth || 600, H = this.stage.clientHeight || 400
    const pad = 28
    const scale = Math.min((W - pad * 2) / this.size.w, (H - pad * 2) / this.size.h, 2.5)
    this.view = { cx: this.size.w / 2, cy: this.size.h / 2, scale: Math.max(0.02, scale) }
    this.apply()
  }

  apply() {
    if (!this.svg || !this.view) return
    const W = this.stage.clientWidth || 600, H = this.stage.clientHeight || 400
    const { cx, cy, scale } = this.view
    this.svg.setAttribute('viewBox', `${cx - W / 2 / scale} ${cy - H / 2 / scale} ${W / scale} ${H / scale}`)
  }

  toSvg(clientX, clientY) {
    const r = this.stage.getBoundingClientRect()
    const { cx, cy, scale } = this.view
    return { x: cx + (clientX - r.left - r.width / 2) / scale, y: cy + (clientY - r.top - r.height / 2) / scale }
  }

  zoomTo(bbox) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight
    const pad = 60
    const scale = Math.min((W - pad) / Math.max(bbox.width, 40), (H - pad) / Math.max(bbox.height, 40), 3)
    this.view = { cx: bbox.x + bbox.width / 2, cy: bbox.y + bbox.height / 2, scale: Math.min(Math.max(scale, this.view?.scale ?? 0.5), 3) }
    this.apply()
  }

  wire() {
    const st = this.stage
    st.addEventListener('wheel', (e) => {
      if (!this.view) return
      e.preventDefault()
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2) {
        this.view.cx += e.deltaX / this.view.scale
        this.apply()
        return
      }
      const p = this.toSvg(e.clientX, e.clientY)
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022))
      const scale = Math.max(0.02, Math.min(this.view.scale * f, 12))
      const k = this.view.scale / scale
      this.view = { cx: p.x - (p.x - this.view.cx) * k, cy: p.y - (p.y - this.view.cy) * k, scale }
      this.apply()
    }, { passive: false })

    let drag = null
    st.addEventListener('pointerdown', (e) => {
      if (!this.view || e.button !== 0) return
      drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false, target: e.target, id: e.pointerId }
    })
    st.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y
        // Capture only once it is a drag, so a double-click still lands on the cell under it.
        if (!drag.moved && Math.hypot(dx, dy) > 3) { drag.moved = true; st.classList.add('dragging'); st.setPointerCapture(drag.id); hideTip() }
        if (drag.moved) {
          this.view.cx = drag.cx - dx / this.view.scale
          this.view.cy = drag.cy - dy / this.view.scale
          this.apply()
          return
        }
      }
      this.hover(e)
    })
    st.addEventListener('pointerup', (e) => {
      if (!drag) return
      st.classList.remove('dragging')
      if (!drag.moved) this.click(drag.target, e)
      drag = null
    })
    st.addEventListener('pointerleave', () => { hideTip(); this.unhover() })
    st.addEventListener('dblclick', (e) => {
      const g = e.target.closest?.('g.cellg')
      const info = g && this.index?.cells[g.dataset.cell]
      if (info?.module) this.open(this.path ? `${this.path}.${g.dataset.cell}` : g.dataset.cell)
      else if (!g && !e.target.closest?.('.hit')) this.fit()
    })

    // search with suggestions
    let hi = 0, items = []
    const renderSuggest = () => {
      const q = this.search.value.trim().toLowerCase()
      this.suggest.innerHTML = ''
      if (!q || !this.index) { this.suggest.hidden = true; return }
      const all = []
      for (const [name, p] of Object.entries(this.index.ports)) all.push({ kind: 'port', name, label: name, sub: `${p.direction} ${p.width > 1 ? `[${p.width - 1}:0]` : ''}` })
      for (const [key, n] of Object.entries(this.index.nets)) {
        for (const name of n.names) if (!name.startsWith('$')) all.push({ kind: 'net', name, key, label: name, sub: n.width > 1 ? `[${n.width - 1}:0]` : '' })
      }
      for (const [name, c] of Object.entries(this.index.cells)) all.push({ kind: c.module ? 'inst' : 'cell', name, label: c.module ? name : cleanName(name), sub: c.type })
      items = all.filter((x) => x.label.toLowerCase().includes(q) || x.sub?.toLowerCase().includes(q))
        .sort((a, b) => (a.label.toLowerCase() === q ? -1 : 0) - (b.label.toLowerCase() === q ? -1 : 0) || a.label.length - b.label.length)
        .slice(0, 30)
      // and the same name elsewhere in the hierarchy, one click away
      const elsewhere = (this.searchAll ?? []).filter((x) => x.path !== this.path && x.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.length - b.name.length).slice(0, 20)
      items = items.concat(elsewhere.map((x) => ({ ...x, label: x.name, sub: x.path || this.tree?.label, remote: true })))
      if (!items.length) {
        this.suggest.innerHTML = ''
        this.suggest.append(h('div', { style: { color: 'var(--faint)', cursor: 'default' } }, 'Nothing by that name in any module'))
        const r = this.search.getBoundingClientRect()
        Object.assign(this.suggest.style, { top: `${r.bottom + 4}px`, left: `${Math.max(6, r.left)}px`, width: `${Math.max(r.width, 260)}px` })
        this.suggest.hidden = false
        return
      }
      hi = Math.min(hi, items.length - 1)
      items.forEach((it, k) => this.suggest.append(h(`div${k === hi ? '.on' : ''}`, {
        onpointerdown: (e) => { e.preventDefault(); this.pick(it) },
      }, h('span.kind', it.kind), h('span.nm', it.label), it.sub ? h('span', { style: { color: it.remote ? 'var(--teal)' : 'var(--faint)', fontSize: '11px' } }, it.remote ? `in ${it.sub}` : it.sub) : null)))
      const r = this.search.getBoundingClientRect()
      this.suggest.hidden = false
      this.suggest.style.top = `${r.bottom + 4}px`
      const w = Math.max(r.width, 260)
      this.suggest.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - w - 6))}px`
      this.suggest.style.width = `${w}px`
    }
    this.search.addEventListener('input', () => { hi = 0; renderSuggest() })
    this.search.addEventListener('focus', renderSuggest)
    this.search.addEventListener('blur', () => setTimeout(() => { this.suggest.hidden = true }, 120))
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { hi = Math.min(items.length - 1, hi + 1); renderSuggest(); e.preventDefault() }
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); renderSuggest(); e.preventDefault() }
      else if (e.key === 'Enter' && items[hi]) { this.pick(items[hi]); e.preventDefault() }
      else if (e.key === 'Escape') { this.search.value = ''; this.suggest.hidden = true; this.search.blur() }
    })
  }

  async pick(it) {
    this.suggest.hidden = true
    this.search.blur()
    if (it.remote) {
      await this.open(it.path)
      if (it.kind === 'net') {
        const key = Object.entries(this.index?.nets ?? {}).find(([, n]) => n.names.includes(it.name))?.[0]
        return key ? this.selectNet(key, true) : null
      }
      return this.cellEls?.has(it.name) ? this.selectCell(it.name, true) : null
    }
    if (it.kind === 'net') this.selectNet(it.key, true)
    else if (it.kind === 'port') {
      // a port is drawn as its own node; its net carries the same name
      const key = Object.entries(this.index.nets).find(([, n]) => n.names.includes(it.name))?.[0]
      if (this.cellEls.has(it.name)) this.selectCell(it.name, true)
      else if (key) this.selectNet(key, true)
    } else this.selectCell(it.name, true)
  }

  // ------------------------------------------------------------------------------ inspect

  netInfo(key) {
    const n = this.index?.nets[key]
    if (n) return n
    // a slice or concatenation of bits: name each bit
    const bits = key.split(',')
    const names = bits.map((b) => this.index?.bitNames[b]?.[0] ?? (/^[01xz]$/.test(b) ? `1'b${b}` : `#${b}`))
    return { names: [names.length > 4 ? `{${names.slice(0, 4).join(', ')}, …}` : names.length > 1 ? `{${names.join(', ')}}` : names[0]], width: bits.length, derived: true }
  }

  hover(e) {
    const t = e.target
    const hit = t.closest?.('.hit')
    const g = t.closest?.('g.cellg')
    this.unhover()
    if (hit) {
      const key = hit.dataset.net
      for (const el of this.netEls.get(key) ?? []) el.classList.add('hov')
      this.hovered = key
      const n = this.netInfo(key)
      const named = n.names.filter((x) => !x.startsWith('$'))
      const main = named[0] ?? cleanName(n.names[0])
      showTip(e.clientX, e.clientY, `<span class="dim">net</span> <span class="mono">${esc(main)}</span>${n.width > 1 ? ` <span class="dim">[${n.width - 1}:0]</span>` : ''}${named.length > 1 ? `<br><span class="dim">also ${esc(named.slice(1, 4).join(', '))}</span>` : ''}`)
      return
    }
    if (g) {
      const name = g.dataset.cell
      const info = this.index?.cells[name]
      const port = this.index?.ports[name]
      if (port) showTip(e.clientX, e.clientY, `<span class="dim">${esc(port.direction)} port</span> <span class="mono">${esc(name)}</span>${port.width > 1 ? ` <span class="dim">[${port.width - 1}:0]</span>` : ''}`)
      else if (info) showTip(e.clientX, e.clientY, `${info.module ? '<span class="dim">instance</span> ' : ''}<span class="mono">${esc(info.module ? name : cleanName(name))}</span><br><span class="dim">${esc(info.type)}${info.src ? ` · ${esc(info.src.split('|')[0])}` : ''}</span>${info.module ? '<br><span class="dim">double-click to open</span>' : ''}`)
      else hideTip()
      return
    }
    hideTip()
  }

  unhover() {
    if (!this.hovered) return
    for (const el of this.netEls.get(this.hovered) ?? []) el.classList.remove('hov')
    this.hovered = null
  }

  click(target) {
    const hit = target.closest?.('.hit')
    const g = target.closest?.('g.cellg')
    if (hit) this.selectNet(hit.dataset.net)
    else if (g) this.selectCell(g.dataset.cell)
    else this.clearSelection()
  }

  clearSelection() {
    this.svg?.classList.remove('focus')
    this.svg?.querySelectorAll('.lit').forEach((el) => el.classList.remove('lit'))
    this.selected = null
    this.info.innerHTML = ''
  }

  selectNet(key, zoom) {
    this.clearSelection()
    const els = this.netEls.get(key) ?? []
    if (!els.length) return
    this.svg.classList.add('focus')
    els.forEach((el) => el.classList.add('lit'))
    // the cells on this net stay lit too
    const touched = new Set()
    for (const el of els) {
      const x = [el.getAttribute('x1'), el.getAttribute('x2')].map(Number), y = [el.getAttribute('y1'), el.getAttribute('y2')].map(Number)
      for (const [name, g] of this.cellEls) {
        if (touched.has(name)) continue
        const b = g.getBBox?.()
        const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '')
        if (!b || !m) continue
        const gx = Number(m[1]), gy = Number(m[2])
        for (let k = 0; k < 2; k++) {
          if (x[k] >= gx + b.x - 3 && x[k] <= gx + b.x + b.width + 3 && y[k] >= gy + b.y - 3 && y[k] <= gy + b.y + b.height + 3) { touched.add(name); break }
        }
      }
    }
    touched.forEach((name) => this.cellEls.get(name).classList.add('lit'))
    this.selected = { kind: 'net', key }
    const n = this.netInfo(key)
    const named = n.names.filter((x) => !x.startsWith('$'))
    const main = named[0] ?? cleanName(n.names[0])
    const ref = srcRef(n.src)
    this.card('Net', main + (n.width > 1 ? ` [${n.width - 1}:0]` : ''),
      [named.length > 1 ? `also ${named.slice(1, 5).join(', ')}` : '', `${touched.size} cell${touched.size === 1 ? '' : 's'} on it`].filter(Boolean).join(' · '),
      [
        ref ? h('button.btn', { onclick: () => this.ctx.openSource(ref.path, ref.line) }, h('span', { html: ICONS.code }), `${ref.path}:${ref.line}`) : null,
        named.length && this.ctx.addWave ? h('button.btn', { onclick: () => this.ctx.addWave(named[0], this.path) }, h('span', { html: ICONS.wave }), 'Show in waves') : null,
      ])
    if (zoom) {
      const box = this.unionBox(els)
      if (box) this.zoomTo(box)
    }
  }

  selectCell(name, zoom) {
    this.clearSelection()
    const g = this.cellEls.get(name)
    const info = this.index?.cells[name]
    const port = this.index?.ports[name]
    if (!g) return
    this.svg.classList.add('focus')
    g.classList.add('lit')
    this.selected = { kind: 'cell', name }
    if (port) {
      const key = Object.entries(this.index.nets).find(([, n]) => n.names.includes(name))?.[0]
      if (key) (this.netEls.get(key) ?? []).forEach((el) => el.classList.add('lit'))
      this.card(`${port.direction} port`, name + (port.width > 1 ? ` [${port.width - 1}:0]` : ''), '', [
        this.ctx.addWave ? h('button.btn', { onclick: () => this.ctx.addWave(name, this.path) }, h('span', { html: ICONS.wave }), 'Show in waves') : null,
      ])
    } else if (info) {
      const ref = srcRef(info.src)
      const params = info.params && Object.keys(info.params).length ? Object.entries(info.params).map(([k, v]) => `${k}=${v}`).join(' ') : ''
      this.card(info.module ? 'Instance' : 'Cell', info.module ? `${name} : ${info.type}` : cleanName(name), info.module ? params : info.type, [
        info.module ? h('button.btn', { onclick: () => this.open(this.path ? `${this.path}.${name}` : name) }, 'Open') : null,
        ref ? h('button.btn', { onclick: () => this.ctx.openSource(ref.path, ref.line) }, h('span', { html: ICONS.code }), `${ref.path}:${ref.line}`) : null,
      ])
    }
    if (zoom) {
      const b = g.getBBox()
      const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '')
      if (m) this.zoomTo({ x: Number(m[1]) + b.x - 40, y: Number(m[2]) + b.y - 40, width: b.width + 80, height: b.height + 80 })
    }
  }

  unionBox(els) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const el of els) {
      const b = el.getBBox()
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height)
    }
    return Number.isFinite(x0) ? { x: x0 - 30, y: y0 - 30, width: x1 - x0 + 60, height: y1 - y0 + 60 } : null
  }

  card(kind, title, sub, actions) {
    this.info.innerHTML = ''
    this.info.append(h('div.card',
      h('div.k', kind), h('div.t', title), sub ? h('div.s', sub) : null,
      actions?.filter(Boolean).length ? h('div.acts', actions.filter(Boolean)) : null))
  }

  key(e) {
    if (e.key === 'f' || e.key === 'F') { this.fit(); e.preventDefault() }
    else if (e.key === '/') { this.search.focus(); e.preventDefault() }
    else if (e.key === 'u' || e.key === 'U' || (e.key === 'Backspace' && this.path)) { this.up(); e.preventDefault() }
    else if (e.key === 'h' || e.key === 'H') { this.toggleTree() }
    else if (e.key === 'Escape') this.clearSelection()
    else if (e.key === 'Enter' && this.selected?.kind === 'cell') {
      const info = this.index?.cells[this.selected.name]
      if (info?.module) this.open(this.path ? `${this.path}.${this.selected.name}` : this.selected.name)
    }
  }
}
