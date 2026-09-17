// The iCE40 floorplan: what nextpnr put where, and the wires it used to connect it.
//
// Three files, all written by one nextpnr run:
//
//   out/<top>.asc          IceStorm's bitstream text. Only its tile headers are read here —
//                          `.logic_tile 9 5`, `.ramb_tile 6 3` … — which is the die's grid.
//   out/<top>_routed.json  nextpnr --write: each cell's NEXTPNR_BEL ("X9/Y5/lc3") and each net's
//                          ROUTING attribute ("wire;pip;strength;…").
//   out/<top>_pnr.json     nextpnr --report: utilisation, Fmax, the critical paths hop by hop.
//
// A route is drawn tile to tile. Every ROUTING entry is a wire and the pip that drives it; the pip's
// name carries its own tile and its source wire ("X9/Y5/9.5.lutff_6:out.->.9.8.sp4_v_b_9"), so each
// entry becomes a segment from where the source wire was driven to where this pip sits. That is the
// route tree at tile resolution — the real span-4 and span-12 tracks run between those tiles.
// Global nets (the clock) ride the dedicated global network and are drawn as their sinks only.

import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

export const TILE_CODES = {
  logic_tile: 'L', io_tile: 'I', ramb_tile: 'B', ramt_tile: 'T',
  dsp0_tile: 'D', dsp1_tile: 'D', dsp2_tile: 'D', dsp3_tile: 'D', ipcon_tile: 'P',
}

/** Tile grid from an .asc (or a chipdb) — any text with `.xxx_tile X Y` headers. */
export function tilesFromText(text) {
  const re = /^\.(\w+_tile) (\d+) (\d+)\s*$/gm
  const found = []
  let w = 0, h = 0, device = null
  const dm = /^\.device (\w+)/m.exec(text)
  if (dm) device = dm[1]
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const x = Number(m[2]), y = Number(m[3])
    found.push([x, y, TILE_CODES[m[1]] ?? '?'])
    if (x + 1 > w) w = x + 1
    if (y + 1 > h) h = y + 1
  }
  if (!found.length) return null
  const rows = Array.from({ length: h }, () => new Array(w).fill('.'))
  for (const [x, y, c] of found) rows[y][x] = c
  return { device, width: w, height: h, rows: rows.map((r) => r.join('')) }
}

const CHIPDB_FOR = {
  up5k: '5k', u4k: 'u4k', u1k: 'u4k', u2k: 'u4k', lp384: '384', lp1k: '1k', hx1k: '1k',
  lp4k: '8k', hx4k: '8k', lp8k: '8k', hx8k: '8k', lm4k: 'lm4k',
}

