// sim.mjs — the Jev Pong court. Pure functions, no I/O, no timers: the viewer drives it one decision
// at a time, and the tests drive it the same way.
//
// Units: the court is courtW × courtH, y grows downward. One "tick" is one Jev decision. The ball
// covers `speed` units per tick along x, the paddle covers at most 2 × maxSpeed units per tick.
// That gap is the whole difficulty: every return makes the ball faster, the paddle never gets
// faster, and one day the ball comes back before the paddle can cross the court.

export const MOVES = ['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST']
/** Paddle travel per decision, in multiples of `maxSpeed`. */
export const MV = { MOVE_UP_FAST: -2, MOVE_UP: -1, HOLD: 0, MOVE_DOWN: 1, MOVE_DOWN_FAST: 2 }
/** x of the paddle's face. The ball turns around when its edge touches it. */
export const PADDLE_X = 8

export const DEFAULT = {
  title: 'Jev Pong',
  description: 'Jev is the paddle. Keep the rally alive as the ball speeds up.',
  instrument: 'PONG',
  courtW: 200, courtH: 120, paddleH: 26, ballR: 3,
  speed: 6, maxSpeed: 2, accel: 1, topSpeed: 40, stepMs: 60, seed: 90210,
  style: 'Keep the rally alive. Track the ball, predict where it will cross your wall, and get the paddle there in time. Be decisive.',
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : d }

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Keep a wild config from breaking the court. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const courtH = num(raw.courtH, 60, 400, DEFAULT.courtH)
  const speed = num(raw.speed, 1, 60, DEFAULT.speed)
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: String(raw.instrument ?? DEFAULT.instrument).slice(0, 24),
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    courtW: num(raw.courtW, 100, 600, DEFAULT.courtW),
    courtH,
    paddleH: num(raw.paddleH, 6, courtH * 0.8, DEFAULT.paddleH),
    ballR: num(raw.ballR, 1, 8, DEFAULT.ballR),
    speed,
    maxSpeed: num(raw.maxSpeed, 0.25, 20, DEFAULT.maxSpeed),
    accel: num(raw.accel, 0, 10, DEFAULT.accel),
    topSpeed: Math.max(speed, num(raw.topSpeed, 1, 80, DEFAULT.topSpeed)),
    stepMs: Math.round(num(raw.stepMs, 30, 2000, DEFAULT.stepMs)),
    seed: Math.round(num(raw.seed, 0, 1e9, DEFAULT.seed)),
  }
}

export function createWorld(cfg) {
  const w = {
    t: 0, episode: 0, rng: null,
    ball: { x: 0, y: 0, vx: 0, vy: 0 }, path: [],
    paddleY: cfg.courtH / 2, paddleFrom: cfg.courtH / 2,
    phase: 'serve', hold: 0, passed: false,
    rally: 0, best: 0, misses: 0, returns: 0, speedNow: cfg.speed,
    lastRally: 0, lastMissSpeed: 0, rallies: [],
    events: [], eventId: 0,
  }
  serve(w, cfg)
  return w
}

/** Put a new ball on the serve spot. Every serve has its own seed, so no two rallies start alike. */
export function serve(w, cfg) {
  w.episode++
  w.rng = mulberry32((cfg.seed + w.episode * 7919) | 0)
  const r = cfg.ballR, dir = w.rng() < 0.5 ? -1 : 1
  w.ball = { x: cfg.courtW * 0.72, y: r + 6 + w.rng() * (cfg.courtH - 2 * r - 12), vx: -cfg.speed, vy: dir * cfg.speed * (0.35 + w.rng() * 0.5) }
  w.path = [[0, w.ball.x, w.ball.y]]
  w.rally = 0
  w.speedNow = cfg.speed
  w.passed = false
  w.phase = 'serve'
  w.hold = clamp(Math.round(900 / cfg.stepMs), 4, 40)
}

function emit(w, ev) {
  ev.id = ++w.eventId
  ev.t = w.t
  w.events.push(ev)
  if (w.events.length > 16) w.events.splice(0, w.events.length - 16)
  return ev
}

/** The ball's pace for the current rally: the dial, plus `accel` for every return, up to the cap. */
export const paceOf = (cfg, rally) => Math.min(cfg.speed + cfg.accel * rally, Math.max(cfg.topSpeed, cfg.speed))

