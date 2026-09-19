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
// Questions are authored as options[] / legend{} and translated to the API's real wire format
// (choice: criteria map, score: criteria level list) by toWire() — see below.
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

// ---------------------------------------------------------------------------
// Wire format. The live API (POST /v1/systemone) takes, per question:
//   noul    { type, instructions, criteria?: { true: "...", false: "..." } }
//   choice  { type, instructions, criteria: { "<option>": "<what it means>" } }   options ARE the keys
//   score   { type, instructions, criteria: ["<level 0>", "<level 1>", ...] }     2+ ordered levels
// Harness code authors questions in a friendlier shape (options[] / legend{}), so we normalise
// both ways: canon() feeds the mock, toWire() feeds the live call. Sending `options` or `legend`
// straight to the API is a 422.
// ---------------------------------------------------------------------------
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** Canonical authoring shape: { type, instructions, options[], descriptions{}, legend{}, hints[] }. */
export function canon(q = {}) {
  const type = q.type
  const out = { ...q, type, instructions: q.instructions ?? '' }
  if (type === 'choice') {
    const fromCriteria = isMap(q.criteria) ? Object.keys(q.criteria) : null
    out.options = (q.options ?? q.choices ?? fromCriteria ?? []).map(String)
    out.descriptions = { ...(isMap(q.criteria) ? q.criteria : {}), ...(isMap(q.descriptions) ? q.descriptions : {}) }
    out.hints = Array.isArray(q.criteria) ? q.criteria.map(String) : []
  } else if (type === 'score') {
    let levels
    if (isMap(q.legend)) levels = Object.keys(q.legend).sort((a, b) => Number(a) - Number(b)).map((k) => String(q.legend[k]))
    else if (Array.isArray(q.criteria)) levels = q.criteria.map(String)
    else levels = Array.from({ length: Math.max(2, Number(q.levels) || 5) }, (_, i) => String(i))
    out.levels = levels
    out.legend = Object.fromEntries(levels.map((label, i) => [String(i), label]))
    out.hints = []
  } else {
    out.hints = Array.isArray(q.criteria) ? q.criteria.map(String) : []
  }
  // The mock scores evidence off `criteria` as a flat list of strings.
  out.criteria = [...(out.hints ?? []), ...Object.values(out.descriptions ?? {})].filter((s) => typeof s === 'string')
  return out
}

/** Exactly what the live API accepts. */
export function toWire(questions = {}) {
  const wire = {}
  for (const [id, raw] of Object.entries(questions)) {
    const q = canon(raw)
    const hint = q.hints?.length ? ` (${q.hints.join('; ')})` : ''
    if (q.type === 'choice') {
      const criteria = {}
      for (const opt of q.options) criteria[opt] = String(q.descriptions[opt] ?? opt)
      wire[id] = { type: 'choice', instructions: q.instructions + hint, criteria }
    } else if (q.type === 'score') {
      wire[id] = { type: 'score', instructions: q.instructions, criteria: q.levels }
    } else {
      const w = { type: 'noul', instructions: q.instructions + hint }
      if (isMap(raw.criteria) && ('true' in raw.criteria || 'false' in raw.criteria)) w.criteria = raw.criteria
      wire[id] = w
    }
  }
  return wire
}

/** Make a live answer look like the mock's, so viewers read one shape. */
function fromWire(ans, q) {
  if (!ans || typeof ans !== 'object') return { type: q.type, ok: false }
  if (q.type === 'choice') {
    const probabilities = isMap(ans.probabilities) ? ans.probabilities : {}
    const best = ans.choice ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const top = best != null && probabilities[best] != null ? probabilities[best] : 0
    return { ...ans, type: 'choice', choice: best == null ? null : String(best), probabilities, confidence: Number(ans.confidence ?? top) }
  }
  if (q.type === 'score') return { ...ans, type: 'score', score: Number(ans.score ?? 0), legend: ans.legend ?? q.legend, confidence: Number(ans.confidence ?? 0) }
  return { ...ans, type: 'noul', noul: Number(ans.noul ?? 0.5) }
}

// ---------------------------------------------------------------------------
// Telemetry. Every evaluate() call is metered so a viewer can show Jev's mind live: what it was
// asked, the full probability distribution it answered with, how long it took and what it cost.
// ---------------------------------------------------------------------------
export const PRICE_PER_MTOK = 0.042 // USD per million input tokens; output is free

export const telemetry = {
  client: 'mock', model: 'jev-latest', calls: 0, errors: 0, retries: 0, questions: 0,
  inputTokens: 0, outputTokens: 0, costUsd: 0, tokensEstimated: true,
  lastLatencyMs: 0, avgLatencyMs: 0, lastError: null, last: null, startedAt: Date.now(),
}
const recent = [] // { t, n } per call, for a sliding-window rate
const latencies = []

function meter({ client, model, wire, state, answers, usage, latencyMs }) {
  const now = Date.now()
  const nQ = Object.keys(wire).length
  const real = Number(usage?.input_tokens)
  const est = Math.ceil((JSON.stringify(state ?? '').length + JSON.stringify(wire).length) / 4)
  const tokens = Number.isFinite(real) && real > 0 ? real : est
  telemetry.client = client
  telemetry.model = model
  telemetry.calls++
  telemetry.questions += nQ
  telemetry.inputTokens += tokens
  telemetry.outputTokens += Number(usage?.output_tokens) || 0
  telemetry.tokensEstimated = !(Number.isFinite(real) && real > 0)
  telemetry.costUsd = (telemetry.inputTokens * PRICE_PER_MTOK) / 1e6
  telemetry.lastLatencyMs = latencyMs
  latencies.push(latencyMs); if (latencies.length > 60) latencies.shift()
  telemetry.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
  telemetry.lastError = null
  telemetry.last = {
    at: now, tokens, latencyMs,
    questions: Object.entries(wire).map(([id, w]) => ({ id, type: w.type, instructions: String(w.instructions).slice(0, 160), answer: answers[id] })),
  }
  recent.push({ t: now, n: nQ })
  while (recent.length && now - recent[0].t > 5000) recent.shift()
}

