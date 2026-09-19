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

/**
 * Launcher ranking read used by the mock when the state text carries a command catalog and a
 * current query (the viewer renders the palette as a numbered list of targets, each with aliases,
 * plus a `Current query: "..."` line). For each target we score how well its name + aliases match
 * the query tokens and return a per-target boost (0 = no match) plus a `dominance` signal (how far
 * the best match clears the field). Real Jev reads the same catalog text and picks the best target
 * — the mock is a stand-in for that judgement, not a replacement. `featured` targets lead when the
 * query is empty.
 */
function launcherRank(text) {
  const query = (text.match(/current query:\s*"([^"]*)"/i) || [null, ''])[1]
  const targets = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s+\[([^\]]+)\](?:\s+\(featured\))?\s+aliases:\s*(.+?)\s+—/i)
    if (m) targets.push({ name: m[1].trim(), cat: m[2].trim(), aliases: m[3].split(',').map((s) => s.trim()).filter(Boolean), featured: /\(featured\)/i.test(line) })
  }
  if (!targets.length) return null
  const qtoks = query.toLowerCase().match(/[a-z0-9]+/g) || []
  const boost = new Map()
  for (const t of targets) {
    let s
    if (qtoks.length === 0) {
      s = t.featured ? 0.8 : 0.2
    } else {
      const toks = [t.name, ...t.aliases].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      s = 0
      for (const q of qtoks) {
        let b = 0
        for (const tok of toks) {
          if (tok === q) b = Math.max(b, 1.2)
          else if (tok.startsWith(q)) b = Math.max(b, 1.0)
          else if (tok.includes(q)) b = Math.max(b, 0.7)
          else { let k = 0; for (const c of q) { if (tok[k] === c) k++ } if (k === q.length) b = Math.max(b, 0.3) }
        }
        s += b
      }
    }
    boost.set(t.name, s)
  }
  const vals = [...boost.values()]
  const top = Math.max(...vals)
  const second = vals.length > 1 ? vals.slice().sort((a, b) => b - a)[1] : 0
  return { boost, query, dominance: top - second }
}

/**
 * Pendulum-balancing read used by the mock when the state text carries the current pole angle and
 * angular velocity (the viewer renders e.g. "angle: +12°  velocity: -0.8 rad/s"). We compute the
 * corrective action the pole is asking for: lean/fall to the right (positive angle) wants a
 * leftward torque, and also damp any velocity. Returns per-action boosts so the deterministic mock
 * biases toward the right call while staying slightly noisy — so Jev can fail when it's sloppy and
 * the fall reads as Jev's mistake. Real Jev reads the same text — the mock is a stand-in.
 */
function pendulumRead(text) {
  const mA = text.match(/angle:\s*([+-]?\d+(?:\.\d+)?)/i)
  const mV = text.match(/velocity:\s*([+-]?\d+(?:\.\d+)?)/i)
  const deg = mA ? Number(mA[1]) : NaN
  const vel = mV ? Number(mV[1]) : NaN
  if (!Number.isFinite(deg) || !Number.isFinite(vel)) return null
  const a = (deg * Math.PI) / 180
  // desired torque = -(Kp*a + Kv*vel); pick the action whose torque is closest.
  const want = -(6.5 * a + 3.2 * vel)
  const ACTS = { LEFT_HARD: -1.6, LEFT: -0.8, CENTER: 0, RIGHT: 0.8, RIGHT_HARD: 1.6 }
  const boost = {}
  for (const [name, t] of Object.entries(ACTS)) {
    boost[name] = 1.4 - Math.abs(t - Math.max(-1.6, Math.min(1.6, want))) * 0.9
  }
  // The mock can't see the gravity dial — it just balances. But a fast judge on a hard
  // rig will hesitate more, so the misjudgement rate rises with how hard the balance is.
  // Low gravity: calm, near-perfect. High gravity: it starts to overshoot and lose it.
  const hard = (parseFloat((text.match(/hardness:\s*([0-9.]+)/i) || [null, '0'])[1]) || 0)
  const noise = Math.min(0.55, 0.03 + hard * 0.06)
  return { boost, noise }
}

/**
 * Pong-defender read used by the mock when the state text carries a ball position/velocity and the
 * paddle's centre. We predict where the ball will cross the paddle's wall (reflecting off floor and
 * ceiling) and bias the paddle move toward that intercept, with a reaction that degrades as the ball
 * gets faster. Returns per-move boosts plus a beta error chance so Jev can visibly lose a fast rally.
 */
