// sim.mjs — the Jev Pendulum rig: a stiff rod hinged on a cart that Jev pushes left or right along
// a rail. Pure functions, no I/O, no timers: the viewer drives it one decision at a time, and the
// tests drive it the same way.
//
// The physics is the textbook cart and pole with the cart's acceleration as the input:
//   rod    a'' = 3/(2L) · (g·sin a − x''·cos a) − damping·a'      (a = lean from upright, + = right)
//   cart   x'' = push − drag·x'
// The honest limits are all in there. Gravity pulls with g·sin a, the hardest shove answers with
// at most 2·maxTorque, so past atan(2·maxTorque / g) the rod cannot be held. A short rod falls
// faster than a long one, so there is less time per decision to catch it.

export const ORDER = ['LEFT_HARD', 'LEFT', 'CENTER', 'RIGHT', 'RIGHT_HARD']
/** Cart push per action, as a share of the hardest shove. */
export const PUSH = { LEFT_HARD: -1, LEFT: -0.5, CENTER: 0, RIGHT: 0.5, RIGHT_HARD: 1 }
export const DRAG = 0.2      // rail drag on the cart, per second
export const REST_DEG = 96   // where a fallen rod comes to rest on the cart's bumper

export const DEFAULT = {
  title: 'The Balance Rod',
  description: 'Jev keeps a stiff rod upright on a cart. A live balancing act.',
  instrument: 'ROD',
  gravity: 7, length: 1.0, damping: 0.5, maxTorque: 0.8,
  stepMs: 80, gustEvery: 10, gustStrength: 0.55, fallDeg: 60, seed: 303,
  style: 'Keep the rod upright. Correct every lean immediately, shrink the swing, and never let it drift past the edge. You are a fast, steady balancer.',
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : d }
const RAD = Math.PI / 180

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Keep a wild config from breaking the rig. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: String(raw.instrument ?? DEFAULT.instrument).slice(0, 24),
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    gravity: num(raw.gravity, 0.5, 30, DEFAULT.gravity),
    length: num(raw.length, 0.2, 3, DEFAULT.length),
    damping: num(raw.damping, 0, 5, DEFAULT.damping),
    maxTorque: num(raw.maxTorque, 0.05, 10, DEFAULT.maxTorque),
    stepMs: Math.round(num(raw.stepMs, 30, 2000, DEFAULT.stepMs)),
    gustEvery: Math.round(num(raw.gustEvery, 0, 1000, DEFAULT.gustEvery)),
    gustStrength: num(raw.gustStrength, 0, 5, DEFAULT.gustStrength),
    fallDeg: num(raw.fallDeg, 10, 85, DEFAULT.fallDeg),
    seed: Math.round(num(raw.seed, 0, 1e9, DEFAULT.seed)),
  }
}

/** The hardest shove, as a cart acceleration. */
export const shoveOf = (cfg) => 2 * cfg.maxTorque
/** Past this lean (degrees) gravity beats the hardest shove: a still rod can no longer be held. */
export const noReturnDeg = (cfg) => Math.atan(shoveOf(cfg) / cfg.gravity) / RAD
/** How fast a lean grows on its own, per second. */
export const fallRate = (cfg) => Math.sqrt((3 * cfg.gravity) / (2 * cfg.length))
/**
 * How much of the recoverable range is used up: lean plus where the swing is about to carry it,
 * over the point of no return. Past 1 (or -1) the rod is physically lost, whatever Jev answers.
 */
export const budgetOf = (w, cfg) => (w.angle + w.vel / fallRate(cfg)) / (noReturnDeg(cfg) * RAD)

export function createWorld(cfg) {
  const w = {
    t: 0, episode: 0, rng: null,
    angle: 0, vel: 0, x: 0, vx: 0, push: 0,
    from: { angle: 0, x: 0 },
    phase: 'balance', hold: 0, thud: false,
    run: 0, best: 0, falls: 0, lastRun: 0, runs: [],
    events: [], eventId: 0,
  }
  newRun(w, cfg)
  return w
}

/** Stand the rod back up. Every run has its own seed, so no two runs get the same gusts. */
export function newRun(w, cfg) {
  w.episode++
  w.rng = mulberry32((cfg.seed + w.episode * 7919) | 0)
  w.angle = (w.rng() - 0.5) * 0.12
  w.vel = (w.rng() - 0.5) * 0.4
  w.vx = 0
  w.push = 0
  w.run = 0
  w.phase = 'balance'
  w.thud = false
  w.from = { angle: w.angle, x: w.x }
  emit(w, { e: 'stand' })
}

