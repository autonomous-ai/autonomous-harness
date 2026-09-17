// The Marp pane: the deck the agent is writing, as a presenter would want it. Four ways to look at
// it — a slide with its notes and a filmstrip, a grid of every slide, a presenter view (now, next,
// notes, timer) and presenting itself — all fed by one /deck.json and redrawn on every save
// without losing the slide you are on. Plain DOM, no build step.
(() => {
  'use strict'
  // The pane's own elements, looked up once before any slide is in the page: marp gives every
  // heading an id from its text, so a slide titled "Notes" or "Next" would otherwise answer
  // getElementById('notes') instead of the notes panel.
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]))
  const $ = (id) => els[id] || document.getElementById(id)

  const ICONS = {
    slide: '<rect x="2.5" y="4" width="15" height="10" rx="1.5"/><path d="M6 17h8"/>',
    grid: '<rect x="3" y="3.5" width="6" height="5.5" rx="1"/><rect x="11" y="3.5" width="6" height="5.5" rx="1"/><rect x="3" y="11" width="6" height="5.5" rx="1"/><rect x="11" y="11" width="6" height="5.5" rx="1"/>',
    presenter: '<rect x="2.5" y="4" width="9.5" height="7" rx="1.2"/><rect x="13.5" y="4" width="4" height="3" rx=".8"/><path d="M13.5 9.5h4M13.5 12h4M2.5 14.5h15"/>',
    play: '<path d="M6.5 4.5v11l9-5.5z"/>',
    left: '<path d="M12.5 4.5L7 10l5.5 5.5"/>',
    right: '<path d="M7.5 4.5L13 10l-5.5 5.5"/>',
    expand: '<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5L11.5 8.5M3.5 16.5l5-5"/>',
    close: '<path d="M5 5l10 10M15 5L5 15"/>',
  }
  const paintIcons = (root = document) => root.querySelectorAll('i[data-icon]').forEach((i) => { i.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[i.dataset.icon] || ''}</svg>` })
  paintIcons()
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

  const file = new URLSearchParams(location.search).get('file') || 'deck.md'
  const key = (k) => `harness.marp.${k}`
  const store = {
    get(k, d) { try { const v = localStorage.getItem(key(k)); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem(key(k), JSON.stringify(v)) } catch { /* private mode */ } },
  }

  const S = {
    slides: [],            // [{html, notes, title}]
    css: null, verdict: null, flags: new Map(),
    current: store.get('current:' + file, 0),
    view: store.get('view', 'slide'),
    follow: store.get('follow', true),
    lastNav: 0,            // when the reader last moved; following waits while they browse
    presenting: false, black: false,
    timerStart: null,
    loaded: false,
  }

  // ------------------------------------------------------------------ data
  // Heading ids come out of marp once per slide; the pane shows each slide up to three times, so
  // they would repeat, and they could shadow the pane's own ids. Headings do not need them here.
  const stripScripts = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/(<h[1-6]\b[^>]*?)\s+id="[^"]*"/g, '$1')
  async function load() {
    let d
    try {
      d = await (await fetch('/deck.json?file=' + encodeURIComponent(file), { cache: 'no-store' })).json()
    } catch {
      toast('The pane lost its link to the workspace; retrying…', { err: true })
      return
    }
    if (d.error) {
      if (S.slides.length) toast(`The latest save does not render: ${d.error}. Showing the last good deck.`, { err: true, ms: 6000 })
      else showEmpty('The deck does not render yet', d.error)
      return
    }
    if (d.missing) {
      // A save by rename leaves the deck missing for a moment: keep the slides through a blink.
      if (S.slides.length && (S.missingRetries = (S.missingRetries || 0) + 1) <= 4) { setTimeout(load, 350); return }
      S.slides = []; S.verdict = null; S.loaded = false
      for (const box of [$('strip'), $('grid')]) box.innerHTML = ''
      render()
      showEmpty('The deck appears here as it is written', `Describe the talk to the agent. Within a minute the outline of <b>${esc(file)}</b> lands here, one slide per beat; then the art, then the words and the notes, slide by slide.`)
      return
    }
    S.missingRetries = 0
    $('empty').hidden = true
    const next = d.html.map((h, i) => ({ html: stripScripts(h), notes: (d.slides[i] && d.slides[i].notes) || '', title: (d.slides[i] && d.slides[i].title) || '' }))
    const first = !S.loaded
    const cssChanged = d.css !== S.css
    // Two kinds of difference: markup that must be redrawn, and content the agent actually edited.
    // Adding a slide rewrites every slide's pagination total, which is the first kind only.
    const content = (x) => (x ? x.html.replace(/ data-marpit-pagination-total="\d+"/g, '') + '\u0000' + x.notes : null)
    const changed = new Set(), edited = new Set()
    next.forEach((s, i) => {
      const old = S.slides[i]
      if (!old || old.html !== s.html || old.notes !== s.notes) changed.add(i)
      if (content(old) !== content(s)) edited.add(i)
    })
    const removed = S.slides.length > next.length
    S.slides = next
    S.loaded = true
    if (cssChanged) { S.css = d.css; $('deckcss').textContent = d.css }
    const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(next[0] ? next[0].html : '')
    if (vb) document.documentElement.style.setProperty('--ratio', String(Number(vb[1]) / Number(vb[2])))
    S.verdict = d.verdict
    S.flags = new Map()
    for (const f of (d.verdict && d.verdict.findings) || []) {
      for (const i of slidesFor(f)) if (f.severity === 'error' || !S.flags.has(i)) S.flags.set(i, f.severity)
    }
    // Follow the agent: a save that edited one to three slides moves you to the last of them,
    // unless you have browsed in the last twelve seconds or are presenting. Otherwise say where.
    const touched = [...edited].sort((a, b) => a - b)
    if (!first && touched.length && touched.length <= 3) {
      const target = touched[touched.length - 1]
      if (S.follow && !S.presenting && Date.now() - S.lastNav > 12000) S.current = target
      else if (target !== S.current && !S.presenting) toast(`Slide ${target + 1} updated`, { action: 'Show', run: () => go(target) })
    }
    S.current = clamp(S.current, 0, Math.max(0, S.slides.length - 1))
    render({ changed: cssChanged ? new Set(S.slides.keys()) : changed, edited: first ? new Set() : edited, rebuild: removed })
  }

  /** The slides a finding is about: its `slide N` ref, or the slides that use the image it names. */
  function slidesFor(f) {
    const m = /^slide (\d+)$/.exec(f.ref || '')
    if (m) return [Number(m[1]) - 1]
    if (!f.ref) return []
    const needle = String(f.ref)
    return S.slides.map((s, i) => (s.html.includes(needle) || s.html.includes(encodeURI(needle)) ? i : -1)).filter((i) => i >= 0)
  }

  function showEmpty(title, html) {
    $('emptyTitle').textContent = title
    $('emptyText').innerHTML = html
    $('empty').hidden = false
  }

  // ------------------------------------------------------------------ rendering
  const marpit = (i) => `<div class="marpit">${S.slides[i].html}</div>`
  const frame = (i) => `<div class="frame">${marpit(i)}</div>`
  const notesHtml = (i) => {
    const text = (S.slides[i] && S.slides[i].notes || '').trim()
    if (!text) return '<p class="none">No speaker notes on this slide.</p>'
    return text.split(/\n\s*\n|\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('')
  }
  const titleOf = (i) => (S.slides[i] && S.slides[i].title) || `Slide ${i + 1}`

  function render({ changed = new Set(), edited = new Set(), rebuild = false } = {}) {
    renderChrome()
    syncList($('strip'), 'thumb', changed, rebuild, edited)
    if (S.view === 'grid' || $('grid').children.length) syncList($('grid'), 'card', changed, rebuild, edited)
    renderStage(changed.has(S.current) && edited.has(S.current))
    renderPresenter()
    if (S.presenting) renderShow()
    requestAnimationFrame(() => { layout(); reveal() })
  }

  function renderChrome() {
    const n = S.slides.length
    const deckTitle = n ? titleOf(0) : file
    $('deckTitle').textContent = deckTitle
    $('deckTitle').title = file
    $('counter').textContent = n ? `${S.current + 1} / ${n}` : ''
    const chip = $('checks'), v = S.verdict
    if (!v || !n) { chip.hidden = true } else {
      const errs = v.findings.filter((f) => f.severity === 'error').length
      const warns = v.findings.filter((f) => f.severity === 'warning').length
      chip.hidden = false
      chip.className = 'chip ' + (errs ? 'err' : warns ? 'warn' : v.ready ? 'ok' : '')
      chip.innerHTML = '<b></b>' + (errs ? plural(errs, 'error') : warns ? plural(warns, 'warning') : v.ready ? 'Ready' : 'Drafting')
      chip.title = v.summary || ''
    }
    document.title = n ? `${deckTitle} · ${S.current + 1}/${n}` : 'Marp'
  }

  function syncList(box, kind, changed, rebuild, edited) {
    const n = S.slides.length
    if (rebuild) box.innerHTML = ''
    while (box.children.length > n) box.lastElementChild.remove()
    for (let i = 0; i < n; i++) {
      let el = box.children[i]
      if (!el) {
        el = document.createElement('button')
        el.className = kind
        el.dataset.i = i
        el.innerHTML = kind === 'thumb'
          ? `<span class="n">${i + 1}</span>${frame(i)}<span class="flag" hidden></span>`
          : `${frame(i)}<div class="cap"><b>${i + 1}</b><span></span><i class="dot" hidden></i></div>`
        box.append(el)
      } else if (changed.has(i)) {
        el.querySelector('.frame').innerHTML = marpit(i)
      }
      el.classList.toggle('current', i === S.current)
      el.title = `${i + 1}. ${titleOf(i)}`
      const flag = S.flags.get(i)
      const mark = el.querySelector(kind === 'thumb' ? '.flag' : '.dot')
      mark.hidden = !flag
      mark.className = (kind === 'thumb' ? 'flag ' : 'dot ') + (flag || '')
      if (kind === 'card') el.querySelector('.cap span').textContent = titleOf(i)
      if (edited.has(i)) { el.classList.remove('edited'); void el.offsetWidth; el.classList.add('edited'); setTimeout(() => el.classList.remove('edited'), 2600) }
    }
  }

  let stageIndex = -1
  function renderStage(flash) {
    const n = S.slides.length
    if (!n) { $('stage').innerHTML = ''; $('notes').innerHTML = ''; stageIndex = -1; return }
    const i = S.current
    $('stage').innerHTML = frame(i)
    if (flash && stageIndex === i) { $('stage').classList.remove('flash'); void $('stage').offsetWidth; $('stage').classList.add('flash') }
    stageIndex = i
    $('prev').disabled = i === 0
    $('next').disabled = i === n - 1
    const findings = ((S.verdict && S.verdict.findings) || []).filter((f) => slidesFor(f).includes(i))
    $('notes').innerHTML = `<div class="head"><b>Notes</b><span>${esc(i + 1 + '. ' + titleOf(i))}</span></div>${notesHtml(i)}` +
      findings.map((f) => `<div class="finding ${esc(f.severity)}"><b>${esc(f.severity)}</b><span>${esc(f.message)}</span></div>`).join('')
  }

  function renderPresenter() {
    const n = S.slides.length, i = S.current
    if (!n) { $('pNow').innerHTML = ''; $('pNext').innerHTML = ''; $('pNotes').innerHTML = ''; return }
    $('pNow').innerHTML = frame(i)
    $('pNowTitle').textContent = `${i + 1}. ${titleOf(i)}`
    $('pNext').innerHTML = i + 1 < n ? frame(i + 1) : '<div class="end">End of the deck</div>'
    $('pNextTitle').textContent = i + 1 < n ? `${i + 2}. ${titleOf(i + 1)}` : ''
    $('pNotes').innerHTML = notesHtml(i)
    $('pCount').textContent = `${i + 1} / ${n}`
  }

  function renderShow() {
    const n = S.slides.length
    if (!n) return
    $('showSlide').innerHTML = frame(S.current)
    $('sCount').textContent = `${S.current + 1} / ${n}`
    layout()
  }

  // Size each big slide to the space it has, keeping the deck's aspect ratio.
  function ratio() { return Number(getComputedStyle(document.documentElement).getPropertyValue('--ratio')) || 16 / 9 }
  function fit(el, w, h) { const r = ratio(); const width = Math.max(40, Math.min(w, h * r)); el.style.width = width + 'px' }
  // The slide takes the width it can while leaving the notes a readable band under it.
  const NOTES_MIN = 150
  function layout() {
    const r = ratio()
    if (S.view === 'slide') {
      const wrap = $('stageWrap'), cs = getComputedStyle(wrap), focus = wrap.parentElement
      const w = focus.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const h = focus.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - NOTES_MIN
      fit($('stage'), w, h)
    }
    if (S.view === 'presenter') {
      const view = $('presenterView'), now = $('pNow'), col = now.parentElement
      const label = col.querySelector('.p-label')
      const narrow = view.clientWidth < 900
      // Now keeps at most 58% of the height (62% wide), so the notes stay readable under it.
      fit(now, col.clientWidth, view.clientHeight * (narrow ? 0.46 : 0.6) - label.offsetHeight)
      now.style.margin = narrow ? '0 auto' : ''
    }
    if (S.presenting) fit($('showSlide'), window.innerWidth, window.innerHeight)
    void r
  }
  new ResizeObserver(() => layout()).observe($('views'))
  window.addEventListener('resize', layout)

  // ------------------------------------------------------------------ navigation
  function go(i, { user = true } = {}) {
    const n = S.slides.length
    if (!n) return
    const next = clamp(i, 0, n - 1)
    if (user) S.lastNav = Date.now()
    if (next === S.current && stageIndex === next) return
    S.current = next
    store.set('current:' + file, next)
    renderChrome()
    for (const box of [$('strip'), $('grid')]) {
      for (const el of box.children) el.classList.toggle('current', Number(el.dataset.i) === next)
    }
    renderStage(false)
    renderPresenter()
    if (S.presenting) renderShow()
    reveal()
    requestAnimationFrame(layout)
  }
  function reveal() {
    const box = S.view === 'grid' ? $('grid') : $('strip')
    const el = box.children[S.current]
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }

  function setView(v) {
    if (!['slide', 'grid', 'presenter'].includes(v)) v = 'slide'
    S.view = v
    store.set('view', v)
    document.body.className = 'view-' + v
    $('slideView').hidden = v !== 'slide'
    $('gridView').hidden = v !== 'grid'
    $('presenterView').hidden = v !== 'presenter'
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v))
    if (v === 'grid' && S.slides.length && $('grid').children.length !== S.slides.length) syncList($('grid'), 'card', new Set(), true, new Set())
    if (v === 'presenter' && !S.timerStart) S.timerStart = Date.now()
    requestAnimationFrame(() => { layout(); reveal() })
  }

  // ------------------------------------------------------------------ presenting
  let idleTimer = 0
  function wake() {
    const show = $('show')
    show.classList.remove('idle'); show.classList.add('cursor')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { show.classList.add('idle'); show.classList.remove('cursor') }, 2200)
  }
  function present(on, { full = false } = {}) {
    if (!S.slides.length) return
    S.presenting = on
    $('show').hidden = !on
    closePopover()
    if (on) {
      if (!S.timerStart) S.timerStart = Date.now()
      S.black = false; $('show').classList.remove('black')
      renderShow(); wake(); tick()
      if (full) fullscreen(true)
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      requestAnimationFrame(() => { layout(); reveal() })
    }
  }
  function fullscreen(on) {
    const el = document.documentElement
    if (on && !document.fullscreenElement) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen
      if (req) Promise.resolve(req.call(el)).catch(() => toast('Full screen is not available in this pane; use the pane’s zoom button.'))
      else toast('Full screen is not available in this pane; use the pane’s zoom button.')
    } else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }
  $('show').addEventListener('mousemove', wake)
  $('show').addEventListener('click', (ev) => {
    if (ev.target.closest('.show-bar')) return
    if (ev.clientX < window.innerWidth * 0.25) go(S.current - 1); else go(S.current + 1)
  })
  $('sPrev').onclick = () => go(S.current - 1)
  $('sNext').onclick = () => go(S.current + 1)
  $('sExit').onclick = () => present(false)
  $('sFull').onclick = () => fullscreen(!document.fullscreenElement)
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(layout))

  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0') }
  function tick() {
    const elapsed = S.timerStart ? Date.now() - S.timerStart : 0
    $('timer').textContent = mmss(elapsed)
    $('sTimer').textContent = mmss(elapsed)
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  setInterval(tick, 1000); tick()
  $('timer').onclick = () => { S.timerStart = Date.now(); tick() }

  // ------------------------------------------------------------------ popover and toast
  function closePopover() { $('popover').hidden = true }
  $('checks').onclick = (ev) => {
    ev.stopPropagation()
    const pop = $('popover')
    if (!pop.hidden) { closePopover(); return }
    const v = S.verdict
    const rows = (v.findings || []).map((f) => {
      const at = slidesFor(f)
      const body = `<span class="sev ${esc(f.severity)}">${esc(f.severity)}</span><span class="msg">${esc(f.message)}${at.length ? ` <span class="faint">· slide ${at[0] + 1}</span>` : ''}</span>`
      return at.length ? `<button data-go="${at[0]}">${body}</button>` : `<div class="row">${body}</div>`
    }).join('')
    pop.innerHTML = `<div class="label">${esc(v.summary || 'The check')}</div>` + (rows || '<div class="row"><span class="msg">Nothing to fix. The check has nothing left to say.</span></div>')
    const r = $('checks').getBoundingClientRect()
    pop.style.left = clamp(r.left, 8, window.innerWidth - 368) + 'px'
    pop.hidden = false
  }
  $('popover').addEventListener('click', (ev) => { const b = ev.target.closest('[data-go]'); if (b) { closePopover(); if (S.view === 'grid') setView('slide'); go(Number(b.dataset.go)) } })
  document.addEventListener('click', (ev) => { if (!ev.target.closest('#popover')) closePopover() })

  let toastTimer = 0
  function toast(text, { err = false, ms = 3200, action, run } = {}) {
    const t = $('toast')
    t.className = 'toast' + (err ? ' err' : '')
    t.innerHTML = `<span>${esc(text)}</span>` + (action ? `<button>${esc(action)}</button>` : '')
    if (action) t.querySelector('button').onclick = () => { t.hidden = true; run() }
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.hidden = true }, action ? Math.max(ms, 5000) : ms)
  }

  // ------------------------------------------------------------------ wiring
  const pick = (ev) => { const el = ev.target.closest('[data-i]'); if (el) { go(Number(el.dataset.i)); return true } return false }
  $('strip').addEventListener('click', pick)
  $('grid').addEventListener('click', (ev) => { if (pick(ev)) setView('slide') })
  $('grid').addEventListener('dblclick', (ev) => { const el = ev.target.closest('[data-i]'); if (el) { go(Number(el.dataset.i)); present(true) } })
  $('prev').onclick = () => go(S.current - 1)
  $('next').onclick = () => go(S.current + 1)
  $('stage').addEventListener('click', () => go(S.current + 1))
  $('pNow').addEventListener('click', () => go(S.current + 1))
  $('pNext').addEventListener('click', () => go(S.current + 1))
  document.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => setView(b.dataset.view) })
  $('presentBtn').onclick = () => present(true)
  function setFollow(on) {
    S.follow = on; store.set('follow', on)
    $('follow').classList.toggle('on', on)
    $('follow').setAttribute('aria-pressed', String(on))
  }
  $('follow').onclick = () => { setFollow(!S.follow); toast(S.follow ? 'Following edits: the pane moves to the slide the agent is writing.' : 'Not following: the pane stays on your slide.') }
  $('help').onclick = () => { $('help').hidden = true }

  let digits = '', digitTimer = 0
  function typeDigit(d) {
    digits = (digits + d).slice(-3)
    clearTimeout(digitTimer)
    digitTimer = setTimeout(() => { digits = ''; $('jump').hidden = true }, 1600)
    if (S.presenting) { $('jump').hidden = false; $('jump').textContent = `Go to ${digits}` } else toast(`Go to slide ${digits} — press Enter`, { ms: 1600 })
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const k = ev.key
    if (!$('help').hidden) { $('help').hidden = true; ev.preventDefault(); return }
    if (/^[0-9]$/.test(k)) { typeDigit(k); ev.preventDefault(); return }
    if (k === 'Enter' && digits) { go(Number(digits) - 1); digits = ''; $('jump').hidden = true; $('toast').hidden = true; ev.preventDefault(); return }
    const nextKeys = ['ArrowRight', 'ArrowDown', 'PageDown', 'l', 'j']
    const prevKeys = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'h', 'k']
    if (nextKeys.includes(k) || (k === ' ' && !ev.shiftKey)) { go(S.current + (S.view === 'grid' && (k === 'ArrowDown') ? gridColumns() : 1)); ev.preventDefault(); return }
    if (prevKeys.includes(k) || (k === ' ' && ev.shiftKey)) { go(S.current - (S.view === 'grid' && (k === 'ArrowUp') ? gridColumns() : 1)); ev.preventDefault(); return }
    if (k === 'Home') { go(0); ev.preventDefault(); return }
    if (k === 'End') { go(S.slides.length - 1); ev.preventDefault(); return }
    if (S.presenting) {
      if (k === 'Escape') present(false)
      else if (k === 'f' || k === 'F') fullscreen(!document.fullscreenElement)
      else if (k === 'b' || k === 'B' || k === '.') { S.black = !S.black; $('show').classList.toggle('black', S.black) }
      else if (k === '?') $('help').hidden = false
      else return
      ev.preventDefault(); return
    }
    const act = {
      p: () => present(true), P: () => present(true), f: () => present(true, { full: true }), F: () => present(true, { full: true }),
      g: () => setView(S.view === 'grid' ? 'slide' : 'grid'), G: () => setView(S.view === 'grid' ? 'slide' : 'grid'),
      s: () => setView('slide'), S: () => setView('slide'),
      n: () => setView(S.view === 'presenter' ? 'slide' : 'presenter'), N: () => setView(S.view === 'presenter' ? 'slide' : 'presenter'),
      Escape: () => { closePopover(); if (S.view === 'grid') setView('slide') },
      Enter: () => { if (S.view === 'grid') setView('slide') },
      '?': () => { $('help').hidden = false },
    }[k]
    if (act) { act(); ev.preventDefault() }
  })
  function gridColumns() {
    const cards = [...$('grid').children]
    if (cards.length < 2) return 1
    const top = cards[0].offsetTop
    const n = cards.findIndex((c) => c.offsetTop !== top)
    return n < 0 ? cards.length : n
  }

  setFollow(S.follow)
  setView(S.view)
  const events = new EventSource('/events')
  events.addEventListener('change', load)
  events.onopen = () => { if (S.loaded) load() } // after a reconnect, catch up on what was missed
  load().then(() => {
    if (location.hash === '#present') present(true)
    requestAnimationFrame(() => { layout(); reveal() })
  })
  window.__pane = S // for tests
})()
