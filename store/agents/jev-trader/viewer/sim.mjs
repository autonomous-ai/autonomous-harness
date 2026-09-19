// sim.mjs — the made-up market and the paper account of Jev Trader. No I/O, fully seeded.
//
// The market is SYNTHETIC. The price follows hidden trend regimes (up, down, sideways) that last a
// few weeks each, plus daily noise. `volatility` is the size of that noise and it is the honest
// difficulty dial: with little noise the trend can be read off the tape, with a lot of noise the
// same trend is buried and a trend follower gets whipsawed and bled by fees. Nothing random is
// added to Jev's decision. One decision per day, one candle per day.

const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export const DEFAULT = {
  title: 'Jev’s Desk',
  description: 'A paper account on a made-up market, run by a System One decision model.',
  instrument: 'SYNTH',
  startPrice: 100,
  volatility: 0.008,   // daily noise (stdev of the daily return). THE difficulty dial.
  drift: 0.0003,       // a constant daily bias on top of the hidden trend
  trend: 0.0035,       // daily drift inside a hidden up or down regime. 0 = pure random walk
  fee: 0.001,          // cost of a trade, as a fraction of its value (0.001 = 0.10%)
  stepMs: 200,         // milliseconds per trading day (one Jev decision per day)
  capital: 10000,
  episodeDays: 250,    // one synthetic "year", then the books close and a new year starts
  seed: 1337,
  style: 'Buy the trend, cut losses, keep some cash. You are a fast, disciplined trader.',
}

/** Keep a wild config from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: String(raw.instrument ?? DEFAULT.instrument).replace(/[^\w .-]/g, '').slice(0, 12) || DEFAULT.instrument,
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    startPrice: clampN(raw.startPrice, 0.01, 1e6, DEFAULT.startPrice),
    volatility: clampN(raw.volatility, 0, 0.2, DEFAULT.volatility),
    drift: clampN(raw.drift, -0.02, 0.02, DEFAULT.drift),
    trend: clampN(raw.trend, 0, 0.02, DEFAULT.trend),
    fee: clampN(raw.fee, 0, 0.05, DEFAULT.fee),
    stepMs: clampN(raw.stepMs, 60, 20000, DEFAULT.stepMs),
    capital: clampN(raw.capital, 100, 1e9, DEFAULT.capital),
    episodeDays: Math.round(clampN(raw.episodeDays, 60, 2000, DEFAULT.episodeDays)),
    seed: Math.round(clampN(raw.seed, 0, 1e9, DEFAULT.seed)),
  }
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const gauss = (rng) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng())
const KEEP = 220 // days of chart history kept in memory and sent to the pane
const WARMUP = 110 // pre-market days drawn before day 1

function nextRegime(w) {
  const r = w.rngR()
  const kinds = [1, -1, 0].filter((k) => k !== w.regime.kind)
  // Up a little more often than down, as a made-up market with a small upward bias would be.
  const kind = w.regime.kind === 0 ? (r < 0.55 ? 1 : -1) : (r < 0.62 ? kinds[0] : kinds[1])
  w.regime = { kind, left: 18 + Math.floor(w.rngR() * 38) }
}

export function createEpisode(cfg, episode = 0) {
  const seed = (cfg.seed + episode * 7919) >>> 0
  const w = {
    episode, seed, day: 0, price: cfg.startPrice, startPrice: cfg.startPrice, capital: cfg.capital,
    rngR: mulberry32(seed ^ 0x9e3779b9), rngN: mulberry32((seed * 31 + 17) >>> 0),
    regime: { kind: 0, left: 0 }, shock: null,
    candles: [], closes: [], eq: [cfg.capital], bh: [cfg.capital], trades: [], events: [],
    cash: cfg.capital, holdings: 0, peak: cfg.capital, drawdown: 0, maxDD: 0, fees: 0, nTrades: 0,
    rightDays: 0, regimeDays: 0, status: 'running', result: null, rest: 0,
  }
  nextRegime(w)
  // Pre-market: the tape runs for a while before the desk opens, so the chart is full and Jev has
  // 20 closes to read on day 1. These days carry numbers up to 0. Nothing is traded on them.
  w.day = -WARMUP
  for (let i = 0; i < WARMUP; i++) stepMarket(w, cfg)
  w.startPrice = w.price
  return w
}

export const equity = (w) => w.cash + w.holdings * w.price
export const invested = (w) => { const e = equity(w); return e > 0 ? (w.holdings * w.price) / e : 0 }

/** One trading day: five intraday moves make the candle. The hidden regime sets the drift. */
export function stepMarket(w, cfg) {
  if (w.regime.left <= 0) nextRegime(w)
  w.regime.left--
  let day = cfg.drift + w.regime.kind * cfg.trend
  let shocked = 0
  if (w.shock && w.shock.left > 0) { day += w.shock.perDay; shocked = w.shock.perDay < 0 ? -1 : 1; if (--w.shock.left <= 0) w.shock = null }
  const o = w.price
  let p = o, h = o, l = o
  for (let i = 0; i < 5; i++) {
    p = Math.max(0.01, p * (1 + day / 5 + gauss(w.rngN) * cfg.volatility / Math.sqrt(5)))
    if (p > h) h = p
    if (p < l) l = p
  }
  w.price = p
  w.day++
  w.candles.push({ d: w.day, o, h, l, c: p, r: w.regime.kind, s: shocked })
  w.closes.push(p)
  if (w.candles.length > KEEP) w.candles.shift()
  if (w.closes.length > 40) w.closes.shift()
}

