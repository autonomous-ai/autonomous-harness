// mock.mjs — the offline stand-in's reader for the duel. It reads ONLY the state text that live Jev
// also gets: the personality line, the list of legal moves with whatever the text says about each,
// and (for the referee) the facts about the move just played. It never looks at the game object.
import { hash01 } from '../toolchain/jev.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const lerp = (a, b, t) => a + (b - a) * t

/** 0 = patient and positional, 1 = greedy for disks. Read from the "You are ..." line. */
export function readStyle(text) {
  const me = /You are [^\n]*?, playing [OX]\.([^\n]*)/.exec(text)?.[1] ?? ''
  const g = (me.match(/greed|biggest|gobbl|material|grab|aggress|attack|smash|reckless|risk/gi) ?? []).length
  const p = (me.match(/patien|position|corner|quiet|structur|careful|defen|avoid|safe|cautious/gi) ?? []).length
  return g + p === 0 ? 0.5 : g / (g + p)
}

/** The legal-move list, with only the facts the text actually carries. */
export function readMoves(text) {
  const out = []
  for (const [, x, y, flips, rest] of text.matchAll(/^\s*(\d+),(\d+) flips (\d+)([^\n]*)$/gm)) {
    const reply = /rival's best reply flips (\d+)/.exec(rest), left = /leaves your rival (\d+) moves/.exec(rest)
    out.push({
      key: `${x},${y}`, flips: Number(flips),
      corner: /· corner(?= ·|$)/.test(rest), edge: /· edge(?= ·|$)/.test(rest), risky: /· next to an open corner/.test(rest),
      replyBest: reply ? Number(reply[1]) : null, givesCorner: /hands your rival a corner/.test(rest), replyCount: left ? Number(left[1]) : null,
    })
  }
  return out
}

const PATIENT = { flips: 0.22, corner: 3.2, edge: 0.7, risky: 1.8, reply: 0.4, gives: 3.2, room: 0.4 }
const GREEDY = { flips: 1.0, corner: 1.6, edge: 0.3, risky: 0.5, reply: 0.16, gives: 1.3, room: 0.1 }

export function scoreMove(m, style) {
  const w = (k) => lerp(PATIENT[k], GREEDY[k], style)
  let s = w('flips') * m.flips + (m.corner ? w('corner') : 0) + (m.edge ? w('edge') : 0) - (m.risky ? w('risky') : 0)
  if (m.replyBest != null) s -= w('reply') * m.replyBest
  if (m.givesCorner) s -= w('gives')
  if (m.replyCount != null) s -= w('room') * m.replyCount
  return s
}

function softmax(raw, heat = 1) {
  const max = Math.max(...Object.values(raw))
  const e = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.exp((v - max) * heat)]))
  const sum = Object.values(e).reduce((a, b) => a + b, 0)
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v / sum]))
}

function bell(score, legend) {
  const keys = Object.keys(legend ?? { 0: 'low', 1: 'mid', 2: 'high' })
  const raw = Object.fromEntries(keys.map((k, i) => [legend?.[k] ?? k, -((i - score) ** 2) / 0.5]))
  const probabilities = softmax(raw)
  return { type: 'score', score, legend, probabilities, confidence: Math.max(...Object.values(probabilities)) }
}

export function duelMock(text, id, q, salt = 1) {
  // ---- a player picking a move
  if (id === 'move' || id === 'confident') {
    const moves = readMoves(text)
    if (!moves.length) return null
    const style = readStyle(text)
    const raw = {}
    for (const m of moves) raw[m.key] = scoreMove(m, style) + (hash01(m.key, salt) - 0.5) * 0.3
    const options = q.options?.length ? q.options.map(String) : Object.keys(raw)
    const probabilities = softmax(Object.fromEntries(options.map((o) => [o, raw[o] ?? -9])), 0.9)
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    if (id === 'move') return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
    return { type: 'noul', noul: clamp((probabilities[choice] - 0.15) * 1.25, 0.04, 0.97) }
  }
  // ---- the referee judging the move just played
  const played = /just played \d+,\d+, flipping (\d+) disks\. That square is ([^.\n]+)\./.exec(text)
  if (!played) return null
  const flips = Number(played[1]), where = played[2]
  const replyBest = Number(/flip at most (\d+) disks in reply/.exec(text)?.[1] ?? 0)
  const givesCorner = /and can take a corner next/.test(text)
  const sc = /Score: O (\d+), X (\d+)\. Empty squares: (\d+) of (\d+)/.exec(text)
  if (id === 'strong') {
    const s = 1 + (where === 'a corner' ? 0.9 : where === 'an edge square' ? 0.25 : where === 'next to an open corner' ? -0.6 : 0) - (givesCorner ? 0.9 : 0) + (flips - replyBest) * 0.12
    return bell(clamp(s, 0, 2), q.legend)
  }
  if (id === 'aggressive') return { type: 'noul', noul: clamp(1 / (1 + Math.exp(-(flips - 2.4) * 0.9)), 0.03, 0.97) }
  if (id === 'decided') {
    if (!sc) return null
    const o = Number(sc[1]), x = Number(sc[2]), empty = Number(sc[3]), total = Number(sc[4])
    return bell(clamp((Math.abs(o - x) / total) * 6 * (0.3 + (1 - empty / total)), 0, 2), q.legend)
  }
  return null
}
