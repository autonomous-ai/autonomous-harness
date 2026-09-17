// The Yosys pane's server. Harness runs `viewer.sh` here with HARNESS_VIEWER_PORT and
// HARNESS_WORKSPACE; this listens on 127.0.0.1 and serves the page in viewer/public/ plus a small
// API over what the flow leaves in the workspace:
//
//   /api/state            top module, the run and each step live, the report, which files exist
//   /api/vcd/meta         out/sim.vcd's hierarchy          /api/vcd/data?ids=…   changes per signal
//   /api/netlist          the design's instance tree       /api/netlist/module   names for hovering
//   /api/schematic.svg    one module drawn by netlistsvg, in a worker thread, cached per netlist
//   /api/chip             the iCE40 floorplan: tiles, placed cells, routes, timing
//   /api/board            the PCF, the top module's ports, the package's pins
//   /api/log?step=        one step's log                   /ws/<path>            a workspace file
//   /events               server-sent `change` events naming the files that changed
//
// Nothing here runs a tool or writes a file: the agent's flow.sh does the work, and the pane reads.
// No network, no CDN: the page is plain modules served from this folder.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parseVcd, vcdMeta, vcdSignal } from './viewer/lib/vcd.mjs'
import { buildChip, packagePins } from './viewer/lib/chip.mjs'
import { hierarchy, moduleForRender, moduleIndex, skinTypes } from './viewer/lib/netlist.mjs'
import { fileInfo, findTop, flowState, parsePcf, readJson, readText, sources, topPorts } from './viewer/lib/workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE ?? process.cwd())
const publicDir = join(here, 'viewer', 'public')
const clients = new Set()

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.log': 'text/plain; charset=utf-8', '.v': 'text/plain; charset=utf-8', '.sv': 'text/plain; charset=utf-8',
  '.vh': 'text/plain; charset=utf-8', '.pcf': 'text/plain; charset=utf-8', '.vcd': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.asc': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
}

