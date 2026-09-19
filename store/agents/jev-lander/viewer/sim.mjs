// sim.mjs — the Jev Lander flight. Pure functions, no I/O, no timers: the viewer drives it one
// decision at a time, and the tests drive it the same way.
//
// One "tick" is one Jev decision. Speeds are in altitude units per tick.
//   v += throttle − gravity          (the throttle also burns that much fuel)
//   v −= sign(v)·v²·DRAG             (air drag limits a long fall)
//   y += v
// The honest limits are all in there. Full BURN pushes 2.6, so the most the booster can brake is
// 2.6 − gravity per tick, and from speed v it needs v² / (2·(2.6 − gravity)) of height to stop.
// Every tick in the air costs about `gravity` of fuel, so a slow careful descent under high
// gravity runs the tank dry.

export const ACTIONS = ['CUT', 'COAST', 'HOVER', 'BURN']
/** Upward push per tick from each throttle setting. It burns the same amount of fuel. */
export const THRUST = { CUT: 0, COAST: 0.4, HOVER: 1.15, BURN: 2.6 }
export const DRAG = 0.004

export const DEFAULT = {
  title: 'Jev Lander',
  description: 'Jev is the flight computer: throttle a booster down to a soft landing.',
  instrument: 'LANDER',
  tickMs: 300, gravity: 1.2, fuel: 60, altitude: 80, safeSpeed: 2.0, seed: 4242,
  style: 'The booster is falling under gravity. Bring it down to the pad gently: watch altitude and vertical speed, burn early and hard enough to keep descent in check, and ease off so you touch down soft. A fast touchdown is a crash — go for the gentle landing.',
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

/** Keep a wild config from breaking the flight. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    instrument: String(raw.instrument ?? DEFAULT.instrument).slice(0, 24),
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    tickMs: Math.round(num(raw.tickMs, 30, 2000, DEFAULT.tickMs)),
    gravity: num(raw.gravity, 0.1, 5, DEFAULT.gravity),
    fuel: num(raw.fuel, 5, 2000, DEFAULT.fuel),
    altitude: num(raw.altitude ?? raw.startAlt, 10, 400, DEFAULT.altitude),
    safeSpeed: num(raw.safeSpeed, 0.2, 10, DEFAULT.safeSpeed),
    seed: Math.round(num(raw.seed, 0, 1e9, DEFAULT.seed)),
  }
}

/** The most the booster can brake per tick. Zero or less means it cannot slow down at all. */
export const brakeOf = (cfg) => THRUST.BURN - cfg.gravity
/** Height needed to stop from the current fall under full BURN. Infinity when it cannot brake. */
export function stopDistance(w, cfg) {
  const d = brakeOf(cfg), v = Math.min(0, w.v)
  return d > 0 ? (v * v) / (2 * d) : v < 0 ? Infinity : 0
}

export function createWorld(cfg) {
  const w = {
    t: 0, episode: 0, rng: null,
    y: cfg.altitude, v: 0, fuel: cfg.fuel, from: { y: cfg.altitude },
    thrust: 'CUT', fired: 0, flameout: 0,
    phase: 'flight', hold: 0, ticks: 0, startAlt: cfg.altitude,
    landed: 0, crashed: 0, streak: 0, bestStreak: 0, flights: [], finished: null,
    trace: [], events: [], eventId: 0,
  }
  newFlight(w, cfg)
  return w
}

/** A new booster at the top. Every flight has its own seed: the drop height and the fall it starts with differ. */
export function newFlight(w, cfg) {
  w.episode++
  w.rng = mulberry32((cfg.seed + w.episode * 7919) | 0)
  w.startAlt = cfg.altitude * (0.9 + w.rng() * 0.2)
  w.y = w.startAlt
  w.v = -w.rng() * 2.5
  w.fuel = cfg.fuel
  w.from = { y: w.y }
  w.thrust = 'CUT'; w.fired = 0; w.flameout = 0; w.dry = false
  w.phase = 'flight'; w.ticks = 0; w.finished = null
  w.trace = []
  emit(w, { e: 'launch' })
}

function emit(w, ev) {
  ev.id = ++w.eventId
  ev.t = w.t
  w.events.push(ev)
  if (w.events.length > 16) w.events.splice(0, w.events.length - 16)
  return ev
}

/** A person shoves the booster: a downdraft (dv < 0) or an updraft (dv > 0). */
export function shove(w, cfg, dv) {
  if (w.phase !== 'flight') return false
  w.v = clamp(w.v + dv, -40, 20)
  emit(w, { e: 'shove', dv })
  return true
}
/** A leak: a share of the fuel that is left is gone. */
export function leak(w, cfg, share = 0.3) {
  if (w.phase !== 'flight') return false
  const lost = w.fuel * clamp(share, 0.05, 0.9)
  w.fuel -= lost
  emit(w, { e: 'leak', lost })
  return true
}
/** The engine goes out for a few decisions, whatever throttle Jev sets. */
export function flameout(w, cfg, ticks = 4) {
  if (w.phase !== 'flight') return false
  w.flameout = Math.round(clamp(ticks, 1, 20))
  emit(w, { e: 'flameout', ticks: w.flameout })
  return true
}

/** The text Jev reads. Raw numbers only. The stand-in in toolchain/jev.mjs reads this same text. */
export function stateText(w, cfg) {
  const pct = (w.fuel / cfg.fuel) * 100
  return `${cfg.style}
Telemetry (altitude above the pad, vertical speed where negative means falling, gravity, fuel left):
ALT ${w.y.toFixed(1)} VY ${w.v.toFixed(1)} G ${cfg.gravity.toFixed(2)} FUEL ${pct.toFixed(0)}% (${w.fuel.toFixed(0)} units)
throttle, upward push per tick: ${ACTIONS.map((a) => `${a} ${THRUST[a].toFixed(2)}`).join(', ')}. Each burns that much fuel per tick.
touchdown is soft at speed ${cfg.safeSpeed.toFixed(1)} or less. air drag ${DRAG} · v² slows a fast fall.
engine: ${w.flameout > 0 ? `OUT for ${w.flameout} more ticks` : 'OK'}
Which throttle do you set for this tick? ${ACTIONS.join(' / ')}`
}

/** Advance one decision. `action` is Jev's pick. Returns the events of this tick. */
export function step(w, cfg, action) {
  const before = w.eventId
  w.t++
  w.from = { y: w.y }
  if (w.phase !== 'flight') {
    if (--w.hold <= 0) newFlight(w, cfg)
    return w.events.filter((e) => e.id > before)
  }
  w.thrust = ACTIONS.includes(action) ? action : 'CUT'
  // The engine gives what the tank and its own health allow.
  let push = THRUST[w.thrust]
  if (w.flameout > 0) { push = 0; w.flameout-- }
  if (push > w.fuel) { push = w.fuel; if (!w.dry) { w.dry = true; emit(w, { e: 'dry' }) } }
  w.fired = push
  w.fuel = Math.max(0, w.fuel - push)
  w.v += push - cfg.gravity
  w.v -= Math.sign(w.v) * w.v * w.v * DRAG
  w.y += w.v
  w.ticks++
  w.trace.push([w.y, w.fired])
  if (w.trace.length > 400) w.trace.shift()
  if (w.y > cfg.altitude * 1.6) { w.y = cfg.altitude * 1.6; w.v = Math.min(0, w.v) } // a ceiling, so a long BURN cannot leave the scene
  if (w.y <= 0) {
    w.y = 0
    const speed = Math.abs(w.v), ok = speed <= cfg.safeSpeed
    w.finished = { ok, ticks: w.ticks, vy: w.v, fuelLeft: Math.round(w.fuel), crashSpeed: speed, gravity: cfg.gravity }
    if (ok) { w.landed++; w.streak++; w.bestStreak = Math.max(w.bestStreak, w.streak) } else { w.crashed++; w.streak = 0 }
    w.flights.push({ ok, speed, fuelLeft: w.fuel, ticks: w.ticks })
    if (w.flights.length > 24) w.flights.shift()
    w.phase = ok ? 'landed' : 'crashed'
    w.hold = clamp(Math.round(3300 / cfg.tickMs), 3, 110)
    w.v = 0
    emit(w, { e: ok ? 'touchdown' : 'crash', speed })
  }
  return w.events.filter((e) => e.id > before)
}
