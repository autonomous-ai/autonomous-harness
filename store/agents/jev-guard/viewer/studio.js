// Jev Guard pane. The server sends one frame per reviewed edit. This file draws the hero canvas at
// 60 fps (the "safe to continue?" gauge and the risk river, both eased between frames) and keeps the
// three DOM panels in step: the file heat, the edit timeline and the diff of the chosen edit.
'use strict'

const $ = (id) => document.getElementById(id)
const scene = $('scene'), hero = $('hero')
const ctx = scene.getContext('2d')
const COL = { safe: '#34d399', review: '#fbbf24', block: '#fb7185', accent: '#2dd4bf', ink: '#e9ecf5', dim: '#8b92aa', faint: '#565d75', line: '#232838' }
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace"

// ---------------------------------------------------------------- state
let F = null                    // the last frame from the server
let W = 10, H = 10, DPR = 1
let pinned = null               // edit id the person clicked, or null to follow the stream
let shownId = null, shownSig = ''
let lastSeen = 0                // highest edit id already animated
let paused = false
const diffCache = new Map()     // edit id -> files with lines
const ease = { needle: 1, needleV: 0, reviewAt: 0.45, blockAt: 0.75, shift: 0, lamp: { safe: 1, review: 0, block: 0 }, conf: 0.8, flash: 0, flashCol: COL.safe }
const particles = [], rings = [], dust = []
let dots = []                   // screen positions of the river dots, for hit testing
let hover = null
for (let i = 0; i < 46; i++) dust.push({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, p: Math.random() * 6.28 })

const fmtP = (p) => (p >= 0.995 ? '1.00' : p.toFixed(2).replace(/^0/, ''))
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const mix = (a, b, t) => a + (b - a) * t
function heatColor(h) {
  const t = Math.max(0, Math.min(1, h))
  const stops = [[52, 211, 153], [251, 191, 36], [251, 113, 133]]
  const k = t < 0.5 ? 0 : 1, u = t < 0.5 ? t * 2 : (t - 0.5) * 2
  const c = stops[k].map((v, i) => Math.round(mix(v, stops[k + 1][i], u)))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

async function post(body) {
  try { const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.ok ? r.json() : null } catch { return null }
}

// ---------------------------------------------------------------- canvas size
function fit() {
  const r = hero.getBoundingClientRect()
  DPR = Math.min(2.5, window.devicePixelRatio || 1)
  W = Math.max(200, r.width); H = Math.max(120, r.height)
  scene.width = Math.round(W * DPR); scene.height = Math.round(H * DPR)
}
new ResizeObserver(fit).observe(hero)
window.addEventListener('resize', fit)

// ---------------------------------------------------------------- frames in
function apply(f) {
  const first = !F
  if (F && f.stats.edits < lastSeen) { lastSeen = 0; diffCache.clear(); particles.length = 0; rings.length = 0; pinned = null; shownId = null }
  F = f
  for (const [id, files] of Object.entries(f.diffs || {})) diffCache.set(Number(id), files)
  const ids = new Set(f.edits.map((e) => e.id))
  for (const id of diffCache.keys()) if (!ids.has(id)) diffCache.delete(id)
  if (pinned != null && !ids.has(pinned)) pinned = null
  const fresh = f.edits.filter((e) => e.id > lastSeen)
  if (fresh.length) {
    lastSeen = fresh[fresh.length - 1].id
    if (!first && fresh.length <= 4) { ease.shift = Math.min(3, ease.shift + fresh.length); for (const e of fresh) burst(e) }
  }
  paused = !f.running
  renderTop(f); renderFiles(f); renderEdits(f); renderDiff(f); renderRail(f); syncSliders(f)
}

function burst(e) {
  const col = COL[e.chip]
  ease.flash = e.chip === 'safe' ? 0.25 : 1; ease.flashCol = col
  pendingBursts.push({ id: e.id, n: e.chip === 'block' ? 30 : e.chip === 'review' ? 14 : 5, col })
}
const pendingBursts = []

// ---------------------------------------------------------------- top bar
function renderTop(f) {
  $('title').textContent = f.title
  const m = $('s-mode'); m.textContent = f.mode === 'demo' ? 'DEMO' : `LIVE ${Math.ceil(f.idleLeft / 1000)}s`; m.className = f.mode
  const t = $('s-tests'); t.textContent = f.tests ? (f.tests.passed ? 'PASS' : 'FAIL') : '—'; t.className = f.tests ? (f.tests.passed ? 'pass' : 'fail') : ''
  const s = f.stats
  $('s-caught').textContent = s.risky ? `${s.caught}/${s.risky}` : '—'
  $('s-false').textContent = s.safe ? `${s.falseAlarms}/${s.safe}` : '—'
  $('s-edits').textContent = s.edits.toLocaleString('en-US')
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  $('pause').classList.toggle('on', !f.running)
  const err = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !err)
  $('cfgError').textContent = err ? (f.cfgError ? `${f.cfgError} — still running on the last good goal.json` : f.error) : ''
  const sc = $('score')
  sc.innerHTML = s.demo
    ? `demo truth: <b>${s.caught}/${s.risky}</b> caught · <b>${s.falseAlarms}</b> false alarm${s.falseAlarms === 1 ? '' : 's'}${s.unreadMisses ? ` · <b>${s.unreadMisses}</b> past the cut` : ''}`
    : 'real edits only'
}