function inside(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function serveFile(req, res, full) {
  let st
  try { st = full && statSync(full) } catch { st = null }
  if (!st || !st.isFile()) return send(res, 404, 'not found', 'text/plain')
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': st.size }); return res.end() }
  send(res, 200, readFileSync(full), type)
}

// ------------------------------------------------------------------------------------ caches
// Each keyed by the mtime and size of the files it was built from, so a new run is a miss.

function stamp(...rels) {
  return rels.map((r) => { const f = fileInfo(workspace, r); return f ? `${f.mtime}:${f.size}` : '-' }).join('|')
}

let vcdCache = { key: null, parsed: null, meta: null }
function vcd() {
  const rel = 'out/sim.vcd'
  const key = stamp(rel)
  if (key === '-') return null
  if (vcdCache.key !== key) {
    const text = readFileSync(join(workspace, rel), 'latin1')
    const parsed = parseVcd(text)
    vcdCache = { key, parsed, meta: { ...vcdMeta(parsed), path: rel, mtime: fileInfo(workspace, rel)?.mtime } }
  }
  return vcdCache
}

let chipCache = { key: null, value: null }
function chip(top) {
  const rels = [`out/${top}.asc`, `out/${top}_routed.json`, `out/${top}_pnr.json`]
  const key = top + stamp(...rels)
  if (chipCache.key !== key) {
    const asc = readText(join(workspace, rels[0]))
    const routed = readJson(join(workspace, rels[1]))
    const report = readJson(join(workspace, rels[2]))
    chipCache = {
      key,
      value: asc || routed || report ? { ...buildChip({ asc, routed, report }), stamp: key, files: rels.map((r) => fileInfo(workspace, r)) } : null,
    }
  }
  return chipCache.value
}

let netlistCache = { key: null, netlist: null }
function netlist(top) {
  const rel = `out/${top}_schematic.json`
  const key = stamp(rel)
  if (key === '-') return null
  if (netlistCache.key !== key) netlistCache = { key, netlist: readJson(join(workspace, rel)), svgs: new Map() }
  return netlistCache.netlist ? netlistCache : null
}

// netlistsvg runs in a worker so a slow layout never stalls the event stream.
const skinPath = join(here, 'node_modules', 'netlistsvg', 'lib', 'default.svg')
let skin = null, known = new Set()
let worker = null, jobs = new Map(), jobSeq = 0
function renderSvg(net) {
  if (!skin) {
    if (!existsSync(skinPath)) return Promise.reject(new Error('netlistsvg is not installed here — run toolchain/setup.sh'))
    skin = readFileSync(skinPath, 'utf8')
    known = skinTypes(skin)
  }
  if (!worker) {
    worker = new Worker(join(here, 'viewer', 'lib', 'schematic-worker.mjs'))
    worker.on('message', ({ id, svg, error }) => {
      const job = jobs.get(id)
      if (!job) return
      jobs.delete(id)
      clearTimeout(job.timer)
      if (error || !svg) job.reject(new Error(error || 'netlistsvg drew nothing'))
      else job.resolve(svg)
    })
    worker.on('error', (e) => { for (const j of jobs.values()) j.reject(e); jobs.clear(); worker = null })
    worker.unref()
  }
  return new Promise((resolveJob, rejectJob) => {
    const id = ++jobSeq
    const timer = setTimeout(() => {
      jobs.delete(id)
      // A layout that takes this long will not finish usefully; start a fresh worker for the next.
      worker?.terminate(); worker = null
      for (const j of jobs.values()) j.reject(new Error('interrupted'))
      jobs.clear()
      rejectJob(new Error('this module is too large to lay out in the pane (over 90 s)'))
    }, 90_000)
    jobs.set(id, { resolve: resolveJob, reject: rejectJob, timer })
    worker.postMessage({ id, skin, netlist: moduleForRender(net, net.__module, known) })
  })
}

// --------------------------------------------------------------------------------------- API

function state(fileParam) {
  const top = findTop(workspace, fileParam)
  const flow = flowState(workspace)
  const report = top ? readJson(join(workspace, 'out', `${top}.report.json`)) : null
  const f = (rel) => fileInfo(workspace, rel)
  return {
    workspace: workspace.split(sep).pop(),
    top,
    flow,
    report,
    files: top ? {
      vcd: f('out/sim.vcd'), waves: f('out/waves.json'),
      schematic: f(`out/${top}_schematic.json`), svg: f(`out/${top}.svg`),
      netlist: f(`out/${top}.json`), routed: f(`out/${top}_routed.json`), pnr: f(`out/${top}_pnr.json`),
      asc: f(`out/${top}.asc`), bin: f(`out/${top}.bin`), pcf: f(`constraints/${top}.pcf`),
      tb: f(`tb/${top}_tb.v`),
    } : {},
    sources: sources(workspace),
  }
}

async function api(req, res, url) {
  const p = url.pathname
  const q = url.searchParams
  const top = q.get('top') || findTop(workspace, q.get('file'))

  if (p === '/api/state') return send(res, 200, state(q.get('file')))

  if (p === '/api/vcd/meta') {
    const v = vcd()
    return v ? send(res, 200, v.meta) : send(res, 404, { error: 'no out/sim.vcd yet' })
  }
  if (p === '/api/vcd/data') {
    const v = vcd()
    if (!v) return send(res, 404, { error: 'no out/sim.vcd yet' })
    const ids = (q.get('ids') ?? '').split(' ').filter(Boolean)
    return send(res, 200, { mtime: v.meta.mtime, signals: ids.map((id) => vcdSignal(v.parsed, id)).filter(Boolean) })
  }

  if (p === '/api/netlist') {
    const n = top && netlist(top)
    if (!n) return send(res, 404, { error: 'no schematic netlist yet' })
    return send(res, 200, { top, stamp: n.key, tree: hierarchy(n.netlist) })
  }
  if (p === '/api/netlist/module') {
    const n = top && netlist(top)
    const idx = n && moduleIndex(n.netlist, q.get('module') ?? '')
    return idx ? send(res, 200, idx) : send(res, 404, { error: 'no such module' })
  }
  if (p === '/api/netlist/names') {
    // every named net, port and cell in every instance, for the schematic's search
    const n = top && netlist(top)
    if (!n) return send(res, 404, { error: 'no schematic netlist yet' })
    const names = []
    const walk = (node) => {
      const idx = moduleIndex(n.netlist, node.module)
      if (idx) {
        for (const port of Object.keys(idx.ports)) names.push({ kind: 'port', name: port, path: node.path })
        const seen = new Set(Object.keys(idx.ports))
        for (const net of Object.values(idx.nets)) {
          for (const name of net.names) if (!name.startsWith('$') && !seen.has(name)) { seen.add(name); names.push({ kind: 'net', name, path: node.path }) }
        }
        for (const [name, c] of Object.entries(idx.cells)) if (c.module) names.push({ kind: 'inst', name, path: node.path })
      }
      node.children.forEach(walk)
    }
    const tree = hierarchy(n.netlist)
    if (tree) walk(tree)
    return send(res, 200, { names: names.slice(0, 20000) })
  }
  if (p === '/api/schematic.svg') {
    const n = top && netlist(top)
    const mod = q.get('module') ?? ''
    if (!n || !n.netlist.modules?.[mod]) return send(res, 404, 'no such module', 'text/plain')
    let job = n.svgs.get(mod)
    if (!job) {
      job = renderSvg({ ...n.netlist, __module: mod })
      n.svgs.set(mod, job)
      job.catch(() => n.svgs.delete(mod))
    }
    try {
      return send(res, 200, await job, 'image/svg+xml')
    } catch (e) {
      return send(res, 500, String(e.message ?? e), 'text/plain')
    }
  }

  if (p === '/api/chip') {
    const c = top && chip(top)
    return c ? send(res, 200, c) : send(res, 404, { error: 'no place-and-route output yet' })
  }

  if (p === '/api/board') {
    const pcfRel = `constraints/${top}.pcf`
    const pcfText = readText(join(workspace, pcfRel))
    const routed = chip(top)
    const run = readJson(join(workspace, 'out', 'logs', 'run.json'))
    const arch = routed?.arch ?? (run?.device ?? '--up5k').replace(/^--/, '')
    const pkg = routed?.package ?? run?.package ?? 'sg48'
    const placed = (routed?.cells ?? []).filter((c) => c.t === 'SB_IO')
      .map((c) => ({ cell: c.n, x: c.x, y: c.y, z: Number(String(c.b).replace(/\D/g, '')) }))
    return send(res, 200, {
      top, pcf: pcfText == null ? null : { path: pcfRel, ...parsePcf(pcfText) },
      ports: top ? topPorts(workspace, top) : null,
      arch, package: pkg, pins: packagePins(arch, pkg), placed,
    })
  }

  if (p === '/api/log') {
    const step = (q.get('step') ?? '').replace(/[^a-z]/g, '')
    const text = readText(join(workspace, 'out', 'logs', `${step}.log`), 4 * 1024 * 1024)
    return text == null ? send(res, 404, '', 'text/plain') : send(res, 200, text, 'text/plain; charset=utf-8')
  }

  return send(res, 404, { error: 'unknown endpoint' })
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)
  try {
    if (path === '/' || path === '/index.html') return serveFile(req, res, join(publicDir, 'index.html'))
    if (path.startsWith('/app/')) return serveFile(req, res, inside(publicDir, path.slice(5)))
    if (path.startsWith('/api/')) return await api(req, res, url)
    if (path.startsWith('/ws/')) return serveFile(req, res, inside(workspace, path.slice(4)))
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write('retry: 1000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    // Old links: a workspace path at the root (/out/blink.svg) still resolves.
    return serveFile(req, res, inside(workspace, path.replace(/^\/+/, '')))
  } catch (error) {
    console.error('[yosys]', error)
    if (!res.headersSent) send(res, 500, { error: String(error.message ?? error) })
    else res.end()
  }
}).listen(port, '127.0.0.1', () => console.log(`[yosys] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

// ------------------------------------------------------------------------------------ live
// fs.watch is recursive on macOS. Changes are batched for 120 ms and pushed with the paths, so the
// page refreshes only what changed: a log line moves the pipeline, a new VCD reloads the waves.
let pending = new Set(), timer = null
function flush() {
  timer = null
  const paths = [...pending]
  pending = new Set()
  const msg = `event: change\ndata: ${JSON.stringify({ paths })}\n\n`
  for (const c of clients) c.write(msg)
}
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '').split(sep).join('/')
    if (!n || n.includes('node_modules') || n.startsWith('.git/') || n.endsWith('.vvp') || n.startsWith('.claude')) return
    pending.add(n)
    if (!timer) timer = setTimeout(flush, 120)
  })
} catch (error) {
  console.log(`[yosys] watch failed: ${error.message}`)
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
