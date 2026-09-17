// A small live plot, like simulate's figures: the last few seconds of simulated time.
//
// One axis per chart. Signals whose series share a unit (potential and kinetic energy) share a
// chart and get a legend; signals whose series do not (a joint's position and velocity) are drawn as
// stacked small multiples, each with its own scale. A crosshair follows the pointer and the readout
// lists every series at that instant; otherwise it shows the latest values.

const WINDOW_S = 10
const MAX_SAMPLES = 1200

export class Plot {
  constructor(canvas, readout) {
    this.canvas = canvas
    this.readout = readout
    this.ctx = canvas.getContext('2d')
    this.signal = null
    this.samples = []          // [t, v0, v1, …]
    this.hoverX = null
    this.dirty = true
    this.lastDraw = 0
    canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); this.hoverX = e.clientX - r.left; this.dirty = true })
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.dirty = true })
  }

  /** `signal`: { id, label, series: [{ name, unit, get }], stacked } */
  setSignal(signal) {
    if (this.signal?.id === signal?.id) { this.signal = signal; return }
    this.signal = signal
    this.samples = []
    this.static = false
    this.dirty = true
  }

  clear() { this.samples = []; this.static = false; this.cursor = null; this.dirty = true }

  /** The whole recording at once (replay): fixed samples, and a cursor at the frame on screen. */
  setStatic(samples) { this.samples = samples; this.static = true; this.dirty = true }

  setCursor(t) { if (this.cursor !== t) { this.cursor = t; this.dirty = true } }

  sample(t) {
    const s = this.signal
    if (!s || this.static) return
    const last = this.samples[this.samples.length - 1]
    if (last && t < last[0] - 1e-9) this.samples = []           // time went backwards: a reset
    if (last && Math.abs(t - last[0]) < 1e-9) return           // paused: nothing new
    const row = [t]
    for (const series of s.series) { const v = series.get(); row.push(Number.isFinite(v) ? v : NaN) }
    this.samples.push(row)
    const cutoff = t - WINDOW_S
    let drop = 0
    while (drop < this.samples.length - 2 && this.samples[drop][0] < cutoff) drop++
    if (drop) this.samples.splice(0, drop)
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
    this.dirty = true
  }

  draw(now = performance.now()) {
    if (!this.dirty || now - this.lastDraw < 33) return
    if (!this.canvas.isConnected || this.canvas.offsetParent === null) return
    this.lastDraw = now
    this.dirty = false
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr)
    }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const css = getComputedStyle(document.documentElement)
    const ink = { text: css.getPropertyValue('--text-2').trim(), faint: css.getPropertyValue('--text-3').trim(), grid: css.getPropertyValue('--line').trim(), surface: css.getPropertyValue('--panel').trim() }
    const colors = [css.getPropertyValue('--series-1').trim(), css.getPropertyValue('--series-2').trim()]
    const s = this.signal
    if (!s || this.samples.length < 2) {
      ctx.fillStyle = ink.faint
      ctx.font = '11px -apple-system, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(s ? 'Waiting for the simulation to run…' : 'Nothing to plot', width / 2, height / 2)
      this.readout.textContent = ''
      return
    }
    const t1 = this.samples[this.samples.length - 1][0]
    const t0 = this.static ? this.samples[0][0] : Math.max(this.samples[0][0], t1 - WINDOW_S)
    const right = 8
    const charts = s.stacked ? s.series.map((_, i) => [i]) : [s.series.map((_, i) => i)]
    const gap = 10
    const chartH = (height - 14 - gap * (charts.length - 1)) / charts.length
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace'
    // Each chart's range and its two axis labels first: the gutter is as wide as the widest label.
    const ranges = charts.map((indices) => {
      let lo = Infinity, hi = -Infinity
      for (const row of this.samples) for (const i of indices) { const v = row[i + 1]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
      if (hi - lo < 1e-9) { const pad = Math.max(Math.abs(hi) * 0.05, 1e-3); lo -= pad; hi += pad }
      const pad = (hi - lo) * 0.08
      lo -= pad; hi += pad
      // Enough digits that the two ends of the axis never read the same, and no more.
      const span = hi - lo
      const digits = Math.min(5, Math.max(2, Math.ceil(-Math.log10(span)) + 1))
      const tick = (v) => (Math.abs(v) >= 1000 || span >= 10 ? fmt(v) : v.toFixed(digits))
      return { lo, hi, labels: [tick(hi), tick(lo)] }
    })
    const left = Math.max(34, Math.ceil(Math.max(...ranges.flatMap((r) => r.labels.map((l) => ctx.measureText(l).width)))) + 9)
    const x = (t) => left + ((t - t0) / Math.max(1e-6, t1 - t0)) * (width - left - right)

    const nearest = (t) => {
      let index = -1, best = Infinity
      for (let i = 0; i < this.samples.length; i++) { const d = Math.abs(this.samples[i][0] - t); if (d < best) { best = d; index = i } }
      return index
    }
    let hoverIndex = -1
    if (this.hoverX !== null && this.hoverX >= left) hoverIndex = nearest(t0 + ((this.hoverX - left) / (width - left - right)) * (t1 - t0))
    const cursorIndex = this.static && this.cursor !== null ? nearest(this.cursor) : -1

    charts.forEach((indices, c) => {
      const top = c * (chartH + gap) + 2
      const { lo, hi, labels } = ranges[c]
      const y = (v) => top + chartH - ((v - lo) / (hi - lo)) * chartH

      ctx.strokeStyle = ink.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const f of [0, 0.5, 1]) { const yy = Math.round(top + chartH * f) + 0.5; ctx.moveTo(left, yy); ctx.lineTo(width - right, yy) }
      ctx.stroke()
      ctx.fillStyle = ink.faint
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(labels[0], left - 5, top + 4)
      ctx.fillText(labels[1], left - 5, top + chartH - 4)
      if (s.stacked) {
        ctx.textAlign = 'left'
        ctx.fillStyle = ink.text
        ctx.fillText(`${s.series[indices[0]].name}${s.series[indices[0]].unit ? ` (${s.series[indices[0]].unit})` : ''}`, left + 4, top + 8)
      }

      indices.forEach((i, k) => {
        ctx.strokeStyle = colors[(s.stacked ? i : k) % colors.length]
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.beginPath()
        let pen = false
        for (const row of this.samples) {
          const v = row[i + 1]
          if (!Number.isFinite(v)) { pen = false; continue }
          const px = x(row[0]), py = y(v)
          if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true }
        }
        ctx.stroke()
      })

      if (cursorIndex >= 0 && this.cursor !== null) {
        const cx = Math.round(x(this.cursor)) + 0.5
        ctx.strokeStyle = colors[0]
        ctx.globalAlpha = 0.55
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + chartH); ctx.stroke()
        ctx.globalAlpha = 1
      }

      const marker = hoverIndex >= 0 ? hoverIndex : cursorIndex
      if (marker >= 0) {
        const row = this.samples[marker]
        const hx = Math.round(x(row[0])) + 0.5
        ctx.strokeStyle = ink.faint
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(hx, top); ctx.lineTo(hx, top + chartH); ctx.stroke()
        indices.forEach((i, k) => {
          const v = row[i + 1]
          if (!Number.isFinite(v)) return
          ctx.beginPath()
          ctx.arc(hx, y(v), 4, 0, Math.PI * 2)
          ctx.fillStyle = colors[(s.stacked ? i : k) % colors.length]
          ctx.fill()
          ctx.lineWidth = 2
          ctx.strokeStyle = ink.surface
          ctx.stroke()
        })
      }
    })
    ctx.fillStyle = ink.faint
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`${fmt(t0)} s`, left, height - 1)
    ctx.textAlign = 'right'
    ctx.fillText(`${fmt(t1)} s`, width - right, height - 1)

    const shownIndex = hoverIndex >= 0 ? hoverIndex : cursorIndex >= 0 ? cursorIndex : this.samples.length - 1
    this.renderReadout(s, this.samples[shownIndex], colors, hoverIndex >= 0 || cursorIndex >= 0)
  }

  renderReadout(s, row, colors, hovering) {
    const parts = s.series.map((series, i) => {
      const span = document.createElement('span')
      if (s.series.length > 1) {
        const key = document.createElement('i')
        key.style.cssText = `display:inline-block;width:10px;height:2px;border-radius:1px;vertical-align:3px;margin-right:4px;background:${colors[i % colors.length]}`
        span.append(key)
      }
      const value = document.createElement('b')
      value.style.fontWeight = '600'
      value.textContent = fmt(row[i + 1])
      span.append(value)
      const label = document.createTextNode(` ${s.series.length > 1 ? series.name : ''}${series.unit ? ` ${series.unit}` : ''}`)
      span.append(label)
      return span
    })
    this.readout.replaceChildren()
    if (hovering) this.readout.append(document.createTextNode(`${fmt(row[0])} s  `))
    parts.forEach((p, i) => { if (i) this.readout.append(document.createTextNode('  ')); this.readout.append(p) })
  }
}

export function fmt(v) {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(0)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  if (a >= 0.01 || a === 0) return v.toFixed(3)
  return v.toExponential(1)
}