function emit(w, ev) {
  ev.id = ++w.eventId
  ev.t = w.t
  w.events.push(ev)
  if (w.events.length > 16) w.events.splice(0, w.events.length - 16)
  return ev
}

/**
 * A gust, or a person's flick: a sideways blow at the tip of the rod. `blow` is the swing it would
 * give a rod of length 1. The same blow swings a short rod harder (1 / length), as it would a real one.
 */
export function kick(w, cfg, blow, kind = 'gust') {
  if (w.phase !== 'balance') return false
  const dv = blow / cfg.length
  w.vel = clamp(w.vel + dv, -8, 8)
  emit(w, { e: kind, dv })
  return true
}

/** The text Jev reads. Raw numbers only. The stand-in in toolchain/jev.mjs reads this same text. */
export function stateText(w, cfg) {
  const sgn = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d)
  const s = shoveOf(cfg)
  return `${cfg.style}
A stiff rod of length ${cfg.length.toFixed(2)} stands hinged on a cart. You push the cart left or right along a rail. Push the cart toward the side the rod leans to, to get back under it.
angle: ${sgn(w.angle / RAD, 1)}°  velocity: ${sgn(w.vel, 2)} rad/s   (positive = leaning right, it falls at ±${cfg.fallDeg}°)
cart: velocity ${sgn(w.vx, 2)} m/s   rail drag ${DRAG} per s
gravity: ${cfg.gravity.toFixed(1)}   damping: ${cfg.damping.toFixed(2)}
push: ${ORDER.map((a) => `${a} ${sgn(PUSH[a] * s, 2)}`).join(', ')} m/s²
Choose the push that catches the lean and steadies the rod. Be decisive.`
}

function integrate(w, cfg, push, ms) {
  const dt = 0.005, n = Math.max(1, Math.round(ms / 5)), k = 3 / (2 * cfg.length)
  for (let i = 0; i < n; i++) {
    const ax = push - DRAG * w.vx
    const acc = k * (cfg.gravity * Math.sin(w.angle) - ax * Math.cos(w.angle)) - cfg.damping * w.vel
    w.vel += acc * dt
    w.angle += w.vel * dt
    w.vx += ax * dt
    w.x += w.vx * dt
    if (w.phase === 'fallen' && Math.abs(w.angle) >= REST_DEG * RAD) {
      w.angle = Math.sign(w.angle) * REST_DEG * RAD
      if (Math.abs(w.vel) > 0.6 && !w.thud) { w.thud = true; emit(w, { e: 'thud', side: Math.sign(w.angle), v: Math.abs(w.vel) }) }
      w.vel = -w.vel * 0.28
    }
  }
}

/** Advance one decision. `action` is Jev's pick. Returns the events of this tick. */
export function step(w, cfg, action) {
  const before = w.eventId
  w.t++
  w.from = { angle: w.angle, x: w.x }
  if (w.phase === 'fallen') {
    w.push = 0
    integrate(w, cfg, 0, cfg.stepMs)
    if (--w.hold <= 0) newRun(w, cfg)
    return w.events.filter((e) => e.id > before)
  }
  w.push = (PUSH[action] ?? 0) * shoveOf(cfg)
  integrate(w, cfg, w.push, cfg.stepMs)
  w.run++
  w.best = Math.max(w.best, w.run)
  if (Math.abs(w.angle) > cfg.fallDeg * RAD) {
    w.falls++
    w.lastRun = w.run
    w.runs.push({ ticks: w.run, secs: (w.run * cfg.stepMs) / 1000 })
    if (w.runs.length > 24) w.runs.shift()
    w.phase = 'fallen'
    w.hold = clamp(Math.round(2600 / cfg.stepMs), 4, 90)
    emit(w, { e: 'fall', side: Math.sign(w.angle), ticks: w.run })
  } else if (cfg.gustEvery > 0 && w.run % cfg.gustEvery === 0 && cfg.gustStrength > 0) {
    // A gust arrives at the end of the tick, so Jev's next read already shows it.
    kick(w, cfg, cfg.gustStrength * (w.rng() < 0.5 ? -1 : 1), 'gust')
  }
  return w.events.filter((e) => e.id > before)
}
