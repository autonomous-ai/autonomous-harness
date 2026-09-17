// The board: which pins of the FPGA the design uses and what each is wired to on an iCEBreaker —
// drawn as the board, with the iCE40UP5K's 48 pins and a trace from every used one to the part it
// reaches, and as a table. Everything comes from constraints/<top>.pcf and the synthesised ports.
import { h, emptyState, ART, showTip, hideTip, esc, svgEl } from './util.js'

// iCEBreaker v1.0 — pin numbers from the iCEBreaker project's own PCF (the template's source).
const FEATURES = [
  { id: 'clk', group: 'Clock', name: '12 MHz oscillator', pins: [['35', 'clk']] },
  { id: 'uart', group: 'UART (FTDI)', name: 'USB serial', pins: [['6', 'rx', 'in'], ['9', 'tx', 'out']] },
  { id: 'btn', group: 'Buttons', name: 'User button', pins: [['10', 'btn_n']], note: 'active low' },
  { id: 'ledr', group: 'LEDs', name: 'Red LED', pins: [['11', 'ledr_n']], note: 'active low', led: '#e5484d' },
  { id: 'ledg', group: 'LEDs', name: 'Green LED', pins: [['37', 'ledg_n']], note: 'active low', led: '#30a46c' },
  { id: 'rgb', group: 'RGB LED', name: 'RGB LED', pins: [['39', 'led_red_n'], ['40', 'led_grn_n'], ['41', 'led_blu_n']], note: 'active low, via SB_RGBA_DRV' },
  { id: 'flash', group: 'SPI flash', name: 'SPI flash', pins: [['15', 'flash_sck'], ['16', 'flash_ssb'], ['14', 'flash_io0'], ['17', 'flash_io1'], ['12', 'flash_io2'], ['13', 'flash_io3']] },
  { id: 'pmod1a', group: 'PMOD 1A', name: 'PMOD 1A', pins: [['4', 'p1a1'], ['2', 'p1a2'], ['47', 'p1a3'], ['45', 'p1a4'], ['3', 'p1a7'], ['48', 'p1a8'], ['46', 'p1a9'], ['44', 'p1a10']] },
  { id: 'pmod1b', group: 'PMOD 1B', name: 'PMOD 1B', pins: [['43', 'p1b1'], ['38', 'p1b2'], ['34', 'p1b3'], ['31', 'p1b4'], ['42', 'p1b7'], ['36', 'p1b8'], ['32', 'p1b9'], ['28', 'p1b10']] },
  { id: 'leds', group: 'Snap-off', name: 'LEDs 1–5', pins: [['26', 'led1'], ['27', 'led2'], ['25', 'led3'], ['23', 'led4'], ['21', 'led5']], note: 'active high', led: '#e5484d' },
  { id: 'btns', group: 'Snap-off', name: 'Buttons 1–3', pins: [['20', 'btn1'], ['19', 'btn2'], ['18', 'btn3']], note: 'active high' },
  { id: 'pmod2', group: 'PMOD 2', name: 'PMOD 2', pins: [['27', 'p2_1'], ['25', 'p2_2'], ['21', 'p2_3'], ['19', 'p2_4'], ['26', 'p2_7'], ['23', 'p2_8'], ['20', 'p2_9'], ['18', 'p2_10']] },
]

function featuresForPin(pin) {
  const out = []
  for (const f of FEATURES) for (const [p, net] of f.pins) if (p === String(pin)) out.push({ feature: f, net })
  return out
}

/** The board part a port most likely means: a snap-off pin is both a PMOD 2 pin and an LED or a
 * button; the port's name decides. */
function bestFeature(pin, port) {
  const all = featuresForPin(pin)
  if (all.length <= 1) return all[0] ?? null
  const n = (port ?? '').toLowerCase()
  const want = /led/.test(n) ? 'leds' : /btn|button|key/.test(n) ? 'btns' : 'pmod2'
  return all.find((x) => x.feature.id === want) ?? all[0]
}

