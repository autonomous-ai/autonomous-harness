// node --test pane/ — the voice parser the pane's mixer and lanes are built on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseVoices, voiceAt, nameFromComment } from './voices.mjs'

const template = readFileSync(new URL('../template/track.strudel', import.meta.url), 'utf8')

test('the template: one voice per stack argument, named by the comment above it', () => {
  const { kind, voices } = parseVoices(template)
  assert.equal(kind, 'stack')
  assert.deepEqual(voices.map((v) => v.name), ['Kick', 'Backbeat', 'Hats', 'Bass', 'Pad', 'Lead'])
  assert.match(voices[0].detail, /four on the floor/)
  for (const v of voices) assert.ok(v.to > v.from)
  // ranges cover the code, not the comments, and do not overlap
  assert.ok(template.slice(voices[0].from, voices[0].to).startsWith('s("sbd*4")'))
  for (let k = 1; k < voices.length; k++) assert.ok(voices[k].from >= voices[k - 1].to)
})

test('a sound inside a voice maps back to that voice', () => {
  const { voices } = parseVoices(template)
  const at = template.indexOf('white*8')
  assert.equal(voiceAt(voices, at), 2)
  assert.equal(voiceAt(voices, 0), -1)
})

test('labelled blocks, with muted ones and names from the label', () => {
  const code = `setcpm(30)\n// Drums: the groove\n$: s("sbd*4")\n\nbass: note("c2 g1").s("sawtooth")\n_$: s("white*8")\n`
  const { kind, voices } = parseVoices(code)
  assert.equal(kind, 'labels')
  assert.deepEqual(voices.map((v) => v.name), ['Drums', 'bass', 'white'])
  assert.equal(voices[2].muted, true)
  assert.equal(voiceAt(voices, code.indexOf('g1')), 1)
})

test('no comment: named after the first sound it plays; commas inside strings and calls do not split', () => {
  const code = 'stack(\n  s("bd, hh*8").gain(".5 .2"),\n  note("c3,e3").s("triangle"),\n)'
  const { voices } = parseVoices(code)
  assert.deepEqual(voices.map((v) => v.name), ['bd', 'triangle'])
})

test('a single expression is one voice; an empty file has none; an unclosed stack still parses', () => {
  assert.equal(parseVoices('s("bd sd")').voices[0].name, 'bd')
  assert.equal(parseVoices('// nothing yet\n').kind, 'none')
  const half = parseVoices('stack(\n  // Kick\n  s("sbd*4"),\n  // Bass\n  note("c2')
  assert.deepEqual(half.voices.map((v) => v.name), ['Kick', 'Bass'])
})

test('a title written before the separating comma, and a trailing remark, both name their voice', () => {
  const code = 'stack(\n  s("sbd*4"), // four on the floor\n  // Bell — a ping\n  ,note("a5").s("sine")\n  ,s("white*8") // hats\n)'
  const { voices } = parseVoices(code)
  assert.deepEqual(voices.map((v) => v.name), ['four on the floor', 'Bell', 'hats'])
})

test('names are cut from the first line of a comment', () => {
  assert.equal(nameFromComment('Kick — lazy and syncopated; bar 8 pushes'), 'Kick')
  assert.equal(nameFromComment('Chord stabs — rootless 7th/9th voicings'), 'Chord stabs')
  assert.equal(nameFromComment('Sub bass - sine with a quiet triangle octave'), 'Sub bass')
  assert.equal(nameFromComment('A very long comment line that never gets to a separator at all'), 'A very long')
})