/** A dial moved mid-rally: keep the ball's direction, give it the new pace. */
export function applyPace(w, cfg) {
  const b = w.ball, s = paceOf(cfg, w.rally), old = Math.abs(b.vx) || s
  b.vy *= s / old
  b.vx = Math.sign(b.vx || -1) * s
  w.speedNow = s
  const half = cfg.paddleH / 2
  w.paddleY = clamp(w.paddleY, half, cfg.courtH - half)
}

/** A person shoves the ball toward a point on the court. It keeps its pace along x. */
export function shove(w, cfg, tx, ty) {
  const b = w.ball
  if (w.phase === 'missed') return false
  const s = Math.abs(b.vx) || cfg.speed
  const pull = clamp((ty - b.y) / (cfg.courtH * 0.35), -1, 1)
  b.vy = clamp(b.vy * 0.35 + pull * s * 1.05, -1.2 * s, 1.2 * s)
  if (Math.abs(b.vy) < 0.2 * s) b.vy = (pull < 0 ? -1 : 1) * 0.2 * s
  emit(w, { e: 'shove', x: b.x, y: b.y, tx, ty })
  return true
}

/** Make the ball faster right now, as if it had been returned `n` more times. */
export function burst(w, cfg, n = 4) {
  if (w.phase === 'missed') return false
  w.rally += n
  w.best = Math.max(w.best, w.rally)
  applyPace(w, cfg)
  emit(w, { e: 'burst', x: w.ball.x, y: w.ball.y, speed: w.speedNow })
  return true
}

/**
 * Where the ball will next cross the paddle's line, by plain geometry (top, bottom and far wall
 * are mirrors). This is for the picture and the verdict. Jev is never told the answer: it gets the
 * raw ball and paddle numbers and has to work it out.
 */
export function predict(w, cfg) {
  const r = cfg.ballR, H = cfg.courtH, faceX = PADDLE_X + r, wallX = cfg.courtW - r
  const b = w.ball
  if (w.phase === 'missed' || !b.vx) return null
  let x = b.x, y = b.y, vx = b.vx, vy = b.vy, ticks = 0
  const pts = [[x, y]]
  for (let guard = 0; guard < 40; guard++) {
    const tx = vx < 0 ? (faceX - x) / vx : (wallX - x) / vx
    const tyy = vy < 0 ? (r - y) / vy : vy > 0 ? (H - r - y) / vy : Infinity
    const t = Math.max(0, Math.min(tx, tyy))
    x += vx * t; y += vy * t; ticks += t
    pts.push([x, y])
    if (tx <= tyy) { if (vx < 0) break; vx = -vx } else vy = -vy
  }
  const half = cfg.paddleH / 2
  const ticksLeft = ticks + (w.phase === 'serve' ? w.hold : 0)
  const target = clamp(y, half, H - half)
  const need = Math.max(0, Math.abs(y - w.paddleY) - half)
  const reach = 2 * cfg.maxSpeed * Math.floor(ticksLeft)
  return { y, target, ticks: ticksLeft, need, reach, reachable: reach >= need, pts }
}

/** The text Jev reads. Raw numbers only. The stand-in in toolchain/jev.mjs reads this same text. */
export function stateText(w, cfg) {
  const b = w.ball, half = cfg.paddleH / 2
  const dir = b.vx < 0 ? 'toward you' : 'away from you'
  const held = w.phase === 'serve' ? `\nserve: the ball is held still for ${w.hold} more decisions, then it flies with the velocity above.` : ''
  return `${cfg.style}
You are the paddle on the left wall of a ${cfg.courtW}×${cfg.courtH} court. y 0 is the top, y grows downward.
paddle: centre y ${w.paddleY.toFixed(1)}, half-height ${half.toFixed(1)}, face at x ${PADDLE_X}
paddle speed: a plain move shifts it ${cfg.maxSpeed.toFixed(1)} per decision, a FAST move ${(2 * cfg.maxSpeed).toFixed(1)} per decision
ball: x ${b.x.toFixed(1)}  y ${b.y.toFixed(1)}  vx ${b.vx.toFixed(1)}  vy ${b.vy.toFixed(1)}  radius ${cfg.ballR}  (${dir})
speed: ${w.speedNow.toFixed(1)} per decision   rally: ${w.rally}${held}
The ball bounces off the top, the bottom and the far wall. Meet it when it crosses your wall.`
}

