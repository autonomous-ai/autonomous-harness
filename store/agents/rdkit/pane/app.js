// The RDKit pane: a read-only molecular viewer that follows the workspace. 3Dmol.js draws the 3D model;
// everything chemical (charges, groups, depiction, conformer energies, the parent and what changed)
// comes from the toolchain's <name>.molecule.json or, for SDFs it did not write, from the server's
// RDKit worker. Editing happens by prompting the agent; this page only looks, measures and compares.
/* global $3Dmol */
const Mol3D = window.$3Dmol

// ---------------------------------------------------------------------------------------------------
// small things
// ---------------------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace(/\.?0+$/, (m) => (d && m.startsWith('.') ? '' : m)))
const fixed = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d))
const minus = (s) => String(s).replace(/-/g, '−')
const signed = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d)
const subscripted = (formula) => esc(formula || '').replace(/(\d+)/g, '<sub>$1</sub>')
const humanName = (name) => String(name || '').replace(/_/g, ' ')
const ICON = {
  wire: '<svg viewBox="0 0 16 16"><path d="M3 11 6 5l4 6 3-6"/></svg>',
  stick: '<svg viewBox="0 0 16 16"><path d="M3.5 11.5 8 4.5l4.5 7" stroke-width="3"/></svg>',
  ball: '<svg viewBox="0 0 16 16"><path d="M4 11 8 5l4 6"/><circle cx="4" cy="11" r="2.2" fill="currentColor"/><circle cx="8" cy="5" r="2.2" fill="currentColor"/><circle cx="12" cy="11" r="2.2" fill="currentColor"/></svg>',
  space: '<svg viewBox="0 0 16 16"><circle cx="6" cy="9" r="4" fill="currentColor" stroke="none"/><circle cx="10.5" cy="6.5" r="3.5" fill="currentColor" stroke="none" opacity=".6"/></svg>',
  h: '<svg viewBox="0 0 16 16"><path d="M5 3.5v9M11 3.5v9M5 8h6"/></svg>',
  palette: '<svg viewBox="0 0 16 16"><path d="M8 2.5a5.5 5.5 0 1 0 0 11c1 0 1.3-.7 1-1.4-.4-.8.1-1.6 1-1.6h1.3a2.2 2.2 0 0 0 2.2-2.2c0-3.2-2.5-5.8-5.5-5.8Z"/><circle cx="5.3" cy="7" r=".6" fill="currentColor"/><circle cx="7.8" cy="5.2" r=".6" fill="currentColor"/><circle cx="10.4" cy="6.6" r=".6" fill="currentColor"/></svg>',
  surface: '<svg viewBox="0 0 16 16"><path d="M3.2 9.5C2 7 4 3.5 7 4c1.2-1.6 4.4-1.2 5 1.2 2 .8 1.6 4.3-.4 4.8-.3 2.3-3.3 3-4.6 1.6C5.6 12.8 3 12 3.2 9.5Z"/></svg>',
  ruler: '<svg viewBox="0 0 16 16"><path d="m2.5 10.5 8-8 3 3-8 8z"/><path d="m5 8 1.5 1.5M7 6l1 1M9 4l1.5 1.5"/></svg>',
  spin: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v2.5h-2.5"/></svg>',
  home: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10"/><circle cx="8" cy="8" r="1.6"/></svg>',
  bg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor"/></svg>',
  caret: '<svg class="caret" viewBox="0 0 8 8"><path d="M1.5 3 4 5.5 6.5 3" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5 3.5v9M11 3.5v9" stroke-width="2.4"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5 3 3"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>',
  ok: '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 4v5M8 12v.1"/></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M8 7.5V12M8 4.5v.1"/></svg>',
  molecule: '<svg viewBox="0 0 64 64"><path d="M32 8 52 20v24L32 56 12 44V20z"/><path d="M32 16 45 24v16l-13 8-13-8V24z" opacity=".45"/><circle cx="32" cy="8" r="3"/><circle cx="52" cy="44" r="3"/><circle cx="12" cy="44" r="3"/></svg>',
}

// Elements, in a palette tuned for a light stage (carbon a cool slate, hydrogen off-white).
const ELEMENT = { H: '#eef0f2', C: '#8c96a1', N: '#3d6ee0', O: '#e2474d', F: '#5cbf88', Cl: '#2ba06a', Br: '#a5532e', I: '#8a4cad', S: '#e3b43a', P: '#f08a24', B: '#f3a39a', Si: '#caa47a', Na: '#8a6be0', K: '#8a6be0', Li: '#b37be8', Mg: '#5fa35f', Zn: '#7d80b0', Fe: '#e06633', Se: '#ffa100' }
const ELEMENT_DARK_C = '#aab4bf'
const ELEMENT_NAME = { H: 'hydrogen', C: 'carbon', N: 'nitrogen', O: 'oxygen', F: 'fluorine', Cl: 'chlorine', Br: 'bromine', I: 'iodine', S: 'sulfur', P: 'phosphorus', B: 'boron', Si: 'silicon' }
const VDW = { H: 1.1, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98, B: 1.92, Si: 2.1 }
const GROUP_COLORS = ['#2f5bea', '#0e9f6e', '#9b51e0', '#d6336c', '#0891b2', '#ca8a04', '#4f46e5']
const PARENT_COLOR = '#8b6ff0'

// ---------------------------------------------------------------------------------------------------
// maths: superposition (Horn's quaternion method), principal axes, 4×4/3×3 symmetric eigenproblems
// ---------------------------------------------------------------------------------------------------
function jacobi(matrix) {
  const n = matrix.length
  const a = matrix.map((r) => r.slice())
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 80; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]
    if (off < 1e-20) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq }
        for (let k = 0; k < n; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk }
        for (let k = 0; k < n; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v }
}
const centroid = (pts) => { const c = [0, 0, 0]; for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2] } return c.map((x) => x / Math.max(1, pts.length)) }
// The rotation R and translation t that put `moving` onto `fixed` (paired points), and the RMSD after.
function superpose(moving, fixed) {
  if (moving.length < 3) return null
  const pc = centroid(moving), qc = centroid(fixed)
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < moving.length; i++) {
    const p = [moving[i][0] - pc[0], moving[i][1] - pc[1], moving[i][2] - pc[2]]
    const q = [fixed[i][0] - qc[0], fixed[i][1] - qc[1], fixed[i][2] - qc[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += p[a] * q[b]
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  const { values, vectors } = jacobi(N)
  let best = 0
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i
  const [w, x, y, z] = [0, 1, 2, 3].map((r) => vectors[r][best])
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ]
  const t = [0, 1, 2].map((r) => qc[r] - (R[r][0] * pc[0] + R[r][1] * pc[1] + R[r][2] * pc[2]))
  const out = { R, t }
  let sum = 0
  for (let i = 0; i < moving.length; i++) {
    const m = apply(out, moving[i])
    sum += (m[0] - fixed[i][0]) ** 2 + (m[1] - fixed[i][1]) ** 2 + (m[2] - fixed[i][2]) ** 2
  }
  out.rmsd = Math.sqrt(sum / moving.length)
  return out
}
const apply = ({ R, t }, p) => [0, 1, 2].map((r) => R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2] + t[r])
function quaternionFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2]
  let w, x, y, z
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m[2][1] - m[1][2]) * s; y = (m[0][2] - m[2][0]) * s; z = (m[1][0] - m[0][1]) * s }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]); w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s }
  else if (m[1][1] > m[2][2]) { const s = 2 * Math.sqrt(1 - m[0][0] + m[1][1] - m[2][2]); w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s }
  else { const s = 2 * Math.sqrt(1 - m[0][0] - m[1][1] + m[2][2]); w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s }
  return [x, y, z, w]
}
// A rotation that lays the molecule flat to the screen: longest axis across the wider side.
function orientation(points, tall) {
  const c = centroid(points)
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of points) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (p[a] - c[a]) * (p[b] - c[b])
  const { values, vectors } = jacobi(C)
  const order = [0, 1, 2].sort((i, j) => values[j] - values[i])
  const axis = (k) => [vectors[0][order[k]], vectors[1][order[k]], vectors[2][order[k]]]
  let e1 = axis(0), e2 = axis(1)
  if (tall) [e1, e2] = [e2, e1]
  const e3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  // then a little turn about both screen axes, so rings read as rings and depth reads as depth
  const tilt = (ax, deg) => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return ax === 'x' ? [[1, 0, 0], [0, c, -s], [0, s, c]] : [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
  return quaternionFromMatrix(mul(tilt('y', -22), mul(tilt('x', 28), [e1, e2, e3])))
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l } }
const add = (a, b, s = 1) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s })
const angleOf = (a, b, c) => { const u = norm(sub(a, b)), v = norm(sub(c, b)); return Math.acos(clamp(dot(u, v), -1, 1)) * 180 / Math.PI }
function dihedralOf(a, b, c, d) {
  const b0 = sub(a, b), b1 = norm(sub(c, b)), b2 = sub(d, c)
  const v = sub(b0, { x: b1.x * dot(b0, b1), y: b1.y * dot(b0, b1), z: b1.z * dot(b0, b1) })
  const w = sub(b2, { x: b1.x * dot(b2, b1), y: b1.y * dot(b2, b1), z: b1.z * dot(b2, b1) })
  return Math.atan2(dot(cross(b1, v), w), dot(v, w)) * 180 / Math.PI
}

// ---------------------------------------------------------------------------------------------------
// SDF text: records, coordinates, and coordinates moved by a superposition
// ---------------------------------------------------------------------------------------------------
function splitSdf(text) {
  return String(text || '').split(/^\$\$\$\$[^\n]*\n?/m).filter((b) => /M {2}END/.test(b) || /V2000|V3000/.test(b)).map((b) => b.replace(/^\s*\n(?=.*\n.*\n.*V[23]000)/, ''))
}
function atomLines(block) {
  const lines = block.split(/\r?\n/)
  const counts = lines[3] || ''
  if (!counts.includes('V2000')) return null
  const n = parseInt(counts.slice(0, 3), 10)
  if (!(n > 0)) return null
  return { lines, first: 4, n }
}
function coordsOf(block) {
  const info = atomLines(block)
  if (!info) return []
  const out = []
  for (let i = 0; i < info.n; i++) {
    const l = info.lines[info.first + i] || ''
    out.push([parseFloat(l.slice(0, 10)), parseFloat(l.slice(10, 20)), parseFloat(l.slice(20, 30))])
  }
  return out
}
function withCoords(block, coords) {
  const info = atomLines(block)
  if (!info) return block
  const lines = info.lines.slice()
  for (let i = 0; i < info.n && i < coords.length; i++) {
    const l = lines[info.first + i]
    lines[info.first + i] = coords[i].map((v) => v.toFixed(4).padStart(10)).join('') + l.slice(30)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search)
const PREFS_KEY = 'harness-rdkit-pane'
const DEFAULTS = { look: 'soft', rep: 'ballstick', hydrogens: 'all', color: 'element', surface: 'none', surfaceColor: 'esp', opacity: 0.9, bg: 'light', tab: 'props', ghost: false, ensemble: false, measure: 'distance' }
const prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { ...DEFAULTS } } })()
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* private */ } }

const state = {
  file: params.get('file') || '',
  dir: null,
  series: [],
  newest: null,
  current: null,            // entry name
  follow: true,             // switch to the newest molecule when one appears
  mol: null,                // the loaded molecule (see loadMolecule)
  conf: 0,
  playing: null,
  picks: [],
  measures: [],
  hover: null,
  hoverSource: null,
  group: null,              // hovered group chip
  pinned: null,             // clicked group chip
  progress: null,
  loading: 0,
  records: new Map(),       // sdf path + mtime → record promise
  texts: new Map(),
  frames: new Map(),
  sort: null,
  familyRoot: null,
  live: true,
}

