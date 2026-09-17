// Video Viewer pane. The server (viewer.mjs) streams the workspace's library over /events: every
// render with its frame rate, frame count, chapters (Manim sections), animations (beats) and what
// changed, plus renders in progress with the clips written so far. This page turns that into an
// editor-grade player: a filmstrip timeline with chapters, frame-accurate stepping, J/K/L, loop
// ranges, stills, and a pane that follows the agent — a render in progress plays as it is made, and
// the finished video swaps in where you were.
'use strict'
;(() => {
  // ---------------------------------------------------------------------------------------------
  // Small things
  const $ = (id) => document.getElementById(id)
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const ICON = {
    film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
    play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
    frameBack: '<path d="M6.5 6v12"/><path d="M18 6.8v10.4a.6.6 0 0 1-.9.5L9.6 12.5a.6.6 0 0 1 0-1l7.5-5.2a.6.6 0 0 1 .9.5z" fill="currentColor" stroke="none"/>',
    frameFwd: '<path d="M17.5 6v12"/><path d="M6 6.8v10.4a.6.6 0 0 0 .9.5l7.5-5.2a.6.6 0 0 0 0-1L6.9 6.3a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>',
    chapterPrev: '<path d="M4.5 6v12"/><path d="M12.5 7.2v9.6L7 12z" fill="currentColor" stroke="none"/><path d="M19.5 7.2v9.6L14 12z" fill="currentColor" stroke="none"/>',
    chapterNext: '<path d="M19.5 6v12"/><path d="M11.5 7.2v9.6L17 12z" fill="currentColor" stroke="none"/><path d="M4.5 7.2v9.6L10 12z" fill="currentColor" stroke="none"/>',
    loop: '<path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H19"/><path d="M16 3.5l3 3-3 3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="M8 20.5l-3-3 3-3"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.4"/>',
    expand: '<path d="M4.5 9V4.5H9M19.5 9V4.5H15M4.5 15v4.5H9M19.5 15v4.5H15"/>',
    collapse: '<path d="M9 4.5V9H4.5M15 4.5V9h4.5M9 19.5V15H4.5M15 19.5V15h4.5"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 0 1 4.7.6c0 1.6-2.4 2-2.4 3.4"/><path d="M12 16.9h.01"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    save: '<path d="M12 4.5v10.5"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    alert: '<path d="M10.3 4.9L3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8h.01"/>',
    volumeOn: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    volumeOff: '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    reverse: '<path d="M16 5.8v12.4a.8.8 0 0 1-1.2.7l-10-6.2a.8.8 0 0 1 0-1.4l10-6.2a.8.8 0 0 1 1.2.7z" fill="currentColor" stroke="none"/>',
  }
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`
  function hydrate(root = document) {
    for (const node of root.querySelectorAll('[data-icon]')) {
      if (node.dataset.drawn === node.dataset.icon) continue
      node.innerHTML = svg(node.dataset.icon)
      node.dataset.drawn = node.dataset.icon
    }
  }
  const setIcon = (node, name) => { if (node.dataset.icon !== name) { node.dataset.icon = name; hydrate(node.parentElement) } }

  function timecode(frame, fps) {
    fps = fps || 30
    frame = Math.max(0, Math.floor(frame + 1e-6))
    const secs = Math.floor(frame / fps + 1e-9)
    const ff = Math.floor(frame - secs * fps + 1e-6)
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60
    return { main: `${h ? h + ':' + pad(m) : pad(m)}:${pad(s)}`, ff: pad(ff) }
  }
  const tcText = (frame, fps) => { const t = timecode(frame, fps); return `${t.main}:${t.ff}` }
  function seconds(sec) {
    if (sec == null || !isFinite(sec)) return '–'
    if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : sec.toFixed(1)} s`
    const m = Math.floor(sec / 60), s = Math.round(sec % 60)
    return `${m}:${pad(s)}`
  }
  function shortTime(sec) {
    if (sec == null || !isFinite(sec)) return '–'
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
    return `${m}:${pad(s)}`
  }
  function ago(ms) {
    if (!ms) return ''
    const d = (Date.now() - ms) / 1000
    if (d < 8) return 'just now'
    if (d < 60) return `${Math.round(d)} s ago`
    if (d < 3600) return `${Math.round(d / 60)} min ago`
    if (d < 86400) return `${Math.round(d / 3600)} h ago`
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function agoShort(ms) {
    if (!ms) return ''
    const d = (Date.now() - ms) / 1000
    if (d < 45) return 'now'
    if (d < 3600) return `${Math.round(d / 60)}m`
    if (d < 86400) return `${Math.round(d / 3600)}h`
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  const wsUrl = (path, v) => '/ws/' + path.split('/').map(encodeURIComponent).join('/') + (v ? `?v=${v}` : '')
  const chapterName = (name) => (name === 'autocreated' ? 'Opening' : name)
  // Labels as Manim prints them ("_MethodAnimation(Text(...))") read better short.
  const prettyLabel = (label) => label == null ? null : String(label).replace(/^_MethodAnimation\(/, 'animate(').replace(/^Wait\(.*\)$/, 'Wait')
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`
  const qualityFps = (q) => Number(/^\d+p(\d+)$/.exec(q ?? '')?.[1]) || null

  function once(target, events, ms = 6000) {
    return new Promise((resolve, reject) => {
      const handlers = {}
      const finish = (fn, value) => { clearTimeout(timer); for (const e of events) target.removeEventListener(e, handlers[e]); fn(value) }
      const timer = setTimeout(() => finish(reject, new Error('timeout')), ms)
      for (const e of events) {
        handlers[e] = (ev) => (e === 'error' ? finish(reject, new Error('media error')) : finish(resolve, ev))
        target.addEventListener(e, handlers[e])
      }
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Elements, preferences, session
  const el = {}
  for (const id of ['app', 'title', 'variants', 'subtitle', 'follow', 'status', 'player', 'stage', 'video', 'freeze', 'still', 'render-progress', 'live-badge', 'chapter-flash', 'flash', 'edge', 'edge-text', 'notice', 'empty', 'toast', 'timeline', 'track', 'chapters-row', 'strip', 'film', 'pending', 'changes', 'ticks', 'loopband', 'hoverline', 'playhead', 'preview', 'preview-canvas', 'preview-tc', 'preview-label', 'transport', 'b-prev', 'b-back', 'b-play', 'b-fwd', 'b-next', 'timecode', 'tc-now', 'tc-dur', 'tc-frame', 'b-in', 'b-out', 'b-speed', 'b-loop', 'b-mute', 'b-frame', 'frame-menu', 'b-full', 'b-help', 'help', 'help-close', 'side', 'outline-panel', 'outline-tabs', 'outline-count', 'outline', 'outline-hint', 'renders-panel', 'renders-count', 'renders', 'thumb-video', 'peek-video']) {
    el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id)
  }
  const V = el.video
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
  const prefs = { speed: 1, loop: true, tcMode: 0, outlineTab: 'chapters' }
  const sess = { param: undefined, key: null, path: null, follow: true, baseline: 0, frames: {}, ack: {}, dismissed: {} }
  let storeKey = 'vv'
  const readStore = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null') } catch { return null } }
  const writeStore = (store, key, value) => { try { store.setItem(key, JSON.stringify(value)) } catch {} }
  const savePrefs = () => writeStore(localStorage, `${storeKey}:prefs`, prefs)
  let sessTimer = null
  const saveSess = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => writeStore(sessionStorage, `${storeKey}:session`, sess), 300) }

  // ---------------------------------------------------------------------------------------------
  // State
  const S = {
    lib: null,
    groups: [],
    key: null, // the render group shown (Manim: one scene, all its qualities)
    path: null, // a pinned variant; null = the newest
    view: 'auto', // 'auto' | 'live' | 'file'
    follow: true, // jump to whatever the agent renders next
    baseline: 0, // the newest activity already accounted for by follow
    pendingParam: null,
    pendingSection: null,
    range: { in: null, out: null },
    scrub: null,
    hover: null,
    lastFrame: -1,
    lastSection: -1,
    uiDirty: true,
    booted: false,
  }
  // The player
  const P = { src: null, clip: -1, target: null, queued: null, pendingLocal: null, wantPlay: false, waiting: false, reverse: 0, revLast: 0, revAcc: 0 }

  // ---------------------------------------------------------------------------------------------
  // Library → groups
  function groupsOf(lib) {
    const map = new Map()
    const get = (key, title, module) => {
      let g = map.get(key)
      if (!g) map.set(key, (g = { key, title, module, variants: [], live: null }))
      return g
    }
    for (const r of lib.renders) get(r.key, r.title, r.module).variants.push(r)
    for (const l of lib.live) get(l.key, l.title, l.module).live = l
    for (const g of map.values()) {
      g.variants.sort((a, b) => b.mtimeMs - a.mtimeMs)
      g.latest = g.variants.find((v) => v.complete) ?? null
      const liveAt = g.live ? (g.live.state === 'rendering' ? g.live.startedAtMs ?? g.live.updatedAtMs : g.live.updatedAtMs) ?? 0 : 0
      g.activity = Math.max(g.latest?.mtimeMs ?? 0, liveAt)
    }
    return [...map.values()].filter((g) => g.latest || g.live).sort((a, b) => b.activity - a.activity)
  }
  const currentGroup = () => S.groups.find((g) => g.key === S.key) ?? null
  const readyClips = (live) => {
    const out = []
    for (const c of live?.clips ?? []) { if (!c.ready) break; out.push(c) }
    return out
  }

  function resolveParam(param) {
    if (!param || !S.lib) return null
    const renders = S.lib.renders
    const r = renders.find((x) => x.path === param)
    if (r) return { key: r.key, path: r.path }
    const sec = /^(.*)\/sections\/(.+)_(\d{4})_[^/]*\.[a-z0-9]+$/i.exec(param)
    if (sec) {
      const parent = renders.find((x) => x.path.startsWith(`${sec[1]}/${sec[2]}.`))
      if (parent) return { key: parent.key, path: parent.path, section: Number(sec[3]) }
    }
    const part = /^(.*)\/partial_movie_files\/([^/]+)\//.exec(param)
    if (part) {
      const scene = `${part[1]}/${part[2]}`
      const parent = renders.find((x) => x.path.startsWith(scene + '.')) ?? null
      const live = S.lib.live.find((l) => (l.output ?? '').startsWith(scene + '.'))
      if (parent || live) return { key: (parent ?? live).key, path: parent?.path ?? null, live: Boolean(live) }
    }
    return null
  }

  // ---------------------------------------------------------------------------------------------
  // Sources
  function fileSource(r) {
    const fps = r.fps || qualityFps(r.quality) || 30
    return {
      id: `file:${r.path}@${r.mtimeMs}`, family: `file:${r.path}`, kind: r.kind === 'video' ? 'file' : 'image',
      key: r.key, path: r.path, title: r.title, quality: r.quality, url: wsUrl(r.path, r.mtimeMs),
      fps, frames: r.frames || (r.duration ? Math.round(r.duration * fps) : 0), duration: r.duration,
      width: r.width, height: r.height, audio: r.audio, sections: r.sections ?? null, beats: r.beats ?? null,
      changes: r.changes ?? null, render: r, live: null, expectedFrames: null,
    }
  }

  function liveSource(g, live, ready) {
    const fps = ready[0]?.fps || qualityFps(live.quality) || 30
    let start = 0
    const clips = ready.map((c) => {
      const o = { url: wsUrl(c.path, c.mtimeMs), path: c.path, name: c.path.split('/').pop(), start, frames: c.frames }
      start += c.frames
      return o
    })
    const byClip = new Map((live.animations ?? []).filter((a) => a.clip).map((a) => [a.clip, a]))
    const beats = clips.map((c) => ({ start: c.start, frames: c.frames, label: byClip.get(c.name)?.label ?? null, index: byClip.get(c.name)?.index ?? null, name: c.name }))
    const prev = g.variants.find((v) => v.quality === live.quality && v.kind === 'video') ?? g.latest
    // Chapters so far: a section begins at the first clip whose animation is at or after its start.
    let sections = null
    if ((live.sections ?? []).length) {
      const secs = []
      for (const sec of live.sections) {
        const first = beats.find((b) => b.index != null && b.index >= sec.animation)
        if (!first && secs.length) continue
        secs.push({ index: secs.length, name: sec.name, start: first ? first.start : start, frames: 0 })
      }
      secs.forEach((s, i) => { s.frames = Math.max(0, (secs[i + 1]?.start ?? start) - s.start) })
      sections = secs.filter((s, i) => s.frames > 0 || i === secs.length - 1)
      if (sections.length === 1 && sections[0].name === 'autocreated') sections = null
    }
    const expected = live.contiguous !== false && prev?.frames ? Math.max(prev.frames, start) : null
    const prevNames = new Set((prev?.beats ?? []).map((b) => b.name))
    let ranges = null
    // Manim's hashed clip names say what is new; uncached_NNNNN names say nothing, so mark nothing.
    if (prev?.beats && !beats.some((b) => /^uncached_/.test(b.name))) {
      ranges = []
      for (const b of beats) {
        if (prevNames.has(b.name)) continue
        const last = ranges[ranges.length - 1]
        if (last && last[1] === b.start) last[1] = b.start + b.frames
        else ranges.push([b.start, b.start + b.frames])
      }
    }
    return {
      id: `live:${g.key}:${live.startedAtMs ?? ''}`, family: `live:${g.key}`, kind: 'clips', key: g.key, path: live.output, title: live.title, quality: live.quality,
      fps, frames: start, duration: start / fps, width: ready[0]?.width, height: ready[0]?.height, audio: false,
      clips, sections, beats, changes: ranges ? { ranges, live: true } : null, render: null, live, expectedFrames: expected, prevRender: prev ?? null,
    }
  }

  const axisFrames = () => Math.max(1, P.src?.expectedFrames || 0, P.src?.frames || 0)

  // ---------------------------------------------------------------------------------------------
  // Player
  const fpsNow = () => P.src?.fps || 30
  function frameNow() {
    const s = P.src
    if (!s || !s.frames) return 0
    if (P.target != null) return P.target
    if (s.kind === 'clips') {
      const c = s.clips[P.clip]
      if (!c) return 0
      return clamp(c.start + Math.floor(V.currentTime * s.fps + 1e-3), c.start, c.start + c.frames - 1)
    }
    return clamp(Math.floor(V.currentTime * s.fps + 1e-3), 0, s.frames - 1)
  }
  const isPlaying = () => P.reverse !== 0 || P.waiting || (!V.paused && !V.ended)

  let freezeTimer = null
  function freeze() {
    if (V.readyState < 2 || !V.videoWidth || el.freeze.hidden === false) return
    try {
      el.freeze.width = V.videoWidth; el.freeze.height = V.videoHeight
      el.freeze.getContext('2d').drawImage(V, 0, 0)
      el.freeze.hidden = false
      clearTimeout(freezeTimer)
      freezeTimer = setTimeout(unfreeze, 2500)
    } catch {}
  }
  function unfreeze() {
    if (el.freeze.hidden) return
    const hide = () => { el.freeze.hidden = true }
    if (V.requestVideoFrameCallback) V.requestVideoFrameCallback(() => requestAnimationFrame(hide))
    else requestAnimationFrame(() => requestAnimationFrame(hide))
    clearTimeout(freezeTimer)
    freezeTimer = setTimeout(hide, 400)
  }

  function unload() {
    P.src = null; P.clip = -1; P.target = null; P.waiting = false; stopReverse()
    V.removeAttribute('src'); V.load()
    el.still.hidden = true
    S.uiDirty = true
  }

  function loadSource(src, { frame = 0, play = false } = {}) {
    stopReverse()
    const prev = P.src
    if (prev && prev.kind !== 'image') freeze()
    if (prev && prev.key !== src.key) hideToast()
    P.src = src; P.clip = -1; P.target = null; P.queued = null; P.waiting = false; P.pendingLocal = null
    S.prevSrc = prev && prev.kind !== 'image' ? prev : S.prevSrc
    el.app.classList.toggle('image-mode', src.kind === 'image')
    el.stage.style.setProperty('--ar', src.width && src.height ? `${src.width} / ${src.height}` : '16 / 9')
    el.preview.style.setProperty('--ar', src.width && src.height ? `${src.width} / ${src.height}` : '16 / 9')
    if (src.kind === 'image') {
      V.pause(); V.removeAttribute('src'); V.load()
      el.still.src = src.url
      el.still.hidden = false
      el.freeze.hidden = true
    } else {
      el.still.hidden = true
      if (S.range.in != null || S.range.out != null) { if (!prev || prev.key !== src.key) S.range = { in: null, out: null } }
      P.wantPlay = play
      if (src.kind === 'file') {
        const f = clamp(frame, 0, Math.max(0, src.frames - 1))
        P.target = f
        P.pendingLocal = (f + 0.5) / src.fps
        V.src = src.url
        V.loop = false
      } else {
        gotoClipFrame(frame, play)
      }
      applyLoop()
    }
    S.uiDirty = true
    S.lastSection = -2
    renderAll()
  }

  function clipIndexFor(frame, src = P.src) {
    const cs = src.clips
    for (let i = cs.length - 1; i >= 0; i--) if (frame >= cs[i].start) return i
    return 0
  }
  function gotoClipFrame(frame, play) {
    const s = P.src
    if (!s.clips.length) return
    frame = clamp(frame, 0, s.frames - 1)
    const i = clipIndexFor(frame)
    const c = s.clips[i]
    const local = (frame - c.start + 0.5) / s.fps
    P.target = frame
    P.wantPlay = play
    if (P.clip !== i || !V.currentSrc) {
      if (P.clip !== -1) freeze()
      P.clip = i
      P.pendingLocal = local
      V.src = c.url
    } else if (V.readyState >= 1) {
      if (V.seeking) { P.queued = frame; return }
      V.currentTime = local
    } else P.pendingLocal = local
  }

  function seek(frame) {
    const s = P.src
    if (!s || !s.frames || s.kind === 'image') return
    frame = clamp(Math.round(frame), 0, s.frames - 1)
    P.waiting = false
    if (s.kind === 'clips') { gotoClipFrame(frame, P.wantPlay && !V.paused ? true : P.wantPlay); S.uiDirty = true; return }
    P.target = frame
    if (V.readyState < 1 || P.pendingLocal != null) { P.pendingLocal = (frame + 0.5) / s.fps; S.uiDirty = true; return }
    if (V.seeking) { P.queued = frame; S.uiDirty = true; return }
    V.currentTime = (frame + 0.5) / s.fps
    S.uiDirty = true
  }

  function play() {
    const s = P.src
    if (!s || s.kind === 'image') return
    stopReverse()
    P.wantPlay = true
    if (P.waiting) return
    const f = frameNow()
    if (f >= s.frames - 1 && !(s.kind === 'clips' && s.live?.state === 'rendering')) seek(activeRange()?.in ?? 0)
    V.playbackRate = V.defaultPlaybackRate = prefs.speed
    V.play().catch(() => {})
    updatePlayButton()
  }
  function pause() {
    stopReverse()
    P.wantPlay = false
    P.waiting = false
    V.pause()
    updatePlayButton()
    S.uiDirty = true
  }
  function togglePlay() {
    if (isPlaying()) pause(); else play()
    flashIcon(isPlaying() ? 'play' : 'pause')
  }
  function step(n) {
    if (!P.src) return
    pause()
    seek(frameNow() + n)
  }
  function stopReverse() {
    if (!P.reverse) return
    P.reverse = 0
    updatePlayButton()
  }
  function startReverse(rate) {
    V.pause(); P.wantPlay = false; P.waiting = false
    P.reverse = rate; P.revLast = performance.now(); P.revAcc = 0
    updatePlayButton()
    const tickReverse = (now) => {
      if (!P.reverse) return
      const dt = Math.min(0.25, (now - P.revLast) / 1000)
      P.revLast = now
      P.revAcc += dt * P.reverse * fpsNow()
      if (P.revAcc >= 1 && !V.seeking && P.pendingLocal == null) {
        const n = Math.floor(P.revAcc)
        P.revAcc -= n
        const f = frameNow() - n
        if (f <= 0) { seek(0); P.reverse = 0; updatePlayButton(); return }
        seek(f)
      }
      requestAnimationFrame(tickReverse)
    }
    requestAnimationFrame(tickReverse)
  }
  function shuttle(direction) {
    if (!P.src || P.src.kind === 'image') return
    const SHUTTLE = [1, 1.5, 2]
    const faster = (r) => SHUTTLE.find((x) => x > r) ?? SHUTTLE[SHUTTLE.length - 1]
    if (direction > 0) {
      if (P.reverse) { stopReverse(); setSpeed(1); play(); return }
      if (isPlaying()) setSpeed(faster(prefs.speed))
      else { setSpeed(1); play() }
    } else {
      if (P.reverse) { P.reverse = faster(P.reverse); showSpeed(); return }
      startReverse(1)
    }
    showSpeed()
  }
  function setSpeed(x) {
    prefs.speed = clamp(x, 0.25, 2)
    V.playbackRate = V.defaultPlaybackRate = prefs.speed
    savePrefs(); showSpeed()
  }
  function showSpeed() {
    const r = P.reverse ? -P.reverse : prefs.speed
    el.bSpeed.textContent = `${r < 0 ? '◀ ' : ''}${Math.abs(r)}×`
    el.bSpeed.classList.toggle('changed', r !== 1)
  }
  function activeRange() {
    const s = P.src
    if (!s || (S.range.in == null && S.range.out == null)) return null
    const a = clamp(S.range.in ?? 0, 0, s.frames - 1), b = clamp(S.range.out ?? s.frames - 1, 0, s.frames - 1)
    return a <= b ? { in: a, out: b } : { in: b, out: a }
  }
  function applyLoop() {
    V.loop = Boolean(prefs.loop && P.src?.kind === 'file' && !activeRange())
    el.bLoop.classList.toggle('on', prefs.loop)
  }

  V.addEventListener('loadedmetadata', () => {
    const s = P.src
    if (s && s.kind === 'file' && !s.frames && isFinite(V.duration)) { s.frames = Math.round(V.duration * s.fps); S.uiDirty = true; renderTimeline() }
    V.playbackRate = V.defaultPlaybackRate = prefs.speed
    if (P.pendingLocal != null) { V.currentTime = P.pendingLocal; P.pendingLocal = null }
    if (P.wantPlay) V.play().catch(() => {})
  })
  V.addEventListener('seeked', () => {
    if (P.queued != null) { const f = P.queued; P.queued = null; P.target = null; seek(f); return }
    P.target = null
    S.uiDirty = true
    unfreeze()
  })
  V.addEventListener('playing', unfreeze)
  V.addEventListener('loadeddata', () => { if (!V.seeking && P.pendingLocal == null) unfreeze() })
  V.addEventListener('play', updatePlayButton)
  V.addEventListener('pause', updatePlayButton)
  V.addEventListener('error', () => { unfreeze() })
  V.addEventListener('ended', () => {
    const s = P.src
    if (!s) return
    const r = activeRange()
    if (s.kind === 'clips') {
      if (P.clip < s.clips.length - 1) {
        const next = s.clips[P.clip + 1]
        if (r && prefs.loop && next.start > r.out) { gotoClipFrame(r.in, true); return }
        gotoClipFrame(next.start, true)
        return
      }
      if (s.live?.state === 'rendering') { P.waiting = true; P.wantPlay = true; renderEdge(); updatePlayButton(); return }
    }
    if (prefs.loop) { seek(r ? r.in : 0); P.wantPlay = true; if (s.kind === 'file') V.play().catch(() => {}); else gotoClipFrame(r ? r.in : 0, true) }
    else { P.wantPlay = false; updatePlayButton() }
  })

  function updatePlayButton() {
    const playing = isPlaying()
    setIcon(el.bPlay, P.reverse ? 'reverse' : playing ? 'pause' : 'play')
    el.bPlay.title = playing ? 'Pause (space, K)' : 'Play (space, L)'
    S.uiDirty = true
  }

  let flashTimer = null
  function flashIcon(name) {
    el.flash.innerHTML = svg(name)
    el.flash.classList.remove('go')
    void el.flash.offsetWidth
    el.flash.classList.add('go')
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => el.flash.classList.remove('go'), 600)
  }

  // ---------------------------------------------------------------------------------------------
  // Deciding what to show
  function decide() {
    const groups = S.groups
    const newest = groups[0] ?? null
    if (S.pendingParam) {
      const hit = resolveParam(S.pendingParam)
      if (hit) {
        S.key = hit.key; S.path = hit.path; S.view = hit.live ? 'live' : 'auto'; S.pendingParam = null
        if (hit.section != null) S.pendingSection = hit.section
        S.baseline = Math.max(S.baseline, newest?.activity ?? 0)
      }
    }
    if (S.follow && newest && newest.activity > S.baseline) {
      if (newest.key !== S.key) { S.key = newest.key; S.path = null; S.view = 'auto' }
      else if (S.path && newest.latest && newest.latest.path !== S.path && newest.latest.mtimeMs > S.baseline) S.path = null
      if (S.view === 'file' && newest.live?.state === 'rendering') S.view = 'auto'
      S.baseline = newest.activity
    }
    if (!groups.some((g) => g.key === S.key)) { S.key = newest?.key ?? null; S.path = null; S.view = 'auto' }
    const g = currentGroup()
    sess.key = S.key; sess.path = S.path; sess.follow = S.follow; sess.baseline = S.baseline; saveSess()
    return targetFor(g)
  }

  function targetFor(g) {
    if (!g) return { kind: 'none' }
    const live = g.live
    const ready = readyClips(live)
    const variant = (S.path && g.variants.find((v) => v.path === S.path && v.complete)) || g.latest
    const wantLive = live && ready.length && (S.view === 'live' || (S.view === 'auto' && live.state === 'rendering') || !variant)
    if (wantLive) return { kind: 'clips', group: g, live, ready }
    if (variant) return { kind: variant.kind === 'video' ? 'file' : 'image', group: g, render: variant }
    return { kind: 'none', group: g, live }
  }

  function mapFrame(from, to, frame) {
    if (!from || !to || !to.frames) return 0
    let f = frame
    if (from.fps && to.fps && Math.abs(from.fps - to.fps) > 0.01) f = Math.round((frame / from.fps) * to.fps)
    else if (from.sections && to.sections) {
      const sec = [...from.sections].reverse().find((x) => frame >= x.start)
      const same = sec && to.sections.find((x) => x.name === sec.name)
      if (sec && same) f = same.start + Math.min(frame - sec.start, Math.max(0, same.frames - 1))
    }
    return clamp(f, 0, to.frames - 1)
  }

  function apply(target) {
    if (target.kind === 'none') {
      if (P.src) unload()
      el.app.classList.add('no-media')
      renderAll()
      return
    }
    el.app.classList.remove('no-media')
    const cur = P.src
    if (target.kind === 'file' || target.kind === 'image') {
      const src = fileSource(target.render)
      if (cur && cur.id === src.id) { refreshSource(cur, src); return }
      if (cur && cur.family === src.family && src.kind === 'file') {
        const frame = mapFrame(cur, src, frameNow())
        loadSource(src, { frame, play: isPlaying() })
        announce(src, 'updated')
      } else if (cur && cur.key === src.key && src.kind === 'file' && cur.kind !== 'image') {
        const frame = mapFrame(cur, src, frameNow())
        const fromLive = cur.kind === 'clips'
        loadSource(src, { frame, play: isPlaying() || (fromLive && P.wantPlay) })
        // Back from a live preview: news only if the render it was previewing actually landed.
        if (fromLive && (src.render?.mtimeMs ?? 0) > (cur.live?.startedAtMs ?? Infinity)) announce(src, 'landed')
      } else {
        let frame = mapFrame({ fps: src.fps }, src, sess.frames[src.key] ?? 0)
        if (S.pendingSection != null && src.sections?.[S.pendingSection]) frame = src.sections[S.pendingSection].start
        S.pendingSection = null
        // A reload of the same page keeps a paused player paused; anything new plays.
        const keepPaused = !S.booted && S.restored && sess.paused
        loadSource(src, { frame, play: !keepPaused })
        if (!S.booted || (src.changes && Date.now() - (src.changes.at ?? 0) < 5 * 60_000)) announce(src, 'opened')
      }
      return
    }
    // A render in progress: its clips so far, as one timeline that grows.
    const src = liveSource(target.group, target.live, target.ready)
    if (cur && cur.family === src.family && cur.id === src.id) {
      const grew = src.clips.length > cur.clips.length
      Object.assign(cur, { clips: src.clips, frames: src.frames, duration: src.duration, sections: src.sections, beats: src.beats, changes: src.changes, live: src.live, expectedFrames: src.expectedFrames })
      if (P.waiting && grew && cur.clips[P.clip + 1]) { P.waiting = false; gotoClipFrame(cur.clips[P.clip + 1].start, true) }
      S.uiDirty = true
      renderAll()
      return
    }
    hideToast()
    let frame = 0
    const firstChanged = src.changes?.ranges?.[0]?.[0]
    if (cur && cur.key === src.key && cur.kind === 'file') frame = firstChanged ?? Math.min(frameNow(), src.clips[src.clips.length - 1].start)
    else frame = firstChanged ?? src.clips[src.clips.length - 1].start
    loadSource(src, { frame, play: true })
  }

  function refreshSource(cur, next) {
    // The same file, same render: only facts that arrive late (sections after the movie) change.
    const before = JSON.stringify([cur.sections, cur.beats, cur.changes])
    cur.sections = next.sections; cur.beats = next.beats; cur.changes = next.changes; cur.render = next.render
    if (!cur.frames && next.frames) cur.frames = next.frames
    if (before !== JSON.stringify([cur.sections, cur.beats, cur.changes])) S.uiDirty = true
    renderAll()
  }

  function onLibrary(lib) {
    const first = !S.lib
    S.lib = lib
    if (first) boot(lib)
    S.groups = groupsOf(lib)
    const target = decide()
    apply(target)
    if (first) { S.booted = true; el.app.classList.remove('booting') }
    renderAll()
    queuePosters()
  }

  function boot(lib) {
    storeKey = `vv:${lib.workspace.path}`
    Object.assign(prefs, readStore(localStorage, `${storeKey}:prefs`) ?? {})
    Object.assign(sess, readStore(sessionStorage, `${storeKey}:session`) ?? {})
    const param = new URLSearchParams(location.search).get('file') || null
    S.groups = groupsOf(lib)
    const newestActivity = S.groups[0]?.activity ?? 0
    if (sess.param === param && sess.key) {
      // A reload of the same page: where the user was.
      S.key = sess.key; S.path = sess.path; S.follow = sess.follow !== false; S.baseline = sess.baseline ?? newestActivity
      S.restored = true
    } else if (param) {
      S.pendingParam = param
      S.follow = true
      S.baseline = newestActivity
      if (!resolveParam(param)) S.baseline = 0
    } else {
      S.follow = true; S.baseline = 0
    }
    sess.param = param
    showSpeed(); applyLoop()
  }

  // ---------------------------------------------------------------------------------------------
  // Announcements: what changed, failures
  let toastTimer = null
  function toast(html, { actions = [], kind = '', timeout = 9000 } = {}) {
    el.toast.className = `toast ${kind}`
    el.toast.innerHTML = `<span class="t-icon"></span><span class="t-text">${html}</span>`
    for (const a of actions) {
      const b = document.createElement('button')
      b.className = a.icon ? 'icon-btn' : `btn ${a.primary ? 'primary' : ''}`
      if (a.icon) { b.innerHTML = svg(a.icon); b.title = a.label } else b.textContent = a.label
      b.addEventListener('click', (e) => { e.stopPropagation(); a.fn() })
      el.toast.append(b)
    }
    el.toast.hidden = false
    clearTimeout(toastTimer)
    if (timeout) toastTimer = setTimeout(() => { el.toast.hidden = true }, timeout)
  }
  const hideToast = () => { el.toast.hidden = true; clearTimeout(toastTimer) }

  const changeAcked = (src) => !src?.changes || src.changes.live ? false : (sess.ack[src.path] ?? 0) >= (src.changes.at ?? 0)
  function ackChanges(src) {
    if (!src?.changes) return
    sess.ack[src.path] = src.changes.at ?? Date.now()
    saveSess()
    S.uiDirty = true
    renderTimeline(); renderOutline()
  }

  function describeChanges(src) {
    const c = src.changes
    if (!c) return null
    const bits = []
    const beats = src.beats ?? []
    if (c.ranges) {
      const n = beats.filter((b) => c.ranges.some(([a, z]) => a < b.start + b.frames && z > b.start)).length
      if (n) bits.push(plural(n, 'animation') + ' changed')
    }
    if (c.sections?.added?.length) bits.push(c.sections.added.length === 1 ? `new chapter “${esc(chapterName(c.sections.added[0]))}”` : `${c.sections.added.length} new chapters`)
    if (c.sections?.removed?.length) bits.push(`${plural(c.sections.removed.length, 'chapter')} removed`)
    if (typeof c.durationDelta === 'number' && Math.abs(c.durationDelta) >= 0.05) bits.push(`${c.durationDelta > 0 ? '+' : '−'}${Math.abs(c.durationDelta).toFixed(1)} s`)
    if (!bits.length && c.same) return 'no visible change'
    return bits.join(' · ')
  }
  const describeRender = (src) => [src.sections?.length > 1 ? plural(src.sections.length, 'chapter') : src.beats?.length ? plural(src.beats.length, 'animation') : null, seconds(src.frames / src.fps)].filter(Boolean).join(' · ')

  function announce(src, why) {
    if (src.kind !== 'file') return
    const summary = describeChanges(src) ?? (why === 'opened' ? null : describeRender(src))
    if (why === 'opened' && (!summary || changeAcked(src) || Date.now() - (src.changes?.at ?? 0) > 5 * 60_000)) return
    const head = why === 'opened' ? `Rendered ${ago(src.changes?.at ?? src.render?.mtimeMs)}` : why === 'landed' ? 'Render finished' : 'New render'
    const first = src.changes?.ranges?.[0]?.[0]
    const actions = []
    if (first != null && src.changes.ranges.length) actions.push({ label: 'Show change', primary: true, fn: () => { pause(); seek(first); flashChapterAt(first, true) } })
    actions.push({ label: 'Dismiss', icon: 'x', fn: () => { ackChanges(src); hideToast() } })
    toast(`<b>${head}</b>${summary ? ` <span>· ${summary}</span>` : ''}`, { actions, kind: src.changes && !src.changes.same ? '' : 'ok', timeout: 12000 })
    S.uiDirty = true
  }

  function renderNotice() {
    const g = currentGroup()
    const live = g?.live
    const bad = live && ['failed', 'stalled', 'stopped', 'cancelled'].includes(live.state)
    const dismissedAt = sess.dismissed[g?.key ?? ''] ?? 0
    if (!bad || dismissedAt >= (live.updatedAtMs ?? 0)) { el.notice.hidden = true; return }
    const e = live.error ?? {}
    const titleText = live.state === 'failed' ? `Rendering ${esc(live.title)} failed` : live.state === 'cancelled' ? `Rendering ${esc(live.title)} was stopped` : live.state === 'stopped' ? `Rendering ${esc(live.title)} stopped` : `Rendering ${esc(live.title)} stalled`
    let body = ''
    if (live.state === 'failed' && (e.message || e.type)) {
      body += `<p class="msg"><b>${esc(e.type ?? 'Error')}</b>: ${esc(e.message ?? '')}</p>`
      if (e.code || e.file) body += `<pre>${e.file ? `<span class="loc">${esc(e.file)}${e.line ? `:${e.line}` : ''}</span>` : ''}${esc(e.code ?? '')}</pre>`
    } else if (live.state === 'stalled') {
      body += `<p class="msg">No new animation for ${Math.round((Date.now() - (live.updatedAtMs ?? Date.now())) / 1000)} s and no video was written. The render most likely stopped with an error; the traceback is in the agent's terminal.</p>`
    } else if (live.state === 'stopped' || live.state === 'cancelled') {
      body += `<p class="msg">The render ended before the video was written.</p>`
    }
    const ready = readyClips(live).length
    const showingLive = P.src?.kind === 'clips'
    const note = showingLive ? `Playing the ${plural(ready, 'animation')} that rendered.` : g.latest ? 'Playing the last good render.' : ''
    hideToast()
    el.notice.innerHTML = `<div class="notice-card ${live.state}"><h3>${svg('alert')}${titleText}</h3>${body}<div class="foot"><span class="note">${note}</span></div></div>`
    const foot = el.notice.querySelector('.foot')
    if (ready && g.latest) {
      const b = document.createElement('button')
      b.className = 'btn'
      b.textContent = showingLive ? 'Last good render' : `Play what rendered (${ready})`
      b.addEventListener('click', () => { S.view = showingLive ? 'file' : 'live'; S.follow = false; update() })
      foot.append(b)
    }
    const ok = document.createElement('button')
    ok.className = 'btn primary'
    ok.textContent = 'Dismiss'
    ok.addEventListener('click', () => { sess.dismissed[g.key] = live.updatedAtMs ?? Date.now(); saveSess(); renderNotice() })
    foot.append(ok)
    el.notice.hidden = false
  }

  function renderEmpty() {
    const g = currentGroup()
    const noMedia = !P.src
    el.app.classList.toggle('no-media', noMedia)
    el.app.classList.toggle('nothing', noMedia && !S.groups.length)
    if (!noMedia) { el.empty.hidden = true; return }
    const lib = S.lib
    let html
    if (g?.live) {
      const l = g.live
      html = `<div class="empty-inner"><div class="empty-art">${svg('film')}<div class="sweep"><i></i></div></div><h2>Rendering ${esc(l.title)}…</h2><p>${l.animation ? `Animation ${l.animation}${l.current ? ` · ${esc(l.current)}` : ''}` : 'Starting Manim'}. The first clip plays here the moment it is written.</p></div>`
    } else if (lib && lib.scenes > 0) {
      html = `<div class="empty-inner"><div class="empty-art">${svg('film')}<div class="sweep"><i></i></div></div><h2>Nothing rendered yet</h2><p>${plural(lib.scenes, 'scene')} written. Each render plays here as it is made — animation by animation, then the finished video with its chapters.</p></div>`
    } else {
      html = `<div class="empty-inner"><div class="empty-art">${svg('film')}<div class="sweep"><i></i></div></div><h2>No renders yet</h2><p>Ask for an animation in the chat — a proof, a transform, an algorithm. It plays here while it renders, then as a video you can scrub frame by frame.</p></div>`
    }
    el.empty.innerHTML = html
    el.empty.hidden = !lib
  }

  // ---------------------------------------------------------------------------------------------
  // Header, status
  function renderHeader() {
    const g = currentGroup()
    const s = P.src
    el.title.textContent = g?.title ?? S.lib?.workspace?.name ?? 'Video Viewer'
    document.title = g?.title ? `${g.title} · Video Viewer` : 'Video Viewer'
    // Variants: one chip per quality, newest render of each.
    const byQuality = new Map()
    const variantKey = (v) => `${v.quality ?? v.path}${v.kind === 'gif' ? ' GIF' : ''}`
    for (const v of g?.variants ?? []) if (v.complete && !byQuality.has(variantKey(v))) byQuality.set(variantKey(v), v)
    const variants = [...byQuality.values()]
    el.variants.innerHTML = ''
    if (variants.length > 1 || (variants.length === 1 && variants[0].quality)) {
      for (const v of variants.sort((a, b) => (a.height ?? 0) - (b.height ?? 0))) {
        const b = document.createElement(variants.length > 1 ? 'button' : 'span')
        b.className = `chip ${variants.length > 1 && s && s.path === v.path && s.kind !== 'clips' ? 'on' : ''}`
        b.textContent = v.quality ? `${v.quality}${v.kind === 'gif' ? ' · GIF' : ''}` : v.path.split('.').pop()
        if (variants.length > 1) {
          b.title = `${v.width}×${v.height} · ${v.fps} fps · rendered ${ago(v.mtimeMs)}`
          b.addEventListener('click', () => { S.path = v.path; S.view = 'file'; S.follow = false; update() })
        }
        el.variants.append(b)
      }
    }
    // Subtitle
    const bits = []
    if (s?.kind === 'clips') {
      bits.push(s.live?.state === 'rendering' ? 'Live preview' : 'Partial render')
      bits.push(`${plural(s.clips.length, 'animation')} so far`)
      bits.push(seconds(s.frames / s.fps))
      if (s.width) bits.push(`${s.width}×${s.height}`)
    } else if (s?.kind === 'file') {
      if (s.width) bits.push(`${s.width}×${s.height}`)
      bits.push(`${s.fps} fps`)
      bits.push(seconds(s.duration ?? s.frames / s.fps))
      if (s.frames) bits.push(`${s.frames} frames`)
      if (s.sections?.length > 1) bits.push(plural(s.sections.length, 'chapter'))
      if (Date.now() - (s.render?.mtimeMs ?? 0) >= 90_000) bits.push(`rendered ${ago(s.render?.mtimeMs)}`)
    } else if (s?.kind === 'image') {
      if (s.width) bits.push(`${s.width}×${s.height}`)
      bits.push(s.render?.kind === 'gif' ? `GIF${s.duration ? ' · ' + seconds(s.duration) : ''}` : 'still')
      bits.push(`rendered ${ago(s.render?.mtimeMs)}`)
    } else if (S.lib) {
      bits.push(S.lib.workspace.name)
    }
    el.subtitle.textContent = bits.join(' · ')

    // Status pill
    const live = g?.live
    let cls = '', html = ''
    if (live?.state === 'rendering') {
      cls = 'rendering'
      const n = live.animation || 0
      html = `<span class="dot"></span>Rendering${n ? ` · ${n}${live.expected ? ` of ~${live.expected}` : ''}` : '…'}${live.current ? ` <span class="muted">${esc(live.current)}</span>` : ''}`
    } else if (live && ['failed', 'stopped', 'cancelled'].includes(live.state)) {
      cls = 'failed'; html = `<span class="dot"></span>${live.state === 'failed' ? 'Render failed' : 'Render stopped'}`
    } else if (live?.state === 'stalled') {
      cls = 'stalled'; html = '<span class="dot"></span>Render stalled'
    } else if (s?.kind === 'file' && s.render && Date.now() - s.render.mtimeMs < 90_000) {
      cls = 'updated'; html = `<span class="dot"></span>Rendered ${ago(s.render.mtimeMs)}`
    }
    el.status.className = `pill status ${cls}`
    el.status.innerHTML = html
    el.status.hidden = !html
    el.status.title = live?.state === 'rendering' && live.section && live.section !== 'autocreated' ? `Chapter: ${live.section}` : ''

    // Follow pill: shown when not following and something newer exists elsewhere.
    const newest = S.groups[0]
    const elsewhere = S.groups.find((x) => x.key !== S.key && x.live?.state === 'rendering')
    if (!S.follow && (elsewhere || (newest && newest.key !== S.key) || (g && S.path && g.latest && g.latest.path !== S.path) || S.view !== 'auto')) {
      el.follow.innerHTML = elsewhere ? `<span class="dot"></span>${esc(elsewhere.title)} is rendering` : '<span class="dot"></span>Follow latest'
      el.follow.hidden = false
    } else el.follow.hidden = true
  }

  // ---------------------------------------------------------------------------------------------
  // Timeline
  function renderTimeline() {
    const s = P.src
    const has = s && s.kind !== 'image' && s.frames > 0
    el.timeline.hidden = !has
    if (!has) { el.chaptersRow.innerHTML = ''; return }
    const axis = axisFrames()
    const pct = (f) => `${(f / axis) * 100}%`

    // Chapters row
    const sections = s.sections && (s.sections.length > 1 || (s.kind === 'clips' && s.sections.length)) ? s.sections : null
    el.track.classList.toggle('has-chapters', Boolean(sections))
    el.chaptersRow.innerHTML = ''
    S.chapterEls = []
    if (sections) {
      const acked = changeAcked(s)
      const changed = new Set(acked ? [] : [...(s.changes?.sections?.changed ?? []), ...(s.changes?.sections?.added ?? [])])
      let used = 0
      for (const sec of sections) {
        const b = document.createElement('button')
        b.className = `chap${changed.has(sec.name) ? ' changed' : ''}`
        const w = (sec.frames / axis) * 100
        b.style.flex = `0 0 calc(${w}% - 2px)`
        b.innerHTML = `<span class="n">${sec.index + 1}</span>${esc(chapterName(sec.name))}`
        b.title = `${sec.index + 1} · ${chapterName(sec.name)} — ${tcText(sec.start, s.fps)} · ${seconds(sec.frames / s.fps)}`
        b.addEventListener('click', (e) => { e.stopPropagation(); goChapter(sec.index) })
        el.chaptersRow.append(b)
        S.chapterEls.push(b)
        used += sec.frames
      }
      if (s.expectedFrames && s.expectedFrames > s.frames) {
        const ghost = document.createElement('div')
        ghost.className = 'chap ghost'
        ghost.style.flex = '1 1 auto'
        ghost.textContent = s.live?.state === 'rendering' ? 'rendering…' : 'not rendered'
        el.chaptersRow.append(ghost)
      }
    }

    // Pending (not rendered yet) region
    if (s.kind === 'clips' && s.expectedFrames && s.expectedFrames > s.frames && s.live?.state === 'rendering') {
      el.pending.hidden = false
      el.pending.style.left = pct(s.frames)
    } else el.pending.hidden = true

    // Changes
    el.changes.innerHTML = ''
    if (s.changes?.ranges && !changeAcked(s)) {
      for (const [a, b] of s.changes.ranges) {
        const i = document.createElement('i')
        i.style.left = pct(a); i.style.width = `max(3px, ${((b - a) / axis) * 100}%)`
        el.changes.append(i)
      }
    }

    // Ticks: animations (short), chapters (full height)
    el.ticks.innerHTML = ''
    const width = el.strip.clientWidth || 600
    if (s.beats && s.beats.length > 1 && s.beats.length < width / 5) {
      for (const b of s.beats.slice(1)) { const i = document.createElement('i'); i.style.left = pct(b.start); el.ticks.append(i) }
    }
    if (sections) for (const sec of sections.slice(1)) { const i = document.createElement('i'); i.className = 'sec'; i.style.left = pct(sec.start); el.ticks.append(i) }

    renderLoopBand()
    drawFilm()
    S.uiDirty = true
  }

  function renderLoopBand() {
    const r = activeRange()
    const axis = axisFrames()
    if (!r) { el.loopband.hidden = true } else {
      el.loopband.hidden = false
      el.loopband.classList.toggle('off', !prefs.loop)
      el.loopband.style.left = `${(r.in / axis) * 100}%`
      el.loopband.style.width = `${((r.out - r.in + 1) / axis) * 100}%`
    }
    el.bIn.classList.toggle('on', S.range.in != null)
    el.bOut.classList.toggle('on', S.range.out != null)
    el.bIn.innerHTML = S.range.in != null && P.src ? `In<span class="at">${tcText(S.range.in, P.src.fps)}</span>` : 'In'
    el.bOut.innerHTML = S.range.out != null && P.src ? `Out<span class="at">${tcText(S.range.out, P.src.fps)}</span>` : 'Out'
    el.bIn.title = S.range.in != null && P.src ? `Loop in at ${tcText(S.range.in, P.src.fps)} (I sets, X clears)` : 'Set loop in point (I)'
    el.bOut.title = S.range.out != null && P.src ? `Loop out at ${tcText(S.range.out, P.src.fps)} (O sets, X clears)` : 'Set loop out point (O)'
    applyLoop()
  }

  function sectionIndexAt(frame) {
    const secs = P.src?.sections
    if (!secs?.length) return -1
    for (let i = secs.length - 1; i >= 0; i--) if (frame >= secs[i].start) return i
    return 0
  }
  function beatIndexAt(frame) {
    const beats = P.src?.beats
    if (!beats?.length) return -1
    for (let i = beats.length - 1; i >= 0; i--) if (frame >= beats[i].start) return i
    return 0
  }

  function frameFromX(clientX) {
    const rect = el.strip.getBoundingClientRect()
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
    return { frame: Math.min(Math.floor(ratio * axisFrames()), axisFrames() - 1), x: clientX - rect.left, width: rect.width }
  }

  el.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.chap') || !P.src || P.src.kind === 'image') return
    e.preventDefault()
    el.track.setPointerCapture(e.pointerId)
    S.scrub = { wasPlaying: isPlaying() }
    V.pause(); stopReverse(); P.waiting = false
    el.track.classList.add('scrubbing')
    const { frame } = frameFromX(e.clientX)
    seek(Math.min(frame, P.src.frames - 1))
  })
  el.track.addEventListener('pointermove', (e) => {
    if (!P.src || P.src.kind === 'image') return
    const hit = frameFromX(e.clientX)
    if (S.scrub) seek(Math.min(hit.frame, P.src.frames - 1))
    hover(hit)
  })
  const endScrub = () => {
    if (!S.scrub) return
    const was = S.scrub.wasPlaying
    S.scrub = null
    el.track.classList.remove('scrubbing')
    if (was) play(); else { P.wantPlay = false; updatePlayButton() }
  }
  el.track.addEventListener('pointerup', endScrub)
  el.track.addEventListener('pointercancel', endScrub)
  el.track.addEventListener('pointerleave', () => { if (!S.scrub) { S.hover = null; el.preview.hidden = true; el.hoverline.hidden = true } })

  function hover({ frame, x, width }) {
    const s = P.src
    S.hover = { frame, key: `${s.id}:${frame}` }
    el.hoverline.hidden = false
    el.hoverline.style.left = `${x}px`
    const boxW = 192
    el.preview.hidden = false
    el.preview.style.left = `${clamp(x - boxW / 2, -8, width - boxW + 8)}px`
    el.previewTc.textContent = tcText(frame, s.fps)
    const secI = sectionIndexAt(frame), beatI = beatIndexAt(frame)
    const labels = []
    if (frame >= s.frames) labels.push('not rendered yet')
    else {
      if (secI >= 0 && s.sections.length > 1) labels.push(chapterName(s.sections[secI].name))
      if (beatI >= 0 && s.beats[beatI].label) labels.push(prettyLabel(s.beats[beatI].label))
    }
    el.previewLabel.textContent = labels.join(' · ')
    const ctx = el.previewCanvas.getContext('2d')
    const ar = s.width && s.height ? s.width / s.height : 16 / 9
    const cw = 384, ch = Math.round(cw / ar)
    if (el.previewCanvas.width !== cw || el.previewCanvas.height !== ch) { el.previewCanvas.width = cw; el.previewCanvas.height = ch }
    if (frame >= s.frames) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cw, ch); return }
    const exactPeek = (() => { const m = mediaFor(s, frame); return m && PEEKS.get(`${m.url}|${m.frame}`) })()
    const near = exactPeek ?? nearestThumb(s, frame)
    if (near) ctx.drawImage(near, 0, 0, cw, ch)
    if (exactPeek) return
    const media = mediaFor(s, frame)
    if (media) peek({ ...media, key: S.hover.key, fps: s.fps })
  }

  // ---------------------------------------------------------------------------------------------
  // Thumbnails: the filmstrip, the hover peek, the render posters. One hidden <video> each for the
  // strip/posters queue and for the peek; a frame is a seek and a drawImage.
  const THUMBS = new Map() // `${url}|${frame}` → canvas
  const THUMB_FRAMES = new Map() // url → sorted frame numbers cached
  function putThumb(url, frame, canvas) {
    const k = `${url}|${frame}`
    if (!THUMBS.has(k)) {
      const list = THUMB_FRAMES.get(url) ?? []
      list.push(frame); list.sort((a, b) => a - b)
      THUMB_FRAMES.set(url, list)
    }
    THUMBS.set(k, canvas)
    if (THUMBS.size > 500) {
      const oldest = THUMBS.keys().next().value
      THUMBS.delete(oldest)
      const [u, f] = oldest.split('|')
      const list = THUMB_FRAMES.get(u)
      if (list) { const i = list.indexOf(Number(f)); if (i >= 0) list.splice(i, 1) }
    }
  }
  function mediaFor(s, frame) {
    if (!s || !s.frames) return null
    frame = clamp(frame, 0, s.frames - 1)
    if (s.kind === 'file') return { url: s.url, frame }
    if (s.kind === 'clips') { const c = s.clips[clipIndexFor(frame, s)]; return c ? { url: c.url, frame: frame - c.start } : null }
    return null
  }
  function nearestThumb(s, frame) {
    const m = mediaFor(s, frame)
    if (!m) return null
    const exact = THUMBS.get(`${m.url}|${m.frame}`)
    if (exact) return exact
    const list = THUMB_FRAMES.get(m.url)
    if (list?.length) {
      let best = list[0]
      for (const f of list) if (Math.abs(f - m.frame) < Math.abs(best - m.frame)) best = f
      if (Math.abs(best - m.frame) <= Math.max(2, s.frames / 24)) return THUMBS.get(`${m.url}|${best}`)
    }
    const prev = S.prevSrc
    if (prev && prev.key === s.key && prev !== s) {
      const pm = mediaFor(prev, Math.min(frame, prev.frames - 1))
      const pl = pm && THUMB_FRAMES.get(pm.url)
      if (pl?.length) {
        let best = pl[0]
        for (const f of pl) if (Math.abs(f - pm.frame) < Math.abs(best - pm.frame)) best = f
        return THUMBS.get(`${pm.url}|${best}`)
      }
    }
    return null
  }

  async function grab(video, url, time, width) {
    if (video.dataset.url !== url) {
      video.dataset.url = url
      const ready = once(video, ['loadeddata', 'error'])
      video.src = url
      await ready
    }
    const t = clamp(time, 0, Math.max(0, (video.duration || 0) - 0.001))
    if (Math.abs(video.currentTime - t) > 0.0005 || video.readyState < 2) {
      const seeked = once(video, ['seeked', 'error'])
      video.currentTime = t
      await seeked
    }
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9
    const c = document.createElement('canvas')
    c.width = width; c.height = Math.round((width * vh) / vw)
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height)
    return c
  }

  const JOBS = []
  let jobOrder = 0, pumping = false
  function want(job) {
    job.order = jobOrder++
    JOBS.push(job)
    pump()
  }
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (JOBS.length) {
        JOBS.sort((a, b) => a.prio - b.prio || a.order - b.order)
        const job = JOBS.shift()
        if (job.stale?.()) continue
        try { job.done(await grab(el.thumbVideo, job.url, job.time, job.width)) } catch { el.thumbVideo.dataset.url = '' }
      }
    } finally { pumping = false }
  }

  let filmRaf = 0
  function drawFilm() {
    cancelAnimationFrame(filmRaf)
    filmRaf = requestAnimationFrame(drawFilmNow)
  }
  function drawFilmNow() {
    const s = P.src
    const c = el.film
    const dpr = window.devicePixelRatio || 1
    const w = el.strip.clientWidth, h = el.strip.clientHeight
    if (!w || !h) return
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#141416'
    ctx.fillRect(0, 0, w, h)
    if (!s || !s.frames || s.kind === 'image') return
    const axis = axisFrames()
    const ar = s.width && s.height ? s.width / s.height : 16 / 9
    const tileW = h * ar
    const n = Math.max(1, Math.ceil(w / tileW))
    const playableW = (w * s.frames) / axis
    ctx.save()
    ctx.beginPath(); ctx.rect(0, 0, playableW, h); ctx.clip()
    const missing = []
    for (let i = 0; i < n; i++) {
      const x = i * tileW
      if (x >= playableW) break
      const frame = Math.min(s.frames - 1, Math.floor(((x + tileW / 2) / w) * axis))
      const m = mediaFor(s, frame)
      const exact = m && THUMBS.get(`${m.url}|${m.frame}`)
      const img = exact ?? nearestThumb(s, frame)
      if (img) ctx.drawImage(img, x, 0, tileW, h)
      if (!exact && m) missing.push({ i, m })
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(x + tileW - 1, 0, 1, h)
    }
    ctx.restore()
    // Ask for the missing tiles coarse-to-fine, so the strip fills evenly.
    if (missing.length) {
      const order = bitReverseOrder(missing.length)
      const id = s.id
      for (const k of order) {
        const { m } = missing[k]
        const key = `${m.url}|${m.frame}`
        if (PENDING.has(key)) continue
        PENDING.add(key)
        want({ prio: 1, url: m.url, time: (m.frame + 0.5) / s.fps, width: Math.round(tileW * Math.min(2, dpr)), stale: () => { const stale = P.src?.id !== id; if (stale) PENDING.delete(key); return stale }, done: (canvas) => { PENDING.delete(key); putThumb(m.url, m.frame, canvas); drawFilm() } })
      }
    }
  }
  const PENDING = new Set()
  function bitReverseOrder(n) {
    const out = [], seen = new Set()
    for (let step = 1 << Math.ceil(Math.log2(Math.max(1, n))); step >= 1; step >>= 1) {
      for (let i = 0; i < n; i += step) if (!seen.has(i)) { seen.add(i); out.push(i) }
    }
    return out
  }

  const PEEK = { busy: false, want: null }
  const PEEKS = new Map() // `${url}|${frame}` → a large canvas, the last few hovered
  async function peek(job) {
    PEEK.want = job
    if (PEEK.busy) return
    PEEK.busy = true
    while (PEEK.want) {
      const j = PEEK.want
      PEEK.want = null
      try {
        const k = `${j.url}|${j.frame}`
        let c = PEEKS.get(k)
        if (!c) {
          c = await grab(el.peekVideo, j.url, (j.frame + 0.5) / j.fps, 384)
          PEEKS.set(k, c)
          if (PEEKS.size > 40) PEEKS.delete(PEEKS.keys().next().value)
        }
        if (S.hover?.key === j.key) {
          const ctx = el.previewCanvas.getContext('2d')
          ctx.drawImage(c, 0, 0, el.previewCanvas.width, el.previewCanvas.height)
        }
      } catch { el.peekVideo.dataset.url = '' }
    }
    PEEK.busy = false
  }

  const POSTERS = new Map() // `${path}@${mtime}` → dataURL
  function queuePosters() {
    for (const g of S.groups) {
      const r = g.latest
      if (r && r.kind === 'video' && r.frames) {
        const k = `${r.path}@${r.mtimeMs}`
        if (POSTERS.has(k)) continue
        POSTERS.set(k, null)
        const fps = r.fps || 30
        want({ prio: 2, url: wsUrl(r.path, r.mtimeMs), time: (Math.floor(r.frames * 0.62) + 0.5) / fps, width: 192, done: (c) => { try { POSTERS.set(k, c.toDataURL('image/jpeg', 0.82)) } catch {} renderRenders() } })
      } else if (!r && g.live) {
        const ready = readyClips(g.live)
        const last = ready[ready.length - 1]
        if (!last) continue
        const k = `${last.path}@${last.mtimeMs}`
        if (POSTERS.has(k)) continue
        POSTERS.set(k, null)
        want({ prio: 2, url: wsUrl(last.path, last.mtimeMs), time: (last.duration || 0) * 0.6, width: 192, done: (c) => { try { POSTERS.set(k, c.toDataURL('image/jpeg', 0.82)) } catch {} renderRenders() } })
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Side: outline (chapters / animations) and renders
  function renderOutline() {
    const s = P.src
    const sections = s && s.kind !== 'image' && s.sections?.length > (s.kind === 'clips' ? 0 : 1) ? s.sections : null
    const beats = s && s.kind !== 'image' && s.beats?.length > 1 ? s.beats : null
    const tabs = []
    if (sections) tabs.push({ id: 'chapters', label: 'Chapters', count: sections.length })
    if (beats) tabs.push({ id: 'animations', label: 'Animations', count: beats.length })
    S.outlineRows = []
    S.outlineKind = null
    el.outline.innerHTML = ''
    el.outlineTabs.innerHTML = ''
    const manimish = Boolean(s?.quality)
    const noChapterHint = 'No chapters in this render. Scenes that mark their beats with <code>self.next_section("…")</code> arrive chaptered — ask the agent to add them.'
    if (!tabs.length) {
      el.outlinePanel.hidden = !(s && s.kind === 'file' && manimish)
      el.outlineTabs.innerHTML = '<span class="tab on">Chapters</span>'
      el.outlineCount.textContent = ''
      el.outlineHint.hidden = false
      el.outlineHint.className = 'hint'
      el.outlineHint.innerHTML = noChapterHint
      return
    }
    el.outlinePanel.hidden = false
    el.outlineHint.hidden = !(s.kind === 'file' && manimish && !sections)
    if (!el.outlineHint.hidden) {
      el.outlineHint.className = 'hint above'
      el.outlineHint.innerHTML = noChapterHint
      el.outline.before(el.outlineHint)
    }
    const tab = tabs.find((t) => t.id === prefs.outlineTab) ?? tabs[0]
    for (const t of tabs) {
      const b = document.createElement(tabs.length > 1 ? 'button' : 'span')
      b.className = `tab ${t.id === tab.id ? 'on' : ''}`
      b.textContent = t.label
      if (tabs.length > 1) b.addEventListener('click', () => { prefs.outlineTab = t.id; savePrefs(); renderOutline() })
      el.outlineTabs.append(b)
    }
    el.outlineCount.textContent = String(tab.count)
    S.outlineKind = tab.id
    const acked = changeAcked(s)
    const ranges = acked ? [] : s.changes?.ranges ?? []
    const touched = (a, n) => ranges.some(([x, y]) => x < a + n && y > a)
    if (tab.id === 'chapters') {
      const added = new Set(acked ? [] : s.changes?.sections?.added ?? [])
      const changed = new Set(acked ? [] : s.changes?.sections?.changed ?? [])
      for (const sec of sections) {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'row'
        const tag = added.has(sec.name) ? '<span class="tag new">new</span>' : changed.has(sec.name) || (s.kind === 'clips' && touched(sec.start, sec.frames)) ? '<span class="tag">changed</span>' : ''
        b.innerHTML = `<span class="num">${sec.index + 1}</span><span class="name">${esc(chapterName(sec.name))}</span>${tag}<span class="meta">${shortTime(sec.start / s.fps)} · ${seconds(sec.frames / s.fps)}</span><span class="fill"></span>`
        b.addEventListener('click', () => goChapter(sec.index))
        li.append(b)
        el.outline.append(li)
        S.outlineRows.push(b)
      }
      if (s.kind === 'clips' && s.live?.state === 'rendering') {
        const li = document.createElement('li')
        li.innerHTML = `<div class="row beat pending-beat"><span class="num"><span class="spinner" style="border-color:rgba(127,127,127,.25);border-top-color:var(--accent)"></span></span><span class="name">Rendering${s.live.current ? ` · ${esc(s.live.current)}` : '…'}</span></div>`
        el.outline.append(li)
      }
    } else {
      let lastSec = -1
      beats.forEach((beat, i) => {
        const secI = sectionIndexAt(beat.start)
        if (sections && secI !== lastSec && secI >= 0) {
          lastSec = secI
          const h = document.createElement('li')
          h.innerHTML = `<div class="row sub" style="padding-top:8px;padding-bottom:2px;font-size:11.5px;font-weight:600">${secI + 1} · ${esc(chapterName(sections[secI].name))}</div>`
          el.outline.append(h)
        }
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.className = 'row beat'
        const tag = touched(beat.start, beat.frames) ? '<span class="tag">changed</span>' : ''
        b.innerHTML = `<span class="num">${i + 1}</span><span class="name">${esc(prettyLabel(beat.label) ?? `Animation ${i + 1}`)}</span>${tag}<span class="meta">${tcText(beat.start, s.fps)}<span class="dur-meta">${seconds(beat.frames / s.fps)}</span></span><span class="fill"></span>`
        b.addEventListener('click', () => { pause(); seek(beat.start) })
        li.append(b)
        el.outline.append(li)
        S.outlineRows.push(b)
      })
      if (s.kind === 'clips' && s.live?.state === 'rendering') {
        const li = document.createElement('li')
        li.innerHTML = `<div class="row beat pending-beat"><span class="num">${beats.length + 1}</span><span class="name">${esc(s.live.current ?? 'Rendering…')}</span><span class="meta"><span class="spinner" style="display:inline-block;vertical-align:-2px;border-color:rgba(127,127,127,.25);border-top-color:var(--accent)"></span></span></div>`
        el.outline.append(li)
      }
    }
    S.activeRow = -1
    S.uiDirty = true
  }

  function renderRenders() {
    const groups = S.groups
    el.rendersCount.textContent = groups.length ? String(groups.length) : ''
    el.rendersPanel.hidden = !groups.length
    el.renders.innerHTML = ''
    for (const g of groups) {
      const r = g.latest
      const live = g.live
      const li = document.createElement('li')
      const b = document.createElement('div')
      b.className = `row render ${g.key === S.key ? 'active' : ''}`
      b.tabIndex = 0
      b.setAttribute('role', 'button')
      const posterKey = r ? `${r.path}@${r.mtimeMs}` : (() => { const rc = readyClips(live); const last = rc[rc.length - 1]; return last ? `${last.path}@${last.mtimeMs}` : '' })()
      const poster = r?.kind === 'image' || r?.kind === 'gif' ? wsUrl(r.path, r.mtimeMs) : POSTERS.get(posterKey)
      const dur = r?.duration ? shortTime(r.duration) : ''
      let line2 = '', line2cls = ''
      if (live?.state === 'rendering') {
        line2cls = 'live'
        line2 = `Rendering · ${live.animation ? `animation ${live.animation}${live.expected ? ` of ~${live.expected}` : ''}` : 'starting'}`
      } else if (live && live.state !== 'done') {
        line2cls = 'failed'
        line2 = live.state === 'failed' ? `Failed · ${esc(live.error?.type ?? 'error')}${live.error?.line ? ` at line ${live.error.line}` : ''}` : live.state === 'stalled' ? 'Stalled' : 'Stopped'
      } else if (r) {
        const bits = []
        if (r.kind === 'video') { if (r.duration) bits.push(seconds(r.duration)); if (r.width) bits.push(`${r.width}×${r.height}`); if (r.sections?.length > 1) bits.push(plural(r.sections.length, 'chapter')); else if (r.beats?.length) bits.push(plural(r.beats.length, 'animation')) }
        else { if (r.width) bits.push(`${r.width}×${r.height}`); bits.push(r.kind === 'gif' ? 'GIF' : 'still') }
        line2 = bits.join(' · ')
      }
      const qualities = [...new Set(g.variants.filter((v) => v.complete && v.quality).map((v) => `${v.quality}${v.kind === 'gif' ? ' · GIF' : ''}`))]
      const bar = live?.state === 'rendering' ? `<div class="bar"><i style="width:${live.expected ? Math.min(100, (100 * live.animation) / live.expected) : 12}%"></i></div>` : ''
      b.innerHTML = `<div class="poster" style="${poster ? `background-image:url('${poster}')` : ''}">${dur ? `<span class="dur">${dur}</span>` : ''}${live?.state === 'rendering' ? '<span class="live-dot">LIVE</span>' : live && live.state !== 'done' ? '<span class="fail-dot">!</span>' : ''}</div>
        <div class="body"><div class="line1"><span class="name">${esc(g.title)}</span><span class="when">${agoShort(live?.state === 'rendering' ? live.updatedAtMs : g.activity)}</span></div>
        <div class="line2 ${line2cls}">${line2}</div>${bar}
        ${qualities.length ? `<div class="line3">${qualities.map((q) => `<span class="chip ${qualities.length > 1 && P.src?.key === g.key && `${P.src.quality}${P.src.render?.kind === 'gif' ? ' · GIF' : ''}` === q && P.src.kind !== 'clips' ? 'on' : ''}" data-q="${esc(q)}">${esc(q)}</span>`).join('')}</div>` : ''}</div>`
      const choose = () => {
        const newest = S.groups[0]
        S.key = g.key; S.path = null; S.view = 'auto'
        S.follow = newest?.key === g.key
        S.baseline = Math.max(S.baseline, newest?.activity ?? 0)
        update()
      }
      b.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip[data-q]')
        if (chip) {
          const v = g.variants.find((x) => `${x.quality}${x.kind === 'gif' ? ' · GIF' : ''}` === chip.dataset.q && x.complete)
          if (v) { S.key = g.key; S.path = v.path; S.view = 'file'; S.follow = false; S.baseline = Math.max(S.baseline, S.groups[0]?.activity ?? 0); update(); return }
        }
        choose()
      })
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter') choose() })
      li.append(b)
      el.renders.append(li)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Stage overlays
  function renderStage() {
    const s = P.src
    const g = currentGroup()
    const live = g?.live
    // LIVE badge
    if (s?.kind === 'clips') {
      el.liveBadge.hidden = false
      const rendering = s.live?.state === 'rendering'
      el.liveBadge.className = `badge ${rendering ? 'live' : ''}`
      el.liveBadge.innerHTML = rendering ? '<span class="rec"></span>LIVE' : 'PARTIAL'
    } else el.liveBadge.hidden = true
    // Progress bar
    if (live?.state === 'rendering') {
      el.renderProgress.hidden = false
      const determinate = live.expected && live.animation
      el.renderProgress.classList.toggle('indeterminate', !determinate)
      el.renderProgress.firstElementChild.style.width = determinate ? `${Math.min(100, (100 * live.animation) / live.expected)}%` : ''
    } else el.renderProgress.hidden = true
    renderEdge()
    renderNotice()
    renderEmpty()
    el.bMute.hidden = !s?.audio
    setIcon(el.bMute, V.muted ? 'volumeOff' : 'volumeOn')
  }
  function renderEdge() {
    const s = P.src
    if (P.waiting && s?.kind === 'clips' && s.live?.state === 'rendering') {
      el.edge.hidden = false
      el.edgeText.textContent = `Rendering animation ${s.clips.length + 1}${s.live.current ? ` · ${s.live.current}` : ''}…`
    } else el.edge.hidden = true
  }

  function renderAll() {
    renderHeader()
    renderStage()
    renderTimeline()
    renderOutline()
    renderRenders()
    updatePlayButton()
  }

  function update() {
    if (!S.lib) return
    S.groups = groupsOf(S.lib)
    apply(decide())
    renderAll()
    queuePosters()
  }

  // ---------------------------------------------------------------------------------------------
  // Per-frame UI
  let flashChapterTimer = null
  function flashChapterAt(frame, force) {
    const s = P.src
    const i = sectionIndexAt(frame)
    if (i < 0 || !s.sections || s.sections.length < 2) return
    if (!force && i === S.lastSection) return
    el.chapterFlash.innerHTML = `<b>${i + 1}</b>${esc(chapterName(s.sections[i].name))}`
    el.chapterFlash.classList.add('on')
    clearTimeout(flashChapterTimer)
    flashChapterTimer = setTimeout(() => el.chapterFlash.classList.remove('on'), 1800)
  }

  let sessFrameAt = 0
  function tick() {
    requestAnimationFrame(tick)
    const s = P.src
    if (!s || s.kind === 'image' || !s.frames) return
    const f = frameNow()
    const r = activeRange()
    if (r && prefs.loop && !V.paused && !S.scrub && f > r.out) seek(r.in)
    if (f === S.lastFrame && !S.uiDirty) return
    S.uiDirty = false
    S.lastFrame = f
    const axis = axisFrames()
    el.playhead.style.left = `${((f + 0.5) / axis) * 100}%`
    const t = timecode(f, s.fps)
    const endT = timecode(Math.max(0, s.frames - 1), s.fps)
    if (prefs.tcMode === 1) {
      el.tcNow.textContent = `${(f / s.fps).toFixed(2)} s`
      el.tcDur.textContent = `${(s.frames / s.fps).toFixed(2)} s`
    } else if (prefs.tcMode === 2) {
      el.tcNow.textContent = `${f}`
      el.tcDur.textContent = `${s.frames - 1}`
    } else {
      el.tcNow.innerHTML = `${t.main}<i>:${t.ff}</i>`
      el.tcDur.textContent = `${endT.main}:${endT.ff}`
    }
    el.tcFrame.textContent = prefs.tcMode === 2 ? `${s.fps} fps` : `f ${f}`
    // Active chapter
    const secI = sectionIndexAt(f)
    if (secI !== S.lastSection) {
      if (S.lastSection >= -1 && secI >= 0 && isPlaying()) flashChapterAt(f, true)
      S.lastSection = secI
      ;(S.chapterEls ?? []).forEach((c, i) => c.classList.toggle('active', i === secI))
    }
    // Active outline row, with the fill of progress through it
    const rowI = S.outlineKind === 'chapters' ? secI : S.outlineKind === 'animations' ? beatIndexAt(f) : -1
    if (rowI !== S.activeRow) {
      const prev = S.outlineRows?.[S.activeRow]
      if (prev) { prev.classList.remove('active'); prev.querySelector('.fill').style.width = '0' }
      S.activeRow = rowI
      const row = S.outlineRows?.[rowI]
      if (row) { row.classList.add('active'); if (!S.scrub) row.scrollIntoView({ block: 'nearest' }) }
    }
    const row = S.outlineRows?.[rowI]
    if (row) {
      const unit = S.outlineKind === 'chapters' ? s.sections[rowI] : s.beats[rowI]
      if (unit) row.querySelector('.fill').style.width = `${clamp(((f - unit.start + 1) / Math.max(1, unit.frames)) * 100, 0, 100)}%`
    }
    const now = performance.now()
    if (now - sessFrameAt > 1000) { sessFrameAt = now; sess.frames[s.key] = f; sess.paused = !isPlaying(); saveSess() }
  }

  // ---------------------------------------------------------------------------------------------
  // Navigation
  function goChapter(i) {
    const secs = P.src?.sections
    if (!secs?.[i]) return
    seek(secs[i].start)
    flashChapterAt(secs[i].start, true)
  }
  function chapterStep(dir) {
    const s = P.src
    if (!s) return
    const units = s.sections?.length > 1 ? s.sections : s.beats?.length > 1 ? s.beats : null
    const f = frameNow()
    if (!units) { seek(dir < 0 ? 0 : s.frames - 1); return }
    let i = units.length - 1
    while (i > 0 && f < units[i].start) i--
    if (dir < 0) {
      const target = f - units[i].start > Math.max(2, s.fps * 0.5) || i === 0 ? units[i].start : units[i - 1].start
      seek(target)
    } else if (i < units.length - 1) seek(units[i + 1].start)
    else seek(s.frames - 1)
    if (units === s.sections) flashChapterAt(Math.min(frameNow(), s.frames - 1), true)
  }
  function beatStep(dir) {
    const s = P.src
    if (!s?.beats?.length) { step(dir); return }
    pause()
    const f = frameNow()
    let i = beatIndexAt(f)
    if (dir < 0) seek(f > s.beats[i].start ? s.beats[i].start : s.beats[Math.max(0, i - 1)].start)
    else seek(i < s.beats.length - 1 ? s.beats[i + 1].start : s.frames - 1)
  }
  function nextChange() {
    const s = P.src
    const ranges = s?.changes?.ranges
    if (!ranges?.length) return
    const f = frameNow()
    const next = ranges.find(([a]) => a > f) ?? ranges[0]
    pause(); seek(next[0]); flashChapterAt(next[0], true)
  }
  function renderStep(dir) {
    const i = S.groups.findIndex((g) => g.key === S.key)
    const g = S.groups[clamp(i + dir, 0, S.groups.length - 1)]
    if (!g || g.key === S.key) return
    S.key = g.key; S.path = null; S.view = 'auto'; S.follow = S.groups[0]?.key === g.key
    S.baseline = Math.max(S.baseline, S.groups[0]?.activity ?? 0)
    update()
  }
  function followLatest() {
    S.follow = true; S.baseline = 0; S.path = null; S.view = 'auto'
    update()
  }

  // ---------------------------------------------------------------------------------------------
  // Stills
  async function frameBlob() {
    const s = P.src
    if (!s) return null
    const c = document.createElement('canvas')
    if (s.kind === 'image') {
      c.width = el.still.naturalWidth; c.height = el.still.naturalHeight
      c.getContext('2d').drawImage(el.still, 0, 0)
    } else {
      if (V.seeking) await once(V, ['seeked', 'error'], 3000).catch(() => {})
      c.width = V.videoWidth; c.height = V.videoHeight
      c.getContext('2d').drawImage(V, 0, 0)
    }
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'))
  }
  const stillName = () => {
    const s = P.src
    return `${s.title}${s.quality ? '-' + s.quality : ''}${s.kind === 'image' ? '' : '-f' + pad(frameNow(), 4)}`
  }
  async function copyFrame() {
    closeMenus()
    if (!P.src) return
    const f = frameNow()
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no clipboard')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': frameBlob() })])
      toast(`<b>Frame ${f} copied</b> <span>· PNG, ${V.videoWidth || el.still.naturalWidth}×${V.videoHeight || el.still.naturalHeight}</span>`, { kind: 'ok', timeout: 3500 })
    } catch {
      await saveFrame('The clipboard is not available here — saved instead.')
    }
  }
  async function saveFrame(prefix) {
    closeMenus()
    if (!P.src) return
    try {
      const blob = await frameBlob()
      const res = await fetch(`/api/still?name=${encodeURIComponent(stillName())}`, { method: 'POST', body: blob, headers: { 'content-type': 'image/png', 'x-video-viewer': 'still' } })
      if (!res.ok) throw new Error(await res.text())
      const { path } = await res.json()
      toast(`<b>${prefix ? esc(prefix) : 'Frame saved'}</b> <span>· ${esc(path)}</span>`, {
        kind: 'ok', timeout: 8000,
        actions: [{ label: 'Copy path', fn: () => { navigator.clipboard?.writeText(path).catch(() => {}); hideToast() } }],
      })
    } catch (error) {
      toast(`<b>Could not save the frame</b> <span>· ${esc(error.message)}</span>`, { timeout: 6000 })
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Controls
  function closeMenus() { el.frameMenu.hidden = true; document.querySelectorAll('.menu.speed-menu').forEach((m) => m.remove()) }
  function toggleHelp(show = el.help.hidden) { el.help.hidden = !show }
  function toggleFullscreen() {
    const fsEl = document.fullscreenElement ?? document.webkitFullscreenElement
    if (fsEl) { (document.exitFullscreen ?? document.webkitExitFullscreen).call(document); return }
    if (el.app.classList.contains('theater')) { el.app.classList.remove('theater'); fullIcon(); drawFilm(); return }
    const req = el.player.requestFullscreen ?? el.player.webkitRequestFullscreen
    const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled
    if (req && enabled) {
      Promise.resolve(req.call(el.player)).catch(() => { el.app.classList.add('theater'); fullIcon(); drawFilm() })
    } else {
      // A pane inside Harness usually cannot go fullscreen: fill the pane instead.
      el.app.classList.add('theater'); fullIcon(); drawFilm()
    }
  }
  const fullIcon = () => setIcon(el.bFull, document.fullscreenElement || el.app.classList.contains('theater') ? 'collapse' : 'expand')
  document.addEventListener('fullscreenchange', () => { fullIcon(); drawFilm(); S.uiDirty = true })

  el.bPlay.addEventListener('click', togglePlay)
  el.bBack.addEventListener('click', () => step(-1))
  el.bFwd.addEventListener('click', () => step(1))
  el.bPrev.addEventListener('click', () => chapterStep(-1))
  el.bNext.addEventListener('click', () => chapterStep(1))
  el.bIn.addEventListener('click', () => setIn())
  el.bOut.addEventListener('click', () => setOut())
  el.bLoop.addEventListener('click', () => { prefs.loop = !prefs.loop; savePrefs(); renderLoopBand() })
  el.bMute.addEventListener('click', () => { V.muted = !V.muted; renderStage() })
  el.bFull.addEventListener('click', toggleFullscreen)
  el.bHelp.addEventListener('click', () => toggleHelp())
  el.helpClose.addEventListener('click', () => toggleHelp(false))
  el.help.addEventListener('click', (e) => { if (e.target === el.help) toggleHelp(false) })
  el.follow.addEventListener('click', () => {
    const elsewhere = S.groups.find((x) => x.key !== S.key && x.live?.state === 'rendering')
    if (elsewhere) { S.key = elsewhere.key; S.path = null; S.view = 'auto'; S.follow = true; S.baseline = Math.max(S.baseline, S.groups[0]?.activity ?? 0); update() } else followLatest()
  })
  el.timecode.addEventListener('click', () => { prefs.tcMode = (prefs.tcMode + 1) % 3; savePrefs(); S.uiDirty = true })
  el.bFrame.addEventListener('click', (e) => { e.stopPropagation(); const open = el.frameMenu.hidden; closeMenus(); el.frameMenu.hidden = !open })
  el.frameMenu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act
    if (act === 'copy') copyFrame()
    if (act === 'save') saveFrame()
  })
  el.bSpeed.addEventListener('click', (e) => {
    e.stopPropagation()
    const existing = document.querySelector('.menu.speed-menu')
    closeMenus()
    if (existing) return
    const menu = document.createElement('div')
    menu.className = 'menu speed-menu'
    menu.style.minWidth = '110px'
    for (const x of [...SPEEDS].reverse()) {
      const b = document.createElement('button')
      b.className = `speed-opt ${x === prefs.speed && !P.reverse ? 'on' : ''}`
      b.textContent = `${x}×`
      b.addEventListener('click', () => { stopReverse(); setSpeed(x); closeMenus() })
      menu.append(b)
    }
    el.bSpeed.parentElement.append(menu)
  })
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('#b-frame') && !e.target.closest('#b-speed')) closeMenus() })

  let clickTimer = null
  el.stage.addEventListener('click', (e) => {
    if (e.target.closest('.notice, .toast, .empty, .edge')) return
    if (!P.src || P.src.kind === 'image') return
    clearTimeout(clickTimer)
    clickTimer = setTimeout(togglePlay, 180)
  })
  el.stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.notice, .toast')) return
    clearTimeout(clickTimer)
    toggleFullscreen()
  })

  function setIn() { if (!P.src) return; S.range.in = frameNow(); if (S.range.out != null && S.range.out < S.range.in) S.range.out = null; renderLoopBand(); drawFilm() }
  function setOut() { if (!P.src) return; S.range.out = frameNow(); if (S.range.in != null && S.range.in > S.range.out) S.range.in = null; renderLoopBand() }
  function clearRange() { S.range = { in: null, out: null }; renderLoopBand() }

  const held = { k: false }
  document.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'k') held.k = false })
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key
    const lower = key.length === 1 ? key.toLowerCase() : key
    const s = P.src
    let handled = true
    if (!el.help.hidden && key !== '?' && key !== 'Escape') return
    switch (lower) {
      case ' ': if (!e.repeat) togglePlay(); break
      case 'k': held.k = true; if (!e.repeat) { if (isPlaying()) pause(); flashIcon('pause') } break
      case 'j': if (held.k) step(-1); else if (!e.repeat) shuttle(-1); break
      case 'l': if (held.k) step(1); else if (!e.repeat) shuttle(1); break
      case 'ArrowLeft': step(e.shiftKey ? -Math.round(s?.fps || 30) : -1); break
      case 'ArrowRight': step(e.shiftKey ? Math.round(s?.fps || 30) : 1); break
      case ',': step(-1); break
      case '.': step(1); break
      case '<': setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(prefs.speed) - 1)] ?? 1); break
      case '>': setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(prefs.speed) + 1)] ?? 1); break
      case 'ArrowUp': if (e.shiftKey) renderStep(-1); else { pause(); chapterStep(-1) } break
      case 'ArrowDown': if (e.shiftKey) renderStep(1); else { pause(); chapterStep(1) } break
      case '[': beatStep(-1); break
      case ']': beatStep(1); break
      case 'Home': pause(); seek(0); break
      case 'End': pause(); seek((s?.frames ?? 1) - 1); break
      case 'i': setIn(); break
      case 'o': setOut(); break
      case 'x': clearRange(); break
      case '\\': prefs.loop = !prefs.loop; savePrefs(); renderLoopBand(); break
      case '-': case '_': setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(prefs.speed) - 1)] ?? 1); break
      case '=': case '+': setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(prefs.speed) + 1)] ?? 1); break
      case 'c': copyFrame(); break
      case 's': saveFrame(); break
      case 'f': toggleFullscreen(); break
      case 'n': followLatest(); break
      case 'g': nextChange(); break
      case 'm': V.muted = !V.muted; renderStage(); break
      case '?': toggleHelp(); break
      case 'Escape':
        if (!el.help.hidden) toggleHelp(false)
        else if (!el.frameMenu.hidden || document.querySelector('.speed-menu')) closeMenus()
        else if (el.app.classList.contains('theater')) toggleFullscreen()
        else if (!el.toast.hidden) hideToast()
        else handled = false
        break
      default:
        if (/^[1-9]$/.test(key) && s?.sections?.length > 1) { pause(); goChapter(Number(key) - 1) } else handled = false
    }
    if (handled) e.preventDefault()
  })

  new ResizeObserver(() => { drawFilm(); renderTimeline() }).observe(el.strip)
  setInterval(() => { if (S.lib) { renderHeader(); renderRenders() } }, 15_000)
  window.addEventListener('pagehide', () => { if (P.src) { sess.frames[P.src.key] = frameNow(); sess.paused = !isPlaying(); writeStore(sessionStorage, `${storeKey}:session`, sess) } })

  // ---------------------------------------------------------------------------------------------
  // Go
  hydrate()
  showSpeed()
  requestAnimationFrame(tick)
  const events = new EventSource('/events')
  events.addEventListener('library', (e) => { try { onLibrary(JSON.parse(e.data)) } catch (error) { console.error(error) } })
  // Tests and the curious: the page's state, read-only.
  window.__viewer = { S, P, prefs, sess, frameNow }
})()
