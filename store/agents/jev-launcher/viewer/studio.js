// Jev Launcher pane. The input is the hero: every key goes to the server, Jev ranks the palette,
// and the reply carries the new ranking, so the rows re-sort inside one round trip. The server
// sends one frame per ranking; this file renders at 60 fps and eases everything between frames:
// row positions (rows glide to their new rank), probability bars, the confidence beam, the
// key-by-key "mind tape", sparks from the caret and a burst on every launch.
'use strict'

const $ = (id) => document.getElementById(id)
const stage = $('stage'), palette = $('palette'), rowsBox = $('rows'), input = $('query'), wrap = $('inputWrap')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const hueOf = (i) => `hsl(${Math.round((255 + i * 137.5) % 360)} 78% 66%)`

const S = {
  f: null, epoch: -1, lastSeq: -1, mode: 'demo', humanAt: -1e9, sel: 0, order: [], visible: 10, rowH: 42,
  rows: new Map(), names: '', hist: [], shift: 0, lastLaunch: 0, energy: 0, rtt: null, reqN: 0,
  beam: 0, beamTo: 0, bylen: [], paused: false, logKey: '', subKey: '', jev: null, shownCalls: 0,
}
const sparks = [], rings = []

// ---------------------------------------------------------------- talking to the server
async function post(body) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(String(r.status))
    return await r.json()
  } catch (e) { console.error('control failed', e); return null }
}
async function send(body) { const r = await post(body); if (r?.frame) applyFrame(r.frame) }

async function sendQuery() {
  const my = ++S.reqN, t0 = performance.now()
  const r = await post({ cmd: 'query', query: input.value })
  if (!r?.frame || my !== S.reqN) return // a newer key is already on its way
  applyFrame(r.frame)
  // Measured to the next painted frame, so it is what the person actually sees.
  requestAnimationFrame(() => { S.rtt = performance.now() - t0; setStat('s-rtt', S.rtt < 10 ? S.rtt.toFixed(1) + ' ms' : Math.round(S.rtt) + ' ms') })
}

// ---------------------------------------------------------------- rows
function buildRows(f) {
  const names = f.targets.map((t) => t.name).join('\n')
  if (names === S.names) return false
  S.names = names
  for (const r of S.rows.values()) r.el.remove()
  S.rows.clear()
  f.targets.forEach((t, i) => {
    const el = document.createElement('div')
    el.className = 'row'; el.setAttribute('role', 'option'); el.style.setProperty('--hue', hueOf(i))
    el.innerHTML = '<span class="rk"></span><span class="hue"></span><span class="nm"></span><span class="cat"></span><span class="via"></span><span class="bar"><i></i></span><span class="pct"></span>'
    const q = (c) => el.querySelector(c)
    const r = { el, t, i, rk: q('.rk'), nm: q('.nm'), cat: q('.cat'), via: q('.via'), fill: q('.bar i'), pct: q('.pct'), y: i * S.rowH, ty: i * S.rowH, p: 0, tp: 0, o: 0, to: 1, key: '', pctText: '', rkText: '' }
    r.cat.textContent = t.category
    el.title = 'Click to mark this as the right answer'
    el.addEventListener('mousedown', (e) => e.preventDefault()) // keep the caret in the input
    el.addEventListener('click', () => { S.mode = 'human'; S.humanAt = performance.now(); send({ cmd: 'mark', name: t.name }) })
    rowsBox.appendChild(el)
    S.rows.set(t.name, r)
  })
  return true
}

/** Wrap what the query matched in <mark>. Returns null when nothing in `text` matched. */
function highlight(text, tokens) {
  const low = text.toLowerCase()
  const spans = []
  for (const tok of tokens) { const at = low.indexOf(tok); if (at >= 0) spans.push([at, at + tok.length]) }
  if (!spans.length) return null
  spans.sort((a, b) => a[0] - b[0])
  let out = '', pos = 0
  for (const [a, b] of spans) { if (a < pos) continue; out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b }
  return out + esc(text.slice(pos))
}

