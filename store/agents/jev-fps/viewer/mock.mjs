// mock.mjs — the offline stand-in for Jev in this harness. It reads ONLY the state text that live
// Jev also gets (never the simulator's variables) and answers the same typed questions with a full
// probability distribution. It is a competent reflex bot, not Jev's judgement; the pane badges it MOCK.

const num = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : NaN }

export function readState(text) {
  const seen = [...text.matchAll(/demon#(\d+) bearing ([+-]\d+) distance ([\d.]+)( BITING YOU)?/g)]
    .map((m) => ({ id: +m[1], b: +m[2], dist: +m[3], biting: !!m[4] }))
  // The "heard" and "crosshair" lines also match the demon pattern, so split them out by line.
  const inSight = []
  let section = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('demons in sight')) { section = 'seen'; continue }
    if (line.startsWith('heard')) section = 'heard'
    if (section === 'seen' && line.startsWith('  demon#')) {
      const m = line.match(/demon#(\d+) bearing ([+-]\d+) distance ([\d.]+)( BITING YOU)?/)
      if (m) inSight.push({ id: +m[1], b: +m[2], dist: +m[3], biting: !!m[4] })
    }
  }
  const heardM = text.match(/heard but not seen: demon#(\d+) bearing ([+-]\d+) distance ([\d.]+)/)
  const routeM = text.match(/route to nearest (\w+): bearing ([+-]\d+) steps (\d+)/)
  const hud = text.match(/health (\d+)\/100\s+ammo (\d+)/)
  const w = text.match(/walls: ahead ([\d.]+)\s+left ([\d.]+)\s+right ([\d.]+)\s+behind ([\d.]+)/)
  return {
    hp: hud ? +hud[1] : NaN, ammo: hud ? +hud[2] : 0,
    walls: w ? { ahead: +w[1], left: +w[2], right: +w[3], behind: +w[4] } : { ahead: 9, left: 9, right: 9, behind: 9 },
    turnAmount: { HARD: num(text, /HARD (\d+) deg/), NORMAL: num(text, /normal (\d+) deg/), FINE: num(text, /FINE (\d+) deg/) },
    seen: inSight, all: seen,
    heard: heardM ? { id: +heardM[1], b: +heardM[2], dist: +heardM[3] } : null,
    route: routeM ? { kind: routeM[1], b: +routeM[2], steps: +routeM[3] } : null,
    crosshair: /crosshair on: demon#\d+/.test(text),
  }
}

/** Spread probability around a chosen index: the pick gets most of it, neighbours share the rest. */
function peaked(options, pick, sharp = 1.6, order = options) {
  const pi = order.indexOf(pick)
  const raw = options.map((o) => Math.exp(-sharp * Math.abs(order.indexOf(o) - pi)))
  const sum = raw.reduce((a, b) => a + b, 0)
  const probabilities = Object.fromEntries(options.map((o, i) => [o, raw[i] / sum]))
  return { type: 'choice', choice: pick, confidence: probabilities[pick], probabilities }
}

export function fpsMock(text, id, q) {
  const s = readState(text)
  if (!Number.isFinite(s.hp)) return null // not our state text: let the generic mock answer
  const near = s.seen[0] ?? null
  const hurt = s.hp < 40
  // Who to face: a demon in sight, else something heard close behind us, else the automap route.
  const fetching = s.route && s.route.kind !== 'demon'
  let faceB = near ? near.b : s.heard && s.heard.dist < 3.5 ? s.heard.b : s.route ? s.route.b : 0
  if (fetching && !(near && near.dist < 3)) faceB = s.route.b

  if (id === 'turn') {
    const amt = { LEFT_HARD: -s.turnAmount.HARD, LEFT: -s.turnAmount.NORMAL, LEFT_FINE: -s.turnAmount.FINE, AHEAD: 0, RIGHT_FINE: s.turnAmount.FINE, RIGHT: s.turnAmount.NORMAL, RIGHT_HARD: s.turnAmount.HARD }
    let pick = 'AHEAD', best = Infinity
    for (const o of q.options) {
      const a = amt[o] ?? 0
      const err = Math.abs(faceB - a) - (!s.crosshair && a !== 0 && Math.sign(a) === Math.sign(faceB) ? 0.01 : 0)
      if (err < best) { best = err; pick = o }
    }
    return peaked(q.options, pick, 1.8)
  }

  if (id === 'move') {
    const open = (side) => (side === 'STRAFE_LEFT' ? s.walls.left : s.walls.right) > 0.9
    const wider = s.walls.left > s.walls.right ? 'STRAFE_LEFT' : 'STRAFE_RIGHT'
    let pick
    if (near) {
      if (near.dist < 1.7 || (hurt && near.dist < 3.2)) pick = s.walls.behind > 0.7 ? 'BACK' : open(wider) ? wider : 'HOLD'
      else if (near.dist < 4.2) pick = open(wider) ? wider : 'HOLD'
      else pick = Math.abs(near.b) < 30 && s.walls.ahead > 0.8 ? 'FORWARD' : open(wider) ? wider : 'HOLD'
    } else if (s.route) {
      pick = Math.abs(s.route.b) < 40 ? (s.walls.ahead > 0.55 ? 'FORWARD' : open(wider) ? wider : 'HOLD') : 'HOLD'
    } else pick = 'HOLD'
    const p = peaked(q.options, pick, 2.2)
    return p
  }

  if (id === 'fire') {
    let p = 0.04
    if (s.ammo > 0 && s.crosshair) p = 0.94
    else if (s.ammo > 0 && near && Math.abs(near.b) < 9 && near.dist < 2.2) p = 0.62
    return { type: 'noul', noul: p }
  }

  if (id === 'threat') {
    const close = s.seen.filter((d) => d.dist < 4).length + (s.heard && s.heard.dist < 3 ? 1 : 0)
    let level = close >= 3 ? 3 : close === 2 ? 2 : close === 1 || s.seen.length ? 1 : 0
    if (hurt) level = Math.min(3, level + 1)
    if (s.seen.some((d) => d.biting)) level = Math.max(level, 2)
    const n = Object.keys(q.legend ?? {}).length || 4
    const raw = Array.from({ length: n }, (_, i) => Math.exp(-1.7 * Math.abs(i - level)))
    const sum = raw.reduce((a, b) => a + b, 0)
    const probabilities = Object.fromEntries(raw.map((r, i) => [String(i), r / sum]))
    return { type: 'score', score: raw.reduce((acc, r, i) => acc + (r / sum) * i, 0), confidence: Math.max(...raw) / sum, legend: q.legend, probabilities }
  }
  return null
}
