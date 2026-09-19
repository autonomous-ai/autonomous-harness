// Jev Browser pane. The server sends one frame per step: the action Jev just chose (with the full
// probability over the elements it could have chosen) and the page as it is now. This file plays
// that as: rings on the old page showing Jev's mind -> the cursor flies to the chosen spot -> a click
// ripple (red when a layout shift made it land somewhere else) -> the new page.
'use strict'

const $ = (id) => document.getElementById(id)
const page = $('page'), viewport = $('viewport'), cursor = $('cursor'), stamp = $('stamp')
const PAGE_W = 1000, PAGE_H = 620
let scale = 1, showMind = true, paused = false
let cur = { x: 500, y: 320 }, anim = null, pending = null
let lastTaskKey = '', costAtTaskStart = 0, costNow = 0, lastFeedLen = -1
const nodes = new Map() // element id -> DOM node

function fit() {
  const r = viewport.getBoundingClientRect()
  scale = Math.min(r.width / PAGE_W, r.height / PAGE_H)
  page.style.transform = `scale(${scale})`
  page.style.left = Math.max(0, (r.width - PAGE_W * scale) / 2) + 'px'
  placeCursor()
}
new ResizeObserver(fit).observe(viewport)
const placeCursor = () => { const off = parseFloat(page.style.left) || 0; cursor.style.transform = `translate(${off + cur.x * scale - 3}px, ${cur.y * scale - 2}px)` }

// ---------------------------------------------------------------- the page
function renderPage(f) {
  const seen = new Set()
  for (const e of f.els) {
    seen.add(e.id)
    let n = nodes.get(e.id)
    if (!n) {
      n = document.createElement('div'); n.dataset.id = e.id; nodes.set(e.id, n); page.appendChild(n)
      n.classList.add('pop')
      n.addEventListener('click', () => { if (n.classList.contains('act')) post({ cmd: 'click', id: e.id }) })
    }
    const isOn = e.value === 'on'
    n.className = ['el', e.role, e.act ? 'act' : '', e.tone ? 't-' + e.tone : '', e.disabled ? 'disabled' : '', e.blocked ? 'blocked' : '', e.overlay ? 'overlay-el' : '', isOn ? 'is-on' : '', e.role === 'input' && e.value ? 'filled' : '', f.shake === e.id ? 'shake' : '', n.classList.contains('pop') ? 'pop' : ''].filter(Boolean).join(' ')
    const [x, y, w, h] = e.rect
    n.style.left = x + 'px'; n.style.top = y + 'px'; n.style.width = w + 'px'; n.style.height = h + 'px'
    if (e.role === 'input') { n.dataset.label = e.label; if (n.dataset.typing !== '1') n.textContent = e.value || '' }
    else if (e.role === 'toggle') n.textContent = (isOn ? '☑ ' : '☐ ') + e.label
    else n.textContent = e.label
    n.title = e.act ? `${e.id} — click it yourself` : ''
  }
  for (const [id, n] of nodes) if (!seen.has(id)) { n.remove(); nodes.delete(id) }
  setTimeout(() => { for (const n of nodes.values()) n.classList.remove('pop') }, 240)
}

function clearRings() { for (const r of page.querySelectorAll('.ring')) r.remove() }
function drawRings(f) {
  clearRings()
  if (!showMind || !f.last?.probs) return
  const top = Object.entries(f.last.probs).sort((a, b) => b[1] - a[1]).slice(0, 4)
  top.forEach(([id, p], i) => {
    const n = nodes.get(id); if (!n || p < 0.03) return
    const r = document.createElement('div'); r.className = 'ring' + (i === 0 ? ' top' : '')
    r.style.left = parseFloat(n.style.left) - 4 + 'px'; r.style.top = parseFloat(n.style.top) - 4 + 'px'
    r.style.width = parseFloat(n.style.width) + 8 + 'px'; r.style.height = parseFloat(n.style.height) + 8 + 'px'
    r.style.opacity = String(0.35 + 0.65 * Math.min(1, p * 1.4))
    const b = document.createElement('b'); b.textContent = p >= 0.995 ? '1.00' : p.toFixed(2).replace(/^0/, ''); r.appendChild(b)
    page.appendChild(r)
  })
}