function pongRead(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : Number.NaN }
  const x = num(/ball:\s*x\s+([-0-9.]+)/i)
  const y = num(/y\s+([-0-9.]+)\s+vx/i)
  const vx = num(/vx\s+([-0-9.]+)\s+vy/i)
  const vy = num(/vy\s+([-0-9.]+)/i)
  const paddleY = num(/centre y\s+([-0-9.]+)/i)
  const half = num(/half-height\s+([-0-9.]+)/i)
  const courtH = num(/court:\s*[-0-9.]+\s*[x×]\s*([-0-9.]+)/i)
  const speed = num(/speed:\s*([-0-9.]+)/i)
  if (![x, y, vx, vy, paddleY, half, courtH, speed].every(Number.isFinite)) return null
  const r = 3
  const span = courtH - 2 * r
  // When the ball is moving away (rightward), the paddle's job is to stop chasing and hold still so
  // it's framed to meet the ball when it comes back — letting the rally breathe.
  if (vx >= 0) return { boost: { HOLD: 1.9, MOVE_UP: 0.7, MOVE_DOWN: 0.7, MOVE_UP_FAST: 0.3, MOVE_DOWN_FAST: 0.3 }, noise: 0, close: false }
  // time (in ball steps) to reach the left wall
  const t = -x / vx
  const dy = vy * t
  let u = ((y - r + dy) % (2 * span) + 2 * span) % (2 * span)
  u = u <= span ? u : 2 * span - u
  const ty = r + u
  const want = ty - paddleY
  const goDown = want > half * 0.5
  const goUp = want < -half * 0.5
  const boost = {}
  for (const name of ['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST']) {
    if (goDown) boost[name] = name === 'MOVE_DOWN' ? 1.8 : name === 'MOVE_DOWN_FAST' ? 1.4 : name === 'HOLD' ? 0.7 : 0.2
    else if (goUp) boost[name] = name === 'MOVE_UP' ? 1.8 : name === 'MOVE_UP_FAST' ? 1.4 : name === 'HOLD' ? 0.7 : 0.2
    else boost[name] = name === 'HOLD' ? 1.8 : 0.8
  }
  // faster ball → the intercept at the wall changes fast and the paddle has fewer ticks to reach it,
  // so the physical difficulty (max paddle speed) does the work. No injected noise: a miss is honest.
  return { boost }
}

/**
 * Shopper read used by the mock when the state text carries the recent price stream for each
 * product (the viewer renders "Name: price (+x% over N ticks) vol v% [spark]"). We score each
 * product by how fast its price is still falling — the best value right now — and bias the "best
 * buy" choice toward the steepest falling momentum, plus a confidence that depends on how far the
 * top pick stands out. Real Jev reads the same lines — the mock is a stand-in.
 */
function shopperRead(text) {
  const picks = []
  const re = /^\s*([^:\n]+?):\s*([0-9.]+)\s*\(\s*([+-][0-9.]+)% over (\d+) ticks\)\s*vol\s*([0-9.]+)%\s*\[([^\]]*)\]/gim
  let m
  while ((m = re.exec(text))) {
    const name = m[1].trim()
    const price = Number(m[2])
    const chgPct = Number(m[3])
    picks.push({ name, price, chgPct })
  }
  if (picks.length < 2) return null
  // best value = most negative recent change (still falling the fastest)
  const sorted = picks.slice().sort((a, b) => a.chgPct - b.chgPct)
  const best = sorted[0]
  const second = sorted[1]
  const spread = second.chgPct - best.chgPct
  const boost = {}
  for (const p of picks) boost[p.name] = p.name === best.name ? 1.6 : p.name === second.name ? 0.9 : 0.2
  // confidence: strong when the leader clearly out-falls the rest; weak when it's a dead heat
  const confidence = Math.min(0.95, Math.max(0.15, 0.5 + spread * 0.6))
  return { boost, confidence, best: best.name }
}

/**
 * Lander read used by the mock when the state text carries booster telemetry
 * ("ALT x VY y G g FUEL f%"). We pick a throttle by altitude and vertical speed — burn early and
 * hard enough to keep descent in check while high, flare gently low so the touchdown is soft —
 * and bias the throttle choice toward it, with a noise term that grows with gravity so high-g
 * missions look twitchy and start to crash. Real Jev reads the same lines — the mock is a
 * stand-in.
 */
