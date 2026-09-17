// The chip: nextpnr's view of the design on the iCE40 die. The floorplan draws every tile of the
// device (logic, I/O, block RAM, DSP), every placed logic cell in its slot, the routes at tile
// resolution and the critical path hop by hop; beside it, utilisation per resource and timing.
import { h, ICONS, colors, fitCanvas, emptyState, ART, showTip, hideTip, esc, palette, bytes } from './util.js'

const RESOURCES = {
  ICESTORM_LC: 'Logic cells', SB_IO: 'I/O pins', ICESTORM_RAM: 'Block RAM (4K)', ICESTORM_SPRAM: 'SPRAM (256K)',
  SB_GB: 'Global buffers', ICESTORM_PLL: 'PLL', ICESTORM_DSP: 'DSP (MAC16)', ICESTORM_HFOSC: 'HF oscillator',
  ICESTORM_LFOSC: 'LF oscillator', SB_RGBA_DRV: 'RGB LED driver', SB_LEDDA_IP: 'LED PWM IP', SB_SPI: 'SPI hard IP',
  SB_I2C: 'I²C hard IP', SB_WARMBOOT: 'Warm boot', IO_I3C: 'I3C pins',
}
const TILE_NAMES = { L: 'logic', I: 'I/O', B: 'block RAM (bottom)', T: 'block RAM (top)', D: 'DSP', P: 'IP connect' }
const KIND_COLORS = () => {
  const c = colors()
  return { lut: c.accent, ff: c.teal, both: c.violet, carry: c.gold }
}

export function shortCell(name) {
  if (!name) return ''
  if (/^\$nextpnr_ICESTORM_LC_\d+$/.test(name)) return 'carry feed-in'
  if (name.endsWith('$sb_io')) return `${name.slice(0, -6)} (I/O buffer)`
  if (name.startsWith('$gbuf_')) return `global buffer`
  const m = /^(.+?)_SB_[A-Z0-9_]+(\$CARRY)?$/.exec(name)
  if (m) return m[2] ? `${m[1]} (carry)` : m[1]
  return name
}
function shortNet(name) {
  if (!name) return ''
  const m = /^(.+?)(?:_SB_[A-Z0-9_]+)+(\[\d+\])?$/.exec(name)
  return m ? `${m[1]}…${m[2] ?? ''}` : name.replace(/\$SB_IO_(IN|OUT)(_\$glb_clk)?$/, (_, d, g) => ` (${d === 'IN' ? 'pad in' : 'pad out'}${g ? ', global' : ''})`)
}
function srcOf(sources) {
  const s = (sources ?? []).find((x) => !x.includes('cells_map') && !x.startsWith('/'))
  const m = s && /^([^:]+):(\d+)/.exec(s)
  return m ? { path: m[1], line: Number(m[2]), text: `${m[1]}:${m[2]}` } : null
}
const clockName = (n) => String(n ?? '').replace(/^(posedge|negedge)\s+/, '').split('$')[0]

export class ChipTab {
  constructor(root, ctx) {
    this.root = root
    this.ctx = ctx
    this.data = null
    this.stamp = null
    this.visible = false
    this.colorBy = 'module'
    this.showRoutes = true
    this.showPath = true
    this.pathIndex = 0
    this.hop = null
    this.pickTile = null
    this.hiddenModules = new Set()
    this.view = { k: 1, x: 0, y: 0 }
    this.showAllUtil = false
    this.build()
  }

  build() {
    this.root.innerHTML = ''
    this.body = h('div.chip-body')
    this.overlay = h('div', { style: { position: 'absolute', inset: 0, background: 'var(--bg)' }, hidden: true })
    this.root.append(this.body, this.overlay)
    new ResizeObserver(() => {
      if (!this.visible) return
      this.layout()
      if (this.data && this.renderedWide !== this.root.clientWidth >= 1080) this.render()
      else this.draw()
    }).observe(this.root)
  }

  show() {
    this.visible = true
    this.layout()
    // rendered while hidden, the cards were laid out for a narrow pane; lay them out again
    if (this.data && this.renderedWide !== this.root.clientWidth >= 1080) this.render()
    else this.draw()
  }
  hide() { this.visible = false; hideTip() }
  resize() { this.layout(); this.draw() }
  theme() { this.draw() }
  reset() { this.stamp = null; this.data = null }

  layout() { this.root.classList.toggle('chip-wide', this.root.clientWidth >= 1080) }