function ripple(x, y, miss, note) {
  const r = document.createElement('div'); r.className = 'ripple' + (miss ? ' miss' : ''); r.style.left = x + 'px'; r.style.top = y + 'px'
  page.appendChild(r); setTimeout(() => r.remove(), 480)
  if (note) { const s = document.createElement('div'); s.className = 'shiftnote'; s.textContent = note; s.style.left = Math.min(PAGE_W - 220, x + 14) + 'px'; s.style.top = Math.max(8, y - 30) + 'px'; page.appendChild(s); setTimeout(() => s.remove(), 920) }
}

function typeInto(id, text, ms) {
  const n = nodes.get(id); if (!n || !text) return
  n.dataset.typing = '1'; n.textContent = ''
  const t0 = performance.now()
  const tick = () => { const k = Math.min(text.length, Math.ceil(((performance.now() - t0) / ms) * text.length)); n.textContent = text.slice(0, k); if (k < text.length) requestAnimationFrame(tick); else n.dataset.typing = '0' }
  tick()
}

// ---------------------------------------------------------------- one frame = one played step
function play(f) {
  const a = f.lastAction
  const isNewStep = a && (!play.lastStep || a.step !== play.lastStep || f.task.goal !== play.lastGoal)
  play.lastStep = a?.step; play.lastGoal = f.task.goal
  if (!isNewStep) { if (!anim) { clearRings(); renderPage(f) } return }
  // 1. rings on the page Jev read, 2. fly, 3. click, 4. show the page as it is now
  drawRings(f)
  const dwell = paused ? 900 : 0 // stepping by hand: time to read Jev's mind on the page it read
  const from = { ...cur }, to = { x: a.x, y: a.y }, dur = Math.max(50, Math.min(150, f.stepMs * 0.55)), t0 = performance.now() + dwell
  if (anim) cancelAnimationFrame(anim)
  const stepAnim = (now) => {
    if (now < t0) { anim = requestAnimationFrame(stepAnim); return }
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3)
    cur = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e - Math.sin(k * Math.PI) * Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.12) }
    placeCursor()
    if (k < 1) { anim = requestAnimationFrame(stepAnim); return }
    anim = null
    const miss = !!a.shift && a.landed !== a.id
    ripple(a.x, a.y, miss || /disabled|blocked|no such/.test(a.note || ''), a.shift ? (miss ? `layout shifted: ${a.shift}` : a.shift) : '')
    clearRings()
    renderPage(f)
    if (a.typed) typeInto(a.landed, a.typed, Math.max(40, f.stepMs * 0.35))
  }
  anim = requestAnimationFrame(stepAnim)
}

// ---------------------------------------------------------------- everything around the page
const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

function paintGoal(f) {
  const g = esc(f.task.goal).replace(/\b(cheapest|earliest|latest|nonstop)\b/g, '<b>$1</b>').replace(/from (\S+) to (\S+) on (\S+)/, 'from <b>$1</b> to <b>$2</b> on <b>$3</b>')
  $('goal').innerHTML = g
  $('taskNo').textContent = `TASK ${f.task.index + 1}/${f.task.count}`
}
function paintStateText(f) {
  const pick = f.last?.choice
  $('stateText').innerHTML = (f.stateText || '').split('\n').slice(1).map((l) => {
    const e = esc(l)
    if (/^(TASK|PAGE|OVERLAY|PAGE TEXT|ELEMENTS|RECENT)/.test(l)) return e.replace(/^([A-Z ]+)/, '<span class="k">$1</span>').replace(/(a (cookie banner|pop-up) covers.*)/, '<span class="warn">$1</span>')
    if (pick && l.startsWith(`  ${pick}  `)) return `<span class="pick">${e}</span>`
    return e
  }).join('\n')
}
function paintFeed(f) {
  const rs = f.session.results
  if (f.session.tasks === lastFeedLen) return
  lastFeedLen = f.session.tasks
  $('feed').innerHTML = rs.slice().reverse().map((r) => `<li class="${r.ok ? 'ok' : 'bad'}"><i>${r.ok ? '✓' : '✗'}</i><span><b>${(r.wallMs / 1000).toFixed(1)} s · ${r.steps} steps</b> · ${esc(r.ok ? r.goal.replace(/^Book the /, '').replace(/ for .*/, '') : r.why)}</span></li>`).join('') || '<li><i></i><span>The first booking is under way.</span></li>'
}