function paintRowText(r, f, tokens) {
  const judged = f.judge && f.judge.name === r.t.name ? f.judge : null
  const wanted = f.mode === 'demo' && f.demo.intent === r.t.name
  const key = [f.query, judged ? judged.ok + ':' + judged.place : '', wanted].join('|')
  if (key === r.key) return
  r.key = key
  const nameHit = tokens.length ? highlight(r.t.name, tokens) : null
  r.nm.innerHTML = nameHit ?? esc(r.t.name)
  let via = ''
  if (judged) via += `<span class="flag ${judged.ok ? 'ok' : 'miss'}">${judged.ok ? '✓ right answer · Jev had it first' : `right answer · Jev had it #${judged.place}`}</span>`
  else if (wanted) via += '<span class="flag want">◎ the typist wants this</span>'
  if (r.t.twin) via += '<span class="flag twin">look-alike</span>'
  let aliasHit = null
  if (tokens.length && !nameHit) for (const a of r.t.aliases) { aliasHit = highlight(a, tokens); if (aliasHit) break }
  via += aliasHit ? 'via ' + aliasHit : esc(r.t.aliases.slice(0, 4).join(' · '))
  r.via.innerHTML = via
  r.el.classList.toggle('judged-ok', !!judged && judged.ok)
  r.el.classList.toggle('judged-miss', !!judged && !judged.ok)
}

function layoutRows() {
  // As many rows as fit, then stretched a little so they fill the box with no dead strip below.
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 42
  const n = S.rows.size || 12
  S.visible = Math.max(3, Math.min(n, Math.floor(rowsBox.clientHeight / base)))
  S.rowH = clamp(rowsBox.clientHeight / S.visible, base, base * 1.3)
  rowsBox.style.setProperty('--row-h', S.rowH.toFixed(2) + 'px')
  if (S.f) placeRows(S.f)
}

function placeRows(f) {
  const sorted = [...S.rows.values()].sort((a, b) => (f.rank[b.t.name] ?? 0) - (f.rank[a.t.name] ?? 0) || a.i - b.i)
  S.order = sorted.map((r) => r.t.name)
  S.sel = clamp(S.sel, 0, Math.min(S.visible, sorted.length) - 1)
  const conf = clamp(f.mind.confidence, 0, 1)
  sorted.forEach((r, k) => {
    const shown = k < S.visible
    r.ty = (shown ? k : S.visible) * S.rowH
    r.to = shown ? 1 : 0
    r.tp = f.rank[r.t.name] ?? 0
    const rk = String(k + 1)
    if (rk !== r.rkText) { r.rkText = rk; r.rk.textContent = rk }
    r.el.classList.toggle('top', k === 0)
    r.el.classList.toggle('sel', S.mode === 'human' && k === S.sel)
    r.el.setAttribute('aria-selected', k === S.sel ? 'true' : 'false')
    r.el.style.zIndex = String(100 - k)
    if (k === 0) r.el.style.setProperty('--conf', conf.toFixed(3))
  })
  const hidden = sorted.length - Math.min(S.visible, sorted.length)
  $('more').textContent = hidden > 0 ? `+ ${hidden} more targets ranked below` : ''
}

