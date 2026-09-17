// The waveform viewer: a signal browser over the VCD's scopes, lanes on a canvas, a cursor and a
// marker, radix per signal, analog buses, and a UART decoder for serial lines.
//
// Time is kept in VCD ticks (out/sim.vcd's timescale); the view is a span [t0, t1] mapped onto the
// lanes' width. Every signal's changes arrive once as sorted arrays, so each frame is a binary
// search to the left edge and a walk to the right one — with runs of changes that land inside the
// same couple of pixels collapsed into one dense block, so a clock reads as a clock at any zoom.
import { h, ICONS, colors, fitCanvas, emptyState, ART, showTip, hideTip, openMenu, esc } from './util.js'
import { upperBound, valueIndex, valueAt, formatValue, charOf, numeric, uartTiming, uartDecode, frameAt } from './wavecore.js'

const ROW = 26
const ROW_ANALOG = 64
const ROW_UART = 46
const RADIXES = ['hex', 'dec', 'sdec', 'bin', 'oct', 'ascii']
const RADIX_LABEL = { hex: 'Hexadecimal', dec: 'Unsigned decimal', sdec: 'Signed decimal', bin: 'Binary', oct: 'Octal', ascii: 'ASCII' }
const RADIX_SHORT = { hex: 'hex', dec: 'dec', sdec: '±dec', bin: 'bin', oct: 'oct', ascii: 'ascii' }
const UNITS = [['s', 1e15], ['ms', 1e12], ['µs', 1e9], ['ns', 1e6], ['ps', 1e3], ['fs', 1]]

// ------------------------------------------------------------------------------------- time

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-12)))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

// ------------------------------------------------------------------------------------ the tab

export class WavesTab {
  constructor(root, ctx) {
    this.root = root
    this.ctx = ctx
    this.meta = null
    this.metaStamp = null
    this.vars = new Map() // path -> var
    this.rows = []
    this.data = new Map() // id -> decoded changes
    this.loading = new Set()
    this.span = { t0: 0, t1: 1 }
    this.cursor = null
    this.marker = null
    this.hoverT = null
    this.sel = -1
    this.scrollY = 0
    this.namesW = 220
    this.browserOpen = null
    this.filter = ''
    this.expanded = new Set()
    this.restored = false
    this.visible = false
    this.raf = 0
    this.build()
  }

  // ------------------------------------------------------------------------------- DOM

