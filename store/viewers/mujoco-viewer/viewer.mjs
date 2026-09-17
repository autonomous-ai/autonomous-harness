// MuJoCo Viewer: one loopback server per pane. Dependency-free Node; everything it serves is local.
//
//   the page      GET /                    public/index.html; GET /static/… the rest of public/
//   the engine    GET /vendor/mujoco/…     MuJoCo's official WASM build   } from this package's
//                 GET /vendor/three/…      three.js                       } node_modules, never a CDN
//   files         GET /ws/…                a file from the harness's workspace (Range-aware: videos)
//                 GET /menagerie/…         a file from the harness's Menagerie checkout
//   the model     GET /api/resolve?file=…  what the pane should open: model, snapshot, rollout, video
//                 GET /api/files?model=…   every file that model needs, for MuJoCo's in-memory FS
//                 GET /api/models          MJCF in the workspace and the Menagerie robots, for the picker
//   liveness      GET /api/events          server-sent events: the workspace paths that just changed
//
// One namespace for model paths, the same one the rollout's `model` field uses: `menagerie/…` is a
// robot from the harness, anything else is workspace-relative.
import { createServer } from 'node:http'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
// The robots live with the harness that uses this viewer, not with the viewer: HARNESS_DSH_DIR is
// the harness's install dir even while this process runs in its own.
const dshDir = process.env.HARNESS_DSH_DIR ? resolve(process.env.HARNESS_DSH_DIR) : null
const menagerie = resolve(process.env.MENAGERIE || (dshDir ? join(dshDir, 'menagerie') : join(workspace, 'menagerie')))
const PUBLIC = join(here, 'public')
const VENDOR = { three: join(here, 'node_modules/three'), mujoco: join(here, 'node_modules/@mujoco/mujoco') }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.xml': 'text/xml', '.obj': 'text/plain', '.mtl': 'text/plain', '.py': 'text/plain',
  '.stl': 'application/octet-stream', '.msh': 'application/octet-stream', '.skn': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ppm': 'image/x-portable-pixmap', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.gif': 'image/gif',
}
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.harness', '.claude', '.agents', '.codex', 'dist', 'build', '.cache', 'menagerie'])
const ROLLOUT = 'out/rollout.qpos.json'
const REPORT = 'out/rollout.json'

// ─── Paths ──────────────────────────────────────────────────────────────────────────────────────

function safe(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

/** A namespace path → the file on disk, or null when it escapes both roots. */
function nsFile(path) {
  const clean = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean === 'menagerie') return menagerie
  if (clean.startsWith('menagerie/')) return safe(menagerie, clean.slice('menagerie/'.length))
  return safe(workspace, clean)
}

function nsClean(path) {
  const clean = posix.normalize(String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, ''))
  return clean === '.' || clean.startsWith('../') || clean === '..' ? null : clean
}

function statOf(path) {
  const full = nsFile(path)
  if (!full) return null
  try { const st = statSync(full); return st.isFile() ? { path, size: st.size, mtime: Math.round(st.mtimeMs) } : null } catch { return null }
}

function readJson(path) {
  const full = nsFile(path)
  if (!full) return null
  try { return JSON.parse(readFileSync(full, 'utf8')) } catch { return null }
}

// ─── What to open ───────────────────────────────────────────────────────────────────────────────

/** A trajectory is `{ model, qpos: [[…]] }`; anything else named *.json is not one. */
function readTrajectoryHead(path) {
  const body = readJson(path)
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.qpos)) return null
  return {
    model: nsClean(body.model), modelXml: typeof body.model_xml === 'string' ? nsClean(body.model_xml) : null,
    video: typeof body.video === 'string' ? nsClean(body.video) : null,
    status: typeof body.status === 'string' ? body.status : 'done', frames: body.qpos.length,
  }
}

