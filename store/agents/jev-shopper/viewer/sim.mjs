// sim.mjs — the made-up shop behind Jev Shopper. No Jev in here, only prices.
//
// Every product has a hidden FAIR price: its list price, a slow trend, and now and then a real SALE
// (a smooth dip that lasts a while). What the shop shows, and what Jev reads, is the fair price plus
// NOISE: a fresh random wobble of up to +-vol on every tick. A sale stays. A wobble is gone one tick
// later. An order lands one tick after the call, so buying a wobble saves nothing. That is the
// honest difficulty dial: the more noise, the harder it is to tell a real deal from a wobble.
//
// All randomness is seeded. The sale calendar and the noise use separate generators, so the same
// seed faces the same sales at every noise level.

export const AVG_N = 60          // the "usual price" is the average of the last 60 shown prices
export const SERIES_N = 62       // points sent to the pane per product
export const MAX_PRODUCTS = 8
export const MAX_ROUND_TICKS = 240
const LN_LO = Math.log(0.5), LN_HI = Math.log(1.6)

export const DEFAULT = {
  title: 'Jev Shopper',
  description: 'Jev watches made-up prices stream in and calls the best buy on every tick.',
  instrument: 'SHOPPER',
  tickMs: 250, vol: 0.03, cash: 600, minDeal: 0.08, seed: 616,
  products: [
    { name: 'Espresso Machine', price: 240, drift: 0.0005 },
    { name: 'Hiking Boots', price: 120, drift: -0.0015 },
    { name: 'Noise Cancellers', price: 180, drift: 0 },
    { name: 'Desk Lamp', price: 45, drift: -0.0005 },
  ],
  style: 'Pick the product that is the best deal right now: the one furthest below its own usual price. Say spend now only when the deal looks real and not a one-tick wobble.',
}

/** Made-up products the pane's "Add a product" button draws from. Two words each, on purpose. */
export const POOL = [
  { name: 'Trail Tent', price: 210 }, { name: 'Pour Kettle', price: 65 }, { name: 'Robot Vacuum', price: 320 },
  { name: 'Bike Light', price: 38 }, { name: 'Record Player', price: 150 }, { name: 'Camp Stove', price: 85 },
  { name: 'Pixel Frame', price: 110 }, { name: 'Yoga Mat', price: 55 },
]

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c) }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }

/** Keep a wild config from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const seen = new Set()
  const products = []
  for (const p of Array.isArray(raw.products) ? raw.products : []) {
    if (!p || typeof p.name !== 'string') continue
    const name = p.name.replace(/[:\[\]()\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28)
    const price = Number(p.price)
    if (!name || !(price > 0) || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    products.push({ name, price: clampN(price, 1, 100000, 100), drift: clampN(p.drift, -0.05, 0.05, 0) })
    if (products.length >= MAX_PRODUCTS) break
  }
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: String(raw.instrument ?? DEFAULT.instrument).slice(0, 24),
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    tickMs: Math.round(clampN(raw.tickMs, 60, 5000, DEFAULT.tickMs)),
    vol: clampN(raw.vol, 0, 0.5, DEFAULT.vol),
    cash: clampN(raw.cash, 1, 1e6, DEFAULT.cash),
    minDeal: clampN(raw.minDeal, 0.01, 0.4, DEFAULT.minDeal),
    seed: Math.round(clampN(raw.seed, 0, 1e9, DEFAULT.seed)),
    products: products.length >= 2 ? products : DEFAULT.products.map((p) => ({ ...p })),
  }
}

/** How much of a sale's full depth applies k ticks in. A flash sale drops almost at once. */
function saleShape(k, len, flash) {
  const attack = flash ? 2 : Math.max(3, Math.round(len * 0.25))
  const release = flash ? 5 : attack
  if (k < attack) return smooth((k + 1) / attack)
  if (k >= len - release) return smooth((len - k) / release)
  return 1
}

