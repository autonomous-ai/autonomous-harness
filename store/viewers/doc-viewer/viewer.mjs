// Doc Viewer: one loopback server per pane. It serves the reader (app/), pdf.js from this package's
// node_modules (never a CDN), and the workspace read-only under /ws/. It watches the workspace and
// pushes the document's state over server-sent events the moment anything that matters changes: a
// new PDF, a source file newer than the PDF (a compile is on its way), a verdict that says the
// compile failed. The page does the rest.
//
//   GET  /                   the reader
//   GET  /app/*              its files
//   GET  /vendor/<part>/*    pdf.js: build, web, legacy, cmaps, standard_fonts, wasm, iccs
//   GET  /ws/<path>          a workspace file (?download=1 for an attachment)
//   GET  /api/state?file=    the document state (lib/workspace.mjs)
//   GET  /events?file=       the same state, pushed on every change
//   POST /api/open           open the PDF in the default app, reveal it, or open an external link
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docState, safeJoin, stateKey } from './lib/workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const APP = join(here, 'app')
const PDFJS = join(here, 'node_modules', 'pdfjs-dist')
const VENDOR_PARTS = new Set(['build', 'web', 'legacy', 'cmaps', 'standard_fonts', 'wasm', 'iccs'])
// DOC_VIEWER_OPEN=log answers "opened" without opening anything (tests); =off hides the actions.
const OPEN_MODE = process.env.DOC_VIEWER_OPEN ?? (process.platform === 'darwin' || process.platform === 'linux' ? 'on' : 'off')
const TYPES = {
  '.pdf': 'application/pdf', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}
const clients = new Set()

function sendFile(req, res, full, { cache = 'no-store', download = false } = {}) {
  let st
  try { st = statSync(full) } catch { st = null }
  if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const headers = { 'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': cache, 'last-modified': st.mtime.toUTCString() }
  if (download) headers['content-disposition'] = `attachment; filename="${basename(full).replace(/"/g, '')}"`
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(full).pipe(res)
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limit = 16_384) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

// Only this page may ask: a custom header forces a CORS preflight no other origin gets past, and
// the Host check stops DNS rebinding.
function trusted(req) {
  const host = String(req.headers.host ?? '')
  return req.headers['x-doc-viewer'] === '1' && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
}

function openThing(args) {
  if (OPEN_MODE === 'log') { console.log(`[doc-viewer] open (dry run): ${args.join(' ')}`); return }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', (error) => console.log(`[doc-viewer] ${cmd} failed: ${error.message}`))
  child.unref()
}

async function handleOpen(req, res) {
  if (!trusted(req)) return json(res, 403, { ok: false, error: 'forbidden' })
  if (OPEN_MODE === 'off') return json(res, 501, { ok: false, error: 'opening is not available here' })
  let body
  try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { ok: false, error: 'bad request' }) }
  if (body.kind === 'url') {
    const url = String(body.url ?? '')
    if (!/^(https?:\/\/|mailto:)/i.test(url) || url.length > 4096) return json(res, 400, { ok: false, error: 'only http(s) and mailto links open' })
    openThing([url])
    return json(res, 200, { ok: true })
  }
  const full = safeJoin(workspace, String(body.path ?? ''))
  if (!full || !existsSync(full)) return json(res, 404, { ok: false, error: 'no such file' })
  if (body.kind === 'reveal') openThing(process.platform === 'darwin' ? ['-R', full] : [dirname(full)])
  else openThing([full])
  return json(res, 200, { ok: true })
}

function state(file) {
  return { ...docState(workspace, file), canOpen: OPEN_MODE !== 'off' }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  let path
  try { path = decodeURIComponent(url.pathname) } catch { res.writeHead(400); res.end(); return }
  if (path === '/' || path === '/index.html') return sendFile(req, res, join(APP, 'index.html'))
  if (path.startsWith('/app/')) {
    const full = safeJoin(APP, path.slice('/app/'.length))
    return full ? sendFile(req, res, full) : (res.writeHead(404), res.end())
  }
  if (path.startsWith('/vendor/')) {
    const [part, ...rest] = path.slice('/vendor/'.length).split('/')
    const full = VENDOR_PARTS.has(part) ? safeJoin(join(PDFJS, part), rest.join('/')) : null
    return full ? sendFile(req, res, full, { cache: 'max-age=86400' }) : (res.writeHead(404), res.end())
  }
  if (path.startsWith('/ws/')) {
    const full = safeJoin(workspace, path.slice('/ws/'.length))
    return full ? sendFile(req, res, full, { download: url.searchParams.has('download') }) : (res.writeHead(404), res.end())
  }
  if (path === '/api/state') return json(res, 200, state(url.searchParams.get('file') ?? ''))
  if (path === '/api/open' && req.method === 'POST') { handleOpen(req, res).catch((e) => json(res, 500, { ok: false, error: e.message })); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const client = { res, file: url.searchParams.get('file') ?? '', key: '' }
    clients.add(client)
    push(client, true)
    req.on('close', () => clients.delete(client))
    return
  }
  // The old viewer served workspace files at the root; keep those URLs working.
  const legacy = safeJoin(workspace, path.replace(/^\/+/, ''))
  if (legacy && extname(legacy).toLowerCase() === '.pdf') return sendFile(req, res, legacy)
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
}).listen(port, '127.0.0.1', () => console.log(`[doc-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

function push(client, force = false) {
  let next
  try { next = state(client.file) } catch (error) { console.log(`[doc-viewer] state failed: ${error.message}`); return }
  const key = stateKey(next)
  if (!force && key === client.key) return
  client.key = key
  client.res.write(`event: state\ndata: ${JSON.stringify(next)}\n\n`)
}

// fs.watch is FSEvents on macOS and reliable; a slow poll backs it up on filesystems where it is not.
let timer = null
const flush = () => { timer = null; for (const c of clients) push(c) }
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const rel = String(name ?? '')
    if (rel.includes('node_modules') || rel.startsWith('.git') || rel.startsWith('.claude') || rel.startsWith('.agents')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 120)
  })
} catch (error) {
  console.log(`[doc-viewer] watch failed: ${error.message}`)
}
setInterval(() => { if (clients.size) flush() }, 3000).unref()
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n') }, 20_000).unref()
