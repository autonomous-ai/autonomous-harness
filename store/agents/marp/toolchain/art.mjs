#!/usr/bin/env node
// Art a deck can have without an image service: wallpaper-style gradient art, a minimal chart,
// and a device frame around any picture. SVG out, deterministic from a seed, no network.
//
//   node art.mjs wallpaper -o assets/bg.svg [--palette aurora|sunset|ocean|graphite|spectrum] [--seed 7] [--size 1920x1080]
//   node art.mjs chart -o assets/chart.svg --data "2022:12,2023:31,2024:64" [--type bar|line] [--accent "#2997ff"] [--label "Revenue, $M"]
//   node art.mjs frame -o assets/phone.svg --image assets/screen.png [--kind phone|laptop|window] [--palette aurora]
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'

const PALETTES = {
  aurora: ['#5e5ce6', '#bf5af2', '#ff375f', '#30d158', '#64d2ff'],
  sunset: ['#ff9f0a', '#ff375f', '#bf5af2', '#ff453a', '#ffd60a'],
  ocean: ['#0a84ff', '#64d2ff', '#5e5ce6', '#30d158', '#0040dd'],
  graphite: ['#3a3a3c', '#636366', '#8e8e93', '#1c1c1e', '#48484a'],
  spectrum: ['#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2'],
}

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true }
    else if (a === '-o') { out.o = argv[++i] }
    else out._.push(a)
  }
  return out
}
function rng(seed) {
  let s = (Number(seed) || 1) >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') }

export function wallpaper({ palette = 'aurora', seed = 7, size = '1920x1080', dark = true } = {}) {
  const [w, h] = size.split('x').map(Number)
  const colors = PALETTES[palette] ?? PALETTES.aurora
  const r = rng(seed)
  const blobs = []
  for (let i = 0; i < 6; i++) {
    const c = colors[i % colors.length]
    const cx = Math.round(w * (0.1 + r() * 0.8)), cy = Math.round(h * (0.1 + r() * 0.8))
    const rx = Math.round(w * (0.18 + r() * 0.22)), ry = Math.round(h * (0.22 + r() * 0.28))
    const rot = Math.round(r() * 180)
    blobs.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}" fill-opacity="${(0.55 + r() * 0.3).toFixed(2)}" transform="rotate(${rot} ${cx} ${cy})"/>`)
  }
  const base = dark ? '#000' : '#fff'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) * 0.11)}"/></filter>
  <radialGradient id="vig" cx="50%" cy="50%" r="72%"><stop offset="60%" stop-color="${base}" stop-opacity="0"/><stop offset="100%" stop-color="${base}" stop-opacity="${dark ? 0.85 : 0.5}"/></radialGradient>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.06"/></feComponentTransfer></filter>
</defs>
<rect width="${w}" height="${h}" fill="${base}"/>
<g filter="url(#blur)">${blobs.join('')}</g>
<rect width="${w}" height="${h}" fill="url(#vig)"/>
<rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.5"/>
</svg>
`
}

export function chart({ data = '', type = 'bar', accent = '#2997ff', label = '', dark = true } = {}) {
  const points = String(data).split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const [k, v] = pair.split(':'); return { k: k.trim(), v: Number(v) }
  }).filter((p) => Number.isFinite(p.v))
  if (!points.length) throw new Error('chart: --data "label:value,label:value" is required')
  const w = 1200, h = 700, left = 80, right = 60, top = label ? 150 : 90, bottom = 110
  const iw = w - left - right, ih = h - top - bottom
  const max = Math.max(...points.map((p) => p.v)) || 1
  const fg = dark ? '#f5f5f7' : '#1d1d1f', muted = dark ? '#6e6e73' : '#86868b', bg = 'none'
  const font = `font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif"`
  let body = ''
  if (type === 'line') {
    const step = points.length > 1 ? iw / (points.length - 1) : 0
    const pts = points.map((p, i) => [left + i * step, top + ih - (p.v / max) * ih])
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
    body += `<path d="${d}" fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`
    body += `<path d="${d} L${pts.at(-1)[0].toFixed(1)} ${top + ih} L${left} ${top + ih} Z" fill="${accent}" fill-opacity="0.12"/>`
    pts.forEach(([x, y], i) => {
      body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12" fill="${accent}"/>`
      body += `<text x="${x.toFixed(1)}" y="${top + ih + 52}" text-anchor="middle" fill="${muted}" font-size="26" ${font}>${esc(points[i].k)}</text>`
      body += `<text x="${x.toFixed(1)}" y="${(y - 28).toFixed(1)}" text-anchor="middle" fill="${fg}" font-size="30" font-weight="600" ${font}>${esc(points[i].v)}</text>`
    })
  } else {
    const gap = 28, bw = (iw - gap * (points.length - 1)) / points.length
    points.forEach((p, i) => {
      const x = left + i * (bw + gap), bh = (p.v / max) * ih, y = top + ih - bh
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="18" fill="${accent}" fill-opacity="${i === points.length - 1 ? 1 : 0.55}"/>`
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${top + ih + 52}" text-anchor="middle" fill="${muted}" font-size="26" ${font}>${esc(p.k)}</text>`
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 22).toFixed(1)}" text-anchor="middle" fill="${fg}" font-size="34" font-weight="600" ${font}>${esc(p.v)}</text>`
    })
  }
  const title = label ? `<text x="${left}" y="44" fill="${muted}" font-size="24" font-weight="500" letter-spacing="2" ${font}>${esc(String(label).toUpperCase())}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="background:${bg}">
${title}
<line x1="${left}" y1="${top + ih}" x2="${left + iw}" y2="${top + ih}" stroke="${muted}" stroke-opacity="0.35" stroke-width="2"/>
${body}
</svg>
`
}

