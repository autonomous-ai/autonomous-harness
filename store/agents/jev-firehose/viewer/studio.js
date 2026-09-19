// studio.js — the Jev Firehose pane. The server streams compact decisions ten times a second; this
// file turns them into a 60 fps scene: tiles spray from the nozzle, cross the Jev gate at the height
// of Jev's confidence, then arc into team bins (or drop into the amber escalate lane).
// No frameworks, no network calls except to the viewer's own server. Objects are pooled.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const easeOutQuad = (t) => 1 - (1 - t) * (1 - t)
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  const fmtInt = (v) => Math.round(v).toLocaleString('en-US')
  const fmtMoney = (v) => '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2))
  const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%')
  const fmtSecs = (ms) => (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') + 's')
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s }

  // ------------------------------------------------------------------------------------------
  // State (everything declared up front)
  // ------------------------------------------------------------------------------------------
  const scene = $('scene'), wrap = $('wrap'), ctx = scene.getContext('2d')
  const binLayer = document.createElement('canvas'), bctx = binLayer.getContext('2d')
  const fxLayer = document.createElement('canvas'), fctx = fxLayer.getContext('2d')
  const bgLayer = document.createElement('canvas'), gctx = bgLayer.getContext('2d')
  const flushLayer = document.createElement('canvas'), flctx = flushLayer.getContext('2d')
  let W = 800, H = 500, dpr = 1
  const L = { gateX: 0, gateTop: 0, gateBot: 0, nx: 0, ny: 0, top: 0, bottom: 0, lane: { x: 0, y: 0, w: 0, h: 0 } }
  let geo = []                      // per bucket: row rect, tile area, tile size, capacity

  let teams = [], nT = 0, SPAMB = 0, ESCB = 1
  let colors = [], rgbs = [], glows = []
  const AMBER = '#fbbf24', WRONG = '#ff4d5e', SPAMC = '#94a3b8', CYAN = '#22d3ee'
  let amberGlow = null, cyanGlow = null, whiteGlow = null, redGlow = null
  let config = { batch: 2000, llmSecondsPerItem: 2, targetAccuracy: 0.95, concurrency: 8, ratePerSec: 40 }
  let live = { running: true, phase: 'run', elapsedMs: 0, costUsd: 0, mps: 0, batchNo: 1, burstLeft: 0, overrides: {} }
  let liveAt = performance.now()
  let rev = -1, thr = 0.55, thrQ = 550, noise = 0.2
  let urgencyLegend = [], moodLegend = []
  let own = false, sourceInfo = null, qSum = 0   // own = the person's own messages: no ground truth, so nothing is right or wrong

  let n = 0, capN = 0
  let T = new Uint8Array(0), C = new Uint8Array(0), Q = new Uint16Array(0), S = new Uint8Array(0), D = new Uint8Array(0), M = new Uint8Array(0), U = new Uint8Array(0)
  let where = new Int16Array(0)     // bucket an item has landed in, or -1
  let binList = [], binRight = [], pending = []
  let counts = [], rights = [], confusion = []
  const RECENT = 500, recentQ = new Uint16Array(RECENT); let recentN = 0
  const confHist = new Uint16Array(40)

  const queue = []; let qHead = 0, emitAcc = 0, activity = 0, flightSeq = 0
  const MAX_FLY = 900, fly = [], freeFly = []
  const MAX_P = 520, P = { x: new Float32Array(MAX_P), y: new Float32Array(MAX_P), vx: new Float32Array(MAX_P), vy: new Float32Array(MAX_P), life: new Float32Array(MAX_P), max: new Float32Array(MAX_P), col: new Int16Array(MAX_P) }
  let pCount = 0
  const flashes = [], rings = [], labels = []
  let lastLabelAt = 0, binFlash = []
  let flushT = -1
  let sel = null, follow = true, hoverB = -1, dragThr = false, holdServerUntil = 0
  let lastFrame = performance.now(), domAt = 0, matrixDirty = true, sweepDirty = true, matrixAt = 0, sweepAt = 0
  const shown = { done: 0, cost: 0, acc: null, escPct: 0, mps: 0 }
  let summaryShownFor = -1
  let mxCells = null

  // ------------------------------------------------------------------------------------------
  // Colours and sprites
  // ------------------------------------------------------------------------------------------
  const CURATED = ['#38bdf8', '#f472b6', '#a3e635', '#a78bfa', '#2dd4bf', '#e879f9', '#4ade80', '#818cf8']
  function hslToHex(h, s, l) {
    s /= 100; l /= 100
    const k = (x) => (x + h / 30) % 12, a = s * Math.min(l, 1 - l)
    const f = (x) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)))))
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')
  }
  function palette(count) {
    if (count <= CURATED.length) return CURATED.slice(0, count)
    const out = []
    for (let i = 0; i < count; i++) out.push(hslToHex(78 + (i * 262) / count, 86, i % 2 ? 72 : 60))   // 78..340: skips red and amber
    return out
  }
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
  function makeGlow(rgb) {
    const c = document.createElement('canvas'); c.width = c.height = 48
    const g = c.getContext('2d'), gr = g.createRadialGradient(24, 24, 0, 24, 24, 24)
    gr.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.95)`); gr.addColorStop(0.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.42)`); gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
    g.fillStyle = gr; g.fillRect(0, 0, 48, 48)
    return c
  }
  function buildPalette() {
    colors = palette(nT).concat([SPAMC]); rgbs = colors.map(hexRgb); glows = rgbs.map(makeGlow)
    amberGlow = makeGlow(hexRgb(AMBER)); cyanGlow = makeGlow(hexRgb(CYAN)); whiteGlow = makeGlow([255, 255, 255]); redGlow = makeGlow(hexRgb(WRONG))
  }

  // ------------------------------------------------------------------------------------------
  // Items and buckets
  // ------------------------------------------------------------------------------------------
  const runSize = () => live.batch || config.batch || 2000   // your-data mode: the size of the file, not the batch setting
  const bucketOf = (i) => (S[i] >= 128 ? SPAMB : Q[i] < thrQ ? ESCB : C[i])
  const isWrong = (i, b) => !own && b !== ESCB && b !== T[i]
  function grow(need) {
    if (need <= capN) return
    const c = Math.max(need, capN * 2, 4096), g = (A, old) => { const a = new A(c); a.set(old); return a }
    T = g(Uint8Array, T); C = g(Uint8Array, C); Q = g(Uint16Array, Q); S = g(Uint8Array, S); D = g(Uint8Array, D); M = g(Uint8Array, M); U = g(Uint8Array, U)
    const w = new Int16Array(c).fill(-1); w.set(where); where = w
    capN = c
  }
  function addStat(i) { const b = bucketOf(i); counts[b]++; if (b === T[i]) rights[b]++; confusion[T[i]][b]++ }
  function recount() {
    counts = new Array(nT + 2).fill(0); rights = new Array(nT + 2).fill(0); confusion = Array.from({ length: nT + 1 }, () => new Array(nT + 2).fill(0))
    for (let i = 0; i < n; i++) addStat(i)
    matrixDirty = true; sweepDirty = true
  }
  function totals() {
    const escN = counts[ESCB] || 0, routed = n - escN
    let right = 0
    for (let b = 0; b <= nT; b++) right += rights[b] || 0
    let rN = 0, rOk = 0, rEsc = 0
    for (let i = Math.max(0, n - 300); i < n; i++) { const b = bucketOf(i); rN++; if (b === ESCB) rEsc++; else if (b === T[i]) rOk++ }
    return { escN, routed, right, acc: routed ? right / routed : null, escPct: n ? escN / n : 0, recent: rN - rEsc ? rOk / (rN - rEsc) : null }
  }
  function recv(i, it, animate) {
    grow(i + 1)
    T[i] = it[0]; C[i] = it[1]; Q[i] = it[2]; S[i] = it[3]; D[i] = it[4]; M[i] = it[5]; U[i] = it[6]; where[i] = -1
    n = i + 1; qSum += it[2]
    addStat(i)
    const hb = Math.min(39, Math.floor(Q[i] / 25))
    if (recentN >= RECENT) { const old = Math.min(39, Math.floor(recentQ[recentN % RECENT] / 25)); if (confHist[old]) confHist[old]-- }
    recentQ[recentN % RECENT] = Q[i]; recentN++; confHist[hb]++
    matrixDirty = true; sweepDirty = true
    if (animate) queue.push(i); else land(i, bucketOf(i), false)
  }
  function land(i, b, draw) {
    if (!binList[b]) return
    ensureRoom(b, 1)
    const slot = binList[b].length
    binList[b].push(i); where[i] = b
    if (b !== ESCB && b === T[i]) binRight[b]++
    if (draw) drawTile(bctx, b, slot, i)
  }

  function resetWorld(s) {
    teams = s.teams || []; nT = teams.length; SPAMB = nT; ESCB = nT + 1
    buildPalette()
    n = 0; qSum = 0; queue.length = 0; qHead = 0; emitAcc = 0
    while (fly.length) freeFly.push(fly.pop())
    pCount = 0; flashes.length = 0; rings.length = 0; labels.length = 0
    recentN = 0; confHist.fill(0)
    binList = Array.from({ length: nT + 2 }, () => []); binRight = new Array(nT + 2).fill(0); pending = new Array(nT + 2).fill(0); binFlash = new Array(nT + 2).fill(0)
    where.fill(-1)
    recount()
    sel = null; follow = true; hoverB = -1
  }

  // ------------------------------------------------------------------------------------------
  // Layout: nozzle left, gate, team rows on the right, amber lane along the bottom
  // ------------------------------------------------------------------------------------------
  function fitGeo(g, need, maxSize = 11) {
    need = Math.max(1, Math.ceil(need))
    for (const s of [11, 9, 8, 7, 6, 5, 4, 3, 2]) {
      if (s > maxSize && s > 2) continue
      const pitch = s + 1, rows = Math.max(1, Math.floor((g.ah + 1) / pitch)), cols = Math.max(1, Math.floor((g.aw + 1) / pitch))
      if (rows * cols >= need || s === 2) { g.size = s; g.pitch = pitch; g.rows = rows; g.cols = cols; g.unit = Math.max(1, Math.ceil(need / (rows * cols))); g.capacity = rows * cols * g.unit; return }
    }
  }
  function layout() {
    const r = wrap.getBoundingClientRect()
    W = Math.max(320, Math.round(r.width)); H = Math.max(220, Math.round(r.height)); dpr = Math.min(2, window.devicePixelRatio || 1)
    for (const c of [scene, binLayer, fxLayer, bgLayer, flushLayer]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
    for (const c of [ctx, bctx, fctx, gctx, flctx]) c.setTransform(dpr, 0, 0, dpr, 0, 0)
    const pad = 12, laneH = clamp(H * 0.14, 48, 74)
    L.lane = { x: pad, y: H - pad - laneH, w: W - 2 * pad, h: laneH }
    L.top = 30; L.bottom = L.lane.y - 12
    L.gateX = Math.round(W * 0.29); L.gateTop = L.top + 24; L.gateBot = L.bottom - 6
    L.nx = Math.round(clamp(W * 0.095, 70, 112)); L.ny = Math.round((L.gateTop + L.gateBot) / 2)
    const nB = nT + 1, gap = nB > 14 ? 2 : nB > 10 ? 3 : 5, x0 = Math.round(W * 0.475)
    const rowH = (L.bottom - L.top - gap * (nB - 1)) / nB, labelW = Math.round(clamp(W * 0.11, 76, 122))
    geo = []
    for (let b = 0; b < nB; b++) {
      const y = L.top + b * (rowH + gap), g = { x: x0, y, w: W - pad - x0, h: rowH, labelW }
      g.ax = x0 + labelW; g.ay = y + 3; g.aw = g.w - labelW - 5; g.ah = rowH - 6
      geo.push(g)
    }
    const lw = Math.round(clamp(W * 0.17, 128, 176)), lg = { x: L.lane.x, y: L.lane.y, w: L.lane.w, h: laneH, labelW: lw }
    lg.ax = L.lane.x + lw; lg.ay = L.lane.y + 5; lg.aw = L.lane.w - lw - 6; lg.ah = laneH - 10
    geo.push(lg)
    fitBins(0); fitGeo(geo[ESCB], Math.max((binList[ESCB]?.length || 0) * 1.3, runSize() * 0.15), geo[0].size)
    drawBackground(); redrawBins(); retarget()
    fctx.clearRect(0, 0, W, H)
  }
  /** Every team bin shares one tile size, so the filled lengths compare like a bar chart. */
  function fitBins(extra) {
    let need = (runSize() / Math.max(1, nT + 1)) * 1.5
    for (let b = 0; b <= nT; b++) need = Math.max(need, ((binList[b]?.length || 0) + (pending[b] || 0) + extra) * 1.5)
    let tight = geo[0]
    for (let b = 0; b <= nT; b++) if (geo[b].aw * geo[b].ah < tight.aw * tight.ah) tight = geo[b]
    fitGeo(tight, need)
    for (let b = 0; b <= nT; b++) { const g = geo[b]; g.size = tight.size; g.pitch = tight.pitch; g.unit = tight.unit; g.rows = Math.max(1, Math.floor((g.ah + 1) / g.pitch)); g.cols = Math.max(1, Math.floor((g.aw + 1) / g.pitch)); g.capacity = g.rows * g.cols * g.unit }
  }
  function ensureRoom(b, extra) {
    const g = geo[b]; if (!g) return
    const need = binList[b].length + pending[b] + extra
    if (need <= g.capacity) return
    if (b === ESCB) { fitGeo(g, need * 1.6, geo[0].size); redrawBin(b) } else { fitBins(extra); fitGeo(geo[ESCB], Math.max(geo[ESCB].capacity, 1), geo[0].size); redrawBins() }
    retarget()
  }
  const pos = { x: 0, y: 0 }
  function slotPos(b, slot) {
    const g = geo[b], k = Math.floor(slot / g.unit), col = Math.floor(k / g.rows), row = k % g.rows
    pos.x = g.ax + col * g.pitch + g.size / 2; pos.y = g.ay + g.ah - row * g.pitch - g.size / 2
    return pos
  }
  function drawTile(c, b, slot, i) {
    const g = geo[b]; if (!g || slot % g.unit) return
    const p = slotPos(b, slot), s = g.size, x = Math.round(p.x - s / 2), y = Math.round(p.y - s / 2)
    const wrong = isWrong(i, b)
    if (wrong && s <= 3) { c.fillStyle = WRONG; c.fillRect(x, y, s, s); return }
    c.fillStyle = colors[T[i]]; c.globalAlpha = b === ESCB ? 0.82 : 1; c.fillRect(x, y, s, s); c.globalAlpha = 1
    if (wrong) { c.strokeStyle = WRONG; c.lineWidth = 1.5; c.strokeRect(x - 0.25, y - 0.25, s + 0.5, s + 0.5) }
  }
  function redrawBin(b) {
    const g = geo[b]; if (!g) return
    bctx.clearRect(g.ax - 3, g.ay - 3, g.aw + 6, g.ah + 6)
    const list = binList[b] || []
    for (let k = 0; k < list.length; k += g.unit) drawTile(bctx, b, k, list[k])
  }
  function redrawBins() { bctx.clearRect(0, 0, W, H); for (let b = 0; b < geo.length; b++) redrawBin(b) }

  /** The threshold moved: move every landed tile that changed bucket, with a capped animation. */
  function rebucket() {
    const old = binList, movers = []
    binList = Array.from({ length: nT + 2 }, () => []); binRight = new Array(nT + 2).fill(0)
    for (let b = 0; b < old.length; b++) for (let k = 0; k < old[b].length; k++) {
      const i = old[b][k], nb = bucketOf(i)
      if (nb === b) { binList[b].push(i); if (b !== ESCB && b === T[i]) binRight[b]++ } else { const p = slotPos(b, k); movers.push(i, b, nb, p.x, p.y) }
    }
    const total = movers.length / 5, room = Math.max(0, Math.min(260, MAX_FLY - fly.length)), keep = total ? room / total : 0
    const later = []
    for (let m = 0; m < movers.length; m += 5) {
      const i = movers[m], nb = movers[m + 2]
      if (Math.random() < keep && freeFlyAvailable()) later.push(m); else { binList[nb].push(i); where[i] = nb; if (nb !== ESCB && nb === T[i]) binRight[nb]++ }
    }
    if (geo[ESCB] && binList[ESCB].length > geo[ESCB].capacity) fitGeo(geo[ESCB], binList[ESCB].length * 1.5, geo[0].size)
    for (let b = 0; b <= nT; b++) if (geo[b] && binList[b].length > geo[b].capacity) { fitBins(0); break }
    for (const m of later) {
      const i = movers[m], f = takeFlight(i)
      where[i] = -1
      f.phase = 2; f.t = -Math.random() * 0.25; f.d = 0.62; f.sx = movers[m + 3]; f.sy = movers[m + 4]; f.x = f.sx; f.y = f.sy
      f.bucket = movers[m + 2]; f.style = 2; f.wrong = isWrong(i, f.bucket); pending[f.bucket]++
    }
    for (const f of fly) if (f.phase === 2 && f.style !== 2) { const nb = bucketOf(f.id); if (nb !== f.bucket) { pending[f.bucket]--; f.bucket = nb; pending[nb]++; f.sx = f.x; f.sy = f.y; f.t = 0; f.d = 0.6; f.style = 2; f.fresh = true; f.wrong = isWrong(f.id, nb) } }
    redrawBins(); retarget(true)
    recount()
  }

  // ------------------------------------------------------------------------------------------
  // Flights, particles and small effects (all pooled)
  // ------------------------------------------------------------------------------------------
  const freeFlyAvailable = () => fly.length < MAX_FLY
  function takeFlight(id) {
    const f = freeFly.pop() || {}
    f.id = id; f.seq = flightSeq++; f.phase = 1; f.t = 0; f.d = 0.5; f.style = 0; f.wrong = false; f.bucket = -1
    f.sx = 0; f.sy = 0; f.cx = 0; f.cy = 0; f.gx = 0; f.gy = 0; f.ex = 0; f.ey = 0; f.tx = 0; f.ty = 0; f.x = 0; f.y = 0; f.fresh = true
    fly.push(f)
    return f
  }
  const GATE_POW = 0.6   // the gate's scale is curved (ticks are labelled) so the busy high-confidence end gets room
  const confY = (q) => L.gateTop + 10 + Math.pow(1 - clamp(q / 1000, 0, 1), GATE_POW) * (L.gateBot - L.gateTop - 14)
  const yToConf = (y) => 1 - Math.pow(clamp((y - L.gateTop - 10) / (L.gateBot - L.gateTop - 14), 0, 1), 1 / GATE_POW)
  function emit(i) {
    if (!freeFlyAvailable()) { land(i, bucketOf(i), true); return }
    const f = takeFlight(i)
    f.sx = L.nx + 2; f.sy = L.ny + (Math.random() - 0.5) * 7
    f.gx = L.gateX; f.gy = confY(Q[i])
    f.cx = f.sx + (f.gx - f.sx) * (0.38 + Math.random() * 0.3); f.cy = f.sy + (f.gy - f.sy) * 0.15 + (Math.random() - 0.5) * Math.min(120, (L.gateBot - L.gateTop) * 0.3)
    f.x = f.sx; f.y = f.sy; f.d = 0.46 + Math.random() * 0.06
  }
  /** Give every phase-2 flight its landing slot again, in launch order. */
  function retarget(snapNew) {
    pending.fill(0)
    const order = fly.filter((f) => f.phase === 2).sort((a, b) => a.seq - b.seq)
    for (const f of order) {
      const g = geo[f.bucket]; if (!g) continue
      const p = slotPos(f.bucket, binList[f.bucket].length + pending[f.bucket]); pending[f.bucket]++
      f.tx = p.x; f.ty = p.y
      if (f.fresh || snapNew === 'all') { f.ex = f.tx; f.ey = f.ty; f.fresh = false }
    }
  }
  function crossGate(f, now) {
    const i = f.id, b = bucketOf(i)
    ensureRoom(b, 1)
    f.phase = 2; f.t = 0; f.bucket = b; f.style = b === ESCB ? 1 : 0; f.d = b === ESCB ? 0.78 : 0.82
    f.sx = L.gateX; f.sy = f.gy; f.x = f.sx; f.y = f.sy
    f.wrong = isWrong(i, b)
    const p = slotPos(b, binList[b].length + pending[b]); pending[b]++
    f.tx = f.ex = p.x; f.ty = f.ey = p.y; f.fresh = false
    if (flashes.length < 90) flashes.push({ y: f.gy, b, life: 1 })
    spark(f.sx, f.sy, b === ESCB ? -2 : T[i], 3, 90, 0.1)
    const ly = clamp(f.gy, L.gateTop + 12, L.gateBot - 8)
    if (now - lastLabelAt > 260 && labels.length < 7 && !labels.some((l) => Math.abs(l.y - ly) < 15)) {
      lastLabelAt = now
      labels.push({ x: L.gateX + 14, y: ly, life: 1, color: b === ESCB ? AMBER : b === SPAMB ? SPAMC : colors[b], text: (b === ESCB ? 'escalate' : b === SPAMB ? 'spam' : teams[b].id) + ' ' + (Q[i] / 1000).toFixed(2).replace(/^0/, '') })
    }
  }
  function spark(x, y, col, count, speed, up) {
    for (let k = 0; k < count && pCount < MAX_P; k++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.35 + Math.random() * 0.65), j = pCount++
      P.x[j] = x; P.y[j] = y; P.vx[j] = Math.cos(a) * v; P.vy[j] = Math.sin(a) * v - speed * up; P.max[j] = P.life[j] = 0.25 + Math.random() * 0.35; P.col[j] = col
    }
  }
  function bez(t, a, b, c, d) { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d }

  function update(dt, now) {
    // Emission: drain the queue smoothly, faster when it is long (a burst), never a single dump.
    const waiting = queue.length - qHead
    if (waiting > 1400) { while (queue.length - qHead > 900) { const i = queue[qHead++]; land(i, bucketOf(i), true) } }
    if (waiting > 0) {
      emitAcc += dt * Math.max(24, waiting / 0.32)
      let k = Math.min(waiting, Math.floor(emitAcc)); emitAcc -= k
      activity = Math.min(1, activity + k * 0.02)
      while (k-- > 0) emit(queue[qHead++])
      if (qHead > 4096) { queue.splice(0, qHead); qHead = 0 }
    } else emitAcc = 0
    activity = Math.max(0, activity - dt * 0.9)

    for (let k = fly.length - 1; k >= 0; k--) {
      const f = fly[k]
      f.t += dt / f.d
      if (f.phase === 1) {
        if (f.t >= 1) { crossGate(f, now); continue }
        const e = easeOutQuad(f.t) * 0.55 + f.t * 0.45, u = 1 - e
        f.x = u * u * f.sx + 2 * u * e * f.cx + e * e * f.gx; f.y = u * u * f.sy + 2 * u * e * f.cy + e * e * f.gy
      } else {
        if (f.t < 0) continue
        if (f.t >= 1) {
          pending[f.bucket] = Math.max(0, pending[f.bucket] - 1)
          land(f.id, f.bucket, true)
          binFlash[f.bucket] = 1
          spark(f.tx, f.ty, f.bucket === ESCB ? -2 : T[f.id], 2, 46, 0.4)
          if (f.wrong && rings.length < 70) rings.push({ x: f.tx, y: f.ty, life: 1 })
          fly[k] = fly[fly.length - 1]; fly.pop(); freeFly.push(f)
          continue
        }
        const sm = Math.min(1, dt * 12); f.ex += (f.tx - f.ex) * sm; f.ey += (f.ty - f.ey) * sm
        const e = easeInOut(f.t), dx = f.ex - f.sx, dy = f.ey - f.sy
        if (f.style === 0) { f.x = bez(e, f.sx, f.sx + dx * 0.5, f.ex - dx * 0.42, f.ex); f.y = bez(e, f.sy, f.sy, f.ey, f.ey) }
        else if (f.style === 1) { f.x = bez(e, f.sx, f.sx + 34, f.ex, f.ex); f.y = bez(e, f.sy, f.sy + dy * 0.2, f.ey - Math.min(130, dy * 0.7), f.ey) }
        else { const lift = Math.min(90, 30 + Math.abs(dx) * 0.2); f.x = bez(e, f.sx, f.sx + dx * 0.25, f.ex - dx * 0.25, f.ex); f.y = bez(e, f.sy, Math.min(f.sy, f.ey) - lift, Math.min(f.sy, f.ey) - lift, f.ey) }
      }
    }
    for (let j = pCount - 1; j >= 0; j--) {
      P.life[j] -= dt
      if (P.life[j] <= 0) { const l = --pCount; P.x[j] = P.x[l]; P.y[j] = P.y[l]; P.vx[j] = P.vx[l]; P.vy[j] = P.vy[l]; P.life[j] = P.life[l]; P.max[j] = P.max[l]; P.col[j] = P.col[l]; continue }
      P.vy[j] += 160 * dt; P.x[j] += P.vx[j] * dt; P.y[j] += P.vy[j] * dt
    }
    for (let k = flashes.length - 1; k >= 0; k--) { flashes[k].life -= dt * 3.2; if (flashes[k].life <= 0) flashes.splice(k, 1) }
    for (let k = rings.length - 1; k >= 0; k--) { rings[k].life -= dt * 1.7; if (rings[k].life <= 0) rings.splice(k, 1) }
    for (let k = labels.length - 1; k >= 0; k--) { labels[k].life -= dt * 1.05; labels[k].x += dt * 30; if (labels[k].life <= 0) labels.splice(k, 1) }
    for (let b = 0; b < binFlash.length; b++) binFlash[b] = Math.max(0, binFlash[b] - dt * 3)
    if (flushT >= 0) { flushT += dt / 0.7; if (flushT >= 1) flushT = -1 }
  }

  // ------------------------------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------------------------------
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r) }
  function drawBackground() {
    const c = gctx
    c.clearRect(0, 0, W, H)
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#060912'); g.addColorStop(1, '#03050a')
    c.fillStyle = g; c.fillRect(0, 0, W, H)
    const rg = c.createRadialGradient(L.gateX, L.ny, 10, L.gateX, L.ny, Math.max(W * 0.5, 300))
    rg.addColorStop(0, 'rgba(34,211,238,.10)'); rg.addColorStop(1, 'rgba(34,211,238,0)')
    c.fillStyle = rg; c.fillRect(0, 0, W, H)
    c.fillStyle = 'rgba(148,163,184,.10)'
    for (let y = 18; y < H; y += 22) for (let x = 14; x < W; x += 22) c.fillRect(x, y, 1, 1)
    // the spray cone, nozzle to gate
    const cone = c.createLinearGradient(L.nx, 0, L.gateX, 0); cone.addColorStop(0, 'rgba(34,211,238,.10)'); cone.addColorStop(1, 'rgba(34,211,238,.015)')
    c.fillStyle = cone; c.beginPath(); c.moveTo(L.nx, L.ny - 5); c.lineTo(L.gateX, L.gateTop); c.lineTo(L.gateX, L.gateBot); c.lineTo(L.nx, L.ny + 5); c.closePath(); c.fill()
  }

  function fitText(c, text, maxW) {
    if (c.measureText(text).width <= maxW) return text
    let t = text
    while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1)
    return t + '…'
  }

  function drawBinsChrome(now) {
    for (let b = 0; b <= nT; b++) {
      const g = geo[b]; if (!g) continue
      const col = colors[b], isSel = sel && sel.kind === 'bin' && sel.b === b, hot = hoverB === b || isSel
      roundRect(ctx, g.x, g.y, g.w, g.h, Math.min(8, g.h / 3))
      ctx.fillStyle = hot ? 'rgba(255,255,255,.055)' : 'rgba(255,255,255,.022)'; ctx.fill()
      ctx.globalAlpha = Math.min(1, (isSel ? 0.95 : hot ? 0.6 : 0.2) + binFlash[b] * 0.5); ctx.strokeStyle = col; ctx.lineWidth = isSel ? 1.6 : 1; ctx.stroke(); ctx.globalAlpha = 1
      ctx.fillStyle = col; ctx.fillRect(g.x + 1, g.y + Math.min(6, g.h * 0.2), 3, g.h - 2 * Math.min(6, g.h * 0.2))
      const name = b === SPAMB ? 'spam' : teams[b].id, cnt = binList[b].length, two = g.h >= 30
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
      ctx.font = `700 ${g.h < 20 ? 10 : 12}px ui-monospace, Menlo, monospace`; ctx.fillStyle = col
      ctx.fillText(fitText(ctx, name, g.labelW - (two ? 14 : 48)), g.x + 10, two ? g.y + g.h / 2 - 7 : g.y + g.h / 2 + 0.5)
      ctx.font = `${g.h < 20 ? 9 : 10.5}px ui-monospace, Menlo, monospace`; ctx.fillStyle = 'rgba(203,213,225,.72)'
      const landedAll = Math.max(1, n - (queue.length - qHead) - fly.length)
      const prec = !cnt ? '' : own ? fmtPct(cnt / landedAll, 0) : Math.round((binRight[b] / cnt) * 100) + '%'
      if (two) ctx.fillText(fmtInt(cnt) + (prec ? ' · ' + prec : ''), g.x + 10, g.y + g.h / 2 + 8)
      else { ctx.textAlign = 'right'; ctx.fillText(fmtInt(cnt), g.x + g.labelW - 6, g.y + g.h / 2 + 0.5); ctx.textAlign = 'left' }
    }
    // the escalate lane
    const g = geo[ESCB]; if (!g) return
    const isSel = sel && sel.kind === 'bin' && sel.b === ESCB, hot = hoverB === ESCB || isSel
    roundRect(ctx, g.x, g.y, g.w, g.h, 9)
    const lg = ctx.createLinearGradient(g.x, 0, g.x + g.w, 0); lg.addColorStop(0, 'rgba(251,191,36,.10)'); lg.addColorStop(1, 'rgba(251,191,36,.025)')
    ctx.fillStyle = lg; ctx.fill()
    ctx.setLineDash([5, 4]); ctx.globalAlpha = Math.min(1, (hot ? 0.9 : 0.45) + binFlash[ESCB] * 0.5); ctx.strokeStyle = AMBER; ctx.lineWidth = isSel ? 1.6 : 1; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    ctx.font = '700 11px ui-monospace, Menlo, monospace'; ctx.fillStyle = AMBER
    ctx.fillText('ESCALATE', g.x + 12, g.y + g.h / 2 - 14)
    ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(251,191,36,.7)'
    ctx.fillText('to a big model', g.x + 12, g.y + g.h / 2)
    ctx.fillStyle = 'rgba(203,213,225,.78)'
    const landed = binList[ESCB].length, all = Math.max(1, n - (queue.length - qHead) - fly.length)
    ctx.fillText(fmtInt(landed) + ' · ' + fmtPct(landed / all), g.x + 12, g.y + g.h / 2 + 14)
  }

  function drawGate(now) {
    const x = L.gateX, top = L.gateTop, bot = L.gateBot, yT = clamp(confY(thrQ), top, bot)
    const pulse = 0.22 + activity * 0.3 + Math.sin(now / 420) * 0.04
    ctx.globalCompositeOperation = 'lighter'
    // wide glow: cyan above the threshold, amber below
    for (const [y0, y1, rgb] of [[top, yT, '34,211,238'], [yT, bot, '251,191,36']]) {
      if (y1 - y0 < 1) continue
      const g = ctx.createLinearGradient(x - 40, 0, x + 40, 0)
      g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(0.5, `rgba(${rgb},${pulse})`); g.addColorStop(1, `rgba(${rgb},0)`)
      ctx.fillStyle = g; ctx.fillRect(x - 40, y0, 80, y1 - y0)
    }
    // confidence spectrum of the last few hundred messages, hugging the gate
    let mx = 1
    for (let k = 0; k < 40; k++) if (confHist[k] > mx) mx = confHist[k]
    const maxLen = Math.min(70, W * 0.07)
    for (let k = 0; k < 40; k++) {
      if (!confHist[k]) continue
      const y0 = confY((k + 1) * 25), y1 = confY(k * 25), len = (confHist[k] / mx) * maxLen
      ctx.fillStyle = (k + 0.5) * 25 < thrQ ? 'rgba(251,191,36,.30)' : 'rgba(34,211,238,.28)'
      ctx.fillRect(x + 4, y0 + 0.5, len, Math.max(1, y1 - y0 - 1))
    }
    for (const f of flashes) {
      const sprite = f.b === ESCB ? amberGlow : glows[f.b] || cyanGlow
      ctx.globalAlpha = f.life * 0.55; ctx.drawImage(sprite, x - 46, f.y - 6, 92, 12)
      ctx.globalAlpha = f.life * 0.22; ctx.drawImage(whiteGlow, x - 8, f.y - 8, 16, 16)
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'rgba(165,243,252,.95)'; ctx.fillRect(x - 1, top, 2, Math.max(0, yT - top))
    ctx.fillStyle = 'rgba(253,230,138,.95)'; ctx.fillRect(x - 1, yT, 2, Math.max(0, bot - yT))
    // axis ticks
    ctx.font = '9px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (const v of [1, 0.9, 0.75, 0.5, 0.25, 0]) {
      const y = confY(v * 1000); ctx.fillStyle = 'rgba(148,163,184,.55)'; ctx.fillRect(x - 7, y - 0.5, 5, 1)
      if (Math.abs(y - yT) > 11) ctx.fillText(v === 1 ? '1.0' : v === 0 ? '0' : String(v).replace(/^0/, ''), x - 10, y)
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
    ctx.font = '700 10.5px ui-monospace, Menlo, monospace'; ctx.fillStyle = CYAN
    ctx.fillText('J E V   G A T E', x, top - 13)
    ctx.font = '9px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(148,163,184,.75)'
    ctx.fillText('height = confidence', x, top - 3)
  }

  /** The draggable threshold handle. Drawn over the flights so it never gets buried. */
  function drawThreshold() {
    const x = L.gateX, yT = clamp(confY(thrQ), L.gateTop, L.gateBot), text = 'threshold ' + thr.toFixed(2)
    ctx.strokeStyle = AMBER; ctx.lineWidth = dragThr ? 2.2 : 1.4; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x - 30, yT); ctx.lineTo(x + 62, yT); ctx.stroke(); ctx.setLineDash([])
    ctx.font = '700 10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    const w = ctx.measureText(text).width + 12
    roundRect(ctx, x - 34 - w, yT - 9, w, 18, 9); ctx.fillStyle = dragThr ? 'rgba(60,40,4,.96)' : 'rgba(20,14,2,.9)'; ctx.fill(); ctx.strokeStyle = AMBER; ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = AMBER; ctx.fillText(text, x - 40, yT + 0.5)
    ctx.beginPath(); ctx.moveTo(x - 25, yT); ctx.lineTo(x - 34, yT - 5); ctx.lineTo(x - 34, yT + 5); ctx.closePath(); ctx.fill()
  }

  function drawNozzle(now) {
    const x = L.nx, y = L.ny + Math.sin(now / 37) * activity * 1.3
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 30; ctx.beginPath(); ctx.moveTo(-16, y + 96); ctx.bezierCurveTo(x * 0.1, y + 92, x * 0.12, y, x - 50, y); ctx.stroke()
    ctx.strokeStyle = '#223047'; ctx.lineWidth = 22; ctx.stroke()
    ctx.strokeStyle = 'rgba(148,163,184,.3)'; ctx.lineWidth = 2; ctx.setLineDash([3, 8]); ctx.lineDashOffset = -now / 28; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0
    const g = ctx.createLinearGradient(0, y - 19, 0, y + 19); g.addColorStop(0, '#0f172a'); g.addColorStop(0.4, '#cbd5e1'); g.addColorStop(0.55, '#64748b'); g.addColorStop(1, '#0f172a')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 54, y - 19); ctx.lineTo(x - 7, y - 9); ctx.lineTo(x - 7, y + 9); ctx.lineTo(x - 54, y + 19); ctx.closePath(); ctx.fill()
    ctx.fillStyle = CYAN; ctx.fillRect(x - 10, y - 11, 6, 22)
    ctx.fillStyle = '#334155'; ctx.fillRect(x - 60, y - 22, 8, 44)
    ctx.fillStyle = 'rgba(34,211,238,.55)'; ctx.fillRect(x - 40, y - 15, 3, 30)
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 + activity * 0.65
    const r = 16 + activity * 16; ctx.drawImage(cyanGlow, x - r + 2, y - r, r * 2, r * 2)
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.font = '700 10.5px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(226,232,240,.9)'
    if (own && live.phase === 'done') return   // the kept summary card sits here
    ctx.fillText('I N B O X', 12, y - 48)
    ctx.font = '9.5px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(148,163,184,.8)'
    ctx.fillText(own && sourceInfo ? fitText(ctx, sourceInfo.name, L.gateX - 70) : 'noise ' + noise.toFixed(2), 12, y - 35)
  }

  function draw(now) {
    // trails: fade the fx layer a little each frame, then add this frame's glow
    fctx.globalCompositeOperation = 'destination-out'; fctx.fillStyle = 'rgba(0,0,0,.2)'; fctx.fillRect(0, 0, W, H)
    fctx.globalCompositeOperation = 'lighter'
    for (const f of fly) {
      if (f.phase === 2 && f.t < 0) continue
      const esc2 = f.phase === 2 && f.bucket === ESCB, r = f.phase === 1 ? 9 : f.style === 2 ? 6 : 8 - f.t * 3
      fctx.globalAlpha = f.phase === 1 ? 0.5 : 0.62
      fctx.drawImage(esc2 ? amberGlow : f.wrong ? redGlow : glows[T[f.id]], f.x - r, f.y - r, r * 2, r * 2)
    }
    for (let j = 0; j < pCount; j++) {
      const a = P.life[j] / P.max[j]; fctx.globalAlpha = a
      fctx.drawImage(P.col[j] === -2 ? amberGlow : glows[P.col[j]] || whiteGlow, P.x[j] - 3, P.y[j] - 3, 6, 6)
    }
    fctx.globalAlpha = 1

    ctx.drawImage(bgLayer, 0, 0, W, H)
    drawBinsChrome(now)
    if (flushT >= 0) { const p = flushT; ctx.globalAlpha = (1 - p) * (1 - p); ctx.drawImage(flushLayer, 0, p * p * 46, W, H); ctx.globalAlpha = 1 }
    ctx.drawImage(binLayer, 0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(fxLayer, 0, 0, W, H); ctx.globalCompositeOperation = 'source-over'
    drawGate(now)
    drawNozzle(now)

    for (const f of fly) {
      const i = f.id, tgt = f.phase === 2 && geo[f.bucket] ? geo[f.bucket].size : 8, tt = Math.max(0, f.t)
      const s = f.phase === 1 ? 8 : f.style === 2 ? Math.max(5, tgt) : 8 + (tgt - 8) * tt * tt, x = f.x - s / 2, y = f.y - s / 2
      ctx.fillStyle = colors[T[i]]; ctx.fillRect(x, y, s, s)
      const nn = M[i] >> 2
      if (nn && D[i] < nT) { const share = nn / (nn + (M[i] & 3)); ctx.fillStyle = colors[D[i]]; ctx.fillRect(x + s * (1 - share), y, s * share, s) }
      if ((U[i] & 7) >= 3) { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(f.x - 1, f.y - 1, 2, 2) }
      if (f.phase === 2 && (f.wrong || f.bucket === ESCB)) { ctx.strokeStyle = f.wrong ? WRONG : AMBER; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(f.x, f.y, s * 0.5 + 3.5, 0, 6.2832); ctx.stroke() }
    }
    drawThreshold()
    for (const r of rings) { ctx.globalAlpha = r.life; ctx.strokeStyle = WRONG; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(r.x, r.y, 4 + (1 - r.life) * 13, 0, 6.2832); ctx.stroke() }
    ctx.globalAlpha = 1
    ctx.font = '700 10.5px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    for (const l of labels) { ctx.globalAlpha = Math.min(1, l.life * 1.6); ctx.fillStyle = 'rgba(4,6,11,.72)'; const w = ctx.measureText(l.text).width; ctx.fillRect(l.x - 3, l.y - 7, w + 6, 14); ctx.fillStyle = l.color; ctx.fillText(l.text, l.x, l.y + 0.5) }
    ctx.globalAlpha = 1
    if (sel && sel.kind === 'item') drawSelection(now)
  }
  function drawSelection(now) {
    const i = sel.id; let x = null, y = null
    const b = where[i]
    if (b >= 0 && binList[b]) { const k = binList[b].indexOf(i); if (k >= 0) { const p = slotPos(b, k); x = p.x; y = p.y } }
    else { const f = fly.find((q) => q.id === i); if (f) { x = f.x; y = f.y } }
    if (x == null) return
    const r = 8 + Math.sin(now / 160) * 1.5
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke()
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7; ctx.drawImage(whiteGlow, x - 16, y - 16, 32, 32); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
  }

  // ------------------------------------------------------------------------------------------
  // DOM: top bar, race, deck, summary
  // ------------------------------------------------------------------------------------------
  function elapsedNow(now) { return live.elapsedMs + (live.running && live.phase === 'run' ? Math.min(400, now - liveAt) : 0) }
  function updateDom(now, dt) {
    const t = totals(), k = Math.min(1, dt * 9)
    shown.done += (n - shown.done) * k; if (Math.abs(n - shown.done) < 0.6) shown.done = n
    shown.cost += (live.costUsd - shown.cost) * k
    shown.mps += (live.mps - shown.mps) * Math.min(1, dt * 5)
    shown.escPct += (t.escPct - shown.escPct) * k
    shown.acc = t.acc == null ? null : shown.acc == null ? t.acc : shown.acc + (t.acc - shown.acc) * k
    if (now - domAt < 66) return
    domAt = now
    const batch = runSize(), el = elapsedNow(now)
    setText($('s-done'), fmtInt(shown.done)); setText($('s-batch'), `of ${fmtInt(batch)}`)
    setText($('synth'), own && sourceInfo ? `your data · ${sourceInfo.name} · ${fmtInt(sourceInfo.used)} messages · only the "${sourceInfo.textColumn}" text goes to Jev` : `all messages are synthetic · made up by a seeded generator · batch ${live.batchNo}`)
    $('synth').classList.toggle('own', own)
    setText($('s-mps'), shown.mps >= 100 ? fmtInt(shown.mps) : shown.mps.toFixed(1)); setText($('s-pool'), `pool of ${config.concurrency} · ${live.client && live.client !== 'mock' ? 'live' : 'mock'}`)
    setText($('s-cost'), fmtMoney(shown.cost)); setText($('s-per1k'), n ? `per 1,000: ${fmtMoney((live.costUsd / n) * 1000)}` : 'per 1,000: —')
    if (own) {
      setText($('l-acc'), 'Auto-routed'); setText($('s-acc'), fmtPct(n ? 1 - shown.escPct : null)); setText($('s-recent'), `mean conf ${n ? (qSum / n / 1000).toFixed(2) : '—'}`)
      $('s-acc').className = 'accent'
    } else {
      setText($('l-acc'), 'Auto-routed right'); setText($('s-acc'), fmtPct(shown.acc)); setText($('s-recent'), `last 300: ${fmtPct(t.recent)}`)
      $('s-acc').className = t.acc != null && t.acc < config.targetAccuracy ? 'bad' : 'ok'
    }
    setText($('s-esc'), fmtPct(shown.escPct)); setText($('s-escn'), `${fmtInt(t.escN)} to a big model`)
    setText($('s-time'), fmtSecs(el)); setText($('s-answers'), `${fmtInt(n * 5)} answers`)
    $('bar-jev').style.width = clamp((shown.done / batch) * 100, 0, 100) + '%'
    const ghostOn = Math.min(batch, Math.floor(el / 1000 / config.llmSecondsPerItem) + 1)
    $('bar-ghost').style.width = clamp((ghostOn / batch) * 100, 0, 100) + '%'
    setText($('race-jev'), `message ${fmtInt(shown.done)} of ${fmtInt(batch)}`)
    setText($('ghost-name'), `${config.llmSecondsPerItem}s/msg model`)
    setText($('race-ghost'), `a model taking ${config.llmSecondsPerItem}s per message would be on message ${fmtInt(ghostOn)}`)
    setText($('pause'), live.running ? 'Pause' : 'Resume'); $('pause').classList.toggle('on', !live.running)
    $('burst').textContent = live.burstLeft > 0 ? `Bursting ${fmtInt(live.burstLeft)}` : 'Burst +500'; $('burst').disabled = live.phase === 'done'
    const ov = live.overrides || {}
    $('noise-pill').classList.toggle('hidden', !ov.noise); $('thr-pill').classList.toggle('hidden', !ov.threshold); $('fileVals').disabled = !(ov.noise || ov.threshold)
    if (now - matrixAt > 380 && matrixDirty) { matrixAt = now; matrixDirty = false; if (own) drawOwnPanel(); else drawMatrix() }
    if (now - sweepAt > 480 && sweepDirty) { sweepAt = now; sweepDirty = false; drawSweep() }
  }

  function showSummary(s) {
    const box = $('summary')
    if (!s) { box.classList.add('hidden'); summaryShownFor = -1; return }
    const key = rev + ':' + s.batchNo + ':' + (s.own ? s.escalated : '')
    if (summaryShownFor === key) return
    summaryShownFor = key
    box.classList.toggle('own', !!s.own); $('sum-again').classList.toggle('hidden', !s.own); $('sum-timer').parentElement.classList.toggle('hidden', !!s.own)
    if (s.own) {
      setText($('sum-kicker'), `Done · your data · ${s.source}`)
      $('sum-line').innerHTML = `<span>${fmtInt(s.messages)} messages</span><em>·</em> <span class="acc">${fmtSecs(s.elapsedMs)}</span><em>·</em> <span>${fmtMoney(s.costUsd)}</span><br><span class="ok">${fmtPct(s.messages ? 1 - s.escalatedPct : null)} auto-routed</span><em>·</em> <span class="warn">${fmtPct(s.escalatedPct)} escalated</span>`
      setText($('sum-sub'), `${s.output} is in the workspace, one line per message · ${fmtInt(s.answers)} typed answers · a ${config.llmSecondsPerItem}s-per-message model would be on message ${fmtInt(s.llmWouldBeOn)}${live.client === 'mock' ? ' · offline stand-in: cost is what live Jev would charge' : ''}`)
      box.classList.remove('hidden')
      return
    }
    setText($('sum-kicker'), `Batch ${s.batchNo} done · all synthetic`)
    $('sum-line').innerHTML = `${fmtInt(s.messages)} messages<em>·</em><span class="acc">${fmtSecs(s.elapsedMs)}</span><em>·</em>${fmtMoney(s.costUsd)}<em>·</em><span class="ok">${fmtPct(s.accuracy)} right</span><em>·</em><span class="warn">${fmtPct(s.escalatedPct)} escalated</span>`
    setText($('sum-sub'), `${fmtInt(s.answers)} typed answers in ${fmtInt(s.messages)} calls · a ${config.llmSecondsPerItem}s-per-message model would be on message ${fmtInt(s.llmWouldBeOn)} · next batch has a new seed`)
    box.classList.remove('hidden')
    const bar = $('sum-timer'); bar.classList.remove('run'); void bar.offsetWidth; if (live.running) bar.classList.add('run')
  }

  // ---- threshold sweep: accuracy and escalations at every threshold, from this batch --------
  let suggested = null
  function computeSweep() {
    const cnt = new Float64Array(101), ok = new Float64Array(101)
    let sr = 0, so = 0
    for (let i = 0; i < n; i++) { if (S[i] >= 128) { sr++; if (T[i] === SPAMB) so++; continue } const b = Math.min(100, Math.floor(Q[i] / 10)); cnt[b]++; if (C[i] === T[i]) ok[b]++ }
    const out = new Array(101); let routed = sr, right = so
    for (let j = 100; j >= 0; j--) { routed += cnt[j]; right += ok[j]; out[j] = { acc: routed ? right / routed : null, esc: n ? (n - routed) / n : 0 } }
    return out
  }
  function drawSweep() {
    const cv = $('sweep'), w = cv.clientWidth, h = 34; if (!w) return
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h)
    const sw = computeSweep(), x = (j) => 8 + (j / 100) * (w - 16), yA = (a) => 3 + (1 - (clamp(a, 0.5, 1) - 0.5) / 0.5) * (h - 6), yE = (e) => h - 2 - e * (h - 5)
    c.fillStyle = 'rgba(255,255,255,.03)'; c.fillRect(8, 0, w - 16, h)
    c.beginPath(); c.moveTo(x(0), h); for (let j = 0; j <= 100; j++) c.lineTo(x(j), yE(sw[j].esc)); c.lineTo(x(100), h); c.closePath(); c.fillStyle = 'rgba(251,191,36,.22)'; c.fill()
    c.beginPath(); for (let j = 0; j <= 100; j++) c[j ? 'lineTo' : 'moveTo'](x(j), yE(sw[j].esc)); c.strokeStyle = AMBER; c.lineWidth = 1.2; c.stroke()
    if (own) {
      const tx0 = x(thr * 100); c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.moveTo(tx0, 0); c.lineTo(tx0, h); c.stroke()
      c.font = '9px ui-monospace, Menlo, monospace'; c.fillStyle = 'rgba(148,163,184,.8)'; c.textAlign = 'left'; c.fillText('share escalated at each threshold', 11, 10)
      suggested = null; $('suggest').classList.add('hidden')
      return
    }
    const ty = yA(config.targetAccuracy); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(52,211,153,.45)'; c.beginPath(); c.moveTo(8, ty); c.lineTo(w - 8, ty); c.stroke(); c.setLineDash([])
    c.beginPath(); let started = false
    for (let j = 0; j <= 100; j++) { if (sw[j].acc == null) continue; c[started ? 'lineTo' : 'moveTo'](x(j), yA(sw[j].acc)); started = true }
    c.strokeStyle = '#34d399'; c.lineWidth = 1.6; c.stroke()
    suggested = null
    if (n >= 50) for (let j = 0; j <= 100; j++) if (sw[j].acc != null && sw[j].acc >= config.targetAccuracy) { suggested = { thr: j / 100, acc: sw[j].acc, esc: sw[j].esc }; break }
    if (suggested) { c.fillStyle = '#34d399'; c.beginPath(); c.arc(x(suggested.thr * 100), yA(suggested.acc), 3, 0, 6.2832); c.fill() }
    const tx = x(thr * 100); c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.moveTo(tx, 0); c.lineTo(tx, h); c.stroke()
    c.font = '9px ui-monospace, Menlo, monospace'; c.fillStyle = 'rgba(148,163,184,.8)'; c.textAlign = 'left'; c.fillText(`target ${Math.round(config.targetAccuracy * 100)}%`, 11, Math.max(9, ty - 3))
    const chip = $('suggest')
    if (suggested) { chip.classList.remove('hidden'); chip.textContent = `${Math.round(config.targetAccuracy * 100)}% at ${suggested.thr.toFixed(2)} · ${fmtPct(suggested.esc, 0)} esc`; chip.title = `Lowest threshold where at least ${Math.round(config.targetAccuracy * 100)}% of auto-routed messages are right on this batch. It escalates ${fmtPct(suggested.esc, 0)}. Click to use it.` }
    else if (n >= 50) { chip.classList.remove('hidden'); chip.textContent = `${Math.round(config.targetAccuracy * 100)}% not reachable`; chip.title = 'No threshold reaches the target on this batch. The noise is too high or the team descriptions overlap.' }
    else chip.classList.add('hidden')
  }

  // ---- your data: confidence histogram and per-team counts (there is no truth to build a matrix from)
  function drawOwnPanel() {
    const cv = $('confHist'), w = cv.clientWidth, h = 86; if (!w) return
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h)
    const B = 40, hist = new Float64Array(B); let mx = 1
    for (let i = 0; i < n; i++) { const k = Math.min(B - 1, Math.floor(Q[i] / (1000 / B))); hist[k]++; if (hist[k] > mx) mx = hist[k] }
    const bw = (w - 2) / B, base = h - 14
    for (let k = 0; k < B; k++) {
      const bh = (hist[k] / mx) * (base - 4)
      c.fillStyle = (k + 0.5) * (1000 / B) < thrQ ? 'rgba(251,191,36,.85)' : 'rgba(34,211,238,.85)'
      if (hist[k]) c.fillRect(1 + k * bw, base - Math.max(1.5, bh), Math.max(1, bw - 1), Math.max(1.5, bh))
    }
    c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(0, base, w, 1)
    const tx = 1 + thr * (w - 2); c.strokeStyle = '#fff'; c.lineWidth = 1; c.setLineDash([3, 2]); c.beginPath(); c.moveTo(tx, 0); c.lineTo(tx, base); c.stroke(); c.setLineDash([])
    c.font = '9px ui-monospace, Menlo, monospace'; c.fillStyle = 'rgba(148,163,184,.85)'; c.textBaseline = 'alphabetic'
    c.textAlign = 'left'; c.fillText('0', 1, h - 2); c.textAlign = 'center'; c.fillText('.5', w / 2, h - 2); c.textAlign = 'right'; c.fillText('1.0', w - 1, h - 2)
    const rows = []
    for (let b = 0; b <= nT + 1; b++) rows.push([b, counts[b] || 0])
    const most = Math.max(1, ...rows.map((r) => r[1]))
    $('teamCounts').innerHTML = rows.map(([b, cnt]) => `<button data-b="${b}"><span class="sw" style="background:${teamColor(b)}"></span><span class="nm" style="color:${teamColor(b)}">${esc(b === ESCB ? 'escalated' : teamName(b))}</span><span class="t"><i style="width:${(cnt / most) * 100}%;background:${teamColor(b)}"></i></span><span class="v">${fmtInt(cnt)}</span><span class="v dim">${fmtPct(n ? cnt / n : 0, 0)}</span></button>`).join('')
  }
  $('teamCounts').addEventListener('click', (e) => { const el = e.target.closest('button[data-b]'); if (el) selectBin(Number(el.dataset.b)) })

  // ---- confusion matrix ------------------------------------------------------------------------
  function drawMatrix() {
    const cv = $('matrix'), w = cv.clientWidth; if (!w || !nT) return
    const rows = nT + 1, cols = nT + 2, labelW = nT > 12 ? 50 : 62, headH = 12
    const cell = Math.min(30, (w - labelW - 6) / cols), ch = Math.max(7, Math.min(24, cell * 0.86)), h = Math.round(headH + rows * ch + 4)
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px' }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h)
    const gx = (j) => labelW + j * cell + (j === cols - 1 ? 5 : 0)
    for (let j = 0; j < cols; j++) { c.fillStyle = j < nT ? colors[j] : j === nT ? SPAMC : AMBER; c.fillRect(gx(j) + 2, 2, cell - 4, 5) }
    c.textBaseline = 'middle'
    for (let i = 0; i < rows; i++) {
      const y = headH + i * ch, row = confusion[i] || [], sum = row.reduce((a, b) => a + b, 0) || 1
      c.font = `${ch < 12 ? 8 : 10}px ui-monospace, Menlo, monospace`; c.textAlign = 'left'; c.fillStyle = i < nT ? colors[i] : SPAMC
      c.fillText(fitText(c, i < nT ? teams[i].id : 'spam', labelW - 4), 0, y + ch / 2)
      for (let j = 0; j < cols; j++) {
        const v = (row[j] || 0) / sum, a = v ? 0.1 + 0.9 * Math.sqrt(v) : 0.035
        c.fillStyle = j === cols - 1 ? `rgba(251,191,36,${a})` : i === j ? `rgba(52,211,153,${a})` : v ? `rgba(255,77,94,${a})` : 'rgba(255,255,255,.035)'
        c.fillRect(gx(j) + 0.5, y + 0.5, cell - 1, ch - 1)
        if (cell >= 21 && ch >= 14 && row[j]) { c.font = '8.5px ui-monospace, Menlo, monospace'; c.textAlign = 'center'; c.fillStyle = v > 0.35 ? '#04120c' : 'rgba(226,232,240,.85)'; c.fillText(row[j] > 9999 ? Math.round(row[j] / 1000) + 'k' : String(row[j]), gx(j) + cell / 2, y + ch / 2 + 0.5) }
      }
    }
    mxCells = { labelW, cell, ch, headH, rows, cols, gx }
  }
  $('matrix').addEventListener('mousemove', (e) => {
    if (!mxCells) return
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, m = mxCells
    const i = Math.floor((y - m.headH) / m.ch); let j = -1
    for (let q = 0; q < m.cols; q++) if (x >= m.gx(q) && x < m.gx(q) + m.cell) j = q
    if (i < 0 || i >= m.rows || j < 0) { setText($('mx-tip'), 'Hover a cell.'); return }
    const row = confusion[i] || [], sum = row.reduce((a, b) => a + b, 0), name = (q) => (q < nT ? teams[q].id : q === nT ? 'spam' : 'escalated')
    setText($('mx-tip'), `true ${name(i)} → ${j === nT + 1 ? 'escalated' : 'bin ' + name(j)}: ${fmtInt(row[j] || 0)} (${fmtPct(sum ? (row[j] || 0) / sum : 0)})`)
  })

  // ------------------------------------------------------------------------------------------
  // Inspector
  // ------------------------------------------------------------------------------------------
  const teamName = (i) => (i < nT ? teams[i]?.id ?? '?' : i === SPAMB ? 'spam' : 'escalated')
  const teamColor = (i) => (i <= nT ? colors[i] : AMBER)
  function probBars(probs, top, colorOf, limit) {
    const e = Object.entries(probs || {}).sort((a, b) => b[1] - a[1]).slice(0, limit)
    return e.map(([k, p]) => `<div class="bar${k === top ? ' top' : ''}"><span class="n" title="${esc(k)}">${esc(k)}</span><span class="t"><i style="width:${Math.max(2, p * 100)}%;background:${colorOf(k)}"></i></span><span class="v">${p.toFixed(2).replace(/^0/, '')}</span></div>`).join('')
  }
  function levelBars(a, truth, legend) {
    const e = Object.entries(a?.probabilities || {}).sort((x, y) => Number(x[0]) - Number(y[0]))
    const best = e.reduce((m, x) => (x[1] > m[1] ? x : m), ['0', -1])[0]
    const bars = e.map(([k, p]) => `<i class="${k === best ? 'top' : ''}${Number(k) === truth ? ' truth' : ''}" style="height:${Math.max(8, p * 100)}%" title="${esc(legend[k] ?? k)}: ${p.toFixed(2)}"></i>`).join('')
    return `<div><div class="levels">${bars}</div><div class="lvl-note">level ${esc(best)} · ${esc(legend[best] ?? '')}</div></div>`
  }
  function noulBar(a, truth) {
    const p = Number(a?.noul ?? 0.5)
    return `<div class="bars"><div class="bar top"><span class="n">${p >= 0.5 ? 'yes' : 'no'}</span><span class="t"><i style="width:${Math.max(2, p * 100)}%;background:${p >= 0.5 ? 'var(--ok)' : 'var(--bad)'}"></i></span><span class="v">${p.toFixed(2).replace(/^0/, '')}</span></div></div>`
  }
  function renderRecord(r, liveMode) {
    const body = $('insp-body')
    setText($('insp-title'), liveMode ? 'Inspector · live sample' : 'Inspector · pinned')
    $('insp-live').classList.toggle('hidden', !liveMode); $('insp-follow').classList.toggle('hidden', liveMode)
    if (!r) { body.innerHTML = '<div class="how">This message is older than the last 6,000 kept for inspection.</div>'; return }
    if (r.own) {
      const b = bucketOf(r.id), a = r.answers || {}
      const tag = r.failed ? '<span class="tag wrong">no answer · escalated</span>' : b === ESCB ? `<span class="tag esc">escalated · ${r.confidence.toFixed(2)} under ${thr.toFixed(2)}</span>` : b === SPAMB ? '<span class="tag esc">spam bin</span>' : `<span class="tag right">auto-routed · ${r.confidence.toFixed(2)}</span>`
      body.innerHTML = `
        <div class="insp-verdict"><span class="sw" style="background:${teamColor(r.choice)}"></span><b>row ${fmtInt(r.row)}</b><span>Jev says</span><b style="color:${teamColor(r.choice)}">${esc(teamName(r.choice))}</b>${tag}</div>
        <div class="insp-text">${esc(r.text)}</div>
        <div class="insp-meta">id <b>${esc(r.sourceId)}</b>${(r.fields || []).map(([k, v]) => ` · ${esc(k)} <b>${esc(v)}</b>`).join('')} · ${r.tokens} tok · ${r.latencyMs < 1 ? '<1' : Math.round(r.latencyMs)} ms</div>
        <div class="ans">
          <div class="q">team<small class="plain">choice</small></div><div class="bars">${probBars(a.team?.probabilities, a.team?.choice, (k) => { const ix = teams.findIndex((t) => t.id === k); return ix < 0 ? CYAN : colors[ix] }, 4)}</div>
          <div class="q">urgency<small class="plain">score</small></div>${levelBars(a.urgency, null, urgencyLegend)}
          <div class="q">spam<small class="plain">noul</small></div>${noulBar(a.spam)}
          <div class="q">needs_human<small class="plain">noul</small></div>${noulBar(a.needs_human)}
          <div class="q">mood<small class="plain">score</small></div>${levelBars(a.mood, null, moodLegend)}
        </div>`
      return
    }
    const b = bucketOf(r.id) , right = b === ESCB ? null : b === r.truth
    const tag = right == null ? `<span class="tag esc">escalated · ${(r.confidence).toFixed(2)} under ${thr.toFixed(2)}</span>` : right ? '<span class="tag right">right</span>' : '<span class="tag wrong">wrong bin</span>'
    const parts = (r.parts || []).map((p) => {
      if (p.kind === 'true' || p.kind === 'noise') return `<span style="border-bottom-color:${teamColor(p.team)};${p.kind === 'noise' ? `background:${teamColor(p.team)}22` : ''}" title="${p.kind === 'noise' ? 'mixed in from ' : 'true team: '}${esc(teamName(p.team))}">${esc(p.text)}</span>`
      if (p.kind === 'spam') return `<span style="border-bottom-color:${SPAMC}">${esc(p.text)}</span>`
      return `<span class="dimmed">${esc(p.text)}</span>`
    }).join(' ')
    const a = r.answers || {}, ham = r.truth !== SPAMB
    body.innerHTML = `
      <div class="insp-verdict"><span class="sw" style="background:${teamColor(r.truth)}"></span><b>#${fmtInt(r.id + 1)}</b><span>Jev says</span><b style="color:${teamColor(r.choice)}">${esc(teamName(r.choice))}</b>${tag}</div>
      <div class="insp-text">${parts}</div>
      <div class="insp-meta">true team <b style="color:${teamColor(r.truth)}">${esc(teamName(r.truth))}</b>${r.nNoise ? ` · ${r.nTrue} true + ${r.nNoise} from <b style="color:${teamColor(r.distractor)}">${esc(teamName(r.distractor))}</b>` : r.truth === SPAMB ? '' : ` · ${r.nTrue} true, no noise`} · ${r.tokens} tok · ${r.latencyMs < 1 ? '<1' : Math.round(r.latencyMs)} ms</div>
      <div class="ans">
        <div class="q">team<small>truth ${esc(teamName(r.truth))}</small></div><div class="bars">${probBars(a.team?.probabilities, a.team?.choice, (k) => { const ix = teams.findIndex((t) => t.id === k); return ix < 0 ? CYAN : colors[ix] }, 4)}</div>
        <div class="q">urgency<small>${ham ? 'truth level ' + r.truthUrgency : 'score'}</small></div>${levelBars(a.urgency, r.truth === SPAMB ? null : r.truthUrgency, urgencyLegend)}
        <div class="q">spam<small>truth ${r.truth === SPAMB ? 'yes' : 'no'}</small></div>${noulBar(a.spam, r.truth === SPAMB)}
        <div class="q">needs_human<small>${ham ? 'truth ' + (r.truthHuman ? 'yes' : 'no') : 'noul'}</small></div>${noulBar(a.needs_human, r.truth === SPAMB ? null : r.truthHuman)}
        <div class="q">mood<small>${ham ? 'truth level ' + r.truthMood : 'score'}</small></div>${levelBars(a.mood, r.truth === SPAMB ? null : r.truthMood, moodLegend)}
      </div>`
  }
  async function renderBin(b) {
    const body = $('insp-body')
    setText($('insp-title'), 'Inspector · pinned'); $('insp-live').classList.add('hidden'); $('insp-follow').classList.remove('hidden')
    const res = await ctl('bin', { bucket: b })
    if (!sel || sel.kind !== 'bin' || sel.b !== b) return
    if (res.own) {
      const isLane = b === ESCB, what = b === SPAMB ? 'spam probability' : 'team confidence'
      const card = (m, title) => (m ? `<div class="pick"><div class="pick-h">${title}<b>${b === SPAMB ? m.spam.toFixed(2) : m.confidence.toFixed(2)}</b></div><button data-id="${m.id}"><span>${esc(m.text)}</span></button></div>` : '')
      const descOwn = isLane ? `Jev's team confidence was under ${thr.toFixed(2)}, so these go to a big model or a person instead of a team.` : b === SPAMB ? 'Jev said yes to the spam question. These skip the teams.' : teams[b].description
      body.innerHTML = `
        <div class="insp-verdict"><span class="sw" style="background:${teamColor(b)}"></span><b style="color:${teamColor(b)}">${esc(isLane ? 'escalate lane' : teamName(b) + ' bin')}</b><span>${fmtInt(res.count)} messages · ${fmtPct(n ? res.count / n : 0, 0)}</span></div>
        <div class="insp-meta" style="font-size:12px;color:var(--ink)">${esc(descOwn)}</div>
        ${card(res.most, `Most confident <small>${what}</small>`)}${card(res.least, `Least confident <small>${what}</small>`)}
        <div class="insp-meta">Latest here</div>
        <div class="bin-list">${(res.list || []).map((m) => `<button data-id="${m.id}"><span>${esc(m.text)}</span><em class="e">${m.confidence.toFixed(2).replace(/^0/, '')}</em></button>`).join('') || '<div class="how">Nothing here yet.</div>'}</div>`
      body.querySelectorAll('button[data-id]').forEach((el) => el.addEventListener('click', () => selectItem(Number(el.dataset.id))))
      return
    }
    const cnt = counts[b] || 0, ok = rights[b] || 0, isEsc = b === ESCB
    const wrongFrom = []
    for (let i = 0; i <= nT; i++) if (i !== b && confusion[i] && confusion[i][b]) wrongFrom.push([i, confusion[i][b]])
    wrongFrom.sort((x, y) => y[1] - x[1])
    const desc = isEsc ? `Jev's team confidence was under ${thr.toFixed(2)}, so these go to a big model instead of a bin.` : b === SPAMB ? 'Jev said yes to the spam question. These skip the teams.' : teams[b].description
    body.innerHTML = `
      <div class="insp-verdict"><span class="sw" style="background:${teamColor(b)}"></span><b style="color:${teamColor(b)}">${esc(isEsc ? 'escalate lane' : teamName(b) + ' bin')}</b><span>${fmtInt(cnt)} messages</span>${isEsc ? '' : `<span class="tag ${cnt && ok / cnt < config.targetAccuracy ? 'wrong' : 'right'}">${fmtPct(cnt ? ok / cnt : null)} right</span>`}</div>
      <div class="insp-meta" style="font-size:12px;color:var(--ink)">${esc(desc)}</div>
      <div class="insp-meta">${isEsc ? 'Truly from: ' : 'Wrong arrivals truly from: '}${wrongFrom.slice(0, 4).map(([i, c]) => `<b style="color:${teamColor(i)}">${esc(teamName(i))}</b> ${fmtInt(c)}`).join(' · ') || 'none yet'}</div>
      <div class="bin-list">${(res.list || []).map((m) => `<button data-id="${m.id}"><span>${esc(m.text)}</span><em class="${m.right == null ? 'e' : m.right ? 'r' : 'w'}">${m.confidence.toFixed(2).replace(/^0/, '')} ${m.right == null ? 'esc' : m.right ? 'ok' : 'wrong'}</em></button>`).join('') || '<div class="how">Nothing here yet.</div>'}</div>`
    body.querySelectorAll('button[data-id]').forEach((el) => el.addEventListener('click', () => selectItem(Number(el.dataset.id))))
  }
  async function selectItem(id) {
    sel = { kind: 'item', id }; follow = false
    const res = await ctl('inspect', { id })
    if (sel && sel.kind === 'item' && sel.id === id) renderRecord(res.record, false)
    $('inspector').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  function selectBin(b) { sel = { kind: 'bin', b }; follow = false; renderBin(b); $('inspector').scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
  $('insp-follow').addEventListener('click', () => { sel = null; follow = true; setText($('insp-title'), 'Inspector · live sample'); $('insp-live').classList.remove('hidden'); $('insp-follow').classList.add('hidden') })

  // ------------------------------------------------------------------------------------------
  // Network
  // ------------------------------------------------------------------------------------------
  async function ctl(cmd, extra) {
    try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...extra }) }); return await r.json() } catch { return {} }
  }
  const b64u8 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
  function takeLive(s, now) {
    live = s; liveAt = now
    if (now > holdServerUntil && !dragThr) {
      if (Math.abs(s.threshold - thr) > 1e-6) { setThr(s.threshold, false) }
      if (Math.abs(s.noise - noise) > 1e-6) { noise = s.noise; syncNoiseUi() }
    }
    const err = $('cfgError'); err.classList.toggle('hidden', !s.error && !s.jevError); if (s.error || s.jevError) setText(err, s.error ? `${s.error}. The demo keeps running on the last good file.` : `Jev call failed: ${s.jevError}`)
    showSummary(s.phase === 'summary' || s.phase === 'done' ? s.summary : null)
  }
  function onFull(s) {
    const now = performance.now()
    config = s.config || config; urgencyLegend = s.urgencyLegend || []; moodLegend = s.moodLegend || []
    const modeChanged = own !== !!s.own
    own = !!s.own; sourceInfo = s.source || null
    document.body.classList.toggle('own', own)
    if (own && sourceInfo) { setText($('src-name'), sourceInfo.name); setText($('src-note'), `${fmtInt(sourceInfo.used)} messages · text column "${sourceInfo.textColumn}"${sourceInfo.skipped ? ` · ${fmtInt(sourceInfo.skipped)} empty rows skipped` : ''} · results in ${s.output?.file ?? 'triage.csv'}`) }
    if (modeChanged) { matrixDirty = true; sweepDirty = true }
    setText($('title'), s.title || 'Jev Firehose'); setText($('desk'), s.desk || ''); document.title = s.title || 'Jev Firehose'
    const warn = $('cfgWarn'); warn.classList.toggle('hidden', !(s.warnings && s.warnings.length)); if (s.warnings && s.warnings.length) setText(warn, 'firehose.json: ' + s.warnings.slice(0, 3).join(' · '))
    const sizeChanged = (s.batch || 0) !== (live.batch || 0)
    if (sizeChanged) live = { ...live, batch: s.batch }
    const fresh = s.rev !== rev || s.n < n || (s.teams || []).length !== nT || sizeChanged
    if (fresh) {
      if (rev !== -1 && binList.some((l) => l.length)) { flctx.clearRect(0, 0, W, H); flctx.drawImage(binLayer, 0, 0, W, H); flushT = 0 }
      rev = s.rev
      thr = s.threshold; thrQ = Math.round(thr * 1000); noise = s.noise
      resetWorld(s); layout(); syncNoiseUi(); syncThrUi()
      shown.done = Math.min(shown.done, s.n)
    }
    if (s.hist && s.n > n) {
      const t = b64u8(s.hist.t), c = b64u8(s.hist.c), qb = b64u8(s.hist.q), q = new Uint16Array(qb.buffer, 0, qb.length >> 1), sp = b64u8(s.hist.s), d = b64u8(s.hist.d), m = b64u8(s.hist.m), u = b64u8(s.hist.u)
      const it = [0, 0, 0, 0, 0, 0, 0], animateFrom = fresh ? s.n : n
      for (let i = n; i < s.n; i++) { it[0] = t[i]; it[1] = c[i]; it[2] = q[i]; it[3] = sp[i]; it[4] = d[i]; it[5] = m[i]; it[6] = u[i]; recv(i, it, i >= animateFrom) }
      if (fresh) { redrawBins(); shown.done = s.n }
    }
    takeLive(s, now)
    if (follow && s.last) renderRecord(s.last, true)
  }
  let resyncing = false
  async function resync() { if (resyncing) return; resyncing = true; try { onFull(await (await fetch('/state', { cache: 'no-store' })).json()) } catch { /* server restarting */ } resyncing = false }
  function onFrame(f) {
    if (f.rev !== rev || f.from > n) { resync(); return }
    for (let j = 0; j < f.items.length; j++) { const i = f.from + j; if (i >= n) recv(i, f.items[j], true) }
    takeLive(f, performance.now())
    if (follow && f.sample) renderRecord(f.sample, true)
  }
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => onFull(JSON.parse(e.data)))
  es.addEventListener('frame', (e) => onFrame(JSON.parse(e.data)))

  // ------------------------------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------------------------------
  function throttle(fn, ms) { let t = 0, timer = null, lastArgs = null; return (...a) => { lastArgs = a; const now = performance.now(); if (now - t >= ms) { t = now; fn(...a) } else if (!timer) timer = setTimeout(() => { timer = null; t = performance.now(); fn(...lastArgs) }, ms - (now - t)) } }
  const sendThr = throttle((v) => ctl('threshold', { value: v }), 70)
  const sendNoise = throttle((v) => ctl('noise', { value: v }), 70)
  function syncThrUi() { $('threshold').value = String(thr); setText($('thr-val'), thr.toFixed(2)) }
  function syncNoiseUi() { $('noise').value = String(noise); setText($('noise-val'), noise.toFixed(2)) }
  function setThr(v, fromUser) {
    v = Math.round(clamp(v, 0, 1) * 100) / 100
    if (Math.abs(v - thr) < 1e-9) return
    thr = v; thrQ = Math.round(v * 1000)
    syncThrUi(); rebucket(); drawSweep(); drawMatrix()
    if (sel && sel.kind === 'bin') renderBin(sel.b)
    if (fromUser) { holdServerUntil = performance.now() + 450; sendThr(v) }
  }
  $('threshold').addEventListener('input', (e) => setThr(Number(e.target.value), true))
  $('noise').addEventListener('input', (e) => { noise = clamp(Number(e.target.value), 0, 1); setText($('noise-val'), noise.toFixed(2)); holdServerUntil = performance.now() + 450; sendNoise(noise) })
  $('suggest').addEventListener('click', () => { if (suggested) setThr(suggested.thr, true) })
  $('burst').addEventListener('click', () => { activity = 1; ctl('burst', { n: 500 }) })
  $('fileVals').addEventListener('click', () => { holdServerUntil = 0; ctl('clearOverrides') })
  $('pause').addEventListener('click', () => ctl(live.running ? 'pause' : 'start'))
  $('step').addEventListener('click', async () => { if (live.running) await ctl('pause'); ctl('tick', { n: 1 }) })
  $('reset').addEventListener('click', () => ctl('reset'))
  $('sum-again').addEventListener('click', () => ctl('again'))
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return
    if (e.key === ' ') { e.preventDefault(); $('pause').click() } else if (e.key === 'b' || e.key === 'B') $('burst').click(); else if (e.key === 's' || e.key === 'S') $('step').click()
  })

  function scenePoint(e) { const r = scene.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const nearThr = (p) => Math.abs(p.y - clamp(confY(thrQ), L.gateTop, L.gateBot)) < 10 && p.x > L.gateX - 120 && p.x < L.gateX + 64
  function bucketAt(p) { for (let b = 0; b < geo.length; b++) { const g = geo[b]; if (p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) return b } return -1 }
  function tileAt(p, b) {
    const g = geo[b]; if (p.x < g.ax || p.y < g.ay || p.y > g.ay + g.ah) return -1
    const col = Math.floor((p.x - g.ax) / g.pitch), row = Math.floor((g.ay + g.ah - p.y) / g.pitch)
    if (row < 0 || row >= g.rows) return -1
    const slot = (col * g.rows + row) * g.unit
    return slot < binList[b].length ? binList[b][slot] : -1
  }
  scene.addEventListener('pointerdown', (e) => {
    const p = scenePoint(e)
    if (nearThr(p)) { dragThr = true; scene.setPointerCapture(e.pointerId); return }
    let best = null, bd = 15 * 15
    for (const f of fly) { const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2; if (d < bd) { bd = d; best = f } }
    if (best) { selectItem(best.id); return }
    const b = bucketAt(p)
    if (b >= 0) { const id = tileAt(p, b); if (id >= 0) selectItem(id); else selectBin(b) }
  })
  scene.addEventListener('pointermove', (e) => {
    const p = scenePoint(e)
    if (dragThr) { setThr(yToConf(p.y), true); return }
    hoverB = bucketAt(p)
    scene.style.cursor = nearThr(p) ? 'ns-resize' : hoverB >= 0 ? 'pointer' : 'default'
  })
  const endDrag = () => { dragThr = false }
  scene.addEventListener('pointerup', endDrag); scene.addEventListener('pointercancel', endDrag)
  scene.addEventListener('pointerleave', () => { hoverB = -1 })

  new ResizeObserver(() => { layout(); matrixDirty = true; sweepDirty = true }).observe(wrap)

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000)); lastFrame = now
    update(dt, now); draw(now); updateDom(now, dt)
    requestAnimationFrame(frame)
  }
  buildPalette(); resetWorld({ teams: [] }); layout()
  requestAnimationFrame(frame)
})()