// ---------------------------------------------------------------- one frame from the server
function applyFrame(f) {
  if (!f || !f.targets) return
  const now = performance.now()
  if (f.epoch === S.epoch && f.seq < S.lastSeq) return                 // an older ranking arriving late
  if (f.mode === 'demo' && now - S.humanAt < 1200) return              // the ghost stops the moment a key is pressed
  const fresh = f.epoch !== S.epoch
  if (fresh) { S.epoch = f.epoch; S.hist = []; S.lastLaunch = 0; S.lastSeq = -1; S.logKey = ''; if (f.mode === 'demo') input.value = '' }
  const newRanking = f.seq !== S.lastSeq
  S.f = f
  S.paused = !f.running
  if (buildRows(f)) layoutRows()

  // Launches first, so the flying copy starts from where the row is right now.
  for (const l of f.launches) if (l.n > S.lastLaunch) { S.lastLaunch = l.n; if (!fresh) playLaunch(l) }

  if (S.mode !== f.mode) { S.mode = f.mode; if (f.mode === 'demo') S.sel = 0 }
  if (f.mode === 'demo') { if (input.value !== f.query) input.value = f.query }
  wrap.classList.toggle('ghost', f.mode === 'demo')
  if (newRanking && f.mind.by === 'you') S.sel = 0

  const tokens = (f.query.toLowerCase().match(/[a-z0-9]+/g) || [])
  for (const r of S.rows.values()) paintRowText(r, f, tokens)
  placeRows(f)

  // The tape: one column per ranking.
  let added = 0
  for (const h of f.history) if (h.seq > (S.hist.length ? S.hist[S.hist.length - 1].seq : -1)) { S.hist.push({ ...h, born: now }); added++ }
  for (const h of f.history) { const mine = S.hist.find((x) => x.seq === h.seq); if (mine && h.launch != null) mine.launch = h.launch }
  if (S.hist.length > 120) S.hist.splice(0, S.hist.length - 120)
  if (added && !fresh) { S.shift += added; S.energy = 1; if (f.query) caretSparks(f.mode === 'demo' ? '#a78bfa' : '#5eead4') }
  S.lastSeq = f.seq

  // Words and numbers.
  $('title').textContent = f.title
  const who = $('who'); who.textContent = f.mode === 'demo' ? 'DEMO · GHOST TYPIST' : 'YOU'; who.className = 'tag ' + (f.mode === 'demo' ? 'demo' : 'you')
  const ready = $('ready'), go = f.mind.ready >= 0.6 && !!f.query
  ready.textContent = (go ? 'LAUNCH READY ' : 'KEEP TYPING ') + Math.round(f.mind.ready * 100) + '%'
  ready.className = 'tag ' + (go ? 'go' : 'wait')
  $('beam').classList.toggle('go', go)
  S.beamTo = f.query ? clamp(f.mind.confidence, 0, 1) : 0
  paintSubline(f)
  const st = f.stats
  setStat('s-acc', st.accuracy == null ? '—' : `${Math.round(st.accuracy * 100)}% of ${st.judged}`)
  setStat('s-keys', st.keysToTop1 == null ? '—' : st.keysToTop1.toFixed(1))
  setStat('s-launch', String(st.launches))
  S.bylen = st.byLen
  paintLog(f)
  $('pause').textContent = f.running ? 'Pause typist' : 'Resume typist'
  const ce = $('cfgError'), problem = f.cfgError || f.error
  ce.classList.toggle('hidden', !problem)
  if (problem) ce.textContent = (f.cfgError ? 'Bad edit, still running the last good palette. ' : '') + problem
  syncDials(f.dials)
}

function paintSubline(f) {
  let html
  if (f.mode === 'demo') {
    const want = f.demo.intent
    const slip = f.demo.planned && f.demo.handle && !f.demo.handle.startsWith(f.demo.planned)
    html = want
      ? `Ghost typist wants <b>${esc(want)}</b> and types <span class="q">“${esc(f.demo.planned)}”</span>${slip ? ' <span class="slip">(fumbled)</span>' : ''} · press any key to take over`
      : 'Ghost typist is picking its next target · press any key to take over'
  } else {
    const left = Math.max(0, Math.ceil((f.dials.idleMs - (performance.now() - S.humanAt)) / 1000))
    html = `You are typing. <b>↑ ↓</b> pick · <b>Enter</b> launches on paper · click a row to mark the right answer · ghost returns in ${left} s`
  }
  if (html !== S.subKey) { S.subKey = html; $('subline').innerHTML = html }
}

function paintLog(f) {
  const key = f.launches.map((l) => l.n).join(',')
  if (key === S.logKey) return
  S.logKey = key
  $('logCount').textContent = String(f.stats.launches)
  const ul = $('log')
  if (!f.launches.length) { ul.innerHTML = '<li class="empty" style="display:block">No launches yet. Nothing real is ever launched.</li>'; return }
  ul.innerHTML = f.launches.slice(-8).reverse().map((l) => {
    const miss = l.by === 'demo' ? ` <em>wanted ${esc(l.intent)}</em>` : ` <em>Jev had it #${l.place}</em>`
    return `<li class="${l.ok ? 'ok' : 'miss'}"><span class="m">${l.ok ? '✓' : '✗'}</span><span class="n">${esc(l.name)} <i>“${esc(l.query)}”</i>${l.ok ? '' : miss}</span><span class="by ${l.by === 'you' ? 'you' : ''}">${l.by === 'you' ? 'you' : 'demo'}</span></li>`
  }).join('')
}

