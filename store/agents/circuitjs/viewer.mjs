// The CircuitJS pane: Paul Falstad's CircuitJS1, running, in an iframe, showing the circuit file
// named by ?file= (workspace-relative). Everything is served off loopback from this package —
// the compiled app from upstream/war (fetched by toolchain/setup.sh, never vendored), the circuit
// from the workspace — so the pane works offline and the iframe is same-origin, which is what
// CircuitJS1's JavaScript interface requires.
//
// The trick that makes it live: the app is loaded once, with ?startCircuit= pointed at a virtual
// path that resolves to the workspace file. After that a change on disk is an SSE `change`, and the
// page re-imports the text through CircuitJS1.importCircuit() — no reload, no flash, the app keeps
// its window, its menus and its run state. The sim stays fully editable: poking at it is the point.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const war = join(here, 'upstream', 'war')
const clients = new Set()

// Where the GWT app asks for a named setup file: moduleBase + "circuits/" + startCircuit. One name
// under it is ours, and the rest of it resolves under the workspace.
const SETUP = '/app/circuitjs1/circuits/__workspace__/'
const BLANK = '$ 1 0.000005 10.20027730826997 50 5 43 5e-11\n'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.xml': 'text/xml',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.wav': 'audio/wav', '.ico': 'image/x-icon',
}

// circuitjs.html as upstream ships it, minus two things that only make sense on falstad.com: a web
// app manifest at an absolute /circuit/ path, and a service worker that would cache files we are
// already serving from disk (and would hand back a stale app after an upstream bump). The file on
// disk is untouched; this is a serving-time edit, and nothing else of CircuitJS1 is changed.
let shell = null
function appShell() {
  if (shell) return shell
  const raw = readFileSync(join(war, 'circuitjs.html'), 'utf8')
  shell = raw
    .replace('<link rel="manifest" href="/circuit/manifest.json">', '<link rel="manifest" href="manifest.json">')
    .replace(/<script>\s*if \('serviceWorker' in navigator\)[\s\S]*?<\/script>/, '')
  return shell
}

const page = `<!doctype html><meta charset="utf-8"><title>CircuitJS</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #1c1c1e; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 10px; align-items: center; padding: 0 10px; background: #1c1c1e; border-bottom: 1px solid #333; z-index: 5; }
  #bar .muted { color: #8e8e93; }
  #bar .grow { flex: 1; }
  #bar button { font: inherit; color: #e5e5ea; background: #2c2c2e; border: 1px solid #3a3a3c; border-radius: 4px; padding: 2px 9px; cursor: pointer; }
  #bar button:hover { background: #3a3a3c; }
  #name { font-weight: 600; }
  #t { font-variant-numeric: tabular-nums; }
  #sim { position: absolute; top: 30px; left: 0; right: 0; bottom: 0; width: 100%; height: calc(100% - 30px); border: 0; background: #fff; }
  #note { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; text-align: center; padding: 0 16px; color: #8e8e93; background: #1c1c1e; z-index: 4; }
</style>
<div id="bar">
  <span id="name">…</span>
  <span class="muted" id="count"></span>
  <span class="muted" id="t"></span>
  <span class="grow"></span>
  <button id="run" type="button">Pause</button>
  <button id="reload" type="button">Reload</button>
  <span class="muted">CircuitJS1 · Paul Falstad</span>
</div>
<iframe id="sim" title="CircuitJS1"></iframe>
<div id="note">Loading CircuitJS1…</div>
<script>
  const file = new URLSearchParams(location.search).get('file') || 'circuit.txt';
  const frame = document.getElementById('sim');
  const note = document.getElementById('note');
  const runBtn = document.getElementById('run');
  document.getElementById('name').textContent = file;
  frame.src = '/app/circuitjs.html?startCircuit=__workspace__/' + file.split('/').map(encodeURIComponent).join('/') + '&running=true';

  let sim = null;
  const si = (v) => {
    const a = Math.abs(v);
    if (a >= 1) return v.toFixed(3) + ' s';
    if (a >= 1e-3) return (v * 1e3).toFixed(3) + ' ms';
    if (a >= 1e-6) return (v * 1e6).toFixed(3) + ' µs';
    return (v * 1e9).toFixed(0) + ' ns';
  };
  function refresh() {
    if (!sim) return;
    let n = 0;
    try { n = sim.getElements().length; } catch (e) {}
    document.getElementById('count').textContent = n + ' element' + (n === 1 ? '' : 's');
    try { document.getElementById('t').textContent = 't = ' + si(sim.getTime()); } catch (e) {}
    try { runBtn.textContent = sim.isRunning() ? 'Pause' : 'Run'; } catch (e) {}
  }
  function ready(s) {
    if (sim === s) return;
    sim = s;
    note.hidden = true;
    s.onanalyze = refresh;
    refresh();
  }
  // The hook has to be on the iframe's window before its GWT module finishes booting, and the
  // window is replaced on every navigation, so plant it (and check for a sim that beat us) on a
  // short poll rather than once.
  setInterval(() => {
    let w = null;
    try { w = frame.contentWindow; } catch (e) { return; }
    if (!w) return;
    if (w.CircuitJS1) ready(w.CircuitJS1);
    else { try { w.oncircuitjsloaded = ready; } catch (e) {} }
  }, 120);
  setInterval(refresh, 250);

  async function load() {
    if (!sim) return;                       // the first load is ?startCircuit='s job
    let text;
    try {
      const res = await fetch('/' + file.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      text = await res.text();
    } catch (e) { return; }
    const running = sim.isRunning();
    sim.importCircuit(text, false);
    sim.setSimRunning(running);
    refresh();
  }
  runBtn.addEventListener('click', () => { if (sim) { sim.setSimRunning(!sim.isRunning()); refresh(); } });
  document.getElementById('reload').addEventListener('click', load);
  new EventSource('/events').addEventListener('change', load);
</script>`

function safe(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}
function send(res, body, type, cache) {
  res.writeHead(200, { 'content-type': type, 'cache-control': cache })
  res.end(body)
}
function sendFile(res, full, req) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  send(res, readFileSync(full), type, full.startsWith(war) ? 'max-age=3600' : 'no-store')
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { send(res, page, 'text/html; charset=utf-8', 'no-store'); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  // The app asking for its start circuit: the workspace file, or a valid empty circuit when the
  // agent has not written it yet — a 404 here is an alert box in the user's face.
  if (path.startsWith(SETUP)) {
    const full = safe(workspace, path.slice(SETUP.length))
    if (full && existsSync(full) && statSync(full).isFile()) { sendFile(res, full, req); return }
    send(res, BLANK, TYPES['.txt'], 'no-store'); return
  }
  if (path === '/app/circuitjs.html') { send(res, appShell(), TYPES['.html'], 'no-store'); return }
  if (path.startsWith('/app/')) { sendFile(res, safe(war, path.slice('/app/'.length)), req); return }
  sendFile(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[circuitjs] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '')
    if (!n || n.startsWith('.harness') || n.startsWith('.git')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) { console.log(`[circuitjs] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