// ---------------------------------------------------------------------------------------------------
// the 3D stage
// ---------------------------------------------------------------------------------------------------
const stage = $('stage')
const viewer = Mol3D.createViewer($('gl'), { backgroundColor: '#f1f2f5', backgroundAlpha: 0, antialias: true, hoverDuration: 25, lowerZoomLimit: 3, upperZoomLimit: 400 })
let models = []
let ghostModel = null
let shapes = { hover: [], group: [], picks: [], measures: [], labels: [] }
let surfaceToken = 0
let surfaceId = null
let lastMouse = { x: 0, y: 0 }
$('gl').addEventListener('pointermove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; if (state.hoverSource === '3d' && state.hover !== null) placeTip() })
$('gl').addEventListener('pointerleave', () => { if (state.hoverSource === '3d') setHover(null) })
$('gl').addEventListener('pointerdown', () => { if (state.hoverSource === '3d') setHover(null) })
new ResizeObserver(() => {
  viewer.resize(); viewer.render()
  const w = stage.clientWidth
  stage.classList.toggle('compact', w < 700)
  stage.classList.toggle('tiny', w < 470)
}).observe(stage)

function applyBackground(restyle = true) {
  const dark = prefs.bg === 'dark'
  stage.classList.toggle('dark', dark)
  viewer.setBackgroundColor(dark ? '#1c1e23' : '#f1f2f5', 0)
  const surface = prefs.surface !== 'none' && prefs.opacity < 0.99
  if (prefs.look === 'outline') viewer.setViewStyle({ style: 'outline', color: dark ? '#050608' : '#1a1a18', width: 0.035 })
  else if (prefs.look === 'soft' && !surface) viewer.setViewStyle({ style: 'ambientOcclusion', strength: 1.1, radius: 4.5 })
  else viewer.setViewStyle({ style: '' })
  if (restyle && state.mol) applyStyles()
  viewer.render()
}

function colorOf(index, scheme) {
  const mol = state.mol
  const info = mol?.record?.atoms?.[index]
  const el = info?.el || mol?.elements?.[index] || 'C'
  const base = el === 'C' && prefs.bg === 'dark' ? ELEMENT_DARK_C : (ELEMENT[el] || '#c05ec8')
  if (scheme === 'charge' && info && info.q !== null && info.q !== undefined) return diverging(info.q / (mol.chargeRange || 0.4), '#d7263d', '#f7f7f5', '#2f5bea')
  if (scheme === 'lipo' && info && info.logp !== null && info.logp !== undefined) return diverging(info.logp / (mol.lipoRange || 0.6), '#2c7fb8', '#f7f7f5', '#c8741f')
  if (scheme === 'changed' && mol?.record?.parent) {
    const heavy = el === 'H' ? info?.on : index
    if (mol.changed.has(heavy)) return el === 'H' ? '#fdba74' : '#f97316'
    return mix(base, prefs.bg === 'dark' ? '#1c1e23' : '#ffffff', el === 'H' ? 0.2 : 0.45)
  }
  return base
}
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function rgbToHex([r, g, b]) { return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('') }
function mix(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map((v, i) => v + (y[i] - v) * t)) }
function diverging(t, neg, mid, pos) { t = clamp(t, -1, 1); return t < 0 ? mix(mid, neg, -t) : mix(mid, pos, t) }

function isVisibleAtom(atom) {
  if (atom.elem !== 'H') return true
  if (prefs.hydrogens === 'all') return true
  if (prefs.hydrogens === 'none') return false
  const info = state.mol?.record?.atoms?.[atom.index]
  const on = info?.on ?? atom.bonds?.[0]
  const nb = state.mol?.record?.atoms?.[on]?.el ?? state.mol?.elements?.[on]
  return ['N', 'O', 'S', 'P'].includes(nb)
}
function styleFor(atom, scheme) {
  const colorfunc = (a) => colorOf(a.index, scheme)
  const h = atom.elem === 'H'
  switch (prefs.rep) {
    case 'wire': return { stick: { radius: h ? 0.035 : 0.05, colorfunc } }
    case 'stick': return { stick: { radius: h ? 0.12 : 0.16, colorfunc } }
    case 'space': return { sphere: { scale: 1.0, colorfunc } }
    default: return { stick: { radius: 0.1, colorfunc }, sphere: { scale: h ? 0.2 : 0.24, colorfunc } }
  }
}
function applyStyles() {
  if (!state.mol) return
  const scheme = prefs.color
  models.forEach((model, i) => {
    model.setStyle({}, {})
    if (i === state.conf) {
      for (const kind of ['heavy', 'h']) {
        model.setStyle({ predicate: (a) => (kind === 'h') === (a.elem === 'H') && isVisibleAtom(a) }, styleFor({ elem: kind === 'h' ? 'H' : 'C' }, scheme))
      }
      model.show()
    } else if (prefs.ensemble) {
      model.setStyle({ predicate: (a) => a.elem !== 'H' }, { stick: { radius: 0.07, opacity: 0.55, colorfunc: (a) => mix(colorOf(a.index, 'element'), prefs.bg === 'dark' ? '#1c1e23' : '#ffffff', 0.35) } })
      model.show()
    } else {
      model.hide()
    }
  })
  if (ghostModel) {
    const removed = new Set(state.mol?.record?.parent?.removed || [])
    ghostModel.setStyle({ predicate: (a) => a.elem !== 'H' }, { stick: { radius: { wire: 0.09, stick: 0.25, ballstick: 0.2, space: 0.25 }[prefs.rep] || 0.2, opacity: 0.45, colorfunc: (a) => (removed.has(a.index) ? '#f97316' : PARENT_COLOR) }, sphere: { scale: 0.001, opacity: 0.45, colorfunc: (a) => (removed.has(a.index) ? '#f97316' : PARENT_COLOR) } })
  }
  viewer.render()
}

function current() { return models[state.conf] }
function atomsOf(model) { return model ? model.selectedAtoms({}) : [] }
function atomAt(index) { return atomsOf(current())[index] }

function buildScene({ keepView }) {
  const mol = state.mol
  const view = keepView ? viewer.getView() : null
  stopPlaying()
  viewer.removeAllModels()
  viewer.removeAllShapes()
  viewer.removeAllLabels()
  viewer.removeAllSurfaces()
  shapes = { hover: [], group: [], picks: [], measures: [], labels: [] }
  surfaceId = null
  ghostModel = null
  models = mol.blocks.map((block) => viewer.addModel(block, mol.format || 'sdf', { keepH: true }))
  if (prefs.ghost && mol.parentFrame) ghostModel = viewer.addModel(mol.parentFrame.block, 'sdf', { keepH: true })
  state.conf = clamp(state.conf, 0, models.length - 1)
  applyStyles()
  wirePicking()
  if (view) viewer.setView(view)
  else orient()
  drawMeasures()
  drawGroupHighlight()
  paintSurface()
  viewer.render()
}
// Lay the molecule flat to the screen, then frame it with room for the overlays (player, toolbar).
function orient() {
  const model = current()
  if (!model) return
  const pts = atomsOf(model).filter((a) => a.elem !== 'H').map((a) => [a.x, a.y, a.z])
  if (pts.length >= 3) {
    const q = orientation(pts, stage.clientHeight > stage.clientWidth * 1.15)
    const v = viewer.getView()
    viewer.setView([v[0], v[1], v[2], v[3], q[0], q[1], q[2], q[3]])
  }
  frame()
}
function frame() {
  const model = current()
  if (!model) return
  viewer.zoomTo({ model }, 0)
  viewer.zoom(stage.clientHeight < 520 ? 0.78 : 0.88, 0)
  viewer.render()
}
function wirePicking() {
  viewer.setHoverable({}, false)
  viewer.setClickable({}, false)
  const model = current()
  if (!model) return
  viewer.setHoverable({ model }, true, (atom) => setHover(atom.index, '3d'), () => { if (state.hoverSource === '3d') setHover(null) })
  viewer.setClickable({ model }, true, (atom) => pick(atom.index))
}

// ---------------------------------------------------------------------------------------------------
// surfaces: VDW / SAS / SES, coloured by electrostatic potential from Gasteiger charges, by the
// molecular lipophilicity potential from Crippen contributions (Fauchère's exp(−r) decay), by atom, or plain
// ---------------------------------------------------------------------------------------------------
const SURFACES = { none: 'None', VDW: 'Van der Waals', SAS: 'Solvent accessible', SES: 'Solvent excluded' }
const SURFACE_COLORS = { esp: 'Electrostatic potential', lipo: 'Lipophilicity potential', element: 'By atom', plain: 'Plain' }
function potential(kind) {
  const atoms = atomsOf(current())
  const info = state.mol?.record?.atoms || []
  const src = atoms.map((a) => ({ x: a.x, y: a.y, z: a.z, v: kind === 'esp' ? info[a.index]?.q : info[a.index]?.logp })).filter((a) => a.v !== null && a.v !== undefined)
  if (!src.length) return null
  const at = kind === 'esp'
    ? (x, y, z) => { let s = 0; for (const a of src) { const r = Math.max(0.6, Math.hypot(x - a.x, y - a.y, z - a.z)); s += 332.06 * a.v / r } return s }
    : (x, y, z) => { let s = 0, w = 0; for (const a of src) { const k = Math.exp(-((x - a.x) ** 2 + (y - a.y) ** 2 + (z - a.z) ** 2) / 2.2); s += a.v * k; w += k } return w ? s / w : 0 }
  // the colour range, each side on its own: the 90th percentile of the negative and of the positive
  // values at points on the surface the probe traces (van der Waals radius, plus 1.4 Å for SAS)
  const neg = [], pos = []
  const dirs = []
  for (let k = 0; k < 26; k++) { const t = Math.acos(1 - 2 * (k + 0.5) / 26), f = Math.PI * (1 + Math.sqrt(5)) * k; dirs.push([Math.sin(t) * Math.cos(f), Math.sin(t) * Math.sin(f), Math.cos(t)]) }
  for (const a of atoms) {
    const r = (VDW[a.elem] || 1.7) * (prefs.surface === 'VDW' ? 1 : 1.05) + (prefs.surface === 'SAS' ? 1.4 : 0)
    for (const d of dirs) {
      const x = a.x + d[0] * r, y = a.y + d[1] * r, z = a.z + d[2] * r
      if (atoms.some((b) => b !== a && Math.hypot(x - b.x, y - b.y, z - b.z) < (VDW[b.elem] || 1.7) * 0.98)) continue // buried
      const v = at(x, y, z)
      if (v < 0) neg.push(-v); else pos.push(v)
    }
  }
  const pct = (list, q) => { list.sort((p, q2) => p - q2); return list[Math.floor(list.length * q)] || 0 }
  const floor = kind === 'esp' ? 4 : 0.04
  const lo = Math.max(floor, pct(neg, 0.9)), hi = Math.max(floor, pct(pos, 0.9))
  // electrostatics on one symmetric scale (a hydrocarbon should read neutral); lipophilicity on two, so
  // a mostly lipophilic molecule still shows where it is polar
  if (kind === 'esp') { const r = Math.max(lo, hi); return { getVal: at, lo: r, hi: r } }
  return { getVal: at, lo, hi }
}
// A diverging colour scale with separate reaches below and above zero, and a gentle curve so modest
// values still show colour.
function scale(lo, hi, neg, mid, pos) {
  const t = (v) => { const u = v < 0 ? -Math.pow(Math.min(1, -v / lo), 0.7) : Math.pow(Math.min(1, v / hi), 0.7); return u }
  return { range: () => [-lo, hi], valueToHex: (v) => parseInt(diverging(t(v), neg, mid, pos).slice(1), 16) }
}
async function paintSurface() {
  const token = ++surfaceToken
  if (surfaceId !== null) { viewer.removeSurface(surfaceId); surfaceId = null }
  renderLegend()
  if (prefs.surface === 'none' || !current()) { applyBackground(false); return }
  const spec = { opacity: prefs.opacity }
  let field = null
  if (prefs.surfaceColor === 'esp' || prefs.surfaceColor === 'lipo') {
    field = potential(prefs.surfaceColor)
    if (field) {
      spec.voldata = { getVal: field.getVal }
      spec.volscheme = prefs.surfaceColor === 'esp' ? scale(field.lo, field.hi, '#d7263d', '#f5f5f3', '#2f5bea') : scale(field.lo, field.hi, '#1f78c1', '#f5f5f3', '#c46a12')
    }
  }
  if (!spec.voldata) {
    if (prefs.surfaceColor === 'element') spec.colorfunc = (a) => colorOf(a.index, 'element')
    else spec.color = prefs.bg === 'dark' ? '#c9d2e3' : '#dfe6f3'
  }
  state.mol.surfaceRange = field ? [field.lo, field.hi] : null
  applyBackground(false)
  renderLegend()
  busy(`Computing the ${SURFACES[prefs.surface].toLowerCase()} surface…`, 'surface')
  try {
    const promise = viewer.addSurface(Mol3D.SurfaceType[prefs.surface], spec, { model: current() }, { model: current() })
    const id = promise.surfid
    await promise
    if (token !== surfaceToken) { viewer.removeSurface(id); return }
    surfaceId = id
  } catch (error) {
    toast(`The surface could not be computed (${error?.message || error})`)
  } finally {
    if (token === surfaceToken) busy(null, 'surface')
    viewer.render()
  }
}
function renderLegend() {
  const box = $('legend')
  const mol = state.mol
  let title = null, left = '', right = '', css = ''
  const surf = prefs.surface !== 'none' && (prefs.surfaceColor === 'esp' || prefs.surfaceColor === 'lipo')
  if (surf && mol?.surfaceRange) {
    const r = mol.surfaceRange
    if (prefs.surfaceColor === 'esp') { title = 'Electrostatic potential'; left = `−${Math.round(r[0])} kcal/mol`; right = `+${Math.round(r[1])}`; css = 'linear-gradient(90deg,#d7263d,#f5f5f3,#2f5bea)' }
    else { title = 'Lipophilicity potential'; left = 'hydrophilic'; right = 'lipophilic'; css = 'linear-gradient(90deg,#1f78c1,#f5f5f3,#c46a12)' }
  } else if (prefs.color === 'charge' && mol?.record) {
    title = 'Gasteiger charge'; left = `−${fixed(mol.chargeRange, 2)} e`; right = `+${fixed(mol.chargeRange, 2)} e`; css = 'linear-gradient(90deg,#d7263d,#f7f7f5,#2f5bea)'
  } else if (prefs.color === 'lipo' && mol?.record) {
    title = 'Crippen logP contribution'; left = `−${fixed(mol.lipoRange, 2)}`; right = `+${fixed(mol.lipoRange, 2)}`; css = 'linear-gradient(90deg,#2c7fb8,#f7f7f5,#c8741f)'
  } else if (prefs.color === 'changed' && mol?.record?.parent) {
    title = `Changed vs ${humanName(mol.record.parent.name)}`; left = 'shared'; right = 'new or different'; css = 'linear-gradient(90deg,#d5d9de 0 50%,#f97316 50% 100%)'
  }
  box.hidden = !title
  box.style.top = $('player').hidden ? '12px' : '54px'
  if (title) box.innerHTML = `<div class="lt">${esc(title)}</div><div class="bar" style="background:${css}"></div><div class="ends"><span>${minus(esc(left))}</span><span>${esc(right)}</span></div>`
}

