// The RDKit pane's server. Harness runs it (viewer.sh) with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE and
// opens /?file=<the verdict's SDF>. It serves the pane (pane/), 3Dmol.js from this package's own
// node_modules (never a CDN), the workspace's files, and three small APIs:
//
//   /api/series?dir=out          every molecule in that folder: series.json, plus any SDF it does not list
//   /api/molecule?path=out/x.sdf the molecule's record — <name>.molecule.json when the toolchain wrote a
//                                fresh one, otherwise computed by `harness_rdkit.py serve` (a Python worker
//                                with the package's RDKit), so SDFs written by hand still get charges,
//                                groups, a depiction and a parent
//   /api/mol?path=out/x.sdf      the first record as a MOL file, for download
//   /events                      server-sent `change` (the files that changed) and `progress` (out/.progress.json)
//
// Read-only: nothing here writes into the workspace. Any path outside the workspace is refused.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.sdf': 'chemical/x-mdl-sdfile',
  '.mol': 'chemical/x-mdl-molfile', '.mol2': 'chemical/x-mol2', '.pdb': 'chemical/x-pdb', '.xyz': 'chemical/x-xyz',
  '.smi': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}
const PANE = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' }
const VENDOR = { '3Dmol-min.js': join(here, 'node_modules/3dmol/build/3Dmol-min.js') }
const STRUCTURE = new Set(['.sdf', '.mol', '.pdb', '.mol2'])

function safe(rel) {
  const full = normalize(join(workspace, String(rel || '').replace(/^\/+/, '')))
  return full === workspace || full.startsWith(workspace + sep) ? full : null
}
function stat(full) { try { return statSync(full) } catch { return null } }
function readJson(full) { try { return JSON.parse(readFileSync(full, 'utf8')) } catch { return null } }
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
function file(req, res, full, { download = false, cache = false } = {}) {
  const st = full && stat(full)
  if (!st || !st.isFile()) { send(res, 404, { error: 'not found' }); return }
  const headers = { 'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': cache ? 'max-age=3600' : 'no-store' }
  if (download) headers['content-disposition'] = `attachment; filename="${basename(full).replace(/"/g, '')}"`
  if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'content-length': st.size }); res.end(); return }
  res.writeHead(200, headers); res.end(readFileSync(full))
}

// ---- the Python worker: one long-lived `harness_rdkit.py serve`, started on the first question ----
function pythonPath() {
  for (const candidate of [process.env.RDKIT_PYTHON, process.env.HARNESS_DSH_DIR && join(process.env.HARNESS_DSH_DIR, '.venv/bin/python'), join(here, '.venv/bin/python')]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}
let worker = null
let nextId = 1
const pending = new Map()
function startWorker() {
  const python = pythonPath()
  if (!python) return null
  const child = spawn(python, ['-u', join(here, 'toolchain/harness_rdkit.py'), 'serve'], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: join(here, 'toolchain'), PYTHONDONTWRITEBYTECODE: '1' },
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      let reply; try { reply = JSON.parse(line) } catch { continue }
      const waiter = pending.get(reply.id); if (!waiter) continue
      pending.delete(reply.id)
      reply.ok ? waiter.resolve(reply.result) : waiter.reject(new Error(reply.error || 'describe failed'))
    }
  })
  child.stderr.on('data', (chunk) => { const text = String(chunk).trim(); if (text) console.log(`[rdkit] worker: ${text.slice(0, 300)}`) })
  child.on('exit', () => {
    if (worker === child) worker = null
    for (const [id, waiter] of pending) { pending.delete(id); waiter.reject(new Error('the RDKit worker stopped')) }
  })
  return child
}
function ask(op, payload) {
  if (!worker) worker = startWorker()
  if (!worker) return Promise.reject(new Error('RDKit is not installed for the pane (run toolchain/setup.sh)'))
  const id = nextId++
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolve: resolvePromise, reject })
    worker.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
    setTimeout(() => { if (pending.delete(id)) reject(new Error('RDKit took longer than 60 s')) }, 60_000).unref()
  })
}

// ---- molecules ----------------------------------------------------------------------------------
const described = new Map() // abs path → { key, promise }
function stemOf(name) { return name.endsWith('.conformers.sdf') ? name.slice(0, -'.conformers.sdf'.length) : name.replace(/\.[^.]+$/, '') }
function sha1(full) { try { return createHash('sha1').update(readFileSync(full)).digest('hex') } catch { return null } }

async function molecule(rel) {
  const full = safe(rel)
  const st = full && stat(full)
  if (!st || !st.isFile() || !STRUCTURE.has(extname(full).toLowerCase())) throw Object.assign(new Error(`${rel} is not there`), { code: 404 })
  const stem = stemOf(basename(full))
  const main = join(dirname(full), `${stem}.sdf`)
  const sidecar = join(dirname(full), `${stem}.molecule.json`)
  const record = readJson(sidecar)
  if (record && record.spec === 'rdkit-molecule/1' && (!record.sdfSha1 || record.sdfSha1 === sha1(existsSync(main) ? main : full))) {
    const svg = join(dirname(full), record.svg || `${stem}.svg`)
    try { record.svgText = readFileSync(svg, 'utf8') } catch { /* the depiction is optional */ }
    record.computedBy = 'toolchain'
    return record
  }
  const ensemble = join(dirname(full), `${stem}.conformers.sdf`)
  const key = [full, ensemble].map((p) => { const s = stat(p); return s ? `${s.mtimeMs}:${s.size}` : '-' }).join('|')
  const cached = described.get(full)
  if (cached && cached.key === key) return cached.promise
  const promise = ask('describe', { path: full })
  described.set(full, { key, promise })
  promise.catch(() => { if (described.get(full)?.promise === promise) described.delete(full) })
  return promise
}