function newestUnder(dir, test, depth = 0, best = null) {
  const full = nsFile(dir || '.')
  if (!full || depth > 4) return best
  let entries = []
  try { entries = readdirSync(full, { withFileTypes: true }) } catch { return best }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) best = newestUnder(rel, test, depth + 1, best); continue }
    if (!entry.isFile() || !test(rel)) continue
    const st = statOf(rel)
    if (st && (!best || st.mtime > best.mtime)) best = st
  }
  return best
}

function isMjcf(path) {
  const full = nsFile(path)
  if (!full || extname(full).toLowerCase() !== '.xml') return false
  try {
    const fd = readFileSync(full, 'utf8').slice(0, 4096).replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
    return /^\s*<mujoco[\s>]/.test(fd)
  } catch { return false }
}

const PY_LITERAL = /(?:r|b|rb|br|u)?("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/gi

/**
 * The model a simulation script loads, read off its source: `load_menagerie("unitree_go2")`,
 * `load_xml("scenes/arm.xml")`, or any string literal naming a Menagerie robot followed by an XML
 * file (`Path(os.environ["MENAGERIE"]) / "unitree_go2" / "scene.xml"`). A guess, used only before
 * the script has recorded a rollout, so the pane opens on the right robot instead of a blank.
 */
function modelFromScript(path) {
  let text = ''
  try { text = readFileSync(nsFile(path), 'utf8') } catch { return null }
  const menagerieCall = /load_menagerie\(\s*["']([\w.-]+)["'](?:\s*,\s*(?:scene\s*=\s*)?["']([\w./-]+)["'])?/.exec(text)
  if (menagerieCall) {
    const candidate = `menagerie/${menagerieCall[1]}/${menagerieCall[2] || 'scene.xml'}`
    if (statOf(candidate)) return candidate
  }
  const literals = [...text.matchAll(PY_LITERAL)].map((m) => m[1].replace(/^("""|'''|"|')|("""|'''|"|')$/g, ''))
  for (let i = 0; i < literals.length; i++) {
    const lit = literals[i]
    if (/^[\w.-]+$/.test(lit) && existsSync(join(menagerie, lit))) {
      const next = literals.slice(i + 1, i + 3).find((l) => /\.xml$/i.test(l))
      const candidate = `menagerie/${lit}/${next ? next.replace(/^\/+/, '') : 'scene.xml'}`
      if (statOf(candidate)) return candidate
    }
    if (/\.xml$/i.test(lit)) {
      const rel = nsClean(lit)
      if (rel && statOf(rel) && isMjcf(rel)) return rel
      const menagerieRel = nsClean(lit.replace(/^.*?menagerie\//, 'menagerie/'))
      if (menagerieRel?.startsWith('menagerie/') && statOf(menagerieRel)) return menagerieRel
    }
  }
  return null
}

/**
 * What the pane opens, from the artifact Harness passed (`?file=`), an explicit model (`?model=`),
 * and the workspace. The artifact is a hint, never the only way in: a verdict that names a video,
 * a report, a rollout mid-write or nothing at all still lands on the simulation.
 */
export function resolveOpen(file, wantedModel) {
  const out = { trajectory: null, trajectoryStatus: null, model: null, modelXml: null, video: null, report: null, source: null, stamps: {} }
  const hint = nsClean(file || '')
  const ext = hint ? extname(hint).toLowerCase() : ''

  let trajectory = null
  const tryTrajectory = (path) => {
    if (trajectory || !path || !statOf(path)) return
    const head = readTrajectoryHead(path)
    if (head) { trajectory = { path, ...head } }
  }
  if (hint && ext === '.json') {
    tryTrajectory(hint)
    if (!trajectory) {
      const report = readJson(hint)
      if (report && (report.trajectory || report.model_path)) {
        out.report = hint
        tryTrajectory(typeof report.trajectory === 'string' ? nsClean(report.trajectory) : null)
      }
    }
  }
  if (hint && VIDEO.has(ext)) {
    out.video = statOf(hint) ? hint : null
    const dir = posix.dirname(hint)
    const stem = posix.basename(hint, extname(hint))
    tryTrajectory(`${dir}/${stem}.qpos.json`)
    tryTrajectory(`${dir}/rollout.qpos.json`)
  }
  if (hint && ext === '.xml' && isMjcf(hint)) { out.model = hint; out.source = 'artifact' }
  tryTrajectory(ROLLOUT)

  const report = readJson(out.report || REPORT)
  if (report && !out.report && statOf(REPORT)) out.report = REPORT

  if (trajectory && (!wantedModel || wantedModel === trajectory.model)) {
    out.trajectory = trajectory.path
    out.trajectoryStatus = trajectory.status
    if (!out.model) { out.model = trajectory.model; out.modelXml = trajectory.modelXml && statOf(trajectory.modelXml) ? trajectory.modelXml : null; out.source = 'rollout' }
    if (!out.video && trajectory.video && statOf(trajectory.video)) out.video = trajectory.video
  }
  if (wantedModel) { out.model = nsClean(wantedModel); out.source = 'picked'; if (out.model !== trajectory?.model) out.modelXml = null }
  if (!out.model && report && typeof report.model_path === 'string' && statOf(nsClean(report.model_path))) {
    out.model = nsClean(report.model_path); out.source = 'report'
  }
  if (!out.video && report && typeof report.video === 'string' && statOf(nsClean(report.video))) out.video = nsClean(report.video)
  if (!out.video) out.video = newestUnder('out', (p) => VIDEO.has(extname(p).toLowerCase()))?.path ?? null
  if (!out.model) {
    const scripts = []
    const collect = (dir) => { const full = nsFile(dir); try { for (const e of readdirSync(full, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.py')) scripts.push(statOf(`${dir}/${e.name}`)) } catch { /* none */ } }
    collect('sim')
    for (const script of scripts.filter(Boolean).sort((a, b) => b.mtime - a.mtime)) {
      const guess = modelFromScript(script.path)
      if (guess) { out.model = guess; out.source = 'script'; break }
    }
  }
  if (!out.model) {
    const scene = newestUnder('scenes', (p) => isMjcf(p)) || newestUnder('', (p) => p.endsWith('.xml') && !p.startsWith('out/') && isMjcf(p))
    if (scene) { out.model = scene.path; out.source = 'workspace' }
  }
  if (out.model && !statOf(out.model)) { out.missing = out.model; out.model = null }

  for (const key of ['trajectory', 'model', 'modelXml', 'video']) {
    const st = out[key] ? statOf(out[key]) : null
    out.stamps[key] = st ? `${st.size}:${st.mtime}` : null
  }
  if (out.model && !out.model.startsWith('menagerie/')) {
    // A workspace model is live source: any XML beside it may be an <include>, so its stamp is theirs too.
    const deps = modelDeps(out.model, out.modelXml)
    out.stamps.model = deps.files.filter((f) => f.path.endsWith('.xml')).map((f) => `${f.path}:${f.size}:${f.mtime}`).join('|')
  }
  return out
}

// ─── A model's files ────────────────────────────────────────────────────────────────────────────

const FILE_ATTRS = new Set(['file', 'fileright', 'fileleft', 'fileup', 'filedown', 'filefront', 'fileback'])

/**
 * Every file a model needs, found by reading its MJCF the way the compiler would: `<include>`,
 * `<compiler meshdir|texturedir|assetdir>`, and every `file*=` attribute, recursively. A snapshot
 * (`xml`, the compiled model record() saved) is read instead of the model but resolves against the
 * model's directory, which is where the pane will put it.
 */
export function modelDeps(model, snapshot) {
  const files = new Map()
  const baseDir = posix.dirname(model)
  const dirs = { mesh: new Set(['']), texture: new Set(['']) }
  const add = (path) => {
    const clean = nsClean(path)
    if (!clean || files.has(clean)) return files.get(clean) ?? null
    const st = statOf(clean)
    if (st) files.set(clean, st)
    return st
  }
  const scan = (path, text) => {
    if (text === undefined) {
      try { text = readFileSync(nsFile(path), 'utf8') } catch { return }
    }
    text = text.replace(/<!--[\s\S]*?-->/g, '')
    const tags = [...text.matchAll(/<([A-Za-z_][\w-]*)\b([^>]*)>/g)]
    for (const [, tag, body] of tags) {
      if (tag !== 'compiler') continue
      for (const [, name, value] of body.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)) {
        if (name === 'meshdir' || name === 'assetdir') dirs.mesh.add(value)
        if (name === 'texturedir' || name === 'assetdir') dirs.texture.add(value)
      }
    }
    const here = posix.dirname(path)
    for (const [, tag, body] of tags) {
      for (const [, name, value] of body.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)) {
        if (!FILE_ATTRS.has(name) || !value || value.startsWith('/')) continue
        const kind = tag === 'mesh' || tag === 'skin' ? 'mesh' : tag === 'texture' || tag === 'hfield' ? 'texture' : 'plain'
        const candidates = []
        if (kind !== 'plain') for (const dir of dirs[kind]) candidates.push(posix.join(baseDir, dir, value), posix.join(here, dir, value))
        candidates.push(posix.join(here, value), posix.join(baseDir, value))
        for (const candidate of candidates) {
          const hit = add(candidate)
          if (hit) { if (candidate.toLowerCase().endsWith('.xml') && !scanned.has(hit.path)) { scanned.add(hit.path); scan(hit.path) } break }
        }
      }
    }
  }
  const scanned = new Set()
  if (!add(model)) return { files: [], error: `${model} does not exist` }
  scanned.add(nsClean(model))
  if (snapshot && statOf(snapshot)) {
    add(snapshot)
    let text = ''
    try { text = readFileSync(nsFile(snapshot), 'utf8') } catch { /* unreadable */ }
    scan(model)                    // the source's own includes and compiler dirs, for meshdir
    scan(model, text)              // then the snapshot's assets, resolved from the model's directory
  } else {
    scan(model)
  }
  return { files: [...files.values()], error: null }
}

/** Menagerie robots and workspace MJCF, for the model picker and the empty state. */
function listModels() {
  const robots = []
  try {
    for (const entry of readdirSync(menagerie, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      for (const scene of ['scene.xml', `${entry.name}.xml`]) {
        if (existsSync(join(menagerie, entry.name, scene))) { robots.push({ path: `menagerie/${entry.name}/scene.xml`.replace('scene.xml', scene), name: entry.name }); break }
      }
    }
  } catch { /* no menagerie */ }
  const scenes = []
  const walk = (dir, depth) => {
    if (depth > 3 || scenes.length > 40) return
    const full = nsFile(dir || '.')
    let entries = []
    try { entries = readdirSync(full, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && entry.name !== 'out') walk(rel, depth + 1); continue }
      if (entry.name.endsWith('.xml') && isMjcf(rel)) scenes.push({ path: rel, name: rel })
    }
  }
  walk('', 0)
  return { robots: robots.sort((a, b) => a.name.localeCompare(b.name)), scenes }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────────────────────

function sendFile(req, res, full, { cache = false } = {}) {
  let st
  try { st = full && statSync(full) } catch { st = null }
  if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type, 'accept-ranges': 'bytes', 'last-modified': st.mtime.toUTCString(),
    'cache-control': cache ? 'max-age=3600' : 'no-store',
  }
  // WebKit will not play a video from a server that ignores Range, so every file honours it.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]))
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
    if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return }
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(full, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': st.size })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(full).pipe(res)
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

const clients = new Set()

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  let path
  try { path = decodeURIComponent(url.pathname) } catch { res.writeHead(400); res.end(); return }
  if (path === '/' || path === '/index.html') { sendFile(req, res, join(PUBLIC, 'index.html')); return }
  if (path.startsWith('/static/')) { sendFile(req, res, safe(PUBLIC, path.slice('/static/'.length))); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path === '/api/events' || path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write('retry: 1000\n: hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (path === '/api/resolve') {
    json(res, resolveOpen(url.searchParams.get('file') ?? '', url.searchParams.get('model') || null)); return
  }
  if (path === '/api/files') {
    const model = nsClean(url.searchParams.get('model') ?? '')
    if (!model) { json(res, { error: 'no model' }, 400); return }
    const deps = modelDeps(model, nsClean(url.searchParams.get('xml') ?? '') || null)
    json(res, deps, deps.error ? 404 : 200); return
  }
  if (path === '/api/list') {
    // The whole directory of a model, for a model whose files the MJCF scan could not find.
    const dir = nsClean(url.searchParams.get('dir') ?? '')
    const files = []
    const walk = (rel, depth) => {
      if (depth > 6 || files.length > 4000) return
      let entries = []
      try { entries = readdirSync(nsFile(rel || '.'), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && e.name !== 'out') walk(child, depth + 1) } else if (e.isFile() && /\.(xml|obj|stl|msh|skn|png|ppm|jpe?g|dae|bin|mtl)$/i.test(e.name)) {
          const st = statOf(child); if (st) files.push(st)
        }
      }
    }
    walk(dir && dir !== '.' ? dir : '', 0)
    json(res, { files }); return
  }
  if (path === '/api/models') { json(res, listModels()); return }
  if (path.startsWith('/vendor/')) {
    const rest = path.slice('/vendor/'.length)
    const slash = rest.indexOf('/')
    const root = VENDOR[slash < 0 ? rest : rest.slice(0, slash)]
    sendFile(req, res, root && slash > 0 ? safe(root, rest.slice(slash + 1)) : null, { cache: true }); return
  }
  if (path === '/ws' || path.startsWith('/ws/')) { sendFile(req, res, safe(workspace, path.slice(3).replace(/^\/+/, ''))); return }
  if (path === '/menagerie' || path.startsWith('/menagerie/')) { sendFile(req, res, safe(menagerie, path.slice('/menagerie'.length).replace(/^\/+/, '')), { cache: true }); return }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
})

// ─── Watching the agent work ────────────────────────────────────────────────────────────────────

const IGNORED = /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__|\.claude|\.agents|\.codex|\.cache)(\/|$)/
let pending = new Set()
let flushTimer = null
function flush() {
  flushTimer = null
  const paths = [...pending]
  pending = new Set()
  const message = `event: change\ndata: ${JSON.stringify({ paths })}\n\n`
  for (const client of clients) client.write(message)
}

export function startWatching() {
  try {
    const watcher = watch(workspace, { recursive: true }, (_event, name) => {
      const rel = String(name ?? '').split(sep).join('/')
      if (!rel || IGNORED.test(rel) || /\.tmp$|~$|\.swp$/.test(rel)) return
      pending.add(rel)
      if (!flushTimer) flushTimer = setTimeout(flush, 120)
    })
    watcher.on('error', (error) => console.log(`[mujoco-viewer] watch error: ${error.message}`))
  } catch (error) { console.log(`[mujoco-viewer] watch failed: ${error.message}`) }
  setInterval(() => { for (const client of clients) client.write(': ping\n\n') }, 20_000).unref()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`[mujoco-viewer] listening on http://127.0.0.1:${port}/`)
    console.log(`[mujoco-viewer] workspace: ${workspace}`)
    console.log(`[mujoco-viewer] menagerie: ${menagerie}${existsSync(menagerie) ? '' : ' (not there — only workspace MJCF will load)'}`)
  })
  startWatching()
}
