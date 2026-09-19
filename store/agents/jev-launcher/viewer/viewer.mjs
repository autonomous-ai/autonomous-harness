// Jev Launcher viewer — a loopback server behind a live command palette. On every keystroke Jev
// (TypeSafe's System One model) reads the palette and the query and answers three typed questions
// in one call: which target to launch (a probability for every target), which category the person
// is after, and whether the query is clear enough to launch now.
//
// Two typists feed it. A person types in the pane. When nobody has typed for `idleMs`, a ghost
// typist takes over: it picks a target it "wants", types one of that target's handles a letter at a
// time, and launches whatever Jev ranks first. Because the ghost's intent is known, the pane can
// score Jev honestly: top-1 accuracy, and how many letters it took.
//
// The honest dials are about what Jev gets to read, never about Jev: `typos` (fumbled letters),
// `chars` (how few letters are typed before launching) and `lookalikes` (near-duplicate targets).
// The palette is made up and nothing is ever really launched.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds launcher.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { launcherMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC = new Set(['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export const DEFAULT_LAUNCHER = {
  title: 'The Developer’s Deck',
  description: 'A command palette for a developer’s everyday launch targets.',
  prompt: 'You are Jev, a fast launcher oracle. Pick the ONE launch target the user most likely wants, and be decisive at every keystroke.',
  typos: 0.06,       // chance that the ghost typist fumbles a letter (0..1)
  chars: 8,          // the ghost typist launches after at most this many letters (1..12)
  lookalikes: 0,     // how many targets get a near-duplicate twin with the same aliases (0..6)
  stepMs: 110,       // ghost typist pace, ms per keystroke (40..2000)
  idleMs: 15000,     // the ghost typist comes back after this long without a human key
  seed: 2024,
  targets: [
    { name: 'Run tests', category: 'Dev', aliases: ['test', 'pytest', 'spec'], featured: true },
    { name: 'Open Editor', category: 'Apps', aliases: ['code', 'vscode', 'ide'], featured: true },
    { name: 'Browser', category: 'Apps', aliases: ['chrome', 'web', 'internet'] },
    { name: 'Terminal', category: 'Apps', aliases: ['shell', 'console', 'zsh', 'bash'] },
    { name: 'Deploy to prod', category: 'Ops', aliases: ['ship', 'release', 'deploy'] },
    { name: 'Team chat', category: 'Comm', aliases: ['slack', 'discord', 'dm'] },
  ],
}

// Deterministic PRNG so the ghost typist's choices and fumbles are reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const word = (v, max) => String(v ?? '').replace(/[\[\]"\n\r—]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const TWIN = ['(staging)', '(beta)', '(old)', '(copy)', '(v2)', '(legacy)']

/** Keep a wild config from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const seen = new Set()
  const targets = []
  for (const t of Array.isArray(raw.targets) ? raw.targets.slice(0, 30) : []) {
    const name = word(t?.name, 40)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    targets.push({ name, category: word(t.category, 16) || 'Misc', aliases: (Array.isArray(t.aliases) ? t.aliases : []).slice(0, 10).map((a) => word(a, 24).replace(/,/g, ' ')).filter(Boolean), featured: !!t.featured })
  }
  return {
    title: word(raw.title ?? DEFAULT_LAUNCHER.title, 80) || DEFAULT_LAUNCHER.title,
    description: String(raw.description ?? DEFAULT_LAUNCHER.description).slice(0, 300),
    prompt: String(raw.prompt ?? DEFAULT_LAUNCHER.prompt).replace(/\s+/g, ' ').slice(0, 600),
    typos: clampN(raw.typos, 0, 1, DEFAULT_LAUNCHER.typos),
    chars: Math.round(clampN(raw.chars, 1, 12, DEFAULT_LAUNCHER.chars)),
    lookalikes: Math.round(clampN(raw.lookalikes, 0, 6, DEFAULT_LAUNCHER.lookalikes)),
    stepMs: Math.round(clampN(raw.stepMs, 40, 2000, DEFAULT_LAUNCHER.stepMs)),
    idleMs: Math.round(clampN(raw.idleMs, 1000, 120000, DEFAULT_LAUNCHER.idleMs)),
    seed: Math.round(clampN(raw.seed, 0, 1e9, DEFAULT_LAUNCHER.seed)),
    targets: targets.length >= 2 ? targets : DEFAULT_LAUNCHER.targets.map((t) => ({ ...t })),
  }
}

/** The palette Jev actually faces: the config's targets, plus a twin for the first `n` of them. */
function withLookalikes(targets, n) {
  const out = []
  targets.forEach((t, i) => {
    out.push(t)
    if (i < n) out.push({ name: `${t.name} ${TWIN[i % TWIN.length]}`, category: t.category, aliases: t.aliases, featured: false, twin: true })
  })
  return out
}

