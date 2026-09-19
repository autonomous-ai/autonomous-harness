// Jev Launcher viewer — a loopback server powering a live predictive command palette. The agent
// types into the palette; on every keystroke Jev (TypeSafe's System One model) ranks the launch
// targets and returns which one it would fire, with a confidence. The pane shows the running
// re-ranking live — the top target flips as the query narrows. Launching a target is the agent's
// choice and always on paper.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds launcher.json (watched
// live); the agent edits its targets/catalog and Jev adapts immediately.

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT_LAUNCHER = {
  title: 'The Developer’s Deck',
  description: 'A command palette for a developer’s everyday launch targets.',
  prompt: 'You are Jev, a fast launcher oracle. Pick the ONE launch target the user most likely wants, and be decisive at every keystroke.',
  targets: [
    { name: 'Run tests', category: 'Dev', aliases: ['test', 'pytest', 'spec'], featured: true },
    { name: 'Open Editor', category: 'Apps', aliases: ['code', 'vscode', 'ide'], featured: true },
    { name: 'Browser', category: 'Apps', aliases: ['chrome', 'web', 'internet'] },
    { name: 'Terminal', category: 'Apps', aliases: ['shell', 'console', 'zsh', 'bash'] },
    { name: 'Deploy to prod', category: 'Ops', aliases: ['ship', 'release', 'deploy'] },
    { name: 'Team chat', category: 'Comm', aliases: ['slack', 'discord', 'dm'] },
  ],
}

// Deterministic PRNG seeded per run so the palette is reproducible within a session.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function catalogBlock(l) {
  const rows = l.targets.map((t, i) =>
    `${i + 1}. ${t.name} [${t.category || '—'}]${t.featured ? ' (featured)' : ''} aliases: ${(t.aliases || []).join(', ')} — launch`
  ).join('\n')
  return `${l.prompt || 'You are a fast, decisive launch-oracle.'}
A launch palette — each numbered target, its category, and its aliases:

${rows}

The user typed nothing yet — the palette is idle, waiting for a query.
Rank the targets by which one would be most useful to surface first.`
}

function stateBlock(l, query) {
  const rows = l.targets.map((t, i) =>
    `${i + 1}. ${t.name} [${t.category || '—'}]${t.featured ? ' (featured)' : ''} aliases: ${(t.aliases || []).join(', ')} — launch`
  ).join('\n')
  const q = (query || '').trim()
  return `${l.prompt || 'You are a fast, decisive launch-oracle.'}
A launch palette — each numbered target, its category, and its aliases:

${rows}

Current query: "${q}"
Pick the ONE target that best matches "${q}". Be decisive, even on a noisy or partial match.`
}

export async function startLauncherViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let launcher = readLauncher(join(workspace, 'launcher.json'))
  let rng = mulberry32(2024)
  let clients = new Set()
  let stopped = false
  let salt = 1
  let query = ''
  let seq = 0
  let error = null
  let lasthistory = []   // [{seq, query, top, conf, ts}]
  let launches = 0       // how many targets the agent has "fired"

  function readLauncher(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return {
        ...DEFAULT_LAUNCHER,
        ...raw,
        targets: Array.isArray(raw.targets) && raw.targets.length ? raw.targets : DEFAULT_LAUNCHER.targets,
      }
    } catch (e) {
      error = clean(e.message)
      return DEFAULT_LAUNCHER
    }
  }

  // The target Jev would fire for the current query — re-ranked live on every keystroke.
  function currentPick() {
    const top = lasthistory[lasthistory.length - 1]
    return top ? { name: top.top, conf: top.conf } : null
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    const ready = lasthistory.length > 0
    const last = lasthistory[lasthistory.length - 1]
    return {
      spec: 1,
      ready,
      summary: error
        ? 'Jev Launcher needs a fix'
        : last
          ? `${launcher.title || 'Jev Launcher'} · query "${last.query || '∅'}" → ${last.top || '—'} (${(last.conf * 100).toFixed(0)}%) · ${lasthistory.length} keystrokes`
          : `${launcher.title || 'Jev Launcher'} · waiting for a query`,
      findings: (error ? [{ severity: 'error', kind: 'launcher', message: error }] : []).concat(
        lasthistory.length > 4 && last && (last.conf ?? 0) < 0.35
          ? [{ severity: 'warn', kind: 'launcher', message: 'Jev is confident on the current query' }]
          : []
      ),
      artifact: 'launcher.json',
      phases: [
        { id: 'idle', name: 'Idle', state: lasthistory.length === 0 ? 'active' : 'done' },
        { id: 'live', name: 'Live ranking', state: lasthistory.length > 0 ? 'active' : 'pending' },
        { id: 'launch', name: 'Launches', state: launches > 0 ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
  }

  function tail() {
    const v = verdict()
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'rank', title: launcher.title, description: launcher.description,
      query, seq, error, history: lasthistory.slice(-200),
      rank: paletteState().rank, targets: launcher.targets,
    })
  }

  async function runQuery(q) {
    if (stopped) return
    query = q
    try {
      const res = await evaluate({
        state: stateBlock(launcher, q),
        questions: {
          pick: { type: 'choice', instructions: 'Which launch target is the best match for this query?', options: launcher.targets.map((t) => t.name) },
          conf: { type: 'noul', instructions: 'Is this the target the user really wants?' },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const pick = res.answers.pick || {}
      const probs = pick.probabilities || {}
      const top = String(pick.choice || launcher.targets[0]?.name || '')
      // confidence = how concentrated the ranking is on the top target (choice confidence).
      const conf = typeof pick.confidence === 'number' ? pick.confidence : 0.5
      const sure = typeof res.answers.conf?.noul === 'number' ? res.answers.conf.noul : 0.5
      lasthistory.push({ seq: ++seq, query: q, top, conf, sure, probs, ts: new Date().toISOString(), client: res.client })
      if (lasthistory.length > 200) lasthistory.splice(0, lasthistory.length - 200)
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
  }

  function paletteState() {
    const last = lasthistory[lasthistory.length - 1]
    return {
      title: launcher.title, description: launcher.description, query,
      targets: launcher.targets, seq, error, history: lasthistory.slice(-200),
      rank: last ? last.probs : null,
    }
  }

  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'launcher.json') {
      launcher = readLauncher(join(workspace, 'launcher.json'))
      if (query) runQuery(query)
      tail()
    }
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'index.html'))) }
    if (req.method === 'GET' && url.pathname === '/studio.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.js'))) }
    if (req.method === 'GET' && url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
    if (req.method === 'GET' && url.pathname === '/jev-hud.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'jev-hud.js'))) }
    if (req.method === 'GET' && url.pathname === '/studio.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.css'))) }
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(paletteState())) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = ''
      for await (const c of req) { body += c; if (body.length > 1024) break }
      const cmd = JSON.parse(body || '{}')
      if (cmd.cmd === 'query') { await runQuery(String(cmd.query ?? '')); tail() }
      else if (cmd.cmd === 'launch') { launches++; tail() }
      else if (cmd.cmd === 'reset') { query = ''; seq = 0; lasthistory = []; launches = 0; tail() }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  tail()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; watcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
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
