// The Excalidraw pane: Excalidraw's own editor, in view mode, showing the .excalidraw file named by
// ?file= (workspace-relative) and redrawn the moment it changes. React and Excalidraw come from this
// package's node_modules (UMD builds), never from a CDN, so the pane works offline. Any other path is
// a file from the workspace, never outside it.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.excalidraw': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const VENDOR = {
  'react.production.min.js': join(here, 'node_modules/react/umd/react.production.min.js'),
  'react-dom.production.min.js': join(here, 'node_modules/react-dom/umd/react-dom.production.min.js'),
  'excalidraw.production.min.js': join(here, 'node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js'),
}
const ASSETS = join(here, 'node_modules/@excalidraw/excalidraw/dist/excalidraw-assets')

const page = `<!doctype html><meta charset="utf-8"><title>Excalidraw</title>
<style>
  :root { color-scheme: dark; }
  /* An id rule with its own display beats the UA's [hidden]; say it outright. */
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #f8f9fa; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 12px; align-items: center; padding: 0 12px; background: #1c1c1e; border-bottom: 1px solid #333; z-index: 5; }
  #bar .muted { color: #8e8e93; }
  #app { position: absolute; top: 30px; left: 0; right: 0; bottom: 0; }
  #empty { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; color: #8e8e93; }
</style>
<div id="bar"><span id="name">…</span><span class="muted" id="meta"></span></div>
<div id="app"></div>
<div id="empty">No diagram yet. The pane shows the .excalidraw file the harness writes.</div>
<script>window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw-assets/';</script>
<script src="/vendor/react.production.min.js"></script>
<script src="/vendor/react-dom.production.min.js"></script>
<script src="/vendor/excalidraw.production.min.js"></script>
<script>
  const params = new URLSearchParams(location.search); const file = params.get('file') || '';
  const empty = document.getElementById('empty');
  let api = null, root = null;
  async function scene() {
    const res = await fetch('/' + file + '?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (data.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('not an excalidraw file');
    return data;
  }
  function describe(data) {
    const live = data.elements.filter((e) => !e.isDeleted);
    document.getElementById('name').textContent = file;
    document.getElementById('meta').textContent = live.length + ' element' + (live.length === 1 ? '' : 's');
  }
  async function load() {
    if (!file) return;
    let data;
    try { data = await scene(); } catch (e) { empty.hidden = false; empty.textContent = file + ' is not there yet (' + e.message + ').'; return; }
    empty.hidden = true; describe(data);
    // The scene's own canvas colour; Excalidraw's dark theme is an inversion filter, so the file is
    // shown in the light theme exactly as its colours were written.
    const appState = { ...(data.appState || {}), viewBackgroundColor: (data.appState && data.appState.viewBackgroundColor) || '#f8f9fa', collaborators: new Map() };
    if (api) {
      api.updateScene({ elements: data.elements, appState });
      if (data.files) api.addFiles(Object.values(data.files));
      setTimeout(() => api.scrollToContent(undefined, { fitToContent: true, animate: false }), 30);
      return;
    }
    root = ReactDOM.createRoot(document.getElementById('app'));
    root.render(React.createElement(ExcalidrawLib.Excalidraw, {
      initialData: { elements: data.elements, appState: { ...appState, zenModeEnabled: true }, files: data.files || {}, scrollToContent: true },
      viewModeEnabled: true, zenModeEnabled: true, theme: 'light', UIOptions: { canvasActions: { toggleTheme: false } },
      excalidrawAPI: (a) => { api = a; },
    }));
  }
  new EventSource('/events').addEventListener('change', load);
  load();
</script>`

function safe(root, rel) { const full = normalize(join(root, rel)); return full === root || full.startsWith(root + sep) ? full : null }
function file(res, full, req) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': full.startsWith(here) ? 'max-age=3600' : 'no-store' }); res.end(readFileSync(full))
}
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  if (path.startsWith('/vendor/excalidraw-assets/')) { file(res, safe(ASSETS, path.slice('/vendor/excalidraw-assets/'.length)), req); return }
  if (path.startsWith('/vendor/')) { file(res, VENDOR[path.slice('/vendor/'.length)] ?? null, req); return }
  file(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[excalidraw] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) { console.log(`[excalidraw] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