function stateBlock(l, targets, query) {
  const rows = targets.map((t, i) =>
    `${i + 1}. ${t.name} [${t.category || '—'}]${t.featured ? ' (featured)' : ''} aliases: ${(t.aliases || []).join(', ')} — launch`
  ).join('\n')
  const q = (query || '').trim()
  return `${l.prompt || 'You are a fast, decisive launch-oracle.'}
A launch palette — each numbered target, its category, and its aliases:

${rows}

Current query: "${q}"
${q ? `Pick the ONE target that best matches "${q}". Be decisive, even on a noisy or partial match.` : 'Nothing is typed yet. Rank the targets by which one is most useful to surface first.'}`
}

// A slip lands on a key next to the one that was meant.
const NEAR = { q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol', a: 'qsz', s: 'adw', d: 'sfe', f: 'dgr', g: 'fht', h: 'gjy', j: 'hku', k: 'jli', l: 'kop', z: 'asx', x: 'zcd', c: 'xvf', v: 'cbg', b: 'vnh', n: 'bmj', m: 'nk' }

/** Type `text` the way a hurried person does: each letter is fumbled with chance `typos`. */
function fumble(text, typos, rng) {
  const out = []
  const src = [...text]
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === ' ' || rng() >= typos) { out.push(c); continue }
    const kind = rng()
    if (kind < 0.34 && i + 1 < src.length && src[i + 1] !== ' ') { out.push(src[i + 1], c); i++ }   // swapped with the next letter
    else if (kind < 0.6) { /* dropped */ }
    else { const near = NEAR[c]; out.push(near ? near[Math.floor(rng() * near.length)] : c) }       // the key next to it
  }
  return out.join('')
}