function landerRead(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : Number.NaN }
  const alt = num(/alt\s+([-0-9.]+)/i)
  const vy = num(/vy\s+([-0-9.]+)/i)
  const g = num(/g\s+([-0-9.]+)/i)
  if (![alt, vy, g].every((v) => Number.isFinite(v))) return null
  let pick
  if (alt > 30) {
    if (vy < -2.5) pick = 'BURN'
    else if (vy < -1.2) pick = 'HOVER'
    else pick = 'COAST'
  } else if (alt > 16) {
    if (vy < -1.8) pick = 'BURN'
    else if (vy < -0.8) pick = 'HOVER'
    else pick = 'COAST'
  } else if (alt > 7) {
    if (vy < -1.0) pick = 'BURN'
    else if (vy < -0.3) pick = 'HOVER'
    else pick = 'COAST'
  } else {
    if (vy < -0.4) pick = 'BURN'
    else pick = 'CUT'
  }
  const boost = { CUT: 0.2, COAST: 0.6, HOVER: 0.7, BURN: 0.5 }
  if (boost[pick] !== undefined) boost[pick] = 1.9
  // twitchiness grows with gravity: higher g -> more over/under correction
  boost.noise = Math.min(0.55, 0.06 + Math.max(0, (g - 1.5)) * 0.14)
  return { boost, pick, g }
}

/**
 * Slalom read used by the mock when the state text carries the skier's x and the next gate ("skier x
 * X gate x G gate in D"). We steer toward the gate — committing harder as it arrives — with a small
 * aim error that grows the less time there is, so faster descents look wobblier and fall. Real Jev
 * reads the same lines — the mock is a stand-in.
 */
function slalomRead(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : Number.NaN }
  const x = num(/skier x\s+([-0-9.]+)/i)
  const gx = num(/gate x\s+([-0-9.]+)/i)
  const rowGap = num(/row gap\s+([-0-9.]+)/i)
  const speed = num(/descends at\s+([-0-9.]+)/i)
  if (![x, gx, rowGap].every((v) => Number.isFinite(v))) return null
  const spd = Number.isFinite(speed) ? speed : 2.4
  // Reaction lag: the faster the descent, the later Jev reacts to an approaching gate (fewer spare
  // ticks to cross the valley), so it arrives pointed at the old line and clips the gate.
  const lag = Math.max(0, Math.floor((spd - 1.8) * 1.7))
  const reachRows = 18 - lag * spd
  const need = Math.abs(gx - x)
  let pick = 'HOLD'
  if (rowGap <= reachRows) {
    const want = gx - x
    if (want < -1.3) pick = 'LEFT_FAST'
    else if (want > 1.3) pick = 'RIGHT_FAST'
    else if (want < -0.5) pick = 'LEFT'
    else if (want > 0.5) pick = 'RIGHT'
    else pick = 'HOLD'
  }
  const boost = { LEFT_FAST: 0.05, LEFT: 0.05, HOLD: 0.05, RIGHT: 0.05, RIGHT_FAST: 0.05 }
  if (boost[pick] !== undefined) boost[pick] = 1.99
  return { boost, pick, rowGap }
}

/**
 * Catcher read used by the mock when the state text carries the glove's x and the next ball's
 * landing spot ("glove x X ball lands B in N ticks"). We slide toward the landing spot — reading it
 * early and coasting far out, committing harder as it nears — and bias the glove move toward that.
 * The physical limit (fewer fall ticks than it takes to cross the field) is what makes Jev leak
 * balls — no injected wobble. Real Jev reads the same lines — the mock is a stand-in.
 */