  update(state) {
    const f = state.files ?? {}
    const pnrRunning = this.ctx.stepRunning('pnr')
    if (this.busy) this.busy.hidden = !pnrRunning
    if (!f.routed && !f.pnr) {
      this.overlay.hidden = false
      this.overlay.innerHTML = ''
      const failed = this.ctx.step('pnr')
      if (pnrRunning) this.overlay.append(emptyState({ spinner: true, title: 'Placing and routing…', body: esc(failed?.last ?? 'nextpnr-ice40 is fitting the design onto the chip.') }))
      else if (failed?.state === 'failed') {
        this.overlay.append(emptyState({ icon: ART.chip, title: 'Place and route failed', body: h('p', h('code', failed.error ?? ''), h('br'), h('br'), h('button.btn', { onclick: () => this.ctx.openLog('pnr') }, 'Open the log')) }))
      } else this.overlay.append(emptyState({ icon: ART.chip, title: 'Not on the chip yet', body: 'After synthesis, <code>nextpnr-ice40</code> places the design on the iCE40 and this tab shows where every cell went, how full the chip is and how fast it runs.' }))
      return
    }
    const stamp = [f.routed, f.pnr, f.asc].map((x) => (x ? `${x.mtime}:${x.size}` : '-')).join('|')
    if (stamp === this.stamp) return
    if (pnrRunning && this.data) return // keep the last placement until the new one is written
    this.stamp = stamp
    this.load(state)
  }

  async load(state) {
    let data
    try { data = await this.ctx.api('chip') } catch (e) {
      this.overlay.hidden = false
      this.overlay.innerHTML = ''
      this.overlay.append(emptyState({ icon: ART.chip, title: 'Could not read the placement', body: esc(e.message) }))
      return
    }
    this.data = data
    this.report = state.report
    this.index()
    this.overlay.hidden = true
    if (this.pathIndex >= (data.criticalPaths?.length ?? 0)) this.pathIndex = 0
    this.render()
  }

  index() {
    const d = this.data
    this.tiles = new Map() // "x,y" -> { cells: [idx] }
    d.cells.forEach((c, i) => {
      if (c.x < 0) return
      const k = `${c.x},${c.y}`
      if (!this.tiles.has(k)) this.tiles.set(k, [])
      this.tiles.get(k).push(i)
    })
    this.moduleCounts = d.modules.map(() => 0)
    for (const c of d.cells) if (c.t === 'ICESTORM_LC') this.moduleCounts[c.m]++
    this.netsByCell = new Map()
    d.nets.forEach((n, i) => {
      for (const c of [n.d, ...n.k]) {
        if (c < 0) continue
        if (!this.netsByCell.has(c)) this.netsByCell.set(c, [])
        this.netsByCell.get(c).push(i)
      }
    })
  }

  moduleLabel(i) {
    const m = this.data.modules[i]
    return m || `${this.ctx.top ?? 'top'} (top)`
  }

  // --------------------------------------------------------------------------------- render