function series(dirRel) {
  const dir = safe(dirRel)
  const st = dir && stat(dir)
  if (!st || !st.isDirectory()) return { dir: dirRel, molecules: [] }
  const index = readJson(join(dir, 'series.json'))
  const listed = Array.isArray(index?.molecules) ? index.molecules.filter((m) => m && m.name) : []
  const out = []
  const seen = new Set()
  for (const entry of listed) {
    const sdf = join(dir, entry.sdf || `${entry.name}.sdf`)
    const s = stat(sdf)
    if (!s) continue
    seen.add(basename(sdf))
    const fresh = !entry.legacy && Date.parse(entry.updatedAt || 0) >= s.mtimeMs - 60_000
    out.push({ ...entry, sdf: rel(sdf), mtime: s.mtimeMs, stale: !fresh, legacy: !!entry.legacy || !entry.properties })
  }
  let names = []
  try { names = readdirSync(dir) } catch { /* empty */ }
  const stems = new Set(out.map((m) => m.name))
  const rank = (name) => ['.sdf', '.mol', '.mol2', '.pdb'].indexOf(extname(name).toLowerCase())
  for (const name of names.filter((n) => rank(n) >= 0).sort((a, b) => rank(a) - rank(b))) {
    if (name.startsWith('.') || name.endsWith('.conformers.sdf') || seen.has(name) || stems.has(stemOf(name))) continue
    const s = stat(join(dir, name)); if (!s?.isFile()) continue
    stems.add(stemOf(name))
    const stamp = new Date(s.mtimeMs).toISOString()
    out.push({ name: stemOf(name), sdf: rel(join(dir, name)), createdAt: stamp, updatedAt: stamp, mtime: s.mtimeMs, legacy: true })
  }
  out.sort((a, b) => (Date.parse(a.createdAt) || a.mtime) - (Date.parse(b.createdAt) || b.mtime))
  return { dir: dirRel, molecules: out }
}
function rel(full) { return relative(workspace, full).split(sep).join('/') }

function newestStructure() {
  let best = null
  const walk = (dir, depth) => {
    if (depth > 4) return
    let names; try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name.startsWith('.') || ['node_modules', '__pycache__', '.venv', 'molecules'].includes(name)) continue
      const full = join(dir, name); const s = stat(full); if (!s) continue
      if (s.isDirectory()) walk(full, depth + 1)
      else if (STRUCTURE.has(extname(name).toLowerCase()) && !name.endsWith('.conformers.sdf') && (!best || s.mtimeMs > best.mtime)) best = { path: rel(full), mtime: s.mtimeMs }
    }
  }
  walk(workspace, 0)
  return best?.path ?? null
}

function progressIn(dirRel) {
  const full = safe(`${dirRel || 'out'}/.progress.json`)
  const p = full && readJson(full)
  if (!p) return null
  if (!['done', 'failed'].includes(p.stage)) {
    let alive = true
    try { if (p.pid) process.kill(p.pid, 0) } catch (error) { alive = error.code === 'EPERM' }
    if (!alive || Date.now() / 1000 - (p.at || 0) > 1800) p.stage = 'stopped'
  }
  return p
}

function molBlock(text) {
  const end = text.indexOf('M  END')
  return end < 0 ? text : text.slice(0, end) + 'M  END\n'
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  try {
    if (PANE[path]) { file(req, res, join(here, 'pane', PANE[path])); return }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (path.startsWith('/vendor/')) { file(req, res, VENDOR[path.slice('/vendor/'.length)] ?? null, { cache: true }); return }
    if (path === '/api/series') {
      const dirRel = url.searchParams.get('dir') || dirname(newestStructure() || 'out/x.sdf')
      send(res, 200, { ...series(dirRel), progress: progressIn(dirRel), newest: newestStructure(), python: !!pythonPath() }); return
    }
    if (path === '/api/molecule') {
      try { send(res, 200, await molecule(url.searchParams.get('path'))) }
      catch (error) { send(res, error.code === 404 ? 404 : 422, { error: error.message }) }
      return
    }
    if (path === '/api/mol') {
      const full = safe(url.searchParams.get('path'))
      if (!full || !stat(full)?.isFile()) { send(res, 404, { error: 'not found' }); return }
      res.writeHead(200, { 'content-type': 'chemical/x-mdl-molfile', 'content-disposition': `attachment; filename="${stemOf(basename(full))}.mol"`, 'cache-control': 'no-store' })
      res.end(molBlock(readFileSync(full, 'utf8'))); return
    }
    file(req, res, safe(path), { download: url.searchParams.has('download') })
  } catch (error) {
    send(res, 500, { error: String(error?.message || error) })
  }
}).listen(port, '127.0.0.1', () => console.log(`[rdkit] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// ---- live: tell the pane which files changed, and what the toolchain is doing ----------------------
let changed = new Set()
let timer = null
function broadcast(event, data) { for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '').split(sep).join('/')
    if (!n || n.startsWith('.harness') || n.includes('node_modules') || n.includes('__pycache__') || n.startsWith('.git/')) return
    if (n.endsWith('.progress.json')) {
      const dirRel = dirname(n)
      setTimeout(() => broadcast('progress', { dir: dirRel, progress: progressIn(dirRel) }), 20)
      return
    }
    if (basename(n).startsWith('.') && n.endsWith('.tmp')) return
    changed.add(n)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { const files = [...changed]; changed = new Set(); timer = null; broadcast('change', { files }) }, 180)
  })
} catch (error) { console.log(`[rdkit] watch failed: ${error.message}`) }
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
function stop() { try { worker?.kill() } catch { /* gone */ } process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