// ---------------------------------------------------------------------------------------------------
// hover, the tooltip, highlights in 3D and 2D
// ---------------------------------------------------------------------------------------------------
function atomLabel(i) {
  const info = state.mol?.record?.atoms?.[i]
  const el = info?.el || state.mol?.elements?.[i] || '?'
  return `${el}${i}`
}
function groupsOfAtom(i) {
  const rec = state.mol?.record
  if (!rec) return []
  const heavy = rec.atoms?.[i]?.el === 'H' ? rec.atoms[i].on : i
  return (rec.groups || []).filter((g) => g.atoms.includes(heavy)).map((g) => g.name)
}
function setHover(index, source) {
  if (index === state.hover && source === state.hoverSource) return
  state.hover = index
  state.hoverSource = index === null ? null : source
  for (const s of shapes.hover) viewer.removeShape(s)
  shapes.hover = []
  const tip = $('tip')
  if (index === null || !state.mol) { tip.hidden = true; draw2D(); viewer.render(); return }
  const atom = atomAt(index)
  if (atom) shapes.hover.push(viewer.addSphere({ center: { x: atom.x, y: atom.y, z: atom.z }, radius: highlightRadius(atom), color: '#ffb020', opacity: 0.55 }))
  viewer.render()
  draw2D()
  const info = state.mol.record?.atoms?.[index]
  const el = info?.el || atom?.elem || '?'
  const rows = []
  const hyb = info?.hyb && info.hyb !== 's' ? info.hyb.replace('sp', 'sp') : null
  const bits = [hyb, info?.arom ? 'aromatic' : null, info?.ring && !info?.arom ? 'ring' : null, info?.cip ? `(${info.cip})` : null].filter(Boolean)
  if (info?.q !== null && info?.q !== undefined) rows.push(['Gasteiger charge', `${minus(signed(info.q, 3))} e`])
  if (info?.logp !== null && info?.logp !== undefined) rows.push(['Crippen logP', minus(signed(info.logp, 2))])
  if (info?.tpsa) rows.push(['TPSA share', `${fixed(info.tpsa, 1)} Å²`])
  if (info?.fc) rows.push(['Formal charge', minus(signed(info.fc, 0))])
  if (el !== 'H' && info) rows.push(['Hydrogens', String(info.h ?? 0)])
  const on = el === 'H' && info?.on !== null && info?.on !== undefined ? ` on ${atomLabel(info.on)}` : ''
  const groups = groupsOfAtom(index)
  const changed = state.mol.changed?.has(el === 'H' ? info?.on : index)
  tip.innerHTML = `<div class="t1">${esc(el)}${index}<span>${esc(ELEMENT_NAME[el] || el)}${esc(on)}</span></div>`
    + (bits.length ? `<div>${esc(bits.join(' · '))}</div>` : '')
    + rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
    + (groups.length ? `<div class="tg">${esc(groups.join(' · '))}</div>` : '')
    + (changed ? `<div class="tg" style="color:#fdba74">changed vs ${esc(humanName(state.mol.record.parent.name))}</div>` : '')
  tip.hidden = false
  placeTip()
}
function placeTip() {
  const tip = $('tip')
  const pad = 14
  const w = tip.offsetWidth, h = tip.offsetHeight
  let x = lastMouse.x + pad, y = lastMouse.y + pad
  if (x + w > window.innerWidth - 6) x = lastMouse.x - w - pad
  if (y + h > window.innerHeight - 6) y = lastMouse.y - h - pad
  tip.style.left = `${Math.max(6, x)}px`
  tip.style.top = `${Math.max(6, y)}px`
}
function highlightRadius(atom) {
  const r = VDW[atom.elem] || 1.7
  if (prefs.rep === 'space') return r * 1.04
  if (prefs.rep === 'ballstick') return Math.max(0.42, r * 0.24 + 0.2)
  return atom.elem === 'H' ? 0.32 : 0.42
}
function groupAtoms() {
  const g = state.group ?? state.pinned
  if (!g || !state.mol?.record) return null
  if (g.kind === 'changed') return { atoms: [...state.mol.changed], color: '#f97316', removed: true }
  return { atoms: g.atoms, color: g.color }
}
function drawGroupHighlight() {
  for (const s of shapes.group) viewer.removeShape(s)
  shapes.group = []
  const g = groupAtoms()
  if (g && current()) {
    const atoms = atomsOf(current())
    for (const i of g.atoms) {
      const a = atoms[i]
      if (a) shapes.group.push(viewer.addSphere({ center: { x: a.x, y: a.y, z: a.z }, radius: highlightRadius(a) + (prefs.rep === 'space' ? 0.1 : 0.22), color: g.color, opacity: 0.42 }))
    }
    const frame = state.mol.parentFrame
    if (g.removed && frame) {
      for (const i of state.mol.record.parent.removed || []) {
        const c = frame.coords[i]
        if (c) shapes.group.push(viewer.addSphere({ center: { x: c[0], y: c[1], z: c[2] }, radius: 0.34, color: '#f97316', opacity: 0.4, wireframe: false }))
      }
    }
  }
  viewer.render()
  draw2D()
}