function onFrame(f) {
  paused = !f.running
  const key = `${f.task.round}:${f.task.index}:${f.task.goal}`
  if (key !== lastTaskKey) { lastTaskKey = key; costAtTaskStart = costNow; stamp.classList.add('hidden'); play.lastStep = null }
  play(f)
  paintGoal(f); paintStateText(f); paintFeed(f)
  $('title').textContent = f.title
  $('tabTitle').textContent = `${f.site} · ${f.page}`
  $('url').textContent = f.url
  $('m-time').textContent = (f.wallMs / 1000).toFixed(1); $('m-steps').textContent = f.steps; $('m-cost').textContent = fmtMoney(Math.max(0, costNow - costAtTaskStart))
  $('m-note').textContent = f.lastAction?.note && !/you clicked$/.test(f.lastAction.note) ? f.lastAction.note : ''
  const s = f.session
  $('s-tasks').textContent = s.tasks; $('s-ok').textContent = s.tasks ? Math.round((s.ok / s.tasks) * 100) + '%' : '—'
  $('s-steps').textContent = s.tasks ? (s.steps / s.tasks).toFixed(1) : '—'; $('s-secs').textContent = s.tasks ? (s.wallMs / s.tasks / 1000).toFixed(1) : '—'
  $('s-mis').textContent = s.misclicks + f.misclicks
  $('pause').textContent = f.running ? 'Pause' : 'Resume'
  if (document.activeElement !== $('distraction')) { $('distraction').value = f.distraction; $('distractionVal').textContent = Number(f.distraction).toFixed(2) }
  if (document.activeElement !== $('stepMs')) { $('stepMs').value = f.stepMs; $('stepMsVal').textContent = f.stepMs }
  const problem = f.cfgError || f.error
  $('cfgError').classList.toggle('hidden', !problem); $('cfgError').textContent = problem ? `site.json: ${problem} — still running on the last good settings.` : ''
  if (f.status === 'done' && f.result) {
    stamp.className = 'stamp ' + (f.result.ok ? 'ok' : 'bad')
    stamp.innerHTML = `<h2>${f.result.ok ? 'Booked. Exactly right.' : 'Wrong booking'}</h2><div class="nums">${(f.wallMs / 1000).toFixed(1)} s · ${f.steps} steps · ${fmtMoney(Math.max(0, costNow - costAtTaskStart))}</div><p>${esc(f.result.why)}</p>`
  } else stamp.classList.add('hidden')
}

const post = (body) => fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
$('pause').onclick = () => post({ cmd: paused ? 'start' : 'pause' })
$('step').onclick = () => post({ cmd: 'tick' })
$('reset').onclick = () => post({ cmd: 'reset' })
$('popup').onclick = () => post({ cmd: 'popup' })
$('nextTask').onclick = () => { const m = /(\d+)\/(\d+)/.exec($('taskNo').textContent); post({ cmd: 'task', index: m ? Number(m[1]) % Number(m[2]) : 0 }) }
$('heat').onclick = () => { showMind = !showMind; $('heat').classList.toggle('on', showMind); if (!showMind) clearRings() }
$('distraction').oninput = (e) => { $('distractionVal').textContent = Number(e.target.value).toFixed(2); post({ cmd: 'set', key: 'distraction', value: Number(e.target.value) }) }
$('stepMs').oninput = (e) => { $('stepMsVal').textContent = e.target.value; post({ cmd: 'set', key: 'stepMs', value: Number(e.target.value) }) }

async function pollJev() {
  try { const s = await (await fetch('/jev', { cache: 'no-store' })).json(); costNow = s.costUsd; $('s-rate').textContent = s.callsPerSec.toFixed(1); $('s-cost').textContent = fmtMoney(s.costUsd) } catch { /* restarting */ }
  setTimeout(pollJev, 400)
}

fit()
const es = new EventSource('/events')
es.addEventListener('state', (e) => onFrame(JSON.parse(e.data)))
pollJev()