const lastStat = {}
function setStat(id, text) {
  if (lastStat[id] === text) return
  const first = lastStat[id] === undefined
  lastStat[id] = text
  const el = $(id); el.textContent = text
  if (!first && id !== 's-rank' && id !== 's-rate' && id !== 's-cost') { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump') }
}

// ---------------------------------------------------------------- launch: a flying copy, a burst, a banner
function playLaunch(l) {
  const r = S.rows.get(l.name)
  const sb = stage.getBoundingClientRect()
  const color = l.ok ? '#34d399' : '#fb7185'
  let cx = sb.width / 2, cy = sb.height / 3
  if (r && r.o > 0.5) {
    const b = r.el.getBoundingClientRect()
    cx = b.left - sb.left + b.width * 0.35; cy = b.top - sb.top + b.height / 2
    const fly = r.el.cloneNode(true)
    fly.className = 'row top fly ' + (l.ok ? 'ok' : 'miss')
    fly.style.cssText += `;left:${b.left - sb.left}px;top:${b.top - sb.top}px;width:${b.width}px;height:${b.height}px;transform:none;opacity:1;right:auto;`
    stage.appendChild(fly)
    const a = fly.animate([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(1.035)', opacity: 1, offset: 0.22 },
      { transform: 'translateX(90px) scale(1.05)', opacity: 0 },
    ], { duration: 820, easing: 'cubic-bezier(.3,.7,.2,1)' })
    a.onfinish = a.oncancel = () => fly.remove()
  }
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 260
    sparks.push({ x: cx + (Math.random() - 0.5) * 120, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 40, life: 0, max: 0.5 + Math.random() * 0.6, color, size: 1.2 + Math.random() * 2 })
  }
  rings.push({ x: cx, y: cy, life: 0, max: 0.7, color })
  S.energy = 1.6
  const banner = $('banner')
  banner.className = 'launch-banner ' + (l.ok ? 'ok' : 'miss')
  banner.textContent = l.by === 'demo'
    ? (l.ok ? `launched ${l.name} ✓ what the typist wanted` : `launched ${l.name} ✗ typist wanted ${l.intent}`)
    : (l.ok ? `you launched ${l.name} ✓ Jev had it first` : `you launched ${l.name} · Jev had it #${l.place}`)
  clearTimeout(playLaunch.t); playLaunch.t = setTimeout(() => banner.classList.add('hidden'), 1500)
}

const meas = document.createElement('canvas').getContext('2d')
function caretXY() {
  const cs = getComputedStyle(input)
  meas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const w = meas.measureText(input.value).width + (parseFloat(cs.letterSpacing) || 0) * input.value.length
  const ib = input.getBoundingClientRect(), sb = stage.getBoundingClientRect()
  return { x: ib.left - sb.left + Math.min(w, ib.width), y: ib.top - sb.top + ib.height / 2, w: Math.min(w, ib.width - 4) }
}
function caretSparks(color) {
  const c = caretXY()
  for (let i = 0; i < 7; i++) sparks.push({ x: c.x, y: c.y, vx: 30 + Math.random() * 120, vy: -150 * Math.random() - 20, life: 0, max: 0.35 + Math.random() * 0.35, color, size: 1 + Math.random() * 1.6 })
}

// ---------------------------------------------------------------- canvases
function fit(cv) {
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth, h = cv.clientHeight
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { g, w, h }
}

