// The Excalidraw pane: Excalidraw's own canvas, in view mode, showing the .excalidraw file named by
// ?file= (workspace-relative) and following every save without losing the reader's zoom and scroll.
// React and Excalidraw come from this package's node_modules (UMD builds), never from a CDN, so the
// pane works offline. The page itself is viewer/ (index.html, app.js, app.css).
//
//   GET  /                     the page
//   GET  /viewer/<file>        the page's script and style
//   GET  /vendor/<file>        React, ReactDOM, Excalidraw; /vendor/excalidraw-assets/* its fonts
//   GET  /files.json           the workspace's .excalidraw files, newest first
//   GET  /events               server-sent events: `change` with {path} per save, `: ping` every 20 s
//   POST /export?name=<file>   an exported PNG or SVG, written to <workspace>/exports/<file>
//   GET  /<anything else>      a file from the workspace, never outside it
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.excalidraw': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const VENDOR = {
  'react.production.min.js': join(here, 'node_modules/react/umd/react.production.min.js'),
  'react-dom.production.min.js': join(here, 'node_modules/react-dom/umd/react-dom.production.min.js'),
  'excalidraw.production.min.js': join(here, 'node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js'),
}
// Excalidraw resolves its lazy chunks and fonts as EXCALIDRAW_ASSET_PATH + "excalidraw-assets/…";
// the page sets that to /vendor/, so this is where they are served from.
const ASSETS = join(here, 'node_modules/@excalidraw/excalidraw/dist/excalidraw-assets')
const PAGE = join(here, 'viewer')
const SKIP = new Set(['node_modules', '.git', '.harness', 'exports', '.venv', '__pycache__'])

function safe(root, rel) { const full = normalize(join(root, rel)); return full === root || full.startsWith(root + sep) ? full : null }
function send(res, full, req) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  // Vendor bundles are immutable per install; the page and the workspace are not.
  const cache = full.startsWith(join(here, 'node_modules')) ? 'max-age=3600' : 'no-store'
  res.writeHead(200, { 'content-type': type, 'cache-control': cache }); res.end(readFileSync(full))
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

/** Every .excalidraw file under the workspace (skipping dependency and state folders), newest first. */
function diagrams(dir = workspace, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) diagrams(full, depth + 1, out); continue }
    if (entry.isFile() && entry.name.endsWith('.excalidraw')) {
      try { out.push({ path: relative(workspace, full).split(sep).join('/'), mtime: statSync(full).mtimeMs }) } catch { /* gone */ }
    }
  }
  return depth === 0 ? out.sort((a, b) => b.mtime - a.mtime) : out
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const chunks = []; let size = 0
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { send(res, join(PAGE, 'index.html'), req); return }
  if (path.startsWith('/viewer/')) { send(res, safe(PAGE, path.slice('/viewer/'.length)), req); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (path === '/files.json') { json(res, 200, { files: diagrams() }); return }
  if (path === '/export' && req.method === 'POST') {
    // Exports land in the workspace, where the agent and the user can both find them: a WebKit pane
    // has no download manager, so a Save link would go nowhere.
    const name = basename(String(url.searchParams.get('name') || ''))
    if (!/^[\w.@ -]+\.(png|svg)$/i.test(name)) { json(res, 400, { error: 'name must be a .png or .svg file name' }); return }
    try {
      const body = await readBody(req)
      mkdirSync(join(workspace, 'exports'), { recursive: true })
      writeFileSync(join(workspace, 'exports', name), body)
      json(res, 200, { path: `exports/${name}`, bytes: body.length })
    } catch (error) { json(res, 500, { error: error.message }) }
    return
  }
  if (path.startsWith('/vendor/excalidraw-assets/')) { send(res, safe(ASSETS, path.slice('/vendor/excalidraw-assets/'.length)), req); return }
  if (path.startsWith('/vendor/')) { send(res, VENDOR[path.slice('/vendor/'.length)] ?? null, req); return }
  send(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[excalidraw] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// One `change` per burst of writes, per path, so the page reloads only for the file it shows (a
// PNG landing in exports/ or build.py being edited is not a new diagram).
const pending = new Map()
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '').split(sep).join('/')
    if (!n || n.split('/').some((part) => SKIP.has(part))) return
    clearTimeout(pending.get(n))
    pending.set(n, setTimeout(() => {
      pending.delete(n)
      const data = JSON.stringify({ path: n })
      for (const c of clients) c.write(`event: change\ndata: ${data}\n\n`)
    }, 120))
  })
} catch (error) { console.log(`[excalidraw] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