  build() {
    const r = this.root
    r.innerHTML = ''
    this.toolbar = h('div.toolbar')
    this.btnBrowser = h('button.btn', { title: 'Signal browser (S)', onclick: () => this.toggleBrowser() }, h('span', { html: ICONS.list }), h('span', 'Signals'))
    this.readCursor = h('span.readout', { title: 'Cursor (click in the lanes)' })
    this.readDelta = h('span.readout', { title: 'Marker (shift-click, or M) and the time between it and the cursor' })
    this.busyPill = h('span.pill.busy', { hidden: true }, 'simulating')
    this.stalePill = h('span.pill.warn', { hidden: true, title: 'The last simulation failed; these waves are from the run before it.' }, 'previous run')
    this.toolbar.append(
      this.btnBrowser,
      h('span.sep'),
      h('button.icon-btn', { title: 'Zoom out (−)', onclick: () => this.zoom(2) , html: ICONS.zout }),
      h('button.icon-btn', { title: 'Zoom in (+)', onclick: () => this.zoom(0.5), html: ICONS.zin }),
      h('button.icon-btn', { title: 'Zoom to fit (F)', onclick: () => this.fit(), html: ICONS.fit }),
      h('span.sep'),
      this.readCursor, this.readDelta,
      h('span.grow'),
      this.busyPill, this.stalePill,
    )

    this.body = h('div.wv-body')
    this.browser = h('aside.wv-browser')
    this.filterInput = h('input.search', { placeholder: 'Find a signal', spellcheck: 'false', oninput: () => { this.filter = this.filterInput.value; this.renderTree() } })
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.tree.querySelector('.tr.var')
        first?.click()
        e.preventDefault()
      }
    })
    this.tree = h('div.wv-tree')
    this.browser.append(h('div.wv-browser-head', this.filterInput), this.tree)

    this.main = h('div.wv-main')
    this.grid = h('div.wv-grid')
    this.namesHead = h('div.wv-names-head', h('span', 'Signal'), h('span', 'Value'))
    this.ruler = h('canvas.wv-ruler')
    this.names = h('div.wv-names')
    this.namesInner = h('div', { style: { position: 'relative' } })
    this.names.append(this.namesInner)
    this.lanes = h('div.wv-lanes')
    this.canvas = h('canvas.wv-canvas')
    this.vbar = h('div.wv-vscroll', { hidden: true }, h('i'))
    this.lanes.append(this.canvas, this.vbar)
    this.resizer = h('div.wv-resize', { title: 'Drag to resize the names column' })
    this.hbar = h('div.wv-hbar', h('i'))
    this.grid.append(
      h('div.wv-head', this.namesHead, this.ruler),
      h('div.wv-rows', this.names, this.lanes),
      h('div.wv-foot', h('div.wv-foot-l'), this.hbar),
      this.resizer,
    )
    this.main.append(this.grid)
    this.overlay = h('div', { style: { position: 'absolute', inset: '0' }, hidden: true })
    this.main.append(this.overlay)
    this.body.append(this.browser, this.main)
    r.append(this.toolbar, this.body)
    this.setNamesW(this.namesW)
    this.wire()
  }

  setNamesW(w) {
    const max = Math.max(140, (this.main.clientWidth || 800) * 0.6)
    this.namesW = Math.round(Math.max(120, Math.min(w, max)))
    this.grid.style.setProperty('--names-w', `${this.namesW}px`)
    this.resizer.style.left = `${this.namesW}px`
  }

  // --------------------------------------------------------------------------- lifecycle

  show() { this.visible = true; this.layoutBrowser(); this.draw() }
  hide() { this.visible = false; hideTip() }
  resize() { this.layoutBrowser(); this.setNamesW(this.namesW); this.draw() }
  theme() { this.draw() }
  reset() {
    this.meta = null; this.metaStamp = null; this.rows = []; this.data.clear(); this.restored = false
    this.cursor = null; this.marker = null; this.sel = -1
  }

  update(state, paths) {
    const vcd = state.files?.vcd
    const simStep = state.flow?.steps?.find((s) => s.id === 'sim')
    const simulating = simStep?.state === 'running'
    this.busyPill.hidden = !simulating
    this.stalePill.hidden = !(simStep?.state === 'failed' && vcd)
    if (!vcd) {
      this.meta = null
      this.showEmpty(state, simulating)
      return
    }
    const stamp = `${vcd.mtime}:${vcd.size}`
    // Mid-simulation the VCD is half written; keep the last good one on screen until vvp is done.
    if (stamp !== this.metaStamp && (!simulating || !this.meta)) {
      if (simulating && !this.meta) { this.showEmpty(state, true); return }
      this.loadMeta(stamp)
    }
    void paths
  }

  showEmpty(state, simulating) {
    this.overlay.hidden = false
    this.overlay.innerHTML = ''
    const simStep = state.flow?.steps?.find((s) => s.id === 'sim')
    let node
    if (simulating) {
      node = emptyState({ spinner: true, title: 'Simulating…', body: 'The waveforms appear as soon as <code>vvp</code> finishes writing <code>out/sim.vcd</code>.' })
    } else if (simStep?.state === 'failed') {
      node = emptyState({ icon: ART.waves, title: 'The simulation did not run', body: h('p', simStep.error || 'iverilog or vvp stopped with an error.', h('br'), h('br'), h('button.btn', { onclick: () => this.ctx.openLog('sim') }, 'Open the log')) })
    } else {
      node = emptyState({
        icon: ART.waves, title: 'No waveforms yet',
        body: `Waves appear here after the agent runs the flow. The testbench <code>tb/&lt;top&gt;_tb.v</code> dumps them with <code>$dumpfile("out/sim.vcd")</code> and <code>$dumpvars</code>.`,
      })
    }
    this.overlay.append(node)
  }

  async loadMeta(stamp) {
    if (this.metaLoading === stamp) return
    this.metaLoading = stamp
    let meta
    try { meta = await this.ctx.api('vcd/meta') } catch (e) {
      this.metaLoading = null
      return
    }
    this.metaLoading = null
    hideTip()
    const hadMeta = Boolean(this.meta)
    const wasFit = hadMeta && this.span.t0 <= 0 && this.span.t1 >= this.meta.end
    this.meta = meta
    this.metaStamp = stamp
    this.vars.clear()
    const walk = (s) => {
      for (const v of s.vars) this.vars.set(`${s.path}.${v.name}`, { ...v, path: `${s.path}.${v.name}`, scope: s.path })
      s.children.forEach(walk)
    }
    meta.scopes.forEach(walk)
    this.data.clear()
    this.uartCache = new Map()
    this.overlay.hidden = true

    if (!this.restored) {
      this.restore()
      this.restored = true
    } else {
      // Same rows, new ids: a new run may number its signals differently.
      this.rows = this.rows.map((r) => { const v = this.vars.get(r.path); return v ? { ...r, id: v.id, width: v.width } : null }).filter(Boolean)
      if (wasFit) this.span = { t0: 0, t1: Math.max(1, meta.end) }
      else this.clampSpan()
    }
    if (!this.rows.length) this.defaultRows()
    if (this.pendingAdd) { const [n, ip] = this.pendingAdd; this.pendingAdd = null; this.addByName(n, ip) }
    this.renderTree()
    this.renderRows()
    this.layoutBrowser()
    await this.ensure(this.rows.map((r) => r.id))
    this.draw()
  }

  // ------------------------------------------------------------------------ persistence

  restore() {
    const saved = this.ctx.store.get('waves', null)
    this.rows = []
    if (saved?.rows?.length) {
      for (const r of saved.rows) {
        const v = this.vars.get(r.path)
        if (v && v.type !== 'parameter') this.rows.push({ path: r.path, id: v.id, width: v.width, radix: r.radix ?? 'hex', mode: r.mode ?? 'digital', decode: r.decode ?? null })
      }
    }
    const end = Math.max(1, this.meta.end)
    if (saved?.span && saved.span.t1 > saved.span.t0 && saved.span.t0 < end) this.span = { ...saved.span }
    else this.span = { t0: 0, t1: end }
    this.clampSpan()
    this.cursor = saved?.cursor ?? null
    this.marker = saved?.marker ?? null
    this.sel = Math.min(saved?.sel ?? -1, this.rows.length - 1)
    if (saved?.namesW) this.setNamesW(saved.namesW)
    if (typeof saved?.browserOpen === 'boolean') this.browserOpen = saved.browserOpen
    this.expanded = new Set(saved?.expanded ?? [])
  }

  persist() {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      if (!this.meta) return
      this.ctx.store.set('waves', {
        rows: this.rows.map(({ path, radix, mode, decode }) => ({ path, radix, mode, decode })),
        span: this.span, cursor: this.cursor, marker: this.marker, sel: this.sel, namesW: this.namesW,
        browserOpen: this.browserOpen, expanded: [...this.expanded],
      })
    }, 250)
  }

  /** The DUT's ports first (the nets the testbench shares with it), then its state. */
  defaultRows() {
    const roots = this.meta.scopes
    if (!roots.length) return
    const tb = roots[0]
    const tbIds = new Set(tb.vars.map((v) => v.id))
    const mods = tb.children.filter((c) => c.kind === 'module')
    const dut = mods.map((m) => ({ m, shared: m.vars.filter((v) => tbIds.has(v.id)).length }))
      .sort((a, b) => b.shared - a.shared || b.m.vars.length - a.m.vars.length)[0]?.m
    const pick = []
    const add = (scope, v) => {
      if (v.type === 'parameter' || v.width > 64) return
      const path = `${scope.path}.${v.name}`
      if (pick.some((p) => p.id === v.id)) return
      pick.push({ path, id: v.id, width: v.width, name: v.name, type: v.type })
    }
    if (dut) {
      for (const v of dut.vars) if (tbIds.has(v.id)) add(dut, v)
      for (const v of dut.vars) if (!tbIds.has(v.id) && v.type !== 'integer') add(dut, v)
    } else {
      for (const v of tb.vars) if (v.type !== 'integer') add(tb, v)
    }
    const clockFirst = (p) => (/^(clk|clock|i_clk|clk_i)$/i.test(p.name) ? 0 : 1)
    pick.sort((a, b) => clockFirst(a) - clockFirst(b))
    const ports = dut ? pick.filter((p) => tbIds.has(p.id)) : pick
    const rest = dut ? pick.filter((p) => !tbIds.has(p.id)) : []
    const chosen = [...ports, ...rest.slice(0, Math.max(0, 14 - ports.length))]
    this.rows = chosen.map((p) => ({
      path: p.path, id: p.id, width: p.width,
      radix: p.width === 8 && /(byte|char|data|msg|ascii|letter)/i.test(p.name) ? 'ascii' : 'hex',
      mode: 'digital',
      decode: p.width === 1 && /^(u?art_?)?(tx|rx|txd|rxd|serial_?(out|in))$|_(tx|rx)$/i.test(p.name) ? 'uart?' : null,
    }))
    this.expanded = new Set([tb.path, ...(dut ? [dut.path] : [])])
  }

  // -------------------------------------------------------------------------- data

  async ensure(ids) {
    const need = [...new Set(ids)].filter((id) => id && !this.data.has(id) && !this.loading.has(id))
    if (!need.length) return
    need.forEach((id) => this.loading.add(id))
    const stamp = this.metaStamp
    try {
      for (let k = 0; k < need.length; k += 24) {
        const chunk = need.slice(k, k + 24)
        const res = await this.ctx.api('vcd/data', { ids: chunk.join(' ') })
        if (stamp !== this.metaStamp) return
        for (const s of res.signals) {
          const t = new Float64Array(s.t.length)
          let acc = 0
          for (let j = 0; j < s.t.length; j++) { acc += s.t[j]; t[j] = acc }
          this.data.set(s.id, { t, v: s.v, scalar: s.width === 1 && !s.real, width: s.width, real: s.real })
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      need.forEach((id) => this.loading.delete(id))
    }
    // Rows marked "uart?" become decoded lines only if the line really looks like one.
    for (const r of this.rows) {
      if (r.decode === 'uart?' && this.data.has(r.id)) r.decode = this.uart(r) ? 'uart' : null
    }
    this.renderRows()
    this.draw()
  }

  uart(row) {
    const d = this.data.get(row.id)
    if (!d || !d.scalar) return null
    const key = `${row.id}:${row.baud ?? 'auto'}`
    if (this.uartCache.has(key)) return this.uartCache.get(key)
    let result = null
    const timing = uartTiming(d, this.meta.tickFs)
    if (timing && d.v[0] !== '0') {
      const frames = uartDecode(d, timing.bit)
      const bad = frames.filter((f) => f.err).length
      if (frames.length && bad <= frames.length / 2) result = { ...timing, frames, bad }
    }
    this.uartCache.set(key, result)
    return result
  }

  // ---------------------------------------------------------------------- geometry

  rowHeight(r) { return r.decode === 'uart' ? ROW_UART : r.mode === 'analog' && r.width > 1 ? ROW_ANALOG : ROW }
  rowTops() {
    const tops = []
    let y = 0
    for (const r of this.rows) { tops.push(y); y += this.rowHeight(r) }
    return { tops, total: y }
  }
  X(t, W) { return ((t - this.span.t0) / (this.span.t1 - this.span.t0)) * W }
  T(x, W) { return this.span.t0 + (x / W) * (this.span.t1 - this.span.t0) }
  get end() { return Math.max(1, this.meta?.end ?? 1) }

  clampSpan() {
    const end = this.end
    let { t0, t1 } = this.span
    let d = Math.max(2, Math.min(t1 - t0, end * 1.2))
    if (!Number.isFinite(d)) d = end
    const pad = d * 0.1
    if (t0 < -pad) t0 = -pad
    if (t0 + d > end + pad) t0 = end + pad - d
    if (t0 < -pad) t0 = -pad
    this.span = { t0, t1: t0 + d }
  }

  unitFor(fs) {
    for (const u of UNITS) if (Math.abs(fs) >= u[1]) return u
    return UNITS[UNITS.length - 1]
  }

  fmtTime(ticks, resTicks) {
    const tf = this.meta?.tickFs ?? 1000
    const fs = ticks * tf
    const [u, f] = this.unitFor(Math.abs(fs) || resTicks * tf)
    const res = Math.max(resTicks * tf, 1e-3)
    const dec = Math.max(0, Math.min(6, Math.ceil(Math.log10(f / res))))
    return `${(fs / f).toFixed(dec)} ${u}`
  }

  fmtFreq(ticks) {
    const tf = this.meta?.tickFs ?? 1000
    const hz = 1e15 / (Math.abs(ticks) * tf)
    if (!Number.isFinite(hz)) return ''
    if (hz >= 1e6) return `${(hz / 1e6).toPrecision(4)} MHz`
    if (hz >= 1e3) return `${(hz / 1e3).toPrecision(4)} kHz`
    return `${hz.toPrecision(4)} Hz`
  }

  // ---------------------------------------------------------------------- view ops

  zoom(factor, at) {
    if (!this.meta) return
    const { t0, t1 } = this.span
    const c = at ?? (this.cursor != null && this.cursor >= t0 && this.cursor <= t1 ? this.cursor : (t0 + t1) / 2)
    const nt0 = c - (c - t0) * factor
    const nt1 = c + (t1 - c) * factor
    if (nt1 - nt0 < 2) return
    this.span = { t0: nt0, t1: nt1 }
    this.clampSpan()
    this.draw()
    this.persist()
  }
  pan(fraction) {
    const d = this.span.t1 - this.span.t0
    this.span = { t0: this.span.t0 + d * fraction, t1: this.span.t1 + d * fraction }
    this.clampSpan()
    this.draw()
    this.persist()
  }
  fit() {
    if (!this.meta) return
    this.span = { t0: 0, t1: this.end }
    this.draw()
    this.persist()
  }
  reveal(t) {
    const { t0, t1 } = this.span
    const d = t1 - t0
    if (t >= t0 + d * 0.04 && t <= t1 - d * 0.04) return
    this.span = { t0: t - d / 2, t1: t + d / 2 }
    this.clampSpan()
  }

  // ------------------------------------------------------------------ signal browser

  layoutBrowser() {
    const wide = this.root.clientWidth >= 980
    if (this.browserOpen == null) this.browserEffective = wide && this.rows.length > 0 ? true : !this.rows.length
    else this.browserEffective = this.browserOpen
    this.browser.hidden = !this.browserEffective || !this.meta
    this.browser.classList.toggle('overlay', !wide)
    this.btnBrowser.setAttribute('aria-pressed', String(Boolean(this.browserEffective && this.meta)))
  }

  toggleBrowser(force) {
    const now = !this.browser.hidden
    this.browserOpen = force ?? !now
    this.layoutBrowser()
    if (this.browserOpen) setTimeout(() => this.filterInput.focus(), 0)
    this.persist()
    this.draw()
  }

  renderTree() {
    const t = this.tree
    t.innerHTML = ''
    if (!this.meta) return
    const onRows = new Set(this.rows.map((r) => r.path))
    const q = this.filter.trim().toLowerCase()
    if (q) {
      const hits = [...this.vars.values()].filter((v) => v.path.toLowerCase().includes(q))
        .sort((a, b) => (a.name.toLowerCase() === q ? -1 : 0) - (b.name.toLowerCase() === q ? -1 : 0) || a.path.length - b.path.length)
        .slice(0, 300)
      if (!hits.length) t.append(h('div', { style: { padding: '12px', color: 'var(--faint)', fontSize: '12px' } }, 'No signal matches.'))
      for (const v of hits) t.append(this.varRow(v, 8, onRows, true))
      return
    }
    const scope = (s, depth) => {
      const open = this.expanded.has(s.path)
      const n = s.vars.filter((v) => v.type !== 'parameter').length
      const row = h(`div.tr${open ? '.open' : ''}`, {
        style: { paddingLeft: `${4 + depth * 14}px` },
        title: s.path,
        onclick: () => { if (open) this.expanded.delete(s.path); else this.expanded.add(s.path); this.renderTree(); this.persist() },
      },
      h('span.chev', { html: ICONS.chev }),
      h('span.scope-ic', { html: s.kind === 'module' ? ICONS.module : ICONS.fn }),
      h('span.nm', s.name),
      n ? h('span.all', { onclick: (e) => { e.stopPropagation(); this.addScope(s) } }, 'add all') : null,
      h('span.cnt', String(n)))
      t.append(row)
      if (!open) return
      for (const c of s.children) scope(c, depth + 1)
      const vars = [...s.vars].sort((a, b) => (a.type === 'parameter') - (b.type === 'parameter'))
      for (const v of vars) t.append(this.varRow({ ...v, path: `${s.path}.${v.name}`, scope: s.path }, 22 + depth * 14, onRows, false))
    }
    for (const s of this.meta.scopes) scope(s, 0)
  }

  varRow(v, indent, onRows, showPath) {
    const range = v.width > 1 ? `[${v.msb}:${v.lsb}]` : ''
    if (v.type === 'parameter') {
      const val = v.value != null ? formatValue(v.value, 'dec', v.width) : ''
      return h('div.tr.param', { style: { paddingLeft: `${indent}px` }, title: `${v.path} = ${val} (parameter)` },
        h('span.nm', v.name), h('span.tag', `= ${val}`))
    }
    const on = onRows.has(v.path)
    return h(`div.tr.var${on ? '.on' : ''}`, {
      style: { paddingLeft: `${indent}px` },
      title: `${v.path} ${range} · ${v.type}${this.meta.changes?.[v.id] != null ? ` · ${this.meta.changes[v.id]} changes` : ''}`,
      onclick: () => (on ? this.removePath(v.path) : this.addVar(v)),
    },
    h('span.add', on ? '✓' : '+'),
    h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.15 } },
      h('span.nm', v.name, range ? h('span', { style: { color: 'var(--faint)' } }, range) : null),
      showPath ? h('span.path', v.scope) : null),
    h('span.tag', v.type === 'integer' ? 'int' : v.type))
  }

  addVar(v, silent) {
    if (this.rows.some((r) => r.path === v.path)) return
    const row = { path: v.path, id: v.id, width: v.width, radix: 'hex', mode: 'digital', decode: v.width === 1 && /(^|_)(tx|rx|txd|rxd)$/i.test(v.name) ? 'uart?' : null }
    const at = this.sel >= 0 ? this.sel + 1 : this.rows.length
    this.rows.splice(at, 0, row)
    this.sel = at
    if (!silent) this.afterRowsChange()
  }
  /** From the schematic: the net `name` inside instance `instPath` of the design, whichever
   * testbench scope the design sits under. Returns whether it was found. */
  addByName(name, instPath) {
    if (!this.meta) { this.pendingAdd = [name, instPath]; return false }
    const suffix = `.${instPath ? `${instPath}.` : ''}${name}`
    const hits = [...this.vars.values()].filter((v) => v.type !== 'parameter' && v.path.endsWith(suffix)).sort((a, b) => a.path.length - b.path.length)
    const v = hits[0]
    if (!v) return false
    const i = this.rows.findIndex((r) => r.path === v.path)
    if (i >= 0) this.select(i)
    else this.addVar(v)
    return true
  }

  addScope(s) {
    for (const v of s.vars) if (v.type !== 'parameter') this.addVar({ ...v, path: `${s.path}.${v.name}` }, true)
    this.afterRowsChange()
  }
  removePath(path) {
    const i = this.rows.findIndex((r) => r.path === path)
    if (i < 0) return
    this.rows.splice(i, 1)
    if (this.sel >= this.rows.length) this.sel = this.rows.length - 1
    this.afterRowsChange()
  }
  afterRowsChange() {
    this.renderTree()
    this.renderRows()
    this.ensure(this.rows.map((r) => r.id))
    this.draw()
    this.persist()
  }

  // ----------------------------------------------------------------------- names column

  /** The scope every row shares — shown once in the header rather than on every row. */
  commonScope() {
    if (!this.rows.length) return this.meta?.scopes?.[0]?.path ?? ''
    const parts = this.rows.map((r) => r.path.split('.').slice(0, -1))
    const first = parts[0]
    let k = 0
    while (k < first.length && parts.every((p) => p[k] === first[k])) k++
    return first.slice(0, k).join('.')
  }

  displayName(path) {
    const root = this.common ?? ''
    let p = path
    if (root && p.startsWith(`${root}.`)) p = p.slice(root.length + 1)
    const k = p.lastIndexOf('.')
    return k < 0 ? { scope: '', leaf: p } : { scope: p.slice(0, k + 1), leaf: p.slice(k + 1) }
  }

  renderRows() {
    const box = this.namesInner
    box.innerHTML = ''
    this.common = this.commonScope()
    const { tops, total } = this.rowTops()
    box.style.height = `${total + 40}px`
    this.rowEls = this.rows.map((r, i) => {
      const { scope, leaf } = this.displayName(r.path)
      const u = r.decode === 'uart' ? this.uart(r) : null
      const el = h(`div.row${i === this.sel ? '.sel' : ''}`, {
        style: { top: `${tops[i]}px`, height: `${this.rowHeight(r)}px` },
        title: r.path + (r.width > 1 ? ` [${r.width - 1}:0]` : ''),
        onpointerdown: (e) => this.rowPointerDown(e, i),
        oncontextmenu: (e) => { e.preventDefault(); this.rowMenu(i, e.clientX, e.clientY) },
      },
      h('span.grip', '⋮⋮'),
      h('span.label', scope ? h('span.sc', scope) : null, leaf, r.width > 1 ? h('span.w', `[${r.width - 1}:0]`) : null),
      u ? h('span.badge.uart', { title: `UART 8N1 at ${u.baud} baud (measured ${Math.round(u.measured)}) · ${u.frames.length} bytes${u.bad ? ` · ${u.bad} framing errors` : ''}` }, 'UART') : null,
      r.width > 1 && r.radix !== 'hex' && r.mode !== 'analog' ? h('span.badge', RADIX_SHORT[r.radix]) : null,
      r.mode === 'analog' && r.width > 1 ? h('span.badge', 'analog') : null,
      h('span.val'),
      h('button.icon-btn.more', { title: 'Radix, display, remove', onclick: (e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); this.rowMenu(i, b.left, b.bottom + 2) } }, '⋯'))
      box.append(el)
      return el
    })
    if (!this.rows.length && this.meta) {
      box.append(h('div', { style: { padding: '14px 12px', color: 'var(--faint)', fontSize: '12px', lineHeight: 1.5 } },
        'No signals. Open ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.toggleBrowser(true) } }, 'Signals'), ' and click one to add it.'))
    }
    this.namesHead.firstChild.textContent = `${this.rows.length} signal${this.rows.length === 1 ? '' : 's'}${this.common ? ` · ${this.common}` : ''}`
    this.namesHead.firstChild.title = this.common ? `every signal below is inside ${this.common}` : ''
    this.updateValues()
  }

  updateValues() {
    if (!this.rowEls) return
    const t = this.cursor ?? this.hoverT
    this.rows.forEach((r, i) => {
      const el = this.rowEls[i]?.querySelector('.val')
      if (!el) return
      const d = this.data.get(r.id)
      let text = '', cls = ''
      if (t != null && d) {
        const v = valueAt(d, t)
        if (v != null) {
          if (r.decode === 'uart') {
            const u = this.uart(r)
            const f = u && frameAt(u.frames, t)
            text = f ? `'${charOf(f.byte)}' ${f.byte.toString(16).padStart(2, '0')}` : v
          } else text = formatValue(v, r.radix, r.width)
          if (/^x+$/.test(v) || v === 'x') cls = 'x'
          else if (v === 'z' || /^z+$/.test(v)) cls = 'z'
        }
      }
      el.textContent = text
      el.className = `val${cls ? ` ${cls}` : ''}`
      el.style.opacity = this.cursor == null ? '0.6' : '1'
    })
  }

  rowPointerDown(e, i) {
    if (e.button !== 0) return
    if (e.target.closest('.more')) return
    this.select(i)
    const startY = e.clientY
    const grip = e.target.closest('.grip')
    let dragging = false
    let line = null, dropAt = i
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientY - startY) > 4 && (grip || Math.abs(ev.clientY - startY) > 8)) {
        dragging = true
        line = h('div.drop-line')
        this.namesInner.append(line)
      }
      if (!dragging) return
      const box = this.namesInner.getBoundingClientRect()
      const y = ev.clientY - box.top
      const { tops, total } = this.rowTops()
      dropAt = this.rows.length
      for (let k = 0; k < tops.length; k++) {
        if (y < tops[k] + this.rowHeight(this.rows[k]) / 2) { dropAt = k; break }
      }
      line.style.top = `${(dropAt < tops.length ? tops[dropAt] : total) - 1}px`
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) return
      line?.remove()
      const [row] = this.rows.splice(i, 1)
      const to = dropAt > i ? dropAt - 1 : dropAt
      this.rows.splice(to, 0, row)
      this.sel = to
      this.renderRows()
      this.draw()
      this.persist()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  select(i) {
    this.sel = i
    this.rowEls?.forEach((el, k) => el.classList.toggle('sel', k === i))
    this.draw()
    this.persist()
    // keep it in view
    const { tops } = this.rowTops()
    if (i >= 0 && i < this.rows.length) {
      const top = tops[i], bottom = top + this.rowHeight(this.rows[i])
      const view = this.names.clientHeight
      if (top < this.names.scrollTop) this.names.scrollTop = top
      else if (bottom > this.names.scrollTop + view) this.names.scrollTop = bottom - view
    }
  }

  rowMenu(i, x, y) {
    const r = this.rows[i]
    if (!r) return
    this.select(i)
    const items = []
    if (r.width > 1) {
      items.push({ header: 'Radix' })
      for (const rx of RADIXES) items.push({ label: RADIX_LABEL[rx], on: r.radix === rx && r.mode !== 'analog', action: () => { r.radix = rx; r.mode = 'digital'; this.afterRowEdit() } })
      items.push('sep', { header: 'Display' })
      items.push({ label: 'Digital bus', on: r.mode !== 'analog', action: () => { r.mode = 'digital'; this.afterRowEdit() } })
      items.push({ label: 'Analog (step plot)', on: r.mode === 'analog', action: () => { r.mode = 'analog'; this.afterRowEdit() } })
    } else {
      items.push({ header: 'Decode' })
      items.push({ label: 'None', on: r.decode !== 'uart', action: () => { r.decode = null; this.afterRowEdit() } })
      items.push({
        label: 'UART 8N1 (auto baud)', on: r.decode === 'uart',
        action: () => {
          const ok = this.uart(r)
          r.decode = ok ? 'uart' : null
          if (!ok) showTip(x, y, 'This line does not look like an idle-high UART.')
          setTimeout(hideTip, 1800)
          this.afterRowEdit()
        },
      })
    }
    items.push('sep', { label: 'Remove', shortcut: '⌫', danger: true, action: () => this.removePath(r.path) })
    openMenu(x, y, items)
  }

  afterRowEdit() { this.renderRows(); this.draw(); this.persist() }

  // ---------------------------------------------------------------------------- events

  wire() {
    const c = this.canvas
    this.names.addEventListener('scroll', () => { this.scrollY = this.names.scrollTop; this.draw() })

    c.addEventListener('wheel', (e) => {
      if (!this.meta) return
      e.preventDefault()
      const W = c.clientWidth
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / W
        this.pan(d)
        return
      }
      if (e.altKey) { this.names.scrollTop += e.deltaY; return }
      const at = this.T(e.offsetX, W)
      const k = e.ctrlKey ? 0.012 : 0.0022
      this.zoom(Math.exp(e.deltaY * k), at)
      this.hoverT = at
    }, { passive: false })

    let press = null
    c.addEventListener('pointerdown', (e) => {
      if (!this.meta || e.button !== 0) return
      c.setPointerCapture(e.pointerId)
      press = { x: e.offsetX, y: e.offsetY, span: { ...this.span }, moved: false }
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.meta) return
      const W = c.clientWidth
      if (press) {
        const dx = e.offsetX - press.x
        if (!press.moved && Math.abs(dx) > 3) { press.moved = true; c.classList.add('grab') }
        if (press.moved) {
          const d = (dx / W) * (press.span.t1 - press.span.t0)
          this.span = { t0: press.span.t0 - d, t1: press.span.t1 - d }
          this.clampSpan()
        }
      }
      this.hoverT = this.T(e.offsetX, W)
      this.hoverTip(e)
      this.draw()
    })
    c.addEventListener('pointerup', (e) => {
      if (!press) return
      c.classList.remove('grab')
      const W = c.clientWidth
      if (!press.moved) {
        const row = this.rowAtY(e.offsetY)
        const t = this.snap(this.T(e.offsetX, W), row, W)
        if (e.shiftKey) this.marker = t
        else this.cursor = t
        if (row >= 0) this.select(row)
      }
      press = null
      this.persist()
      this.draw()
    })
    c.addEventListener('pointerleave', () => { this.hoverT = null; hideTip(); this.draw() })
    c.addEventListener('dblclick', (e) => {
      const row = this.rowAtY(e.offsetY)
      if (row < 0) this.fit()
    })
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const row = this.rowAtY(e.offsetY)
      if (row >= 0) this.rowMenu(row, e.clientX, e.clientY)
    })

    // ruler: click puts the cursor, drag selects a range to zoom to
    const ru = this.ruler
    let rsel = null
    ru.addEventListener('pointerdown', (e) => {
      if (!this.meta || e.button !== 0) return
      ru.setPointerCapture(e.pointerId)
      rsel = { x0: e.offsetX, x1: e.offsetX }
    })
    ru.addEventListener('pointermove', (e) => {
      if (!this.meta) return
      this.hoverT = this.T(e.offsetX, ru.clientWidth)
      if (rsel) rsel.x1 = e.offsetX
      this.rangeSel = rsel
      this.draw()
    })
    ru.addEventListener('pointerup', (e) => {
      if (!rsel) return
      const W = ru.clientWidth
      if (Math.abs(rsel.x1 - rsel.x0) > 4) {
        const a = this.T(Math.min(rsel.x0, rsel.x1), W), b = this.T(Math.max(rsel.x0, rsel.x1), W)
        if (b - a >= 2) { this.span = { t0: a, t1: b }; this.clampSpan() }
      } else {
        const t = this.snap(this.T(e.offsetX, W), this.sel, W)
        if (e.shiftKey) this.marker = t; else this.cursor = t
      }
      rsel = null
      this.rangeSel = null
      this.persist()
      this.draw()
    })
    ru.addEventListener('pointerleave', () => { if (!rsel) { this.hoverT = null; this.draw() } })
    ru.addEventListener('dblclick', () => this.fit())
    ru.addEventListener('wheel', (e) => { e.preventDefault(); c.dispatchEvent(new WheelEvent('wheel', e)) }, { passive: false })

    // horizontal scrollbar
    const hb = this.hbar
    let hdrag = null
    hb.addEventListener('pointerdown', (e) => {
      if (!this.meta) return
      hb.setPointerCapture(e.pointerId)
      const W = hb.clientWidth
      const { lo, hi } = this.hbarRange()
      const tAt = lo + (e.offsetX / W) * (hi - lo)
      const d = this.span.t1 - this.span.t0
      if (tAt < this.span.t0 || tAt > this.span.t1) { this.span = { t0: tAt - d / 2, t1: tAt + d / 2 }; this.clampSpan() }
      hdrag = { x: e.clientX, span: { ...this.span } }
      hb.classList.add('on')
      this.draw()
    })
    hb.addEventListener('pointermove', (e) => {
      if (!hdrag) return
      const { lo, hi } = this.hbarRange()
      const d = ((e.clientX - hdrag.x) / hb.clientWidth) * (hi - lo)
      this.span = { t0: hdrag.span.t0 + d, t1: hdrag.span.t1 + d }
      this.clampSpan()
      this.draw()
    })
    hb.addEventListener('pointerup', () => { hdrag = null; hb.classList.remove('on'); this.persist() })

    // names column width
    let rz = null
    this.resizer.addEventListener('pointerdown', (e) => {
      this.resizer.setPointerCapture(e.pointerId)
      rz = { x: e.clientX, w: this.namesW }
      this.resizer.classList.add('on')
    })
    this.resizer.addEventListener('pointermove', (e) => { if (rz) { this.setNamesW(rz.w + e.clientX - rz.x); this.draw() } })
    this.resizer.addEventListener('pointerup', () => { rz = null; this.resizer.classList.remove('on'); this.persist() })

    new ResizeObserver(() => { if (this.visible) { this.layoutBrowser(); this.draw() } }).observe(this.root)
    // an overlaid browser closes when the lanes are touched, like a popover
    this.main.addEventListener('pointerdown', () => {
      if (!this.browser.hidden && this.browser.classList.contains('overlay')) this.toggleBrowser(false)
    }, true)
  }

  hbarRange() {
    const end = this.end
    return { lo: Math.min(0, this.span.t0), hi: Math.max(end, this.span.t1) }
  }

  rowAtY(y) {
    const yy = y + this.scrollY
    const { tops } = this.rowTops()
    for (let k = 0; k < this.rows.length; k++) if (yy >= tops[k] && yy < tops[k] + this.rowHeight(this.rows[k])) return k
    return -1
  }

  /** Land on a transition of the row under the pointer when one is within a few pixels. */
  snap(t, row, W) {
    const r = this.rows[row]
    const d = r && this.data.get(r.id)
    const px = (this.span.t1 - this.span.t0) / W
    if (d && d.t.length) {
      const i = upperBound(d.t, t)
      let best = null
      for (const k of [i - 1, i]) {
        if (k >= 0 && k < d.t.length && Math.abs(d.t[k] - t) <= 6 * px && (best == null || Math.abs(d.t[k] - t) < Math.abs(best - t))) best = d.t[k]
      }
      if (best != null) return best
    }
    return Math.max(0, Math.round(t))
  }

  hoverTip(e) {
    const row = this.rowAtY(e.offsetY)
    const r = this.rows[row]
    const d = r && this.data.get(r.id)
    if (!d || this.hoverT == null) { hideTip(); return }
    const W = this.canvas.clientWidth
    const res = (this.span.t1 - this.span.t0) / W
    const i = valueIndex(d, this.hoverT)
    if (i < 0) { hideTip(); return }
    const v = d.v[i]
    const t0 = d.t[i], t1 = i + 1 < d.t.length ? d.t[i + 1] : null
    let valueText = r.width > 1 ? formatValue(v, r.radix, r.width) : v
    if (r.width > 1 && r.radix !== 'dec' && !/[xz]/.test(v)) valueText += ` <span class="dim">= ${formatValue(v, 'dec', r.width)}</span>`
    let extra = ''
    if (r.decode === 'uart') {
      const u = this.uart(r)
      const f = u && frameAt(u.frames, this.hoverT)
      if (f) valueText = `'${esc(charOf(f.byte))}' 0x${f.byte.toString(16).padStart(2, '0')} <span class="dim">${f.err ? 'framing error' : `${u.baud} baud`}</span>`
    }
    // (px spacing) interval width as a period/frequency hint for a toggling line
    if (t1 != null) extra = `<br><span class="dim">held ${this.fmtTime(t1 - t0, res)}</span>`
    const { leaf } = this.displayName(r.path)
    showTip(e.clientX, e.clientY, `<span class="mono">${esc(leaf)}</span> = <span class="mono">${valueText}</span><br><span class="dim">from ${this.fmtTime(t0, res)}</span>${extra}`)
  }

  key(e) {
    if (!this.meta) return
    const k = e.key
    const W = this.canvas.clientWidth || 1
    if (k === '+' || k === '=') { this.zoom(0.5); e.preventDefault() }
    else if (k === '-' || k === '_') { this.zoom(2); e.preventDefault() }
    else if (k === 'f' || k === 'F') { this.fit(); e.preventDefault() }
    else if (k === 's' || k === 'S') { this.toggleBrowser(); e.preventDefault() }
    else if (k === '/') { this.toggleBrowser(true); e.preventDefault() }
    else if (k === 'm' || k === 'M') { if (this.cursor != null) { this.marker = this.cursor; this.draw(); this.persist() } }
    else if (k === 'z' || k === 'Z') {
      if (this.cursor != null && this.marker != null && this.cursor !== this.marker) {
        const a = Math.min(this.cursor, this.marker), b = Math.max(this.cursor, this.marker)
        const pad = (b - a) * 0.08
        this.span = { t0: a - pad, t1: b + pad }
        this.clampSpan(); this.draw(); this.persist()
      }
    } else if (k === 'r' || k === 'R') {
      const r = this.rows[this.sel]
      if (r && r.width > 1) { r.radix = RADIXES[(RADIXES.indexOf(r.radix) + (e.shiftKey ? RADIXES.length - 1 : 1)) % RADIXES.length]; r.mode = 'digital'; this.afterRowEdit() }
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (!this.rows.length) return
      const n = this.sel < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, this.sel + (k === 'ArrowUp' ? -1 : 1)))
      this.select(n)
      e.preventDefault()
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1
      const r = this.rows[this.sel]
      const d = r && this.data.get(r.id)
      if (e.shiftKey || !d) { this.pan(dir * 0.2); e.preventDefault(); return }
      const from = this.cursor ?? (dir > 0 ? this.span.t0 : this.span.t1)
      let t = null
      if (r.decode === 'uart') {
        const f = this.uart(r)?.frames ?? []
        const j = f.findIndex((x) => x.t0 > from)
        t = dir > 0 ? (j >= 0 ? f[j].t0 : null) : ([...f].reverse().find((x) => x.t0 < from)?.t0 ?? null)
      } else if (dir > 0) {
        const i = upperBound(d.t, from)
        t = i < d.t.length ? d.t[i] : null
      } else {
        const i = upperBound(d.t, from - 1) - 1
        t = i >= 0 ? d.t[i] : null
        if (t != null && t >= from) t = i > 0 ? d.t[i - 1] : null
      }
      if (t != null) { this.cursor = t; this.reveal(t); this.draw(); this.persist() }
      e.preventDefault()
    } else if (k === 'Delete' || k === 'Backspace') {
      const r = this.rows[this.sel]
      if (r) { this.removePath(r.path); e.preventDefault() }
    } else if (k === 'Home') { const d = this.span.t1 - this.span.t0; this.span = { t0: 0, t1: d }; this.clampSpan(); this.draw() }
    else if (k === 'End') { const d = this.span.t1 - this.span.t0; this.span = { t0: this.end - d, t1: this.end }; this.clampSpan(); this.draw() }
    else if (k === 'Escape') {
      if (!this.browser.hidden && this.browser.classList.contains('overlay')) this.toggleBrowser(false)
      else if (this.marker != null) { this.marker = null; this.draw(); this.persist() }
    }
    void W
  }

  // ------------------------------------------------------------------------------ drawing

  draw() {
    if (!this.visible || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint() })
  }

  paint() {
    if (!this.meta) return
    const col = colors()
    const W = this.lanes.clientWidth, H = this.lanes.clientHeight
    if (W < 2 || H < 2) return
    const { tops, total } = this.rowTops()
    // keep scroll within range
    const maxScroll = Math.max(0, total + 40 - H)
    if (this.scrollY > maxScroll) this.scrollY = maxScroll
    const ctx = fitCanvas(this.canvas, W, H)
    ctx.fillStyle = col['w-bg']
    ctx.fillRect(0, 0, W, H)
    ctx.font = `11px ${col.mono || 'ui-monospace, monospace'}`
    ctx.textBaseline = 'middle'

    const { t0, t1 } = this.span
    const dt = t1 - t0
    const res = dt / W
    const X = (t) => ((t - t0) / dt) * W

    // grid
    const step = niceStep(dt / Math.max(2, Math.floor(W / 96)))
    ctx.fillStyle = col['w-grid']
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ctx.fillRect(Math.round(X(t)), 0, 1, H)
    // past the end of the dump
    if (this.end < t1) {
      ctx.fillStyle = col['w-row']
      ctx.fillRect(Math.max(0, X(this.end)), 0, W, H)
    }

    // rows
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]
      const rh = this.rowHeight(r)
      const y = tops[i] - this.scrollY
      if (y > H || y + rh < 0) continue
      if (i === this.sel) { ctx.fillStyle = col['w-sel']; ctx.fillRect(0, y, W, rh) }
      ctx.fillStyle = col['w-row']
      ctx.fillRect(0, y + rh - 1, W, 1)
      const d = this.data.get(r.id)
      if (!d) {
        ctx.fillStyle = col.faint
        ctx.textAlign = 'left'
        ctx.fillText(this.loading.has(r.id) ? 'loading…' : '', 8, y + rh / 2)
        continue
      }
      if (r.decode === 'uart') {
        this.paintBit(ctx, d, y + 3, y + 21, W, X, res, col, true)
        this.paintUart(ctx, r, y + 24, y + rh - 4, W, X, res, col)
      } else if (d.scalar) this.paintBit(ctx, d, y + 6, y + rh - 6, W, X, res, col)
      else if (r.mode === 'analog') this.paintAnalog(ctx, r, d, y + 5, y + rh - 5, W, X, res, col)
      else this.paintBus(ctx, r, d, y + 5, y + rh - 5, W, X, res, col)
    }

    // hover, marker, cursor
    if (this.hoverT != null) {
      ctx.fillStyle = col['w-hover']
      ctx.fillRect(Math.round(X(this.hoverT)), 0, 1, H)
    }
    if (this.marker != null) {
      const x = Math.round(X(this.marker)) + 0.5
      ctx.strokeStyle = col['w-marker']
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      ctx.setLineDash([])
    }
    if (this.cursor != null) {
      const x = Math.round(X(this.cursor)) + 0.5
      ctx.strokeStyle = col['w-cursor']
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    }

    if (this.meta.truncated) {
      ctx.textAlign = 'right'; ctx.fillStyle = col.faint
      ctx.fillText('dump truncated — too many changes to hold', W - 14, H - 10)
    }

    this.paintRuler(col, step)
    // scrollbars
    const { lo, hi } = this.hbarRange()
    const thumb = this.hbar.firstChild
    const HW = this.hbar.clientWidth
    thumb.style.left = `${((t0 - lo) / (hi - lo)) * HW}px`
    thumb.style.width = `${Math.max(8, (dt / (hi - lo)) * HW)}px`
    const overflow = total + 40 > H
    this.vbar.hidden = !overflow
    if (overflow) {
      const vt = this.vbar.firstChild
      vt.style.top = `${(this.scrollY / (total + 40)) * H}px`
      vt.style.height = `${Math.max(16, (H / (total + 40)) * H)}px`
    }
    if (this.names.scrollTop !== this.scrollY) this.names.scrollTop = this.scrollY

    this.updateReadouts(res)
    this.updateValues()
  }

  paintBit(ctx, d, top, bot, W, X, res, col, thin) {
    const n = d.t.length
    const { t0, t1 } = this.span
    let i = Math.max(0, valueIndex(d, t0))
    const mid = (top + bot) / 2
    ctx.lineWidth = thin ? 1 : 1.25
    const line = new Path2D()
    const fill = new Path2D()
    const xfill = new Path2D()
    const xline = new Path2D()
    const zline = new Path2D()
    const dense = new Path2D()
    let prevY = null
    const endT = this.end
    while (i < n && d.t[i] <= t1) {
      const ts = d.t[i]
      const te = i + 1 < n ? d.t[i + 1] : endT
      if (te < t0) { i++; continue }
      const xa = Math.max(-2, X(ts)), xb = Math.min(W + 2, X(te))
      if (xb - xa < 1.6 && i + 1 < n) {
        // Several changes inside a pixel or two: one busy block, then resume at the last of them.
        const tLimit = ts + 2 * res
        let j = upperBound(d.t, tLimit)
        if (j <= i + 1) j = i + 2
        if (j > n) j = n
        const xe = Math.min(W + 2, X(d.t[j - 1]))
        dense.rect(xa, top, Math.max(1, xe - xa), bot - top)
        prevY = null
        i = j - 1 // the last change of the run is drawn normally on the next pass
        continue
      }
      const v = d.v[i]
      if (v === '1' || v === '0') {
        const y = v === '1' ? top : bot
        if (prevY != null && prevY !== y) { line.moveTo(xa, top); line.lineTo(xa, bot) }
        line.moveTo(xa, y); line.lineTo(xb, y)
        if (v === '1') fill.rect(xa, top, xb - xa, bot - top)
        prevY = y
      } else if (v === 'z') {
        zline.moveTo(xa, mid); zline.lineTo(xb, mid)
        prevY = null
      } else {
        xfill.rect(xa, top, xb - xa, bot - top)
        xline.moveTo(xa, top); xline.lineTo(xb, top); xline.moveTo(xa, bot); xline.lineTo(xb, bot)
        prevY = null
      }
      i++
    }
    ctx.fillStyle = col['w-bit-fill']; ctx.fill(fill)
    ctx.fillStyle = col['w-x-fill']; ctx.fill(xfill)
    ctx.strokeStyle = col['w-bit']; ctx.stroke(line)
    ctx.globalAlpha = 0.45; ctx.fillStyle = col['w-bit']; ctx.fill(dense); ctx.globalAlpha = 1
    ctx.strokeStyle = col['w-x']; ctx.stroke(xline)
    ctx.strokeStyle = col['w-z']; ctx.stroke(zline)
  }

  paintBus(ctx, r, d, top, bot, W, X, res, col) {
    const n = d.t.length
    const { t0, t1 } = this.span
    let i = Math.max(0, valueIndex(d, t0))
    const mid = (top + bot) / 2
    const shape = new Path2D()
    const xshape = new Path2D()
    const dense = new Path2D()
    const labels = []
    const endT = this.end
    while (i < n && d.t[i] <= t1) {
      const ts = d.t[i]
      const te = i + 1 < n ? d.t[i + 1] : endT
      if (te < t0) { i++; continue }
      const xa = X(ts), xb = X(te)
      if (xb - xa < 3 && i + 1 < n) {
        const tLimit = ts + 3 * res
        let j = upperBound(d.t, tLimit)
        if (j <= i + 1) j = i + 2
        if (j > n) j = n
        const xe = X(d.t[j - 1])
        dense.rect(Math.max(-2, xa), top, Math.max(1, Math.min(W + 2, xe) - Math.max(-2, xa)), bot - top)
        i = j - 1
        continue
      }
      const v = d.v[i]
      const bad = /[xz]/.test(v)
      const s = Math.min(3.5, (xb - xa) / 2)
      const ca = Math.max(-10, xa), cb = Math.min(W + 10, xb)
      const p = bad ? xshape : shape
      p.moveTo(ca, mid); p.lineTo(ca + (ca === xa ? s : 0), top); p.lineTo(cb - (cb === xb ? s : 0), top)
      p.lineTo(cb, mid); p.lineTo(cb - (cb === xb ? s : 0), bot); p.lineTo(ca + (ca === xa ? s : 0), bot); p.closePath()
      const va = Math.max(xa, 0), vb = Math.min(xb, W)
      if (vb - va > 14) labels.push([va, vb, v, bad])
      i++
    }
    ctx.lineWidth = 1
    ctx.fillStyle = col['w-bus-fill']; ctx.fill(shape)
    ctx.strokeStyle = col['w-bus']; ctx.stroke(shape)
    ctx.fillStyle = col['w-x-fill']; ctx.fill(xshape)
    ctx.strokeStyle = col['w-x']; ctx.stroke(xshape)
    ctx.globalAlpha = 0.35; ctx.fillStyle = col['w-bus']; ctx.fill(dense); ctx.globalAlpha = 1
    ctx.textAlign = 'center'
    for (const [va, vb, v, bad] of labels) {
      let text = formatValue(v, r.radix, r.width)
      const room = vb - va - 10
      let w = ctx.measureText(text).width
      if (w > room) {
        // shorter forms before an ellipsis: a char without its quotes, hex without leading zeros
        const short = text.replace(/^'(.+)'$/, '$1').replace(/^0+(?=[0-9a-fxz])/, '')
        if (ctx.measureText(short).width <= room) { text = short; w = room }
      }
      if (w > room) {
        while (text.length > 1 && ctx.measureText(`${text}…`).width > room) text = text.slice(0, -1)
        text = `${text}…`
        w = ctx.measureText(text).width
        if (w > room + 2) continue
      }
      ctx.fillStyle = bad ? col['w-x'] : col['w-text']
      ctx.fillText(text, (va + vb) / 2, mid + 0.5)
    }
  }

  paintAnalog(ctx, r, d, top, bot, W, X, res, col) {
    const signed = r.radix === 'sdec'
    if (!d.range || d.range.signed !== signed) {
      let lo = Infinity, hi = -Infinity
      for (let k = 0; k < d.v.length; k++) {
        const v = numeric(d.v[k], signed)
        if (v == null) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      d.range = { lo, hi, signed }
    }
    const { lo, hi } = d.range
    if (!Number.isFinite(lo)) return
    const span = hi - lo || 1
    const Y = (v) => bot - ((v - lo) / span) * (bot - top)
    const n = d.t.length
    const { t0, t1 } = this.span
    let i = Math.max(0, valueIndex(d, t0))
    const path = new Path2D()
    const area = new Path2D()
    let started = false, lastY = null, lastX = null
    while (i < n && d.t[i] <= t1) {
      const ts = d.t[i]
      const te = i + 1 < n ? d.t[i + 1] : this.end
      const xa = Math.max(-2, X(ts)), xb = Math.min(W + 2, X(te))
      if (xb - xa < 1 && i + 1 < n) {
        // min/max over the pixel column
        const j0 = i
        const tLimit = ts + res
        let j = upperBound(d.t, tLimit)
        if (j <= i + 1) j = i + 2
        if (j > n) j = n
        let mn = Infinity, mx = -Infinity
        const stride = Math.max(1, Math.floor((j - j0) / 64))
        for (let k = j0; k < j; k += stride) { const v = numeric(d.v[k], signed); if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v } }
        if (Number.isFinite(mn)) {
          if (!started) { path.moveTo(xa, Y(mn)); started = true }
          path.lineTo(xa, Y(mx)); path.lineTo(xa, Y(mn))
          lastY = Y(numeric(d.v[j - 1], signed) ?? mn); path.lineTo(xa, lastY); lastX = xa
        }
        i = j - 1
        continue
      }
      const v = numeric(d.v[i], signed)
      if (v == null) { started = false; i++; continue }
      const y = Y(v)
      if (!started) { path.moveTo(xa, y); started = true } else path.lineTo(xa, y)
      path.lineTo(xb, y)
      area.rect(xa, y, xb - xa, bot - y)
      lastY = y; lastX = xb
      i++
    }
    void lastX; void lastY
    ctx.fillStyle = col['w-bus-fill']; ctx.fill(area)
    ctx.strokeStyle = col['w-analog']; ctx.lineWidth = 1.25; ctx.stroke(path)
    ctx.fillStyle = col.faint; ctx.textAlign = 'right'; ctx.font = `9.5px ${col.mono || 'monospace'}`
    ctx.fillText(String(hi), W - 14, top + 5)
    ctx.fillText(String(lo), W - 14, bot - 4)
    ctx.font = `11px ${col.mono || 'monospace'}`
  }

  paintUart(ctx, r, top, bot, W, X, res, col) {
    const u = this.uart(r)
    if (!u) return
    const { t0, t1 } = this.span
    const f = u.frames
    let lo = 0, hi = f.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (f[m].t1 < t0) lo = m + 1; else hi = m }
    const mid = (top + bot) / 2
    const bitPx = (u.bit / (t1 - t0)) * W
    ctx.textAlign = 'center'
    for (let k = lo; k < f.length && f[k].t0 <= t1; k++) {
      const fr = f[k]
      const xa = X(fr.t0), xb = X(fr.t1)
      const w = xb - xa
      ctx.fillStyle = fr.err ? col['w-x-fill'] : col['w-uart-fill']
      ctx.strokeStyle = fr.err ? col['w-x'] : col['w-uart']
      ctx.lineWidth = 1
      const rad = Math.min(4, w / 2)
      ctx.beginPath()
      ctx.roundRect ? ctx.roundRect(xa + 0.5, top + 0.5, Math.max(1, w - 1), bot - top - 1, rad) : ctx.rect(xa + 0.5, top + 0.5, Math.max(1, w - 1), bot - top - 1)
      ctx.fill()
      if (w > 3) ctx.stroke()
      if (bitPx > 7) {
        // the ten bit cells: start, eight data bits LSB first, stop
        ctx.globalAlpha = 0.35
        for (let b = 1; b < 10; b++) {
          const x = Math.round(xa + b * bitPx) + 0.5
          ctx.beginPath(); ctx.moveTo(x, top + 3); ctx.lineTo(x, bot - 3); ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
      const ch = charOf(fr.byte)
      const hex = fr.byte.toString(16).padStart(2, '0')
      const full = bitPx > 7 ? `${ch}  0x${hex}` : `${ch} ${hex}`
      const va = Math.max(xa, 0), vb = Math.min(xb, W)
      ctx.fillStyle = fr.err ? col['w-x'] : col['w-text']
      if (ctx.measureText(full).width < vb - va - 6) ctx.fillText(full, (va + vb) / 2, mid + 0.5)
      else if (ctx.measureText(ch).width < vb - va - 2) ctx.fillText(ch, (va + vb) / 2, mid + 0.5)
    }
  }

  paintRuler(col, step) {
    const ru = this.ruler
    const W = ru.clientWidth, H = ru.clientHeight
    if (W < 2) return
    const ctx = fitCanvas(ru, W, H)
    const { t0, t1 } = this.span
    const dt = t1 - t0
    const X = (t) => ((t - t0) / dt) * W
    ctx.fillStyle = col.panel
    ctx.fillRect(0, 0, W, H)
    ctx.font = `10.5px ${col.mono || 'monospace'}`
    ctx.textBaseline = 'middle'
    const tf = this.meta.tickFs
    // One unit across the ruler, picked by how far along the run the view is (so 1.5 ms, not
    // 1500 µs); decimals by the step between ticks.
    const [u, f] = this.unitFor(Math.max(Math.abs(t0), Math.abs(t1), step) * tf)
    const dec = Math.max(0, Math.min(6, Math.ceil(Math.log10(f / (step * tf)) - 1e-9)))
    ctx.fillStyle = col.faint
    ctx.textAlign = 'left'
    const minor = step / 5
    for (let t = Math.ceil(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(X(t))
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
      ctx.fillStyle = major ? col.guide : col.line
      ctx.fillRect(x, major ? H - 9 : H - 5, 1, major ? 9 : 5)
      if (major) {
        ctx.fillStyle = col.ink2
        ctx.fillText(`${((t * tf) / f).toFixed(dec)} ${u}`, x + 4, 10)
      }
    }
    // range selection
    if (this.rangeSel && Math.abs(this.rangeSel.x1 - this.rangeSel.x0) > 2) {
      const a = Math.min(this.rangeSel.x0, this.rangeSel.x1), b = Math.max(this.rangeSel.x0, this.rangeSel.x1)
      ctx.fillStyle = col['accent-soft']
      ctx.fillRect(a, 0, b - a, H)
      this.canvasOverlayRange(a, b)
    }
    const res = dt / W
    const placed = []
    const flag = (t, color, label) => {
      const x = Math.round(X(t)) + 0.5
      if (x < -40 || x > W + 40) return
      ctx.font = `600 10.5px ${col.mono || 'monospace'}`
      const w = ctx.measureText(label).width + 10
      let bx = Math.max(0, Math.min(W - w, x - w / 2))
      // two flags close together: this one moves to whichever side of its line is clear
      for (const [a, b] of placed) {
        if (bx < b + 2 && bx + w > a - 2) bx = x >= (a + b) / 2 ? Math.min(W - w, Math.max(b + 2, x - 2)) : Math.max(0, Math.min(a - w - 2, x - w + 2))
      }
      placed.push([bx, bx + w])
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect ? ctx.roundRect(bx, 3, w, 15, 4) : ctx.rect(bx, 3, w, 15)
      ctx.fill()
      ctx.fillRect(x - 0.75, 18, 1.5, H - 18)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText(label, bx + w / 2, 11)
      ctx.textAlign = 'left'
    }
    if (this.marker != null) flag(this.marker, col['w-marker'], this.fmtTime(this.marker, res))
    if (this.cursor != null) flag(this.cursor, col['w-cursor'], this.fmtTime(this.cursor, res))
    if (this.cursor == null && this.hoverT != null) {
      ctx.fillStyle = col.faint
      ctx.fillRect(Math.round(X(this.hoverT)), H - 12, 1, 12)
    }
  }

  canvasOverlayRange() { /* the lanes show the hover line; the ruler band is enough */ }

  updateReadouts(res) {
    const c = this.cursor, m = this.marker
    this.readCursor.innerHTML = c == null
      ? '<span class="hint">click to place the cursor</span>'
      : `<i class="sw" style="background:var(--w-cursor)"></i><b>${esc(this.fmtTime(c, res))}</b>`
    if (m == null) { this.readDelta.innerHTML = c == null ? '' : '<span class="hint">shift-click for a marker</span>'; return }
    if (c == null) { this.readDelta.innerHTML = `<i class="sw" style="background:var(--w-marker)"></i>${esc(this.fmtTime(m, res))}`; return }
    const d = c - m
    this.readDelta.innerHTML = `<i class="sw" style="background:var(--w-marker)"></i>Δ <b>${esc(this.fmtTime(Math.abs(d), res))}</b>${d ? ` <span style="color:var(--faint)">${esc(this.fmtFreq(d))}</span>` : ''}`
  }
}
