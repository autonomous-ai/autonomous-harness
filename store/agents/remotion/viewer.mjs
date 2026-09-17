// The Remotion pane: Remotion Studio, unchanged, with the two things Studio does not show a person
// sitting beside an agent — the renders the agent made, and the render it is making right now.
//
//   /__harness/            the pane: a slim bar (Studio | Renders, render progress) over Studio
//   /__harness/events      server-sent state: Studio's status, the renders in out/, .harness/render.json
//   /__harness/media/<p>   a render from the workspace, with Range support (a <video> needs it to seek)
//   everything else        proxied to Studio, which runs on a private loopback port
//
// Studio is started by this process (`remotion studio`, BROWSER=none) and restarted if it dies. It is
// proxied rather than framed cross-origin so it shares the pane's origin: its own same-origin checks
// pass untouched, and the pane can follow which composition is open. Remotion binds Studio to every
// interface and has no flag for it, so toolchain/loopback.cjs is preloaded into Studio's process to
// keep it on 127.0.0.1.
//
// Render progress comes from `$REMOTION` (toolchain/remotion.mjs), which writes .harness/render.json
// as the CLI reports bundling, frames and encoding.
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, watch } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const remotionBin = join(here, 'node_modules', '.bin', 'remotion')
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])
const IMAGE = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp'])
const AUDIO = new Set(['.mp3', '.wav', '.aac', '.m4a'])
const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
}

// The workspace links the package's node_modules (init-workspace.sh does it too; a workspace made by
// hand may not have it yet).
if (!existsSync(join(workspace, 'node_modules'))) {
  try { lstatSync(join(workspace, 'node_modules')) } catch { try { symlinkSync(join(here, 'node_modules'), join(workspace, 'node_modules')) } catch {} }
}

// ---- Studio -------------------------------------------------------------------------------------
const studio = { state: 'starting', port: null, log: [], restarts: 0, child: null, since: Date.now() }
let stopping = false

function freePort() {
  const wanted = Number(process.env.REMOTION_STUDIO_PORT || 0)
  if (wanted) return Promise.resolve(wanted)
  return new Promise((ok, fail) => {
    const s = net.createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
  })
}

function entryPoint() {
  for (const f of ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx']) if (existsSync(join(workspace, f))) return f
  return 'src/index.ts'
}

async function startStudio() {
  const p = await freePort()
  studio.state = 'starting'; studio.port = null; studio.since = Date.now()
  broadcast()
  const preload = `--require ${JSON.stringify(join(here, 'toolchain', 'loopback.cjs'))}`
  const child = spawn(remotionBin, ['studio', '--port', String(p), '--no-open', entryPoint()], {
    cwd: workspace,
    env: { ...process.env, BROWSER: 'none', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim(), FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  studio.child = child
  const onData = (chunk) => {
    const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')
    process.stdout.write(text)
    for (const line of text.split(/\r?\n/)) if (line.trim()) { studio.log.push(line); if (studio.log.length > 40) studio.log.shift() }
    const ready = text.match(/Server ready[^\n]*?(?:localhost|127\.0\.0\.1):(\d+)/)
    if (ready) { studio.port = Number(ready[1]); studio.state = 'ready'; studio.restarts = 0; broadcast() }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code) => {
    studio.child = null
    if (stopping) return
    studio.state = 'stopped'; studio.port = null
    studio.log.push(`Remotion Studio exited (${code ?? 'signal'}).`)
    broadcast()
    const delay = Math.min(30_000, 1000 * 2 ** studio.restarts++)
    setTimeout(() => { if (!stopping) startStudio() }, delay)
  })
}

// ---- Workspace state ----------------------------------------------------------------------------
function walk(dir, out, depth = 0) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) { if (depth < 4) walk(full, out, depth + 1) } else out.push(full)
  }
  return out
}

function newestSource() {
  let best = 0
  for (const f of walk(join(workspace, 'src'), [])) {
    try { best = Math.max(best, statSync(f).mtimeMs) } catch {}
  }
  return best
}