// ---- the 2D depiction ----
function renderDepiction() {
  const host = $('depict')
  const rec = state.mol?.record
  if (!rec) { host.innerHTML = '<div class="placeholder skeleton"></div>'; $('groups').innerHTML = ''; return }
  if (!rec.svgText) { host.innerHTML = `<div class="placeholder">${esc(state.mol?.recordError || 'No depiction')}</div>`; return }
  host.innerHTML = rec.svgText.replace(/<\?xml[^>]*>/, '')
  const svg = host.querySelector('svg')
  if (!svg) return
  svg.removeAttribute('width'); svg.removeAttribute('height')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  fitDepiction()
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  layer.setAttribute('class', 'hl')
  svg.insertBefore(layer, svg.firstChild)
  state.mol.pos2d = new Map((rec.depiction?.atoms || []).map(([i, x, y]) => [i, [x, y]]))
  svg.addEventListener('pointermove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY }
    const i = nearest2D(svg, e)
    if (i === null) { if (state.hoverSource === '2d') setHover(null) }
    else { setHover(i, '2d'); placeTip() }
  })
  svg.addEventListener('pointerleave', () => { if (state.hoverSource === '2d') setHover(null) })
  svg.addEventListener('click', (e) => { const i = nearest2D(svg, e); if (i !== null) pick(i) })
  renderGroups()
  draw2D()
}
// Fill the panel, but never draw a small molecule at more than 1.6× its natural bond length.
function fitDepiction() {
  const host = $('depict')
  const svg = host.querySelector('svg')
  const vb = svg?.viewBox?.baseVal
  if (!svg || !vb?.width) return
  const w = host.clientWidth - 20, h = host.clientHeight - 8
  const scale = Math.max(0.2, Math.min(w / vb.width, h / vb.height, 1.45))
  svg.style.width = `${Math.round(vb.width * scale)}px`
  svg.style.height = `${Math.round(vb.height * scale)}px`
}
new ResizeObserver(fitDepiction).observe($('depict'))
function nearest2D(svg, e) {
  const ctm = svg.getScreenCTM()
  if (!ctm || !state.mol?.pos2d) return null
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
  const scale = (svg.viewBox.baseVal.width || 1) / (svg.clientWidth || 1)
  let best = null, bestD = 16 * Math.max(1, scale)
  for (const [i, [x, y]] of state.mol.pos2d) {
    const d = Math.hypot(pt.x - x, pt.y - y)
    if (d < bestD) { best = i; bestD = d }
  }
  return best
}
function draw2D() {
  const layer = $('depict').querySelector('svg g.hl')
  if (!layer || !state.mol?.pos2d) return
  const pos = state.mol.pos2d
  const bonds = state.mol.record?.depiction?.bonds || []
  const parts = []
  const lasso = (atoms, color, opacity, width = 15) => {
    const set = new Set(atoms)
    for (const [a, b] of bonds) if (set.has(a) && set.has(b) && pos.has(a) && pos.has(b)) {
      const [x1, y1] = pos.get(a), [x2, y2] = pos.get(b)
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round"/>`)
    }
    for (const i of set) if (pos.has(i)) { const [x, y] = pos.get(i); parts.push(`<circle cx="${x}" cy="${y}" r="${width * 0.62}" fill="${color}" fill-opacity="${opacity}"/>`) }
  }
  const g = groupAtoms()
  if (g) lasso(g.atoms.filter((i) => pos.has(i)), g.color, 0.22)
  state.picks.forEach((i, k) => {
    const heavy = pos.has(i) ? i : state.mol.record?.atoms?.[i]?.on
    if (pos.has(heavy)) { const [x, y] = pos.get(heavy); parts.push(`<circle cx="${x}" cy="${y}" r="11" fill="none" stroke="#2f5bea" stroke-width="2"/><text x="${x + 9}" y="${y - 9}" font-size="10" font-weight="700" fill="#2f5bea" font-family="-apple-system,system-ui">${k + 1}</text>`) }
  })
  for (const m of state.measures) for (const i of m.atoms) {
    const heavy = pos.has(i) ? i : state.mol.record?.atoms?.[i]?.on
    if (pos.has(heavy)) { const [x, y] = pos.get(heavy); parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="#2f5bea" fill-opacity=".6"/>`) }
  }
  if (state.hover !== null) {
    const info = state.mol.record?.atoms?.[state.hover]
    const heavy = pos.has(state.hover) ? state.hover : info?.on
    if (pos.has(heavy)) { const [x, y] = pos.get(heavy); parts.push(`<circle cx="${x}" cy="${y}" r="12" fill="#ffb020" fill-opacity="${heavy === state.hover ? 0.45 : 0.22}"/>`) }
  }
  layer.innerHTML = parts.join('')
  const hint = $('depictHint')
  if (state.hover !== null) {
    const info = state.mol.record?.atoms?.[state.hover]
    hint.innerHTML = `<b>${esc(atomLabel(state.hover))}</b>${info?.q !== null && info?.q !== undefined ? ` · q ${minus(signed(info.q, 3))}` : ''}${info?.hyb && info.hyb !== 's' ? ` · ${esc(info.hyb)}` : ''}`
  } else {
    hint.textContent = state.mol?.record?.depiction?.aligned_to_parent ? `drawn on ${humanName(state.mol.record.parent.name)}'s core` : 'hover an atom · click to measure'
  }
}
function renderGroups() {
  const box = $('groups')
  const rec = state.mol?.record
  if (!rec) { box.innerHTML = ''; return }
  const chips = []
  if (rec.parent && (state.mol.changed.size || rec.parent.removed?.length)) {
    chips.push({ kind: 'changed', name: `Changed vs ${humanName(rec.parent.name)}`, detail: rec.parent.change, atoms: [...state.mol.changed], color: '#f97316' })
  }
  const byName = new Map()
  for (const g of rec.groups || []) {
    if (!byName.has(g.name)) byName.set(g.name, [])
    byName.get(g.name).push(...g.atoms)
  }
  let k = 0
  for (const [name, atoms] of byName) {
    const count = (rec.groups || []).filter((g) => g.name === name).length
    chips.push({ kind: 'group', name: count > 1 ? `${name} ×${count}` : name, atoms: [...new Set(atoms)], color: GROUP_COLORS[k++ % GROUP_COLORS.length] })
  }
  for (const alert of rec.alerts || []) chips.push({ kind: 'alert', name: `⚠ ${alert.name}`, atoms: alert.atoms, color: '#b45309' })
  state.mol.chips = chips
  box.innerHTML = chips.map((c, i) => `<button class="group${c.kind === 'changed' ? ' change' : ''}" data-i="${i}" style="--g:${c.color}" aria-pressed="${state.pinned?.name === c.name}" title="${esc(c.detail ? `${c.name} (${c.detail})` : c.name)} — hover to highlight, click to keep"><i></i>${esc(c.name)}${c.detail ? ` <span style="color:var(--change);font-weight:600">${esc(c.detail)}</span>` : ''}</button>`).join('')
  box.querySelectorAll('.group').forEach((el) => {
    const chip = chips[Number(el.dataset.i)]
    el.addEventListener('pointerenter', () => { state.group = chip; drawGroupHighlight() })
    el.addEventListener('pointerleave', () => { state.group = null; drawGroupHighlight() })
    el.addEventListener('click', () => {
      state.pinned = state.pinned?.name === chip.name ? null : chip
      box.querySelectorAll('.group').forEach((b) => b.setAttribute('aria-pressed', String(state.pinned?.name === chips[Number(b.dataset.i)].name)))
      drawGroupHighlight()
    })
  })
}

// ---------------------------------------------------------------------------------------------------
// measuring: distance (2 atoms), angle (3), dihedral (4)
// ---------------------------------------------------------------------------------------------------
const MEASURE = { distance: { n: 2, label: 'Distance', key: 'D' }, angle: { n: 3, label: 'Angle', key: 'A' }, dihedral: { n: 4, label: 'Dihedral', key: 'T' } }
function pick(index) {
  if (!state.mol) return
  if (state.picks.length && state.picks[state.picks.length - 1] === index) { state.picks.pop() }
  else state.picks.push(index)
  const need = MEASURE[prefs.measure].n
  if (state.picks.length >= need) {
    state.measures.push({ kind: prefs.measure, atoms: state.picks.slice(0, need) })
    state.picks = []
  }
  drawMeasures()
}
function measureValue(m, atoms) {
  const p = m.atoms.map((i) => atoms[i])
  if (p.some((a) => !a)) return null
  if (m.kind === 'distance') return dist(p[0], p[1])
  if (m.kind === 'angle') return angleOf(p[0], p[1], p[2])
  return dihedralOf(p[0], p[1], p[2], p[3])
}
function measureText(m, v) { return v === null ? '–' : m.kind === 'distance' ? `${v.toFixed(2)} Å` : `${minus(v.toFixed(1))}°` }
function drawMeasures() {
  for (const s of [...shapes.picks, ...shapes.measures]) viewer.removeShape(s)
  for (const l of shapes.labels) viewer.removeLabel(l)
  shapes.picks = []; shapes.measures = []; shapes.labels = []
  const atoms = atomsOf(current())
  const dark = prefs.bg === 'dark'
  const ink = dark ? '#8fb0ff' : '#2f5bea'
  for (const i of state.picks) {
    const a = atoms[i]
    if (a) shapes.picks.push(viewer.addSphere({ center: { x: a.x, y: a.y, z: a.z }, radius: highlightRadius(a) + 0.05, color: ink, opacity: 0.45 }))
  }
  const label = (text, position) => shapes.labels.push(viewer.addLabel(text, { position, backgroundColor: dark ? '#ffffff' : '#1a1a18', backgroundOpacity: 0.9, fontColor: dark ? '#111111' : '#ffffff', fontSize: 12, font: '-apple-system, system-ui, sans-serif', inFront: true, alignment: 'center', showBackground: true }))
  const dash = (a, b) => shapes.measures.push(viewer.addCylinder({ start: { x: a.x, y: a.y, z: a.z }, end: { x: b.x, y: b.y, z: b.z }, radius: 0.035, color: ink, dashed: true, dashLength: 0.16, gapLength: 0.1, fromCap: 1, toCap: 1 }))
  for (const m of state.measures) {
    const p = m.atoms.map((i) => atoms[i])
    if (p.some((a) => !a)) continue
    const v = measureValue(m, atoms)
    m.value = v
    if (m.kind === 'distance') {
      dash(p[0], p[1])
      label(measureText(m, v), add(p[0], sub(p[1], p[0]), 0.5))
    } else if (m.kind === 'angle') {
      dash(p[0], p[1]); dash(p[1], p[2])
      const u = norm(sub(p[0], p[1])), w = norm(sub(p[2], p[1]))
      const r = Math.min(0.75, dist(p[0], p[1]) * 0.45, dist(p[2], p[1]) * 0.45)
      const pts = []
      for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(add(p[1], norm(add(u, sub(w, u), t)), r)) }
      shapes.measures.push(viewer.addCurve({ points: pts, radius: 0.025, color: ink, smooth: 4, fromArrow: false, toArrow: false }))
      label(measureText(m, v), add(p[1], norm(add(u, w)), r + 0.45))
    } else {
      dash(p[0], p[1]); dash(p[2], p[3])
      shapes.measures.push(viewer.addCylinder({ start: p[1], end: p[2], radius: 0.06, color: ink, opacity: 0.6, fromCap: 1, toCap: 1 }))
      label(measureText(m, v), add(p[1], sub(p[2], p[1]), 0.5))
    }
  }
  viewer.render()
  renderMeasureList()
  draw2D()
}
function renderMeasureList() {
  const box = $('measures')
  const any = state.measures.length || state.picks.length
  box.hidden = !any
  if (!any) return
  const kinds = { distance: '↔', angle: '∠', dihedral: '⟲' }
  box.innerHTML = `<div class="mh">Measurements<span class="grow"></span><button class="link" id="clearMeasures">Clear</button></div>`
    + state.measures.map((m, i) => `<div class="row"><span class="k">${kinds[m.kind]}</span><span class="a">${m.atoms.map(atomLabel).join('–')}</span><b>${esc(measureText(m, m.value ?? null))}</b><button class="x" data-i="${i}" title="Remove">×</button></div>`).join('')
    + (state.picks.length ? `<div class="pick">${MEASURE[prefs.measure].label}: ${state.picks.map(atomLabel).join('–')} · pick ${MEASURE[prefs.measure].n - state.picks.length} more</div>` : '')
  $('clearMeasures').onclick = clearMeasures
  box.querySelectorAll('.x').forEach((b) => { b.onclick = () => { state.measures.splice(Number(b.dataset.i), 1); drawMeasures() } })
}
function clearMeasures() { state.measures = []; state.picks = []; drawMeasures() }

// ---------------------------------------------------------------------------------------------------
// conformers: list, player, ensemble overlay, parent overlay
// ---------------------------------------------------------------------------------------------------
function setConformer(i, { fromPlayer = false } = {}) {
  if (!state.mol || !models.length) return
  const n = models.length
  const next = ((i % n) + n) % n
  if (next === state.conf) return
  if (!fromPlayer) stopPlaying()
  state.conf = next
  applyStyles()
  wirePicking()
  if (state.hover !== null && state.hoverSource === '3d') setHover(null)
  drawMeasures()
  drawGroupHighlight()
  if (prefs.surface !== 'none') paintSurface()
  renderPlayer()
  renderConformers(true)
}
function togglePlay() {
  if (state.playing) { stopPlaying(); return }
  if (models.length < 2) return
  state.playing = setInterval(() => setConformer(state.conf + 1, { fromPlayer: true }), prefs.surface !== 'none' ? 1400 : 700)
  renderPlayer(); renderConformers(true)
}
function stopPlaying() {
  if (!state.playing) return
  clearInterval(state.playing); state.playing = null
  renderPlayer(); renderConformers(true)
}
function renderPlayer() {
  const box = $('player')
  const mol = state.mol
  const n = models.length
  box.hidden = !mol || n < 2
  if (box.hidden) return
  const delta = mol.record?.conformers?.delta?.[state.conf]
  box.innerHTML = `<button class="mini" id="pPrev" title="Previous conformer ([)">${ICON.prev}</button>`
    + `<button class="mini" id="pPlay" title="Play conformers (P)">${state.playing ? ICON.pause : ICON.play}</button>`
    + `<button class="mini" id="pNext" title="Next conformer (])">${ICON.next}</button>`
    + `<span class="lab">Conformer <b>${state.conf + 1}</b>/${n}${delta !== undefined ? ` · ΔE <b>${fixed(delta, 2)}</b> kcal/mol` : ''}</span>`
  $('pPrev').onclick = () => setConformer(state.conf - 1)
  $('pNext').onclick = () => setConformer(state.conf + 1)
  $('pPlay').onclick = togglePlay
}
function renderConformers(soft) {
  const panel = $('panel-confs')
  const mol = state.mol
  $('confCount').textContent = mol && models.length > 1 ? String(models.length) : ''
  if (!mol) { panel.innerHTML = ''; return }
  const rec = mol.record
  const n = models.length
  const delta = rec?.conformers?.delta || []
  const maxDelta = Math.max(0.5, ...delta)
  const field = rec?.conformers?.forcefield || 'force field'
  if (soft && panel.querySelector('.conf-list')) {
    panel.querySelectorAll('.conf').forEach((row) => row.setAttribute('aria-current', String(Number(row.dataset.i) === state.conf)))
    const play = panel.querySelector('#cPlay')
    if (play) { play.innerHTML = `${state.playing ? ICON.pause : ICON.play}<span>${state.playing ? 'Pause' : 'Play'}</span>`; play.setAttribute('aria-pressed', String(!!state.playing)) }
    return
  }
  const rows = []
  for (let i = 0; i < n; i++) {
    const d = delta[i]
    const rmsd = mol.rmsdToFirst?.[i]
    rows.push(`<button class="conf" data-i="${i}" aria-current="${i === state.conf}"><span class="n">${i + 1}</span><span class="bar"><i style="width:${d === undefined ? 0 : Math.max(2, (d / maxDelta) * 100)}%"></i></span><span class="e">${d === undefined ? '–' : fixed(d, 2)}</span><span class="r">${rmsd === undefined ? '' : i === 0 ? '—' : `${fixed(rmsd, 2)} Å`}</span></button>`)
  }
  const parent = rec?.parent
  panel.innerHTML = `<div class="conf-head">`
    + (n > 1 ? `<button class="btn" id="cPlay" aria-pressed="${!!state.playing}">${state.playing ? ICON.pause : ICON.play}<span>${state.playing ? 'Pause' : 'Play'}</span></button><button class="btn icon" id="cPrev" title="Previous ([)">${ICON.prev}</button><button class="btn icon" id="cNext" title="Next (])">${ICON.next}</button><span class="grow"></span>` : '<span class="grow"></span>')
    + (n > 1 ? `<label class="toggle" title="Overlay every conformer (O)"><input type="checkbox" id="cEnsemble" ${prefs.ensemble ? 'checked' : ''}>All</label>` : '')
    + (parent && mol.parentFrame ? `<label class="toggle" title="Overlay ${esc(humanName(parent.name))} (G)"><input type="checkbox" id="cGhost" ${prefs.ghost ? 'checked' : ''}>${esc(humanName(parent.name))}</label>` : '')
    + `</div>`
    + `<div class="conf-cols"><span>#</span><span>ΔE (kcal/mol)</span><span></span><span>RMSD</span></div>`
    + `<div class="conf-list">${rows.join('')}</div>`
    + `<div class="foot">${n > 1 ? `${n} conformers from ETKDGv3 embedding, each minimised with ${esc(field)} in vacuum; ΔE is relative to the lowest, RMSD is over heavy atoms to conformer 1.` : `One conformer${rec?.conformers?.energies?.length ? `, ${esc(field)} energy ${fixed(rec.conformers.energies[0], 2)} kcal/mol` : ''}. The toolchain's <code>design()</code> searches ten by default.`}`
    + (parent && mol.fit ? ` Superposed on ${esc(humanName(parent.name))} over ${parent.map.length} shared atoms (RMSD ${fixed(mol.fit[state.conf]?.rmsd ?? mol.fit[0]?.rmsd, 2)} Å).` : '')
    + ` Force-field energies are a guide to shape, not to solution populations.</div>`
  panel.querySelectorAll('.conf').forEach((row) => { row.onclick = () => setConformer(Number(row.dataset.i)) })
  if ($('cPlay')) { $('cPlay').onclick = togglePlay; $('cPrev').onclick = () => setConformer(state.conf - 1); $('cNext').onclick = () => setConformer(state.conf + 1) }
  if ($('cEnsemble')) $('cEnsemble').onchange = (e) => { prefs.ensemble = e.target.checked; savePrefs(); applyStyles() }
  if ($('cGhost')) $('cGhost').onchange = (e) => setGhost(e.target.checked)
}
function setGhost(on) {
  prefs.ghost = !!on; savePrefs()
  if (ghostModel) { viewer.removeModel(ghostModel); ghostModel = null }
  if (prefs.ghost && state.mol?.parentFrame) ghostModel = viewer.addModel(state.mol.parentFrame.block, 'sdf', { keepH: true })
  applyStyles()
  renderGhostChip()
  if ($('cGhost')) $('cGhost').checked = prefs.ghost
}
function renderGhostChip() {
  const box = $('ghostChip')
  const parent = state.mol?.record?.parent
  box.hidden = !(parent && state.mol?.parentFrame)
  if (box.hidden) return
  box.innerHTML = `<button class="btn" aria-pressed="${prefs.ghost}" title="Overlay the parent, superposed on the shared atoms (G)"><i></i>Overlay ${esc(humanName(parent.name))}</button>`
  box.querySelector('button').onclick = () => setGhost(!prefs.ghost)
}