/** Advance one decision. `move` is Jev's pick. Returns the events of this tick. */
export function step(w, cfg, move) {
  const before = w.eventId
  w.t++
  const W = cfg.courtW, H = cfg.courtH, r = cfg.ballR, half = cfg.paddleH / 2
  const from = clamp(w.paddleY, half, H - half)
  const to = clamp(from + (MV[move] ?? 0) * cfg.maxSpeed, half, H - half)
  w.paddleFrom = from
  w.paddleY = to
  const b = w.ball
  const path = [[0, b.x, b.y]]

  if (w.phase === 'serve') {
    if (--w.hold <= 0) { w.phase = 'play'; emit(w, { e: 'serve', x: b.x, y: b.y }) }
    w.path = path
    return w.events.filter((e) => e.id > before)
  }

  const faceX = PADDLE_X + r, wallX = W - r
  let left = 1
  for (let guard = 0; guard < 80 && left > 1e-9; guard++) {
    let t = left, kind = null
    if (b.vy < 0 && (r - b.y) / b.vy < t) { t = (r - b.y) / b.vy; kind = 'top' }
    if (b.vy > 0 && (H - r - b.y) / b.vy < t) { t = (H - r - b.y) / b.vy; kind = 'bottom' }
    if (b.vx > 0 && (wallX - b.x) / b.vx < t) { t = (wallX - b.x) / b.vx; kind = 'wall' }
    if (b.vx < 0 && !w.passed && b.x >= faceX && (faceX - b.x) / b.vx < t) { t = (faceX - b.x) / b.vx; kind = 'paddle' }
    t = Math.max(0, t)
    b.x += b.vx * t; b.y += b.vy * t; left -= t
    if (!kind) break
    const f = 1 - left
    path.push([f, b.x, b.y])
    if (kind === 'top') { b.y = r; b.vy = Math.abs(b.vy); { if (b.x > 0) emit(w, { e: 'bounce', x: b.x, y: 0, f }) } }
    else if (kind === 'bottom') { b.y = H - r; b.vy = -Math.abs(b.vy); if (b.x > 0) emit(w, { e: 'bounce', x: b.x, y: H, f }) }
    else if (kind === 'wall') { b.x = wallX; b.vx = -Math.abs(b.vx); emit(w, { e: 'wall', x: W, y: b.y, f }) }
    else {
      const py = from + (to - from) * f
      if (Math.abs(b.y - py) <= half + r * 0.5) {
        w.rally++; w.returns++
        w.best = Math.max(w.best, w.rally)
        const old = Math.abs(b.vx), s = paceOf(cfg, w.rally)
        const offset = clamp((b.y - py) / half, -1, 1)
        // The return keeps its angle, and where it met the paddle bends it: an edge hit comes off steep.
        let vy = b.vy * (s / old) + offset * s * 0.6
        if (Math.abs(vy) < 0.25 * s) vy = (vy < 0 || (vy === 0 && offset < 0) ? -1 : 1) * 0.25 * s
        b.vy = clamp(vy, -1.1 * s, 1.1 * s)
        b.vx = s
        w.speedNow = s
        emit(w, { e: 'hit', x: faceX, y: b.y, f, offset, speed: s, rally: w.rally })
      } else {
        w.passed = true
        w.misses++
        w.lastRally = w.rally
        w.lastMissSpeed = Math.abs(b.vx)
        w.rallies.push({ n: w.rally, speed: w.lastMissSpeed })
        if (w.rallies.length > 24) w.rallies.shift()
        emit(w, { e: 'miss', x: faceX, y: b.y, f, gap: Math.abs(b.y - py) - half, speed: w.lastMissSpeed, rally: w.rally })
      }
    }
  }
  path.push([1, b.x, b.y])
  w.path = path

  if (w.passed && w.phase === 'play') { w.phase = 'missed'; w.hold = clamp(Math.round(1600 / cfg.stepMs), 6, 60) }
  else if (w.phase === 'missed' && --w.hold <= 0) serve(w, cfg)
  return w.events.filter((e) => e.id > before)
}
