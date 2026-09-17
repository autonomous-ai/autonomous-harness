// The RDKit pane: 3Dmol.js showing the conformer named by ?file= (workspace-relative .sdf/.mol/.pdb),
// with the molecule's properties beside it and its 2D depiction in the corner, redrawn the moment any
// of them changes. 3Dmol.js comes from this package's node_modules (its UMD build), never from a CDN,
// so the pane works offline. Any other path is a file from the workspace, never outside it.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.sdf': 'chemical/x-mdl-sdfile', '.mol': 'chemical/x-mdl-molfile',
  '.mol2': 'chemical/x-mol2', '.pdb': 'chemical/x-pdb', '.xyz': 'chemical/x-xyz', '.smi': 'text/plain',
}
const VENDOR = { '3Dmol-min.js': join(here, 'node_modules/3dmol/build/3Dmol-min.js') }

const page = `<!doctype html><meta charset="utf-8"><title>RDKit</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: #0e0e11; color: #e5e5ea; font: 12px -apple-system, system-ui, sans-serif; overflow: hidden; }
  #bar { position: absolute; top: 0; left: 0; right: 0; height: 30px; display: flex; gap: 10px; align-items: center; padding: 0 12px; background: #1c1c1e; border-bottom: 1px solid #333; z-index: 5; }
  #bar .muted { color: #8e8e93; }
  #bar .grow { flex: 1; }
  #formula sub { font-size: 9px; }
  button { appearance: none; background: #2c2c2e; color: #e5e5ea; border: 1px solid #3a3a3c; border-radius: 5px; padding: 3px 9px; font: inherit; cursor: pointer; }
  button:hover { background: #3a3a3c; }
  button[aria-pressed="true"] { background: #0a84ff; border-color: #0a84ff; color: #fff; }
  #app { position: absolute; top: 30px; left: 0; right: 0; bottom: 0; }
  #props { position: absolute; top: 42px; right: 12px; width: 186px; padding: 9px 11px; background: rgba(28,28,30,.86); border: 1px solid #333; border-radius: 8px; z-index: 4; backdrop-filter: blur(6px); }
  #props h2 { margin: 0 0 6px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #8e8e93; font-weight: 600; }
  #props .row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
  #props .row span:first-child { color: #8e8e93; }
  #props .row b { font-weight: 500; font-variant-numeric: tabular-nums; }
  #props .lipinski { margin-top: 7px; padding-top: 7px; border-top: 1px solid #333; color: #8e8e93; }
  #props .lipinski.bad { color: #ff9f0a; }
  #thumb { position: absolute; left: 12px; bottom: 12px; width: 190px; padding: 6px; background: #fff; border-radius: 8px; border: 1px solid #333; z-index: 4; }
  #thumb img { display: block; width: 100%; }
  #empty { position: absolute; inset: 30px 0 0 0; display: grid; place-items: center; color: #8e8e93; padding: 0 24px; text-align: center; }
  @media (max-width: 560px) { #props, #thumb { display: none; } }
</style>
<div id="bar">
  <span id="name">…</span><span class="muted" id="formula"></span><span class="grow"></span>
  <button id="spin" aria-pressed="false">Spin</button>
  <button id="surface" aria-pressed="false">Surface</button>
</div>
<div id="app"></div>
<div id="props" hidden><h2>Properties</h2><div id="rows"></div><div class="lipinski" id="lipinski"></div></div>
<div id="thumb" hidden><img id="thumbimg" alt="2D depiction"></div>
<div id="empty">No conformer yet. The pane shows the newest <code>out/*.sdf</code> the harness writes.</div>
<script src="/vendor/3Dmol-min.js"></script>
<script>
  const Mol = window.$3Dmol || window['3Dmol'];
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || '';
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const stem = file.slice(dir.length).replace(/\\.[^.]+$/, '');
  const FORMAT = { sdf: 'sdf', mol: 'sdf', pdb: 'pdb', xyz: 'xyz', mol2: 'mol2' };
  const empty = document.getElementById('empty');
  const spin = document.getElementById('spin');
  const surface = document.getElementById('surface');
  let viewer = null, framed = false, lastText = null;

  // Stick and ball, Jmol's element colours — the way a chemist expects a small molecule to look.
  const STYLE = { stick: { radius: 0.13, colorscheme: 'Jmol' }, sphere: { scale: 0.26, colorscheme: 'Jmol' } };

  function subscripted(formula) {
    return String(formula || '').replace(/([0-9]+)/g, '<sub>$1</sub>');
  }
  function paintSurface() {
    if (!viewer) return;
    viewer.removeAllSurfaces();
    if (surface.getAttribute('aria-pressed') === 'true') {
      // The VDW surface is marching cubes in a worker; a molecule the size of a protein can take a
      // moment, and a browser that refuses the worker must not take the rest of the pane with it.
      try {
        const done = viewer.addSurface(Mol.SurfaceType.VDW, { opacity: 0.6, color: '#8ab4ff' });
        if (done && done.catch) done.catch(() => surface.setAttribute('aria-pressed', 'false'));
      } catch { surface.setAttribute('aria-pressed', 'false'); }
    }
    viewer.render();
  }
  async function structure() {
    const res = await fetch('/' + file + '?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty');
    return text;
  }
  async function facts() {
    try {
      const res = await fetch('/' + dir + 'properties.json?t=' + Date.now());
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }
  function panel(p) {
    const box = document.getElementById('props');
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    const rows = [['MW', p.mw], ['cLogP', p.logp], ['TPSA', p.tpsa], ['HBD', p.hbd], ['HBA', p.hba],
                  ['Rot. bonds', p.rotatable_bonds], ['Rings', p.rings], ['QED', p.qed]];
    document.getElementById('rows').innerHTML = rows
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => '<div class="row"><span>' + k + '</span><b>' + v + '</b></div>').join('');
    const n = p.lipinski_violations || 0;
    const lip = document.getElementById('lipinski');
    lip.className = 'lipinski' + (n ? ' bad' : '');
    lip.textContent = n ? 'Lipinski: ' + (p.lipinski || []).join(', ') : 'Lipinski: passes all four';
  }
  async function load() {
    if (!file) return;
    let text;
    try { text = await structure(); }
    catch (e) { empty.hidden = false; empty.textContent = file + ' is not there yet (' + e.message + ').'; return; }
    empty.hidden = true;
    const props = await facts();
    document.getElementById('name').textContent = (props && props.name) || stem || file;
    document.getElementById('formula').innerHTML = subscripted(props && props.formula);
    panel(props);
    const thumb = document.getElementById('thumb');
    const img = document.getElementById('thumbimg');
    img.onerror = () => { thumb.hidden = true; };
    img.onload = () => { thumb.hidden = false; };
    img.src = '/' + dir + stem + '.png?t=' + Date.now();
    if (text === lastText) return;
    lastText = text;
    if (!viewer) viewer = Mol.createViewer(document.getElementById('app'), { backgroundColor: '#0e0e11' });
    viewer.removeAllSurfaces();
    viewer.removeAllLabels();
    viewer.removeAllModels();
    viewer.addModel(text, FORMAT[(file.split('.').pop() || '').toLowerCase()] || 'sdf');
    viewer.setStyle({}, STYLE);
    if (!framed) { viewer.zoomTo(); framed = true; }
    viewer.render();
    paintSurface();
    viewer.spin(spin.getAttribute('aria-pressed') === 'true');
  }
  function toggle(button, after) {
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      after();
    });
  }
  toggle(spin, () => viewer && viewer.spin(spin.getAttribute('aria-pressed') === 'true'));
  toggle(surface, paintSurface);
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
  if (path.startsWith('/vendor/')) { file(res, VENDOR[path.slice('/vendor/'.length)] ?? null, req); return }
  file(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[rdkit] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? ''); if (!n || n.startsWith('.harness') || n.includes('node_modules') || n.includes('__pycache__')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) { console.log(`[rdkit] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