  render() {
    const d = this.data
    const b = this.body
    this.renderedWide = this.root.clientWidth >= 1080
    b.innerHTML = ''
    const grid = h('div.chip-grid')
    b.append(grid)

    // floorplan card
    this.canvas = h('canvas.fp-canvas')
    this.legend = h('div.fp-legend')
    this.tileInfo = h('div.inner.tile-info', { hidden: true })
    this.busy = h('span.pill.busy', { hidden: !this.ctx.stepRunning('pnr') }, 'routing')
    const seg = (name, opts) => h('div.seg', opts.map(([v, label]) => h('button', {
      'aria-pressed': String(this[name] === v),
      onclick: () => { this[name] = v; this.render() },
    }, label)))
    const toggle = (prop, label, title) => h('button.btn', {
      'aria-pressed': String(this[prop]), title,
      onclick: (e) => { this[prop] = !this[prop]; e.currentTarget.setAttribute('aria-pressed', String(this[prop])); this.draw() },
    }, label)
    const devName = `iCE40 ${String(d.arch ?? '').toUpperCase()} · ${String(d.package ?? '').toUpperCase()}`
    const fp = h('div.card2.fp-card',
      h('h4', 'Floorplan', h('span.sub', devName), h('span.grow'), this.busy),
      h('div.toolbar', { style: { borderBottom: '1px solid var(--line)' } },
        seg('colorBy', [['module', 'Module'], ['kind', 'Cell kind']]),
        h('span.grow'),
        toggle('showRoutes', 'Routes', 'Draw every routed net (R)'),
        d.criticalPaths?.length ? toggle('showPath', 'Critical path', 'Draw the critical path (P)') : null,
        h('button.icon-btn', { title: 'Reset zoom', html: ICONS.fit, onclick: () => { this.view = { k: 1, x: 0, y: 0 }; this.draw() } })),
      h('div.fp-wrap', this.canvas),
      this.legend,
      this.tileInfo)
    this.fpCard = fp

    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } })
    side.append(this.renderKpis(), this.renderTiming(), this.renderUtil())
    grid.append(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } }, this.root.clientWidth >= 1080 ? null : this.renderKpis(true), fp), side)
    if (this.root.clientWidth < 1080) side.firstChild.remove()
    this.renderLegend()
    this.wireCanvas()
    this.layout()
    this.draw()
  }

  renderKpis() {
    const d = this.data
    const util = d.utilization ?? {}
    const lc = util.ICESTORM_LC, io = util.SB_IO
    const clocks = Object.entries(d.fmax ?? {})
    const [cname, c] = clocks[0] ?? []
    const r = this.ctx.state?.report
    const k = (cls, key, value, unit, sub) => h(`div.kpi${cls ? `.${cls}` : ''}`, h('div.k', key), h('div.v', value, unit ? h('small', unit) : null), sub ? h('div.s', sub) : null)
    return h('div.kpis',
      lc ? k('', 'Logic cells', String(lc.used), `/ ${lc.available}`, `${((lc.used / lc.available) * 100).toFixed(1)}% of the chip`) : null,
      c ? k(c.achieved >= c.constraint ? 'good' : 'bad', `Fmax · ${clockName(cname)}`, c.achieved.toFixed(1), 'MHz',
        c.constraint ? (c.achieved >= c.constraint ? `${(c.achieved / c.constraint).toFixed(1)}× the ${+c.constraint.toFixed(2)} MHz target` : `misses ${+c.constraint.toFixed(2)} MHz`) : 'no target set') : null,
      io ? k('', 'I/O pins', String(io.used), `/ ${io.available}`, `${util.SB_GB?.used ?? 0} global buffer${util.SB_GB?.used === 1 ? '' : 's'}`) : null,
      r?.bitstream ? k('', 'Bitstream', bytes(r.bitstream.bytes), '', r.bitstream.path) : null)
  }

  renderTiming() {
    const d = this.data
    const card = h('div.card2', h('h4', 'Timing', h('span.sub', 'from nextpnr’s static timing analysis')))
    const inner = h('div.inner')
    card.append(inner)
    const clocks = Object.entries(d.fmax ?? {})
    if (!clocks.length) inner.append(h('div.note', 'No clocked paths — the design has no flip-flops on a clock nextpnr knows.'))
    for (const [name, c] of clocks) {
      const pass = !c.constraint || c.achieved >= c.constraint
      const max = Math.max(c.achieved, c.constraint || 0) * 1.18
      const period = 1000 / c.achieved, target = c.constraint ? 1000 / c.constraint : null
      inner.append(h('div', { style: { marginBottom: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '22px', fontWeight: 650, letterSpacing: '-0.02em', color: pass ? 'var(--ok)' : 'var(--bad)' } }, `${c.achieved.toFixed(2)} MHz`),
          h('span.clock-name', clockName(name)),
          h('span.grow', { style: { flex: '1 1 auto' } }),
          h('span.note', target ? `slack ${(target - period).toFixed(2)} ns · period ${period.toFixed(2)} ns` : `period ${period.toFixed(2)} ns`)),
        h('div.gauge',
          h('div.track'),
          h(`div.fill${pass ? '' : '.bad'}`, { style: { width: `${(c.achieved / max) * 100}%` } }),
          c.constraint ? h('div.mark', { style: { left: `${(c.constraint / max) * 100}%` } }, h('span', `target ${+c.constraint.toFixed(2)} MHz`)) : null)))
    }
    const paths = d.criticalPaths ?? []
    if (paths.length) {
      const tabs = h('div.path-tabs')
      paths.forEach((p, i) => {
        const total = p.path.reduce((a, x) => a + x.delay, 0)
        tabs.append(h('button.btn', {
          'aria-pressed': String(i === this.pathIndex),
          title: `${p.from} → ${p.to}`,
          onclick: () => { this.pathIndex = i; this.hop = null; this.render() },
        }, `${clockName(p.from) || p.from} → ${clockName(p.to) || p.to}`, h('span', { style: { color: 'var(--faint)' } }, ` ${total.toFixed(2)} ns`)))
      })
      inner.append(h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '4px 0 6px' } }, 'Critical paths'), tabs)
      inner.append(this.renderHops(paths[this.pathIndex]))
    }
    return card
  }

  renderHops(p) {
    const total = p.path.reduce((a, x) => a + x.delay, 0)
    const logic = p.path.filter((x) => x.type !== 'routing').reduce((a, x) => a + x.delay, 0)
    const wrap = h('div')
    wrap.append(h('div.lc-split',
      h('span', h('b', `${total.toFixed(2)} ns`), ' end to end'),
      h('span', h('b', `${logic.toFixed(2)} ns`), ' in cells'),
      h('span', h('b', `${(total - logic).toFixed(2)} ns`), ' in routing'),
      h('span', h('b', String(p.path.filter((x) => x.type === 'logic').length)), ' LUT levels')))
    const table = h('table.hops')
    let acc = 0
    const maxDelay = Math.max(...p.path.map((x) => x.delay), 0.001)
    p.path.forEach((hop, i) => {
      acc += hop.delay
      const src = srcOf(hop.sources)
      const what = hop.type === 'routing'
        ? h('div.what', h('span.ty.routing', 'net'), h('span', { title: hop.net ?? '' }, shortNet(hop.net)),
          h('div', { style: { color: 'var(--faint)', fontSize: '10.5px' } }, `(${hop.from?.loc?.join(',')}) → (${hop.to?.loc?.join(',')})`))
        : h('div.what', h(`span.ty.${hop.type}`, hop.type), h('span', { title: hop.to?.cell ?? '' }, shortCell(hop.to?.cell)),
          h('span', { style: { color: 'var(--faint)' } }, hop.from?.port && hop.to?.port && hop.from.port !== hop.to.port ? ` ${hop.from.port}→${hop.to.port}` : hop.to?.port ? ` .${hop.to.port}` : ''))
      const row = h(`tr${this.hop === i ? '.hl' : ''}`, {
        onclick: () => { this.hop = this.hop === i ? null : i; table.querySelectorAll('tr').forEach((r, k) => r.classList.toggle('hl', k === this.hop)); this.draw() },
      },
      h('td.n', String(i + 1)),
      h('td', what,
        src ? h('div.src', h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); this.ctx.openSource(src.path, src.line) } }, src.text)) : null,
        h(`div.dbar${hop.type === 'routing' ? '.routing' : ''}`, { style: { width: `${Math.max(3, (hop.delay / maxDelay) * 100)}%` } })),
      h('td.d', `${hop.delay.toFixed(2)}`, h('small', `${acc.toFixed(2)} ns`)))
      table.append(row)
    })
    wrap.append(table)
    return wrap
  }

  renderUtil() {
    const d = this.data
    const util = Object.entries(d.utilization ?? {}).map(([id, u]) => ({ id, ...u, pct: u.available ? (100 * u.used) / u.available : 0 }))
    const rank = { ICESTORM_LC: 0, SB_IO: 1, ICESTORM_RAM: 2, ICESTORM_SPRAM: 3, ICESTORM_DSP: 4, ICESTORM_PLL: 5, SB_GB: 6 }
    util.sort((a, b) => (b.used > 0) - (a.used > 0) || (rank[a.id] ?? 9) - (rank[b.id] ?? 9) || a.id.localeCompare(b.id))
    const card = h('div.card2', h('h4', 'Utilization', h('span.sub', 'used / available on this device')))
    const inner = h('div.inner')
    card.append(inner)
    const lcs = d.cells.filter((c) => c.t === 'ICESTORM_LC')
    if (lcs.length) {
      const both = lcs.filter((c) => c.lut && c.ff).length
      const ffOnly = lcs.filter((c) => !c.lut && c.ff).length
      const lutOnly = lcs.filter((c) => c.lut && !c.ff).length
      const carry = lcs.filter((c) => c.carry).length
      inner.append(h('div.lc-split',
        h('span', h('b', String(lutOnly)), ' LUT only'), h('span', h('b', String(ffOnly)), ' flip-flop only'),
        h('span', h('b', String(both)), ' LUT + FF'), h('span', h('b', String(carry)), ' on a carry chain')))
    }
    const shown = this.showAllUtil ? util : util.filter((u) => u.used > 0 || u.id === 'ICESTORM_LC' || u.id === 'SB_IO' || u.id === 'ICESTORM_RAM' || u.id === 'ICESTORM_DSP')
    for (const u of shown) {
      const cls = u.pct >= 90 ? '.full' : u.pct >= 70 ? '.hot' : ''
      inner.append(h(`div.util-row${u.used ? '' : '.zero'}`,
        h('span.nm', { title: u.id }, RESOURCES[u.id] ?? u.id),
        h(`div.bar${cls}`, h('i', { style: { width: `${u.used ? Math.max(1.5, u.pct) : 0}%` } })),
        h('span.num', `${u.used} / ${u.available}`, h('span', { style: { color: 'var(--faint)', marginLeft: '6px', display: 'inline-block', minWidth: '34px' } }, `${u.pct < 1 && u.pct > 0 ? '<1' : Math.round(u.pct)}%`))))
    }
    const hiddenCount = util.length - shown.length
    if (hiddenCount > 0 || this.showAllUtil) {
      inner.append(h('span.util-more', { onclick: () => { this.showAllUtil = !this.showAllUtil; this.render() } },
        this.showAllUtil ? 'Show only what is used' : `Show ${hiddenCount} more hard blocks`))
    }
    return card
  }

  renderLegend() {
    const L = this.legend
    L.innerHTML = ''
    const d = this.data
    if (this.colorBy === 'module') {
      const pal = palette()
      d.modules.forEach((m, i) => {
        if (!this.moduleCounts[i]) return
        const off = this.hiddenModules.has(i)
        L.append(h(`span${off ? '.off' : ''}`, {
          title: off ? 'Show' : 'Click to fade the others',
          onclick: () => {
            const only = !this.hiddenModules.size || !off
            if (only && !(this.hiddenModules.size === d.modules.length - 1 && !off)) {
              this.hiddenModules = new Set(d.modules.map((_, k) => k).filter((k) => k !== i))
            } else this.hiddenModules.clear()
            this.renderLegend(); this.draw()
          },
        }, h('i', { style: { background: pal[i % pal.length] } }), `${this.moduleLabel(i)} · ${this.moduleCounts[i]}`))
      })
    } else {
      const kc = KIND_COLORS()
      L.append(h('span', h('i', { style: { background: kc.lut } }), 'LUT'), h('span', h('i', { style: { background: kc.ff } }), 'flip-flop'),
        h('span', h('i', { style: { background: kc.both } }), 'LUT + flip-flop'), h('span', h('i', { style: { background: kc.carry } }), 'carry'))
    }
    const c = colors()
    L.append(h('span', { style: { marginLeft: 'auto', cursor: 'default' } }, h('i', { style: { background: c['f-ram'] } }), 'BRAM'),
      h('span', { style: { cursor: 'default' } }, h('i', { style: { background: c['f-dsp'] } }), 'DSP'),
      h('span', { style: { cursor: 'default' } }, h('i', { style: { background: c['f-io'] } }), 'I/O'))
  }

  // ------------------------------------------------------------------------------ floorplan

  geom() {
    const d = this.data
    const gw = d.grid?.width ?? 26, gh = d.grid?.height ?? 32
    const W = this.canvas.parentElement.clientWidth
    // Tall enough to read a logic cell, short enough that the whole die fits the pane at once.
    const maxH = Math.max(380, this.root.clientHeight - (this.root.clientWidth >= 1080 ? 150 : 220))
    const s = Math.max(6, Math.min((W - 16) / gw, (maxH - 16) / gh))
    const H = Math.round(gh * s + 16)
    const ox = (W - gw * s) / 2, oy = 8
    const { k, x, y } = this.view
    // zoom k about the canvas centre, then pan by (x, y); y = 0 is the bottom row, as on the die
    return {
      W, H, s: s * k, gw, gh,
      tx: (tx) => W / 2 + (ox + tx * s - W / 2) * k + x,
      ty: (ty) => H / 2 + (oy + (gh - 1 - ty) * s - H / 2) * k + y,
    }
  }

  draw() {
    if (!this.visible || !this.data || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint() })
  }

  paint() {
    const d = this.data
    if (!this.canvas?.isConnected) return
    const g = this.geom()
    this.canvas.style.height = `${g.H}px`
    const ctx = fitCanvas(this.canvas, g.W, g.H)
    const c = colors()
    const pal = palette()
    const kc = KIND_COLORS()
    ctx.clearRect(0, 0, g.W, g.H)
    ctx.fillStyle = c['f-die']
    ctx.fillRect(0, 0, g.W, g.H)
    const s = g.s
    const gap = s > 10 ? 1 : 0.5
    const rows = d.grid?.rows ?? []

    // tiles
    for (let ty = 0; ty < rows.length; ty++) {
      for (let tx = 0; tx < rows[ty].length; tx++) {
        const t = rows[ty][tx]
        if (t === '.') continue
        const px = g.tx(tx), py = g.ty(ty)
        if (px > g.W || py > g.H || px + s < 0 || py + s < 0) continue
        ctx.fillStyle = t === 'L' ? c['f-tile'] : t === 'I' ? c['f-io'] : t === 'B' || t === 'T' ? c['f-ram'] : t === 'D' ? c['f-dsp'] : c['f-ipcon']
        // a block RAM spans its bottom and top tile; draw the pair as one block
        if (t === 'B') ctx.fillRect(px + gap, py - s + gap, s - 2 * gap, 2 * s - 2 * gap)
        else if (t !== 'T') ctx.fillRect(px + gap, py + gap, s - 2 * gap, s - 2 * gap)
      }
    }

    // cells
    const faded = (cell) => this.colorBy === 'module' && this.hiddenModules.size && this.hiddenModules.has(cell.m)
    for (const [key, idxs] of this.tiles) {
      const [tx, ty] = key.split(',').map(Number)
      const px = g.tx(tx), py = g.ty(ty)
      if (px > g.W || py > g.H || px + s < 0 || py + s < 0) continue
      for (const i of idxs) {
        const cell = d.cells[i]
        let color
        if (this.colorBy === 'module') color = pal[cell.m % pal.length]
        else color = cell.carry && !cell.ff && !cell.lut ? kc.carry : cell.lut && cell.ff ? kc.both : cell.ff ? kc.ff : cell.carry ? kc.carry : kc.lut
        ctx.globalAlpha = faded(cell) ? 0.15 : 1
        ctx.fillStyle = color
        if (cell.t === 'ICESTORM_LC') {
          const z = Number(String(cell.b).replace(/\D/g, '')) || 0
          const pad = Math.max(1, s * 0.1)
          const cw = (s - pad * 2 - 1) / 2, ch = (s - pad * 2 - 3) / 4
          const col = z % 2, row = 3 - Math.floor(z / 2)
          ctx.fillRect(px + pad + col * (cw + 1), py + pad + row * (ch + 1), cw, ch)
        } else if (cell.t === 'SB_IO') {
          const z = Number(String(cell.b).replace(/\D/g, '')) || 0
          const r = Math.max(2, s * 0.2)
          ctx.beginPath()
          ctx.arc(px + s * (z ? 0.7 : 0.3), py + s / 2, r, 0, Math.PI * 2)
          ctx.fillStyle = c.accent
          ctx.fill()
        } else if (cell.t === 'SB_GB') {
          ctx.strokeStyle = c.teal
          ctx.lineWidth = 1.5
          ctx.strokeRect(px + 2, py + 2, s - 4, s - 4)
        } else {
          ctx.fillStyle = c.violet
          ctx.fillRect(px + s * 0.2, py + s * 0.2, s * 0.6, s * 0.6)
        }
        ctx.globalAlpha = 1
      }
    }

    const center = (tx, ty) => [g.tx(tx) + s / 2, g.ty(ty) + s / 2]

    // routes
    if (this.showRoutes) {
      ctx.strokeStyle = c['f-route']
      ctx.lineWidth = Math.max(0.6, Math.min(1.2, s / 18))
      ctx.beginPath()
      for (const n of d.nets) {
        if (n.g) continue
        const seg = n.s
        for (let k = 0; k < seg.length; k += 4) {
          const [x1, y1] = center(seg[k], seg[k + 1])
          const [x2, y2] = center(seg[k + 2], seg[k + 3])
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y2)
        }
      }
      ctx.stroke()
    }

    // the selected tile's nets
    if (this.pickTile) {
      const idxs = this.tiles.get(this.pickTile) ?? []
      const nets = new Set(idxs.flatMap((i) => this.netsByCell.get(i) ?? []))
      ctx.strokeStyle = c.accent
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (const ni of nets) {
        const n = d.nets[ni]
        if (n.g) continue
        for (let k = 0; k < n.s.length; k += 4) {
          const [x1, y1] = center(n.s[k], n.s[k + 1])
          const [x2, y2] = center(n.s[k + 2], n.s[k + 3])
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y2)
        }
      }
      ctx.stroke()
      const [tx, ty] = this.pickTile.split(',').map(Number)
      ctx.strokeStyle = c.ink
      ctx.lineWidth = 1.5
      ctx.strokeRect(g.tx(tx) + 0.5, g.ty(ty) + 0.5, s - 1, s - 1)
    }

    // critical path
    const p = d.criticalPaths?.[this.pathIndex]
    if (this.showPath && p) {
      const pts = []
      for (const hop of p.path) {
        for (const end of [hop.from, hop.to]) {
          if (!end?.loc) continue
          const last = pts[pts.length - 1]
          if (!last || last[0] !== end.loc[0] || last[1] !== end.loc[1]) pts.push(end.loc)
        }
      }
      ctx.strokeStyle = c['f-path']
      ctx.fillStyle = c['f-path']
      ctx.lineWidth = 2.25
      ctx.lineJoin = 'round'
      ctx.beginPath()
      pts.forEach(([tx, ty], k) => {
        const [x, y] = center(tx, ty)
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y)
      })
      ctx.stroke()
      // arrowheads and stops
      for (let k = 1; k < pts.length; k++) {
        const [x1, y1] = center(...pts[k - 1]), [x2, y2] = center(...pts[k])
        const a = Math.atan2(y2 - y1, x2 - x1)
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
        if (Math.hypot(x2 - x1, y2 - y1) > 16) {
          ctx.beginPath()
          ctx.moveTo(mx + 5 * Math.cos(a), my + 5 * Math.sin(a))
          ctx.lineTo(mx - 4 * Math.cos(a) + 4 * Math.sin(a), my - 4 * Math.sin(a) - 4 * Math.cos(a))
          ctx.lineTo(mx - 4 * Math.cos(a) - 4 * Math.sin(a), my - 4 * Math.sin(a) + 4 * Math.cos(a))
          ctx.fill()
        }
      }
      pts.forEach(([tx, ty], k) => {
        const [x, y] = center(tx, ty)
        ctx.beginPath()
        ctx.arc(x, y, k === 0 || k === pts.length - 1 ? 4.5 : 3, 0, Math.PI * 2)
        ctx.fillStyle = k === 0 || k === pts.length - 1 ? c['f-path'] : c.bg
        ctx.fill()
        ctx.stroke()
      })
      if (this.hop != null && p.path[this.hop]) {
        const hop = p.path[this.hop]
        ctx.strokeStyle = c.accent
        ctx.lineWidth = 3
        const a = hop.from?.loc, b = hop.to?.loc
        if (a && b) {
          const [x1, y1] = center(...a), [x2, y2] = center(...b)
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
          for (const [x, y] of [[x1, y1], [x2, y2]]) { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke() }
        }
      }
    }
  }

  tileAt(ex, ey) {
    const g = this.geom()
    const tx = Math.floor((ex - g.tx(0)) / g.s)
    const ty = g.gh - 1 - Math.floor((ey - g.ty(g.gh - 1)) / g.s)
    if (tx < 0 || ty < 0 || tx >= g.gw || ty >= g.gh) return null
    return { tx, ty, t: this.data.grid?.rows?.[ty]?.[tx] ?? '.' }
  }

  wireCanvas() {
    const cv = this.canvas
    let press = null
    cv.addEventListener('pointerdown', (e) => {
      press = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, id: e.pointerId }
    })
    cv.addEventListener('pointermove', (e) => {
      if (press) {
        const dx = e.clientX - press.x, dy = e.clientY - press.y
        if (!press.moved && Math.hypot(dx, dy) > 3 && this.view.k > 1) { press.moved = true; cv.setPointerCapture(press.id) }
        if (press.moved) { this.view.x = press.vx + dx; this.view.y = press.vy + dy; this.draw(); hideTip(); return }
      }
      const t = this.tileAt(e.offsetX, e.offsetY)
      if (!t || t.t === '.') { hideTip(); return }
      const idxs = this.tiles.get(`${t.tx},${t.ty}`) ?? []
      const cells = idxs.map((i) => this.data.cells[i])
      const lcs = cells.filter((x) => x.t === 'ICESTORM_LC')
      const pin = this.data.pins?.find((p) => p.x === t.tx && p.y === t.ty)
      let html = `<span class="mono">X${t.tx} Y${t.ty}</span> <span class="dim">${TILE_NAMES[t.t] ?? t.t}</span>`
      if (t.t === 'L') html += `<br>${lcs.length}/8 logic cells used`
      for (const x of cells.slice(0, 6)) html += `<br><span class="mono">${esc(shortCell(x.n))}</span> <span class="dim">${x.t === 'ICESTORM_LC' ? [x.lut ? 'LUT' : '', x.ff ? 'FF' : '', x.carry ? 'carry' : ''].filter(Boolean).join('+') : x.t}</span>`
      if (cells.length > 6) html += `<br><span class="dim">+${cells.length - 6} more</span>`
      if (t.t === 'I' && pin) html += `<br><span class="dim">package pin ${esc(pin.pin)}${this.data.pins.filter((p) => p.x === t.tx && p.y === t.ty).length > 1 ? ` and ${esc(this.data.pins.filter((p) => p.x === t.tx && p.y === t.ty)[1].pin)}` : ''}</span>`
      showTip(e.clientX, e.clientY, html)
    })
    cv.addEventListener('pointerup', (e) => {
      if (press && !press.moved) {
        const t = this.tileAt(e.offsetX, e.offsetY)
        const key = t ? `${t.tx},${t.ty}` : null
        this.pickTile = key && this.tiles.has(key) && this.pickTile !== key ? key : null
        this.renderTileInfo()
        this.draw()
      }
      press = null
    })
    cv.addEventListener('pointerleave', hideTip)
    cv.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0025))
      const k = Math.max(1, Math.min(8, this.view.k * f))
      if (k === this.view.k) return
      // keep the point under the pointer where it is
      const g = this.geom()
      const cx = e.offsetX - g.W / 2 - this.view.x, cy = e.offsetY - g.H / 2 - this.view.y
      const r = k / this.view.k
      this.view.x -= cx * (r - 1)
      this.view.y -= cy * (r - 1)
      this.view.k = k
      if (k === 1) { this.view.x = 0; this.view.y = 0 }
      this.draw()
    }, { passive: false })
    cv.addEventListener('dblclick', () => { this.view = { k: 1, x: 0, y: 0 }; this.draw() })
  }

  renderTileInfo() {
    const el = this.tileInfo
    el.innerHTML = ''
    if (!this.pickTile) { el.hidden = true; return }
    el.hidden = false
    const [tx, ty] = this.pickTile.split(',').map(Number)
    const idxs = this.tiles.get(this.pickTile) ?? []
    const nets = new Set(idxs.flatMap((i) => this.netsByCell.get(i) ?? []))
    const table = h('table')
    for (const i of idxs.sort((a, b) => String(this.data.cells[a].b).localeCompare(String(this.data.cells[b].b)))) {
      const c = this.data.cells[i]
      table.append(h('tr',
        h('td', c.b),
        h('td', { title: c.n }, shortCell(c.n), h('div', { style: { color: 'var(--faint)' } }, this.moduleLabel(c.m))),
        h('td.flags', c.t === 'ICESTORM_LC'
          ? [c.lut ? h('i', `LUT${c.k ? c.k : ''}`) : null, c.ff ? h('i', 'FF') : null, c.carry ? h('i', 'carry') : null, c.init && c.lut ? h('i', { title: 'LUT_INIT' }, c.init) : null]
          : h('i', c.t))))
    }
    el.append(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' } },
      h('b', { style: { fontFamily: 'var(--mono)' } }, `X${tx} Y${ty}`),
      h('span.note', `${TILE_NAMES[this.data.grid?.rows?.[ty]?.[tx]] ?? ''} tile · ${idxs.length} cell${idxs.length === 1 ? '' : 's'} · ${nets.size} net${nets.size === 1 ? '' : 's'} drawn in blue`),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button.icon-btn', { onclick: () => { this.pickTile = null; this.renderTileInfo(); this.draw() } }, '×')), table)
  }

  key(e) {
    if (!this.data) return
    if (e.key === 'r' || e.key === 'R') { this.showRoutes = !this.showRoutes; this.render() }
    else if (e.key === 'p' || e.key === 'P') { this.showPath = !this.showPath; this.render() }
    else if (e.key === 'c' || e.key === 'C') { this.colorBy = this.colorBy === 'module' ? 'kind' : 'module'; this.render() }
    else if (e.key === 'Escape') { this.pickTile = null; this.hop = null; this.renderTileInfo(); this.draw() }
  }
}
