// kit.mjs — the boring, security-relevant half of a Jev viewer, written once:
// a loopback-only HTTP server with static files, /state, /events (SSE), /jev (telemetry) and
// /control, plus an atomic verdict writer and a safe JSON config watcher.
import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' }

export const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

/** Deterministic PRNG so every run of a demo is reproducible. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Serve a viewer.
 * @param {object} o
 * @param {string}   o.here      the viewer directory (static files live here)
 * @param {number}   o.port      0 = ephemeral
 * @param {string[]} [o.files]   static file names served from `here` ('index.html' is also '/')
 * @param {function} o.state     () => JSON-safe full state (GET /state, and the first SSE frame)
 * @param {function} [o.control] async (cmd, body) => optional JSON-safe reply (POST /control)
 */
export async function serveViewer({ here, port = 0, files = ['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js'], state, control }) {
  const clients = new Set()
  const allowed = new Set(files)

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
        if (allowed.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' }); return res.end(readFileSync(join(here, name))) }
        if (path === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(state())) }
        if (path === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (path === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && path === '/control') {
        let body = ''
        for await (const c of req) { body += c; if (body.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        const reply = control ? await control(String(j.cmd ?? ''), j) : null
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...(reply && typeof reply === 'object' ? reply : {}) }))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    clients,
    /** Push a named SSE event (default 'state') to every connected pane. */
    broadcast(obj, event = 'state') {
      const line = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
      for (const c of clients) c.write(line)
    },
    async close() { for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
  }
}

/** Atomic write of .harness/verdict.json (the harness reads this file; never edit it by hand). */
export function writeVerdict(workspace, verdict) {
  const dir = join(workspace, '.harness')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'verdict.json')
  writeFileSync(file + '.tmp', JSON.stringify({ spec: 1, ...verdict, updatedAt: new Date().toISOString() }))
  renameSync(file + '.tmp', file)
}

/**
 * Load a JSON config merged over defaults, and re-load on every edit. A bad edit keeps the last
 * good config and reports the parse error instead of crashing the demo.
 * @returns {{ get(): object, error(): string|null, close(): void }}
 */
export function watchConfig(file, defaults, onChange) {
  let cfg = { ...defaults }, err = null, timer = null
  const load = () => {
    try { cfg = { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) }; err = null }
    catch (e) { err = existsSync(file) ? clean(`${file.split('/').pop()}: ${e.message}`) : null }
  }
  load()
  let watcher = null
  try {
    watcher = watch(file, () => { clearTimeout(timer); timer = setTimeout(() => { load(); onChange?.(cfg, err) }, 40) })
  } catch { /* file may not exist yet; defaults stand */ }
  return { get: () => cfg, error: () => err, close() { clearTimeout(timer); watcher?.close() } }
}