/** One product's price stream, warmed up so the first frame already has a full chart. */
export function makeStream(product, roundSeed, vol) {
  const h = hashStr(product.name.toLowerCase())
  const s = {
    name: product.name, base: product.price, drift: product.drift ?? 0,
    trend: 0, sale: null, nextSaleAt: 0, t: -AVG_N,
    prices: [], fairs: [], price: product.price, fair: product.price, avg: product.price,
    locked: false, lockedAt: 0, pending: null, buys: [], flashId: 0, flashLeft: 0,
    rngSale: mulberry32((roundSeed * 31 + h) | 0), rngNoise: mulberry32((roundSeed * 17 + (h >>> 3) + 99) | 0),
  }
  s.nextSaleAt = 1 + Math.floor(s.rngSale() * 44)
  while (s.t < 0) advance(s, vol)
  return s
}

/** Move one product one tick on. */
export function advance(s, vol) {
  s.t++
  s.trend = Math.max(LN_LO, Math.min(LN_HI, s.trend + Math.log(1 + s.drift)))
  if (!s.sale && s.t >= s.nextSaleAt && s.t > 0) {
    s.sale = { start: s.t, len: 16 + Math.floor(s.rngSale() * 18), depth: 0.1 + s.rngSale() * 0.22, flash: false }
  }
  let depth = 0
  s.flashLeft = 0
  if (s.sale) {
    const k = s.t - s.sale.start
    if (k >= s.sale.len) { s.sale = null; s.nextSaleAt = s.t + 25 + Math.floor(s.rngSale() * 55) }
    else if (k >= 0) { depth = s.sale.depth * saleShape(k, s.sale.len, s.sale.flash); if (s.sale.flash) s.flashLeft = s.sale.len - k }
    else if (s.sale.flash) s.flashLeft = s.sale.len
  }
  s.fair = s.base * Math.exp(s.trend) * (1 - depth)
  s.price = Math.max(0.5, s.fair * (1 + vol * (2 * s.rngNoise() - 1)))
  s.prices.push(s.price); s.fairs.push(s.fair)
  if (s.prices.length > SERIES_N) { s.prices.shift(); s.fairs.shift() }
  const tail = s.prices.slice(-AVG_N)
  s.avg = tail.reduce((a, b) => a + b, 0) / tail.length
}

/** The person clicked a product: a deep sale that starts on the next tick and lasts a few seconds. */
export function flashSale(s) {
  s.sale = { start: s.t + 1, len: 18, depth: 0.3, flash: true }
  s.flashId++
  s.flashLeft = 18
  s.locked = false // a new deal: Jev may buy it again
}

/** Shown discount against the usual price (what Jev can see), and the true one (what it cannot). */
export const shownDisc = (s) => s.price / s.avg - 1
export const trueDisc = (s) => s.fair / s.avg - 1

/** The state text Jev reads. Only products it can buy right now are options. */
export function observe(cfg, streams, cash) {
  const open = streams.filter((s) => !s.locked && s.price <= cash)
  const line = (s) => {
    const d = shownDisc(s) * 100
    const spark = s.prices.slice(-6).map((p) => p.toFixed(0)).join(' ')
    return `${s.name}: ${s.price.toFixed(2)}  (${d >= 0 ? '+' : ''}${d.toFixed(1)}% over ${Math.min(AVG_N, s.prices.length)} ticks)  vol ${(cfg.vol * 100).toFixed(0)}%  [${spark}]`
  }
  const closed = streams.filter((s) => !open.includes(s)).map((s) => `- ${s.name} at ${s.price.toFixed(2)}, ${s.locked ? 'already bought in this dip' : 'over the budget left'}`)
  const watchOnly = open.length === 0
  const listed = watchOnly ? streams : open
  const text = `${cfg.style}
The shop and its prices are made up. Budget left: $${cash.toFixed(2)}. One buy per product per price dip. An order lands one tick after the call, at the price it finds then.
Each line reads: product: price now (price now against its own average over the last ticks) price noise [last 6 prices].
${watchOnly ? 'Nothing can be bought right now. Watching:' : 'Open to buy now:'}
${listed.map(line).join('\n')}${!watchOnly && closed.length ? '\nNot open now:\n' + closed.join('\n') : ''}
Which single product is the best buy to act on right now?`
  return { text, options: listed.map((s) => s.name), open, watchOnly }
}
