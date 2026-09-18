// jev.mjs — a tiny, dependency-free client for TypeSafe's Jev "System One" decision model,
// with a deterministic mock fallback so the whole harness runs without a key.
//
// Jev never writes text. You send it a `state` plus typed `questions`; it returns a calibrated
// probability distribution per question in ~100ms. Three primitives:
//   noul    yes/no — returns a single probability 0..1
//   choice  pick one of up to 255 declared options — returns per-option probabilities + a
//           `confidence` (how concentrated the mass is)
//   score   a position on a 2..10 level scale — returns a float plus the same probabilities
//
// When TYPESAFE_API_KEY is set we call the real API (POST /v1/systemone). Without it we serve a
// deterministic local mock so development, tests and offline demos work. The mock reads real
// evidence out of the state text and turns it into plausible, stable distributions, so the
// *plumbing* (typed questions, probability shaping, confidence) is exercised exactly as with the
// live model. It is deliberately NOT a stand-in for Jev's judgement.

const LIVE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export class JevError extends Error {}

function pickClient(key) {
  if (key) return 'typesafe'
  return 'mock'
}

/** Low-hash of a string -> [0,1). Stable for the same input; varies with the seed. */
export function hash01(str, salt = 0) {
  let h = 2166136261 ^ salt
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h = (h >>> 0) / 4294967296
  return h
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Greedy grid navigation used by the mock when the state text is a grid map. Parses the lines the
 * viewer renders: '.' empty, '#' wall, '$' coin, 'G' goal, '@' the agent. Returns, for the cardinal
 * directions, an estimated gain (reduction in Manhattan distance to the goal) adjusted for walls,
 * or null when no grid shape is present. Not a planner — just a competent reactive stand-in, exactly
 * the class of behaviour Jev's own model produces from the same text.
 */
function gridNav(text) {
  const lines = text.split('\n')
  const grid = []
  let hero = null, goal = null
  let start = false
  for (const line of lines) {
    const t = line.trim()
    // The world block is the run of lines made only of '.', '#', '$', 'G', '@' of equal length.
    if (t.length > 2 && /^[.#$G@]+$/.test(t) && !/^[- ]/.test(line)) {
      const row = t.split('')
      grid.push(row)
      for (let x = 0; x < row.length; x++) {
        const c = row[x]
        if (c === '@') hero = { x, y: grid.length - 1, row: grid.length - 1 }
        else if (c === 'G') goal = { x, y: grid.length - 1 }
      }
    } else if (grid.length && /[^\s]/.test(t)) {
      // Coordinates can also be given in prose; keep looking for goal/hero there.
      if (!goal) { const m = t.match(/goal[:\s]*\((\d+),(\d+)\)/); if (m) goal = { x: +m[1], y: +m[2] } }
      if (!hero) { const m = t.match(/\((\d+),(\d+)\)\.?\s+goal/i); if (m) hero = { x: +m[1], y: +m[2] } }
    }
  }
  if (!grid.length) return null
  const H = grid.length, W = grid[0].length
  const wallAt = (x, y) => x < 0 || y < 0 || x >= W || y >= H || grid[y][x] === '#'
  if (!hero || !goal) return null
  const dist = (p) => Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y)
  const base = dist(hero)
  if (base === 0) return { gain: {}, trapped: null }
  const dirs = [
    ['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0],
  ]
  const gain = {}
  const trapped = {}
  for (const [name, dx, dy] of dirs) {
    const nx = hero.x + dx, ny = hero.y + dy
    if (wallAt(nx, ny)) { gain[name] = -2; trapped[name] = false }
    else { gain[name] = base - dist({ x: nx, y: ny }); trapped[name] = true }
  }
  const anyOpen = dirs.some(([, dx, dy]) => !wallAt(hero.x + dx, hero.y + dy))
  return { gain, trapped: anyOpen ? null : trapped }
}

/**
 * Market momentum read used by the mock when the state text carries recent price lines (the viewer
 * renders a series like "day 12: 103.40"). We average the last few per-day returns into a trend in
 * [-1, 1] and bias buy (positive) / sell (negative) / hold (near-flat). Real Jev reads the same
 * text — the mock is a stand-in for that judgement, not a replacement.
 */
function marketMomentum(text) {
  const prices = []
  for (const m of text.matchAll(/(?:day\s*)?(\d+)\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)/gi)) {
    prices.push({ day: Number(m[1]), price: Number(m[2]) })
  }
  if (prices.length < 3) return null
  prices.sort((a, b) => a.day - b.day)
  const p = prices.map((x) => x.price)
  const last = p.length, n = Math.min(5, last)
  // Simple moving average over the tail: trend = (avg(last half) - avg(first half)) / avg(all).
  const old = p.slice(last - n, last - Math.floor(n / 2))
  const recent = p.slice(last - Math.floor(n / 2))
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const denom = avg(p)
  if (!denom) return null
  const trend = (avg(recent) - avg(old)) / denom
  return { trend: Math.max(-1, Math.min(1, trend * 6)) }
}

// ---------------------------------------------------------------------------
// The deterministic mock. It turns the state text + question instructions into a plausible
// distribution. Evidence = how strongly the state "mentions" something relevant to the question.
// ---------------------------------------------------------------------------
function mockAnswer(state, qid, q, salt) {
  const text = `${state ?? ''}`.toLowerCase()
  const qtext = `${q.instructions ?? ''} ${(q.criteria ?? []).join(' ')}`.toLowerCase()
  const h = hash01(`${qid}::${qtext}` + (state ?? ''), salt)

  if (q.type === 'noul') {
    // Noul: a probability that something is true. The mock nudges it from the mere prior.
    const mention = text.includes(qtext.split(' ').find((w) => w.length > 3) ?? '')
    let p = 0.5 + (h - 0.5) * 0.5
    if (mention) p = Math.min(0.95, p + 0.25)
    return { type: 'noul', noul: clamp(p) }
  }

  if (q.type === 'choice') {
    const options = q.options || q.choices || []
    if (!options.length) return { type: 'choice', choice: null, confidence: 0, probabilities: {} }
    // If the state carries a grid of '.', '#' and 'G' with '@' marking the agent, the mock behaves
    // like a competent reactive navigator: it greedily reduces distance to the goal while avoiding
    // walls. Real Jev reads the same grid text — the mock is a stand-in for that judgement, not a
    // replacement for it.
    const nav = gridNav(text)
    let raw = options.map((opt) => {
      const optToks = String(opt).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      let score = 0.2
      for (const tok of optToks) if (text.includes(tok)) score += 0.7
      score += (hash01(String(opt), salt + 7) - 0.5) * 0.35
      return score
    })
    if (nav) {
      // Score the cardinal actions by how much each shrinks the distance to the goal.
      options.forEach((opt, i) => {
        const gain = nav.gain[String(opt)]
        if (gain !== undefined) raw[i] += gain * 1.6
      })
      if (nav.trapped) {
        // Boxed in: strongly prefer the one legal opening, or wait, so it visibly pauses.
        options.forEach((opt, i) => {
          if (nav.trapped[String(opt)]) raw[i] += 1.4
        })
      }
    }
    // Market: if the state carries recent price lines, bias buy/hold/sell by momentum.
    const mom = marketMomentum(text)
    if (mom) {
      options.forEach((opt, i) => {
        const oKey = String(opt).toLowerCase()
        if (oKey.includes('buy') || oKey === 'long') raw[i] += mom.trend * 1.4
        else if (oKey.includes('sell') || oKey === 'short') raw[i] -= mom.trend * 1.4
        else if (oKey.includes('hold') && Math.abs(mom.trend) < 0.12) raw[i] += 0.6
      })
    }
    // Softmax into a distribution.
    const exps = raw.map((r) => Math.exp(r))
    const sum = exps.reduce((a, b) => a + b, 0)
    const probs = raw.map((r, i) => exps[i] / sum)
    const probabilities = {}
    options.forEach((opt, i) => (probabilities[String(opt)] = probs[i]))
    const best = options[probs.indexOf(Math.max(...probs))]
    const confidence = clamp(Math.max(...probs))
    return { type: 'choice', choice: String(best), confidence, probabilities }
  }
  if (q.type === 'score') {
    const levels = q.legend
      ? Object.values(q.legend)
      : Array.from({ length: Number(q.levels) || 5 }, (_, i) => String(i + 1))
    const lo = 0, hi = levels.length - 1
    const pos = clamp01(h)
    const score = lo + pos * (hi - lo)
    // A bell around `score` for the per-level probabilities.
    const probs = levels.map((_, i) => Math.exp(-((i - score) ** 2) / 0.6))
    const psum = probs.reduce((a, b) => a + b, 0)
    const probabilities = {}
    levels.forEach((lv, i) => (probabilities[String(lv)] = probs[i] / psum))
    const confidence = clamp(Math.max(...Object.values(probabilities)))
    return { type: 'score', score, confidence, legend: q.legend, probabilities }
  }

  return { type: q.type, ok: false }
}

function clamp(x) {
  return Math.min(1, Math.max(0, x))
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

async function liveEvaluate(body, key) {
  const res = await fetch(LIVE_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new JevError(`Jev API ${res.status}: ${detail.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Evaluate a set of typed questions against a state.
 *
 * @param {object} opts
 * @param {string} opts.state           the shared context block
 * @param {object} opts.questions       map of id -> question descriptor
 * @param {string} [opts.key]           TYPESAFE_API_KEY; defaults to process.env
 * @param {string} [opts.model]         'jev-latest' by default
 * @param {string} [opts.salt]          mock-only seed so different callers diverge
 * @returns the Jev response (answers keyed by question id, plus usage)
 */
export async function evaluate({ state, questions, key, model = 'jev-latest', salt = 1 }) {
  const apiKey = key ?? process.env.TYPESAFE_API_KEY
  const client = pickClient(apiKey)

  if (client === 'typesafe') {
    // The live API takes one state and a questions map, and returns answers by id.
    const body = { model, state, questions }
    const data = await liveEvaluate(body, apiKey)
    return {
      client: 'typesafe',
      model: data.model || model,
      answers: data.answers || data,
      usage: data.usage || {},
    }
  }

  // Mock: local, deterministic, instant.
  const answers = {}
  for (const [qid, q] of Object.entries(questions)) {
    answers[qid] = mockAnswer(state, qid, q, salt)
  }
  return {
    client: 'mock',
    model: `${model} (mock)`,
    answers,
    usage: { provider: 'deterministic-mock' },
  }
}

// ---------------------------------------------------------------------------
// Question builders
// ---------------------------------------------------------------------------
export const jev = {
  noul(instructions, criteria = undefined) {
    const q = { type: 'noul', instructions }
    if (criteria) q.criteria = Array.isArray(criteria) ? criteria : [criteria]
    return q
  },
  choice(options, instructions, criteria = undefined) {
    const q = { type: 'choice', instructions, options }
    if (criteria) q.criteria = Array.isArray(criteria) ? criteria : [criteria]
    return q
  },
  /**
   * score(legend, instructions) — legend is an object mapping level -> label, e.g.
   * {0:'calm',1:'frustrated',2:'angry'}. 2..10 levels.
   */
  score(legend, instructions, criteria = undefined) {
    const q = { type: 'score', instructions, legend }
    if (criteria) q.criteria = Array.isArray(criteria) ? criteria : [criteria]
    return q
  },
}

export default jev