function renders() {
  const src = newestSource()
  const files = walk(join(workspace, 'out'), [])
  return files
    .map((full) => {
      const ext = extname(full).toLowerCase()
      const kind = VIDEO.has(ext) ? 'video' : IMAGE.has(ext) ? (ext === '.gif' ? 'gif' : 'image') : AUDIO.has(ext) ? 'audio' : null
      if (!kind) return null
      let st
      try { st = statSync(full) } catch { return null }
      if (!st.size) return null
      return { path: relative(workspace, full).split(sep).join('/'), name: basename(full), kind, size: st.size, mtime: st.mtimeMs, stale: src > st.mtimeMs + 1000 }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 60)
}

function renderJob() {
  try {
    const job = JSON.parse(readFileSync(join(workspace, '.harness', 'render.json'), 'utf8'))
    if (job.state === 'running' && job.pid) {
      try { process.kill(job.pid, 0) } catch { job.state = 'interrupted' }
    }
    return job
  } catch { return null }
}

// Compositions as Root.tsx registers them, with the source file behind each: the one whose file was
// touched last is the one the agent is working on, and the pane opens Studio there.
function compositions() {
  const rootFile = ['src/Root.tsx', 'src/Root.jsx', 'src/Root.ts'].map((f) => join(workspace, f)).find((f) => existsSync(f))
  if (!rootFile) return []
  let text = ''
  try { text = readFileSync(rootFile, 'utf8') } catch { return [] }
  const imports = new Map()
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imports.set(name, m[2])
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*["'](\.[^"']+)["']/g)) imports.set(m[1], m[2])
  const out = []
  for (const m of text.matchAll(/<(Composition|Still)\b([\s\S]*?)\/>/g)) {
    const id = m[2].match(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["'`]([^"'`]+)["'`]\s*\})/)
    if (!id) continue
    const component = m[2].match(/\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/)
    let mtime = 0
    const spec = component && imports.get(component[1])
    if (spec) {
      const base = resolve(dirname(rootFile), spec)
      for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
        try { const st = statSync(candidate); if (st.isFile()) { mtime = st.mtimeMs; break } } catch {}
      }
    }
    out.push({ id: id[1] ?? id[2] ?? id[3], kind: m[1] === 'Still' ? 'still' : 'video', mtime })
  }
  return out
}

function state() {
  const comps = compositions()
  const active = [...comps].sort((a, b) => b.mtime - a.mtime)[0]?.id ?? null
  return {
    studio: { state: studio.state, log: studio.state === 'ready' ? [] : studio.log.slice(-12), since: studio.since },
    renders: renders(),
    job: renderJob(),
    compositions: comps.map((c) => c.id),
    active,
  }
}

// ---- Events -------------------------------------------------------------------------------------
const clients = new Set()
let last = ''
function broadcast() {
  if (!clients.size) return
  const body = JSON.stringify(state())
  if (body === last) return
  last = body
  for (const c of clients) c.write(`event: state\ndata: ${body}\n\n`)
}
let timer = null
const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(broadcast, 120) }
try {
  watch(workspace, { recursive: true }, (_e, name) => {
    const n = String(name ?? '').split(sep).join('/')
    if (n.startsWith('node_modules') || n.startsWith('.git/')) return
    if (n.startsWith('out/') || n === 'out' || n.startsWith('src/') || n === '.harness/render.json') soon()
  })
} catch (error) { console.log(`[remotion pane] watch failed: ${error.message}`) }
// A render that was killed never writes its own end, and "stale" moves with src/ and out/ alike; a
// slow tick catches what the watcher cannot (broadcast() sends nothing when nothing changed).
setInterval(broadcast, 2000).unref()
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()

// ---- HTTP ---------------------------------------------------------------------------------------
function safe(rel) {
  const full = normalize(join(workspace, rel))
  return full === workspace || full.startsWith(workspace + sep) ? full : null
}

function sendMedia(req, res, rel) {
  const full = safe(rel)
  const ext = extname(rel).toLowerCase()
  if (!full || !TYPES[ext] || !existsSync(full)) { res.writeHead(404); res.end('not found'); return }
  const size = statSync(full).size
  const headers = { 'content-type': TYPES[ext], 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/)
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start); end = Math.min(size - 1, end)
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(full, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': size })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(full).pipe(res)
}

function proxy(req, res) {
  if (studio.state !== 'ready' || !studio.port) {
    const html = (req.headers.accept ?? '').includes('text/html')
    res.writeHead(503, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain', 'retry-after': '1', 'cache-control': 'no-store' })
    res.end(html ? `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><body style="margin:0;background:#1f2428;color:#a6a7a9;font:13px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh">Starting Remotion Studio…</body>` : 'Studio is starting')
    return
  }
  const upstream = http.request({ host: '127.0.0.1', port: studio.port, method: req.method, path: req.url, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Studio did not answer') } else res.end() })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  if (path === '/__harness' || path === '/__harness/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(join(here, 'viewer.html')))
    return
  }
  if (path === '/__harness/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (path === '/__harness/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(state()))
    return
  }
  if (path.startsWith('/__harness/media/')) { sendMedia(req, res, decodeURIComponent(path.slice('/__harness/media/'.length))); return }
  proxy(req, res)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`[remotion pane] http://127.0.0.1:${port}/__harness/ (workspace: ${workspace})`)
  mkdirSync(join(workspace, 'out'), { recursive: true })
  startStudio()
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true
    try { studio.child?.kill('SIGTERM') } catch {}
    setTimeout(() => process.exit(0), 300).unref()
  })
}
process.on('exit', () => { try { studio.child?.kill('SIGTERM') } catch {} })