function dataUri(file) {
  const ext = extname(file).toLowerCase()
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' }[ext]
  if (!mime) throw new Error(`frame: unsupported image ${file}`)
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`
}

export function frame({ image, kind = 'phone', palette = 'graphite', seed = 3 } = {}) {
  if (!image || !existsSync(image)) throw new Error('frame: --image <file> is required and must exist')
  const href = dataUri(image)
  const w = 1920, h = 1080
  const bg = wallpaper({ palette, seed, size: `${w}x${h}` }).replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')
  let device
  if (kind === 'laptop') {
    device = `<g transform="translate(360 150)">
      <rect x="0" y="0" width="1200" height="760" rx="44" fill="#0b0b0c" stroke="#3a3a3c" stroke-width="3"/>
      <clipPath id="screen"><rect x="40" y="36" width="1120" height="688" rx="18"/></clipPath>
      <image href="${href}" x="40" y="36" width="1120" height="688" preserveAspectRatio="xMidYMid slice" clip-path="url(#screen)"/>
      <rect x="-80" y="760" width="1360" height="26" rx="10" fill="#1c1c1e" stroke="#3a3a3c" stroke-width="2"/>
    </g>`
  } else if (kind === 'window') {
    device = `<g transform="translate(320 120)">
      <rect x="0" y="0" width="1280" height="840" rx="26" fill="#1c1c1e" stroke="#3a3a3c" stroke-width="2"/>
      <circle cx="30" cy="26" r="8" fill="#ff5f57"/><circle cx="56" cy="26" r="8" fill="#febc2e"/><circle cx="82" cy="26" r="8" fill="#28c840"/>
      <clipPath id="screen"><rect x="0" y="52" width="1280" height="788" rx="0"/></clipPath>
      <image href="${href}" x="0" y="52" width="1280" height="788" preserveAspectRatio="xMidYMid slice" clip-path="url(#screen)"/>
    </g>`
  } else {
    device = `<g transform="translate(760 70)">
      <rect x="0" y="0" width="400" height="860" rx="70" fill="#0b0b0c" stroke="#3a3a3c" stroke-width="3"/>
      <clipPath id="screen"><rect x="18" y="18" width="364" height="824" rx="56"/></clipPath>
      <image href="${href}" x="18" y="18" width="364" height="824" preserveAspectRatio="xMidYMid slice" clip-path="url(#screen)"/>
      <rect x="140" y="34" width="120" height="34" rx="17" fill="#000"/>
    </g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${bg}
<g filter="drop-shadow(0 40px 60px rgba(0,0,0,.6))">${device}</g>
</svg>
`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2))
  const cmd = a._[0]
  const out = a.o
  try {
    let svg
    if (cmd === 'wallpaper') svg = wallpaper({ palette: a.palette, seed: a.seed, size: a.size, dark: a.light ? false : true })
    else if (cmd === 'chart') svg = chart({ data: a.data, type: a.type, accent: a.accent, label: a.label, dark: a.light ? false : true })
    else if (cmd === 'frame') svg = frame({ image: a.image ? resolve(a.image) : undefined, kind: a.kind, palette: a.palette, seed: a.seed })
    else { console.error('usage: art.mjs wallpaper|chart|frame -o <file.svg> [options]'); process.exit(2) }
    if (!out) { process.stdout.write(svg); process.exit(0) }
    writeFileSync(out, svg)
    console.log(`wrote ${out}`)
  } catch (error) {
    console.error(`art: ${error instanceof Error ? error.message : error}`); process.exit(1)
  }
}
