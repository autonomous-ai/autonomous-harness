// MuJoCo Viewer: one loopback server per pane. It serves three things and nothing else.
//
//   the page          GET /            the shell, and GET /app.js the browser app
//   the engine        GET /vendor/…    MuJoCo's official WASM build and three.js, from this
//                                      package's node_modules — never a CDN, so the pane is offline
//   the model         GET /ws/…        a file from the harness's workspace
//                     GET /menagerie/… a file from the harness's Menagerie checkout
//                     GET /list?dir=…  every model file under one directory of those two roots,
//                                      which the page copies into MuJoCo's in-memory filesystem
//
// The two roots are one namespace, the same one the trajectory's `model` field uses: a path that
// starts with `menagerie/` is a robot from the harness, anything else is workspace-relative.
// GET /events is server-sent events; the page reloads the trajectory on every workspace change.
import { createServer } from 'node:http'
import { createReadStream, existsSync, readdirSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
// The robots live with the harness that uses this viewer, not with the viewer: HARNESS_DSH_DIR is
// the harness's install dir even while this process runs in its own.
const dshDir = process.env.HARNESS_DSH_DIR ? resolve(process.env.HARNESS_DSH_DIR) : null
const menagerie = resolve(process.env.MENAGERIE || (dshDir ? join(dshDir, 'menagerie') : join(workspace, 'menagerie')))
const clients = new Set()

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.xml': 'text/xml', '.obj': 'text/plain', '.mtl': 'text/plain',
  '.stl': 'application/octet-stream', '.msh': 'application/octet-stream', '.skn': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ppm': 'image/x-portable-pixmap',
}
// What MuJoCo can open. A directory listing is a fetch list for the page, so it carries model files
// and nothing else — no READMEs, no videos, no notebooks.
const MODEL_EXTENSIONS = new Set(['.xml', '.mjcf', '.urdf', '.sdf', '.obj', '.mtl', '.stl', '.msh', '.skn', '.png', '.ppm', '.jpg', '.jpeg', '.dae', '.bin'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.harness', '.claude', '.agents', '.codex', 'out', 'dist', 'build', '.cache'])
const LIST_MAX_FILES = 4000
const LIST_MAX_BYTES = 512 * 1024 * 1024

const VENDOR = { three: join(here, 'node_modules/three'), mujoco: join(here, 'node_modules/@mujoco/mujoco') }

const page = `<!doctype html><meta charset="utf-8"><title>MuJoCo Viewer</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #111114; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 10px; align-items: center; padding: 0 10px; border-bottom: 1px solid #303036; background: #1c1c1e; z-index: 3; }
  #bar .muted { color: #8e8e93; }
  #bar .spacer { flex: 1; }
  #name { max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #hud { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  button, select { font: inherit; color: #e5e5ea; background: #2c2c30; border: 1px solid #3a3a42; border-radius: 5px; padding: 2px 8px; cursor: pointer; }
  button:hover, select:hover { background: #35353b; }
  button:disabled { opacity: .4; cursor: default; }
  label.toggle { display: flex; gap: 5px; align-items: center; cursor: pointer; user-select: none; }
  canvas { position: absolute; inset: 30px 0 0 0; width: 100%; display: block; touch-action: none; }
  #transport { position: absolute; left: 0; right: 0; bottom: 0; height: 34px; display: flex; gap: 10px; align-items: center; padding: 0 10px; background: rgba(28, 28, 30, .86); border-top: 1px solid #303036; backdrop-filter: blur(8px); z-index: 2; }
  #transport #play { width: 30px; text-align: center; }
  #scrub { flex: 1; accent-color: #0a84ff; }
  #clock { font-variant-numeric: tabular-nums; color: #8e8e93; min-width: 96px; text-align: right; }
  #overlay { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; padding: 24px; text-align: center; color: #8e8e93; line-height: 1.6; z-index: 1; pointer-events: none; }
  #overlay b { color: #e5e5ea; font-weight: 500; }
  #overlay code { color: #c7c7cc; background: #26262c; border-radius: 4px; padding: 1px 5px; }
</style>
<div id="bar">
  <span id="name">MuJoCo</span>
  <span class="muted" id="hud"></span>
  <span class="spacer"></span>
  <button id="reset" title="Back to the model's first keyframe (R)" disabled>Reset</button>
  <label class="toggle" title="Step physics from the pose on screen (L)"><input type="checkbox" id="live" disabled> Live</label>
</div>
<canvas id="view"></canvas>
<div id="transport" hidden>
  <button id="play" title="Play / pause (space)">▮▮</button>
  <input type="range" id="scrub" min="0" max="0" value="0" step="1" title="Scrub the rollout">
  <span id="clock">0.00 s</span>
  <select id="speed" title="Playback speed">
    <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
    <option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option>
  </select>
</div>
<div id="overlay">Starting MuJoCo…</div>
<script type="importmap">
{ "imports": { "three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/" } }
</script>
<script type="module" src="/app.js"></script>
`

function safe(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

/** A path in the model namespace → the file on disk. `menagerie/…` is the harness's, the rest the workspace's. */
function modelFile(path) {
  const clean = path.replace(/^\/+/, '')
  if (clean === 'menagerie') return menagerie
  if (clean.startsWith('menagerie/')) return safe(menagerie, clean.slice('menagerie/'.length))
  return safe(workspace, clean)
}

function send(res, req, full, cacheable) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const size = statSync(full).size
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const headers = { 'content-type': type, 'content-length': size, 'cache-control': cacheable ? 'max-age=3600' : 'no-store' }
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
  res.writeHead(200, headers)
  createReadStream(full).pipe(res)
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

/** Every model file under one directory of the namespace, as namespace paths the page can fetch. */
function listModelFiles(dir) {
  const clean = dir.replace(/^\/+/, '').replace(/\/+$/, '')
  const root = modelFile(clean || '.')
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) return null
  const prefix = clean && clean !== '.' ? clean + '/' : ''
  const files = []
  let bytes = 0
  const walk = (abs, rel, depth) => {
    if (depth > 8 || files.length >= LIST_MAX_FILES || bytes >= LIST_MAX_BYTES) return
    let names
    try { names = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      if (entry.name.startsWith('.')) continue
      const child = join(abs, entry.name)
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(child, rel + entry.name + '/', depth + 1) ; continue }
      if (!entry.isFile()) continue
      if (!MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      let size = 0
      try { size = statSync(child).size } catch { continue }
      if (files.length >= LIST_MAX_FILES || bytes + size > LIST_MAX_BYTES) return
      bytes += size
      files.push({ path: prefix + rel + entry.name, size })
    }
  }
  walk(root, '', 0)
  return { dir: clean, files, bytes }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (path === '/app.js') { send(res, req, join(here, 'app.js'), false); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (path === '/list') {
    const listing = listModelFiles(url.searchParams.get('dir') ?? '')
    if (!listing) { json(res, { error: 'no such directory', dir: url.searchParams.get('dir') ?? '' }, 404); return }
    json(res, listing); return
  }
  if (path.startsWith('/vendor/')) {
    const rest = path.slice('/vendor/'.length)
    const slash = rest.indexOf('/')
    const root = VENDOR[slash < 0 ? rest : rest.slice(0, slash)]
    send(res, req, root && slash > 0 ? safe(root, rest.slice(slash + 1)) : null, true); return
  }
  if (path === '/ws' || path.startsWith('/ws/')) { send(res, req, safe(workspace, path.slice(3).replace(/^\/+/, '')), false); return }
  if (path === '/menagerie' || path.startsWith('/menagerie/')) { send(res, req, safe(menagerie, path.slice('/menagerie'.length).replace(/^\/+/, '')), true); return }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
}).listen(port, '127.0.0.1', () => {
  console.log(`[mujoco-viewer] listening on http://127.0.0.1:${port}/`)
  console.log(`[mujoco-viewer] workspace: ${workspace}`)
  console.log(`[mujoco-viewer] menagerie: ${menagerie}${existsSync(menagerie) ? '' : ' (not there — only workspace MJCF will load)'}`)
})

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '')
    if (!n || n.startsWith('.harness') || n.includes('node_modules') || n.endsWith('.mp4')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 300)
  })
} catch (error) { console.log(`[mujoco-viewer] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