// ---------------------------------------------------------------------------------------------------
// the properties tab
// ---------------------------------------------------------------------------------------------------
function renderProperties() {
  const panel = $('panel-props')
  const mol = state.mol
  if (!mol) { panel.innerHTML = ''; return }
  const rec = mol.record
  if (!rec) {
    panel.innerHTML = mol.recordError
      ? `<div class="foot">${esc(mol.recordError)}</div>`
      : `<div class="rules"><span class="rule skeleton" style="width:110px"></span><span class="rule skeleton" style="width:90px"></span></div><div class="tiles">${'<div class="tile skeleton" style="height:58px"></div>'.repeat(6)}</div><div class="foot">Computing charges, groups and properties with RDKit…</div>`
    return
  }
  const p = rec.properties || {}
  const d = rec.parent?.deltas || {}
  const lip = rec.rules?.lipinski, veb = rec.rules?.veber
  const alerts = rec.alerts || []
  const qedClass = p.qed >= 0.67 ? 'good' : p.qed >= 0.35 ? 'warn' : 'bad'
  const rules = [
    `<span class="rule ${lip?.violations?.length ? (lip.pass ? 'warn' : 'bad') : 'good'}" title="MW ≤ 500, cLogP ≤ 5, HBD ≤ 5, HBA ≤ 10 (one violation allowed)">${lip?.violations?.length ? ICON.warn : ICON.ok}Lipinski <span>${lip?.violations?.length ? `${lip.violations.length} violation${lip.violations.length > 1 ? 's' : ''}` : 'pass'}</span></span>`,
    `<span class="rule ${veb?.pass ? 'good' : 'bad'}" title="Rotatable bonds ≤ 10 and TPSA ≤ 140 Å²">${veb?.pass ? ICON.ok : ICON.warn}Veber <span>${veb?.pass ? 'pass' : 'fail'}</span></span>`,
    `<span class="rule ${qedClass}" title="Quantitative estimate of drug-likeness (Bickerton 2012), 0–1">QED <span>${fixed(p.qed, 2)}</span></span>`,
    `<span class="rule ${alerts.length ? 'warn' : 'good'}" title="PAINS and Brenk substructure alerts">${alerts.length ? ICON.warn : ICON.ok}Alerts <span>${alerts.length ? alerts.length : 'none'}</span></span>`,
  ]
  const tile = (k, v, unit, delta, digits, limit, hint) => {
    const over = limit !== undefined && v > limit
    const dv = delta === undefined || delta === null || Math.abs(delta) < 1e-9 ? '' : `<div class="d ${delta > 0 ? 'up' : 'down'}">${minus(signed(delta, digits))} vs parent</div>`
    const meter = limit !== undefined ? `<div class="meter${over ? ' over' : ''}"><i style="width:${clamp((Math.max(0, v) / limit) * 100, 2, 100)}%"></i></div>` : ''
    return `<div class="tile${over ? ' over' : ''}" title="${esc(hint || '')}"><div class="k">${esc(k)}</div><div class="v">${minus(esc(v === undefined || v === null ? '–' : Number(v).toFixed(digits)))}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${dv || (rec.parent ? '<div class="d"></div>' : '')}${meter}</div>`
  }
  const tiles = [
    tile('Mol. weight', p.mw, 'Da', d.mw, 1, 500, 'Lipinski limit 500 Da'),
    tile('cLogP', p.logp, '', d.logp, 2, 5, 'Crippen; Lipinski limit 5'),
    tile('TPSA', p.tpsa, 'Å²', d.tpsa, 1, 140, 'Veber limit 140 Å²; ~90 for CNS'),
    tile('H-bond donors', p.hbd, '', d.hbd, 0, 5, 'Lipinski limit 5'),
    tile('H-bond acceptors', p.hba, '', d.hba, 0, 10, 'Lipinski limit 10'),
    tile('Rotatable bonds', p.rotatable_bonds, '', d.rotatable_bonds, 0, 10, 'Veber limit 10'),
    tile('QED', p.qed, '', d.qed, 2, undefined, 'Drug-likeness, 0–1'),
    tile('Aromatic rings', p.aromatic_rings, '', undefined, 0),
    tile('Fsp3', p.fsp3, '', d.fsp3, 2, undefined, 'Fraction of sp3 carbons'),
    tile('Formal charge', p.formal_charge, '', undefined, 0),
    tile('Heavy atoms', p.heavy_atoms, '', undefined, 0),
    tile('Stereocentres', p.stereocenters, p.unspecified_stereocenters ? `${p.unspecified_stereocenters} unspec.` : '', undefined, 0),
  ]
  const flags = (rec.flags || []).map((f) => `<div class="flag ${esc(f.level)}"><i>${f.level === 'good' ? ICON.ok : f.level === 'warn' ? ICON.warn : ICON.note}</i><span>${esc(f.text)}</span></div>`).join('')
  const ids = [['SMILES', rec.smiles], ['InChIKey', rec.inchikey], ['InChI', rec.inchi], ['Formula', rec.formula]]
    .filter(([, v]) => v).map(([k, v]) => `<div class="id"><span class="k">${k}</span><code title="${esc(v)}">${esc(v)}</code><button class="copy" data-copy="${esc(v)}" title="Copy ${k}">${ICON.copy}</button></div>`).join('')
  const parent = rec.parent
  panel.innerHTML = `<div class="rules">${rules.join('')}</div>`
    + `<div class="tiles">${tiles.join('')}</div>`
    + (parent ? `<div class="foot" style="margin-top:8px">Differences are against <b>${esc(humanName(parent.name))}</b> (${esc(parent.change)}, Tanimoto ${fixed(parent.similarity, 2)}${parent.inferred ? ', the closest earlier molecule' : ''}).</div>` : '')
    + `<div class="section-t">In plain words</div><div class="flags">${flags}</div>`
    + `<div class="section-t">Identifiers</div><div class="ids">${ids}</div>`
    + `<div class="foot">Computed by RDKit ${rec.computedBy === 'viewer' ? 'in the pane from the SDF' : 'by the toolchain'}. Crippen cLogP and TPSA describe the neutral molecule; these are rules of thumb, and nothing here predicts activity, binding or safety.</div>`
  panel.querySelectorAll('.copy').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b) })
}

