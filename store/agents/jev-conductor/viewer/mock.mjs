// mock.mjs — the offline stand-in's reader for the conductor. It reads ONLY the state text and the
// question that live Jev also gets, and answers in the API's shape with a real probability spread.
// What it can do depends on what the text tells it: with no remembered bars in the text it cannot
// follow a progression, hold a mood, or carry a melody over the bar line.
import { hash01 } from '../toolchain/jev.mjs'
import { parseChord, pitchClass } from './music.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function softmax(raw, heat = 1) {
  const max = Math.max(...Object.values(raw))
  const e = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.exp((v - max) * heat)]))
  const sum = Object.values(e).reduce((a, b) => a + b, 0)
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v / sum]))
}
const asChoice = (probabilities) => { const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]; return { type: 'choice', choice, confidence: probabilities[choice], probabilities } }

const CALM = /brood|calm|sparse|sad|dream|blue|dark|quiet|still|gentle|lonely|tender/i
const BRIGHT = /hope|warm|bright|flow|sweet|light|joy|happy|playful|sunny/i
const HOT = /driv|urgent|fierce|wild|fast|storm|angry|bold|dance|chase|trium/i
/** A rough energy for a mood word: 0 sparse .. 2 driving. */
export const moodEnergy = (m) => (HOT.test(m) ? 1.8 : CALM.test(m) ? 0.5 : BRIGHT.test(m) ? 1.15 : 1)