/** Exactly what Jev is sent. The offline stand-in reads this text and nothing else. */
export function observe(w, cfg) {
  const e = equity(w)
  const n = Math.min(20, w.closes.length)
  const tape = w.closes.slice(-n).map((p, i) => `day ${w.day - n + 1 + i}: ${p.toFixed(2)}`).join('\n')
  return `You run a PAPER trading desk on a SYNTHETIC market. No real money, no real asset.
Instrument: ${cfg.instrument}. Brief: ${cfg.style}
Day ${w.day} of ${cfg.episodeDays}. Fee per trade: ${(cfg.fee * 100).toFixed(2)}%.
Account: cash ${w.cash.toFixed(2)}; holdings ${w.holdings} shares; equity ${e.toFixed(2)}; invested ${(invested(w) * 100).toFixed(0)}% of equity; drawdown ${(w.drawdown * 100).toFixed(1)}% from the peak.
Closing prices, oldest first:
${tape}
Decide today's action. BUY adds shares, HOLD does nothing, SELL cuts shares. You see only this tape and your own account.`
}

const SIZE = [0.2, 0.35, 0.5] // share of equity moved per trade, by conviction level 0..2

/** Turn Jev's answers into a paper trade. `decision` = { action, conviction 0..2, crash 0..1 }. */
export function applyDecision(w, cfg, decision) {
  const px = w.price
  const e = equity(w)
  let side = decision.action === 'BUY' ? 'B' : decision.action === 'SELL' ? 'S' : null
  let frac = SIZE[Math.max(0, Math.min(2, Math.round(decision.conviction ?? 1)))]
  let why = ''
  // The desk rule on top of Jev's read: a flagged sell-off means get out, all of it.
  if ((decision.crash ?? 0) >= 0.7 && w.holdings > 0) { side = 'S'; frac = 1; why = 'crash flagged' }
  let shares = 0, fee = 0
  if (side === 'B') {
    shares = Math.floor(Math.min(e * frac, w.cash / (1 + cfg.fee)) / px)
    if (shares > 0) { fee = shares * px * cfg.fee; w.cash -= shares * px + fee; w.holdings += shares }
  } else if (side === 'S') {
    shares = Math.min(w.holdings, Math.max(1, Math.ceil((e * frac) / px)))
    if (w.holdings <= 0) shares = 0
    if (shares > 0) { fee = shares * px * cfg.fee; w.cash += shares * px - fee; w.holdings -= shares }
  }
  let trade = null
  if (shares > 0) {
    w.fees += fee; w.nTrades++
    trade = { d: w.day, side, px, sh: shares, fee, why }
    w.trades.push(trade)
    if (w.trades.length > 400) w.trades.shift()
  }
  settleDay(w, cfg)
  return trade
}

/** Person pressed "Go to cash": sell everything at today's price, fee included. */
export function flatten(w, cfg) {
  if (w.holdings <= 0 || w.status !== 'running') return null
  const shares = w.holdings, fee = shares * w.price * cfg.fee
  w.cash += shares * w.price - fee; w.holdings = 0; w.fees += fee; w.nTrades++
  const trade = { d: w.day, side: 'S', px: w.price, sh: shares, fee, why: 'you went to cash' }
  w.trades.push(trade)
  return trade
}

/** Person pressed Crash or Rally: a made-up shock that plays out over the next four days. */
export function injectShock(w, kind) {
  if (w.status !== 'running') return
  w.shock = { kind, left: 4, perDay: kind === 'crash' ? -0.045 : 0.045 }
  w.events.push({ d: w.day + 1, kind })
  if (w.events.length > 40) w.events.shift()
}

function settleDay(w, cfg) {
  const e = equity(w)
  w.peak = Math.max(w.peak, e)
  w.drawdown = w.peak > 0 ? (w.peak - e) / w.peak : 0
  w.maxDD = Math.max(w.maxDD, w.drawdown)
  w.eq.push(e)
  w.bh.push(w.capital * (w.price / w.startPrice))
  if (w.eq.length > KEEP) { w.eq.shift(); w.bh.shift() }
  // Was the desk on the right side of the hidden trend today? (Sideways days do not count.)
  const r = w.candles[w.candles.length - 1].r
  if (r !== 0) { w.regimeDays++; const inv = invested(w); if ((r > 0 && inv >= 0.5) || (r < 0 && inv < 0.5)) w.rightDays++ }
  if (w.day >= cfg.episodeDays) {
    const ret = (e - w.capital) / w.capital, bh = w.price / w.startPrice - 1
    w.status = 'done'
    w.result = { ret, bh, edge: ret - bh, maxDD: w.maxDD, trades: w.nTrades, fees: w.fees, right: w.regimeDays ? w.rightDays / w.regimeDays : 0 }
  }
}
