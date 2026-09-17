// The CircuitJS pane: Paul Falstad's CircuitJS1, running, in an iframe, showing the circuit file
// named by ?file= (workspace-relative). Everything is served off loopback from this package —
// the compiled app from upstream/war (fetched by toolchain/setup.sh, never vendored), the circuit
// from the workspace — so the pane works offline and the iframe is same-origin, which is what
// CircuitJS1's JavaScript interface requires.
//
// The trick that makes it live: the app boots on an empty circuit, and the page hands it the file
// through CircuitJS1.importCircuit(). A save on disk is an SSE `change`; the page fetches the file
// and, when its text actually changed, imports it again — no reload, no flash, the app keeps its
// window, its menus and its run state. The sim stays fully editable: poking at it is the point.
//
// Around the app, the page adds what a person watching an agent needs: a live status (updated,
// waiting, problems), the labeled nodes' voltages as they move, a readable account of lines the
// simulator could not load (the package's own checker, toolchain/verdict.py, plus the app's own
// load errors), and a legend for the colours, dots and controls.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const war = join(here, 'upstream', 'war')
const clients = new Set()

// The circuit the app boots on, before the page imports the workspace file: an options line and
// nothing else, so the canvas never flashes one of upstream's example circuits.
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

// The package's own checker, run on the text the page is about to import: the same judge the
// verdict uses, so the pane and the header never disagree about what is wrong with a line.
function check(text, rel) {
  return new Promise((ok) => {
    const code = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(join(here, 'toolchain'))})`,
      'from verdict import judge',
      'print(json.dumps(judge(sys.stdin.read(), sys.argv[1])))',
    ].join('\n')
    let out = ''
    let child
    try {
      child = spawn('python3', ['-c', code, rel], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch { ok(null); return }
    const timer = setTimeout(() => { child.kill(); ok(null) }, 10_000)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); ok(null) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const v = JSON.parse(out)
        ok({ findings: v.findings.filter((f) => f.severity === 'error' || (f.severity === 'warning' && ['slider_label', 'no_ground', 'zero_length'].includes(f.kind))) })
      } catch { ok(null) }
    })
    child.stdin.end(text)
  })
}

// Read per request: it is small, and a package update then needs no pane restart.
const page = () => readFileSync(join(here, 'viewer.html'), 'utf8').replace('__BLANK__', encodeURIComponent(BLANK))

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

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  if (path === '/') { send(res, page(), 'text/html; charset=utf-8', 'no-store'); return }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (path === '/__check' && req.method === 'POST') {
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 4e6) req.destroy() })
    req.on('end', async () => {
      const result = await check(body, url.searchParams.get('file') || 'circuit.txt')
      send(res, JSON.stringify(result ?? { findings: null }), 'application/json', 'no-store')
    })
    return
  }
  if (path === '/app/circuitjs.html') { send(res, appShell(), TYPES['.html'], 'no-store'); return }
  if (path.startsWith('/app/')) { sendFile(res, safe(war, path.slice('/app/'.length)), req); return }
  sendFile(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[circuitjs] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// Any change under the workspace is announced by name; the page decides whether it is its file and
// whether the text really changed, so a README or a verdict write never resets the simulation.
let timer = null
const changed = new Set()
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '').split(sep).join('/')
    if (!n || n.startsWith('.git') || n.startsWith('node_modules')) return
    changed.add(n)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const names = [...changed]; changed.clear()
      for (const c of clients) c.write(`event: change\ndata: ${JSON.stringify({ names })}\n\n`)
    }, 150)
  })
} catch (error) { console.log(`[circuitjs] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
