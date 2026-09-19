// mock.mjs — the offline stand-in's reader for the trading desk. It is used ONLY when there is no
// TYPESAFE_API_KEY. It reads the same state text live Jev gets (the closing prices and the account
// line) and nothing else: no hidden regime, no future prices. It is a plain trend follower: a fast
// average against a slow one, measured against the noise it can see on the tape. It is a stand-in
// for plumbing, not for Jev's judgement, and the pane badges it MOCK.

const softmax = (raw) => { const m = Math.max(...raw); const e = raw.map((r) => Math.exp(r - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s) }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const sigmoid = (x) => 1 / (1 + Math.exp(-x))

export function readTape(text) {
  const closes = []
  for (const m of text.matchAll(/^day (-?\d+): ([0-9]+(?:\.[0-9]+)?)$/gm)) closes.push(Number(m[2]))
  const inv = text.match(/invested (\d+)% of equity/)
  const brief = (text.match(/Brief: (.*)/) ?? [, ''])[1].toLowerCase()
  return { closes, invested: inv ? Number(inv[1]) / 100 : 0, brief }
}

/** Signal strength: fast average over slow average, in units of the noise seen on the tape. */
export function signal(closes) {
  if (closes.length < 6) return { z: 0, slowZ: 0, sigma: 0, drop: 0 }
  const rets = []
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1)
  const mu = mean(rets)
  const sigma = Math.max(0.0015, Math.sqrt(mean(rets.map((r) => (r - mu) ** 2))))
  const fast = mean(closes.slice(-3)), slow = mean(closes.slice(-10))
  const z = (fast - slow) / slow / (sigma * 1.8)
  const long = mean(closes.slice(-20)), mid = mean(closes.slice(-5))
  const slowZ = (mid - long) / long / (sigma * 2.6)
  const k = Math.min(3, closes.length - 1)
  const drop = closes[closes.length - 1] / closes[closes.length - 1 - k] - 1 // last three days
  return { z, slowZ, sigma, drop }
}

export function traderMock(text, id, q) {
  const { closes, invested, brief } = readTape(text)
  if (closes.length < 2) return null
  const { z, slowZ, sigma, drop } = signal(closes)
  // The brief can make the desk more patient or more eager. It only moves the trigger level.
  let theta = 0.75
  if (/cautious|careful|patient|conservative|slow/.test(brief)) theta *= 1.4
  if (/aggressive|bold|eager|momentum|fast/.test(brief)) theta *= 0.85

  if (id === 'action' && q.type === 'choice') {
    let buy = z * 1.7, sell = -z * 1.7, hold = theta * 1.7 + 0.25
    if (invested > 0.97) buy -= 3    // no cash left to add
    if (invested < 0.03) sell -= 3   // nothing left to cut
    const opts = q.options
    const raw = opts.map((o) => (o === 'BUY' ? buy : o === 'SELL' ? sell : hold))
    const p = softmax(raw)
    const probabilities = {}
    opts.forEach((o, i) => (probabilities[o] = p[i]))
    const bi = p.indexOf(Math.max(...p))
    return { type: 'choice', choice: opts[bi], confidence: p[bi], probabilities }
  }
  if (id === 'conviction' && q.type === 'score') {
    const pos = Math.max(0, Math.min(2, (Math.abs(z) - theta) * 1.4))
    const raw = [0, 1, 2].map((i) => -((i - pos) ** 2) / 0.5)
    const p = softmax(raw)
    const probabilities = {}
    p.forEach((v, i) => (probabilities[String(i)] = v))
    return { type: 'score', score: p.reduce((a, v, i) => a + v * i, 0), confidence: Math.max(...p), legend: q.legend, probabilities }
  }
  if (id === 'regime' && q.type === 'choice') {
    const raw = q.options.map((o) => (o === 'uptrend' ? slowZ * 1.6 : o === 'downtrend' ? -slowZ * 1.6 : 1.0))
    const p = softmax(raw)
    const probabilities = {}
    q.options.forEach((o, i) => (probabilities[o] = p[i]))
    const bi = p.indexOf(Math.max(...p))
    return { type: 'choice', choice: q.options[bi], confidence: p[bi], probabilities }
  }
  if (id === 'crash' && q.type === 'noul') {
    // A sell-off: the last three days fell far more than the tape's own noise explains.
    const depth = -drop / Math.max(0.03, sigma * Math.sqrt(3) * 2.2)
    return { type: 'noul', noul: Math.max(0.02, Math.min(0.98, sigmoid((depth - 1.35) * 5))) }
  }
  if (id === 'confident' && q.type === 'noul') return { type: 'noul', noul: Math.max(0.03, Math.min(0.97, sigmoid((Math.abs(z) - theta) * 1.8 + 0.4))) }
  return null
}