// ---------------------------------------------------------------------------------------------------
// the series: strip of cards, comparison table
// ---------------------------------------------------------------------------------------------------
function entryProps(entry) {
  const rec = state.records.get(recordKey(entry))?.value
  return entry.properties || rec?.properties || null
}
function entryParent(entry) {
  if (entry.parent !== undefined && !entry.legacy) return entry.parent ? { name: entry.parent, change: entry.change, similarity: entry.similarity } : null
  const rec = state.records.get(recordKey(entry))?.value
  return rec?.parent ? { name: rec.parent.name, change: rec.parent.change, similarity: rec.parent.similarity } : null
}
function thumbSrc(entry) {
  const rec = state.records.get(recordKey(entry))?.value
  if (entry.svg && !entry.legacy && !entry.stale) return `/${state.dir}/${entry.svg}?v=${Math.round(entry.mtime)}`
  if (rec?.svgText) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(rec.svgText)
  return null
}
function renderStrip() {
  const strip = $('strip')
  const list = state.series
  strip.hidden = list.length < 2
  $('seriesCount').textContent = list.length > 1 ? String(list.length) : ''
  if (strip.hidden) return
  const scroll = strip.scrollLeft
  strip.innerHTML = list.map((e) => {
    const p = entryProps(e)
    const par = entryParent(e)
    const src = thumbSrc(e)
    return `<button class="mol-card" data-name="${esc(e.name)}" aria-current="${e.name === state.current}" title="${esc(e.name)}${par ? ` — from ${esc(par.name)}` : ''}">`
      + `<span class="thumb">${src ? `<img alt="" src="${src}">` : '<span class="skeleton" style="width:100%;height:100%"></span>'}</span>`
      + `<span class="meta"><div class="nm">${esc(humanName(e.name))}</div><div class="sm">${par?.change ? `<span class="delta">${esc(par.change)}</span> · ` : ''}${p ? `cLogP ${minus(fixed(p.logp, 2))}${par?.change ? '' : ` · MW ${fixed(p.mw, 0)}`}` : '…'}</div></span>`
      + (e.name === state.newest && e.name !== state.current ? '<i class="new" title="Newest"></i>' : '')
      + `</button>`
  }).join('')
  strip.scrollLeft = scroll
  strip.querySelectorAll('.mol-card').forEach((b) => { b.onclick = () => selectMolecule(b.dataset.name, { user: true }) })
  const active = strip.querySelector('[aria-current="true"]')
  if (active) {
    const l = active.offsetLeft, r = l + active.offsetWidth
    if (l < strip.scrollLeft || r > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: l - 14, behavior: 'smooth' })
  }
}
const COLUMNS = [
  { key: 'mw', label: 'MW', d: 1, limit: 500 }, { key: 'logp', label: 'cLogP', d: 2, limit: 5 }, { key: 'tpsa', label: 'TPSA', d: 1, limit: 140 },
  { key: 'hbd', label: 'HBD', d: 0, limit: 5 }, { key: 'hba', label: 'HBA', d: 0, limit: 10 }, { key: 'rotatable_bonds', label: 'RotB', d: 0, limit: 10 },
  { key: 'qed', label: 'QED', d: 2 }, { key: 'fsp3', label: 'Fsp3', d: 2 }, { key: 'lipinski_violations', label: 'Ro5', d: 0, limit: 1 },
]
function renderSeries() {
  const panel = $('panel-series')
  const list = state.series
  if (!list.length) { panel.innerHTML = '<div class="foot">No molecules yet.</div>'; return }
  const rows = list.map((e, order) => ({ e, order, p: entryProps(e), par: entryParent(e) }))
  if (state.sort) {
    const { key, dir } = state.sort
    rows.sort((a, b) => {
      const va = key === 'name' ? a.e.name : a.p?.[key], vb = key === 'name' ? b.e.name : b.p?.[key]
      if (va === undefined || va === null) return 1
      if (vb === undefined || vb === null) return -1
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir
    })
  }
  const byName = new Map(rows.map((r) => [r.e.name, r]))
  const head = `<tr><th data-k="name" ${state.sort?.key === 'name' ? 'aria-sort="x"' : ''}>Molecule</th>${COLUMNS.map((c) => `<th data-k="${c.key}" ${state.sort?.key === c.key ? 'aria-sort="x"' : ''}>${c.label}${state.sort?.key === c.key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr>`
  const body = rows.map(({ e, p, par }) => {
    const src = thumbSrc(e)
    const parentP = par ? byName.get(par.name)?.p : null
    const cells = COLUMNS.map((c) => {
      const v = p?.[c.key]
      const over = c.limit !== undefined && v > c.limit
      const delta = parentP && v !== undefined && parentP[c.key] !== undefined && ['mw', 'logp', 'tpsa', 'qed'].includes(c.key) ? v - parentP[c.key] : null
      return `<td class="${over ? 'over' : ''}">${v === undefined || v === null ? '…' : minus(Number(v).toFixed(c.d))}${delta !== null && Math.abs(delta) > 1e-9 ? `<span class="dv ${delta > 0 ? 'up' : 'down'}">${minus(signed(delta, c.d))}</span>` : ''}</td>`
    }).join('')
    return `<tr data-name="${esc(e.name)}" aria-current="${e.name === state.current}"><td><div class="mcell"><span class="th">${src ? `<img alt="" src="${src}">` : ''}</span><span><div class="nm">${esc(humanName(e.name))}</div><div class="ln">${par ? `from ${esc(humanName(par.name))}${par.change ? ` · <span class="delta">${esc(par.change)}</span>` : ''}` : 'lead'}</div></span></div></td>${cells}</tr>`
  }).join('')
  panel.innerHTML = `<div class="cmp-wrap"><table class="cmp"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    + `<div class="foot">Click a row to open it; click a heading to sort. Small numbers are the change from each molecule's parent. Amber marks a value past its Lipinski or Veber limit.</div>`
  panel.querySelectorAll('tbody tr').forEach((tr) => { tr.onclick = () => selectMolecule(tr.dataset.name, { user: true }) })
  panel.querySelectorAll('th').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.k
      state.sort = state.sort?.key === key ? (state.sort.dir > 0 ? { key, dir: -1 } : null) : { key, dir: 1 }
      renderSeries()
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// loading: the series, records (cached per SDF version), frames (superposed on the parent chain)
// ---------------------------------------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status}`)
  return body
}
async function getText(path, version) {
  const key = `${path}@${version}`
  if (!state.texts.has(key)) {
    state.texts.set(key, fetch(`/${path}?v=${version}`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.text() }))
    state.texts.get(key).catch(() => state.texts.delete(key))
  }
  return state.texts.get(key)
}
const recordKey = (entry) => `${entry.sdf}@${Math.round(entry.mtime)}`
function getRecord(entry) {
  const key = recordKey(entry)
  if (!state.records.has(key)) {
    const slot = { promise: null, value: null }
    slot.promise = getJson(`/api/molecule?path=${encodeURIComponent(entry.sdf)}`).then((r) => { slot.value = r; return r })
    slot.promise.catch(() => state.records.delete(key))
    state.records.set(key, slot)
  }
  return state.records.get(key).promise
}
async function frameOf(name, depth = 0) {
  const entry = state.series.find((e) => e.name === name)
  if (!entry) return null
  const key = `${name}@${Math.round(entry.mtime)}`
  if (!state.frames.has(key)) {
    const promise = (async () => {
      const [record, text] = await Promise.all([getRecord(entry), getText(entry.sdf, Math.round(entry.mtime))])
      const block = splitSdf(text)[0]
      let coords = coordsOf(block)
      let root = name
      const par = record.parent
      if (par && depth < 6 && par.name !== name && par.map?.length >= 3) {
        const pf = await frameOf(par.name, depth + 1).catch(() => null)
        if (pf) {
          const fit = superpose(par.map.map(([c]) => coords[c]), par.map.map(([, p]) => pf.coords[p]))
          if (fit) { coords = coords.map((c) => apply(fit, c)); root = pf.root }
        }
      }
      return { coords, root, block: withCoords(block, coords) }
    })()
    promise.catch(() => state.frames.delete(key))
    state.frames.set(key, promise)
  }
  return state.frames.get(key)
}

async function refreshSeries() {
  const q = state.dir ? `?dir=${encodeURIComponent(state.dir)}` : ''
  let data
  try { data = await getJson(`/api/series${q}`) } catch { return }
  if (!state.dir) state.dir = data.dir
  state.series = data.molecules || []
  setProgress(data.progress)
  const newest = state.series.reduce((best, e) => (!best || e.mtime > best.mtime ? e : best), null)
  const previousNewest = state.newest
  state.newest = newest?.name ?? null
  renderStrip(); renderSeries()
  // the legacy entries (SDFs without a series row) get their properties and thumbnails in the background
  for (const e of state.series) {
    if ((e.legacy || e.stale) && !state.records.get(recordKey(e))?.value) getRecord(e).then(() => { renderStrip(); renderSeries() }).catch(() => {})
  }
  return { newest, previousNewest }
}

async function selectMolecule(name, { user = false, keepView = null } = {}) {
  const entry = state.series.find((e) => e.name === name)
  if (!entry) return
  if (user) state.follow = name === state.newest
  const sameMolecule = state.current === name
  state.current = name
  renderStrip(); renderSeries()
  await loadMolecule(entry, { keepView: keepView ?? sameMolecule })
}

async function loadMolecule(entry, { keepView }) {
  const token = ++state.loading
  const previous = state.mol
  const version = Math.round(entry.mtime)
  const slow = setTimeout(() => { if (token === state.loading) busy(entry.legacy || entry.stale ? `Computing ${humanName(entry.name)} with RDKit…` : `Loading ${humanName(entry.name)}…`, 'load') }, 160)
  try {
    let record = null, recordError = null
    const recordPromise = getRecord(entry).then((r) => (record = r)).catch((e) => { recordError = e.message })
    const mainText = await getText(entry.sdf, version)
    await recordPromise
    if (token !== state.loading) return
    const format = (entry.sdf.split('.').pop() || 'sdf').toLowerCase()
    let blocks = format === 'sdf' || format === 'mol' ? splitSdf(mainText) : [mainText]
    if ((format === 'sdf' || format === 'mol') && record?.conformers?.count > 1 && record.conformers.file && record.conformers.file !== basename(entry.sdf)) {
      const ensemble = await getText(`${state.dir}/${record.conformers.file}`, version).catch(() => null)
      const more = ensemble ? splitSdf(ensemble) : []
      if (more.length > 1) blocks = more
    }
    if (!blocks.length) throw new Error(`${entry.sdf} has no molecule yet`)
    let elements = []
    const firstLines = atomLines(blocks[0])
    if (firstLines) for (let i = 0; i < firstLines.n; i++) elements.push((firstLines.lines[firstLines.first + i] || '').slice(31, 34).trim())
    else if (record?.atoms) elements = record.atoms.map((a) => a.el)
    if (firstLines && record?.atoms && (record.atoms.length !== elements.length || record.atoms.some((a, i) => a.el !== elements[i]))) {
      recordError = 'The record does not match this SDF (the agent may be rewriting it).'
      record = null
    }
    // superpose every conformer on the parent's frame, so a series shares one core position
    let parentFrame = null, fit = null
    if (firstLines && record?.parent?.map?.length >= 3) {
      parentFrame = await frameOf(record.parent.name).catch(() => null)
      if (token !== state.loading) return
      if (parentFrame) {
        fit = []
        blocks = blocks.map((block) => {
          const coords = coordsOf(block)
          const f = superpose(record.parent.map.map(([c]) => coords[c]), record.parent.map.map(([, p]) => parentFrame.coords[p]))
          fit.push(f)
          return f ? withCoords(block, coords.map((c) => apply(f, c))) : block
        })
      }
    }
    const heavy = elements.map((el, i) => (el !== 'H' ? i : -1)).filter((i) => i >= 0)
    const first = coordsOf(blocks[0])
    const rmsdToFirst = first.length ? blocks.map((block) => {
      const c = coordsOf(block)
      const f = c.length === first.length ? superpose(heavy.map((i) => c[i]), heavy.map((i) => first[i])) : null
      return f ? f.rmsd : undefined
    }) : []
    const charges = (record?.atoms || []).map((a) => Math.abs(a.q ?? 0)).sort((a, b) => a - b)
    const lipos = (record?.atoms || []).map((a) => Math.abs(a.logp ?? 0)).sort((a, b) => a - b)
    const root = parentFrame?.root ?? entry.name
    const sameMolecule = !!previous && previous.entry.name === entry.name
    const mol = {
      entry, record, recordError, blocks, elements, parentFrame, fit, rmsdToFirst, root, format: format === 'mol' ? 'sdf' : format,
      changed: new Set(record?.parent?.changed || []),
      chargeRange: Math.max(0.15, charges[Math.floor(charges.length * 0.95)] || 0.4),
      lipoRange: Math.max(0.2, lipos[Math.floor(lipos.length * 0.95)] || 0.6),
    }
    const sameAtoms = sameMolecule && previous.elements.join() === elements.join()
    if (!sameAtoms) { state.picks = []; state.measures = []; state.pinned = null }
    if (!sameMolecule) state.conf = 0
    // the view stays when the same molecule is rewritten, or when an analogue of the same family is
    // about the same size (so the shared core does not move); otherwise the camera re-frames, keeping
    // its rotation
    const extent = (block) => { const c = coordsOf(block).filter((_, i) => elements[i] !== 'H'); if (!c.length) return null; const m = centroid(c); return { m, r: Math.max(0.5, ...c.map((p) => Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]))) } }
    const now = extent(blocks[0])
    const before = previous ? previous.extent : null
    const similar = before && now && Math.abs(now.r - before.r) / before.r < 0.25 && Math.hypot(now.m[0] - before.m[0], now.m[1] - before.m[1], now.m[2] - before.m[2]) < before.r * 0.35
    const keep = !!previous && (sameMolecule || ((keepView || previous.root === root) && similar))
    const reframe = !!previous && !keep
    mol.extent = now
    state.mol = mol
    state.hover = null
    if (prefs.color === 'changed' && !record?.parent) prefs.color = 'element'
    buildScene({ keepView: keep || reframe })
    if (reframe) orient()
    renderHeader(); renderDepiction(); renderProperties(); renderConformers(); renderPlayer(); renderGhostChip(); renderLegend(); renderStrip(); renderSeries(); renderToolbar()
    $('empty').hidden = true
    $('side').hidden = false
    if (recordError && !record) toast(recordError)
  } catch (error) {
    if (token !== state.loading) return
    if (!state.mol) showEmpty('waiting', entry.sdf, error.message)
    else toast(`${humanName(entry.name)}: ${error.message}`)
  } finally {
    clearTimeout(slow)
    if (token === state.loading) busy(null, 'load')
  }
}
const basename = (p) => String(p).split('/').pop()