function catcherRead(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : Number.NaN }
  const gx = num(/glove x\s+([-0-9.]+)/i)
  const bx = num(/ball lands\s+([-0-9.]+)/i)
  const ticks = num(/in\s+([-0-9.]+)\s+ticks/i)
  if (![gx, bx, ticks].every((v) => Number.isFinite(v))) return null
  const want = bx - gx
  // Far out, a gentle read settles on the landing spot; near the catch, commit fast.
  let pick
  if (ticks > 6) pick = want < -0.4 ? 'LEFT' : want > 0.4 ? 'RIGHT' : 'HOLD'
  else pick = want < -1.0 ? 'LEFT_FAST' : want > 1.0 ? 'RIGHT_FAST' : want < -0.4 ? 'LEFT' : want > 0.4 ? 'RIGHT' : 'HOLD'
  const boost = { LEFT_FAST: 0.05, LEFT: 0.05, HOLD: 0.05, RIGHT: 0.05, RIGHT_FAST: 0.05 }
  if (boost[pick] !== undefined) boost[pick] = 1.99
  return { boost, pick, want, ticks }
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
    // Shopper: "act now" is urgent when the best buy clearly out-falls the field. Ask Jev to spend
    // when the momentum spread is wide, so the demo eventually commits on paper.
    if (/act now|spend now|strong enough/i.test(qtext) || /buy|act/i.test(q.instructions)) {
      const shop = shopperRead(text)
      if (shop && shop.confidence) p = Math.max(p, Math.min(0.9, 0.4 + shop.confidence * 0.5))
    }
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
    // Launcher: if the state carries a numbered command catalog + a current query, bias the
    // ranking by how well each target matches the query (and lead with featured targets on an
    // empty query).
    const lr = launcherRank(text)
    if (lr) {
      options.forEach((opt, i) => {
        const coast = lr.boost.get(String(opt).toLowerCase())
        if (coast !== undefined) raw[i] += coast + Math.min(0.5, lr.dominance * 0.6)
      })
    }
    // Pendulum: if the state carries an angle + angular velocity, bias toward the balancing action,
    // and occasionally flip to a neighbour (a fast model that sometimes hesitates) so the pole can
    // visibly wobble — that wiggle is the demo.
    const pen = pendulumRead(text)
    if (pen) {
      options.forEach((opt, i) => {
        const b = pen.boost[String(opt)]
        if (b !== undefined) raw[i] += b
      })
      if (pen.noise && (hash01('pen', salt + 9) < pen.noise)) {
        // flip the current best to two neighbours over — a big, costly overcorrection
        const best = options.map((o, i) => ({ o, i, r: raw[i] })).sort((a, b) => b.r - a.r)[0]
        const ni = Math.max(0, Math.min(options.length - 1, best.i + (hash01('dir', salt) < 0.5 ? -2 : 2)))
        if (ni !== best.i) raw[ni] += 2.2
      }
    }
    // Pong: if the state text carries a ball + paddle, steer the paddle to the predicted intercept,
    // and lag harder (miss more) as the ball speeds up.
    const pong = pongRead(text)
    if (pong) {
      options.forEach((opt, i) => {
        const b = pong.boost[String(opt)]
        if (b !== undefined) raw[i] += b
      })
    }
    // Shopper: if the state carries a product price stream, bias "best buy" toward the product
    // whose price is still falling the fastest.
    const shop = shopperRead(text)
    if (shop) {
      options.forEach((opt, i) => {
        const b = shop.boost[String(opt).toLowerCase()]
        if (b !== undefined) raw[i] += b
      })
    }
    // Lander: if the state carries booster telemetry, bias the throttle toward a plausible burn and
    // flip to a worse one more often as gravity rises, so high-g missions look twitchy and crash.
    const land = landerRead(text)
    if (land) {
      options.forEach((opt, i) => {
        const b = land.boost[String(opt)]
        if (b !== undefined) raw[i] += b
      })
      if (land.boost.noise && (hash01('land', salt + 11) < land.boost.noise)) {
        // over or under-throttle by one step — a costly hesitation
        const best = options.map((o, i) => ({ o, i, r: raw[i] })).sort((a, b) => b.r - a.r)[0]
        const step = hash01('ldir', salt) < 0.5 ? 1 : -1
        const ni = Math.max(0, Math.min(options.length - 1, best.i + step))
        if (ni !== best.i && land.boost[String(options[ni])] !== undefined) raw[ni] += 2.4
      }
    }
    // Slalom: if the state carries the skier's x and the next gate, steer toward it once it's in
    // reach; the physical slew limit (fast descents have too few ticks to cross the valley) is what
    // makes it fall — no injected wobble.
    const slal = slalomRead(text)
    if (slal) {
      options.forEach((opt, i) => {
        const b = slal.boost[String(opt)]
        if (b !== undefined) raw[i] += b
      })
    }
    // Catcher: if the state carries the glove's x and the next ball's landing spot, slide toward it.
    // The physical slew limit (fewer fall ticks than it takes to cross the field) is what leaks
    // balls — no injected wobble.
    const catchr = catcherRead(text)
    if (catchr) {
      options.forEach((opt, i) => {
        const b = catchr.boost[String(opt)]
        if (b !== undefined) raw[i] += b
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

// Imports are hoisted, so they can live here with the code that needs them.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    out.raw = isMap(q.criteria) ? q.criteria : null
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

// ---------------------------------------------------------------------------
// Credentials. Environment variables win. Otherwise a small KEY=VALUE file in the user's home is
// read, because a viewer started by the Harness daemon does not inherit the variables of the shell
// you happen to have open. Two live routes are supported, both speaking the same question format:
//   TypeSafe direct         TYPESAFE_API_KEY                               (api.typesafe.ai)
//   Cloudflare Workers AI   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN   (no TypeSafe waitlist)
// The file is ~/.config/typesafe/credentials (or $TYPESAFE_CREDENTIALS). Keep it chmod 600.
// ---------------------------------------------------------------------------
const CRED_KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_API_URL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
let credCache = null
export const credentialsPath = () => process.env.TYPESAFE_CREDENTIALS || join(homedir(), '.config', 'typesafe', 'credentials')

function readCredentialFile() {
  const now = Date.now()
  const path = credentialsPath()
  if (credCache && credCache.path === path && now - credCache.at < 5000) return credCache.values
  const values = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/)
      if (m && CRED_KEYS.includes(m[1])) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch { /* no file: fine */ }
  credCache = { at: now, path, values }
  return values
}

/** Which live route to use, or null for the offline stand-in. Never log the returned secret. */
export function resolveCredentials(explicitKey) {
  if (explicitKey === '') return null // an explicit empty key forces the offline stand-in
  // Test suites assume the deterministic stand-in. Under `node --test`, or with JEV_OFFLINE=1, a real
  // key on the machine is ignored unless it is passed explicitly or JEV_LIVE_TESTS=1 is set.
  if (!explicitKey && (process.env.JEV_OFFLINE === '1' || (process.env.NODE_TEST_CONTEXT && process.env.JEV_LIVE_TESTS !== '1'))) return null
  const file = readCredentialFile()
  const get = (k) => process.env[k] || file[k] || ''
  const key = explicitKey || get('TYPESAFE_API_KEY')
  if (key) return { provider: 'typesafe', secret: key, url: get('TYPESAFE_API_URL') || LIVE_ENDPOINT }
  const account = get('CLOUDFLARE_ACCOUNT_ID'), token = get('CLOUDFLARE_API_TOKEN')
  if (account && token) return { provider: 'cloudflare', secret: token, url: `${process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${encodeURIComponent(account)}/ai/run` }
  return null
}

/** One safe line for doctor scripts and panes: says which route is active, never the secret. */
export function describeCredentials() {
  const c = resolveCredentials()
  if (!c) return `offline stand-in (no key found in the environment or in ${credentialsPath()})`
  return c.provider === 'cloudflare' ? 'live Jev through Cloudflare Workers AI' : 'live Jev through the TypeSafe API'
}

async function liveEvaluate(body, cred) {
  const endpoint = cred.url
  const key = cred.secret
  const payload = cred.provider === 'cloudflare' ? { model: 'typesafe/jev', input: { state: body.state, questions: body.questions } } : body
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) { telemetry.retries++; await sleep(250 * 3 ** (attempt - 1)) }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = await res.json()
        // Cloudflare wraps the model's reply as { result, success, errors }.
        if (data && data.success === false) throw new JevError(`Jev API 422: ${JSON.stringify(data.errors ?? data).slice(0, 200)}`)
        return data?.result?.answers ? data.result : data
      }
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
  const cred = resolveCredentials(key)
  const client = cred ? cred.provider : 'mock'
  const wire = toWire(questions)
  const t0 = performance.now()
  try {
    if (cred) {
      const data = await liveEvaluate({ model, state, questions: wire }, cred)
      const rawAnswers = data.answers || data
      const answers = {}
      for (const [qid, q] of Object.entries(questions)) answers[qid] = fromWire(rawAnswers[qid], canon(q))
      const latencyMs = performance.now() - t0
      meter({ client, model: data.model || model, wire, state, answers, usage: data.usage, latencyMs })
      return { client, model: data.model || model, answers, usage: data.usage || {}, latencyMs }
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
