// mock.mjs — the offline stand-in's reader for the arena. It reads ONLY the state text that live Jev
// also gets (the two "Steps to ..." lines, the coin count and the last move) and answers in the same
// shape as the API, with a real probability spread. It never looks at the simulator.
import { hash01 } from '../toolchain/jev.mjs'

const OPTS = ['up', 'down', 'left', 'right', 'wait']
const clamp = (v, lo = 0.02, hi = 0.98) => Math.max(lo, Math.min(hi, v))

function readSteps(text, what) {
  const m = new RegExp(`Steps to the ${what} after each move[^:\\n]*: ([^\\n]+)`).exec(text)
  if (!m) return null
  const out = {}
  for (const [, a, v] of m[1].matchAll(/\b(up|down|left|right|wait) (\d+|wall|none)/g)) out[a] = /^\d+$/.test(v) ? Number(v) : v
  return Object.keys(out).length === OPTS.length ? out : null
}

/** Which line is Jev following: the coin line while a coin can be reached, else the goal line. */
export function readArena(text) {
  const goal = readSteps(text, 'goal')
  if (!goal) return null
  const coin = readSteps(text, 'nearest coin')
  const coinsLeft = Number(/Coins left: (\d+)/.exec(text)?.[1] ?? 0)
  const coinOpen = coinsLeft > 0 && coin && Number.isFinite(coin.wait)
  const goalOpen = Number.isFinite(goal.wait)
  const lastMove = /Your last move: (\w+)/.exec(text)?.[1] ?? 'wait'
  return { steps: coinOpen ? coin : goal, heading: coinOpen ? 'coin' : goalOpen ? 'goal' : 'none', coinsLeft, lastMove }
}

function softmax(raw) {
  const max = Math.max(...Object.values(raw))
  const exps = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.exp(v - max)]))
  const sum = Object.values(exps).reduce((a, b) => a + b, 0)
  return Object.fromEntries(Object.entries(exps).map(([k, v]) => [k, v / sum]))
}

function moveProbs(r, salt) {
  const nums = OPTS.filter((a) => a !== 'wait' && Number.isFinite(r.steps[a])).map((a) => r.steps[a])
  const best = nums.length ? Math.min(...nums) : null
  const raw = {}
  for (const a of OPTS) {
    const v = r.steps[a]
    let s
    if (a === 'wait') s = best == null ? 0 : -1.4 * (Number.isFinite(v) ? v - best : 2) - 0.9
    else if (v === 'wall') s = -6
    else if (v === 'none' || best == null) s = -4
    else s = -1.4 * (v - best)
    if (a !== 'wait' && a === r.lastMove) s += 0.22 // keep walking straight when two ways are as good
    raw[a] = s + (hash01(a, salt) - 0.5) * 0.1
  }
  return softmax(raw)
}

export function arenaMock(text, id, q, salt = 1) {
  const r = readArena(text)
  if (!r) return null
  const probs = moveProbs(r, salt)
  const top = Math.max(...Object.values(probs))
  if (id === 'move') {
    const probabilities = Object.fromEntries((q.options ?? OPTS).map((o) => [o, probs[o] ?? 0]))
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
  }
  if (id === 'heading') {
    const pCoin = r.heading === 'coin' ? clamp(0.93 - 0.012 * (Number(r.steps.wait) || 0), 0.6, 0.95) : 0.05
    const probabilities = { coin: pCoin, goal: 1 - pCoin }
    const choice = pCoin >= 0.5 ? 'coin' : 'goal'
    return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
  }
  if (id === 'sure') return { type: 'noul', noul: clamp((top - 0.25) * 1.6) }
  if (id === 'boxed_in') {
    const walls = OPTS.filter((a) => r.steps[a] === 'wall').length
    return { type: 'noul', noul: r.heading === 'none' ? 0.97 : [0.03, 0.12, 0.38, 0.8, 0.97][walls] }
  }
  return null
}
