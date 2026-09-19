#!/usr/bin/env node
// check.mjs — validate a piece.json for the Jev Conductor harness.
// Enforces the shape Jev reads: tempo/beatsPerBar/swing in range, scale & bassScale notes valid,
// chords and moods non-empty, leadNotes sane and consistent with the scale.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ws = process.env.HARNESS_WORKSPACE || '.'
const VALID_BASS = ['C2', 'C#2', 'D2', 'D#2', 'E2', 'F2', 'F#2', 'G2', 'G#2', 'A2', 'A#2', 'B2', 'C3', 'G2']
const VALID_SCALE = ['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5']

let fail = false
const bad = (msg) => { fail = true; console.log(msg) }

let piece
try {
  piece = JSON.parse(readFileSync(join(ws, 'piece.json'), 'utf8'))
} catch (e) {
  console.log(`error  cannot read piece.json: ${e.message}`)
  process.exit(1)
}

if (!piece.title || typeof piece.title !== 'string') bad('warn  no title')
if (typeof piece.tempo !== 'number' || piece.tempo < 30 || piece.tempo > 240) bad('error  tempo must be a number 30..240')
if (!Number.isInteger(piece.beatsPerBar) || piece.beatsPerBar < 2 || piece.beatsPerBar > 8) bad('error  beatsPerBar must be an integer 2..8')
if (typeof piece.swing !== 'number' || piece.swing < 0 || piece.swing > 0.9) bad('error  swing must be a number 0..0.9')
if (!Array.isArray(piece.scale) || !piece.scale.length || piece.scale.some((n) => !VALID_SCALE.includes(n))) bad('error  scale must be a non-empty array of C4..B5 notes')
if (!Array.isArray(piece.bassScale) || !piece.bassScale.length || piece.bassScale.some((n) => !VALID_BASS.includes(n))) bad('error  bassScale must be a non-empty array of C2..C3 notes')
if (!Array.isArray(piece.chords) || !piece.chords.length) bad('error  chords must be a non-empty array')
if (!Array.isArray(piece.moods) || !piece.moods.length) bad('error  moods must be a non-empty array')
if (!Number.isInteger(piece.leadNotes) || piece.leadNotes < 2 || piece.leadNotes > 32) bad('error  leadNotes must be an integer 2..32')
if (piece.leadNotes > piece.scale.length * 3) bad('warn  leadNotes long relative to scale; phrase may repeat')

console.log(fail ? 'fail  invalid piece.json' : 'ok   piece.json is valid')
process.exit(fail ? 1 : 0)