export function readPiece(text) {
  const list = (re) => (re.exec(text)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const pos = /which is bar (\d+) of a (\d+)-bar phrase/.exec(text)
  const bars = [...text.matchAll(/^\s*bar (\d+): (\S+) · (.+?) · energy ([\d.]+) · bass (\S+) · lead ([^\n]+)$/gm)]
    .map((m) => ({ bar: Number(m[1]), chord: m[2], mood: m[3], energy: Number(m[4]), bass: m[5], lead: m[6].trim().split(/\s+/) }))
  const now = /This bar's chord is (\S+) \(tones ([^)]*)\)\. Its mood is (.+?) and its energy is ([\d.]+) of 2/.exec(text)
  return {
    chords: list(/Available chords: ([^\n]+?)\. The home/), home: /The home chord is ([^.\n]+)\./.exec(text)?.[1] ?? null,
    moods: list(/Moods to choose from: ([^\n]+?)\./), request: /The audience asked for: ([^.\n]+)\./.exec(text)?.[1] ?? null,
    pos: pos ? Number(pos[1]) : null, phrase: pos ? Number(pos[2]) : null, bars,
    scale: list(/Scale for the lead: ([^\n]+?)\. Bass/), lastEnd: /Your last lead phrase ended on (\S+?)\./.exec(text)?.[1] ?? null,
    now: now ? { chord: now[1], mood: now[3], energy: Number(now[4]) } : null,
  }
}

function chordScores(r, salt) {
  const home = parseChord(r.home), prev = r.bars.at(-1), prev2 = r.bars.at(-2)
  const p = prev ? parseChord(prev.chord) : null
  const mood = r.request ?? prev?.mood ?? ''
  const raw = {}
  for (const name of r.chords) {
    const c = parseChord(name); let s = 0
    if (!c) { raw[name] = -5; continue }
    if (p) {
      const move = (c.root - p.root + 12) % 12
      if (move === 0) s -= prev2 && prev2.chord === prev.chord ? 2.4 : 1.3 // do not sit on one chord
      else if (move === 5) s += 2.0 // up a fourth: the strongest pull
      else if ([7, 2, 9, 8].includes(move)) s += 1.5
      else s -= 0.4
      if (prev2 && prev2.chord === name) s -= 0.5 // no ping-pong
    }
    if (home && r.pos === 1 && c.root === home.root) s += 1.5 // start a phrase at home
    if (home && r.pos === r.phrase) { if (c.root === (home.root + 7) % 12) s += 1.5; if (c.root === home.root) s -= 0.7 } // end it ready to come home
    if (CALM.test(mood) && c.colour === 'minor') s += 0.7
    if (BRIGHT.test(mood) && c.colour === 'major') s += 0.5
    if (HOT.test(mood) && c.colour === 'dominant') s += 0.5
    raw[name] = s + (hash01(name, salt) - 0.5) * 0.3
  }
  return raw
}

function moodScores(r, salt) {
  const prev = r.bars.at(-1)
  const raw = {}
  r.moods.forEach((m, i) => {
    let s = 0
    if (r.request) s += m === r.request ? 2.6 : 0
    else if (prev) {
      const at = r.moods.indexOf(prev.mood)
      if (r.pos === 1) s += i === (at + 1) % r.moods.length ? 1.5 : m === prev.mood ? 0.6 : 0 // a new phrase may move on
      else s += m === prev.mood ? 1.9 : 0 // hold the mood through the phrase
    }
    raw[m] = s + (hash01(m, salt) - 0.5) * 0.4
  })
  return raw
}

function bell(score, legend) {
  const labels = Object.values(legend ?? { 0: 'sparse', 1: 'flowing', 2: 'driving' })
  const probabilities = softmax(Object.fromEntries(labels.map((l, i) => [l, -((i - score) ** 2) / 0.5])))
  return { type: 'score', score, legend, probabilities, confidence: Math.max(...Object.values(probabilities)) }
}

/**
 * Where the phrase wants to go, from -1 (low) to 1 (high) around its centre, by mood. t runs 0..1
 * through the bar. Calm moods sigh downward, bright moods climb, hot moods zigzag upward.
 */
function contour(mood, t) {
  const shape = HOT.test(mood) ? [-0.5, 0.5, -0.5, 0.7, -0.3, 0.9, -0.1, 1] : CALM.test(mood) ? [0.6, 0.2, 0.5, -0.1, 0.1, -0.5, -0.9, -0.6] : [-0.6, -0.2, 0.3, 0, 0.5, 1, 0.6, 0.2]
  const x = t * (shape.length - 1), i = Math.floor(x), f = x - i
  return shape[i] + ((shape[Math.min(shape.length - 1, i + 1)] - shape[i]) * f)
}

export function conductorMock(text, id, q, salt = 1) {
  const r = readPiece(text)
  if (!r.chords.length || !r.home) return null
  if (id === 'chord') return asChoice(softmax(chordScores(r, salt), 1.15))
  if (id === 'mood') return r.moods.length ? asChoice(softmax(moodScores(r, salt), 1.2)) : null
  if (id === 'energy') {
    const mood = r.request ?? r.bars.at(-1)?.mood ?? ''
    const lift = r.pos && r.phrase ? ((r.pos - 1) / Math.max(1, r.phrase - 1)) * 0.35 : 0
    return bell(clamp(moodEnergy(mood) + lift + (hash01('energy', salt) - 0.5) * 0.2, 0, 2), q.legend)
  }
  if (!r.now) return null
  const chord = parseChord(r.now.chord)
  if (id === 'bass') {
    const raw = {}
    for (const n of q.options ?? []) {
      const pc = pitchClass(n)
      raw[n] = (chord && pc === chord.root ? 2.3 : chord && pc === (chord.root + 7) % 12 ? 1.0 : chord?.pcs.includes(pc) ? 0.7 : -0.6) + (hash01(n, salt) - 0.5) * 0.3
    }
    return Object.keys(raw).length ? asChoice(softmax(raw, 1.1)) : null
  }
  const k = /^lead(\d+)$/.exec(id)
  if (k && r.scale.length) {
    const slot = Number(k[1]), total = Number(/of (\d+)/.exec(q.instructions ?? '')?.[1] ?? 8)
    const mid = (r.scale.length - 1) / 2
    // Carry on from where the last phrase ended (when the text says where), pulled a little to the middle.
    const from = r.lastEnd && r.scale.includes(r.lastEnd) ? r.scale.indexOf(r.lastEnd) * 0.55 + mid * 0.45 : mid
    const t = total > 1 ? (slot - 1) / (total - 1) : 0
    const reach = mid * 0.95 * (1 - 0.45 * (1 - t)) // the phrase opens out from its first note
    const target = clamp(from + contour(r.now.mood, t) * reach, 0, r.scale.length - 1)
    const strong = slot % 2 === 1
    const raw = {}
    r.scale.forEach((n, i) => { raw[n] = -0.95 * Math.abs(i - target) + (chord?.pcs.includes(pitchClass(n)) ? (strong ? 1.3 : 0.35) : 0) + (hash01(n + id, salt) - 0.5) * 0.35 })
    raw.rest = slot === 1 ? -4 : (strong ? -3.2 : -2.0) + (2 - r.now.energy) * (strong ? 0.5 : 1.25)
    const options = q.options?.length ? q.options.map(String) : Object.keys(raw)
    return asChoice(softmax(Object.fromEntries(options.map((o) => [o, raw[o] ?? -6])), 1.1))
  }
  return null
}
