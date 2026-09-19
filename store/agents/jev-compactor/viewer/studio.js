// Jev Compactor pane. One big canvas: the context tower (Jev lane), a giant token odometer, the
// last-compaction card, a tokens-over-time chart and the slim "summarize instead" baseline tower.
// The server owns the session; this file only draws it, at 60 fps, easing between server frames.
(() => {
  const $ = (id) => document.getElementById(id)
  const canvas = $('scene'), wrap = canvas.parentElement, ctx = canvas.getContext('2d')
  const MONO = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace"
  const KIND_COLORS = ['#e2e8f0', '#c4b5fd', '#38bdf8', '#2dd4bf', '#8b9bc4', '#fb923c', '#f472b6', '#64748b']
  const KIND_NAMES = ['user', 'assistant', 'Read', 'Grep', 'Bash', 'Edit', 'WebFetch', 'summary']
  const V_NAMES = ['', 'KEEP', 'TRIM', 'DROP'], V_KEYS = ['', 'keep', 'trim', 'drop']
  const V_COLORS = ['', '#4ade80', '#fbbf24', '#fb7185']
  const GREEN = '#4ade80', AMBER = '#fbbf24', ROSE = '#fb7185', INK = '#e9ecf5', DIM = '#8b92aa', FAINT = '#565d75'

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  // The tower's height axis is concave, so a small window still has presence. The budget line stays exact.
  const axis = (u) => Math.pow(clamp(u, 0, 4), 0.6)
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US')
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)))
  const fmtPct = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%')
  const fmtMs = (ms) => (ms == null ? '—' : ms < 10 ? ms.toFixed(1) + ' ms' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s')
  const fmtUsd = (v) => (v <= 0 ? '$0' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2))
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const easeOutBounce = (t) => {
    const n1 = 7.5625, d1 = 2.75
    if (t < 1 / d1) return n1 * t * t
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
    return n1 * (t -= 2.625 / d1) * t + 0.984375
  }

  // ---- state -----------------------------------------------------------------
  let S = null
  let gen = -1
  let lastCompN = null
  let lastBaseN = null
  const jevLane = { order: [], map: new Map(), topY: 0 }
  const baseLane = { order: [], map: new Map(), topY: 0 }
  let scan = null
  let ghost = null
  let particles = [], chips = [], floaters = []
  const odo = { v: 0, tween: null, speed: 0, hot: 0 }
  let budgetDisp = 0
  let hoverId = null, selectedId = null, autoSelect = true, inspected = null
  const mouse = { x: -1, y: -1 }
  let W = 0, H = 0, dpr = 1, L = null
  let lastT = performance.now()
  let sliderHold = 0
  let taskKey = ''
  let histKey = ''

  // ---- server link -------------------------------------------------------------
  async function post(cmd, extra = {}) {
    try {
      const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...extra }) })
      return r.ok ? r.json() : null
    } catch { return null }
  }
  function connect() {
    const es = new EventSource('/events')
    es.addEventListener('state', (ev) => { try { onFrame(JSON.parse(ev.data)) } catch (e) { console.error(e) } })
    es.onerror = () => { es.close(); setTimeout(connect, 1000) }
  }

  function mkBlock(item, now, delay) {
    return { id: item[0], kind: item[1], tokens: item[2], orig: item[3], task: item[4], need: item[5], pinned: item[6], verdict: item[7], label: item[8] ?? '', share: 0, at: 0, w: 0, y: 0, h: 0, state: 'live', pend: null, born: now + delay, flash: null, dieFrom: 1 }
  }

  function syncLane(lane, list, now, verdicts, isBase) {
    const fresh = lane.order.length === 0
    const seen = new Set()
    let prev = null, i = 0
    for (const item of list) {
      const id = item[0]
      seen.add(id)
      let v = lane.map.get(id)
      if (!v) {
        v = mkBlock(item, now, fresh ? Math.min(i * 6, 700) : 0)
        if (isBase) { v.share = item[3]; v.orig = item[2]; v.task = -2; v.need = 0; v.pinned = 0; v.verdict = 0; v.label = '' }
        lane.map.set(id, v)
        const idx = prev ? lane.order.indexOf(prev) + 1 : 0
        lane.order.splice(idx, 0, v)
      } else if (isBase) { v.tokens = item[2]; v.share = item[3] }
      else {
        v.pinned = item[6]; v.task = item[4]; v.need = item[5]
        const vd = verdicts?.[id]
        if (vd) v.pend = { code: vd[0], probs: [vd[1], vd[2], vd[3]], demoted: vd[4], tokens: item[2] }
        else if (v.pend) v.pend.tokens = item[2]
        else { v.tokens = item[2]; v.verdict = item[7] }
      }
      prev = v; i++
    }
    for (const v of lane.order) {
      if (seen.has(v.id) || v.state !== 'live') continue
      const vd = verdicts?.[v.id]
      if (vd) { v.state = 'pending'; v.pend = { code: vd[0], probs: [vd[1], vd[2], vd[3]], demoted: vd[4], tokens: 0 } }
      else if (!v.pend) { v.state = 'dying'; v.dieFrom = Math.max(1, v.at); if (isBase) dust(v) }
    }
  }

  function onFrame(s) {
    const now = performance.now()
    const first = S === null
    if (s.gen !== gen) {
      gen = s.gen
      for (const lane of [jevLane, baseLane]) { lane.order = []; lane.map.clear() }
      scan = null; ghost = null; chips = []; particles = []; floaters = []
      lastCompN = s.last?.n ?? 0; lastBaseN = s.baseline.compactions
      odo.tween = null; odo.v = first ? 0 : odo.v
      if (autoSelect) { selectedId = null; inspected = null }
    }
    const newComp = s.last && s.last.n !== lastCompN && s.last.verdicts && !document.hidden
    if (newComp) finishScan(now)
    S = s
    if (!budgetDisp) budgetDisp = s.cfg.budget
    syncLane(jevLane, s.blocks, now, newComp ? s.last.verdicts : null, false)
    syncLane(baseLane, s.baseline.blocks, now, null, true)
    if (newComp) {
      lastCompN = s.last.n
      scan = { t0: now, dur: clamp(900 + s.last.questions * 3, 1000, 1700), n: s.last.n }
      ghost = { y: jevLane.topY, t0: now, text: `BEFORE ${fmtInt(s.last.before)}` }
      if (L) floaters.push({ x: L.towerX + L.towerW / 2, y: Math.max(L.top + 60, jevLane.topY + 40), text: `−${fmtPct(s.last.reduction)} · ${fmtInt(s.last.questions)} questions · ${fmtMs(s.last.ms)}`, color: GREEN, t0: now + scan.dur * 0.75, big: true })
      odo.tween = { from: odo.v, to: s.tokens, t0: now + 120, dur: scan.dur + 350 }
      if (autoSelect) setTimeout(pickAuto, scan.dur + 200)
      else if (selectedId != null) setTimeout(fetchInspect, scan.dur + 200)
    } else if (s.last && s.last.n !== lastCompN) lastCompN = s.last.n
    else if (odo.tween) odo.tween.to = s.tokens
    if (s.baseline.compactions !== lastBaseN) {
      if (lastBaseN != null && s.baseline.compactions > lastBaseN && L && !document.hidden) {
        const lost = s.baseline.lastRecall == null ? null : 1 - s.baseline.lastRecall
        floaters.push({ x: L.baseX + L.baseW / 2, y: L.bBottom - 40, text: lost == null ? 'folded' : `lost ${Math.round(lost * 100)}% of needles`, color: ROSE, t0: now })
      }
      lastBaseN = s.baseline.compactions
    }
    renderDom(s)
    if (autoSelect && selectedId == null) pickAuto()
  }

  // ---- DOM: stats, console, inspector, history ------------------------------------
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t }
  function renderDom(s) {
    setText($('title'), s.title)
    setText($('subtitle'), `synthetic agent session · made-up repo "${s.repo}"`)
    document.title = s.title
    const last = s.last, t = s.totals
    setText($('sTokens'), fmtInt(s.tokens))
    setText($('sTokensSub'), `${Math.round((s.tokens / s.cfg.budget) * 100)}% full · ${s.blocks.length} blocks`)
    setText($('sBudget'), fmtInt(s.cfg.budget))
    setText($('sBudgetSub'), `target ${Math.round(s.cfg.target * 100)}% · trim ${fmtInt(s.cfg.trimTo)}`)
    setText($('sReduction'), last ? '−' + fmtPct(last.reduction) : '—')
    setText($('sReductionSub'), last ? `${fmtInt(last.before)} → ${fmtInt(last.after)}` : 'waiting for the first one')
    const rec = $('sRecall')
    setText(rec, last ? fmtPct(last.recall) : '—')
    rec.className = !last || last.recall == null ? '' : last.recall >= s.cfg.recallTarget ? 'ok' : last.recall >= s.cfg.recallTarget - 0.1 ? 'warn' : 'bad'
    setText($('sRecallSub'), t.avgRecall == null ? `goal ${fmtPct(s.cfg.recallTarget, 0)}` : `avg ${fmtPct(t.avgRecall)} · goal ${fmtPct(s.cfg.recallTarget, 0)}`)
    setText($('sTime'), last ? fmtMs(last.ms) : '—')
    setText($('sTimeSub'), s.client === 'typesafe' ? 'live Jev · wall clock' : 'offline mock')
    setText($('sPerCall'), last ? String(last.perCall) : '—')
    setText($('sPerCallSub'), last ? `${fmtInt(last.questions)} in ${last.calls} call${last.calls === 1 ? '' : 's'}` : 'up to 100')
    setText($('sJudged'), fmtInt(t.questions))
    setText($('sJudgedSub'), `in ${fmtInt(t.calls)} call${t.calls === 1 ? '' : 's'} · ${fmtInt(t.compactions)} run${t.compactions === 1 ? '' : 's'}`)
    setText($('sCost'), fmtUsd(t.costUsd))
    setText($('sCostSub'), s.client === 'typesafe' ? '$0.042 per M tokens' : 'at live Jev prices')

    const err = $('cfgError'), msg = s.cfgError ? (s.cfgError.startsWith('session.json') ? s.cfgError : `session.json: ${s.cfgError}`) + ' · the last good session keeps running' : s.error ? `Jev: ${s.error}` : ''
    err.classList.toggle('hidden', !msg); setText(err, msg)

    const pause = $('pause'); setText(pause, s.running ? 'Pause' : 'Resume'); pause.classList.toggle('on', !s.running)

    const key = JSON.stringify(s.tasks.map((x) => x.id))
    const box = $('tasks')
    if (key !== taskKey) {
      taskKey = key
      box.textContent = ''
      for (const task of s.tasks) {
        const b = document.createElement('button')
        b.textContent = task.id; b.title = task.title; b.dataset.task = task.id
        b.addEventListener('click', () => post('setTask', { task: task.id }))
        box.appendChild(b)
      }
    }
    for (const b of box.children) b.classList.toggle('on', b.dataset.task === s.currentTask)
    setText($('taskTitle'), s.tasks.find((x) => x.id === s.currentTask)?.title ?? '')

    if (performance.now() > sliderHold) {
      $('budget').value = String(Math.round((1000 * Math.log(s.cfg.budget / 20000)) / Math.log(100)))
      $('distraction').value = String(s.cfg.distraction)
    }
    setText($('budgetOut'), fmtInt(s.cfg.budget))
    setText($('distractionOut'), s.cfg.distraction.toFixed(2))
    $('overridePill').classList.toggle('hidden', !(s.overrides.budget || s.overrides.distraction || s.overrides.task))

    const hk = `${s.gen}:${s.history.length}:${s.history.at(-1)?.n ?? 0}`
    if (hk !== histKey) {
      histKey = hk
      const ul = $('history'); ul.textContent = ''
      if (!s.history.length) { const li = document.createElement('div'); li.className = 'hist-empty'; li.textContent = 'None yet. The first one fires when the tower passes the budget line.'; ul.appendChild(li) }
      for (const h of [...s.history].reverse()) {
        const li = document.createElement('li')
        if (h.trigger === 'manual') li.className = 'manual'
        const cells = [[`${h.n}`, ''], [fmtInt(h.before), ''], [fmtInt(h.after), 'after'], [h.recall == null ? '—' : fmtPct(h.recall, 0), h.recall == null ? '' : h.recall < s.cfg.recallTarget - 0.1 ? 'vlo' : h.recall < s.cfg.recallTarget ? 'lo' : ''], [h.ms < 10 ? h.ms.toFixed(1) : String(Math.round(h.ms)), '']]
        for (const [text, cls] of cells) { const sp = document.createElement('span'); sp.textContent = text; if (cls) sp.className = cls; li.appendChild(sp) }
        li.title = `#${h.n} · task ${h.task} · ${h.trigger === 'manual' ? 'pressed by hand' : 'budget hit'} · ${h.questions} questions in ${h.calls} call(s)${h.demoted ? ` · ${h.demoted} squeezed` : ''}`
        ul.appendChild(li)
      }
    }
    setText($('histAvg'), t.compactions ? `avg cut ${fmtPct(t.avgReduction, 0)} · recall ${fmtPct(t.avgRecall, 0)}` : '')
  }

  function pickAuto() {
    if (!S || !autoSelect) return
    const curIdx = S.tasks.findIndex((x) => x.id === S.currentTask)
    let best = null, bestScore = -1
    for (const b of S.blocks) {
      if (b[5] === 3) continue
      const wrong = b[7] === 1 && b[4] !== curIdx
      const score = (wrong ? 1e7 : b[7] === 1 ? 1e6 : 0) + b[2]
      if (score > bestScore) { bestScore = score; best = b }
    }
    if (best && best[0] !== selectedId) { selectedId = best[0]; fetchInspect() }
    else if (best) fetchInspect()
  }

  async function fetchInspect() {
    if (selectedId == null) { inspected = null; renderInspector(); return }
    const id = selectedId
    const r = await post('inspect', { id })
    if (id !== selectedId) return
    inspected = r?.block ?? null
    renderInspector()
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function renderInspector() {
    const body = $('insBody'), b = inspected
    body.textContent = ''
    if (!b) { body.className = 'ins-empty'; body.textContent = 'Click any block in the tower.'; setText($('insId'), ''); return }
    body.className = ''
    setText($('insId'), `block #${b.id}${autoSelect ? ' · auto-picked' : ''}`)
    const top = el('div', 'ins-top')
    const kind = el('span', 'ins-kind', b.kind); kind.style.background = KIND_COLORS[KIND_NAMES.indexOf(b.kind)] ?? '#888'
    const label = el('span', 'ins-label', b.label); label.title = b.label
    top.append(kind, label)
    const meta = el('div', 'ins-meta')
    const tok = el('span'); tok.innerHTML = `<b>${fmtInt(b.tokens)}</b> tokens${b.orig !== b.tokens ? ` (was ${fmtInt(b.orig)})` : ''}`
    meta.append(tok)
    if (b.gone) meta.append(el('span', 'pill bad', 'GONE'))
    if (b.need !== 'message' && b.inWindow) {
      const pin = el('button', b.pinned ? 'on' : '', b.pinned ? 'Pinned' : 'Pin')
      pin.title = 'A pinned block is never dropped or trimmed'
      pin.addEventListener('click', async () => { await post('pin', { id: b.id, pinned: !b.pinned }); fetchInspect() })
      meta.append(pin)
    }
    const prev = el('div', 'ins-prev'); prev.append(el('div', 'ins-prev-text', b.preview)); prev.title = b.preview
    body.append(top, meta, prev)
    if (b.need === 'message') { body.append(el('div', 'ins-truth', b.truth)); return }
    const vh = el('div', 'ins-h')
    vh.append(el('span', '', "Jev's verdict"))
    if (b.probs) {
      vh.append(el('b', 'v-' + b.jev, String(b.jev).toUpperCase()))
      body.append(vh)
      for (const k of ['keep', 'trim', 'drop']) {
        const row = el('div', `pbar ${k}${k === b.jev ? ' top' : ''}`)
        const t = el('div', 't'), f = el('div', 'f'); f.style.width = Math.max(1.5, b.probs[k] * 100) + '%'; t.append(f)
        row.append(el('span', '', k), t, el('span', '', b.probs[k].toFixed(2).replace(/^0/, '')))
        body.append(row)
      }
    } else { vh.append(el('b', '', 'not judged yet')); body.append(vh); body.append(el('div', 'ins-truth', 'New since the last compaction. Jev judges it at the next one.')) }
    const note = b.pinned && b.jev && b.jev !== 'keep' ? `Pinned by you, so it stayed (Jev said ${b.jev}).`
      : b.demoted ? `Squeezed by the pressure pass: Jev said ${b.jev}, but the window had to reach the target, so it became ${b.verdict}.`
      : b.gone ? b.gone : ''
    body.append(el('div', 'ins-note', note))
    const truth = el('div', 'ins-truth')
    truth.append(el('b', '', 'Ground truth: '), document.createTextNode(b.truth + ' '))
    if (b.ideal) {
      truth.append(document.createTextNode('Ideal: '), el('b', 'v-' + b.ideal, b.ideal.toUpperCase()), document.createTextNode(' '))
      if (b.verdict) truth.append(el('span', 'ins-match ' + (b.verdict === b.ideal ? 'ok' : 'bad'), b.verdict === b.ideal ? '✓ match' : '✗ differs'))
    }
    body.append(truth)
  }

  // ---- controls --------------------------------------------------------------------
  $('pause').addEventListener('click', () => post(S?.running ? 'pause' : 'start'))
  $('step').addEventListener('click', () => post('tick'))
  $('flood').addEventListener('click', () => post('flood', { n: 40 }))
  $('reset').addEventListener('click', () => post('reset'))
  $('compact').addEventListener('click', () => post('compact'))
  let budgetTimer = null, distTimer = null
  $('budget').addEventListener('input', (e) => {
    sliderHold = performance.now() + 700
    const raw = 20000 * Math.pow(100, Number(e.target.value) / 1000)
    const value = clamp(Math.round(raw / 1000) * 1000, 20000, 2000000)
    setText($('budgetOut'), fmtInt(value))
    clearTimeout(budgetTimer); budgetTimer = setTimeout(() => post('setBudget', { value }), 40)
  })
  $('distraction').addEventListener('input', (e) => {
    sliderHold = performance.now() + 700
    const value = Number(e.target.value)
    setText($('distractionOut'), value.toFixed(2))
    clearTimeout(distTimer); distTimer = setTimeout(() => post('setDistraction', { value }), 40)
  })
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return
    if (e.key === ' ') { e.preventDefault(); post(S?.running ? 'pause' : 'start') }
    else if (e.key === 'c') post('compact')
  })

  canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top })
  canvas.addEventListener('mouseleave', () => { mouse.x = mouse.y = -1; hoverId = null; wrap.classList.remove('hot') })
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top
    const id = hitTest()
    if (id != null) { selectedId = id; autoSelect = false; fetchInspect() }
    else { autoSelect = true; selectedId = null; pickAuto() }
  })

  function hitTest() {
    if (!L || mouse.x < L.towerX - 4 || mouse.x > L.towerX + L.towerW + 12) return null
    let best = null, bestD = 4
    for (const v of jevLane.order) {
      if (v.state === 'dying' || v.h <= 0) continue
      if (mouse.y >= v.y && mouse.y < v.y + v.h) return v.id
      const d = Math.abs(mouse.y - (v.y + v.h / 2))
      if (d < bestD) { bestD = d; best = v.id }
    }
    return best
  }

  // ---- canvas plumbing --------------------------------------------------------------
  function resize() {
    const r = wrap.getBoundingClientRect()
    dpr = window.devicePixelRatio || 1
    W = Math.max(200, r.width); H = Math.max(160, r.height)
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    L = layout()
  }
  new ResizeObserver(resize).observe(wrap)

  function layout() {
    const pad = 16
    const towerW = clamp(W * 0.3, 180, 360)
    const gaugeX = pad, gaugeW = 8
    const towerX = gaugeX + gaugeW + 10
    const stripX = towerX + towerW + 5, stripW = 5
    const chipX = stripX + stripW + 9, chipW = 84
    const top = pad + 24, bottom = H - pad - 20
    const Hb = (bottom - top) * 0.84
    const baseW = clamp(W * 0.11, 92, 132)
    const baseX = W - pad - baseW
    const midX = chipX + chipW + 10
    const midW = Math.max(120, baseX - 26 - midX)
    const odoW = W - pad - midX
    return { pad, towerW, gaugeX, gaugeW, towerX, stripX, stripW, chipX, chipW, top, bottom, Hb, baseW, baseX, midX, midW, odoW, bTop: top, bBottom: bottom, bHb: Hb }
  }

  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2)
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
  }
  const font = (px, weight = 600) => { ctx.font = `${weight} ${px}px ${MONO}` }
  function fit(text, maxW, px, weight = 700, min = 8) {
    let size = px
    font(size, weight)
    while (size > min && ctx.measureText(text).width > maxW) { size -= 1; font(size, weight) }
    return size
  }
  function caps(text, x, y, color = DIM, px = 9, align = 'left', maxW = 0) {
    font(px, 600); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'
    try { ctx.letterSpacing = '1.2px' } catch { /* older engines */ }
    while (maxW && px > 6.5 && ctx.measureText(text).width > maxW) { px -= 0.5; font(px, 600) }
    ctx.fillText(text, x, y)
    try { ctx.letterSpacing = '0px' } catch { /* older engines */ }
  }

  // ---- animation step ------------------------------------------------------------------
  function stepLane(lane, dt, now, budget, top, bottom, Hb) {
    let sumAt = 0, sumW = 0
    for (const v of lane.order) {
      const target = now < v.born || v.state === 'dying' ? 0 : v.tokens
      const k = target > v.at ? 18 : 7.5
      v.at += (target - v.at) * (1 - Math.exp(-dt * k))
      if (Math.abs(target - v.at) < 0.6) v.at = target
      v.w = Math.pow(Math.max(v.at, 0), 0.75)
      sumAt += v.at; sumW += v.w
    }
    if (lane.order.some((v) => v.state === 'dying' && v.at < 1)) {
      lane.order = lane.order.filter((v) => { const dead = v.state === 'dying' && v.at < 1; if (dead) lane.map.delete(v.id); return !dead })
    }
    const Ht = Math.min(axis(sumAt / budget) * Hb, bottom - top)
    let y = bottom
    for (const v of lane.order) { v.h = sumW > 0 ? (Ht * v.w) / sumW : 0; y -= v.h; v.y = y }
    lane.topY = y
    lane.sumAt = sumAt
  }

  function finishScan(now) {
    if (!scan) return
    for (const v of jevLane.order) if (v.pend) trigger(v, now, true)
    scan = null
  }

  function trigger(v, now, quiet) {
    const p = v.pend
    v.pend = null
    v.verdict = p.code
    v.flash = { t: now, code: p.code }
    if (p.code === 3 || v.state === 'pending') { v.state = 'dying'; v.dieFrom = Math.max(1, v.at); if (!quiet) burst(v) }
    else v.tokens = p.tokens
    if (!quiet) addChip(v, p, now)
  }

  function addChip(v, p, now) {
    const y = clamp(v.y + v.h / 2, L.top + 8, L.bottom - 8)
    for (const c of chips) if (Math.abs(c.y - y) < 15 && now - c.t0 < 620) return
    const top = Math.max(...p.probs)
    chips.push({ y, t0: now, color: V_COLORS[p.code], text: `${V_NAMES[p.code]} ${top.toFixed(2).replace(/^0/, '')}`, squeezed: !!p.demoted })
  }

  function burst(v) {
    const n = clamp(Math.round((v.h * L.towerW) / 70), 8, 80)
    const color = KIND_COLORS[v.kind]
    for (let i = 0; i < n; i++) {
      if (particles.length > 2400) break
      particles.push({ x: L.towerX + Math.random() * L.towerW, y: v.y + Math.random() * Math.max(1, v.h), vx: 20 + Math.random() * 230, vy: -120 + Math.random() * 150, life: 0, max: 0.6 + Math.random() * 0.9, color: Math.random() < 0.25 ? '#fecdd3' : color, size: 1.4 + Math.random() * 2.6 })
    }
  }
  function dust(v) {
    if (!L || v.h < 0.5) return
    const n = clamp(Math.round(v.h / 2), 1, 8)
    for (let i = 0; i < n; i++) {
      if (particles.length > 1400) break
      particles.push({ x: L.baseX + Math.random() * L.baseW, y: v.y + Math.random() * Math.max(1, v.h), vx: -20 - Math.random() * 60, vy: -30 + Math.random() * 60, life: 0, max: 0.5 + Math.random() * 0.5, color: '#94a3b8', size: 1 + Math.random() * 1.6 })
    }
  }

  // ---- drawing ---------------------------------------------------------------------------
  function drawTower(lane, x, w, now, top, isBase) {
    const curIdx = S.tasks.findIndex((t) => t.id === S.currentTask)
    let fallingNow = 0
    for (const v of lane.order) if (now >= v.born && now - v.born < 500) fallingNow++
    font(10, 600)
    for (const v of lane.order) {
      if (now < v.born || v.h < 0.12) continue
      const age = (now - v.born) / 1000
      let yOff = 0, alpha = 1
      if (age < 0.62) { const dropH = Math.min(130, Math.max(24, v.y - top + 30)); yOff = -(1 - easeOutBounce(age / 0.62)) * dropH; alpha = Math.min(1, age / 0.09) }
      if (v.state === 'dying') alpha *= clamp(v.at / v.dieFrom, 0, 1)
      const gap = v.h > 3.4 ? 1 : 0
      const falling = age < 0.5 && yOff < -2
      const hh = Math.max(v.h - gap, falling ? 4 : 0.7)
      const y = Math.max(top - 2, v.y + yOff)
      if (falling && v.h >= 5 && fallingNow <= 3 && y - 34 > top) {
        const st = ctx.createLinearGradient(0, y - 34, 0, y)
        st.addColorStop(0, 'rgba(255,255,255,0)'); st.addColorStop(1, 'rgba(255,255,255,.12)')
        ctx.globalAlpha = alpha; ctx.fillStyle = st; ctx.fillRect(x, y - 34, w, 34)
      }
      ctx.globalAlpha = alpha * (v.h < 1 ? clamp(v.h + 0.25, 0.4, 1) : 1)
      ctx.fillStyle = KIND_COLORS[v.kind]
      if (hh > 5) { rr(x, y, w, hh, 2.5); ctx.fill() } else ctx.fillRect(x, y, w, hh)
      if (v.kind === 7 && hh > 3) { // a summary slab: hatch it
        ctx.save(); rr(x, y, w, hh, 2.5); ctx.clip(); ctx.strokeStyle = 'rgba(8,10,16,.55)'; ctx.lineWidth = 2
        for (let sx = x - hh; sx < x + w; sx += 7) { ctx.beginPath(); ctx.moveTo(sx, y + hh); ctx.lineTo(sx + hh, y); ctx.stroke() }
        ctx.restore()
      }
      if (!isBase) {
        if (v.verdict === 1 || v.verdict === 2) { ctx.fillStyle = V_COLORS[v.verdict]; ctx.fillRect(x, y, 3, hh) }
        if (hh >= 12 && v.state === 'live') {
          ctx.fillStyle = 'rgba(5,8,12,.82)'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right'
          const tok = fmtInt(v.tokens)
          ctx.fillText(tok, x + w - (v.pinned ? 18 : 7), y + hh / 2 + 0.5)
          ctx.textAlign = 'left'
          const room = w - 24 - tok.length * 6.2 - (v.pinned ? 12 : 0)
          const text = `${KIND_NAMES[v.kind]}  ${v.label}`
          const max = Math.max(0, Math.floor(room / 6.1))
          if (max > 3) ctx.fillText(text.length > max ? text.slice(0, max - 1) + '…' : text, x + 8, y + hh / 2 + 0.5)
        }
        if (v.pinned) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
          if (hh > 3) { rr(x + 0.75, y + 0.75, w - 1.5, Math.max(1, hh - 1.5), 2.5); ctx.stroke() }
          const cy = y + hh / 2, cx = x + w - 9, d = clamp(hh / 2 - 1, 2, 4.5)
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy); ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d, cy); ctx.closePath(); ctx.fill()
        }
        if (v.flash) {
          const ft = (now - v.flash.t) / 520
          if (ft >= 1) v.flash = null
          else { ctx.globalAlpha = alpha * (1 - ft) * 0.85; ctx.fillStyle = v.flash.code === 1 ? '#bbf7d0' : v.flash.code === 2 ? '#fde68a' : '#fecdd3'; ctx.fillRect(x, y, w, Math.max(hh, 1.5)) }
        }
      }
      // truth strip
      ctx.globalAlpha = alpha
      const sx = isBase ? x - 9 : x + w + 5
      if (isBase) { if (v.share > 0.004) { ctx.fillStyle = GREEN; ctx.globalAlpha = alpha * clamp(0.25 + v.share, 0, 1); ctx.fillRect(sx, y, 5, Math.max(hh, 0.7)) } }
      else if (v.need !== 3) {
        const rel = v.task === curIdx && v.need > 0
        ctx.fillStyle = rel ? (v.need === 2 ? GREEN : '#86efac') : '#3a2430'
        ctx.globalAlpha = alpha * (rel ? (v.need === 2 ? 1 : 0.6) : 0.9)
        ctx.fillRect(sx, y, 5, Math.max(hh, 0.7))
      }
    }
    ctx.globalAlpha = 1
    // sheen
    const g = ctx.createLinearGradient(x, 0, x + w, 0)
    g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(0.25, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.30)')
    ctx.fillStyle = g; ctx.fillRect(x, lane.topY - 2, w, Math.max(0, (isBase ? L.bBottom : L.bottom) - lane.topY + 2))
  }

  function drawLine(x1, x2, y, color, label, dashed, labelAlign = 'left') {
    ctx.save()
    ctx.strokeStyle = color; ctx.lineWidth = dashed ? 1 : 1.5
    if (dashed) ctx.setLineDash([4, 5]); else { ctx.shadowColor = color; ctx.shadowBlur = 12 }
    ctx.beginPath(); ctx.moveTo(x1, y + 0.5); ctx.lineTo(x2, y + 0.5); ctx.stroke()
    ctx.restore()
    if (label) {
      font(9, 700)
      const tw = ctx.measureText(label).width + 10
      const lx = labelAlign === 'left' ? x1 + 4 : labelAlign === 'after' ? x2 + 3 : x2 - tw - 4
      const ly = labelAlign === 'after' ? y - 6.5 : y - 15
      ctx.fillStyle = 'rgba(5,6,10,.82)'; rr(lx, ly, tw, 13, 3); ctx.fill()
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + 5, ly + 7)
    }
  }

  function drawOdometer(x, yTop, px, value, speed, digits, now, hot) {
    const cellW = px * 0.66, commaW = px * 0.3, cellH = px * 1.14
    let cx = x
    for (let p = digits - 1; p >= 0; p--) {
      const unit = 10 ** p
      const lead = value < unit && p > 0
      rr(cx + 1.5, yTop, cellW - 3, cellH, px * 0.1)
      const bg = ctx.createLinearGradient(0, yTop, 0, yTop + cellH)
      bg.addColorStop(0, '#05070b'); bg.addColorStop(0.5, '#10141d'); bg.addColorStop(1, '#05070b')
      ctx.fillStyle = bg; ctx.fill()
      ctx.strokeStyle = hot > 0.02 ? `rgba(74,222,128,${0.18 + hot * 0.4})` : '#1a2030'; ctx.lineWidth = 1; ctx.stroke()
      ctx.save(); rr(cx + 1.5, yTop, cellW - 3, cellH, px * 0.1); ctx.clip()
      font(px, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const mx = cx + cellW / 2, my = yTop + cellH / 2 + px * 0.04
      const color = hot > 0.02 ? `rgb(${Math.round(233 - hot * 99)},${Math.round(236 + hot * 3)},${Math.round(245 - hot * 73)})` : INK
      ctx.fillStyle = color
      if (hot > 0.02) { ctx.shadowColor = GREEN; ctx.shadowBlur = 16 * hot }
      const dps = Math.abs(speed) / unit
      if (dps > 26) {
        const off = ((now / 1000) * 13 + p * 0.37) % 1
        const d0 = Math.floor(value / unit) % 10
        ctx.globalAlpha = 0.34
        for (let k = -1; k <= 2; k++) ctx.fillText(String((((d0 + k) % 10) + 10) % 10), mx, my + (k - off) * cellH * 0.86)
        ctx.globalAlpha = 1
      } else {
        const pos = value / unit
        const d = Math.floor(pos) % 10
        let f
        if (p === 0) f = pos - Math.floor(pos)
        else { const lower = value % unit, start = unit - Math.max(1, unit * 0.08); f = lower > start ? (lower - start) / (unit - start) : 0 }
        ctx.globalAlpha = lead ? 0.13 : 1
        ctx.fillText(String(d), mx, my - f * cellH)
        if (f > 0.001) ctx.fillText(String((d + 1) % 10), mx, my + (1 - f) * cellH)
        ctx.globalAlpha = 1
      }
      ctx.restore()
      const sh = ctx.createLinearGradient(0, yTop, 0, yTop + cellH)
      sh.addColorStop(0, 'rgba(0,0,0,.6)'); sh.addColorStop(0.28, 'rgba(0,0,0,0)'); sh.addColorStop(0.72, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.6)')
      rr(cx + 1.5, yTop, cellW - 3, cellH, px * 0.1); ctx.fillStyle = sh; ctx.fill()
      cx += cellW
      if (p % 3 === 0 && p > 0) {
        font(px * 0.8, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = value < unit ? 'rgba(233,236,245,.13)' : DIM
        ctx.fillText(',', cx + commaW / 2, yTop + cellH - px * 0.12)
        cx += commaW
      }
    }
    return cx - x
  }
  const odoWidth = (px, digits) => digits * px * 0.66 + Math.floor((digits - 1) / 3) * px * 0.3

  function meter(x, y, w, label, value, color) {
    font(10, 600); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = DIM
    ctx.fillText(label, x, y)
    const lw = 92, vw = 50
    const bx = x + lw, bw = Math.max(20, w - lw - vw)
    ctx.fillStyle = 'rgba(255,255,255,.06)'; rr(bx, y - 3.5, bw, 7, 3.5); ctx.fill()
    if (value != null) { ctx.fillStyle = color; rr(bx, y - 3.5, Math.max(3, bw * clamp(value, 0, 1)), 7, 3.5); ctx.fill() }
    font(11, 700); ctx.textAlign = 'right'; ctx.fillStyle = value == null ? DIM : INK
    ctx.fillText(fmtPct(value), x + w, y)
  }

  function drawCard(x, y, w, now) {
    const last = S.last
    const extra = last && (last.demoted || last.needlesDropped || last.junkKept)
    const h = last ? (extra ? 172 : 154) : 84
    rr(x, y, w, h, 10); ctx.fillStyle = 'rgba(16,18,26,.82)'; ctx.fill(); ctx.strokeStyle = '#232838'; ctx.lineWidth = 1; ctx.stroke()
    const px = x + 12, pw = w - 24
    if (!last) {
      caps('LAST COMPACTION', px, y + 20)
      font(12, 700); ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      ctx.fillText('Waiting for the first one', px, y + 44)
      font(10.5, 500); ctx.fillStyle = DIM
      ctx.fillText('It fires when the tower passes', px, y + 62); ctx.fillText('the budget line, or press Compact now.', px, y + 76)
      return h
    }
    caps(`LAST COMPACTION #${last.n}`, px, y + 20)
    caps(last.trigger === 'manual' ? 'BY HAND' : 'BUDGET HIT', px + pw, y + 20, last.trigger === 'manual' ? '#5eead4' : FAINT, 9, 'right')
    const red = '−' + fmtPct(last.reduction)
    const redPx = fit(red, pw * 0.42, 22, 700, 12)
    ctx.fillStyle = GREEN; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
    ctx.save(); ctx.shadowColor = GREEN; ctx.shadowBlur = 14; ctx.fillText(red, px + pw, y + 47); ctx.restore()
    const redW = ctx.measureText(red).width
    const span = `${fmtInt(last.before)} → ${fmtInt(last.after)}`
    fit(span, pw - redW - 10, 15, 700, 9)
    ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.fillText(span, px, y + 46)
    // verdict bar
    const total = Math.max(1, last.keep + last.trim + last.drop)
    let bx = px
    const by = y + 58
    for (const [n, c] of [[last.keep, GREEN], [last.trim, AMBER], [last.drop, ROSE]]) {
      const bw = (pw * n) / total
      if (bw > 0.5) { ctx.fillStyle = c; ctx.fillRect(bx, by, Math.max(1, bw - 1.5), 9) }
      bx += bw
    }
    font(10, 700); ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'; ctx.fillStyle = GREEN; ctx.fillText(`KEEP ${last.keep}`, px, y + 82)
    ctx.textAlign = 'center'; ctx.fillStyle = AMBER; ctx.fillText(`TRIM ${last.trim}`, px + pw / 2, y + 82)
    ctx.textAlign = 'right'; ctx.fillStyle = ROSE; ctx.fillText(`DROP ${last.drop}`, px + pw, y + 82)
    const okRecall = last.recall == null || last.recall >= S.cfg.recallTarget
    meter(px, y + 101, pw, 'needle recall', last.recall, okRecall ? GREEN : last.recall >= S.cfg.recallTarget - 0.1 ? AMBER : ROSE)
    meter(px, y + 119, pw, 'junk removed', last.junkRemoved, '#5eead4')
    const line = `${fmtInt(last.questions)} questions · ${last.calls} call${last.calls === 1 ? '' : 's'} · ${fmtMs(last.ms)} · ${fmtUsd(last.costUsd)}`
    fit(line, pw, 10.5, 600, 8); ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText(line, px, y + 142)
    if (extra) {
      const bits = []
      if (last.demoted) bits.push(`${last.demoted} squeezed to reach target`)
      if (last.needlesDropped) bits.push(`${last.needlesDropped} needle${last.needlesDropped === 1 ? '' : 's'} dropped`)
      if (last.junkKept) bits.push(`${last.junkKept} junk kept`)
      const t = bits.join(' · ')
      fit(t, pw, 10.5, 600, 8); ctx.fillStyle = AMBER; ctx.fillText(t, px, y + 160)
    }
    return h
  }

  function drawChart(x, y, w, h) {
    if (h < 64 || w < 100) return
    rr(x, y, w, h, 10); ctx.fillStyle = 'rgba(12,14,20,.7)'; ctx.fill(); ctx.strokeStyle = '#1d2230'; ctx.lineWidth = 1; ctx.stroke()
    caps(w < 270 ? 'TOKENS' : 'TOKENS OVER TIME', x + 12, y + 18)
    font(9, 600); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#7c8aa8'; ctx.fillText('— summarize', x + w - 12, y + 18)
    const sw = ctx.measureText('— summarize').width
    ctx.fillStyle = GREEN; ctx.fillText('— Jev', x + w - 22 - sw, y + 18)
    const pts = S.series
    if (pts.length < 2) return
    const gx = x + 12, gy = y + 28, gw = w - 24, gh = h - 38
    const budget = S.cfg.budget
    let max = budget * 1.12
    for (const p of pts) max = Math.max(max, p[1], p[2])
    const X = (i) => gx + (i / (pts.length - 1)) * gw
    const Y = (v) => gy + gh - (v / max) * gh
    ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(251,191,36,.55)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(gx, Y(budget)); ctx.lineTo(gx + gw, Y(budget)); ctx.stroke(); ctx.restore()
    ctx.strokeStyle = '#7c8aa8'; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.85; ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[2])) : ctx.moveTo(X(i), Y(p[2])))); ctx.stroke(); ctx.globalAlpha = 1
    const fill = ctx.createLinearGradient(0, gy, 0, gy + gh)
    fill.addColorStop(0, 'rgba(74,222,128,.28)'); fill.addColorStop(1, 'rgba(74,222,128,0)')
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[1])) : ctx.moveTo(X(i), Y(p[1]))))
    ctx.lineTo(gx + gw, gy + gh); ctx.lineTo(gx, gy + gh); ctx.closePath(); ctx.fillStyle = fill; ctx.fill()
    ctx.save(); ctx.shadowColor = GREEN; ctx.shadowBlur = 8; ctx.strokeStyle = GREEN; ctx.lineWidth = 1.6; ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[1])) : ctx.moveTo(X(i), Y(p[1])))); ctx.stroke(); ctx.restore()
    const lp = pts[pts.length - 1]
    ctx.fillStyle = GREEN; ctx.beginPath(); ctx.arc(X(pts.length - 1), Y(lp[1]), 2.6, 0, Math.PI * 2); ctx.fill()
  }

  function draw(dt, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const budgetTarget = S.cfg.budget
    budgetDisp += (budgetTarget - budgetDisp) * (1 - Math.exp(-dt * 9))
    if (Math.abs(budgetTarget - budgetDisp) < 1) budgetDisp = budgetTarget

    // odometer band geometry first: the baseline lane starts under it
    const digits = Math.max(6, String(Math.round(Math.max(S.tokens, budgetTarget * 1.3))).length)
    let odoPx = 92
    while (odoPx > 22 && odoWidth(odoPx, digits) > L.odoW) odoPx -= 1
    const bandTop = L.pad + 18
    const bandBottom = bandTop + odoPx * 1.14 + 24
    L.bTop = bandBottom + 46
    L.bHb = (L.bBottom - L.bTop) * 0.84

    stepLane(jevLane, dt, now, budgetDisp, L.top, L.bottom, L.Hb)
    stepLane(baseLane, dt, now, budgetDisp, L.bTop, L.bBottom, L.bHb)

    // scan line progress + triggers
    let scanY = null
    if (scan) {
      const t = (now - scan.t0) / scan.dur
      if (scan.y0 == null) scan.y0 = jevLane.topY - 8
      scanY = scan.y0 + (L.bottom + 4 - scan.y0) * easeInOut(clamp(t, 0, 1))
      for (const v of jevLane.order) if (v.pend && scanY >= v.y + v.h / 2) trigger(v, now, false)
      if (t >= 1) { finishScan(now); scanY = null }
    } else for (const v of jevLane.order) if (v.pend) trigger(v, now, true)

    // ---- Jev lane ----
    const { towerX, towerW, gaugeX, gaugeW, top, bottom, Hb } = L
    const budgetY = bottom - Hb
    caps(towerW < 270 ? 'JEV LANE' : 'CONTEXT WINDOW · JEV LANE', gaugeX, L.pad + 8)
    if (S.totals.avgRecall != null) caps(`AVG RECALL ${fmtPct(S.totals.avgRecall)}`, towerX + towerW + 10, L.pad + 8, GREEN, 9, 'right')
    // backdrop
    ctx.fillStyle = 'rgba(255,255,255,.018)'; ctx.fillRect(towerX, top, towerW, bottom - top)
    ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1
    font(8.5, 600); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'
    for (const f of [0.1, 0.25, 0.5, 0.75]) {
      const y = Math.round(bottom - Hb * axis(f)) + 0.5
      ctx.beginPath(); ctx.moveTo(towerX, y); ctx.lineTo(towerX + towerW, y); ctx.stroke()
      ctx.fillStyle = 'rgba(139,146,170,.5)'; ctx.fillText(fmtK(budgetDisp * f), towerX + towerW - 4, y - 3)
    }
    // gauge
    const fillFrac = clamp(axis(jevLane.sumAt / budgetDisp), 0, (bottom - top) / Hb)
    rr(gaugeX, top, gaugeW, bottom - top, 4); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill()
    const gg = ctx.createLinearGradient(0, bottom, 0, budgetY)
    gg.addColorStop(0, '#15803d'); gg.addColorStop(0.7, GREEN); gg.addColorStop(0.92, AMBER); gg.addColorStop(1, ROSE)
    ctx.save(); rr(gaugeX, top, gaugeW, bottom - top, 4); ctx.clip(); ctx.fillStyle = gg; ctx.fillRect(gaugeX, bottom - Hb * fillFrac, gaugeW, Hb * fillFrac); ctx.restore()

    drawTower(jevLane, towerX, towerW, now, top, false)

    // floor
    const fl = ctx.createLinearGradient(towerX - 14, 0, towerX + towerW + 20, 0)
    fl.addColorStop(0, 'rgba(74,222,128,0)'); fl.addColorStop(0.5, 'rgba(74,222,128,.7)'); fl.addColorStop(1, 'rgba(74,222,128,0)')
    ctx.fillStyle = fl; ctx.fillRect(gaugeX - 4, bottom + 1, towerW + 44, 1.5)

    drawLine(gaugeX - 2, towerX + towerW + 12, bottom - Hb * axis(S.cfg.target), 'rgba(74,222,128,.7)', `TARGET ${Math.round(S.cfg.target * 100)}%`, true, 'after')
    const over = jevLane.sumAt > budgetDisp
    drawLine(gaugeX - 2, towerX + towerW + 12, budgetY, over ? ROSE : AMBER, `BUDGET ${fmtK(budgetDisp)}`, false, 'after')

    if (ghost) {
      const t = (now - ghost.t0) / 4200
      if (t >= 1) ghost = null
      else { ctx.globalAlpha = t < 0.06 ? t / 0.06 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1; drawLine(towerX, towerX + towerW, ghost.y, 'rgba(233,236,245,.55)', ghost.text, true, 'left'); ctx.globalAlpha = 1 }
    }

    // selection + hover
    hoverId = mouse.x >= 0 ? hitTest() : null
    wrap.classList.toggle('hot', hoverId != null)
    for (const v of jevLane.order) {
      if (v.id !== selectedId && v.id !== hoverId) continue
      if (v.h <= 0 || now < v.born) continue
      const sel = v.id === selectedId
      ctx.save(); ctx.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,.7)'; ctx.lineWidth = sel ? 2 : 1
      if (sel) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 12 }
      const hh = Math.max(v.h, 3)
      rr(towerX - 2, v.y + v.h / 2 - hh / 2 - 1, towerW + 4, hh + 2, 3); ctx.stroke(); ctx.restore()
      if (sel) { ctx.fillStyle = '#fff'; ctx.beginPath(); const cy = v.y + v.h / 2; ctx.moveTo(towerX - 5, cy); ctx.lineTo(towerX - 11, cy - 4); ctx.lineTo(towerX - 11, cy + 4); ctx.closePath(); ctx.fill() }
    }

    // scan line
    if (scan && now - scan.t0 < 260) {
      ctx.fillStyle = `rgba(187,247,208,${0.22 * (1 - (now - scan.t0) / 260)})`
      ctx.fillRect(towerX, jevLane.topY, towerW, bottom - jevLane.topY)
    }
    if (scanY != null) {
      const x1 = gaugeX - 4, x2 = towerX + towerW + 14
      const trail = ctx.createLinearGradient(0, scanY - 70, 0, scanY)
      trail.addColorStop(0, 'rgba(74,222,128,0)'); trail.addColorStop(1, 'rgba(74,222,128,.22)')
      ctx.fillStyle = trail; ctx.fillRect(x1, Math.max(top - 10, scanY - 70), x2 - x1, Math.min(70, scanY - top + 10))
      ctx.save(); ctx.shadowColor = '#bbf7d0'; ctx.shadowBlur = 22; ctx.strokeStyle = '#ecfdf5'; ctx.lineWidth = 2.2
      ctx.beginPath(); ctx.moveTo(x1, scanY); ctx.lineTo(x2, scanY); ctx.stroke(); ctx.restore()
    }

    // chips
    chips = chips.filter((c) => now - c.t0 < 1150)
    for (const c of chips) {
      const t = (now - c.t0) / 1150
      const a = t < 0.08 ? t / 0.08 : t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1
      const x = L.chipX + t * 10
      ctx.globalAlpha = a
      ctx.strokeStyle = c.color; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(L.stripX + L.stripW + 1, c.y); ctx.lineTo(x, c.y); ctx.stroke()
      font(9.5, 700)
      const tw = ctx.measureText(c.text).width + 12
      rr(x, c.y - 7.5, tw, 15, 7.5); ctx.fillStyle = 'rgba(6,8,12,.9)'; ctx.fill(); ctx.stroke()
      ctx.fillStyle = c.color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(c.text, x + 6, c.y + 0.5)
      if (c.squeezed) { ctx.fillStyle = AMBER; ctx.beginPath(); ctx.arc(x + tw + 5, c.y, 2.2, 0, Math.PI * 2); ctx.fill() }
    }
    ctx.globalAlpha = 1

    // ---- odometer band ----
    const mx = L.midX
    caps('TOKENS IN CONTEXT', mx, L.pad + 8)
    const phase = scan ? 'JEV IS JUDGING EVERY TOOL RESULT' : !S.running ? 'PAUSED' : S.phase === 'hold' ? 'COMPACTED' : 'FILLING'
    caps(phase, W - L.pad, L.pad + 8, scan ? GREEN : !S.running ? AMBER : S.phase === 'hold' ? GREEN : FAINT, 9, 'right')
    // odometer value
    const prev = odo.v
    if (odo.tween) {
      const t = clamp((now - odo.tween.t0) / odo.tween.dur, 0, 1)
      odo.v = odo.tween.from + (odo.tween.to - odo.tween.from) * easeInOut(t)
      odo.hot += (1 - odo.hot) * (1 - Math.exp(-dt * 10))
      if (t >= 1) { odo.v = odo.tween.to; odo.tween = null }
    } else {
      odo.v += (S.tokens - odo.v) * (1 - Math.exp(-dt * 9))
      if (Math.abs(S.tokens - odo.v) < 0.6) odo.v = S.tokens
      odo.hot += (0 - odo.hot) * (1 - Math.exp(-dt * 2.2))
    }
    const inst = dt > 0 ? (odo.v - prev) / dt : 0
    odo.speed += (inst - odo.speed) * 0.5
    drawOdometer(mx, bandTop, odoPx, Math.max(0, odo.v), odo.speed, digits, now, odo.hot)
    font(11, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = DIM
    const curTask = S.tasks.find((t) => t.id === S.currentTask)
    const sub = `of ${fmtInt(budgetTarget)} budget · task: ${curTask?.id ?? ''}`
    fit(sub, L.odoW, 11, 600, 8); ctx.fillStyle = DIM
    ctx.fillText(sub, mx, bandBottom - 4)

    // ---- card + chart ----
    const cardY = bandBottom + 10
    const cardH = drawCard(mx, cardY, L.midW, now)
    const chartY = cardY + cardH + 10
    drawChart(mx, chartY, L.midW, bottom - chartY)

    // ---- baseline lane ----
    const bx = L.baseX, bw = L.baseW
    caps('SUMMARIZE INSTEAD', bx + bw, bandBottom + 18, '#aab3c8', 9, 'right', bw + 12)
    caps('SIMPLE BASELINE', bx + bw, bandBottom + 30, FAINT, 8, 'right', bw + 12)
    caps(S.baseline.avgRecall == null ? 'NO FOLD YET' : `AVG RECALL ${fmtPct(S.baseline.avgRecall, 0)}`, bx + bw, bandBottom + 42, S.baseline.avgRecall == null ? FAINT : ROSE, 8.5, 'right', bw + 12)
    ctx.fillStyle = 'rgba(255,255,255,.018)'; ctx.fillRect(bx, L.bTop, bw, L.bBottom - L.bTop)
    drawTower(baseLane, bx, bw, now, L.bTop, true)
    ctx.fillStyle = 'rgba(148,163,184,.5)'; ctx.fillRect(bx - 12, L.bBottom + 1, bw + 16, 1.5)
    drawLine(bx - 12, bx + bw + 4, L.bBottom - L.bHb, 'rgba(251,191,36,.8)', null, false)

    // particles
    particles = particles.filter((p) => p.life < p.max)
    ctx.globalCompositeOperation = 'lighter'
    for (const p of particles) {
      p.life += dt; p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt
      ctx.globalAlpha = clamp(1 - p.life / p.max, 0, 1)
      ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    // floaters
    floaters = floaters.filter((f) => now - f.t0 < 2600)
    for (const f of floaters) {
      const t = (now - f.t0) / 2600
      if (t < 0) continue
      ctx.globalAlpha = t < 0.1 ? t / 0.1 : 1 - Math.max(0, t - 0.6) / 0.4
      font(f.big ? 12.5 : 10, 700)
      const tw = ctx.measureText(f.text).width + 12
      const fx = clamp(f.x - tw / 2, 4, W - tw - 4), fy = f.y - t * 26
      const fh = f.big ? 24 : 18
      rr(fx, fy - fh / 2, tw, fh, 7); ctx.fillStyle = 'rgba(6,8,12,.92)'; ctx.fill(); ctx.strokeStyle = f.color; ctx.lineWidth = 1
      if (f.big) { ctx.save(); ctx.shadowColor = f.color; ctx.shadowBlur = 16; ctx.stroke(); ctx.restore() } else ctx.stroke()
      ctx.fillStyle = f.color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(f.text, fx + 6, fy + 0.5)
    }
    ctx.globalAlpha = 1

    // ---- legend ----
    let lx = gaugeX
    const ly = H - 10
    font(9.5, 600); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    for (let k = 0; k < 7; k++) {
      ctx.fillStyle = KIND_COLORS[k]; rr(lx, ly - 4, 8, 8, 2); ctx.fill()
      ctx.fillStyle = DIM; ctx.fillText(KIND_NAMES[k], lx + 12, ly + 0.5)
      lx += 12 + ctx.measureText(KIND_NAMES[k]).width + 12
    }
    const truthLegend = [[GREEN, 'truth: needed now'], ['#3a2430', 'not needed']]
    let need = 0
    for (const [, t] of truthLegend) need += 12 + ctx.measureText(t).width + 12
    if (lx + 10 + need < W - L.pad) {
      lx += 10
      for (const [c, t] of truthLegend) {
        ctx.fillStyle = c; ctx.fillRect(lx, ly - 5, 5, 10)
        ctx.fillStyle = DIM; ctx.fillText(t, lx + 9, ly + 0.5)
        lx += 12 + ctx.measureText(t).width + 12
      }
    }

    // hover tip
    if (hoverId != null) {
      const v = jevLane.map.get(hoverId)
      if (v) {
        const text = `${KIND_NAMES[v.kind]} ${v.label} · ${fmtInt(v.tokens)} tok${v.pinned ? ' · pinned' : ''}`
        font(10.5, 600)
        const tw = Math.min(ctx.measureText(text).width + 14, W - 20)
        const tx = clamp(mouse.x + 14, 4, W - tw - 4), ty = clamp(mouse.y - 24, 4, H - 24)
        rr(tx, ty, tw, 19, 6); ctx.fillStyle = 'rgba(8,10,16,.95)'; ctx.fill(); ctx.strokeStyle = '#2e3550'; ctx.lineWidth = 1; ctx.stroke()
        ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, tx + 7, ty + 10)
      }
    }
  }

  function loop() {
    const now = performance.now()
    const dt = Math.min(0.05, (now - lastT) / 1000)
    lastT = now
    if (S && L && W > 0) { try { draw(dt, now) } catch (e) { console.error(e) } }
    requestAnimationFrame(loop)
  }

  resize()
  connect()
  requestAnimationFrame(loop)
})()
