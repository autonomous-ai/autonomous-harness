// Video Viewer: one loopback server per pane. GET / plays the file named by ?file= (workspace-
// relative): a video element for mp4/webm/mov, an image for gif/png; reloaded the moment the file
// changes (a new render), with byte-range support so scrubbing works. GET /events is server-sent
// events; any other path is a file from the workspace, never outside it. No dependencies.
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { join, normalize, resolve, sep, extname } from 'node:path'

const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }

const page = `<!doctype html><meta charset="utf-8"><title>Video Viewer</title>
<style>
  :root { color-scheme: dark; }
  /* An id rule with its own display beats the UA's [hidden]; say it outright. */
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #000; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { display: flex; gap: 12px; align-items: center; padding: 6px 12px; background: #1c1c1e; border-bottom: 1px solid #333; }
  #bar .muted { color: #8e8e93; }
  #stage { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; }
  video, img { max-width: 100%; max-height: 100%; }
  #empty { color: #8e8e93; }
</style>
<div id="bar"><span id="name">…</span><span class="muted" id="meta"></span></div>
<div id="stage"><div id="empty">No render yet. The pane plays the video the harness renders.</div></div>
<script>
  const params = new URLSearchParams(location.search); const file = params.get('file') || '';
  const stage = document.getElementById('stage');
  async function load() {
    if (!file) return;
    const head = await fetch('/' + file, { method: 'HEAD' });
    if (!head.ok) { stage.innerHTML = '<div id="empty">' + file + ' is not there yet.</div>'; return; }
    document.getElementById('name').textContent = file;
    const size = Number(head.headers.get('content-length') || 0);
    const src = '/' + file + '?t=' + Date.now();
    const isImage = /\\.(gif|png|jpe?g)$/i.test(file);
    stage.innerHTML = isImage ? '<img src="' + src + '">' : '<video src="' + src + '" controls autoplay loop muted playsinline></video>';
    const v = stage.querySelector('video');
    const meta = () => document.getElementById('meta').textContent = [v && isFinite(v.duration) ? v.duration.toFixed(1) + ' s' : null, size ? (size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB') : null].filter(Boolean).join(' · ');
    if (v) v.addEventListener('loadedmetadata', meta); else meta();
  }
  new EventSource('/events').addEventListener('change', load);
  load();
</script>`

function safe(rel) { const full = normalize(join(workspace, rel)); return full === workspace || full.startsWith(workspace + sep) ? full : null }
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (url.pathname === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  const full = safe(decodeURIComponent(url.pathname).replace(/^\/+/, ''))
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const size = statSync(full).size, type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' }); res.end(); return }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
    createReadStream(full, { start, end }).pipe(res); return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }); createReadStream(full).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`[video-viewer] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules') || /partial_movie_files|\.tmp/.test(n)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 400)
  })
} catch (error) { console.log(`[video-viewer] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
