// Doc Viewer: one loopback server per pane. GET / renders the PDF named by ?file= (workspace-
// relative) page by page with pdf.js — scrollable, zoomable, page count in the header — and
// re-renders it the moment the file changes, keeping the scroll position. pdf.js comes from this
// package's node_modules, never a CDN. GET /events is server-sent events; any other path is a file
// from the workspace, never outside it.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const VENDOR = {
  'pdf.min.mjs': join(here, 'node_modules/pdfjs-dist/build/pdf.min.mjs'),
  'pdf.worker.min.mjs': join(here, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
}
const TYPES = { '.pdf': 'application/pdf', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }

const page = `<!doctype html><meta charset="utf-8"><title>Doc Viewer</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #2c2c2e; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 12px; align-items: center; padding: 0 12px; background: #1c1c1e; border-bottom: 1px solid #333; z-index: 2; }
  #bar .muted { color: #8e8e93; }
  #bar .spacer { flex: 1; }
  #bar button { background: #3a3a3c; color: #e5e5ea; border: 0; border-radius: 6px; padding: 3px 9px; font: inherit; cursor: pointer; }
  #bar button:hover { background: #48484a; }
  #scroll { position: absolute; top: 30px; left: 0; right: 0; bottom: 0; overflow: auto; padding: 18px 0 40px; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  canvas.page { background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.45); border-radius: 2px; }
  #empty { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; color: #8e8e93; }
</style>
<div id="bar"><span id="name">…</span><span class="muted" id="meta"></span><span class="spacer"></span><button id="out" title="Zoom out">−</button><button id="fit" title="Fit width">Fit</button><button id="in" title="Zoom in">+</button></div>
<div id="scroll"><div id="pages"></div></div>
<div id="empty">No document yet. The pane shows the PDF the harness writes.</div>
<script type="module">
  import * as pdfjs from '/vendor/pdf.min.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const params = new URLSearchParams(location.search); const file = params.get('file') || '';
  const scroller = document.getElementById('scroll'), pages = document.getElementById('pages'), empty = document.getElementById('empty');
  let doc = null, zoom = null, rendering = 0;
  const fitScale = (p) => (scroller.clientWidth - 48) / p.getViewport({ scale: 1 }).width;
  async function render() {
    if (!doc) return;
    const token = ++rendering;
    const first = await doc.getPage(1);
    const scale = zoom ?? fitScale(first);
    const keep = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    pages.replaceChildren();
    const dpr = window.devicePixelRatio || 1;
    for (let n = 1; n <= doc.numPages; n++) {
      if (token !== rendering) return;
      const p = n === 1 ? first : await doc.getPage(n);
      const vp = p.getViewport({ scale });
      const c = document.createElement('canvas'); c.className = 'page';
      c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
      c.style.width = Math.floor(vp.width) + 'px'; c.style.height = Math.floor(vp.height) + 'px';
      pages.appendChild(c);
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    }
    scroller.scrollTop = keep * scroller.scrollHeight;
  }
  async function load() {
    if (!file) return;
    const head = await fetch('/' + file, { method: 'HEAD' });
    if (!head.ok) { empty.hidden = false; empty.textContent = file + ' is not there yet.'; return; }
    try {
      doc = await pdfjs.getDocument({ url: '/' + file + '?t=' + Date.now() }).promise;
    } catch (e) { empty.hidden = false; empty.textContent = file + ' could not be read (' + e.message + ').'; return; }
    empty.hidden = true;
    const size = Number(head.headers.get('content-length') || 0);
    document.getElementById('name').textContent = file;
    document.getElementById('meta').textContent = doc.numPages + ' page' + (doc.numPages === 1 ? '' : 's') + (size ? ' · ' + Math.max(1, Math.round(size / 1024)) + ' KB' : '');
    await render();
  }
  document.getElementById('in').onclick = async () => { zoom = (zoom ?? fitScale(await doc.getPage(1))) * 1.2; render(); };
  document.getElementById('out').onclick = async () => { zoom = (zoom ?? fitScale(await doc.getPage(1))) / 1.2; render(); };
  document.getElementById('fit').onclick = () => { zoom = null; render(); };
  let resize = null; window.addEventListener('resize', () => { if (zoom !== null) return; clearTimeout(resize); resize = setTimeout(render, 150); });
  new EventSource('/events').addEventListener('change', load);
  load();
</script>`

function safe(rel) { const full = normalize(join(workspace, rel)); return full === workspace || full.startsWith(workspace + sep) ? full : null }
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  const full = path.startsWith('/vendor/') ? (VENDOR[path.slice('/vendor/'.length)] ?? null) : safe(path.replace(/^\/+/, ''))
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const size = statSync(full).size, type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': path.startsWith('/vendor/') ? 'max-age=3600' : 'no-store' }); createReadStream(full).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`[doc-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    if (!name || String(name).startsWith('.harness') || String(name).includes('node_modules')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 250)
  })
} catch (error) { console.log(`[doc-viewer] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
