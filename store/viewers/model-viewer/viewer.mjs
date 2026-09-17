// 3D Viewer: one loopback server per pane. GET / shows the glTF/GLB named by ?file= (workspace-
// relative) in Google's <model-viewer> — orbit, zoom, auto-rotate — and reloads it the moment the
// file changes. The component comes from this package's node_modules, never a CDN. GET /events is
// server-sent events; any other path is a file from the workspace, never outside it.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const BUNDLE = join(here, 'node_modules/@google/model-viewer/dist/model-viewer.min.js')
const TYPES = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.hdr': 'application/octet-stream', '.js': 'text/javascript', '.json': 'application/json' }

const page = `<!doctype html><meta charset="utf-8"><title>3D Viewer</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #1c1c1e; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 12px; align-items: center; padding: 0 12px; border-bottom: 1px solid #333; z-index: 2; }
  #bar .muted { color: #8e8e93; }
  model-viewer { position: absolute; top: 30px; left: 0; right: 0; bottom: 0; width: 100%; height: calc(100% - 30px); background: radial-gradient(ellipse at 50% 40%, #2c2c30, #151517 70%); }
  #empty { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; color: #8e8e93; }
</style>
<div id="bar"><span id="name">…</span><span class="muted" id="meta"></span></div>
<model-viewer id="mv" hidden camera-controls auto-rotate rotation-per-second="20deg" shadow-intensity="1" exposure="1" touch-action="pan-y" interaction-prompt="none"></model-viewer>
<div id="empty">No model yet. The pane shows the glTF the harness exports.</div>
<script type="module" src="/vendor/model-viewer.min.js"></script>
<script>
  const params = new URLSearchParams(location.search); const file = params.get('file') || '';
  const mv = document.getElementById('mv'), empty = document.getElementById('empty');
  async function load() {
    if (!file) return;
    const head = await fetch('/' + file, { method: 'HEAD' });
    if (!head.ok) { mv.hidden = true; empty.hidden = false; empty.textContent = file + ' is not there yet.'; return; }
    document.getElementById('name').textContent = file;
    const size = Number(head.headers.get('content-length') || 0);
    document.getElementById('meta').textContent = size ? (size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB') : '';
    mv.src = '/' + file + '?t=' + Date.now(); mv.hidden = false; empty.hidden = true;
  }
  mv.addEventListener('error', () => { empty.hidden = false; empty.textContent = 'This file could not be shown as a model.'; });
  new EventSource('/events').addEventListener('change', load);
  load();
</script>`

function safe(rel) { const full = normalize(join(workspace, rel)); return full === workspace || full.startsWith(workspace + sep) ? full : null }
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  const full = path === '/vendor/model-viewer.min.js' ? BUNDLE : safe(path.replace(/^\/+/, ''))
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const size = statSync(full).size, type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': full === BUNDLE ? 'max-age=3600' : 'no-store' }); createReadStream(full).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`[model-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules') || /-frames\//.test(n)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 300)
  })
} catch (error) { console.log(`[model-viewer] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
