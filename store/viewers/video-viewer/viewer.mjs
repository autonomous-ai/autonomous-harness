// Video Viewer: one loopback server per pane, no dependencies.
//
//   GET  /                 the page (ui/index.html); ?file=<workspace-relative> names what to open
//   GET  /ui/<file>        the page's script and styles
//   GET  /api/library      every render in the workspace, the renders in progress (lib/library.mjs)
//   GET  /events           server-sent events: `library` with the same JSON whenever it changes
//   GET  /ws/<path>        a workspace file, with byte ranges so seeking is instant
//   POST /api/still?name=  a PNG frame from the page, saved to .harness/stills/<name>.png
//
// Any other path is a workspace file too (the pane's first version linked files at /<path>).
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLibrary, STALL_MS } from './lib/library.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.gif': 'image/gif', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
}

const library = createLibrary(workspace)
let current = library.scan()
let currentJson = JSON.stringify(current)
const clients = new Set()

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function inside(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

function serveFile(req, res, full) {
  let st
  try { st = statSync(full) } catch { return send(res, 404, 'not found') }
  if (!st.isFile()) return send(res, 404, 'not found')
  const size = st.size
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'last-modified': st.mtime.toUTCString() }
  if (req.method === 'HEAD') { res.writeHead(200, { ...base, 'content-length': size }); return res.end() }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && size > 0) {
    let start = range[1] ? Number(range[1]) : NaN, end = range[2] ? Number(range[2]) : NaN
    if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1 } else end = Number.isNaN(end) ? size - 1 : Math.min(end, size - 1)
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end() }
    res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    return createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res)
  }
  res.writeHead(200, { ...base, 'content-length': size })
  createReadStream(full).on('error', () => res.destroy()).pipe(res)
}

function publish() {
  let next
  try { next = library.scan() } catch (error) { console.log(`[video-viewer] scan failed: ${error.message}`); return }
  const json = JSON.stringify(next)
  if (json === currentJson) return
  current = next; currentJson = json
  for (const c of clients) c.write(`event: library\ndata: ${json}\n\n`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = url.pathname
  if (path === '/' || path === '/index.html') return serveFile(req, res, join(here, 'ui', 'index.html'))
  if (path.startsWith('/ui/')) {
    const full = inside(join(here, 'ui'), decodeURIComponent(path.slice(4)))
    return full ? serveFile(req, res, full) : send(res, 404, 'not found')
  }
  if (path === '/api/library') return send(res, 200, currentJson, { 'content-type': 'application/json' })
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`retry: 1000\nevent: library\ndata: ${currentJson}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (path === '/api/still' && req.method === 'POST') {
    // A custom header: a page on another origin cannot send it without a preflight this server refuses.
    if (req.headers['x-video-viewer'] !== 'still') return send(res, 403, 'forbidden')
    const name = (url.searchParams.get('name') || 'frame').replace(/[^\w.@+-]+/g, '-').replace(/^[-.]+/, '').slice(0, 120) || 'frame'
    const chunks = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c) })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return send(res, 400, 'not a png')
      const rel = `.harness/stills/${name}.png`
      try {
        mkdirSync(join(workspace, '.harness', 'stills'), { recursive: true })
        writeFileSync(join(workspace, rel), body)
      } catch (error) { return send(res, 500, error.message) }
      send(res, 200, JSON.stringify({ path: rel, abs: join(workspace, rel) }), { 'content-type': 'application/json' })
    })
    return
  }
  const rel = decodeURIComponent(path.startsWith('/ws/') ? path.slice(4) : path.slice(1))
  const full = inside(workspace, rel)
  if (!full) return send(res, 403, 'outside the workspace')
  serveFile(req, res, full)
})
server.listen(port, '127.0.0.1', () => console.log(`[video-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// A render writes dozens of files a second; answer the burst once it settles, but never later than a
// beat after it began, so a long render still streams its clips.
let timer = null, firstAt = 0
function schedule() {
  const t = Date.now()
  if (!timer) firstAt = t
  clearTimeout(timer)
  const wait = t - firstAt > 900 ? 0 : 250
  timer = setTimeout(() => { timer = null; publish() }, wait)
}
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '')
    if (n.startsWith('.harness') && !/^\.harness[\\/]((render|verdict)\.json$|renders[\\/])/.test(n)) return
    if (/(^|[\\/])(node_modules|\.git|__pycache__|\.claude|texts|Tex)([\\/]|$)/.test(n)) return
    schedule()
  })
} catch (error) {
  console.log(`[video-viewer] watch failed (${error.message}); polling instead`)
  setInterval(publish, 1500).unref()
}
// While a render is running, time alone changes the answer (a render that stops writing is stalled).
setInterval(() => { if (current.live.some((l) => l.state === 'rendering' || Date.now() - (l.updatedAtMs ?? 0) < STALL_MS + 5000)) publish() }, 2000).unref()
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const c of clients) c.end(); server.close(); process.exit(0) })