let chipdbDirCache
/** IceStorm's chipdb directory, found next to icepack; null when IceStorm is not installed. */
export function chipdbDir() {
  if (chipdbDirCache !== undefined) return chipdbDirCache
  chipdbDirCache = null
  const candidates = []
  try {
    const bin = execFileSync('/bin/sh', ['-c', 'command -v icepack'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin` },
    }).trim()
    if (bin) candidates.push(join(dirname(realpathSync(bin)), '..', 'share', 'icestorm', 'chipdb'))
  } catch { /* not on PATH */ }
  candidates.push('/opt/homebrew/share/icestorm/chipdb', '/usr/local/share/icestorm/chipdb', '/usr/share/icestorm/chipdb')
  chipdbDirCache = candidates.find((d) => existsSync(join(d, 'chipdb-5k.txt'))) ?? null
  return chipdbDirCache
}

const pinCache = new Map()
/**
 * Package pin -> IO tile, from the chipdb's `.pins <package>` block: [{ pin, x, y, z }].
 * The chipdb is tens of megabytes, so only its head is read — the pins block sits near the top.
 */
export function packagePins(arch, pkg) {
  const key = `${arch}/${pkg}`
  if (pinCache.has(key)) return pinCache.get(key)
  let pins = null
  const dir = chipdbDir()
  const db = CHIPDB_FOR[arch]
  if (dir && db) {
    try {
      const head = readHead(join(dir, `chipdb-${db}.txt`), 256 * 1024)
      const at = head.indexOf(`.pins ${pkg}\n`)
      if (at >= 0) {
        pins = []
        for (const line of head.slice(at).split('\n').slice(1)) {
          if (!line.trim() || line.startsWith('.')) break
          const [pin, x, y, z] = line.trim().split(/\s+/)
          pins.push({ pin, x: Number(x), y: Number(y), z: Number(z) })
        }
      }
    } catch { /* unreadable chipdb: fall through */ }
  }
  if (!pins && arch === 'up5k' && pkg === 'sg48') pins = UP5K_SG48
  pinCache.set(key, pins)
  return pins
}

function readHead(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const got = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, got).toString('latin1')
  } finally {
    closeSync(fd)
  }
}

// The iCE40UP5K-SG48 pin table from IceStorm's chipdb-5k.txt (ISC licence), for a machine where
// the chipdb cannot be found. pin, tile x, tile y, io index.
const UP5K_SG48 = [
  [2, 8, 0, 0], [3, 9, 0, 1], [4, 9, 0, 0], [6, 13, 0, 1], [9, 15, 0, 0], [10, 16, 0, 0], [11, 17, 0, 0],
  [12, 18, 0, 0], [13, 19, 0, 0], [14, 23, 0, 0], [15, 24, 0, 0], [16, 24, 0, 1], [17, 23, 0, 1],
  [18, 22, 0, 1], [19, 21, 0, 1], [20, 19, 0, 1], [21, 18, 0, 1], [23, 19, 31, 0], [25, 19, 31, 1],
  [26, 18, 31, 0], [27, 18, 31, 1], [28, 17, 31, 0], [31, 16, 31, 1], [32, 16, 31, 0], [34, 13, 31, 1],
  [35, 12, 31, 1], [36, 9, 31, 1], [37, 13, 31, 0], [38, 8, 31, 1], [39, 4, 31, 0], [40, 5, 31, 0],
  [41, 6, 31, 0], [42, 8, 31, 0], [43, 9, 31, 0], [44, 6, 0, 1], [45, 7, 0, 1], [46, 5, 0, 0],
  [47, 6, 0, 0], [48, 7, 0, 0],
].map(([pin, x, y, z]) => ({ pin: String(pin), x, y, z }))

/** "u_uart.left_SB_DFFESS_Q_D_SB_LUT4_O_LC" -> "u_uart"; top-level and tool-made names -> "". */
export function moduleOf(cellName) {
  if (!cellName || cellName.startsWith('$')) return ''
  const parts = cellName.split('.')
  const path = []
  for (const p of parts.slice(0, -1)) {
    if (!/^[A-Za-z_][\w\\[\]]*$/.test(p)) break
    path.push(p)
  }
  return path.join('.')
}

const XY = /^X(\d+)\/Y(\d+)\/(.*)$/
const PIP_WIRE = /^(\d+)\.(\d+)\.(.+)$/

/** A net's ROUTING attribute -> tile segments [x1,y1,x2,y2, …], and whether it is global. */
export function routeSegments(routing) {
  const parts = routing.split(';')
  const drivenAt = new Map()
  const edges = []
  let global = false
  for (let k = 0; k + 1 < parts.length; k += 3) {
    const wire = parts[k], pip = parts[k + 1]
    if (wire.includes('glb_netwk') || pip.includes('glb_netwk')) global = true
    const wm = XY.exec(wire)
    if (!pip) {
      if (wm) drivenAt.set(wire, [Number(wm[1]), Number(wm[2])])
      continue
    }
    const pm = XY.exec(pip)
    if (!pm) continue
    const at = [Number(pm[1]), Number(pm[2])]
    drivenAt.set(wire, at)
    const [src] = pm[3].split('.->.')
    const sm = PIP_WIRE.exec(src ?? '')
    if (sm) edges.push([`X${sm[1]}/Y${sm[2]}/${sm[3]}`, at, [Number(sm[1]), Number(sm[2])]])
  }
  const segs = []
  const seen = new Set()
  for (const [src, at, srcTile] of edges) {
    const from = drivenAt.get(src) ?? srcTile
    if (from[0] === at[0] && from[1] === at[1]) continue
    const key = `${from[0]},${from[1]},${at[0]},${at[1]}`
    if (seen.has(key)) continue
    seen.add(key)
    segs.push(from[0], from[1], at[0], at[1])
  }
  return { segs, global }
}

/**
 * Everything the Chip tab draws.
 * @param {{asc?:string, routed?:object, report?:object}} inputs file contents (asc text, parsed JSON)
 */
export function buildChip({ asc, routed, report }) {
  const grid = asc ? tilesFromText(asc) : null
  const mod = routed ? Object.values(routed.modules ?? {})[0] : null
  const settings = mod?.settings ?? {}
  const arch = settings['arch.type'] || (grid?.device ? archFromDevice(grid.device) : 'up5k')
  const pkg = settings['arch.package'] || 'sg48'

  const modules = ['']
  const moduleIndex = new Map([['', 0]])
  const cells = []
  const cellIndex = new Map()
  const portsOfNet = new Map() // bit -> [{c: cellIdx, p: port, d: 'o'|'i'}]
  for (const [name, cell] of Object.entries(mod?.cells ?? {})) {
    const bel = cell.attributes?.NEXTPNR_BEL
    const bm = bel ? XY.exec(bel) : null
    const m = moduleOf(name)
    if (!moduleIndex.has(m)) { moduleIndex.set(m, modules.length); modules.push(m) }
    const p = cell.parameters ?? {}
    const c = {
      n: name, t: cell.type,
      x: bm ? Number(bm[1]) : -1, y: bm ? Number(bm[2]) : -1, b: bm ? bm[3] : '',
      m: moduleIndex.get(m),
    }
    if (cell.type === 'ICESTORM_LC') {
      const conn = cell.connections ?? {}
      const lutInputs = ['I0', 'I1', 'I2', 'I3'].filter((k) => (conn[k] ?? []).length).length
      const init = String(p.LUT_INIT ?? '')
      c.lut = lutInputs > 0 || /1/.test(init) ? 1 : 0
      c.ff = p.DFF_ENABLE === '1' || p.DFF_ENABLE === 1 ? 1 : 0
      c.carry = p.CARRY_ENABLE === '1' || p.CARRY_ENABLE === 1 ? 1 : 0
      if (lutInputs) c.k = lutInputs
      if (init && /^[01]{16}$/.test(init)) c.init = parseInt(init, 2).toString(16).padStart(4, '0')
    }
    const idx = cells.length
    cells.push(c)
    cellIndex.set(name, idx)
    const dirs = cell.port_directions ?? {}
    for (const [port, bits] of Object.entries(cell.connections ?? {})) {
      for (const bit of bits) {
        if (typeof bit !== 'number') continue
        if (!portsOfNet.has(bit)) portsOfNet.set(bit, [])
        portsOfNet.get(bit).push({ c: idx, p: port, d: dirs[port] === 'output' ? 'o' : 'i' })
      }
    }
  }

  const nets = []
  const seenBits = new Set()
  for (const [name, net] of Object.entries(mod?.netnames ?? {})) {
    const bit = net.bits?.[0]
    if (typeof bit !== 'number' || seenBits.has(bit)) continue
    const routing = net.attributes?.ROUTING
    if (!routing) continue
    seenBits.add(bit)
    const { segs, global } = routeSegments(routing)
    const ends = portsOfNet.get(bit) ?? []
    const driver = ends.find((e) => e.d === 'o')
    nets.push({
      n: name, g: global ? 1 : 0, s: segs,
      d: driver ? driver.c : -1,
      k: ends.filter((e) => e.d === 'i').map((e) => e.c),
    })
  }

  const pins = packagePins(arch, pkg)

  return {
    arch, package: pkg, grid,
    modules, cells, nets, pins,
    utilization: report?.utilization ?? null,
    fmax: report?.fmax ?? null,
    criticalPaths: (report?.critical_paths ?? []).map((cp) => ({
      from: cp.from, to: cp.to,
      path: (cp.path ?? []).map((h) => ({
        type: h.type, delay: h.delay, net: h.net ?? null, sources: h.sources ?? [],
        from: h.from ? { cell: h.from.cell, port: h.from.port, loc: h.from.loc } : null,
        to: h.to ? { cell: h.to.cell, port: h.to.port, loc: h.to.loc } : null,
      })),
    })),
  }
}

function archFromDevice(device) {
  return { '5k': 'up5k', '1k': 'hx1k', '8k': 'hx8k', '384': 'lp384', u4k: 'u4k', lm4k: 'lm4k' }[device] ?? device
}