function renderHeader() {
  const mol = state.mol
  const rec = mol?.record
  $('name').textContent = mol ? humanName(mol.entry.name) : 'RDKit'
  $('name').title = mol?.entry.name || ''
  $('formula').innerHTML = subscripted(rec?.formula || '')
  const chips = []
  if (rec) {
    const lip = rec.rules?.lipinski
    chips.push(`<span class="chip ${lip?.violations?.length ? (lip.pass ? 'warn' : 'bad') : 'good'}" title="Lipinski's rule of five">Ro5 ${lip?.violations?.length ? lip.violations.length : '✓'}</span>`)
    chips.push(`<span class="chip" title="Molecular weight · Crippen cLogP">${fixed(rec.properties?.mw, 1)} Da · cLogP ${minus(fixed(rec.properties?.logp, 2))}</span>`)
  }
  $('ruleChips').innerHTML = chips.join('')
  const par = rec?.parent
  $('lineage').innerHTML = par
    ? `analogue of <b>${esc(humanName(par.name))}</b> · <span class="delta">${esc(par.change)}</span> · Tanimoto ${fixed(par.similarity, 2)}${models.length > 1 ? ` · ${models.length} conformers` : ''}`
    : rec ? `${esc(rec.smiles || '')}` : (mol ? esc(mol.entry.sdf) : '')
  document.title = mol ? `${mol.entry.name} — RDKit` : 'RDKit'
}

// ---------------------------------------------------------------------------------------------------
// live: progress from the toolchain, file changes from the server
// ---------------------------------------------------------------------------------------------------
const STAGES = { embedding: 'Embedding', minimising: 'Minimising', describing: 'Computing properties of', writing: 'Writing', parsing: 'Reading' }
function setProgress(p) {
  state.progress = p || null
  const status = $('status')
  const active = p && STAGES[p.stage]
  status.className = 'status' + (active ? ' working' : p?.stage === 'failed' ? ' failed' : state.live ? '' : ' off')
  if (active) {
    status.querySelector('span').textContent = `${STAGES[p.stage]} ${humanName(p.name)}…`
    status.title = p.detail || ''
  } else if (p?.stage === 'failed') {
    status.querySelector('span').textContent = `${humanName(p.name)} failed`
    status.title = p.detail || ''
  } else {
    status.querySelector('span').textContent = state.live ? 'Live' : 'Reconnecting…'
    status.title = 'The pane follows the workspace: it redraws when the agent writes a file'
  }
  if (active) busy(`${STAGES[p.stage]} ${humanName(p.name)}${p.detail ? ` · ${p.detail}` : ''}…`, 'progress')
  else busy(null, 'progress')
  if (!state.mol && !state.series.length) showEmpty(active ? 'working' : 'none')
}
const busyReasons = new Map()
function busy(text, reason) {
  if (text) busyReasons.set(reason, text); else busyReasons.delete(reason)
  const box = $('busy')
  const order = ['progress', 'load', 'surface']
  const shown = order.map((r) => busyReasons.get(r)).find(Boolean)
  box.hidden = !shown || (!state.mol && !!busyReasons.get('progress') && !busyReasons.get('load'))
  if (shown) box.querySelector('span').textContent = shown
}
function showEmpty(kind, path, detail) {
  const box = $('empty')
  box.hidden = false
  const p = state.progress
  if (kind === 'working' && p) {
    box.innerHTML = `<div class="box"><div class="glyph">${ICON.molecule}</div><h2><i class="spinner"></i>${esc(STAGES[p.stage] || 'Working on')} ${esc(humanName(p.name))}…</h2><p>${esc(p.detail || 'RDKit is building the molecule. It appears here the moment its SDF is written.')}</p></div>`
  } else if (kind === 'waiting') {
    box.innerHTML = `<div class="box"><div class="glyph">${ICON.molecule}</div><h2>Waiting for <code>${esc(path)}</code></h2><p>${esc(detail || '')}. The pane opens it as soon as the agent writes it.</p></div>`
  } else {
    box.innerHTML = `<div class="box"><div class="glyph">${ICON.molecule}</div><h2>No molecule yet</h2><p>Ask for one in the chat — a drug, an analogue, a series. Each SDF the agent writes to <code>out/</code> appears here in 3D, with its properties, its conformers and the series it belongs to.</p></div>`
  }
  $('toolbar').hidden = kind !== 'ready'
  $('side').hidden = true
}

let pendingChange = null
function onChange(files) {
  const dir = state.dir || 'out'
  const relevant = files.filter((f) => f.startsWith(`${dir}/`) || !f.includes('/'))
  if (!relevant.length) return
  clearTimeout(pendingChange)
  pendingChange = setTimeout(async () => {
    const before = state.series.find((e) => e.name === state.current)
    const res = await refreshSeries()
    if (!res) return
    const { newest } = res
    const now = state.series.find((e) => e.name === state.current)
    if (newest && state.follow && newest.name !== state.current && (!before || newest.mtime > before.mtime)) {
      await selectMolecule(newest.name, { keepView: false })
      if (state.series.length > 1) toast(`Showing ${humanName(newest.name)}, just written`)
      return
    }
    if (newest && !state.follow && newest.name !== state.current && res.previousNewest !== newest.name) {
      toast(`${humanName(newest.name)} was just written`, 'Show', () => selectMolecule(newest.name, { user: true }))
    }
    if (!state.current && newest) { await selectMolecule(newest.name); return }
    if (now && (!before || now.mtime !== before.mtime || !state.mol?.record)) await loadMolecule(now, { keepView: true })
  }, 60)
}
function connect() {
  const events = new EventSource('/events')
  events.addEventListener('open', () => { state.live = true; setProgress(state.progress) })
  events.addEventListener('error', () => { state.live = false; setProgress(state.progress) })
  events.addEventListener('change', (e) => { try { onChange(JSON.parse(e.data).files || []) } catch { onChange([]) } })
  events.addEventListener('progress', (e) => {
    try {
      const data = JSON.parse(e.data)
      if (!state.dir || data.dir === state.dir) setProgress(data.progress)
    } catch { /* ignore */ }
  })
}

// ---------------------------------------------------------------------------------------------------
// toolbar, menus, export, keyboard
// ---------------------------------------------------------------------------------------------------
const REPS = [['wire', 'Wire', ICON.wire, '1'], ['stick', 'Stick', ICON.stick, '2'], ['ballstick', 'Ball & stick', ICON.ball, '3'], ['space', 'Spacefill', ICON.space, '4']]
const HYDROGENS = { all: 'All hydrogens', polar: 'Polar hydrogens', none: 'No hydrogens' }
const COLORS = { element: 'By element', charge: 'Gasteiger charge', lipo: 'Crippen lipophilicity', changed: 'Changed vs parent' }
function renderToolbar() {
  const bar = $('toolbar')
  bar.hidden = !state.mol
  const hShort = { all: 'All', polar: 'Polar', none: 'None' }[prefs.hydrogens]
  bar.innerHTML = `<div class="seg">${REPS.map(([k, label, icon, key]) => `<button class="tb" data-rep="${k}" aria-pressed="${prefs.rep === k}" title="${label} (${key})">${icon}<span class="lbl">${label === 'Ball & stick' ? 'Ball' : label === 'Spacefill' ? 'Space' : label}</span></button>`).join('')}</div>`
    + `<span class="sep"></span>`
    + `<button class="tb" data-menu="h" title="Hydrogens (H)">${ICON.h}<span class="lbl val">${hShort}</span>${ICON.caret}</button>`
    + `<button class="tb" data-menu="color" title="Colour atoms (C)">${ICON.palette}<span class="lbl">Colour</span>${ICON.caret}</button>`
    + `<button class="tb" data-menu="surface" aria-pressed="${prefs.surface !== 'none'}" title="Molecular surface (S)">${ICON.surface}<span class="lbl">Surface</span>${ICON.caret}</button>`
    + `<button class="tb" data-menu="measure" title="Click atoms to measure (D, A, T)">${ICON.ruler}<span class="lbl">${MEASURE[prefs.measure].label}</span>${ICON.caret}</button>`
    + `<span class="sep"></span>`
    + `<button class="tb" data-act="spin" aria-pressed="${!!state.spinning}" title="Spin (Space)">${ICON.spin}</button>`
    + `<button class="tb" data-act="home" title="Reset the view (R)">${ICON.home}</button>`
    + `<button class="tb" data-menu="look" title="Background and lighting (B)">${ICON.bg}${ICON.caret}</button>`
  bar.querySelectorAll('[data-rep]').forEach((b) => { b.onclick = () => setRep(b.dataset.rep) })
  bar.querySelectorAll('[data-menu]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openToolbarMenu(b.dataset.menu, b) } })
  bar.querySelector('[data-act="spin"]').onclick = toggleSpin
  bar.querySelector('[data-act="home"]').onclick = () => orient()
}
function setRep(rep) { prefs.rep = rep; savePrefs(); applyStyles(); drawMeasures(); drawGroupHighlight(); renderToolbar() }
function setHydrogens(h) { prefs.hydrogens = h; savePrefs(); applyStyles(); renderToolbar() }
function setColor(c) { prefs.color = c; savePrefs(); applyStyles(); renderLegend(); renderToolbar() }
function setSurface(type, color) {
  if (type) prefs.surface = type
  if (color) prefs.surfaceColor = color
  savePrefs(); paintSurface(); renderToolbar()
}
function toggleSpin() { state.spinning = !state.spinning; viewer.spin(state.spinning ? 'y' : false, 0.6); renderToolbar() }
function toggleBackground() { prefs.bg = prefs.bg === 'dark' ? 'light' : 'dark'; savePrefs(); applyBackground(); drawMeasures(); if (prefs.surface !== 'none' && prefs.surfaceColor === 'plain') paintSurface() }

let openMenu = null
let opacityTimer = null
function closeMenu() { if (openMenu) { openMenu.el.remove(); openMenu.button?.classList.remove('menu-open'); openMenu = null } }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.el.contains(e.target) && e.target !== openMenu.button && !openMenu.button?.contains(e.target)) closeMenu() })
function showMenu(button, items, { above = true } = {}) {
  closeMenu()
  const el = document.createElement('div')
  el.className = 'menu floating'
  for (const item of items) {
    if (item === '-') { el.insertAdjacentHTML('beforeend', '<div class="ms"></div>'); continue }
    if (item.header) { el.insertAdjacentHTML('beforeend', `<div class="mh">${esc(item.header)}</div>`); continue }
    if (item.slider) {
      const wrap = document.createElement('div'); wrap.className = 'slider'
      wrap.innerHTML = `<span>${esc(item.slider)}</span><input type="range" min="${item.min}" max="${item.max}" step="${item.step}" value="${item.value}"><span class="sv">${Math.round(item.value * 100)}%</span>`
      const input = wrap.querySelector('input')
      input.oninput = () => { wrap.querySelector('.sv').textContent = `${Math.round(input.value * 100)}%`; item.onInput(Number(input.value)) }
      el.appendChild(wrap); continue
    }
    const b = document.createElement('button')
    b.className = 'mi'
    b.disabled = !!item.disabled
    b.innerHTML = `<span class="check">${item.checked ? ICON.check : ''}</span>${item.icon || ''}<span>${esc(item.label)}</span>${item.kbd ? `<span class="kbd">${esc(item.kbd)}</span>` : ''}`
    b.onclick = () => { closeMenu(); item.run() }
    el.appendChild(b)
  }
  document.body.appendChild(el)
  const r = button.getBoundingClientRect()
  const w = el.offsetWidth, h = el.offsetHeight
  let left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)
  let top = above ? r.top - h - 8 : r.bottom + 6
  if (top < 8) top = r.bottom + 6
  if (!above && left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
  if (!above) left = clamp(r.right - w, 8, window.innerWidth - w - 8)
  el.style.left = `${left}px`; el.style.top = `${top}px`
  button.classList.add('menu-open')
  openMenu = { el, button }
}
function openToolbarMenu(kind, button) {
  if (openMenu?.button === button) { closeMenu(); return }
  const rec = state.mol?.record
  if (kind === 'h') {
    showMenu(button, Object.entries(HYDROGENS).map(([k, label]) => ({ label, checked: prefs.hydrogens === k, run: () => setHydrogens(k) })).concat(['-', { label: 'Cycle', kbd: 'H', run: cycleHydrogens }]))
  } else if (kind === 'color') {
    showMenu(button, Object.entries(COLORS).map(([k, label]) => ({ label, checked: prefs.color === k, disabled: (k === 'changed' && !rec?.parent) || ((k === 'charge' || k === 'lipo') && !rec), run: () => setColor(k) })).concat(['-', { label: 'Cycle', kbd: 'C', run: cycleColor }]))
  } else if (kind === 'surface') {
    showMenu(button, [
      { header: 'Surface' },
      ...Object.entries(SURFACES).map(([k, label]) => ({ label, checked: prefs.surface === k, run: () => setSurface(k) })),
      { header: 'Colour by' },
      ...Object.entries(SURFACE_COLORS).map(([k, label]) => ({ label, checked: prefs.surfaceColor === k, disabled: (k === 'esp' || k === 'lipo') && !rec, run: () => setSurface(prefs.surface === 'none' ? 'VDW' : null, k) })),
      { slider: 'Opacity', min: 0.2, max: 1, step: 0.05, value: prefs.opacity, onInput: (v) => { prefs.opacity = v; savePrefs(); clearTimeout(opacityTimer); opacityTimer = setTimeout(() => { applyBackground(false); if (prefs.surface !== 'none') paintSurface() }, 180) } },
    ])
  } else if (kind === 'look') {
    showMenu(button, [
      { header: 'Background' },
      { label: 'Light', checked: prefs.bg !== 'dark', kbd: 'B', run: () => { if (prefs.bg === 'dark') toggleBackground() } },
      { label: 'Dark', checked: prefs.bg === 'dark', run: () => { if (prefs.bg !== 'dark') toggleBackground() } },
      { header: 'Lighting' },
      { label: 'Soft shadows', checked: prefs.look === 'soft', run: () => setLook('soft') },
      { label: 'Outlined', checked: prefs.look === 'outline', run: () => setLook('outline') },
      { label: 'Plain', checked: prefs.look === 'plain', run: () => setLook('plain') },
    ])
  } else if (kind === 'measure') {
    showMenu(button, [
      ...Object.entries(MEASURE).map(([k, m]) => ({ label: `${m.label} · ${m.n} atoms`, checked: prefs.measure === k, kbd: m.key, run: () => setMeasureMode(k) })),
      '-',
      { label: 'Clear measurements', kbd: 'Delete', disabled: !state.measures.length && !state.picks.length, run: clearMeasures },
    ])
  }
}
function setLook(look) { prefs.look = look; savePrefs(); applyBackground() }
function setMeasureMode(k) { prefs.measure = k; state.picks = []; savePrefs(); drawMeasures(); renderToolbar() }
function cycleHydrogens() { const k = Object.keys(HYDROGENS); setHydrogens(k[(k.indexOf(prefs.hydrogens) + 1) % k.length]) }
function cycleColor() {
  const k = Object.keys(COLORS).filter((c) => c !== 'changed' || state.mol?.record?.parent)
  setColor(k[(k.indexOf(prefs.color) + 1) % k.length])
}
function cycleSurface() { const k = Object.keys(SURFACES); setSurface(k[(k.indexOf(prefs.surface) + 1) % k.length]) }