async function pollJev() {
  if (!document.hidden) {
    try {
      const r = await fetch('/jev', { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json()
        $('s-rate').textContent = j.callsPerSec >= 10 ? j.callsPerSec.toFixed(0) : j.callsPerSec.toFixed(1)
        const c = j.costUsd
        $('s-cost').textContent = c <= 0 ? '$0' : c < 0.01 ? '$' + c.toFixed(5) : '$' + c.toFixed(3)
      }
    } catch { /* viewer restarting */ }
  }
  setTimeout(pollJev, 300)
}

// ---------------------------------------------------------------- file heat (keyed, FLIP on reorder)
const fileNodes = new Map()
function renderFiles(f) {
  const list = $('files')
  const project = f.files.filter((x) => x.group === 'project')
  const demo = f.files.filter((x) => x.group === 'demo').sort((a, b) => Math.round(b.heat * 12) - Math.round(a.heat * 12) || b.n - a.n || a.name.localeCompare(b.name)).slice(0, 14)
  const rows = [{ key: '#project', group: 'project/ · the real files' }, ...project.map((x) => ({ key: x.name, file: x })), ...(demo.length ? [{ key: '#demo', group: 'demo repo · made up' }] : []), ...demo.map((x) => ({ key: x.name, file: x }))]
  const before = new Map()
  for (const [k, n] of fileNodes) before.set(k, [n.offsetLeft, n.offsetTop])
  const keep = new Set()
  rows.forEach((r) => {
    keep.add(r.key)
    let n = fileNodes.get(r.key)
    if (!n) {
      n = document.createElement('li')
      if (r.group) { n.className = 'file group'; n.textContent = r.group }
      else { n.className = 'file'; n.innerHTML = '<span class="glow"></span><span class="led"></span><span class="path"></span><span class="bar"><b></b></span>' }
      fileNodes.set(r.key, n)
    }
    list.appendChild(n) // re-append in order
    if (r.file) {
      const x = r.file, short = x.name.replace(/^project\//, ''), cut = short.lastIndexOf('/')
      const sig = `${x.name}|${Math.round(x.heat * 100)}|${x.n}`
      if (n.dataset.sig !== sig) {
        if (n.dataset.n && Number(n.dataset.n) !== x.n) { n.classList.remove('touched'); void n.offsetWidth; n.classList.add('touched') }
        n.dataset.sig = sig; n.dataset.n = x.n
        n.querySelector('.path').innerHTML = `${esc(short.slice(cut + 1))}${cut >= 0 ? ` <i>${esc(short.slice(0, cut))}</i>` : ''}`
        n.title = `${x.name} · ${x.n} edit${x.n === 1 ? '' : 's'} · heat ${x.heat.toFixed(2)}`
        const col = x.n ? heatColor(x.heat) : ''
        n.style.setProperty('--heat', col || 'transparent')
        n.querySelector('.glow').style.opacity = String(Math.min(0.32, x.heat * 0.4))
        n.querySelector('.bar b').style.width = Math.round(x.heat * 100) + '%'
      }
    }
  })
  for (const [k, n] of fileNodes) if (!keep.has(k)) { n.remove(); fileNodes.delete(k) }
  for (const [k, n] of fileNodes) {
    const was = before.get(k); if (!was) continue
    const dx = was[0] - n.offsetLeft, dy = was[1] - n.offsetTop
    if (!dx && !dy) continue
    n.style.transition = 'none'; n.style.transform = `translate(${dx}px, ${dy}px)`
    requestAnimationFrame(() => { n.style.transition = 'transform .4s cubic-bezier(.2,.8,.2,1)'; n.style.transform = '' })
  }
}

// ---------------------------------------------------------------- timeline (keyed rows, newest on top)
const editNodes = new Map()
function renderEdits(f) {
  const list = $('edits')
  const show = f.edits.slice(-24)
  const keep = new Set()
  const target = currentId(f)
  for (const e of show) {
    keep.add(e.id)
    let n = editNodes.get(e.id)
    if (!n) {
      n = document.createElement('li'); n.dataset.id = e.id
      n.addEventListener('click', () => { pinned = pinned === e.id ? null : e.id; if (F) { renderEdits(F); renderDiff(F) } })
      editNodes.set(e.id, n)
      list.insertBefore(n, list.firstChild)
    }
    const sig = `${e.chip}|${e.outcome}|${e.id === target}`
    if (n.dataset.sig === sig) continue
    n.dataset.sig = sig
    n.className = `edit ${e.chip}${e.id === target ? ' sel' : ''}`
    const where = e.files.length ? e.files.map((x) => x.name.replace(/^project\//, '')).join(', ') : 'no file changed'
    const plus = e.files.reduce((a, x) => a + x.added, 0), minus = e.files.reduce((a, x) => a + x.removed, 0)
    const out = e.outcome ? `<span class="outcome ${e.outcome === 'false alarm' ? 'false' : e.outcome}">${e.outcome}</span>` : ''
    n.innerHTML = `<div class="l1"><span class="chip ${e.chip}">${e.chip.toUpperCase()}</span><span class="note">${esc(e.note)}</span><span class="src ${e.source}">${e.source}</span><span class="id">#${e.id}</span></div>`
      + `<div class="l2"><span class="where">${esc(where)} <span style="color:var(--safe)">+${plus}</span> <span style="color:var(--block)">−${minus}</span></span>${out}<span class="pbar" title="safe ${fmtP(e.probs.safe)} · review ${fmtP(e.probs.review)} · block ${fmtP(e.probs.block)}"><i class="s" style="width:${e.probs.safe * 100}%"></i><i class="r" style="width:${e.probs.review * 100}%"></i><i class="b" style="width:${e.probs.block * 100}%"></i></span></div>`
  }
  for (const [id, n] of editNodes) if (!keep.has(id)) { n.remove(); editNodes.delete(id) }
}

/** The edit the diff view shows: the pinned one, else the newest flagged one, else the newest. */
function currentId(f) {
  if (pinned != null) return pinned
  for (let i = f.edits.length - 1; i >= 0 && i >= f.edits.length - 12; i--) if (f.edits[i].chip !== 'safe') return f.edits[i].id
  return f.edits.length ? f.edits[f.edits.length - 1].id : null
}

// ---------------------------------------------------------------- diff view
function renderDiff(f) {
  const id = currentId(f)
  const e = f.edits.find((x) => x.id === id)
  $('follow').classList.toggle('hidden', pinned == null)
  $('diffTag').textContent = pinned != null ? `Edit #${id} · pinned` : e && e.chip !== 'safe' ? 'Latest flagged edit' : 'Latest edit'
  const head = $('diffHead'), body = $('diffBody'), mind = $('diffMind')
  if (!e) { head.innerHTML = ''; body.innerHTML = '<div class="empty">Waiting for the first edit…</div>'; mind.innerHTML = ''; shownId = null; return }
  const files = diffCache.get(id)
  const sig = `${id}|${e.chip}|${e.outcome}|${files ? 1 : 0}`
  if (sig === shownSig) return
  const changed = shownId !== id
  shownSig = sig; shownId = id
  const out = e.outcome ? `<span class="outcome ${e.outcome === 'false alarm' ? 'false' : e.outcome}">${e.outcome}${e.outcome === 'missed' && e.hotRead === false ? ' · never read' : ''}</span>` : ''
  head.innerHTML = `<span class="chip ${e.chip}">${e.chip.toUpperCase()}</span><span class="note">${esc(e.note)}</span>${out}<span class="src ${e.source}">${e.source}</span><span class="id" style="color:var(--faint)">#${e.id}</span>`
  if (changed || !body.dataset.id || body.dataset.id !== String(id) || body.dataset.has !== String(!!files)) {
    body.dataset.id = id; body.dataset.has = String(!!files)
    if (!files) body.innerHTML = '<div class="empty">The diff for this edit is no longer kept.</div>'
    else if (!files.length) body.innerHTML = '<div class="empty">No file changed. Jev judged the test result alone.</div>'
    else {
      let html = '', cutDone = false
      files.forEach((file, k) => {
        const meta = e.files[k]
        html += `<div class="dfile"><span>${esc(file.name)}</span><span class="st">${file.status}</span><span class="risk">file risk <b>${meta && meta.risk != null ? fmtP(meta.risk) : '—'}</b></span></div>`
        for (const l of file.lines) {
          if (l.unread && !cutDone) { cutDone = true; html += `<div class="cut">✂ Jev stopped reading here · ${e.readChars.toLocaleString('en-US')} of ${e.totalChars.toLocaleString('en-US')} characters read</div>` }
          const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'hunk' : 'ctx'
          html += `<div class="dl ${cls}${l.hot ? ' hot' : ''}${l.unread ? ' unread' : ''}"${l.hot ? ' title="Planted risk. This mark is ground truth for the demo. Jev never sees it."' : ''}><span class="g">${l.hot ? '◆' : l.t === '@' ? '⋯' : l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span><span class="t">${esc(l.s) || ' '}</span></div>`
        }
      })
      body.innerHTML = html
      const focus = body.querySelector('.dl.hot') || body.querySelector('.dl.add, .dl.del')
      body.scrollTo({ top: focus ? Math.max(0, focus.offsetTop - body.clientHeight * 0.4) : 0, behavior: changed ? 'smooth' : 'auto' })
    }
  }
  const bar = (label, p) => `<div class="mind"><label>${label} <b>${fmtP(p)}</b></label><div class="track"><i class="y${p < 0.5 ? ' low' : ''}" style="width:${Math.max(2, p * 100)}%"></i></div></div>`
  mind.innerHTML = `<div class="mind"><label>safe · review · block <b>${fmtP(e.probs.safe)} · ${fmtP(e.probs.review)} · ${fmtP(e.probs.block)}</b></label><div class="track"><i class="s" style="width:${e.probs.safe * 100}%"></i><i class="r" style="width:${e.probs.review * 100}%"></i><i class="b" style="width:${e.probs.block * 100}%"></i></div></div>`
    + bar('secret?', e.flags.secret) + bar('tests cut?', e.flags.tests) + bar('destructive?', e.flags.destructive)
}

// ---------------------------------------------------------------- rail
let lastState = null, lastTestOut = null
function renderRail(f) {
  if (f.stateText !== lastState) {
    lastState = f.stateText
    $('stateText').innerHTML = f.stateText.split('\n').map((l) => {
      const c = l.startsWith('=== file:') ? 'hd' : l.startsWith('[cut:') ? 'cutl' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : /^(Goal|Tests|Edit #\d+|Files changed):?/.test(l) ? 'k' : ''
      return c ? `<span class="${c}">${esc(l)}</span>` : esc(l)
    }).join('\n')
    const last = f.edits[f.edits.length - 1]
    const tag = $('readTag')
    if (last) { tag.textContent = last.cut ? `cut at ${f.cfg.diffBudget} chars` : `${last.readChars} chars`; tag.classList.toggle('cut', !!last.cut) }
  }
  $('goal').textContent = f.goal
  const pill = $('testPill')
  pill.textContent = f.tests ? (f.tests.passed ? (f.tests.green ? 'ALL GREEN' : 'PASSING') : 'FAILING') : '—'
  pill.className = 'right pill ' + (f.tests ? (f.tests.passed ? 'ok' : 'bad') : '')
  const outText = f.tests ? (f.tests.output.trim().split('\n').slice(-6).join('\n') || '(no output)') : ''
  if (outText !== lastTestOut) { lastTestOut = outText; $('testOut').textContent = outText }
}

// ---------------------------------------------------------------- controls
const paceToMs = (v) => Math.round(2000 * Math.pow(0.04, v))
const msToPace = (ms) => Math.max(0, Math.min(1, Math.log(ms / 2000) / Math.log(0.04)))
const dragging = new Set()
function syncSliders(f) {
  if (!dragging.has('strictness')) { $('strictness').value = f.cfg.strictness; $('strictnessVal').textContent = fmtP(f.cfg.strictness) }
  if (!dragging.has('subtlety')) { $('subtlety').value = f.cfg.subtlety; $('subtletyVal').textContent = fmtP(f.cfg.subtlety) }
  if (!dragging.has('pace')) { $('pace').value = msToPace(f.cfg.stepMs); $('paceVal').textContent = (1000 / f.cfg.stepMs).toFixed(1) + '/s' }
}
function slider(id, toBody, show) {
  const el = $(id)
  let t = null
  el.addEventListener('input', () => {
    dragging.add(id); show(Number(el.value))
    if (id === 'strictness') { const s = Number(el.value); targetTh = { reviewAt: 0.7 - 0.5 * s, blockAt: 0.95 - 0.4 * s } } // the lines move before the server answers
    clearTimeout(t); t = setTimeout(() => post(toBody(Number(el.value))), 40)
  })
  const done = () => setTimeout(() => dragging.delete(id), 250)
  el.addEventListener('change', done); el.addEventListener('pointerup', done)
}
let targetTh = null
slider('strictness', (v) => ({ cmd: 'set', key: 'strictness', value: v }), (v) => { $('strictnessVal').textContent = fmtP(v) })
slider('subtlety', (v) => ({ cmd: 'set', key: 'subtlety', value: v }), (v) => { $('subtletyVal').textContent = fmtP(v) })
slider('pace', (v) => ({ cmd: 'set', key: 'stepMs', value: paceToMs(v) }), (v) => { $('paceVal').textContent = (1000 / paceToMs(v)).toFixed(1) + '/s' })

$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick', n: 1 })
$('judge').onclick = () => post({ cmd: 'judge' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('follow').onclick = () => { pinned = null; if (F) { renderEdits(F); renderDiff(F) } }
for (const b of document.querySelectorAll('[data-sample]')) b.onclick = () => { pinned = null; post({ cmd: 'sample', kind: b.dataset.sample }) }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pinned != null) { pinned = null; if (F) { renderEdits(F); renderDiff(F) } } })

scene.addEventListener('mousemove', (ev) => {
  const r = scene.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top
  let best = null, bd = 16
  for (const d of dots) { const dist = Math.hypot(d.x - x, d.y - y); if (dist < bd) { bd = dist; best = d } }
  hover = best; scene.style.cursor = best ? 'pointer' : 'default'
})
scene.addEventListener('mouseleave', () => { hover = null })
scene.addEventListener('click', () => { if (hover && F) { pinned = hover.e.id; renderEdits(F); renderDiff(F) } })

// ---------------------------------------------------------------- the hero canvas
let lastT = performance.now()
function draw(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const f = F
  const th = targetTh && dragging.has('strictness') ? targetTh : f ? f.thresholds : { reviewAt: 0.45, blockAt: 0.75 }
  const k = 1 - Math.exp(-dt * 10)
  ease.reviewAt = mix(ease.reviewAt, th.reviewAt, k); ease.blockAt = mix(ease.blockAt, th.blockAt, k)
  ease.shift *= Math.exp(-dt * (f ? Math.max(7, 2600 / f.cfg.stepMs) : 7))
  ease.flash *= Math.exp(-dt * 3.2)
  const latest = f && f.edits.length ? f.edits[f.edits.length - 1] : null
  if (latest) { for (const key of ['safe', 'review', 'block']) ease.lamp[key] = mix(ease.lamp[key], latest.probs[key], k); ease.conf = mix(ease.conf, latest.confidence, k) }
  // A lightly sprung needle: it overshoots a touch, then settles.
  const target = f ? f.gauge.safe : 1
  ease.needleV += ((target - ease.needle) * 90 - ease.needleV * 13) * dt
  ease.needle += ease.needleV * dt

  drawBackdrop(now)
  const gw = Math.min(300, Math.max(210, W * 0.3))
  drawRiver(f, gw + 6, now, dt)
  drawGauge(f, gw, latest, now)
  drawParticles(dt)
  requestAnimationFrame(draw)
}

function drawBackdrop(now) {
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, 'rgba(45,212,191,.05)'); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  for (const d of dust) {
    d.x += 0.000045 * d.z * 16; if (d.x > 1.02) d.x = -0.02
    const a = 0.10 + 0.10 * Math.sin(now / 900 + d.p)
    ctx.fillStyle = `rgba(148,163,184,${a * d.z})`
    ctx.beginPath(); ctx.arc(d.x * W, d.y * H + Math.sin(now / 1700 + d.p) * 4, 0.7 + d.z, 0, 6.28); ctx.fill()
  }
}

function drawGauge(f, gw, latest, now) {
  const R = Math.max(54, Math.min(gw / 2 - 30, H - 128))
  const cx = gw / 2 + 4, cy = 30 + R
  ctx.textAlign = 'center'
  ctx.font = `600 10px ${MONO}`; ctx.fillStyle = COL.dim
  ctx.fillText('S A F E   T O   C O N T I N U E ?', cx, 16)
  const ang = (v) => Math.PI * (1 - v) // v in 0..1 (0 = stop, left) to angle; canvas y is flipped below
  const arc = (v0, v1, col, width, alpha) => {
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI + Math.PI * v0, Math.PI + Math.PI * v1)
    ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.lineCap = 'butt'; ctx.stroke(); ctx.globalAlpha = 1
  }
  const b0 = 1 - ease.blockAt, b1 = 1 - ease.reviewAt
  arc(0, 1, '#151a26', 16, 1)
  arc(0, b0 - 0.006, COL.block, 12, 0.85); arc(b0 + 0.006, b1 - 0.006, COL.review, 12, 0.85); arc(b1 + 0.006, 1, COL.safe, 12, 0.85)
  // ticks
  for (let i = 0; i <= 20; i++) {
    const a = Math.PI + (Math.PI * i) / 20, r0 = R - 13, r1 = R - (i % 5 === 0 ? 22 : 17)
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    ctx.strokeStyle = i % 5 === 0 ? '#475069' : '#2a3145'; ctx.lineWidth = 1; ctx.stroke()
  }
  const v = Math.max(-0.02, Math.min(1.02, ease.needle))
  const zone = v < b0 ? 'block' : v < b1 ? 'review' : 'safe'
  const col = COL[zone]
  // the lit part of the arc up to the needle, with glow
  ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 18 + ease.flash * 22
  arc(Math.max(0, v - 0.16), Math.max(0.001, v), col, 4, 0.95); ctx.restore()
  // confidence: a soft wedge around the needle. Wide when Jev is unsure.
  const spread = (1 - ease.conf) * 0.22 + 0.012
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R - 24, Math.PI + Math.PI * Math.max(0, v - spread), Math.PI + Math.PI * Math.min(1, v + spread)); ctx.closePath()
  const wg = ctx.createRadialGradient(cx, cy, 4, cx, cy, R - 24); wg.addColorStop(0, 'rgba(255,255,255,0)'); wg.addColorStop(1, col + '55')
  ctx.fillStyle = wg; ctx.fill()
  // needle
  const a = Math.PI + Math.PI * v
  ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 14
  ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8); ctx.lineTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18))
  ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore()
  ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, 6.28); ctx.fillStyle = col; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, 6.28); ctx.fillStyle = '#05060a'; ctx.fill()
  ctx.font = `600 9px ${MONO}`; ctx.fillStyle = COL.faint
  ctx.textAlign = 'left'; ctx.fillText('STOP', cx - R - 6, cy + 14); ctx.textAlign = 'right'; ctx.fillText('YES', cx + R + 6, cy + 14); ctx.textAlign = 'center'
  // the word
  const word = f ? (zone === 'block' ? 'STOP' : zone === 'review' ? 'LOOK FIRST' : 'YES') : '…'
  ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 16 + ease.flash * 20
  ctx.font = `800 ${word.length > 5 ? 17 : 24}px ${MONO}`; ctx.fillStyle = col; ctx.fillText(word, cx, cy - R * 0.36); ctx.restore()
  ctx.font = `600 10px ${MONO}`; ctx.fillStyle = COL.dim
  ctx.fillText(`${Math.round(Math.max(0, Math.min(1, v)) * 100)}% safe`, cx, cy - R * 0.36 + 15)
  // Jev's mind for the newest edit: three lamps, lit by probability, the chosen one glowing
  const lw = Math.min(86, (gw - 28) / 3), ly = cy + 26, lh = 38, x0 = cx - (lw * 3 + 12) / 2
  ;['safe', 'review', 'block'].forEach((key, i) => {
    const p = ease.lamp[key], x = x0 + i * (lw + 6), chosen = latest && latest.choice === key
    ctx.save()
    if (chosen) { ctx.shadowColor = COL[key]; ctx.shadowBlur = 16 + 6 * Math.sin(now / 240) }
    ctx.globalAlpha = 0.10 + 0.75 * p
    roundRect(x, ly, lw, lh, 8); ctx.fillStyle = COL[key]; ctx.fill(); ctx.restore()
    roundRect(x, ly, lw, lh, 8); ctx.strokeStyle = chosen ? COL[key] : '#2a3145'; ctx.lineWidth = chosen ? 1.6 : 1; ctx.stroke()
    ctx.fillStyle = p > 0.45 ? '#05060a' : COL.ink
    ctx.font = `800 9px ${MONO}`; ctx.fillText(key.toUpperCase(), x + lw / 2, ly + 15)
    ctx.font = `700 13px ${MONO}`; ctx.fillText(fmtP(p), x + lw / 2, ly + 31)
  })
  ctx.font = `500 9px ${MONO}`; ctx.fillStyle = COL.faint
  if (ly + lh + 14 < H) ctx.fillText("Jev's answer for the newest edit", cx, ly + lh + 13)
}