export class BoardTab {
  constructor(root, ctx) {
    this.root = root
    this.ctx = ctx
    this.data = null
    this.stamp = null
    this.hl = null
    this.visible = false
    this.root.innerHTML = ''
    this.body = h('div.board-body')
    this.root.append(this.body)
    new ResizeObserver(() => { if (this.visible) this.root.classList.toggle('board-wide', this.root.clientWidth >= 1080) }).observe(this.root)
  }

  show() { this.visible = true; this.root.classList.toggle('board-wide', this.root.clientWidth >= 1080) }
  hide() { this.visible = false; hideTip() }
  reset() { this.stamp = null }

  update(state) {
    const f = state.files ?? {}
    const stamp = [f.pcf, f.netlist, f.schematic, f.routed].map((x) => (x ? `${x.mtime}:${x.size}` : '-')).join('|') + state.top
    if (stamp === this.stamp) return
    this.stamp = stamp
    this.load()
  }

  async load() {
    try { this.data = await this.ctx.api('board') } catch (e) { this.data = null }
    this.render()
  }

  render() {
    const b = this.body
    b.innerHTML = ''
    const d = this.data
    if (!d?.pcf) {
      b.append(emptyState({ icon: ART.board, title: 'No pin constraints yet', body: `Each port of the top module is wired to a pin in <code>constraints/${esc(this.ctx.top ?? '&lt;top&gt;')}.pcf</code>. This tab shows the board once there is one.` }))
      return
    }
    const ports = d.ports?.ports ?? {}
    const used = d.pcf.ios.filter((io) => !io.commented)
    // a PCF line for a port the design does not have is fine (-nowarn), but it is not "used"
    const portOf = (name) => name.replace(/\[\d+\]$/, '')
    const haveNetlist = Boolean(d.ports)
    const active = used.filter((io) => !haveNetlist || ports[portOf(io.port)])
    const extra = used.filter((io) => haveNetlist && !ports[portOf(io.port)])
    const constrained = new Set(active.map((io) => portOf(io.port)))
    const missing = Object.keys(ports).filter((p) => !constrained.has(p))
    const byPin = new Map()
    for (const io of active) {
      if (!byPin.has(io.pin)) byPin.set(io.pin, [])
      byPin.get(io.pin).push(io)
    }
    const clash = [...byPin.entries()].filter(([, v]) => v.length > 1)
    this.active = active
    this.ports = ports

    const grid = h('div.board-grid')
    b.append(grid)
    const left = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } })
    const right = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } })
    grid.append(left, right)

    const boardCard = h('div.card2', h('h4', 'iCEBreaker', h('span.sub', `iCE40 ${String(d.arch ?? 'up5k').toUpperCase()} · ${String(d.package ?? 'sg48').toUpperCase()} · ${active.length} pin${active.length === 1 ? '' : 's'} in use`), h('span.grow'),
      h('a', { href: '#', style: { fontSize: '11.5px', fontWeight: 400 }, onclick: (e) => { e.preventDefault(); this.ctx.openSource(d.pcf.path) } }, d.pcf.path)))
    const inner = h('div', { style: { padding: '8px' } })
    inner.append(this.drawBoard(active, ports, d))
    boardCard.append(inner)
    left.append(boardCard)

    // warnings
    const warns = []
    for (const p of missing) warns.push(`Port ${p} has no set_io line — nextpnr stops with “unconstrained IO”.`)
    for (const [pin, ios] of clash) warns.push(`Pin ${pin} is given to ${ios.map((x) => x.port).join(' and ')}.`)
    if (d.arch && d.arch !== 'up5k') warns.push(`This design targets ${d.arch.toUpperCase()}, not the iCEBreaker's UP5K; the board drawing is only a guide.`)

    const tableCard = h('div.card2', h('h4', 'Pins', h('span.sub', 'port → package pin → board')))
    const tInner = h('div', { style: { padding: '4px 4px 8px' } })
    if (warns.length) tInner.append(h('div', { style: { padding: '8px 8px 0' } }, warns.map((w) => h('div.warnline', w))))
    const table = h('table.pin-table')
    table.append(h('tr', h('th', 'Port'), h('th', 'Dir'), h('th', 'Pin'), h('th', 'On the board')))
    const rows = active.slice().sort((a, b) => {
      const fa = bestFeature(a.pin, a.port)?.feature, fb = bestFeature(b.pin, b.port)?.feature
      return FEATURES.indexOf(fa) - FEATURES.indexOf(fb) || Number(a.pin) - Number(b.pin)
    })
    let lastGroup = null
    for (const io of rows) {
      const bf = bestFeature(io.pin, io.port)
      const group = bf?.feature.group ?? 'Other'
      if (group !== lastGroup) { table.append(h('tr.group-h', h('td', { colspan: 4 }, group))); lastGroup = group }
      const port = ports[portOf(io.port)]
      const dir = port?.direction
      const flags = [io.pullup ? `pull-up${io.pullup_resistor ? ` ${io.pullup_resistor}` : ''}` : '', bf?.feature.note ?? '', d.pcf.frequencies?.[io.port] ? `${d.pcf.frequencies[io.port]} MHz` : ''].filter(Boolean)
      table.append(h(`tr${this.hl === io.pin ? '.hl' : ''}`, {
        dataset: { pin: io.pin },
        onmouseenter: () => this.highlight(io.pin),
        onmouseleave: () => this.highlight(null),
        onclick: () => this.ctx.openSource(d.pcf.path, io.line),
        style: { cursor: 'pointer' },
      },
      h('td.port', io.port),
      h('td', dir ? h(`span.dir.${dir}`, dir === 'input' ? 'IN' : dir === 'output' ? 'OUT' : 'INOUT') : h('span.note', '—')),
      h('td.pin', io.pin),
      h('td', bf ? `${bf.feature.name}${bf.feature.pins.length > 1 ? ` · ${bf.net}` : ''}` : h('span.note', 'not an iCEBreaker part'),
        flags.length ? h('div.note', flags.join(' · ')) : null)))
    }
    if (!active.length) table.append(h('tr', h('td', { colspan: 4, style: { color: 'var(--faint)', padding: '12px 8px' } }, 'No set_io lines are active in the PCF.')))
    tInner.append(table)
    if (extra.length) {
      tInner.append(h('div.note', { style: { padding: '10px 8px 0' } },
        `Also in the PCF for ports this design does not have (kept by -nowarn): ${extra.map((x) => `${x.port}→${x.pin}`).join(', ')}`))
    }
    tableCard.append(tInner)
    right.append(tableCard)

    const free = FEATURES.filter((f) => !f.pins.some(([p]) => byPin.has(p)))
    if (free.length) {
      right.append(h('div.card2', h('h4', 'Free on the board', h('span.sub', 'uncomment its lines in the PCF to use one')),
        h('div.inner', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          free.map((f) => h('span.pill', { title: f.pins.map(([p, n]) => `${n} → ${p}`).join('\n') }, `${f.name} · ${f.pins.map(([p]) => p).join(', ')}`)))))
    }
  }

  highlight(pin) {
    this.hl = pin
    this.svg?.querySelectorAll('[data-pin]').forEach((el) => el.classList.toggle('hlp', el.dataset.pin === pin))
    this.body.querySelectorAll('tr[data-pin]').forEach((tr) => tr.classList.toggle('hl', tr.dataset.pin === pin))
  }

  // ---------------------------------------------------------------------------- the drawing

  drawBoard(active, ports, d) {
    const W = 1000, H = 600
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'board-svg', role: 'img', 'aria-label': 'iCEBreaker board' })
    this.svg = svg
    const defs = svgEl('defs')
    defs.append(svgEl('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' },
      svgEl('feGaussianBlur', { stdDeviation: '5' })))
    svg.append(defs)
    const g = (cls) => svgEl('g', { class: cls })
    const portByPin = new Map(active.map((io) => [io.pin, io]))
    const ioPins = new Set((d.pins ?? []).map((p) => p.pin))

    // boards
    svg.append(svgEl('rect', { x: 8, y: 8, width: 752, height: 584, rx: 22, class: 'bd-pcb' }))
    svg.append(svgEl('rect', { x: 776, y: 8, width: 216, height: 584, rx: 22, class: 'bd-pcb' }))
    svg.append(svgEl('line', { x1: 768, y1: 30, x2: 768, y2: 570, class: 'bd-perf' }))
    svg.append(svgEl('text', { x: 884, y: 36, class: 'bd-title', 'text-anchor': 'middle' }, 'snap-off'))
    for (const [x, y] of [[30, 30], [738, 30], [30, 570], [738, 570], [798, 570], [970, 570], [798, 60], [970, 60]]) svg.append(svgEl('circle', { cx: x, cy: y, r: 7, class: 'bd-hole' }))

    // the FPGA
    const X0 = 330, Y0 = 220, S = 170
    const pitch = S / 13
    const pinPos = (n) => {
      n = Number(n)
      if (n <= 12) return { x: X0 - 9, y: Y0 + n * pitch, side: 'l' }
      if (n <= 24) return { x: X0 + (n - 12) * pitch, y: Y0 + S + 9, side: 'b' }
      if (n <= 36) return { x: X0 + S + 9, y: Y0 + S - (n - 24) * pitch, side: 'r' }
      return { x: X0 + S - (n - 36) * pitch, y: Y0 - 9, side: 't' }
    }
    const traces = g('bd-traces')
    const parts = g('bd-parts')
    const chip = g('bd-chip')
    svg.append(traces, parts, chip)
    chip.append(svgEl('rect', { x: X0, y: Y0, width: S, height: S, rx: 6, class: 'bd-ic' }))
    chip.append(svgEl('circle', { cx: X0 + 14, cy: Y0 + 14, r: 4, class: 'bd-dot' }))
    chip.append(svgEl('text', { x: X0 + S / 2, y: Y0 + S / 2 - 6, class: 'bd-ic-t', 'text-anchor': 'middle' }, 'iCE40'))
    chip.append(svgEl('text', { x: X0 + S / 2, y: Y0 + S / 2 + 14, class: 'bd-ic-s', 'text-anchor': 'middle' }, `${String(d.arch ?? 'up5k').toUpperCase()}-${String(d.package ?? 'sg48').toUpperCase()}`))
    for (let n = 1; n <= 48; n++) {
      const p = pinPos(n)
      const horiz = p.side === 'l' || p.side === 'r'
      const used = portByPin.has(String(n))
      const io = portByPin.get(String(n))
      const port = io && ports[io.port.replace(/\[\d+\]$/, '')]
      const el = svgEl('rect', {
        x: horiz ? p.x - 7 : p.x - 3, y: horiz ? p.y - 3 : p.y - 7, width: horiz ? 14 : 6, height: horiz ? 6 : 14, rx: 1.5,
        class: `bd-pin${used ? ' used' : ''}${ioPins.has(String(n)) ? '' : ' nio'}`, 'data-pin': String(n),
      })
      el.addEventListener('mouseenter', (e) => {
        const feats = featuresForPin(n)
        showTip(e.clientX, e.clientY, `<b>pin ${n}</b>${io ? ` · <span class="mono">${esc(io.port)}</span>${port ? ` <span class="dim">${esc(port.direction)}</span>` : ''}` : ''}` +
          `${feats.length ? `<br><span class="dim">${esc(feats.map((f) => `${f.feature.name} (${f.net})`).join(' · '))}</span>` : ''}` +
          `${ioPins.has(String(n)) ? '' : '<br><span class="dim">power, ground or configuration — not a user I/O</span>'}`)
        this.highlight(String(n))
      })
      el.addEventListener('mouseleave', () => { hideTip(); this.highlight(null) })
      chip.append(el)
      if (n % 12 === 1) {
        const off = 20
        const tx = p.side === 'l' ? p.x - off : p.side === 'r' ? p.x + off : p.x
        const ty = p.side === 't' ? p.y - off + 4 : p.side === 'b' ? p.y + off : p.y + 3.5
        if (!used) chip.append(svgEl('text', { x: p.side === 'l' ? X0 + 10 : p.side === 'r' ? X0 + S - 10 : p.x, y: p.side === 't' ? Y0 + 20 : p.side === 'b' ? Y0 + S - 12 : p.y + 3.5, class: 'bd-pinno', 'text-anchor': p.side === 'l' ? 'start' : p.side === 'r' ? 'end' : 'middle' }, String(n)))
        void tx; void ty
      }
    }

    // the parts, each with the anchor its traces run to
    const part = (id, x, y, w, hgt, label, sub, extraCls = '') => {
      const on = FEATURES.find((f) => f.id === id).pins.some(([p]) => portByPin.has(p))
      const grp = svgEl('g', { class: `bd-part${on ? ' on' : ''} ${extraCls}` })
      grp.append(svgEl('rect', { x, y, width: w, height: hgt, rx: 5 }))
      if (label) grp.append(svgEl('text', { x: x + w / 2, y: y + hgt / 2 + (sub ? -2 : 4), 'text-anchor': 'middle', class: 'bd-lbl' }, label))
      if (sub) grp.append(svgEl('text', { x: x + w / 2, y: y + hgt / 2 + 12, 'text-anchor': 'middle', class: 'bd-sub' }, sub))
      parts.append(grp)
      return grp
    }
    const led = (id, cx, cy, color, label) => {
      const f = FEATURES.find((x) => x.id === id)
      const on = f.pins.some(([p]) => portByPin.has(p))
      const grp = svgEl('g', { class: `bd-led${on ? ' on' : ''}` })
      if (on) grp.append(svgEl('circle', { cx, cy, r: 14, fill: color, opacity: 0.45, filter: 'url(#glow)' }))
      grp.append(svgEl('rect', { x: cx - 9, y: cy - 6, width: 18, height: 12, rx: 3, fill: on ? color : 'none', class: 'bd-led-body' }))
      grp.append(svgEl('text', { x: cx, y: cy + 24, 'text-anchor': 'middle', class: 'bd-sub' }, label))
      parts.append(grp)
    }
    const trace = (pin, ax, ay, label, labelSide = 'end', dx = 0, dy = -7) => {
      const io = portByPin.get(String(pin))
      if (!io) return
      const p = pinPos(pin)
      // neighbouring pins leave the package at different distances so their traces do not merge
      const out = 12 + (Number(pin) % 3) * 8
      const sx = p.side === 'l' ? p.x - 7 : p.side === 'r' ? p.x + 7 : p.x
      const sy = p.side === 't' ? p.y - 7 : p.side === 'b' ? p.y + 7 : p.y
      const ex = p.side === 'l' ? sx - out : p.side === 'r' ? sx + out : sx
      const ey = p.side === 't' ? sy - out : p.side === 'b' ? sy + out : sy
      const horiz = p.side === 'l' || p.side === 'r'
      const d = horiz ? `M${sx},${sy} H${ex} V${ay} H${ax}` : `M${sx},${sy} V${ey} H${ax} V${ay}`
      const port = ports[io.port.replace(/\[\d+\]$/, '')]
      traces.append(svgEl('path', { d, class: `bd-trace ${port?.direction ?? ''}`, 'data-pin': String(pin) }))
      traces.append(svgEl('circle', { cx: ax, cy: ay, r: 3, class: 'bd-via', 'data-pin': String(pin) }))
      const lx = horiz ? (sx + ex) / 2 : ex
      const ly = horiz ? sy - 5 : (sy + ey) / 2
      void lx; void ly
      if (label !== false) {
        const t = svgEl('text', { x: ax + dx + (labelSide === 'end' ? -6 : labelSide === 'start' ? 6 : 0), y: ay + dy, 'text-anchor': labelSide, class: 'bd-port', 'data-pin': String(pin) }, io.port)
        traces.append(t)
      }
    }

    // USB + FTDI on the left edge, UART to pins 6 and 9
    part('uart', 8, 262, 44, 70, '', '', 'usb')
    svg.querySelector('.usb')?.append(svgEl('text', { x: 30, y: 350, 'text-anchor': 'middle', class: 'bd-sub' }, 'USB'))
    part('uart', 92, 262, 96, 96, 'FT2232H', 'USB ↔ UART')
    trace(6, 188, pinPos(6).y, true, 'start')
    trace(9, 188, pinPos(9).y, true, 'start')
    // user button, red LED — left, below the UART
    part('btn', 110, 440, 60, 44, 'USR', 'button')
    trace(10, 170, 462, true, 'start')
    led('ledr', 250, 512, '#e5484d', 'LEDR')
    trace(11, 250, 506, true, 'end', -12, 4)
    // flash under the chip
    part('flash', 330, 470, 170, 58, 'SPI flash', 'W25Q128')
    for (const [pin, x] of [[12, 342], [13, 358], [14, 376], [15, 400], [16, 430], [17, 460]]) trace(pin, x, 470, false)
    // oscillator right of the chip, top
    part('clk', 560, 212, 78, 46, '12 MHz', 'oscillator')
    trace(35, 560, 235, true, 'end', -14, -8)
    // green LED and the RGB LED along the top
    led('ledg', 560, 120, '#30a46c', 'LEDG')
    trace(37, 560, 126, true, 'end', -14, 4)
    part('rgb', 356, 90, 88, 44, 'RGB', 'LED')
    for (const [pin, x] of [[39, 372], [40, 400], [41, 428]]) trace(pin, x, 134, pin === 40, 'middle')
    // PMOD 1A: top-left header; PMOD 1B: right edge of the main board
    const header = (id, x, y, horizontal, pinsList) => {
      const f = FEATURES.find((q) => q.id === id)
      const grp = svgEl('g', { class: `bd-hdr${f.pins.some(([p]) => portByPin.has(p)) ? ' on' : ''}` })
      const n = pinsList.length
      grp.append(svgEl('rect', { x: x - 12, y: y - 12, width: horizontal ? n * 22 + 2 : 24, height: horizontal ? 24 : n * 22 + 2, rx: 4 }))
      pinsList.forEach(([pin, label], k) => {
        const cx = horizontal ? x + k * 22 : x, cy = horizontal ? y : y + k * 22
        grp.append(svgEl('circle', { cx, cy, r: 6, class: `bd-pad${portByPin.has(pin) ? ' used' : ''}`, 'data-pin': pin }))
        grp.append(svgEl('text', { x: horizontal ? cx : cx + (x > 500 ? -16 : 16), y: horizontal ? cy - 16 : cy + 3.5, 'text-anchor': 'middle', class: 'bd-pinno' }, label))
      })
      grp.append(svgEl('text', { x: horizontal ? x + ((n - 1) * 22) / 2 : x, y: horizontal ? y + 30 : y + n * 22 + 16, 'text-anchor': 'middle', class: 'bd-sub' }, f.name))
      parts.append(grp)
      return (k) => (horizontal ? [x + k * 22, y + 6] : [x - 6, y + k * 22])
    }
    const pa = header('pmod1a', 70, 70, true, [['4', '1'], ['2', '2'], ['47', '3'], ['45', '4'], ['3', '7'], ['48', '8'], ['46', '9'], ['44', '10']])
    ;['4', '2', '47', '45', '3', '48', '46', '44'].forEach((pin, k) => { const [x, y] = pa(k); trace(pin, x, y, true, 'middle') })
    const pb = header('pmod1b', 712, 300, false, [['43', '1'], ['38', '2'], ['34', '3'], ['31', '4'], ['42', '7'], ['36', '8'], ['32', '9'], ['28', '10']])
    ;['43', '38', '34', '31', '42', '36', '32', '28'].forEach((pin, k) => { const [x, y] = pb(k); trace(pin, x, y, true, 'end') })

    // snap-off: LEDs, buttons, PMOD 2 — the same eight pins
    const snapPins = new Set(['27', '25', '21', '19', '26', '23', '20', '18'])
    ;[['26', 'LED1'], ['27', 'LED2'], ['25', 'LED3'], ['23', 'LED4'], ['21', 'LED5']].forEach(([pin, label], k) => {
      const io = portByPin.get(pin)
      const isLed = io && bestFeature(pin, io.port)?.feature.id === 'leds'
      const cy = 110 + k * 56
      const grp = svgEl('g', { class: `bd-led${isLed ? ' on' : ''}`, 'data-pin': pin })
      if (isLed) grp.append(svgEl('circle', { cx: 830, cy, r: 14, fill: '#e5484d', opacity: 0.45, filter: 'url(#glow)' }))
      grp.append(svgEl('rect', { x: 821, y: cy - 6, width: 18, height: 12, rx: 3, fill: isLed ? '#e5484d' : 'none', class: 'bd-led-body' }))
      grp.append(svgEl('text', { x: 830, y: cy + 22, 'text-anchor': 'middle', class: 'bd-sub' }, label))
      if (io && isLed) grp.append(svgEl('text', { x: 852, y: cy + 4, class: 'bd-port' }, io.port))
      parts.append(grp)
    })
    ;[['20', 'BTN1'], ['19', 'BTN2'], ['18', 'BTN3']].forEach(([pin, label], k) => {
      const io = portByPin.get(pin)
      const isBtn = io && bestFeature(pin, io.port)?.feature.id === 'btns'
      const cy = 400 + k * 56
      const grp = svgEl('g', { class: `bd-part${isBtn ? ' on' : ''}`, 'data-pin': pin })
      grp.append(svgEl('rect', { x: 812, y: cy - 14, width: 36, height: 28, rx: 5 }))
      grp.append(svgEl('text', { x: 830, y: cy + 30, 'text-anchor': 'middle', class: 'bd-sub' }, label))
      if (io && isBtn) grp.append(svgEl('text', { x: 856, y: cy + 4, class: 'bd-port' }, io.port))
      parts.append(grp)
    })
    const p2 = [['27', '1'], ['25', '2'], ['21', '3'], ['19', '4'], ['26', '7'], ['23', '8'], ['20', '9'], ['18', '10']]
    const hdr2 = svgEl('g', { class: `bd-hdr${p2.some(([p]) => portByPin.has(p) && bestFeature(p, portByPin.get(p).port)?.feature.id === 'pmod2') ? ' on' : ''}` })
    hdr2.append(svgEl('rect', { x: 948, y: 118, width: 24, height: 178, rx: 4 }))
    p2.forEach(([pin, label], k) => {
      const io = portByPin.get(pin)
      const isP = io && bestFeature(pin, io.port)?.feature.id === 'pmod2'
      hdr2.append(svgEl('circle', { cx: 960, cy: 130 + k * 22, r: 6, class: `bd-pad${isP ? ' used' : ''}`, 'data-pin': pin }))
      hdr2.append(svgEl('text', { x: 938, y: 133.5 + k * 22, 'text-anchor': 'end', class: 'bd-pinno' }, isP ? io.port : label))
    })
    hdr2.append(svgEl('text', { x: 960, y: 316, 'text-anchor': 'middle', class: 'bd-sub' }, 'PMOD 2'))
    parts.append(hdr2)
    // snap-off pins cross the perforation from the chip's bottom-right
    for (const pin of snapPins) {
      if (!portByPin.has(pin)) continue
      const io = portByPin.get(pin)
      const id = bestFeature(pin, io.port)?.feature.id
      const k = id === 'leds' ? ['26', '27', '25', '23', '21'].indexOf(pin) : id === 'btns' ? ['20', '19', '18'].indexOf(pin) : p2.findIndex(([p]) => p === pin)
      const [ax, ay] = id === 'leds' ? [821, 110 + k * 56] : id === 'btns' ? [812, 400 + k * 56] : [954, 130 + k * 22]
      trace(pin, ax, ay, false)
    }

    svg.append(svgEl('text', { x: 24, y: 588, class: 'bd-title' }, 'iCEBreaker v1.0'))
    return svg
  }

  key() {}
}
