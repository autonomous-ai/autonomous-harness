// The Strudel pane: Strudel's own REPL as a web component, playing the .strudel file named by ?file=
// (workspace-relative) and hot-swapping the pattern the moment the file changes — without stopping the
// transport, so a save lands on the next cycle instead of restarting the track. Strudel comes from this
// package's node_modules (`@strudel/repl`, as npm publishes it), never from a CDN, so the pane works
// offline. Any other path is a file from the workspace, never outside it.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.strudel': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }
// The whole dist directory: index.js is the script-tag build, and it resolves its audio clock worker
// relative to its own URL (dist/assets/clockworker-*.js), so the siblings have to be reachable too.
const VENDOR = join(here, 'node_modules/@strudel/repl/dist')

const page = `<!doctype html><meta charset="utf-8"><title>Strudel</title>
<style>
  :root { color-scheme: dark; --bg: #0e0e11; --panel: #16161a; --line: #2a2a31; --dim: #8e8e99; --fg: #e8e8ee; --hot: #f0b429; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 12px -apple-system, system-ui, sans-serif; overflow: hidden; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 44px; display: flex; gap: 10px; align-items: center; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--line); z-index: 6; }
  button { font: inherit; font-weight: 600; color: #0e0e11; background: var(--hot); border: 0; border-radius: 6px; padding: 7px 16px; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  button[disabled] { opacity: .4; cursor: default; filter: none; }
  #name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .dim { color: var(--dim); }
  #hint { color: var(--hot); }
  #hint.bad { color: #ff6b6b; }
  #wrap { position: absolute; top: 44px; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; }
  /* The component inserts the CodeMirror root as its own next sibling, so both live in #editor: the
     element itself is an empty marker, the div after it is the editor and takes the height. */
  #editor { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  #editor strudel-editor { display: none; }
  #editor > div { flex: 1 1 auto; min-height: 0; overflow: auto; }
  #editor .cm-editor { height: 100%; }
  #src { flex: 0 0 auto; max-height: 38%; display: flex; flex-direction: column; border-top: 1px solid var(--line); background: var(--panel); }
  #src h2 { margin: 0; padding: 7px 12px; font: 600 11px/1 -apple-system, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line); display: flex; gap: 8px; }
  #src pre { margin: 0; padding: 10px 12px; overflow: auto; font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9c9d4; white-space: pre; }
  #empty { position: absolute; inset: 44px 0 0 0; display: grid; place-items: center; text-align: center; color: var(--dim); padding: 24px; z-index: 4; background: var(--bg); }
</style>
<div id="bar">
  <button id="play">▶ Play</button>
  <button id="stop" class="ghost" disabled>■ Stop</button>
  <span id="name" class="dim">…</span>
  <span id="hint">Click Play to hear it — the browser only starts audio on a click.</span>
</div>
<div id="wrap">
  <div id="editor"></div>
  <div id="src"><h2><span id="srcname">track</span><span class="dim" id="srcmeta"></span></h2><pre id="srctext"></pre></div>
</div>
<div id="empty">No track yet. The pane plays the .strudel file the harness writes.</div>
<script>
  // Strudel's REPL preloads sample banks from the network (dough-samples on GitHub). Nothing here
  // needs them — synth patterns are the offline path — but its prebake awaits them all before the
  // first evaluation, so one failed fetch would mean no sound at all. Let those cross-origin fetches
  // fall back to an empty sample map, and say in the bar that banks are unavailable.
  window.__strudelOffline = false;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    try { return await realFetch(input, init); } catch (error) {
      if (/^https?:\\/\\//.test(url) && !url.startsWith(location.origin)) {
        window.__strudelOffline = true;
        window.dispatchEvent(new CustomEvent('strudel-offline'));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw error;
    }
  };
</script>
<script src="/vendor/index.js"></script>
<script>
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || 'track.strudel';
  const empty = document.getElementById('empty');
  const hint = document.getElementById('hint');
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const HINT = 'Click Play to hear it — the browser only starts audio on a click.';
  let el = null, started = false, code = null, loaded = false;

  const editor = () => (el && el.editor) || null;

  function say(text, bad) { hint.textContent = text; hint.classList.toggle('bad', !!bad); }
  function buttons() {
    playBtn.textContent = started ? '▶ Replay' : '▶ Play';
    stopBtn.disabled = !started;
  }
  function mount(text) {
    el = document.createElement('strudel-editor');
    el.setAttribute('code', text);
    el.addEventListener('update', (e) => {
      const state = e.detail || {};
      started = !!state.started;
      buttons();
      if (state.error) say(String(state.error.message || state.error), true);
      else if (window.__strudelOffline) say('Offline: sample banks are unavailable, synths still play.', false);
      else if (started) say('Playing — a save hot-swaps the pattern on the next cycle.');
      else say(HINT);
    });
    document.getElementById('editor').append(el);
  }
  async function load() {
    let text;
    try {
      const res = await fetch('/' + file + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 404 ? 'not there yet' : 'HTTP ' + res.status);
      text = await res.text();
    } catch (error) {
      empty.hidden = false;
      empty.textContent = file + ' is not there yet (' + error.message + ').';
      return;
    }
    empty.hidden = true;
    document.getElementById('name').textContent = file;
    document.getElementById('srcname').textContent = file;
    const lines = text.split('\\n').length;
    document.getElementById('srcmeta').textContent = lines + ' line' + (lines === 1 ? '' : 's') + ' · ' + text.length + ' bytes';
    document.getElementById('srctext').textContent = text;
    if (text === code) return;
    code = text;
    if (!loaded) { loaded = true; mount(text); return; }
    // Hot swap: setCode through the observed attribute, then re-evaluate only if we are already
    // playing, so the transport keeps running and the new pattern lands on the next cycle. If we are
    // stopped, the new code just sits in the editor waiting for Play — no audio without a gesture.
    el.setAttribute('code', text);
    const ed = editor();
    if (started && ed) ed.evaluate();
  }

  playBtn.addEventListener('click', () => { const ed = editor(); if (ed) ed.evaluate(); else say('Still loading…'); });
  stopBtn.addEventListener('click', () => { const ed = editor(); if (ed) ed.stop(); });
  window.addEventListener('strudel-offline', () => { if (!hint.classList.contains('bad')) say('Offline: sample banks are unavailable, synths still play.'); });
  new EventSource('/events').addEventListener('change', load);
  load();
</script>`

function safe(root, rel) { const full = normalize(join(root, rel)); return full === root || full.startsWith(root + sep) ? full : null }
function send(res, full, req) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': full.startsWith(VENDOR) ? 'max-age=3600' : 'no-store' }); res.end(readFileSync(full))
}
createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return }
  if (path === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return }
  if (path.startsWith('/vendor/')) { send(res, safe(VENDOR, path.slice('/vendor/'.length)), req); return }
  send(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[strudel] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) { console.log(`[strudel] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