export async function startLauncherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const markerFile = join(workspace, 'launcher.json')

  // Every binding is declared before anything can call into the closures below.
  let raw = {}
  let cfgError = null
  let overrides = {}
  let error = null
  let stopped = false, running = false
  let timer = null, watchTimer = null, lastVerdictAt = 0
  let salt = 1, seq = 0
  let mode = 'demo'            // 'demo' = the ghost typist is driving, 'human' = a person is
  let humanAt = 0, pendingHuman = null
  let query = ''
  let targets = []             // what Jev faces (config targets plus look-alike twins)
  let mind = { top: null, confidence: 0, ready: 0, probs: {}, category: null, categories: {}, latencyMs: 0, client: 'mock', by: 'demo' }
  let history = []             // one entry per ranking
  let launches = []            // launch log
  let lastJudge = null         // one judgement per ranking, so a click then Enter is not counted twice
  let rng = mulberry32(1)
  let demo = { intent: null, planned: '', typed: 0, phase: 'next', wait: 0, order: [], right: [], round: 0 }
  let stats = null
  let chain = Promise.resolve()
  let epoch = 0                // goes up whenever the palette or the tallies start over, so the pane starts over too
  const clients = new Set()

  const freshStats = () => ({ keystrokes: 0, launches: 0, demo: { launched: 0, right: 0, keysSum: 0, keysN: 0 }, human: { judged: 0, right: 0 }, byLen: Array.from({ length: 12 }, () => ({ n: 0, right: 0 })) })
  const cfg = () => sanitize({ ...raw, ...overrides })

  function load() {
    try { raw = JSON.parse(readFileSync(markerFile, 'utf8')); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('launcher.json must be a JSON object'); cfgError = null; return true }
    catch (e) { cfgError = existsSync(markerFile) ? clean(`launcher.json: ${e.message}`) : null; return false }
  }

  function rebuild() {
    const c = cfg()
    targets = withLookalikes(c.targets, c.lookalikes)
    rng = mulberry32(c.seed)
    demo = { intent: null, planned: '', typed: 0, phase: 'next', wait: 0, order: [], right: [], round: 0 }
    history = []   // columns of the tape point at targets by position, so an old tape would lie
    epoch++
  }

  /** Ask Jev to rank the palette for `text`. One call, three typed questions. */
  async function rank(text, by) {
    const c = cfg()
    query = String(text ?? '').replace(/["\n\r]/g, ' ').slice(0, 64)
    const cats = [...new Set(targets.map((t) => t.category))]
    try {
      const res = await evaluate({
        state: stateBlock(c, targets, query),
        questions: {
          pick: jev.choice(Object.fromEntries(targets.map((t) => [t.name, `${t.category}. Also typed as: ${t.aliases.join(', ') || t.name}`])), 'Which launch target is the best match for this query?'),
          category: jev.choice(Object.fromEntries(cats.map((k) => [k, `targets in the ${k} group`])), 'Which group of targets is the person after?'),
          ready: jev.noul('Is the query clear enough to launch the top target right now?'),
        },
        salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: launcherMock,
      })
      const pick = res.answers.pick ?? {}
      const probs = {}
      for (const t of targets) probs[t.name] = Number(pick.probabilities?.[t.name] ?? 0)
      const top = pick.choice && pick.choice in probs ? String(pick.choice) : targets[0].name
      mind = {
        top, confidence: Number(pick.confidence ?? probs[top] ?? 0), ready: Number(res.answers.ready?.noul ?? 0.5), probs,
        category: res.answers.category?.choice ?? null, categories: res.answers.category?.probabilities ?? {},
        latencyMs: res.latencyMs, client: res.client, by,
      }
      seq++
      if (query) stats.keystrokes++
      const segs = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, p]) => [targets.findIndex((t) => t.name === name), Math.round(p * 1000) / 1000])
      const intent = by === 'demo' ? demo.intent : null
      history.push({ seq, query, top, conf: mind.confidence, ready: mind.ready, by, intent, ok: intent ? top === intent : null, segs })
      if (history.length > 200) history.splice(0, history.length - 200)
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
  }

  function logLaunch(entry) {
    stats.launches++
    launches.push({ n: stats.launches, at: Date.now(), ...entry })
    if (launches.length > 40) launches.shift()
    const h = history[history.length - 1]
    if (h) h.launch = entry.ok ? 1 : 0 // the tape marks the ranking that was launched
  }

  /** One judgement per ranking: was Jev's first row the right answer? */
  function judge(name) {
    if (lastJudge && lastJudge.seq === seq) { stats.human.judged--; if (lastJudge.ok) stats.human.right-- }
    const ok = name === mind.top
    stats.human.judged++; if (ok) stats.human.right++
    const place = Object.entries(mind.probs).sort((a, b) => b[1] - a[1]).findIndex(([n]) => n === name) + 1
    lastJudge = { seq, ok, name, place, query }
    return lastJudge
  }

  /** One step of the ghost typist. Most steps are one keystroke, so one Jev call. */
  async function demoStep() {
    const c = cfg()
    if (demo.phase === 'next') {
      if (!demo.order.length) {
        demo.order = targets.map((t) => t.name)
        for (let i = demo.order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [demo.order[i], demo.order[j]] = [demo.order[j], demo.order[i]] }
        demo.round++
      }
      const name = demo.order.pop()
      const t = targets.find((x) => x.name === name) ?? targets[0]
      const handles = [t.name, ...t.aliases].map((h) => h.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()).filter(Boolean)
      const handle = handles[Math.floor(rng() * handles.length)] || t.name.toLowerCase()
      const planned = fumble(handle.slice(0, c.chars).trim(), c.typos, rng) || handle.slice(0, 1)
      demo = { ...demo, intent: t.name, handle, planned, typed: 0, phase: 'typing', right: [] }
    }
    if (demo.phase === 'typing') {
      demo.typed++
      await rank(demo.planned.slice(0, demo.typed), 'demo')
      const ok = mind.top === demo.intent
      demo.right.push(ok)
      const slot = stats.byLen[Math.min(demo.typed, stats.byLen.length) - 1]
      slot.n++; if (ok) slot.right++
      if (demo.typed >= demo.planned.length) { demo.phase = 'hold'; demo.wait = Math.max(2, Math.round(440 / c.stepMs)) }
      return
    }
    if (demo.phase === 'hold') {
      if (--demo.wait > 0) return
      const ok = mind.top === demo.intent
      stats.demo.launched++
      if (ok) {
        stats.demo.right++
        // How many letters it took until the wanted target was first and stayed first.
        let k = demo.right.length
        while (k > 0 && demo.right[k - 1]) k--
        stats.demo.keysSum += k + 1; stats.demo.keysN++
      }
      logLaunch({ name: mind.top, by: 'demo', ok, intent: demo.intent, query })
      demo.phase = 'next'
      await rank('', 'demo')
    }
  }

  function frame() {
    const c = cfg()
    const judged = stats.demo.launched + stats.human.judged
    return {
      type: 'rank', epoch, title: c.title, description: c.description,
      mode, running, query, seq, rankings: seq,
      targets: targets.map((t) => ({ name: t.name, category: t.category, aliases: t.aliases, featured: !!t.featured, twin: !!t.twin })),
      rank: mind.probs, mind: { top: mind.top, confidence: mind.confidence, ready: mind.ready, category: mind.category, categories: mind.categories, latencyMs: mind.latencyMs, client: mind.client, by: mind.by },
      demo: { intent: mode === 'demo' ? demo.intent : null, handle: demo.handle ?? '', planned: demo.planned, typed: demo.typed, phase: demo.phase },
      stats: { ...stats, judged, right: stats.demo.right + stats.human.right, accuracy: judged ? (stats.demo.right + stats.human.right) / judged : null, keysToTop1: stats.demo.keysN ? stats.demo.keysSum / stats.demo.keysN : null },
      judge: lastJudge && lastJudge.seq === seq ? lastJudge : null,
      launches: launches.slice(-10), history: history.slice(-48),
      dials: { typos: c.typos, chars: c.chars, lookalikes: c.lookalikes, stepMs: c.stepMs, idleMs: c.idleMs },
      overrides, error, cfgError,
    }
  }

  function verdict() {
    const c = cfg()
    const f = frame()
    const problem = cfgError || error
    const acc = f.stats.accuracy == null ? '—' : `${Math.round(f.stats.accuracy * 100)}%`
    const v = {
      spec: 1,
      ready: seq > 0,
      summary: problem
        ? `Jev Launcher needs a fix: ${problem}`
        : `${c.title} · ${seq} rankings · first row right on ${acc} of ${f.stats.judged} launches · ${targets.length} targets, typos ${c.typos.toFixed(2)}, ${c.chars} letters`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'launcher', message: problem }] : []),
        ...(f.stats.judged >= 20 && f.stats.accuracy < 0.5 ? [{ severity: 'warning', kind: 'launcher', message: `The first row is right only ${acc} of the time. Queries are too short or too noisy, or targets share the same aliases.` }] : []),
        ...launches.filter((l) => l.ok === false).slice(-4).map((l) => ({ severity: 'info', kind: 'miss', message: `"${l.query}" launched ${l.name}, wanted ${l.intent}` })),
        { severity: 'info', kind: 'run', message: `${stats.keystrokes} keystrokes ranked, ${stats.launches} launches on paper, last query "${query}" → ${mind.top ?? '—'} (${Math.round(mind.confidence * 100)}%)` },
      ],
      artifact: 'launcher.json',
      phases: [
        { id: 'palette', name: 'Palette loaded', state: 'done' },
        { id: 'live', name: 'Live ranking', state: seq > 0 ? 'active' : 'pending' },
        { id: 'judged', name: 'Launches judged', state: f.stats.judged > 0 ? 'done' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  /** Everything that touches the palette runs one after another, in arrival order. */
  function enqueue(job) {
    const p = chain.then(() => (stopped ? null : job()))
    chain = p.catch((e) => { error = clean(e?.message ?? String(e)) })
    return p
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().stepMs) }
  async function run() {
    const t0 = Date.now()
    let acted = false
    await enqueue(async () => {
      if (mode === 'human' && Date.now() - humanAt >= cfg().idleMs) { mode = 'demo'; demo.phase = 'next'; demo.intent = null }
      if (mode === 'demo') { await demoStep(); acted = true }
    })
    if (acted) push()
    if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().stepMs - (Date.now() - t0)))
  }

  function takeOver() { mode = 'human'; humanAt = Date.now(); demo.intent = null }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'demo') { await enqueue(async () => { mode = 'demo'; demo.phase = 'next'; demo.intent = null; if (!running) { running = true; schedule() } }) }
    else if (cmd === 'touch') { await enqueue(async () => { takeOver() }) }
    else if (cmd === 'query') {
      // A person typed. The newest text wins if several keystrokes are waiting.
      pendingHuman = String(body.query ?? body.text ?? '')
      humanAt = Date.now()
      await enqueue(async () => { if (pendingHuman == null) return; const t = pendingHuman; pendingHuman = null; takeOver(); await rank(t, 'you') })
    }
    else if (cmd === 'launch') {
      await enqueue(async () => {
        takeOver()
        const name = targets.some((t) => t.name === body.name) ? body.name : mind.top
        if (!name) return
        const j = judge(name)
        logLaunch({ name, by: 'you', ok: j.ok, intent: name, query, place: j.place })
        await rank('', 'you')
      })
    }
    else if (cmd === 'mark') {
      await enqueue(async () => { if (targets.some((t) => t.name === body.name)) { takeOver(); judge(body.name) } })
    }
    else if (cmd === 'tick') {
      const n = Math.round(clampN(body.n, 1, 20000, 1))
      await enqueue(async () => { if (mode !== 'demo') { mode = 'demo'; demo.phase = 'next'; demo.intent = null } for (let i = 0; i < n && !stopped; i++) await demoStep() })
    }
    else if (cmd === 'set') {
      const allowed = { typos: [0, 1], chars: [1, 12], lookalikes: [0, 6], stepMs: [40, 2000], idleMs: [1000, 120000] }
      const range = allowed[body.key]
      if (range) await enqueue(async () => {
        overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], cfg()[body.key]) }
        if (body.key === 'lookalikes') { const was = mode; rebuild(); mode = was; await rank(mode === 'human' ? query : '', mode === 'human' ? 'you' : 'demo') }
      })
      if (running) schedule()
    }
    else if (cmd === 'reset') {
      await enqueue(async () => { overrides = {}; stats = freshStats(); history = []; launches = []; lastJudge = null; seq = 0; salt = 1; mode = 'demo'; rebuild(); await rank('', 'demo') })
      if (running) schedule()
    }
    push(true)
    return { frame: frame() }
  }

  let watcher = null
  try {
    watcher = watch(workspace, (_, name) => {
      if (name && String(name) !== 'launcher.json') return
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        // A good edit takes over from any slider. A bad edit keeps the last good palette running.
        if (load()) enqueue(async () => { overrides = {}; const was = mode; rebuild(); mode = was; await rank(mode === 'human' ? query : '', mode === 'human' ? 'you' : 'demo') }).then(() => push(true))
        else push(true)
      }, 40)
    })
  } catch { /* the defaults stand */ }

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    try {
      if (req.method === 'GET') {
        const name = path === '/' ? 'index.html' : path.slice(1)
        if (STATIC.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' }); return res.end(readFileSync(join(HERE, name))) }
        if (path === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(frame())) }
        if (path === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (path === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(frame())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && path === '/control') {
        let text = ''
        for await (const c of req) { text += c; if (text.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let body
        try { body = JSON.parse(text || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(body.cmd ?? ''), body)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...reply }))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  stats = freshStats()
  load()
  rebuild()
  await rank('', 'demo')
  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false; clearTimeout(timer); clearTimeout(watchTimer); watcher?.close()
      await chain.catch(() => {})
      for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startLauncherViewer({ workspace, port })
  console.log(`Jev Launcher listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