function drawBg(t) {
  const { g, w, h } = fit($('bg'))
  g.clearRect(0, 0, w, h)
  const e = Math.min(1, S.energy)
  const blobs = [[167, 139, 250, 0.23, 0.30, 0.00], [94, 234, 212, 0.78, 0.62, 2.10], [96, 165, 250, 0.52, 0.95, 4.20]]
  g.globalCompositeOperation = 'lighter'
  for (const [r, gg, b, fx, fy, ph] of blobs) {
    const x = w * fx + Math.cos(t * 0.00023 + ph) * w * 0.16, y = h * fy + Math.sin(t * 0.00031 + ph) * h * 0.14
    const rad = Math.max(w, h) * (0.34 + 0.05 * e)
    const grd = g.createRadialGradient(x, y, 0, x, y, rad)
    grd.addColorStop(0, `rgba(${r},${gg},${b},${0.13 + 0.1 * e})`); grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd; g.fillRect(0, 0, w, h)
  }
  g.globalCompositeOperation = 'source-over'
}

/** Sparks and rings, drawn over the palette. */
function drawFx(dt) {
  const { g, w, h } = fit($('fx'))
  g.clearRect(0, 0, w, h)
  if (!sparks.length && !rings.length) return
  g.globalCompositeOperation = 'lighter'
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.life += dt
    if (r.life >= r.max) { rings.splice(i, 1); continue }
    const k = r.life / r.max
    g.strokeStyle = r.color; g.globalAlpha = (1 - k) * 0.8; g.lineWidth = 3 * (1 - k) + 0.5
    g.beginPath(); g.ellipse(r.x, r.y, 30 + k * 380, 12 + k * 120, 0, 0, Math.PI * 2); g.stroke()
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]; s.life += dt
    if (s.life >= s.max) { sparks.splice(i, 1); continue }
    s.vy += 420 * dt; s.x += s.vx * dt; s.y += s.vy * dt
    const k = 1 - s.life / s.max
    g.globalAlpha = k; g.fillStyle = s.color
    g.beginPath(); g.arc(s.x, s.y, s.size * (0.6 + k), 0, Math.PI * 2); g.fill()
    g.globalAlpha = k * 0.25; g.beginPath(); g.arc(s.x, s.y, s.size * 3.2, 0, Math.PI * 2); g.fill()
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
}

function drawStream(now) {
  const { g, w, h } = fit($('stream'))
  g.clearRect(0, 0, w, h)
  const padT = 36, padB = 20, padX = 12, cw = 15, pitch = 20
  const ph = h - padT - padB, baseX = w - padX - cw
  g.save(); g.beginPath(); g.rect(padX, 0, w - padX * 2, h); g.clip()
  g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1
  for (const k of [0, 0.5, 1]) { const y = padT + ph * k + 0.5; g.beginPath(); g.moveTo(padX, y); g.lineTo(w - padX, y); g.stroke() }
  g.font = '600 10px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'
  const n = S.hist.length
  for (let k = n - 1; k >= 0; k--) {
    const e = S.hist[k], age = n - 1 - k
    const x = baseX - age * pitch + S.shift * pitch
    if (x < padX - pitch) break
    if (x > w) continue
    const grow = clamp((now - e.born) / 160, 0, 1), ease = 1 - (1 - grow) ** 3
    let y = padT + ph
    if (!e.query) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(x + cw / 2 - 1, padT + ph * 0.25, 2, ph * 0.75) }
    else {
      let rest = 1
      e.segs.forEach(([idx, p], j) => {
        const hh = p * ph * ease
        g.globalAlpha = j === 0 ? 0.95 : 0.5
        g.fillStyle = hueOf(idx)
        if (j === 0) { g.shadowColor = hueOf(idx); g.shadowBlur = 10 }
        g.fillRect(x, y - hh, cw, Math.max(0.5, hh - 1)); g.shadowBlur = 0
        y -= hh; rest -= p
      })
      g.globalAlpha = 1; g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(x, padT + ph - ph * ease, cw, Math.max(0, ph * ease - (padT + ph - y)))
      if (e.ok != null) { g.fillStyle = e.ok ? '#34d399' : '#fb7185'; g.fillRect(x, padT + ph + 2, cw, 2) }
      else { g.fillStyle = '#5eead4'; g.fillRect(x, padT + ph + 2, cw, 2) }
      const ch = e.query.slice(-1)
      g.fillStyle = e.by === 'you' ? '#5eead4' : '#8b92aa'; g.fillText(ch === ' ' ? '␣' : ch, x + cw / 2, h - 5)
    }
    if (e.launch != null) { g.fillStyle = e.launch ? '#34d399' : '#fb7185'; g.font = '800 12px ui-monospace, Menlo, monospace'; g.fillText(e.launch ? '✓' : '✗', x + cw / 2, padT - 4); g.font = '600 10px ui-monospace, Menlo, monospace' }
  }
  g.restore()
}

