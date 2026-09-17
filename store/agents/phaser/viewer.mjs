// The Phaser pane: Vite's dev server on the workspace, wrapped in a game frame.
//
//   GET /                      the frame — toolbar, device presets, debug, errors — around an iframe
//   GET /index.html            the game itself, served and hot-reloaded by Vite as always
//   GET /__harness/<asset>     the frame's own files (viewer/), never the workspace's
//   GET /__harness/events      server-sent events: file changes, Vite's reloads, updates and errors
//   GET /__harness/source      ?path= a workspace source file as text, for an error's code frame
//
// Vite runs in-process with the workspace's own vite.config.mjs, plus one plugin that adds the
// routes above and injects two small scripts into the game page: a guard (runtime errors, before
// anything else runs) and a probe (finds the Phaser.Game so the frame can pause, debug, restart).
// Nothing is written into the workspace; `vite build` and a standalone `npm run dev` never see it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const ASSETS = join(here, 'viewer')
const PROBE_ID = '/@harness/probe.js'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const SOURCE = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.glsl', '.frag', '.vert'])
const clients = new Set()

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) client.write(line)
}

function rel(file) {
  const r = relative(workspace, resolve(workspace, String(file ?? '')))
  return r.startsWith('..') ? String(file ?? '') : r.split(sep).join('/')
}

/** A workspace path from an error payload or a URL, or null when it leaves the workspace. */
function inWorkspace(raw) {
  const clean = decodeURIComponent(String(raw ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/^\/@fs/, ''))
  const full = normalize(clean.startsWith(workspace) ? clean : join(workspace, clean.replace(/^\/+/, '')))
  return full.startsWith(workspace + sep) ? full : null
}

/** What the frame needs from a Vite payload: reloads, updates and errors, with workspace paths. */
function observe(payload) {
  if (!payload || typeof payload !== 'object') return
  if (payload.type === 'full-reload') {
    broadcast('reload', { file: payload.triggeredBy ? rel(payload.triggeredBy) : null, path: payload.path ?? null })
  } else if (payload.type === 'update') {
    broadcast('update', { files: [...new Set((payload.updates ?? []).map((u) => u.path?.replace(/^\/+/, '').replace(/\?.*$/, '')))] })
  } else if (payload.type === 'error') {
    const err = payload.err ?? {}
    const file = err.loc?.file ?? err.id ?? null
    broadcast('build-error', {
      message: String(err.message ?? 'Build error').replace(/\x1b\[[0-9;]*m/g, ''),
      file: file ? rel(String(file).replace(/\?.*$/, '')) : null,
      line: err.loc?.line ?? null,
      column: err.loc?.column ?? null,
      frame: String(err.frame ?? '').replace(/\x1b\[[0-9;]*m/g, ''),
      plugin: err.plugin ?? null,
    })
  }
}

const GUARD = readFileSync(join(ASSETS, 'guard.js'), 'utf8')

function harness() {
  return {
    name: 'harness-frame',
    apply: 'serve',
    resolveId(id) { return id === PROBE_ID ? '\0harness-probe' : null },
    load(id) { return id === '\0harness-probe' ? readFileSync(join(ASSETS, 'probe.js'), 'utf8') : null },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          { tag: 'script', children: GUARD, injectTo: 'head-prepend' },
          { tag: 'script', attrs: { type: 'module', src: PROBE_ID }, injectTo: 'head' },
        ]
      },
    },
    configureServer(server) {
      const hot = server.environments?.client?.hot ?? server.ws
      const send = hot.send.bind(hot)
      hot.send = (...args) => {
        try { observe(typeof args[0] === 'string' ? { type: 'custom', event: args[0], data: args[1] } : args[0]) } catch { /* the frame is a spectator */ }
        return send(...args)
      }
      server.watcher.on('all', (event, file) => {
        const r = rel(file)
        if (r.startsWith('..') || /^(out|\.vite|\.harness|node_modules|\.git)(\/|$)/.test(r)) return
        broadcast('change', { event, file: r })
      })
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path === '/' && !url.searchParams.has('game')) return asset(res, 'frame.html')
        if (!path.startsWith('/__harness/')) return next()
        const name = path.slice('/__harness/'.length)
        if (name === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          res.write(`event: hello\ndata: ${JSON.stringify({ workspace: workspace.split(sep).pop() })}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
        if (name === 'source') {
          const full = inWorkspace(url.searchParams.get('path'))
          if (!full || !SOURCE.has(extname(full).toLowerCase()) || !existsSync(full) || !statSync(full).isFile() || statSync(full).size > 2_000_000) {
            res.writeHead(404); res.end('not found'); return
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(readFileSync(full))
          return
        }
        return asset(res, name)
      })
    },
  }
}

function asset(res, name) {
  const full = normalize(join(ASSETS, name))
  if (!full.startsWith(ASSETS + sep) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(readFileSync(full))
}

const server = await createServer({
  root: workspace,
  clearScreen: false,
  plugins: [harness()],
  // The frame shows build errors itself, readably and outside the game; Vite's overlay would sit
  // inside the scaled game and cover it.
  server: { host: '127.0.0.1', port, strictPort: true, hmr: { overlay: false } },
})
await server.listen()
console.log(`[phaser] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`)
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close().finally(() => process.exit(0)) })