function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }

function drawRiver(f, x0, now, dt) {
  const left = x0 + 14, right = W - 14, top = 30, bottom = H - 22
  const h = bottom - top, y = (p) => bottom - p * h
  // zone bands
  const band = (p0, p1, col) => { ctx.fillStyle = col; ctx.fillRect(left, y(p1), right - left, y(p0) - y(p1)) }
  band(0, ease.reviewAt, 'rgba(52,211,153,.045)'); band(ease.reviewAt, ease.blockAt, 'rgba(251,191,36,.06)'); band(ease.blockAt, 1, 'rgba(251,113,133,.075)')
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(left, y(i / 4)); ctx.lineTo(right, y(i / 4)); ctx.stroke() }
  const thLine = (p, col, label) => {
    ctx.save(); ctx.setLineDash([5, 5]); ctx.lineDashOffset = -now / 60; ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.moveTo(left, y(p)); ctx.lineTo(right, y(p)); ctx.stroke(); ctx.restore()
    ctx.font = `700 9px ${MONO}`; ctx.textAlign = 'right'; ctx.fillStyle = col; ctx.fillText(`${label} ≥ ${fmtP(p)}`, right - 4, y(p) - 4)
  }
  thLine(ease.blockAt, COL.block, 'BLOCK'); thLine(ease.reviewAt, COL.review, 'REVIEW')
  // titles
  ctx.textAlign = 'left'; ctx.font = `600 10px ${MONO}`; ctx.fillStyle = COL.dim
  ctx.fillText("R I S K   R I V E R", left, 16)
  ctx.font = `500 10px ${MONO}`; ctx.fillStyle = COL.faint
  if (right - left > 560) ctx.fillText("· Jev's risk for each edit, newest on the right · ◇ marks a planted risk", left + 124, 16)
  if (f) {
    const live = f.mode === 'live'
    const tag = live ? `LIVE · real edits · demo back in ${Math.ceil(f.idleLeft / 1000)}s` : f.running ? 'DEMO STREAM · synthetic edits' : 'PAUSED'
    ctx.font = `700 10px ${MONO}`; ctx.textAlign = 'right'
    const tw = ctx.measureText(tag).width
    ctx.fillStyle = live ? 'rgba(52,211,153,.12)' : 'rgba(251,191,36,.12)'; roundRect(right - tw - 16, 4, tw + 16, 17, 8); ctx.fill()
    ctx.fillStyle = live ? COL.safe : COL.review; ctx.fillText(tag, right - 8, 16)
  }
  dots = []
  if (!f || !f.edits.length) { ctx.textAlign = 'center'; ctx.font = `500 12px ${MONO}`; ctx.fillStyle = COL.dim; ctx.fillText('waiting for the first edit…', (left + right) / 2, (top + bottom) / 2); return }
  const gap = Math.max(18, Math.min(30, (right - left) / 36))
  const xr = right - 86
  const n = Math.min(f.edits.length, Math.ceil((xr - left) / gap) + 2)
  const pts = []
  for (let k = 0; k < n; k++) { const e = f.edits[f.edits.length - 1 - k]; pts.push({ e, x: xr - k * gap + ease.shift * gap, y: y(e.riskP) }) }
  ctx.save(); ctx.beginPath(); ctx.rect(left, 0, right - left, H); ctx.clip()
  // the river: a soft filled curve through the dots
  if (pts.length > 1) {
    const path = (close) => {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], mx = (a.x + b.x) / 2; ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y) }
      if (close) { ctx.lineTo(pts[pts.length - 1].x, bottom); ctx.lineTo(pts[0].x, bottom); ctx.closePath() }
    }
    const g = ctx.createLinearGradient(0, top, 0, bottom); g.addColorStop(0, 'rgba(251,113,133,.30)'); g.addColorStop(0.5, 'rgba(251,191,36,.12)'); g.addColorStop(1, 'rgba(45,212,191,.03)')
    path(true); ctx.fillStyle = g; ctx.fill()
    path(false); ctx.strokeStyle = 'rgba(148,163,184,.55)'; ctx.lineWidth = 1.4; ctx.stroke()
  }
  const sel = currentId(f)
  let lastLabelX = Infinity
  pts.forEach((p, k) => {
    const e = p.e, col = COL[e.chip], fade = Math.max(0.25, Math.min(1, (p.x - left) / 90))
    if (p.x < left - 10) return
    dots.push({ x: p.x, y: p.y, e })
    ctx.globalAlpha = fade
    // uncertainty whisker: long when Jev is unsure
    const wlen = (1 - e.confidence) * 44 + 3
    ctx.strokeStyle = col; ctx.globalAlpha = fade * 0.35; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y - wlen); ctx.lineTo(p.x, p.y + wlen); ctx.stroke()
    ctx.globalAlpha = fade
    if (e.id === sel) { ctx.strokeStyle = 'rgba(45,212,191,.55)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(p.x, top); ctx.lineTo(p.x, bottom); ctx.stroke(); ctx.setLineDash([]) }
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = k === 0 ? 20 : e.chip === 'safe' ? 6 : 12
    ctx.beginPath(); ctx.arc(p.x, p.y, k === 0 ? 5.5 + Math.sin(now / 160) * 0.8 : e.chip === 'safe' ? 3.2 : 4.4, 0, 6.28); ctx.fillStyle = col; ctx.fill(); ctx.restore()
    if (e.truth === 'risky') { // ground truth, demo only
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); ctx.strokeStyle = e.outcome === 'missed' ? COL.block : 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.3
      const s = 7.5 + (e.outcome === 'missed' ? Math.sin(now / 200) * 1.2 : 0); ctx.strokeRect(-s, -s, s * 2, s * 2); ctx.restore()
    }
    if ((e.outcome === 'missed' || e.outcome === 'false alarm') && lastLabelX - p.x > 74 && p.x > left + 40) {
      lastLabelX = p.x
      ctx.font = `700 8.5px ${MONO}`; ctx.textAlign = 'center'; ctx.fillStyle = e.outcome === 'missed' ? COL.block : COL.review
      ctx.fillText(e.outcome === 'missed' ? (e.hotRead === false ? 'MISSED · NEVER READ' : 'MISSED') : 'FALSE ALARM', p.x, e.riskP > 0.6 ? p.y + 22 : p.y - 15)
    }
    if (e.id === sel) { ctx.strokeStyle = COL.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, 6.28); ctx.stroke() }
    ctx.globalAlpha = 1
  })
  ctx.restore()
  // fire the bursts now that the newest dots have a place
  while (pendingBursts.length) {
    const b = pendingBursts.shift(), p = pts.find((q) => q.e.id === b.id); if (!p) continue
    const px = p.x - ease.shift * gap
    rings.push({ x: px, y: p.y, r: 4, a: 1, col: b.col })
    for (let i = 0; i < b.n; i++) { const a = Math.random() * 6.28, s = 30 + Math.random() * 110; particles.push({ x: px, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, life: 0, max: 0.5 + Math.random() * 0.6, col: b.col }) }
  }
  // newest edit: label to the right of its dot
  const p0 = pts[0]
  ctx.textAlign = 'left'; ctx.font = `800 11px ${MONO}`; ctx.fillStyle = COL[p0.e.chip]
  const lx = Math.min(right - 80, p0.x + 12), ly = Math.max(top + 12, Math.min(bottom - 14, p0.y))
  ctx.fillText(p0.e.chip.toUpperCase(), lx, ly - 1)
  ctx.font = `600 9.5px ${MONO}`; ctx.fillStyle = COL.dim; ctx.fillText(`risk ${fmtP(p0.e.riskP)} · #${p0.e.id}`, lx, ly + 11)
  if (hover) {
    const e = hover.e, text = `#${e.id} ${e.chip.toUpperCase()} · risk ${fmtP(e.riskP)} · ${e.note}`
    ctx.font = `600 10px ${MONO}`
    const tw = Math.min(right - left - 10, ctx.measureText(text).width + 14), tx = Math.max(left, Math.min(right - tw, hover.x - tw / 2)), ty = hover.y > top + 40 ? hover.y - 30 : hover.y + 14
    ctx.fillStyle = 'rgba(8,10,16,.94)'; roundRect(tx, ty, tw, 18, 6); ctx.fill(); ctx.strokeStyle = COL[e.chip]; ctx.lineWidth = 1; ctx.stroke()
    ctx.save(); ctx.beginPath(); ctx.rect(tx, ty, tw - 6, 18); ctx.clip(); ctx.fillStyle = COL.ink; ctx.textAlign = 'left'; ctx.fillText(text, tx + 7, ty + 12.5); ctx.restore()
  }
}

function drawParticles(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.r += dt * 90; r.a -= dt * 1.9
    if (r.a <= 0) { rings.splice(i, 1); continue }
    ctx.strokeStyle = r.col; ctx.globalAlpha = r.a * 0.8; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.28); ctx.stroke(); ctx.globalAlpha = 1
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life += dt
    if (p.life >= p.max) { particles.splice(i, 1); continue }
    p.vy += 160 * dt; p.vx *= 0.985; p.x += p.vx * dt; p.y += p.vy * dt
    const a = 1 - p.life / p.max
    ctx.globalAlpha = a; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 + a * 1.6, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1
  }
  if (particles.length > 400) particles.splice(0, particles.length - 400)
}

// ---------------------------------------------------------------- go
function connect() {
  const es = new EventSource('/events')
  es.addEventListener('state', (ev) => { try { apply(JSON.parse(ev.data)) } catch (e) { console.error('bad frame', e) } })
  es.onerror = () => { /* the browser reconnects on its own */ }
}
fit(); connect(); pollJev(); requestAnimationFrame(draw)