const bl = []
function drawBylen(dt) {
  const { g, w, h } = fit($('bylen'))
  g.clearRect(0, 0, w, h)
  const data = S.bylen || []
  let maxN = 6
  data.forEach((b, i) => { if (b.n > 0) maxN = Math.max(maxN, i + 1) })
  const padT = 38, padB = 18, padX = 14, ph = h - padT - padB
  const pitch = (w - padX * 2) / maxN, bw = Math.min(24, pitch - 6)
  g.font = '600 10px ui-monospace, Menlo, monospace'; g.textAlign = 'center'
  for (let i = 0; i < maxN; i++) {
    const b = data[i], v = b && b.n ? b.right / b.n : 0
    bl[i] = (bl[i] ?? 0) + (v - (bl[i] ?? 0)) * (1 - Math.exp(-dt * 8))
    const x = padX + pitch * i + (pitch - bw) / 2, hh = bl[i] * ph
    g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(x, padT, bw, ph)
    const hue = 350 + bl[i] * 160 // rose -> amber -> green
    g.fillStyle = `hsl(${hue % 360} 80% 62%)`; g.shadowColor = g.fillStyle; g.shadowBlur = 8
    g.fillRect(x, padT + ph - hh, bw, hh); g.shadowBlur = 0
    g.fillStyle = '#8b92aa'; g.fillText(String(i + 1), x + bw / 2, h - 5)
    if (b && b.n) { g.fillStyle = '#e9ecf5'; g.fillText(Math.round(bl[i] * 100) + '', x + bw / 2, padT + ph - hh - 4) }
  }
}

// ---------------------------------------------------------------- the 60 fps loop
let lastT = performance.now(), subTick = 0
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t
  const kPos = 1 - Math.exp(-dt * 16), kBar = 1 - Math.exp(-dt * 14)
  for (const r of S.rows.values()) {
    r.y += (r.ty - r.y) * kPos; r.o += (r.to - r.o) * kPos; r.p += (r.tp - r.p) * kBar
    r.el.style.transform = `translate3d(0,${r.y.toFixed(2)}px,0)`
    r.el.style.opacity = r.o.toFixed(3)
    r.el.style.pointerEvents = r.to ? 'auto' : 'none'
    r.fill.style.width = (r.p * 100).toFixed(2) + '%'
    const txt = r.p >= 0.995 ? '100%' : r.p < 0.005 ? '0%' : (r.p * 100).toFixed(r.p < 0.1 ? 1 : 0) + '%'
    if (txt !== r.pctText) { r.pctText = txt; r.pct.textContent = txt }
  }
  S.beam += (S.beamTo - S.beam) * kBar
  $('beam').style.width = (S.beam * 100).toFixed(2) + '%'
  S.shift += (0 - S.shift) * (1 - Math.exp(-dt * 12)); if (Math.abs(S.shift) < 0.002) S.shift = 0
  S.energy = Math.max(0, S.energy - dt * 1.8)
  palette.style.setProperty('--energy', Math.min(1, S.energy).toFixed(2))
  if (S.mode === 'demo') $('ghostCaret').style.transform = `translateX(${caretXY().w + 2}px)`
  drawBg(t); drawFx(dt); drawStream(t); drawBylen(dt)
  if (S.jev) { S.shownCalls += (S.jev.calls - S.shownCalls) * (1 - Math.exp(-dt * 10)); setStat('s-rank', Math.round(S.shownCalls).toLocaleString('en-US')) }
  if (S.f && S.mode === 'human' && t - subTick > 250) { subTick = t; paintSubline(S.f) }
  requestAnimationFrame(loop)
}

// ---------------------------------------------------------------- the person
function takeOver() {
  if (S.mode === 'demo') input.value = ''
  S.mode = 'human'; S.humanAt = performance.now(); S.sel = 0
  wrap.classList.remove('ghost')
  const who = $('who'); who.textContent = 'YOU'; who.className = 'tag you'
}

