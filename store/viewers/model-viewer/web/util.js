// Small shared pieces: number formats in millimetres, time ago, DOM helpers, icons.

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'style' && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (k.startsWith('--')) node.style.setProperty(k, v); else node.style[k] = v }
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

/** replaceChildren that skips the nulls a conditional child leaves (the DOM would print "null"). */
export function put(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))
  return node
}

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
export const int = (n) => grouped.format(Math.round(n))

/** A length in millimetres at a precision that suits its size: 1 234 · 123.4 · 12.35 · 0.125. */
export function mm(value, unit = true) {
  const v = Math.abs(value)
  let text
  if (v >= 1000) text = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
  else if (v >= 100) text = value.toFixed(1)
  else if (v >= 1) text = value.toFixed(2)
  else if (v === 0) text = '0'
  else text = value.toFixed(3)
  text = text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return unit ? `${text} mm` : text
}

export function dims(size) {
  return `${mm(size[0], false)} × ${mm(size[1], false)} × ${mm(size[2], false)} mm`
}

export function deg(value) {
  const t = (Math.abs(value) < 0.0005 ? 0 : value).toFixed(1).replace(/\.0$/, '')
  return `${t}°`
}

export function bytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function debounce(fn, ms) {
  let t = null
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

export function store(key, fallback, kind = localStorage) {
  try { const raw = kind.getItem(key); return raw === null ? fallback : JSON.parse(raw) } catch { return fallback }
}
export function save(key, value, kind = localStorage) {
  try { kind.setItem(key, JSON.stringify(value)) } catch { /* private mode, full: it is a convenience */ }
}

// Icons: 16×16, stroked with currentColor, drawn for this pane.
const svg = (body, extra = '') => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`
export const icon = {
  wire: svg('<circle cx="8" cy="8" r="5.6"/><ellipse cx="8" cy="8" rx="2.4" ry="5.6"/><path d="M2.4 8h11.2"/>'),
  solid: svg('<circle cx="8" cy="8" r="5.6" fill="currentColor" fill-opacity=".28"/><path d="M5 5.2a3.6 3.6 0 0 1 2.2-1.1" stroke-width="1.2"/>'),
  material: svg('<circle cx="8" cy="8" r="5.6"/><circle cx="6.2" cy="6.2" r="1.6" fill="currentColor" stroke="none"/><path d="M3.2 10.2c2.6 1.4 6.8 1.4 9.6-.6" stroke-opacity=".55"/>'),
  rendered: svg('<circle cx="8" cy="8" r="5.6" fill="currentColor"/><circle cx="6" cy="6" r="1.3" fill="#fff" stroke="none"/>'),
  xray: svg('<rect x="2.5" y="4.5" width="7" height="7" rx="1"/><rect x="6.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" fill-opacity=".22"/>'),
  caret: svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>'),
  measure: svg('<path d="M2.2 11.3 11.3 2.2l2.5 2.5-9.1 9.1z"/><path d="m5 8.5 1.3 1.3M7 6.5l1.3 1.3M9 4.5l1.3 1.3"/>'),
  section: svg('<path d="M3 3.5h6.5l3.5 3v6H3z" stroke-opacity=".45"/><path d="M1.8 9.2h12.4" stroke-width="1.6"/><path d="M3 9.2v3.3h10V9.2" fill="currentColor" fill-opacity=".25"/>'),
  explode: svg('<rect x="5.8" y="5.8" width="4.4" height="4.4" rx=".8"/><path d="M2 2l2.3 2.3M14 2l-2.3 2.3M2 14l2.3-2.3M14 14l-2.3-2.3M2 2h2M2 2v2M14 2h-2M14 2v2M2 14h2M2 14v-2M14 14h-2M14 14v-2"/>'),
  sidebar: svg('<rect x="2" y="2.8" width="12" height="10.4" rx="1.6"/><path d="M10 2.8v10.4"/><path d="M11.6 5.5h.9M11.6 7.5h.9M11.6 9.5h.9"/>'),
  view: svg('<path d="M8 2.2 13 5v6l-5 2.8L3 11V5z"/><path d="M3 5l5 2.8L13 5M8 7.8v6"/>'),
  camera: svg('<rect x="1.8" y="4.5" width="9" height="7" rx="1.2"/><path d="m10.8 7 3.4-2v6l-3.4-2"/>'),
  ortho: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11" stroke-opacity=".55"/>'),
  persp: svg('<path d="M4.5 3h7l2.5 10H2z"/><path d="M3.3 8h9.4M8 3v10" stroke-opacity=".55"/>'),
  frame: svg('<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/><rect x="5.5" y="5.5" width="5" height="5" rx=".8"/>'),
  zoom: svg('<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.6 3.6M5 7h4M7 5v4"/>'),
  pan: svg('<path d="M8 1.8v12.4M1.8 8h12.4M8 1.8 6.3 3.5M8 1.8l1.7 1.7M8 14.2l-1.7-1.7M8 14.2l1.7-1.7M1.8 8l1.7-1.7M1.8 8l1.7 1.7M14.2 8l-1.7-1.7M14.2 8l-1.7 1.7"/>'),
  shot: svg('<path d="M2 5.5a1.5 1.5 0 0 1 1.5-1.5h1.6l1.1-1.5h3.6L10.9 4h1.6A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/><circle cx="8" cy="8.3" r="2.4"/>'),
  help: svg('<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3"/><circle cx="8" cy="11.4" r=".35" fill="currentColor"/>'),
  eye: svg('<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  eyeOff: svg('<path d="M2.8 6.1C2 7 1.5 8 1.5 8S4 12.2 8 12.2c1 0 1.8-.2 2.6-.6M6 4.1c.6-.2 1.3-.3 2-.3 4 0 6.5 4.2 6.5 4.2s-.5.9-1.4 1.9M2 2l12 12"/>'),
  chevron: svg('<path d="m6 4 4 4-4 4"/>'),
  collection: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.4"/><path d="M2.5 6.5h11"/>'),
  mesh: svg('<path d="M8 2.5 13.5 12h-11z"/><circle cx="8" cy="2.5" r=".9" fill="currentColor"/><circle cx="13.5" cy="12" r=".9" fill="currentColor"/><circle cx="2.5" cy="12" r=".9" fill="currentColor"/>'),
  empty: svg('<path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4" stroke-opacity=".8"/>'),
  light: svg('<path d="M5.3 10.2a4 4 0 1 1 5.4 0c-.6.5-.9 1-.9 1.7V12H6.2v-.1c0-.7-.3-1.2-.9-1.7z"/><path d="M6.4 14h3.2"/>'),
  camObj: svg('<path d="M2.5 5.5h7v5h-7z"/><path d="m9.5 6.8 4-2.3v7l-4-2.3"/>'),
  isolate: svg('<circle cx="8" cy="8" r="2.2" fill="currentColor"/><circle cx="8" cy="8" r="5.6" stroke-dasharray="2 2"/>'),
  play: svg('<path d="M5 3.2v9.6L12.6 8z" fill="currentColor"/>'),
  pause: svg('<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>'),
  stepBack: svg('<path d="M4 3.5v9M12 3.5 6.5 8l5.5 4.5z" fill="currentColor"/>'),
  stepFwd: svg('<path d="M12 3.5v9M4 3.5 9.5 8 4 12.5z" fill="currentColor"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  flip: svg('<path d="M8 2v12M5 5 2 8l3 3M11 5l3 3-3 3"/>'),
  spin: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M11.8 1.8v2.8H9"/>'),
  model: svg('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>'),
  video: svg('<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6"/><path d="M6.5 6v4l3.5-2z" fill="currentColor"/>'),
  image: svg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><circle cx="5.5" cy="6.3" r="1.2"/><path d="m2 11.5 3.6-3 2.6 2.2 2.3-1.8 3.5 2.8"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1.4"/><path d="M11 5V3.8A1.3 1.3 0 0 0 9.7 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.9A1.3 1.3 0 0 0 3.8 11H5"/>'),
  download: svg('<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/>'),
  follow: svg('<path d="M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2"/><circle cx="8" cy="8" r="3.4"/>'),
  grid: svg('<path d="M1.8 5.5h12.4M1.8 10.5h12.4M5.5 1.8v12.4M10.5 1.8v12.4"/>'),
}
