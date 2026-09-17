// Small shared pieces: DOM building, formatting, theme colours for canvases, persistence, popovers.

export const $ = (sel, root = document) => root.querySelector(sel)

/** h('div.row.sel', { onclick }, child, 'text') */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.')
  const el = document.createElement(name || 'div')
  if (classes.length) el.className = classes.join(' ')
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs)
    attrs = null
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'html') el.innerHTML = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v)
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return el
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const ICONS = {
  check: '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>',
  cross: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
  chev: '<svg viewBox="0 0 14 14"><path d="M5.5 3.5 9 7l-3.5 3.5"/></svg>',
  module: '<svg viewBox="0 0 14 14"><rect x="2" y="2.5" width="10" height="9" rx="1.5"/><path d="M2 5.5h10"/></svg>',
  fn: '<svg viewBox="0 0 14 14"><path d="M8.5 2.5c-2 0-2 1.5-2.3 3.5l-.7 4c-.3 1.6-1 2-2.5 2M4.5 6h5"/></svg>',
  fit: '<svg viewBox="0 0 16 16"><path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5"/></svg>',
  zin: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14M5 7h4M7 5v4"/></svg>',
  zout: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14M5 7h4"/></svg>',
  list: '<svg viewBox="0 0 16 16"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>',
  tree: '<svg viewBox="0 0 16 16"><path d="M3 2.5v9h4M3 6h4"/><rect x="8" y="4" width="5.5" height="4" rx="1"/><rect x="8" y="9.5" width="5.5" height="4" rx="1"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
  log: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h6l3 3v8h-9z M5.5 8h5M5.5 10.5h5"/></svg>',
  code: '<svg viewBox="0 0 16 16"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>',
  wave: '<svg viewBox="0 0 16 16"><path d="M1 11h3V5h3v6h3V5h3v6h2"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-1v-8h8v1"/></svg>',
  route: '<svg viewBox="0 0 16 16"><path d="M2.5 13.5h4v-6h4v-5h3"/></svg>',
}

// ------------------------------------------------------------------------------------ colours

let colorCache = null
export function colors() {
  if (colorCache) return colorCache
  const cs = getComputedStyle(document.documentElement)
  const get = (n) => cs.getPropertyValue(n).trim()
  const real = {}
  for (const n of ['bg', 'panel', 'card', 'line', 'guide', 'ink', 'ink2', 'faint', 'accent', 'accent-soft', 'ok', 'bad', 'warn', 'teal', 'violet', 'gold',
    'w-bg', 'w-grid', 'w-row', 'w-sel', 'w-bit', 'w-bit-fill', 'w-bus', 'w-bus-fill', 'w-text', 'w-x', 'w-x-fill', 'w-z', 'w-cursor', 'w-marker',
    'w-hover', 'w-uart', 'w-uart-fill', 'w-analog', 'f-die', 'f-tile', 'f-tile-line', 'f-io', 'f-ram', 'f-dsp', 'f-ipcon', 'f-route', 'f-path', 'mono']) {
    real[n] = get(`--${n}`)
  }
  colorCache = real
  return real
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  colorCache = null
  window.dispatchEvent(new Event('themechange'))
})

/** The design palette for modules and people alike (desktop's avatarPalette), light and dark. */
export const PALETTE_LIGHT = ['#1d5bd6', '#0f766e', '#a65a08', '#be123c', '#6d28d9', '#15803d', '#a21caf', '#4e5d78']
export const PALETTE_DARK = ['#6b93ff', '#2dd4bf', '#f0a347', '#fb7185', '#a78bfa', '#4ade80', '#e879f9', '#94a3b8']
export const palette = () => (matchMedia('(prefers-color-scheme: dark)').matches ? PALETTE_DARK : PALETTE_LIGHT)

// --------------------------------------------------------------------------------- formatting