/** A JSON-safe snapshot for the viewer's /jev route. */
export function snapshot() {
  const now = Date.now()
  while (recent.length && now - recent[0].t > 5000) recent.shift()
  const span = recent.length > 1 ? Math.max(0.5, (now - recent[0].t) / 1000) : 5
  return {
    ...telemetry,
    callsPerSec: recent.length / span,
    questionsPerSec: recent.reduce((a, r) => a + r.n, 0) / span,
    latencies: latencies.slice(-40),
    pricePerMTok: PRICE_PER_MTOK,
    uptimeMs: now - telemetry.startedAt,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function liveEvaluate(body, key) {
  const endpoint = process.env.TYPESAFE_API_URL || LIVE_ENDPOINT
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) { telemetry.retries++; await sleep(250 * 3 ** (attempt - 1)) }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) return res.json()
      const detail = await res.text().catch(() => '')
      lastErr = new JevError(`Jev API ${res.status}: ${detail.slice(0, 200)}`)
      if (res.status !== 429 && res.status !== 529 && res.status < 500) throw lastErr // 401/422: retrying cannot help
    } catch (e) {
      if (e instanceof JevError && !/ (429|529|5\d\d):/.test(e.message)) throw e
      lastErr = e instanceof JevError ? e : new JevError(`Jev API unreachable: ${e?.message ?? e}`)
    }
  }
  throw lastErr
}

/**
 * Evaluate a set of typed questions against a state. All questions share the state and are
 * answered in one parallel pass — ask many at once, it is nearly free.
 *
 * @param {object} opts
 * @param {string|object|Array} opts.state   the shared context block
 * @param {object} opts.questions            map of id -> question (see the `jev` builders)
 * @param {string} [opts.key]                TYPESAFE_API_KEY; defaults to process.env
 * @param {string} [opts.model]              'jev-latest' by default
 * @param {number} [opts.salt]               mock-only seed so different callers diverge
 * @param {function} [opts.mock]             mock-only domain reader: (state, id, question, salt) => answer | null
 * @returns {{client, model, answers, usage, latencyMs}}
 */
export async function evaluate({ state, questions, key, model = 'jev-latest', salt = 1, mock } = {}) {
  const apiKey = key ?? process.env.TYPESAFE_API_KEY
  const client = pickClient(apiKey)
  const wire = toWire(questions)
  const t0 = performance.now()
  try {
    if (client === 'typesafe') {
      const data = await liveEvaluate({ model, state, questions: wire }, apiKey)
      const rawAnswers = data.answers || data
      const answers = {}
      for (const [qid, q] of Object.entries(questions)) answers[qid] = fromWire(rawAnswers[qid], canon(q))
      const latencyMs = performance.now() - t0
      meter({ client, model: data.model || model, wire, state, answers, usage: data.usage, latencyMs })
      return { client: 'typesafe', model: data.model || model, answers, usage: data.usage || {}, latencyMs }
    }
    // Mock: local, deterministic, instant.
    const text = typeof state === 'string' ? state : JSON.stringify(state)
    const answers = {}
    for (const [qid, raw] of Object.entries(questions)) {
      const q = canon(raw)
      answers[qid] = (typeof mock === 'function' && mock(text, qid, q, salt)) || mockAnswer(text, qid, q, salt)
    }
    const latencyMs = performance.now() - t0
    meter({ client, model: `${model} (mock)`, wire, state, answers, usage: null, latencyMs })
    return { client: 'mock', model: `${model} (mock)`, answers, usage: { provider: 'deterministic-mock' }, latencyMs }
  } catch (e) {
    telemetry.errors++
    telemetry.lastError = String(e?.message ?? e).slice(0, 240)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Question builders
// ---------------------------------------------------------------------------
export const jev = {
  /** Yes/no. criteria may be { true: '...', false: '...' } or a list of hints. */
  noul(instructions, criteria = undefined) {
    const q = { type: 'noul', instructions }
    if (criteria) q.criteria = isMap(criteria) ? criteria : Array.isArray(criteria) ? criteria : [criteria]
    return q
  },
  /**
   * Pick one of up to 255 options. `options` is a list, or a map of option -> what it means
   * (descriptions make Jev sharper; they are sent as the API's `criteria`).
   */
  choice(options, instructions, criteria = undefined) {
    const q = { type: 'choice', instructions }
    if (isMap(options)) { q.options = Object.keys(options); q.descriptions = options } else q.options = options
    if (criteria) q.criteria = Array.isArray(criteria) ? criteria : [criteria]
    return q
  },
  /**
   * score(legend, instructions) — legend maps level -> label, e.g. {0:'calm',1:'frustrated',2:'angry'},
   * or is an ordered list of level labels. 2..10 levels.
   */
  score(legend, instructions) {
    const q = { type: 'score', instructions }
    q.legend = Array.isArray(legend) ? Object.fromEntries(legend.map((l, i) => [String(i), l])) : legend
    return q
  },
}

export default jev
