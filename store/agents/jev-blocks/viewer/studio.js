// studio.js — the Jev Blocks pane. Draws the well at 60 fps and eases between server frames, so the
// piece falls and slides smoothly even though decisions arrive a few times a second. Jev's mind is
// drawn ON the board: every placement it weighed is a ghost whose brightness is its probability.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const wrap = $('wrap'), canvas = $('scene'), ctx = canvas.getContext('2d')
  const W = 10, H = 20
  const CODE = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 }
  const COLORS = { 1: '#22d3ee', 2: '#fde047', 3: '#c084fc', 4: '#4ade80', 5: '#fb7185', 6: '#60a5fa', 7: '#fb923c', 8: '#5b6680', 9: '#9aa6bf' }
  const FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace"
  const FADE_MS = 420 // game ms for the mind overlay to fade once the piece starts to move

  // ------------------------------------------------------------------ state
  let S = null, shapes = null, mind = null, logLines = [], logSeq = -1
  let lastSeq = -1, firstFrame = true
  let board = new Array(W * H).fill(0), prevBoard = board
  let showMind = true
  let simBase = 0, simWall = performance.now()
  let disp = null                  // the piece as drawn: { id, type, rot, x, y, pop }
  let mindFade = { id: -1, start: null, born: 0 }
  let drop = null, clearAnim = null, fallAnim = null, rise = null, sweep = null, flash = null, lockFlash = null, collapse = null, want = null
  let junks = [], particles = [], texts = [], nextPulse = [0, 0, 0]
  let shake = 0, intro = 0
  let hover = { col: -1, next: -1 }
  let L = null, sprites = null, dpr = 1
  let dragging = { gravity: false, think: false }
  let jevStats = { dps: 0, cost: 0 }
  let last = performance.now()

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const lerp = (a, b, t) => a + (b - a) * t
  const easeOut = (t) => 1 - (1 - t) ** 3
  const rate = () => (S && S.slow ? 0.25 : 1)
  const simNow = () => simBase + (S && S.running && !S.finished ? (performance.now() - simWall) * rate() : 0)
  const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
  const cellsOf = (type, rot, x, y) => (shapes?.[type]?.[rot] ?? []).map(([dx, dy]) => [x + dx, y + dy])

  // ------------------------------------------------------------------ frames from the server
  function onFrame(f) {
    if (f.shapes) shapes = f.shapes
    if ('mind' in f) {
      mind = f.mind
      if (mind && mind.pieceId !== mindFade.id) mindFade = { id: mind.pieceId, start: null, born: performance.now(), seq: mind.seq }
      else if (mind && mind.seq !== mindFade.seq) mindFade = { id: mind.pieceId, start: null, born: performance.now() - 200, seq: mind.seq }
    }
    if (f.log) logLines = f.log
    const was = S
    S = f
    simBase = f.game.simMs; simWall = performance.now()
    prevBoard = board
    board = Array.from(f.game.board, Number)
    const fresh = (f.events || []).filter((e) => e.seq > lastSeq)
    if (firstFrame) { firstFrame = false; intro = performance.now() } else {
      const locks = fresh.filter((e) => e.kind === 'lock').length
      for (const e of fresh) onEvent(e, locks > 3 && e !== fresh[fresh.length - 1])
    }
    if (fresh.length) lastSeq = fresh[fresh.length - 1].seq
    if (was && was.game.n !== f.game.n && !fresh.some((e) => e.kind === 'newgame')) resetAnims()
    renderDom()
  }

  function resetAnims() { drop = clearAnim = fallAnim = rise = sweep = flash = lockFlash = collapse = want = null; junks = []; particles = []; texts = []; disp = null; shake = 0; intro = performance.now() }

  function onEvent(e, quiet) {
    const now = performance.now(), r = rate()
    if (e.kind === 'newgame') return resetAnims()
    if (e.kind === 'topout') return startCollapse()
    if (quiet || !L) return
    if (e.kind === 'lock') {
      const cells = cellsOf(e.type, e.rot, e.x, e.y).filter(([, y]) => y >= 0)
      const from = disp && disp.id === e.id ? { x: disp.x, y: disp.y } : { x: e.x, y: e.fromY }
      const dist = Math.abs(e.x - from.x) * 14 + Math.abs(e.y - from.y) * 5
      const dur = clamp(50 + dist, 70, 240) / r
      drop = { type: e.type, rot: e.rot, x0: from.x, y0: Math.min(from.y, e.y), x1: e.x, y1: e.y, t0: now, dur, cells }
      if (disp && disp.id === e.id) disp = null
      lockFlash = { cells, t0: now + dur, dur: 190 / r, missed: e.missed, code: CODE[e.type] }
      if (e.missed) {
        texts.push({ text: 'TOO SLOW', x: e.x + 1.5, y: e.y, t0: now + dur, dur: 900 / r, color: '#fb7185', size: 0.62 })
        want = e.want ? { type: e.type, ...e.want, t0: now, dur: 900 / r } : null
        shake = Math.max(shake, 3)
      }
      if (e.cleared.length) {
        const pre = prevBoard.slice()
        for (const [x, y] of cells) pre[y * W + x] = CODE[e.type]
        clearAnim = { rows: e.cleared, board: pre, t0: now + dur, dur: 210 / r, burst: false, gain: e.gain }
        fallAnim = null
      }
      if (mindFade.id === e.id && mindFade.start == null) mindFade.start = simNow()
    } else if (e.kind === 'levelup') {
      sweep = { t0: now, dur: 750 / r, level: e.level, g: e.g }
    } else if (e.kind === 'garbage') {
      rise = { t0: now, dur: 170 / r }; shake = Math.max(shake, 5)
    } else if (e.kind === 'junk') {
      junks.push({ col: e.col, row: e.row, t0: now, dur: clamp(90 + e.row * 9, 100, 280) / r }); shake = Math.max(shake, 2)
    } else if (e.kind === 'cycle') nextPulse[e.index] = now
  }

  function startCollapse() {
    const now = performance.now(), blocks = []
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = board[y * W + x]
      if (c) blocks.push({ x, y, c, delay: 250 + (H - 1 - y) * 70 + Math.random() * 90, vx: (Math.random() - 0.5) * 4, vy: -1 - Math.random() * 3, rot: 0, vr: (Math.random() - 0.5) * 9, fx: x, fy: y })
    }
    collapse = { t0: now, blocks, last: now }
    drop = clearAnim = fallAnim = lockFlash = null; disp = null
    shake = 9
    flash = { t0: now, dur: 380, color: '251,113,133', alpha: 0.4 }
  }

  // ------------------------------------------------------------------ layout and sprites
  function layout() {
    const w = wrap.clientWidth, h = wrap.clientHeight
    dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    const pad = 16, gap = 18, sideMin = 138
    let cell = Math.floor((h - pad * 2) / H)
    cell = Math.min(cell, Math.floor((w - pad * 2 - 2 * (sideMin + gap)) / W))
    cell = Math.max(10, cell)
    const wellW = cell * W, wellH = cell * H
    const side = clamp(Math.floor((w - wellW - 2 * gap - 2 * pad) / 2), sideMin, 236)
    const x0 = Math.round((w - (wellW + 2 * (side + gap))) / 2)
    const y0 = Math.round((h - wellH) / 2)
    L = { w, h, cell, u: clamp(cell / 30, 0.62, 1.25), well: { x: x0 + side + gap, y: y0, w: wellW, h: wellH }, left: { x: x0, y: y0, w: side, h: wellH }, right: { x: x0 + side + gap + wellW + gap, y: y0, w: side, h: wellH }, nextBoxes: [] }
    sprites = makeSprites(cell)
  }

  function makeSprites(cell) {
    const out = {}
    const px = Math.round(cell * dpr)
    for (const [code, color] of Object.entries(COLORS)) {
      const c = document.createElement('canvas'); c.width = c.height = px
      const g = c.getContext('2d'); g.scale(px / cell, px / cell)
      const s = cell, b = Math.max(2, s * 0.17), r = s * 0.14, dull = code >= 8
      g.save()
      g.beginPath(); g.roundRect(0.5, 0.5, s - 1, s - 1, r); g.clip()
      g.fillStyle = color; g.fillRect(0, 0, s, s)
      const poly = (pts, fill) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = fill; g.fill() }
      poly([[0, 0], [s, 0], [s - b, b], [b, b]], `rgba(255,255,255,${dull ? 0.22 : 0.5})`)
      poly([[0, 0], [b, b], [b, s - b], [0, s]], `rgba(255,255,255,${dull ? 0.1 : 0.24})`)
      poly([[s, 0], [s, s], [s - b, s - b], [s - b, b]], 'rgba(0,0,0,.26)')
      poly([[0, s], [b, s - b], [s - b, s - b], [s, s]], 'rgba(0,0,0,.46)')
      const face = g.createLinearGradient(b, b, s - b, s - b)
      face.addColorStop(0, 'rgba(255,255,255,.22)'); face.addColorStop(0.5, 'rgba(255,255,255,0)'); face.addColorStop(1, 'rgba(0,0,0,.16)')
      g.fillStyle = face; g.fillRect(b, b, s - 2 * b, s - 2 * b)
      if (!dull) { g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.roundRect(b + s * 0.06, b + s * 0.06, s * 0.2, s * 0.09, s * 0.04); g.fill() }
      if (code == 9) { g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = Math.max(1.5, s * 0.08); g.beginPath(); g.moveTo(s * 0.34, s * 0.34); g.lineTo(s * 0.66, s * 0.66); g.moveTo(s * 0.66, s * 0.34); g.lineTo(s * 0.34, s * 0.66); g.stroke() }
      g.restore()
      // soft glow, drawn additively under the block
      const gl = document.createElement('canvas'); const gs = Math.round(cell * 2.4 * dpr); gl.width = gl.height = gs
      const gg = gl.getContext('2d'); const rad = gg.createRadialGradient(gs / 2, gs / 2, gs * 0.12, gs / 2, gs / 2, gs / 2)
      rad.addColorStop(0, hexA(color, dull ? 0.1 : 0.34)); rad.addColorStop(1, hexA(color, 0))
      gg.fillStyle = rad; gg.fillRect(0, 0, gs, gs)
      out[code] = { body: c, glow: gl }
    }
    return out
  }

  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }

  // ------------------------------------------------------------------ drawing helpers
  const cx = (x) => L.well.x + x * L.cell
  const cy = (y) => L.well.y + y * L.cell

  function drawBlock(code, x, y, alpha = 1, glow = 1) {
    const s = sprites[code]; if (!s) return
    const c = L.cell, X = cx(x), Y = cy(y)
    if (glow > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha * glow; ctx.drawImage(s.glow, X - c * 0.7, Y - c * 0.7, c * 2.4, c * 2.4); ctx.globalCompositeOperation = 'source-over' }
    ctx.globalAlpha = alpha
    ctx.drawImage(s.body, X, Y, c, c)
    ctx.globalAlpha = 1
  }

  /** Trace the outside edge of a set of cells (not one box per cell). */
  function outline(cells, inset = 0) {
    const has = new Set(cells.map(([x, y]) => x + ',' + y)), c = L.cell
    ctx.beginPath()
    for (const [x, y] of cells) {
      const X = cx(x), Y = cy(y)
      if (!has.has(x + ',' + (y - 1))) { ctx.moveTo(X + inset, Y + inset); ctx.lineTo(X + c - inset, Y + inset) }
      if (!has.has(x + ',' + (y + 1))) { ctx.moveTo(X + inset, Y + c - inset); ctx.lineTo(X + c - inset, Y + c - inset) }
      if (!has.has(x - 1 + ',' + y)) { ctx.moveTo(X + inset, Y + inset); ctx.lineTo(X + inset, Y + c - inset) }
      if (!has.has(x + 1 + ',' + y)) { ctx.moveTo(X + c - inset, Y + inset); ctx.lineTo(X + c - inset, Y + c - inset) }
    }
  }

  function text(str, x, y, size, color, align = 'left', weight = 600) {
    ctx.font = `${weight} ${Math.round(size)}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'
    ctx.fillText(str, x, y)
  }

  function card(x, y, w, h, title) {
    ctx.fillStyle = 'rgba(15,17,26,.86)'; ctx.strokeStyle = '#232838'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 10); ctx.fill(); ctx.stroke()
    if (title) text(title, x + 12, y + 19, 9.5, '#8b92aa', 'left', 600)
  }

  const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fmtMs = (ms) => (ms >= 10000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)

  // ------------------------------------------------------------------ side panels
  /** Split a panel into cards that fill its height. Returns [{ y, h, mid }] where mid is the centre under the title. */
  function stackCards(p, natural, gapY = 10) {
    const k = (p.h - gapY * (natural.length - 1)) / natural.reduce((a, b) => a + b, 0)
    let y = p.y
    return natural.map((n, i) => { const h = i === natural.length - 1 ? p.y + p.h - y : Math.round(n * k); const c = { y, h, mid: y + 24 + (h - 30) / 2 }; y += h + gapY; return c })
  }

  function drawLeft(now) {
    const p = L.left, u = clamp(L.u, 0.8, 1.15), g = S.game
    const [cScore, cStats, cDanger, cFour, cGrav] = stackCards(p, [72, 116, 100, 84, 132])
    const bx = p.x + 12, bw = p.w - 24
    // score
    card(p.x, cScore.y, p.w, cScore.h, 'SCORE')
    text(fmt(g.score), p.x + p.w - 14, cScore.mid + 12 * u, 28 * u, '#e9ecf5', 'right', 700)
    // four small numbers
    card(p.x, cStats.y, p.w, cStats.h)
    const rowH = (cStats.h - 16) / 2
    const cells = [['LEVEL', g.level], ['LINES', fmt(g.lines)], ['LINES/MIN', g.lpm ? g.lpm.toFixed(0) : '—'], ['PIECES', fmt(g.pieces)]]
    cells.forEach(([k, v], i) => {
      const X = bx + (i % 2) * (bw / 2 + 4), Y = cStats.y + 8 + Math.floor(i / 2) * rowH + rowH / 2
      text(k, X, Y - 9 * u, 9, '#8b92aa'); text(String(v), X, Y + 15 * u, 20 * u, i === 0 ? '#c084fc' : '#e9ecf5', 'left', 700)
    })
    // danger meter
    const d = S.danger, ds = d ? clamp(d.score / 3, 0, 1) : 0
    card(p.x, cDanger.y, p.w, cDanger.h, 'DANGER')
    const by = cDanger.mid - 16 * u, bh = 12
    const segs = ['#34d399', '#fbbf24', '#fb923c', '#fb7185']
    segs.forEach((col, i) => { const on = ds * 3 >= i - 0.5; ctx.fillStyle = hexA(col, on ? 0.95 : 0.16); ctx.beginPath(); ctx.roundRect(bx + i * (bw / 4) + 1, by, bw / 4 - 2, bh, 3); ctx.fill() })
    const nx = bx + ds * bw, pulse = ds > 0.6 ? 0.6 + 0.4 * Math.sin(now / 110) : 1
    ctx.fillStyle = `rgba(255,255,255,${pulse})`; ctx.shadowColor = '#fff'; ctx.shadowBlur = 8
    ctx.beginPath(); ctx.roundRect(clamp(nx - 2, bx, bx + bw - 4), by - 5, 4, bh + 10, 2); ctx.fill(); ctx.shadowBlur = 0
    text(d ? d.label : 'waiting', bx, by + bh + 25 * u, 16 * u, d ? segs[clamp(Math.round(d.score), 0, 3)] : '#565d75', 'left', 700)
    text(d ? `${d.score.toFixed(2)} / 3` : '', bx + bw, by + bh + 25 * u, 11, '#8b92aa', 'right')
    // going for four
    const f = S.four ?? 0, on = f >= 0.5
    card(p.x, cFour.y, p.w, cFour.h, 'GOING FOR FOUR')
    const lr = 12 * u, lx = bx + lr + 4, ly = cFour.mid + 2
    if (on) { const a = 0.55 + 0.25 * Math.sin(now / 260); const rg = ctx.createRadialGradient(lx, ly, 2, lx, ly, lr * 2.6); rg.addColorStop(0, `rgba(94,234,212,${a})`); rg.addColorStop(1, 'rgba(94,234,212,0)'); ctx.fillStyle = rg; ctx.fillRect(lx - lr * 3, ly - lr * 3, lr * 6, lr * 6) }
    ctx.beginPath(); ctx.arc(lx, ly, lr, 0, 7); ctx.fillStyle = on ? '#5eead4' : '#141824'; ctx.fill(); ctx.strokeStyle = on ? '#a7f3e4' : '#2e3550'; ctx.lineWidth = 2; ctx.stroke()
    text(S.four == null ? '—' : on ? 'YES' : 'no', lx + lr + 12, ly + 1, 17 * u, on ? '#5eead4' : '#8b92aa', 'left', 700)
    text(S.four == null ? '' : `p ${f.toFixed(2)}`, bx + bw, ly + 1, 11, '#8b92aa', 'right')
    text(on ? 'keeping a column open' : 'clearing what it can', lx + lr + 12, ly + 16 * u, 9.5, '#565d75')
    // gravity
    card(p.x, cGrav.y, p.w, cGrav.h, 'GRAVITY')
    const gy = cGrav.mid - 12 * u
    text(g.gravity.toFixed(1), bx, gy + 4 * u, 26 * u, '#e9ecf5', 'left', 700)
    const gw = ctx.measureText(g.gravity.toFixed(1)).width
    text('rows/s', bx + gw + 6, gy + 4 * u, 10.5, '#8b92aa')
    text(S.cfg.pinned ? 'pinned by you' : `level ${g.level} · +${Math.round(S.cfg.speedup * 100)}% a level`, bx, gy + 22 * u, 9.5, S.cfg.pinned ? '#c084fc' : '#565d75')
    const ty = gy + 36 * u, lo = Math.log(0.2), hi = Math.log(S.cfg.maxGravity || 120)
    const at = (v) => bx + ((Math.log(clamp(v, 0.2, 120)) - lo) / (hi - lo)) * bw
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.roundRect(bx, ty, bw, 6, 3); ctx.fill()
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0); grad.addColorStop(0, '#7e22ce'); grad.addColorStop(0.75, '#c084fc'); grad.addColorStop(1, '#fb7185')
    ctx.fillStyle = grad; ctx.beginPath(); ctx.roundRect(bx, ty, Math.max(4, at(g.gravity) - bx), 6, 3); ctx.fill()
    const kx = at(knee()); ctx.fillStyle = '#fbbf24'; ctx.fillRect(kx - 1, ty - 5, 2, 16)
    text(`Jev's limit ${Math.round(knee())}`, clamp(kx, bx + 40, bx + bw - 40), ty + 25, 9.5, '#fbbf24', 'center')
  }

  /** Rows per second at which a wall placement no longer fits in the fall, for the stack as it is now. */
  function knee() {
    const free = Math.max(2, 18 - (S.game.maxHeight || 0))
    return free / ((S.cfg.decisionMs + 6 * S.cfg.moveMs) / 1000)
  }

  function drawMini(type, bx, by, bw, bh, alpha = 1) {
    const sh = shapes?.[type]?.[0]; if (!sh) return
    let x0 = 9, x1 = 0, y0 = 9, y1 = 0
    for (const [x, y] of sh) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    const m = Math.min(L.cell * 0.72, (bw - 20) / 4, (bh - 14) / 2)
    const ox = bx + (bw - (x1 - x0 + 1) * m) / 2, oy = by + (bh - (y1 - y0 + 1) * m) / 2
    const s = sprites[CODE[type]]
    for (const [x, y] of sh) {
      const X = ox + (x - x0) * m, Y = oy + (y - y0) * m
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7 * alpha; ctx.drawImage(s.glow, X - m * 0.7, Y - m * 0.7, m * 2.4, m * 2.4)
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = alpha; ctx.drawImage(s.body, X, Y, m, m)
    }
    ctx.globalAlpha = 1
  }

  function drawRight(now) {
    const p = L.right, u = clamp(L.u, 0.8, 1.15), g = S.game
    const [cNext, cTime, cGame, cSess] = stackCards(p, [236, 116, 80, 100])
    const bx = p.x + 12, bw = p.w - 24
    card(p.x, cNext.y, p.w, cNext.h, 'NEXT')
    text('click to change', p.x + p.w - 12, cNext.y + 19, 9, '#565d75', 'right')
    const boxH = (cNext.h - 28 - 10 - 14) / 3
    L.nextBoxes = []
    g.queue.forEach((t, i) => {
      const x = p.x + 10, y = cNext.y + 28 + i * (boxH + 7), w = p.w - 20
      const hot = hover.next === i, pulse = clamp(1 - (now - nextPulse[i]) / 380, 0, 1)
      ctx.fillStyle = hot ? 'rgba(192,132,252,.12)' : 'rgba(255,255,255,.025)'; ctx.strokeStyle = hot || pulse ? hexA('#c084fc', 0.5 + 0.5 * pulse) : '#232838'; ctx.lineWidth = 1 + pulse * 1.5
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, boxH - 1, 8); ctx.fill(); ctx.stroke()
      drawMini(t, x, y, w, boxH, i === 0 ? 1 : 0.8)
      text(String(i + 1), x + 8, y + 15, 9, '#565d75')
      L.nextBoxes.push({ x, y, w, h: boxH })
    })
    // time budget: the honest limit
    card(p.x, cTime.y, p.w, cTime.h, 'TIME BUDGET')
    if (mind) {
      const need = mind.needMs, have = mind.haveMs, late = need > have
      const max = Math.max(need * 1.6, Math.min(have, need * 3), 1)
      const by = cTime.mid - 30
      text('needs', bx, by + 1, 9.5, '#8b92aa'); text(fmtMs(need), bx + bw, by + 1, 11.5, '#e9ecf5', 'right', 700)
      ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.roundRect(bx, by + 6, bw, 7, 3); ctx.fill()
      const dw = Math.min(bw, (S.cfg.decisionMs / max) * bw), nw = Math.min(bw, (need / max) * bw)
      ctx.fillStyle = '#c084fc'; ctx.beginPath(); ctx.roundRect(bx, by + 6, dw, 7, 3); ctx.fill()
      ctx.fillStyle = '#60a5fa'; ctx.fillRect(bx + dw + 1, by + 6, Math.max(0, nw - dw - 1), 7)
      text('has', bx, by + 32, 9.5, '#8b92aa'); text(fmtMs(have), bx + bw, by + 32, 11.5, late ? '#fb7185' : '#34d399', 'right', 700)
      ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.roundRect(bx, by + 37, bw, 7, 3); ctx.fill()
      ctx.fillStyle = late ? '#fb7185' : '#34d399'; ctx.beginPath(); ctx.roundRect(bx, by + 37, clamp((have / max) * bw, 3, bw), 7, 3); ctx.fill()
      text(late ? 'the piece lands first' : 'think', bx, by + 60, 9, late ? '#fb7185' : '#c084fc')
      if (!late) { const tw = ctx.measureText('think').width; text('+ moves, before it lands', bx + tw + 6, by + 60, 9, '#60a5fa') }
    } else text('waiting for a piece', bx, cTime.mid, 10, '#565d75')
    // this game
    card(p.x, cGame.y, p.w, cGame.h, 'THIS GAME')
    const cols = [['MISSED', g.misses, g.misses ? '#fb7185' : '#e9ecf5'], ['FOURS', g.fours, g.fours ? '#5eead4' : '#e9ecf5'], ['HOLES', g.holes, g.holes > 4 ? '#fbbf24' : '#e9ecf5']]
    cols.forEach(([k, v, col], i) => { const X = bx + i * (bw / 3); text(k, X, cGame.mid - 6 * u, 8.5, '#8b92aa'); text(String(v), X, cGame.mid + 16 * u, 18 * u, col, 'left', 700) })
    // session
    card(p.x, cSess.y, p.w, cSess.h, 'SESSION')
    const best = Math.max(S.session.best, g.lines), sy = cSess.mid - 14
    text(`game ${g.n}`, bx, sy, 12, '#e9ecf5', 'left', 700); text(`${S.session.topOuts} top-out${S.session.topOuts === 1 ? '' : 's'}`, bx + bw, sy, 10.5, S.session.topOuts ? '#fb7185' : '#8b92aa', 'right')
    text('best', bx, sy + 20, 9.5, '#8b92aa'); text(`${fmt(best)} lines`, bx + bw, sy + 20, 12, '#c084fc', 'right', 700)
    text('client', bx, sy + 40, 9.5, '#8b92aa'); text(S.client === 'typesafe' ? 'LIVE Jev' : 'offline MOCK', bx + bw, sy + 40, 10.5, S.client === 'typesafe' ? '#34d399' : '#fbbf24', 'right', 700)
  }

  // ------------------------------------------------------------------ the well
  function drawWell(now, dt) {
    const w = L.well, c = L.cell
    const danger = S.danger ? clamp(S.danger.score / 3, 0, 1) : 0
    const hot = clamp((danger - 0.45) * 2, 0, 1)
    // ambient light behind the well
    const amb = ctx.createRadialGradient(w.x + w.w / 2, w.y + w.h * 0.55, 20, w.x + w.w / 2, w.y + w.h * 0.55, w.h * 0.85)
    const pulse = hot > 0.3 ? 0.75 + 0.25 * Math.sin(now / 170) : 1
    amb.addColorStop(0, `rgba(${Math.round(lerp(126, 225, hot))},${Math.round(lerp(34, 29, hot))},${Math.round(lerp(206, 72, hot))},${(0.2 + hot * 0.16) * pulse})`); amb.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = amb; ctx.fillRect(0, 0, L.w, L.h)

    ctx.save()
    if (shake > 0.2) ctx.translate(Math.sin(now / 17) * shake, Math.cos(now / 13) * shake * 0.7)
    // frame
    const edge = `rgb(${Math.round(lerp(192, 251, hot))},${Math.round(lerp(132, 113, hot))},${Math.round(lerp(252, 133, hot))})`
    ctx.shadowColor = edge; ctx.shadowBlur = 26 * pulse; ctx.strokeStyle = edge; ctx.lineWidth = 2
    ctx.beginPath(); ctx.roundRect(w.x - 5, w.y - 5, w.w + 10, w.h + 10, 8); ctx.stroke(); ctx.shadowBlur = 0
    ctx.fillStyle = '#060710'; ctx.beginPath(); ctx.roundRect(w.x - 4, w.y - 4, w.w + 8, w.h + 8, 7); ctx.fill()
    ctx.beginPath(); ctx.rect(w.x, w.y, w.w, w.h); ctx.clip()
    const bg = ctx.createLinearGradient(0, w.y, 0, w.y + w.h); bg.addColorStop(0, '#0a0b16'); bg.addColorStop(1, '#0d0a1a')
    ctx.fillStyle = bg; ctx.fillRect(w.x, w.y, w.w, w.h)
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1; ctx.beginPath()
    for (let x = 1; x < W; x++) { ctx.moveTo(cx(x) + 0.5, w.y); ctx.lineTo(cx(x) + 0.5, w.y + w.h) }
    for (let y = 1; y < H; y++) { ctx.moveTo(w.x, cy(y) + 0.5); ctx.lineTo(w.x + w.w, cy(y) + 0.5) }
    ctx.stroke()
    // hover column
    if (hover.col >= 0 && !S.finished) {
      const hg = ctx.createLinearGradient(0, w.y, 0, w.y + w.h); hg.addColorStop(0, 'rgba(154,166,191,.2)'); hg.addColorStop(1, 'rgba(154,166,191,.03)')
      ctx.fillStyle = hg; ctx.fillRect(cx(hover.col), w.y, c, w.h)
      let top = 0; while (top < H && !board[top * W + hover.col]) top++
      if (top > 0) drawBlock(9, hover.col, top - 1, 0.5 + 0.2 * Math.sin(now / 160), 0)
    }

    if (collapse) drawCollapse(now, dt)
    else {
      drawBoard(now)
      if (showMind) drawMind(now)
      drawPiece(now, dt)
      drawDrop(now)
      drawJunks(now)
      drawFlashes(now)
    }
    drawSweep(now)
    drawParticles(dt)
    drawTexts(now)
    if (flash) { const t = (now - flash.t0) / flash.dur; if (t >= 1) flash = null; else if (t >= 0) { ctx.fillStyle = `rgba(${flash.color},${flash.alpha * (1 - t)})`; ctx.fillRect(w.x, w.y, w.w, w.h) } }
    const iv = clamp((now - intro) / 450, 0, 1); if (iv < 1) { ctx.fillStyle = `rgba(6,7,16,${1 - iv})`; ctx.fillRect(w.x, w.y, w.w, w.h) }
    ctx.restore()
    if (S.finished) drawBanner(now)
  }

  function drawBoard(now) {
    let src = board, rowShift = null, flashRows = null, ft = 0
    if (clearAnim) {
      const t = (now - clearAnim.t0) / clearAnim.dur
      if (t >= 1) {
        const map = new Array(H).fill(0); let cnt = 0
        for (let y = H - 1; y >= 0; y--) { if (clearAnim.rows.includes(y)) cnt++; else if (y + cnt < H) map[y + cnt] = cnt }
        fallAnim = { map, t0: now, dur: 150 / rate() }; clearAnim = null
      } else { src = clearAnim.board; if (t >= 0) { flashRows = clearAnim.rows; ft = t; if (!clearAnim.burst) { clearAnim.burst = true; burst(clearAnim) } } }
    }
    if (fallAnim) { const t = (now - fallAnim.t0) / fallAnim.dur; if (t >= 1) fallAnim = null; else rowShift = fallAnim.map.map((k) => -k * (1 - easeOut(clamp(t, 0, 1)))) }
    let lift = 0
    if (rise) { const t = (now - rise.t0) / rise.dur; if (t >= 1) rise = null; else lift = 1 - easeOut(t) }
    const hide = new Set()
    if (drop) for (const [x, y] of drop.cells) hide.add(y * W + x)
    for (const j of junks) hide.add(j.row * W + j.col)
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++) {
        const dy = (rowShift ? rowShift[y] : 0) + lift
        for (let x = 0; x < W; x++) {
          const code = src[y * W + x]
          if (!code || hide.has(y * W + x)) continue
          if (flashRows && flashRows.includes(y) && Math.abs(x - 4.5) < ft * 6.5) continue // wiped from the middle out
          const s = sprites[code], X = cx(x), Y = cy(y + dy), c = L.cell
          if (pass === 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.85; ctx.drawImage(s.glow, X - c * 0.7, Y - c * 0.7, c * 2.4, c * 2.4); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1 } else ctx.drawImage(s.body, X, Y, c, c)
        }
      }
    }
    if (flashRows) {
      const w = L.well, c = L.cell
      for (const y of flashRows) {
        const half = clamp(ft * 6.5, 0, 5) * c, mid = w.x + w.w / 2
        ctx.globalCompositeOperation = 'lighter'
        const g = ctx.createLinearGradient(mid - half - c, 0, mid + half + c, 0)
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.15, `rgba(255,255,255,${0.95 * (1 - ft * 0.5)})`); g.addColorStop(0.85, `rgba(255,255,255,${0.95 * (1 - ft * 0.5)})`); g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g; ctx.fillRect(mid - half - c, cy(y) + c * 0.12, 2 * (half + c), c * 0.76)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
  }

  function burst(a) {
    const n = a.rows.length, c = L.cell
    shake = Math.max(shake, [0, 3, 5, 7, 13][n] || 4)
    if (n === 4) flash = { t0: performance.now(), dur: 420, color: '255,255,255', alpha: 0.5 }
    for (const y of a.rows) for (let x = 0; x < W; x++) {
      const code = a.board[y * W + x] || 8
      for (let k = 0; k < (n === 4 ? 5 : 3); k++) {
        const ang = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 260) * (n === 4 ? 1.5 : 1)
        particles.push({ x: cx(x) + c / 2, y: cy(y) + c / 2, vx: Math.cos(ang) * sp + (x - 4.5) * 22, vy: Math.sin(ang) * sp - 120, life: 0, max: 0.45 + Math.random() * 0.55, color: COLORS[code], size: c * (0.1 + Math.random() * 0.16) })
      }
    }
    const mid = a.rows.reduce((s, y) => s + y, 0) / n
    texts.push({ text: n === 4 ? 'FOUR!' : ['', 'SINGLE', 'DOUBLE', 'TRIPLE'][n], x: 5, y: mid + 0.5, t0: performance.now(), dur: n === 4 ? 1200 : 750, color: n === 4 ? '#5eead4' : '#e9ecf5', size: n === 4 ? 1.7 : 0.8, center: true, grow: n === 4 })
    if (a.gain) texts.push({ text: '+' + fmt(a.gain), x: 5, y: mid + (n === 4 ? 2.1 : 1.5), t0: performance.now() + 60, dur: 900, color: '#c084fc', size: 0.66, center: true })
    if (particles.length > 900) particles.splice(0, particles.length - 900)
  }

  function drawMind(now) {
    if (!mind || !shapes) return
    if (mindFade.id !== mind.pieceId) return
    const P = S.piece
    if (mindFade.start == null && P && P.id === mind.pieceId && P.moved > 0) mindFade.start = simNow()
    if (mindFade.start == null && (!P || P.id !== mind.pieceId)) mindFade.start = simNow()
    let a = clamp((now - mindFade.born) / 90, 0, 1)
    if (mindFade.start != null) { const e = simNow() - mindFade.start; a *= e < 0 ? 0 : clamp(1 - e / FADE_MS, 0, 1) }
    if (a <= 0.01) return
    const code = CODE[mind.type], color = COLORS[code], c = L.cell
    // every placement, as light. Overlaps add up, so the surface glows where Jev's belief is.
    ctx.globalCompositeOperation = 'lighter'
    for (const k of mind.cands) {
      const al = a * Math.min(0.62, Math.pow(k.p, 0.85) * 0.8 + 0.012)
      if (al < 0.006) continue
      ctx.fillStyle = hexA(color, al)
      for (const [x, y] of cellsOf(mind.type, k.r, k.x, k.y)) if (y >= 0) { ctx.beginPath(); ctx.roundRect(cx(x) + 1.5, cy(y) + 1.5, c - 3, c - 3, c * 0.14); ctx.fill() }
    }
    ctx.globalCompositeOperation = 'source-over'
    // the top three, outlined and labelled
    const top = mind.cands.slice(0, 3).filter((k) => k.p >= 0.02)
    const placed = []
    top.slice().reverse().forEach((k) => {
      const chosen = k.id === mind.chosen
      const cells = cellsOf(mind.type, k.r, k.x, k.y).filter(([, y]) => y >= 0)
      if (chosen) {
        const xs = cells.map(([x]) => x), x0 = Math.min(...xs), x1 = Math.max(...xs), yTop = Math.min(...cells.map(([, y]) => y))
        const beam = ctx.createLinearGradient(0, L.well.y, 0, cy(yTop)); beam.addColorStop(0, hexA(color, 0)); beam.addColorStop(1, hexA(color, 0.16 * a * (0.4 + mind.confidence)))
        ctx.fillStyle = beam; ctx.fillRect(cx(x0), L.well.y, (x1 - x0 + 1) * c, cy(yTop) - L.well.y)
      }
      outline(cells, chosen ? 1 : 2.5)
      ctx.lineCap = 'round'
      if (chosen) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 14 * (0.5 + mind.confidence); ctx.strokeStyle = `rgba(255,255,255,${0.95 * a})`; ctx.lineWidth = 2.4 } else { ctx.strokeStyle = hexA(color, 0.75 * a); ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]) }
      ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([])
    })
    top.forEach((k) => {
      const chosen = k.id === mind.chosen
      const cells = cellsOf(mind.type, k.r, k.x, k.y).filter(([, y]) => y >= 0); if (!cells.length) return
      const xs = cells.map(([x]) => x), ys = cells.map(([, y]) => y)
      const label = `${Math.round(k.p * 100)}%`
      const fs = Math.max(10, c * (chosen ? 0.5 : 0.42))
      ctx.font = `700 ${Math.round(fs)}px ${FONT}`
      const tw = ctx.measureText(label).width + fs * 0.9, th = fs * 1.5
      let bx = clamp(cx((Math.min(...xs) + Math.max(...xs) + 1) / 2) - tw / 2, L.well.x + 2, L.well.x + L.well.w - tw - 2)
      let by = cy(Math.min(...ys)) - th - 5
      for (let guard = 0; guard < 8 && placed.some((r) => bx < r.x + r.w + 3 && bx + tw + 3 > r.x && by < r.y + r.h + 2 && by + th + 2 > r.y); guard++) by -= th + 3
      by = Math.max(L.well.y + 2, by)
      placed.push({ x: bx, y: by, w: tw, h: th })
      ctx.globalAlpha = a
      ctx.fillStyle = chosen ? '#ffffff' : 'rgba(10,11,20,.88)'; ctx.strokeStyle = chosen ? '#ffffff' : hexA(color, 0.9); ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.roundRect(bx, by, tw, th, th / 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = chosen ? '#0b0d14' : color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + tw / 2, by + th / 2 + 0.5)
      ctx.globalAlpha = 1
    })
  }

  function drawPiece(now, dt) {
    const P = S.piece
    if (!P || !shapes) { if (!drop) disp = null; return }
    const r = rate()
    if (!disp || disp.id !== P.id) disp = { id: P.id, type: P.type, rot: P.rot, x: P.x, y: P.y + P.frac, pop: 1 }
    const live = S.running ? 1 : 3
    disp.x += (P.x - disp.x) * (1 - Math.exp((-dt * 1000 * r * live) / 30))
    const ty = P.y + P.frac
    if (ty < disp.y - 0.05 || ty - disp.y > 6) disp.y = ty; else disp.y += (ty - disp.y) * (1 - Math.exp((-dt * 1000 * r * live) / 38))
    if (disp.rot !== P.rot) { disp.rot = P.rot; disp.pop = 1 }
    disp.pop = Math.max(0, disp.pop - dt * 7 * r)
    const code = CODE[P.type]
    // where it would land from here
    const ghost = cellsOf(P.type, P.rot, P.x, P.ghostY).filter(([, y]) => y >= 0)
    if (ghost.length && P.ghostY - disp.y > 0.6) { outline(ghost, 2); ctx.strokeStyle = hexA(COLORS[code], 0.55); ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = hexA(COLORS[code], 0.07); for (const [x, y] of ghost) ctx.fillRect(cx(x) + 2, cy(y) + 2, L.cell - 4, L.cell - 4) }
    const cells = cellsOf(P.type, disp.rot, disp.x, disp.y)
    for (const [x, y] of cells) drawBlock(code, x, y, 1, 1.5 + disp.pop)
    if (P.phase === 'think') { // Jev is thinking: a soft ring of light on the piece
      const mx = cells.reduce((s, q) => s + q[0], 0) / cells.length + 0.5, my = cells.reduce((s, q) => s + q[1], 0) / cells.length + 0.5
      const rr = L.cell * (1.6 + 0.25 * Math.sin(now / 60))
      const g = ctx.createRadialGradient(cx(mx), cy(my), rr * 0.3, cx(mx), cy(my), rr); g.addColorStop(0, 'rgba(255,255,255,.0)'); g.addColorStop(0.8, 'rgba(255,255,255,.14)'); g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(cx(mx) - rr, cy(my) - rr, rr * 2, rr * 2); ctx.globalCompositeOperation = 'source-over'
    }
  }

  function drawDrop(now) {
    if (!drop) return
    const t = (now - drop.t0) / drop.dur
    if (t >= 1) { dust(drop); drop = null; return }
    const e = clamp(t, 0, 1), ex = easeOut(clamp(e / 0.55, 0, 1)), ey = e * e
    const x = lerp(drop.x0, drop.x1, ex), y = lerp(drop.y0, drop.y1, ey)
    const code = CODE[drop.type], c = L.cell
    // streak of light behind the falling piece
    for (const [px, py] of cellsOf(drop.type, drop.rot, x, y)) {
      const len = Math.min(py - drop.y0 + 1, 7) * c * ey
      if (len > 2) { const g = ctx.createLinearGradient(0, cy(py) - len, 0, cy(py) + c * 0.5); g.addColorStop(0, hexA(COLORS[code], 0)); g.addColorStop(1, hexA(COLORS[code], 0.5)); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(cx(px) + 2, cy(py) - len, c - 4, len + c * 0.5); ctx.globalCompositeOperation = 'source-over' }
    }
    for (const [px, py] of cellsOf(drop.type, drop.rot, x, y)) drawBlock(code, px, py, 1, 2)
  }

  function dust(d) {
    const c = L.cell, code = CODE[d.type]
    const bottoms = new Map()
    for (const [x, y] of d.cells) bottoms.set(x, Math.max(bottoms.get(x) ?? -1, y))
    for (const [x, y] of bottoms) for (let k = 0; k < 3; k++) particles.push({ x: cx(x) + Math.random() * c, y: cy(y + 1) - 2, vx: (Math.random() - 0.5) * 160, vy: -30 - Math.random() * 110, life: 0, max: 0.25 + Math.random() * 0.3, color: COLORS[code], size: c * (0.06 + Math.random() * 0.08) })
    shake = Math.max(shake, 1.6)
  }

  function drawJunks(now) {
    junks = junks.filter((j) => now - j.t0 < j.dur)
    for (const j of junks) {
      const t = clamp((now - j.t0) / j.dur, 0, 1), y = lerp(-1, j.row, t * t), c = L.cell
      const g = ctx.createLinearGradient(0, cy(y) - c * 4, 0, cy(y) + c); g.addColorStop(0, 'rgba(154,166,191,0)'); g.addColorStop(1, 'rgba(154,166,191,.45)')
      ctx.fillStyle = g; ctx.fillRect(cx(j.col) + 3, cy(y) - c * 4, c - 6, c * 4.5)
      drawBlock(9, j.col, y, 1, 1)
    }
  }

  function drawFlashes(now) {
    if (lockFlash) {
      const t = (now - lockFlash.t0) / lockFlash.dur
      if (t >= 1) lockFlash = null
      else if (t >= 0) { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lockFlash.missed ? `rgba(251,113,133,${0.85 * (1 - t)})` : `rgba(255,255,255,${0.6 * (1 - t)})`; for (const [x, y] of lockFlash.cells) { ctx.beginPath(); ctx.roundRect(cx(x) + 1, cy(y) + 1, L.cell - 2, L.cell - 2, L.cell * 0.14); ctx.fill() } ctx.globalCompositeOperation = 'source-over' }
    }
    if (want) {
      const t = (now - want.t0) / want.dur
      if (t >= 1) want = null
      else { const cells = cellsOf(want.type, want.rot, want.x, want.y).filter(([, y]) => y >= 0); outline(cells, 2); ctx.setLineDash([5, 4]); ctx.strokeStyle = `rgba(251,113,133,${0.95 * (1 - t * t)})`; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]) }
    }
  }

  function drawSweep(now) {
    if (!sweep) return
    const t = (now - sweep.t0) / sweep.dur
    if (t >= 1) { sweep = null; return }
    const w = L.well, y = w.y + w.h * (1 - easeOut(t)), bandH = L.cell * 3
    const g = ctx.createLinearGradient(0, y - bandH, 0, y + bandH); g.addColorStop(0, 'rgba(192,132,252,0)'); g.addColorStop(0.5, `rgba(216,180,254,${0.55 * (1 - t)})`); g.addColorStop(1, 'rgba(192,132,252,0)')
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(w.x, y - bandH, w.w, bandH * 2); ctx.globalCompositeOperation = 'source-over'
    const a = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85
    ctx.globalAlpha = clamp(a, 0, 1)
    ctx.shadowColor = '#c084fc'; ctx.shadowBlur = 18
    text(`LEVEL ${sweep.level}`, w.x + w.w / 2, w.y + L.cell * 4.2, L.cell * 0.95, '#f3e8ff', 'center', 800)
    ctx.shadowBlur = 0
    text(`${sweep.g.toFixed(1)} rows/s`, w.x + w.w / 2, w.y + L.cell * 5.2, L.cell * 0.46, '#c084fc', 'center', 600)
    ctx.globalAlpha = 1
  }

  function drawParticles(dt) {
    if (!particles.length) return
    ctx.globalCompositeOperation = 'lighter'
    for (const p of particles) {
      p.life += dt; p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt
      const a = 1 - p.life / p.max; if (a <= 0) continue
      ctx.fillStyle = hexA(p.color, a); ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
    }
    ctx.globalCompositeOperation = 'source-over'
    particles = particles.filter((p) => p.life < p.max)
  }

  function drawTexts(now) {
    texts = texts.filter((t) => now - t.t0 < t.dur)
    for (const t of texts) {
      const k = (now - t.t0) / t.dur; if (k < 0) continue
      const a = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88
      const size = L.cell * t.size * (t.grow ? 0.7 + 0.5 * easeOut(Math.min(1, k * 3)) : 1)
      ctx.globalAlpha = clamp(a, 0, 1); ctx.shadowColor = t.color; ctx.shadowBlur = t.grow ? 24 : 10
      const X = clamp(cx(t.x), L.well.x + size * 2.2, L.well.x + L.well.w - size * 2.2)
      text(t.text, t.center ? cx(t.x) : X, cy(t.y) - k * L.cell * 1.3, size, t.color, 'center', 800)
      ctx.shadowBlur = 0; ctx.globalAlpha = 1
    }
  }

  function drawCollapse(now, dt) {
    const c = L.cell, el = now - collapse.t0
    for (const b of collapse.blocks) {
      const live = el > b.delay
      if (live) { b.vy += 30 * dt; b.fx += b.vx * dt; b.fy += b.vy * dt; b.rot += b.vr * dt }
      if (b.fy > H + 2) continue
      const s = sprites[live ? 8 : b.c]
      ctx.save(); ctx.translate(cx(b.fx) + c / 2, cy(b.fy) + c / 2); ctx.rotate(b.rot)
      ctx.globalAlpha = live ? clamp(1.2 - (el - b.delay) / 1500, 0, 1) : 1
      ctx.drawImage(s.body, -c / 2, -c / 2, c, c); ctx.restore(); ctx.globalAlpha = 1
    }
  }

  function drawBanner(now) {
    const w = L.well, f = S.finished, c = L.cell
    const bh = c * 5.6, by = w.y + w.h / 2 - bh / 2
    ctx.save(); ctx.globalAlpha = collapse ? clamp((now - collapse.t0 - 350) / 300, 0, 1) : 1
    ctx.fillStyle = 'rgba(8,8,16,.84)'; ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 1.5; ctx.shadowColor = '#fb7185'; ctx.shadowBlur = 24
    ctx.beginPath(); ctx.roundRect(w.x + 8, by, w.w - 16, bh, 12); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0
    text('TOPPED OUT', w.x + w.w / 2, by + c * 1.5, c * 0.92, '#fb7185', 'center', 800)
    text(`${fmt(f.lines)} lines · ${fmt(f.pieces)} pieces`, w.x + w.w / 2, by + c * 2.7, c * 0.5, '#e9ecf5', 'center', 700)
    text(`at ${f.gravity.toFixed(1)} rows/s${f.record && f.lines ? ' · new best' : ''}`, w.x + w.w / 2, by + c * 3.55, c * 0.42, f.record && f.lines ? '#c084fc' : '#8b92aa', 'center', 600)
    const left = S.running ? Math.max(0, f.restartInMs - (now - simWall)) : f.restartInMs
    text(S.running ? `next game in ${(left / 1000).toFixed(1)} s` : 'paused · Step or Resume for the next game', w.x + w.w / 2, by + c * 4.7, c * 0.4, '#8b92aa', 'center', 600)
    ctx.restore()
  }

  // ------------------------------------------------------------------ the frame loop
  function frame(now) {
    requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - last) / 1000); last = now
    if (!L || L.w !== wrap.clientWidth || L.h !== wrap.clientHeight || dpr !== Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))) layout()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, L.w, L.h)
    if (!S || !shapes) { text('connecting…', L.w / 2, L.h / 2, 13, '#8b92aa', 'center'); return }
    shake *= Math.exp(-dt * 9)
    drawWell(now, dt)
    drawLeft(now)
    drawRight(now)
  }

  // ------------------------------------------------------------------ DOM
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v }
  const fmtMoney = (v) => (v <= 0 ? '$0' : v < 1 ? '$' + v.toFixed(v < 0.01 ? 5 : 4) : '$' + v.toFixed(2))
  const G_LO = 0.2, T_LO = 30, T_HI = 1000
  const gHi = () => (S && S.cfg.maxGravity) || 120
  const sliderToG = (v) => G_LO * Math.pow(gHi() / G_LO, v / 1000)
  const gToSlider = (g) => Math.round((Math.log(g / G_LO) / Math.log(gHi() / G_LO)) * 1000)
  const sliderToT = (v) => T_LO * Math.pow(T_HI / T_LO, v / 1000)
  const tToSlider = (t) => Math.round((Math.log(t / T_LO) / Math.log(T_HI / T_LO)) * 1000)

  function renderDom() {
    if (!S) return
    const g = S.game
    setText($('title'), S.title || 'Jev Blocks'); document.title = S.title || 'Jev Blocks'
    setText($('sLines'), fmt(g.lines)); setText($('sLpm'), g.lpm ? g.lpm.toFixed(0) : '—'); setText($('sPieces'), fmt(S.session.pieces)); setText($('sBest'), fmt(Math.max(S.session.best, g.lines)))
    setText($('pause'), S.running ? 'Pause' : 'Resume'); $('pause').classList.toggle('on', !S.running)
    $('slow').classList.toggle('on', !!S.slow)
    const err = S.error || (S.warnings && S.warnings[0]) || (S.jevError ? 'Jev: ' + S.jevError : '')
    $('cfgError').classList.toggle('hidden', !err); setText($('cfgError'), err || '')
    if (!dragging.gravity) { $('gravity').value = gToSlider(g.gravity); setText($('gravityVal'), g.gravity.toFixed(1)) }
    if (!dragging.think) { $('think').value = tToSlider(S.cfg.decisionMs); setText($('thinkVal'), String(Math.round(S.cfg.decisionMs))) }
    $('pinTag').classList.toggle('hidden', !S.cfg.pinned)
    setText($('kneeVal'), String(Math.round(knee())))
    if (S.logSeq !== logSeq) {
      logSeq = S.logSeq
      const ul = $('log'), seen = Number(ul.dataset.seen || 0)
      ul.replaceChildren(...logLines.slice().reverse().map((l) => { const li = document.createElement('li'); li.className = l.kind + (l.seq > seen ? ' fresh' : ''); const n = document.createElement('span'); n.className = 'n'; n.textContent = String(l.lines); const t = document.createElement('span'); t.textContent = l.text; li.append(n, t); return li }))
      ul.dataset.seen = String(logLines.length ? logLines[logLines.length - 1].seq : 0)
      setText($('logMeta'), 'lines · event')
    }
  }

  async function pollJev() {
    try { const r = await fetch('/jev', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); setText($('sDps'), j.questionsPerSec >= 10 ? String(Math.round(j.questionsPerSec)) : j.questionsPerSec.toFixed(1)); setText($('sCost'), fmtMoney(j.costUsd)) } } catch { /* restarting */ }
    setTimeout(pollJev, 400)
  }

  // ------------------------------------------------------------------ input
  function pick(ev) {
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top
    const out = { col: -1, next: -1 }
    if (!L) return out
    const w = L.well
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) out.col = clamp(Math.floor((x - w.x) / L.cell), 0, W - 1)
    L.nextBoxes.forEach((b, i) => { if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) out.next = i })
    return out
  }
  canvas.addEventListener('mousemove', (ev) => { hover = pick(ev); wrap.classList.toggle('hot', hover.col >= 0 || hover.next >= 0) })
  canvas.addEventListener('mouseleave', () => { hover = { col: -1, next: -1 }; wrap.classList.remove('hot') })
  canvas.addEventListener('click', (ev) => { const h = pick(ev); if (h.next >= 0) post({ cmd: 'cycleNext', index: h.next }); else if (h.col >= 0) post({ cmd: 'junk', col: h.col }) })

  let sendTimer = null
  const sendSoon = (body) => { clearTimeout(sendTimer); sendTimer = setTimeout(() => post(body), 40) }
  $('gravity').addEventListener('input', (e) => { dragging.gravity = true; const g = sliderToG(Number(e.target.value)); setText($('gravityVal'), g.toFixed(1)); sendSoon({ cmd: 'set', gravity: +g.toFixed(2) }) })
  $('think').addEventListener('input', (e) => { dragging.think = true; const t = sliderToT(Number(e.target.value)); setText($('thinkVal'), String(Math.round(t))); sendSoon({ cmd: 'set', decisionMs: Math.round(t) }) })
  for (const k of ['gravity', 'think']) for (const evn of ['change', 'pointerup', 'blur']) $(k).addEventListener(evn, () => setTimeout(() => { dragging[k] = false }, 150))
  $('pinTag').addEventListener('click', () => post({ cmd: 'set', gravity: null }))
  $('pinTag').title = 'Click to let gravity follow the level again'
  $('pause').addEventListener('click', () => post({ cmd: S && S.running ? 'pause' : 'start' }))
  $('step').addEventListener('click', () => post({ cmd: 'tick' }))
  $('reset').addEventListener('click', () => post({ cmd: 'reset' }))
  $('garbage').addEventListener('click', () => post({ cmd: 'garbage' }))
  $('slow').addEventListener('click', () => post({ cmd: 'set', slow: !(S && S.slow) }))
  $('mind').addEventListener('click', () => { showMind = !showMind; $('mind').classList.toggle('on', showMind) })
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range') return
    const k = e.key.toLowerCase()
    if (k === ' ') { e.preventDefault(); $('pause').click() } else if (k === 's') $('step').click(); else if (k === 'g') $('garbage').click(); else if (k === 'm') $('mind').click(); else if (k === 'r') $('reset').click()
  })

  // ------------------------------------------------------------------ go
  if (window.innerHeight < 1000) $('how').open = false // keep the game log on screen in a short pane
  new ResizeObserver(() => { L = null }).observe(wrap)
  fetch('/state').then((r) => r.json()).then(onFrame).catch(() => {})
  const es = new EventSource('/events')
  es.addEventListener('state', (ev) => { try { onFrame(JSON.parse(ev.data)) } catch (e) { console.error(e) } })
  pollJev()
  requestAnimationFrame(frame)
})()
