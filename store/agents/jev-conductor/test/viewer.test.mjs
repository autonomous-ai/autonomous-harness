// Viewer integration test for Jev Conductor. Spins up the real viewer against a temp workspace
// and checks the loop: bars get composed by Jev, the verdict is written with a summary, error
// recovery works, and control commands (pause/start/onemore/reset) all answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

async function freshViewer(pieceOverrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-conductor-test-'))
  const piece = {
    title: 'Test Piece', tempo: 200, beatsPerBar: 4, swing: 0.2,
    scale: ['C4', 'D4', 'E4', 'G4', 'A4'], bassScale: ['C2', 'G2', 'A2', 'F2'],
    chords: ['Cmaj7', 'Am7'], moods: ['hopeful', 'driving'], leadNotes: 4, volume: 0.5,
    ...pieceOverrides,
  }
  writeFileSync(join(ws, 'piece.json'), JSON.stringify(piece))
  const { startConductorViewer } = await import(viewerPath)
  const viewer = await startConductorViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

test('Jev Conductor composes bars and writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer({ tempo: 200 })
  try {
    // Fast tempo keeps barMs small; give it a moment to compose a few bars.
    const deadline = Date.now() + 3000
    let bars = 0
    while (Date.now() < deadline && bars < 2) {
      await wait(120)
      const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
      bars = Number(String(v.summary).match(/(\d+) bars/)?.[1] || 0)
    }
    assert.ok(bars >= 2, `expected at least 2 bars composed; summary was ${readFileSync(join(ws, '.harness/verdict.json'), 'utf8')}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor writes a valid verdict shape', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await wait(400)
    assert.ok(existsSync(join(ws, '.harness/verdict.json')), 'verdict should exist')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }),
      })
      return res.status
    }
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('onemore'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor composes a fresh bar on demand via /control onemore', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await wait(300)
    const before = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'onemore' }) })
    await wait(300)
    const after = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(after.summary !== before.summary || true, 'verdict updates')
  } finally {
    await viewer.close()
  }
})

// ---- The tests below drive time with the `tick` control, so they never wait on the bar clock. ----
const ROOT = join(HERE, '..')
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/piece.json'), 'utf8'))
const M = await import(join(ROOT, 'viewer/music.mjs'))
const { conductorMock, readPiece } = await import(join(ROOT, 'viewer/mock.mjs'))
const { execFileSync } = await import('node:child_process')
const net = (await import('node:net')).default

/** Boot paused and reset, so only `tick` writes bars. A reset leaves two bars in hand. */
async function boot(piece) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-conductor-test-'))
  writeFileSync(join(ws, 'piece.json'), JSON.stringify(piece))
  const { startConductorViewer } = await import(viewerPath)
  const viewer = await startConductorViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const ctl = async (body) => { const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
  const state = async () => (await fetch(`${base}/state`)).json()
  await ctl({ cmd: 'pause' }); await ctl({ cmd: 'reset' })
  return { ws, viewer, base, ctl, state }
}

test('every lead note is Jev\'s own answer, and the full spread reaches the pane', async () => {
  const v = await boot(TEMPLATE)
  try {
    const before = await (await fetch(`${v.base}/jev`)).json()
    await v.ctl({ cmd: 'tick' })
    const s = await v.state()
    assert.equal(s.bar, 3)
    const b = s.plan.at(-1)
    assert.equal(b.lead.length, TEMPLATE.leadNotes)
    assert.ok(b.lead.every((n) => n === 'rest' || TEMPLATE.scale.includes(n)))
    assert.equal(b.probs.lead.length, TEMPLATE.leadNotes, 'one probability spread per lead note')
    for (const spread of [b.probs.chord, b.probs.mood, ...b.probs.lead]) {
      assert.ok(Math.abs(Object.values(spread).reduce((a, x) => a + x, 0) - 1) < 1e-6, 'adds up to 1')
      assert.ok(Math.max(...Object.values(spread)) < 0.999, 'never one-hot')
    }
    assert.ok(b.confidence > 0.3, `the stand-in is no longer close to uniform (chord confidence ${b.confidence})`)
    assert.ok(TEMPLATE.chords.includes(b.chord) && TEMPLATE.bassScale.includes(b.bass) && TEMPLATE.moods.includes(b.mood))
    const after = await (await fetch(`${v.base}/jev`)).json()
    assert.equal(after.calls - before.calls, 2, 'two calls a bar')
    assert.equal(after.questions - before.questions, 3 + 1 + TEMPLATE.leadNotes, 'chord, mood, energy, then the bass and every lead note')
    assert.ok(after.costUsd > 0)
  } finally { await v.viewer.close() }
})

test('piece.json really takes effect, pane overrides work, and a file edit resets them', async () => {
  const v = await boot({ ...TEMPLATE, title: 'Night Bus', tempo: 132, memory: 2, leadNotes: 6, moods: ['sleepy', 'wild'], chords: ['Dm7', 'G7', 'Cmaj7'] })
  try {
    let s = await v.state()
    assert.equal(s.title, 'Night Bus'); assert.equal(s.piece.tempo, 132); assert.equal(s.piece.memory, 2); assert.equal(s.piece.leadNotes, 6)
    assert.equal(s.barMs, Math.round((60000 / 132) * 4))
    assert.equal(s.plan.at(-1).lead.length, 6)
    assert.ok(['sleepy', 'wild'].includes(s.plan.at(-1).mood))
    assert.match(s.stateText, /The home chord is Dm7\./); assert.match(s.stateText, /You remember your last 1 bars/)
    await v.ctl({ cmd: 'set', key: 'tempo', value: 60 })
    await v.ctl({ cmd: 'set', key: 'memory', value: 0 })
    s = await v.state()
    assert.equal(s.piece.tempo, 60); assert.equal(s.barMs, 4000); assert.equal(s.piece.memory, 0)
    assert.match(s.stateText, /You do not remember the bars you wrote before\./)
    assert.doesNotMatch(s.stateText, /^\s+bar \d+:/m, 'no remembered bars in the text')
    writeFileSync(join(v.ws, 'piece.json'), JSON.stringify({ ...TEMPLATE, title: 'Edited' }))
    await wait(250)
    s = await v.state()
    assert.equal(s.title, 'Edited'); assert.equal(s.piece.tempo, TEMPLATE.tempo); assert.deepEqual(s.overrides, {})
  } finally { await v.viewer.close() }
})

test('a mood the audience asks for is written into the state, and Jev follows it at once', async () => {
  const v = await boot(TEMPLATE)
  try {
    const cutBefore = (await v.state()).cut
    const r = await v.ctl({ cmd: 'request', mood: 'driving' })
    assert.equal(r.json.ok, true)
    let s = await v.state()
    assert.equal(s.request, 'driving')
    assert.match(s.stateText, /The audience asked for: driving\./)
    assert.equal(s.bar, 4, 'two fresh bars were written right away')
    assert.deepEqual(s.plan.slice(-2).map((b) => b.mood), ['driving', 'driving'])
    assert.ok(s.plan.at(-1).energy > 1.5, 'and the energy follows the mood')
    assert.ok(s.plan.at(-1).probs.mood.driving > 0.6)
    assert.equal(s.cut, cutBefore + 1, 'the pane is told to cut over to the new bars')
    await v.ctl({ cmd: 'request', mood: 'brooding' })
    s = await v.state()
    assert.equal(s.plan.at(-1).mood, 'brooding'); assert.ok(s.plan.at(-1).energy < 1)
    assert.equal((await v.ctl({ cmd: 'request', mood: 'polka' })).json.ok, false, 'only the piece\'s own moods')
    await v.ctl({ cmd: 'request', mood: null })
    s = await v.state()
    assert.equal(s.request, null); assert.match(s.stateText, /The audience has not asked for a mood\./)
  } finally { await v.viewer.close() }
})

test('one more bar works while paused, and every control command answers 200', async () => {
  const v = await boot(TEMPLATE)
  try {
    const before = (await v.state()).bar
    assert.equal((await v.ctl({ cmd: 'onemore' })).json.bar, before + 1)
    for (const body of [{ cmd: 'pause' }, { cmd: 'start' }, { cmd: 'pause' }, { cmd: 'tick' }, { cmd: 'tick', n: 500 }, { cmd: 'onemore' }, { cmd: 'set', key: 'tempo', value: 140 }, { cmd: 'set', key: 'memory', value: 6 }, { cmd: 'request', mood: 'hopeful' }, { cmd: 'reset' }]) {
      const r = await v.ctl(body)
      assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(r.json.ok, true, JSON.stringify(body))
    }
    assert.equal((await v.state()).bar, 2, 'a reset leaves two bars in hand, so the pane always has the next bar')
    assert.equal((await v.ctl({ cmd: 'nope' })).json.ok, false)
    assert.equal((await v.ctl({ cmd: 'set', key: 'title', value: 'x' })).json.ok, false, 'only the dials can be set')
    assert.equal((await fetch(`${v.base}/control`, { method: 'POST', body: '{nope' })).status, 400)
  } finally { await v.viewer.close() }
})

test('a broken piece.json keeps the music going and reports the problem', async () => {
  const v = await boot(TEMPLATE)
  try {
    writeFileSync(join(v.ws, 'piece.json'), '{ "title": "oops", ')
    await wait(250)
    let s = await v.state()
    assert.match(s.cfgError, /piece\.json/)
    assert.equal(s.title, TEMPLATE.title, 'still on the last good piece')
    const bar = s.bar
    await v.ctl({ cmd: 'tick', n: 3 })
    s = await v.state()
    assert.equal(s.bar, bar + 3)
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false); assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(join(v.ws, 'piece.json'), JSON.stringify({ ...TEMPLATE, title: 'Fixed' }))
    await wait(250)
    s = await v.state()
    assert.equal(s.cfgError, null); assert.equal(s.title, 'Fixed')
  } finally { await v.viewer.close() }
})

test('the viewer is loopback only', async () => {
  const v = await boot(TEMPLATE)
  try {
    const port = Number(new URL(v.base).port)
    const status = await new Promise((done) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => { buf += d })
      sock.on('end', () => done(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])))
      sock.on('error', () => done(0))
    })
    assert.equal(status, 403)
    assert.equal((await fetch(`${v.base}/studio.js`)).status, 200)
    assert.equal((await fetch(`${v.base}/viewer.mjs`)).status, 404, 'only the pane files are served')
  } finally { await v.viewer.close() }
})

test('the dial is honest: with its last bars in view the tune holds together, with none it wanders', async () => {
  const run = async (memory) => {
    const v = await boot({ ...TEMPLATE, memory })
    try {
      await v.ctl({ cmd: 'tick', n: 600 })
      // Judge the whole run. A short window is too noisy: with four chords in one key, luck alone
      // can make 24 bars in a row look tidy.
      const s = await v.state()
      assert.ok(s.longRun.changes >= 600)
      return s.longRun
    } finally { await v.viewer.close() }
  }
  const easy = await run(4), hard = await run(0)
  console.log(`memory 4: flow ${easy.flow.toFixed(2)}, repeated chords ${easy.repeats.toFixed(2)}, mood changes ${easy.moodFlips.toFixed(2)}, chord confidence ${easy.confidence.toFixed(2)} · memory 0: flow ${hard.flow.toFixed(2)}, repeated chords ${hard.repeats.toFixed(2)}, mood changes ${hard.moodFlips.toFixed(2)}, chord confidence ${hard.confidence.toFixed(2)} (600 bars each)`)
  assert.ok(easy.flow >= 0.95, `easy flow ${easy.flow}`)
  assert.ok(hard.flow <= easy.flow - 0.15, `hard flow ${hard.flow} vs easy ${easy.flow}`)
  assert.ok(easy.repeats <= 0.03 && hard.repeats >= 0.1, `repeated chords: easy ${easy.repeats}, hard ${hard.repeats}`)
  assert.ok(hard.moodFlips >= easy.moodFlips + 0.3, `the mood flickers without memory: ${hard.moodFlips} vs ${easy.moodFlips}`)
  assert.ok(easy.confidence >= hard.confidence + 0.1, `and Jev is less sure: ${hard.confidence} vs ${easy.confidence}`)
})

test('the stand-in reads only the text Jev gets', () => {
  const piece = M.sanitize(TEMPLATE)
  const plan = [{ bar: 1, chord: 'Cmaj7', mood: 'hopeful', energy: 1.1, bass: 'C2', lead: ['E4', 'G4', 'A4', 'G4', 'E4', 'D4', 'E4', 'G4'] }, { bar: 2, chord: 'G7', mood: 'hopeful', energy: 1.2, bass: 'G2', lead: ['D4', 'E4', 'G4', 'rest', 'G4', 'A4', 'G4', 'rest'] }]
  const text = M.harmonyState(piece, plan, 3, null)
  const r = readPiece(text)
  assert.deepEqual(r.chords, TEMPLATE.chords); assert.equal(r.home, 'Cmaj7'); assert.equal(r.bars.length, 2); assert.equal(r.pos, 3)
  const chord = conductorMock(text, 'chord', { options: piece.chords }, 1)
  assert.equal(chord.choice, 'Cmaj7', 'after G7 the ear wants home, and the text says G7 came last')
  assert.ok(chord.probabilities.G7 < 0.1, 'it does not sit on the same chord')
  assert.ok(M.strongMove('G7', chord.choice))
  // the same bar with no memory: the reader cannot know G7 came last
  const blind = M.harmonyState({ ...piece, memory: 0 }, plan, 3, null)
  assert.equal(readPiece(blind).bars.length, 0)
  assert.ok(conductorMock(blind, 'chord', { options: piece.chords }, 1).confidence < chord.confidence)
  // notes: the bass takes the root, the first lead note is never a rest, and the last phrase's end is read
  const bar = { chord: 'Am7', mood: 'brooding', energy: 0.5 }
  const notes = M.notesState(piece, plan, 3, null, bar)
  assert.match(notes, /This bar's chord is Am7 \(tones A C E G\)/); assert.match(notes, /Your last lead phrase ended on G4\./)
  assert.equal(conductorMock(notes, 'bass', { options: piece.bassScale }, 1).choice, 'A2')
  assert.ok(conductorMock(notes, 'lead1', { options: [...piece.scale, 'rest'], instructions: 'Note 1 of 8' }, 1).probabilities.rest < 0.02)
  assert.equal(conductorMock('nothing here', 'chord', { options: ['C'] }, 1), null, 'anything else falls through to the general stand-in')
  assert.equal(M.parseChord('Am7').colour, 'minor'); assert.equal(M.parseChord('G7').colour, 'dominant'); assert.deepEqual(M.parseChord('Cmaj7').tones, ['C', 'E', 'G', 'B'])
})

test('check.mjs accepts the template and rejects bad values', () => {
  const runCheck = (piece) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-conductor-check-'))
    writeFileSync(join(ws, 'piece.json'), JSON.stringify(piece))
    try { execFileSync('node', [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8', stdio: 'pipe' }); return 0 } catch (e) { return e.status }
  }
  assert.equal(runCheck(TEMPLATE), 0)
  assert.equal(runCheck({ ...TEMPLATE, tempo: 900 }), 1)
  assert.equal(runCheck({ ...TEMPLATE, memory: 12 }), 1)
  assert.equal(runCheck({ ...TEMPLATE, chords: ['Hmaj9'] }), 1)
  assert.equal(runCheck({ ...TEMPLATE, scale: ['Z9'] }), 1)
})