export function bytes(n) {
  if (n == null) return ''
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1048576).toFixed(1)} MB`
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
  const m = Math.floor(ms / 60000)
  return `${m}m ${Math.round((ms - m * 60000) / 1000)}s`
}

export function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${Math.round(s)} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ts).toLocaleDateString()
}

// ---------------------------------------------------------------------------------- persistence

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`yosys-pane:${key}`)
      return v == null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try { localStorage.setItem(`yosys-pane:${key}`, JSON.stringify(value)) } catch { /* private mode, full */ }
  },
}

// ------------------------------------------------------------------------------------- fetch

export async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error ?? msg } catch { /* not json */ }
    const e = new Error(msg)
    e.status = r.status
    throw e
  }
  return r.json()
}

export async function getText(url) {
  const r = await fetch(url, { cache: 'no-store' })
  const text = await r.text()
  if (!r.ok) {
    const e = new Error(text || `${r.status}`)
    e.status = r.status
    throw e
  }
  return text
}

// ------------------------------------------------------------------------------ popovers

const tip = () => document.getElementById('tooltip')
export function showTip(x, y, html) {
  const t = tip()
  t.innerHTML = html
  t.hidden = false
  const r = t.getBoundingClientRect()
  const W = window.innerWidth, H = window.innerHeight
  let left = x + 14, top = y + 16
  if (left + r.width > W - 6) left = Math.max(6, x - r.width - 12)
  if (top + r.height > H - 6) top = Math.max(6, y - r.height - 12)
  t.style.left = `${left}px`
  t.style.top = `${top}px`
}
export function hideTip() { tip().hidden = true }

/** A context menu: items are { label, on, shortcut, danger, action } | 'sep' | { header }. */
export function openMenu(x, y, items) {
  const m = document.getElementById('menu')
  m.innerHTML = ''
  for (const it of items) {
    if (it === 'sep') { m.append(h('hr')); continue }
    if (it.header) { m.append(h('div.mh', it.header)); continue }
    const el = h(`div.mi${it.on ? '.on' : ''}${it.danger ? '.danger' : ''}`, {
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.action?.() },
    }, h('span', it.label), it.shortcut ? h('span.sc', it.shortcut) : null)
    m.append(el)
  }
  m.hidden = false
  const r = m.getBoundingClientRect()
  m.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`
  m.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`
  setTimeout(() => {
    const off = (e) => {
      if (m.contains(e.target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', off, { once: true, capture: true })
  })
}
export function closeMenu() { document.getElementById('menu').hidden = true }
export const menuOpen = () => !document.getElementById('menu').hidden

// ------------------------------------------------------------------------------------ canvas

export function fitCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr))
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

export function emptyState({ icon, title, body, spinner }) {
  return h('div.empty', h('div.box',
    spinner ? h('div', { style: { marginBottom: '12px' } }, h('span.spinner')) : icon ? h('div.art', { html: icon }) : null,
    h('h3', title),
    typeof body === 'string' ? h('p', { html: body }) : body))
}

export const ART = {
  waves: '<svg viewBox="0 0 64 64"><path d="M6 22h8V12h10v10h8V12h10v10h16M6 42h6l3-6h14l3 6h6l3-6h14l3 6h2" /></svg>',
  schematic: '<svg viewBox="0 0 64 64"><path d="M6 20h12M6 44h12M46 32h12"/><path d="M18 12h12a16 16 0 0 1 16 16v8a16 16 0 0 1-16 16H18z"/></svg>',
  chip: '<svg viewBox="0 0 64 64"><rect x="14" y="14" width="36" height="36" rx="4"/><rect x="24" y="24" width="16" height="16" rx="2"/><path d="M22 4v10M32 4v10M42 4v10M22 50v10M32 50v10M42 50v10M4 22h10M4 32h10M4 42h10M50 22h10M50 32h10M50 42h10"/></svg>',
  board: '<svg viewBox="0 0 64 64"><rect x="6" y="14" width="52" height="36" rx="4"/><rect x="24" y="22" width="16" height="16" rx="2"/><circle cx="14" cy="22" r="2"/><circle cx="14" cy="42" r="2"/><path d="M46 22h6M46 30h6M46 38h6"/></svg>',
  flow: '<svg viewBox="0 0 64 64"><circle cx="12" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="52" cy="32" r="5"/><path d="M17 32h10M37 32h10"/></svg>',
}
