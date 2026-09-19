// music.mjs — the piece, the text Jev reads, and how the tune is measured. Pure logic: no I/O, no
// timers, no randomness.
//
// The honest dial is `memory`: how many of its own last bars the text shows Jev. With a few bars in
// view Jev can follow a chord with the next one in a common progression, hold a mood for a phrase,
// and start each lead phrase near where the last one ended. With memory 0 it cannot know what it
// just played, so the harmony wanders, the mood flickers and the melody jumps.

export const DEFAULT = {
  title: 'Jev in Blue',
  description: 'A tune Jev composes live, one bar at a time.',
  tempo: 96, // bpm
  beatsPerBar: 4,
  swing: 0.2,
  scale: ['C4', 'D4', 'E4', 'G4', 'A4'],
  bassScale: ['C2', 'G2', 'A2', 'F2'],
  chords: ['Cmaj7', 'Am7', 'Fmaj7', 'G7'], // the first one is the home chord
  moods: ['brooding', 'hopeful', 'driving'],
  leadNotes: 8, // lead slots per bar; Jev picks every one of them
  volume: 0.6,
  memory: 4, // bars of its own music Jev can see, 0..8
  phrase: 4, // bars in a phrase
}

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export function midi(note) {
  const m = /^([A-G](?:#|b)?)(-?\d)$/.exec(String(note))
  return m && PC[m[1]] != null ? PC[m[1]] + (Number(m[2]) + 1) * 12 : null
}
export const pitchClass = (note) => { const m = midi(note); return m == null ? null : m % 12 }

/** Root, colour and tones of a chord name such as Cmaj7, Am7, G7, Dm, Bdim, Fsus4. */
export function parseChord(name) {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(String(name).trim())
  if (!m || PC[m[1]] == null) return null
  const root = PC[m[1]], q = m[2]
  const minor = /^m(?!aj)/.test(q), dim = /dim|°/.test(q), sus = /sus/.test(q)
  const steps = dim ? [0, 3, 6] : sus ? [0, 5, 7] : minor ? [0, 3, 7] : [0, 4, 7]
  if (/maj7/.test(q)) steps.push(11); else if (/7/.test(q)) steps.push(10)
  const colour = dim || minor ? 'minor' : /7/.test(q) && !/maj7/.test(q) ? 'dominant' : 'major'
  return { name: String(name).trim(), root, colour, pcs: steps.map((s) => (root + s) % 12), tones: steps.map((s) => NAMES[(root + s) % 12]) }
}

/** Keep a wild piece.json from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw = {}) {
  const notes = (arr, lo, hi, def) => { const out = (Array.isArray(arr) ? arr : []).map(String).filter((n) => { const m = midi(n); return m != null && m >= lo && m <= hi }).slice(0, 16); return out.length ? [...new Set(out)] : def }
  const words = (arr, def, max) => { const out = (Array.isArray(arr) ? arr : []).map((s) => String(s).replace(/[^\w #-]/g, '').trim().slice(0, 24)).filter(Boolean).slice(0, max); return out.length ? [...new Set(out)] : def }
  const chords = words(raw.chords, DEFAULT.chords, 12).filter((c) => parseChord(c))
  return {
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    tempo: Math.round(num(raw.tempo, 30, 240, DEFAULT.tempo)),
    beatsPerBar: Math.round(num(raw.beatsPerBar, 2, 8, DEFAULT.beatsPerBar)),
    swing: num(raw.swing, 0, 0.9, DEFAULT.swing),
    scale: notes(raw.scale, 48, 96, DEFAULT.scale).sort((a, b) => midi(a) - midi(b)),
    bassScale: notes(raw.bassScale, 24, 60, DEFAULT.bassScale),
    chords: chords.length ? chords : DEFAULT.chords,
    moods: words(raw.moods, DEFAULT.moods, 8),
    leadNotes: Math.round(num(raw.leadNotes, 2, 16, DEFAULT.leadNotes)),
    volume: num(raw.volume, 0, 1, DEFAULT.volume),
    memory: Math.round(num(raw.memory, 0, 8, DEFAULT.memory)),
    phrase: Math.round(num(raw.phrase, 2, 8, DEFAULT.phrase)),
  }
}

export const barMs = (piece) => Math.max(120, Math.round((60000 / Math.max(20, piece.tempo)) * piece.beatsPerBar))

const barLine = (b) => `  bar ${b.bar}: ${b.chord} · ${b.mood} · energy ${b.energy.toFixed(1)} · bass ${b.bass} · lead ${b.lead.join(' ')}`

/** What Jev reads before it picks the chord, the mood and the energy of the next bar. */
export function harmonyState(piece, plan, barNo, request) {
  const seen = piece.memory > 0 ? plan.slice(-piece.memory) : []
  const pos = ((barNo - 1) % piece.phrase) + 1
  return [
    'You are composing a live piece, one bar at a time.',
    `Title: ${piece.title}. Tempo ${piece.tempo} bpm, ${piece.beatsPerBar} beats a bar, swing ${piece.swing}.`,
    `Available chords: ${piece.chords.join(', ')}. The home chord is ${piece.chords[0]}.`,
    `Moods to choose from: ${piece.moods.join(', ')}.`,
    request ? `The audience asked for: ${request}.` : 'The audience has not asked for a mood.',
    `This is bar ${barNo}, which is bar ${pos} of a ${piece.phrase}-bar phrase.`,
    seen.length ? `You remember your last ${seen.length} bars:\n${seen.map(barLine).join('\n')}` : 'You do not remember the bars you wrote before.',
    'Choose the chord, the mood and the energy for this bar. Keep the harmony moving: start a phrase at home, follow each chord with one that leads on from it, and end a phrase ready to come home.',
  ].join('\n')
}

/** What Jev reads before it picks the bass note and every lead note of the bar. */
export function notesState(piece, plan, barNo, request, bar) {
  const chord = parseChord(bar.chord)
  const prev = piece.memory > 0 ? plan[plan.length - 1] : null
  const lastNote = prev ? [...prev.lead].reverse().find((n) => n !== 'rest') : null
  return [
    harmonyState(piece, plan, barNo, request).split('\n').slice(0, -1).join('\n'),
    `This bar's chord is ${bar.chord} (tones ${chord ? chord.tones.join(' ') : '?'}). Its mood is ${bar.mood} and its energy is ${bar.energy.toFixed(1)} of 2.`,
    `Scale for the lead: ${piece.scale.join(', ')}. Bass options: ${piece.bassScale.join(', ')}.`,
    lastNote ? `Your last lead phrase ended on ${lastNote}.` : 'You do not know where your last lead phrase ended.',
    `Choose the bass note and each of the ${piece.leadNotes} lead notes. Put chord tones on the strong beats, move by step, and rest now and then when the energy is low.`,
  ].join('\n')
}

/** Does the root move in a way that leads the ear on? Up a fourth or fifth, down a third, up a step. */
export function strongMove(from, to) {
  const a = parseChord(from), b = parseChord(to)
  if (!a || !b) return false
  return [5, 7, 2, 9, 8].includes((b.root - a.root + 12) % 12)
}

/** How the tune holds together, over the bars given: harmony flow, repeats, mood changes, melody jumps. */
export function measure(piece, bars) {
  let pairs = 0, strong = 0, repeats = 0, moodFlips = 0, leap = 0, leaps = 0
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i]
    pairs++
    if (a.chord === b.chord) repeats++; else if (strongMove(a.chord, b.chord)) strong++
    if (a.mood !== b.mood && !b.request) moodFlips++
    const end = [...a.lead].reverse().find((n) => n !== 'rest'), start = b.lead.find((n) => n !== 'rest')
    if (end && start) { leap += Math.abs(piece.scale.indexOf(end) - piece.scale.indexOf(start)); leaps++ }
  }
  return { pairs, flow: pairs ? strong / pairs : 0, repeats: pairs ? repeats / pairs : 0, moodFlips: pairs ? moodFlips / pairs : 0, leap: leaps ? leap / leaps : 0 }
}
