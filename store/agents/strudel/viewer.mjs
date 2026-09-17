// The Strudel pane's server: Strudel's own REPL as a web component, playing the .strudel file named by
// ?file= (workspace-relative, or the newest .strudel when none is named) and hot-swapping the pattern the
// moment the file changes — without stopping the transport. Strudel comes from this package's
// node_modules (`@strudel/repl`, as npm publishes it), never from a CDN, so the pane works offline.
//
//   GET /            the pane (pane/index.html; pane.mjs draws the transport, the voices, the lanes)
//   GET /_pane/*     the pane's own files
//   GET /vendor/*    @strudel/repl's dist, unmodified
//   GET /_files      [{ path, mtime }] — the workspace's .strudel files, newest first
//   GET /events      server-sent events: one "change" per save
//   GET /<path>      a file from the workspace, never outside it
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.strudel': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }
// The whole dist directory: index.js is the script-tag build, and it resolves its audio clock worker
// relative to its own URL (dist/assets/clockworker-*.js), so the siblings have to be reachable too.
const VENDOR = join(here, 'node_modules/@strudel/repl/dist')

const PANE = join(here, 'pane')
const page = () => readFileSync(join(PANE, 'index.html'))

function safe(root, rel) { const full = normalize(join(root, rel)); return full === root || full.startsWith(root + sep) ? full : null }
/** The workspace's .strudel files, newest first — what the pane opens when no file is named. */
function tracks() {
  const found = []
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory() && depth < 4) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.strudel')) {
        try { found.push({ path: relative(workspace, full).split(sep).join('/'), mtime: statSync(full).mtimeMs }) } catch {}
      }
    }
  }
  walk(workspace, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, 50)
}
function send(res, full, req, fresh = false) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': full.startsWith(VENDOR) && !fresh ? 'max-age=3600' : 'no-store' }); res.end(readFileSync(full))
}
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page()); return }
  if (path.startsWith('/_pane/')) { send(res, safe(PANE, path.slice('/_pane/'.length)), req, true); return }
  if (path === '/_files') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(tracks())); return }
  if (path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  if (path.startsWith('/vendor/')) { send(res, safe(VENDOR, path.slice('/vendor/'.length)), req); return }
  send(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[strudel] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) { console.log(`[strudel] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