function download(href, name) {
  const a = document.createElement('a')
  a.href = href; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
}
function viewImage(scale = 2) {
  const glCanvas = viewer.getCanvas()
  viewer.render()
  const w = glCanvas.width, h = glCanvas.height
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  const ctx = out.getContext('2d')
  const g = ctx.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h * 0.38, Math.max(w, h) * 0.75)
  if (prefs.bg === 'dark') { g.addColorStop(0, '#2a2d33'); g.addColorStop(0.6, '#1b1d22'); g.addColorStop(1, '#121317') }
  else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#f4f5f7'); g.addColorStop(1, '#e8eaee') }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const img = new Image()
  return new Promise((resolve) => { img.onload = () => { ctx.drawImage(img, 0, 0, w, h); resolve(out) }; img.src = viewer.pngURI() })
}
async function exportPng() {
  const canvas = await viewImage()
  canvas.toBlob((blob) => { const url = URL.createObjectURL(blob); download(url, `${state.mol?.entry.name || 'molecule'}.png`); setTimeout(() => URL.revokeObjectURL(url), 4000); toast('PNG of the view saved') })
}
async function copyPng() {
  try {
    const canvas = await viewImage()
    const blob = await new Promise((r) => canvas.toBlob(r))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    toast('Image copied')
  } catch { toast('This browser does not allow copying images — use Save PNG') }
}
function openExportMenu() {
  const mol = state.mol
  const e = mol?.entry
  const rec = mol?.record
  const confFile = rec?.conformers?.count > 1 ? `${state.dir}/${rec.conformers.file}` : null
  showMenu($('exportBtn'), [
    { header: 'Image' },
    { label: 'Save PNG of the view', icon: ICON.image, disabled: !mol, run: exportPng },
    { label: 'Copy image', icon: ICON.copy, disabled: !mol, run: copyPng },
    { label: 'Save 2D depiction (SVG)', icon: ICON.image, disabled: !rec?.svgText, run: () => { const url = URL.createObjectURL(new Blob([rec.svgText], { type: 'image/svg+xml' })); download(url, `${e.name}.svg`); setTimeout(() => URL.revokeObjectURL(url), 4000) } },
    { header: 'Structure' },
    { label: 'SDF — lowest conformer', icon: ICON.file, disabled: !e, run: () => download(`/${e.sdf}?download=1`, basename(e.sdf)) },
    { label: `SDF — all ${rec?.conformers?.count || ''} conformers`, icon: ICON.file, disabled: !confFile, run: () => download(`/${confFile}?download=1`, basename(confFile)) },
    { label: 'MOL file', icon: ICON.file, disabled: !e, run: () => download(`/api/mol?path=${encodeURIComponent(e.sdf)}`, `${e.name}.mol`) },
    '-',
    { label: 'Copy SMILES', icon: ICON.copy, disabled: !rec?.smiles, run: () => copyText(rec.smiles) },
  ], { above: false })
}
$('exportBtn').onclick = (e) => { e.stopPropagation(); if (openMenu?.button === $('exportBtn')) closeMenu(); else openExportMenu() }

async function copyText(text, button) {
  let ok = false
  try { await navigator.clipboard.writeText(text); ok = true } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
  }
  if (button) { button.classList.add('done'); button.innerHTML = ICON.ok; setTimeout(() => { button.classList.remove('done'); button.innerHTML = ICON.copy }, 1200) }
  else toast(ok ? 'Copied' : 'Could not copy')
}
let toastTimer = null
function toast(text, action, run) {
  const box = $('toast')
  box.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="link">${esc(action)}</button>` : ''}`
  if (action) box.querySelector('button').onclick = () => { box.hidden = true; run() }
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.hidden = true }, action ? 6000 : 2400)
}

const SHORTCUTS = [
  ['1 2 3 4', 'Wire, stick, ball & stick, spacefill'], ['H', 'Hydrogens: all, polar, none'], ['C', 'Colour: element, charge, lipophilicity, change'],
  ['S', 'Surface: none, VDW, SAS, SES'], ['Space', 'Spin'], ['R', 'Reset the view'], ['B', 'Light or dark background'],
  ['D  A  T', 'Measure distance, angle, dihedral'], ['Esc', 'Cancel picks, close menus'], ['Delete', 'Clear measurements'],
  ['[  ]', 'Previous / next conformer'], ['P', 'Play conformers'], ['O', 'Overlay all conformers'], ['G', 'Overlay the parent'],
  ['J  K', 'Previous / next molecule in the series'], ['E', 'Export'], ['?', 'This sheet'],
]
function toggleHelp(force) {
  const box = $('help')
  box.hidden = force === undefined ? !box.hidden : !force
  if (!box.hidden) {
    box.innerHTML = `<div class="sheet"><h3>Keyboard</h3><div class="cols">${SHORTCUTS.map(([k, v]) => `<div class="kr"><span>${esc(v)}</span><span>${k.split(/\s{1,2}/).map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span></div>`).join('')}</div><div class="foot">Drag to rotate, scroll or pinch to zoom, right-drag or ctrl-drag to move. Hover an atom in 3D or 2D for its charge, hybridisation and groups; click atoms to measure.</div></div>`
    box.onclick = (e) => { if (e.target === box) toggleHelp(false) }
  }
}
$('helpBtn').onclick = () => toggleHelp()
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  const k = e.key
  if (k === 'Escape') { closeMenu(); toggleHelp(false); if (state.picks.length) { state.picks = []; drawMeasures() } else if (state.pinned) { state.pinned = null; renderGroups(); drawGroupHighlight() } return }
  if (k === '?') { toggleHelp(); return }
  if (!state.mol) return
  const actions = {
    1: () => setRep('wire'), 2: () => setRep('stick'), 3: () => setRep('ballstick'), 4: () => setRep('space'),
    h: cycleHydrogens, c: cycleColor, s: cycleSurface, ' ': toggleSpin, r: () => orient(), b: toggleBackground,
    d: () => setMeasureMode('distance'), a: () => setMeasureMode('angle'), t: () => setMeasureMode('dihedral'),
    Backspace: clearMeasures, Delete: clearMeasures, '[': () => setConformer(state.conf - 1), ']': () => setConformer(state.conf + 1),
    p: togglePlay, o: () => { prefs.ensemble = !prefs.ensemble; savePrefs(); applyStyles(); renderConformers() }, g: () => setGhost(!prefs.ghost),
    e: openExportMenu, j: () => stepSeries(-1), k: () => stepSeries(1), ArrowUp: () => stepSeries(-1), ArrowDown: () => stepSeries(1),
  }
  const run = actions[k] || actions[k.toLowerCase?.()]
  if (run) { e.preventDefault(); run() }
})
function stepSeries(d) {
  const i = state.series.findIndex((e) => e.name === state.current)
  const next = state.series[i + d]
  if (next) selectMolecule(next.name, { user: true })
}
document.querySelectorAll('.tabbar button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab) })
function setTab(tab) {
  prefs.tab = tab; savePrefs()
  document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
  for (const t of ['props', 'confs', 'series']) $(`panel-${t}`).hidden = t !== tab
}

// ---------------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------------
async function boot() {
  setTab(prefs.tab)
  applyBackground()
  const file = state.file.replace(/^\/+/, '')
  if (file.includes('/')) state.dir = file.slice(0, file.lastIndexOf('/'))
  connect()
  await refreshSeries()
  const wanted = file ? file.replace(/\.conformers\.sdf$/, '.sdf') : null
  let entry = wanted ? state.series.find((e) => e.sdf === wanted) : null
  if (!entry && state.newest) entry = state.series.find((e) => e.name === state.newest)
  if (entry) {
    state.follow = entry.name === state.newest
    await selectMolecule(entry.name, { keepView: false })
  } else if (wanted && !state.series.length) {
    showEmpty(state.progress && STAGES[state.progress.stage] ? 'working' : 'none')
  } else {
    showEmpty(state.progress && STAGES[state.progress.stage] ? 'working' : 'none')
  }
  renderToolbar()
  // a handle for headless checks (screenshots, the live test); nothing in the pane depends on it
  window.__pane = {
    atomScreen: (i) => { const a = atomAt(i); const p = viewer.modelToScreen({ x: a.x, y: a.y, z: a.z }); return { x: p.x, y: p.y } },
    atom2D: (i) => { const svg = $('depict').querySelector('svg'); const [x, y] = state.mol.pos2d.get(i); const pt = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()); return { x: pt.x, y: pt.y } }, state, prefs, viewer, setConformer, setRep, setSurface, setColor, setHydrogens, pick, setHover, selectMolecule, setTab, setGhost, orient, toggleSpin, clearMeasures, setMeasureMode }
}
boot()