input.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key, printable = k.length === 1
  const acts = printable || ['Backspace', 'Delete', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(k)
  if (!acts) return
  const wasDemo = S.mode === 'demo'
  if (wasDemo) { takeOver(); if (!printable) { e.preventDefault(); sendQuery(); return } }
  S.humanAt = performance.now()
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault()
    S.sel = clamp(S.sel + (k === 'ArrowDown' ? 1 : -1), 0, Math.min(S.visible, S.order.length) - 1)
    if (S.f) placeRows(S.f)
    post({ cmd: 'touch' })
  } else if (k === 'Enter') {
    e.preventDefault()
    const name = S.order[S.sel]
    if (name) { input.value = ''; S.sel = 0; S.reqN++; send({ cmd: 'launch', name }) }
  } else if (k === 'Escape') {
    e.preventDefault(); input.value = ''; sendQuery()
  }
})
// Paste, drop and input methods never send a keydown: clear the ghost's text before theirs goes in.
input.addEventListener('beforeinput', () => { if (S.mode === 'demo') takeOver() })
input.addEventListener('input', () => { S.mode = 'human'; S.humanAt = performance.now(); sendQuery() })
document.addEventListener('keydown', (e) => {
  if (e.target === input || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key.length === 1 || e.key === 'Backspace') input.focus()
})
palette.addEventListener('click', (e) => { if (!e.target.closest('.row')) input.focus() })

$('pause').onclick = () => send({ cmd: S.paused ? 'start' : 'pause' })
$('reset').onclick = () => { S.humanAt = -1e9; input.value = ''; send({ cmd: 'reset' }) }

const DIALS = {
  typos: { el: $('d-typos'), out: $('v-typos'), show: (v) => Math.round(v * 100) + '%', toServer: (v) => ['typos', v], fromServer: (d) => d.typos },
  chars: { el: $('d-chars'), out: $('v-chars'), show: (v) => String(v), toServer: (v) => ['chars', v], fromServer: (d) => d.chars },
  lookalikes: { el: $('d-lookalikes'), out: $('v-lookalikes'), show: (v) => String(v), toServer: (v) => ['lookalikes', v], fromServer: (d) => d.lookalikes },
  speed: { el: $('d-speed'), out: $('v-speed'), show: (v) => Math.round(v) + '/s', toServer: (v) => ['stepMs', Math.round(1000 / v)], fromServer: (d) => clamp(Math.round(1000 / d.stepMs), 1, 20) },
}
for (const d of Object.values(DIALS)) {
  d.el.addEventListener('input', () => { const v = Number(d.el.value); d.out.textContent = d.show(v); const [key, value] = d.toServer(v); send({ cmd: 'set', key, value }) })
}
function syncDials(dials) {
  for (const d of Object.values(DIALS)) {
    if (document.activeElement === d.el) continue
    const v = d.fromServer(dials)
    if (Number(d.el.value) !== v) d.el.value = String(v)
    d.out.textContent = d.show(Number(d.el.value))
  }
}

// ---------------------------------------------------------------- the three numbers
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$0.0001' : v < 1 ? '$' + v.toFixed(4) : '$' + v.toFixed(2)
async function pollJev() {
  if (!document.hidden) {
    try {
      const r = await fetch('/jev', { cache: 'no-store' })
      if (r.ok) { S.jev = await r.json(); setStat('s-rate', S.jev.callsPerSec >= 10 ? String(Math.round(S.jev.callsPerSec)) : S.jev.callsPerSec.toFixed(1)); setStat('s-cost', fmtMoney(S.jev.costUsd)) }
    } catch { /* the viewer is restarting */ }
  }
  setTimeout(pollJev, 300)
}

new ResizeObserver(layoutRows).observe(rowsBox)
function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (e) => applyFrame(JSON.parse(e.data)))
  es.onerror = () => { /* the browser reconnects on its own */ }
}
layoutRows(); connect(); pollJev(); requestAnimationFrame(loop)
input.focus({ preventScroll: true })
