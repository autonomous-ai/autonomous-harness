// Viewer integration test for Jev Pendulum. Spins up the real viewer against a temp workspace and
// checks the loop: the rod ticks and leans, Jev forms a balancing action, the verdict updates,
// control commands answer, a bad edit is survived, only loopback is served, and the difficulty
// dials are honest. Time is driven with the `tick` control, never with sleeps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')
const ORDER = ['LEFT_HARD', 'LEFT', 'CENTER', 'RIGHT', 'RIGHT_HARD']

const CFG = {
  title: 'Test Rod', instrument: 'ROD', gravity: 7, length: 1.0, damping: 0.5, maxTorque: 2.0,
  stepMs: 60, gustEvery: 10, gustStrength: 0.5, fallDeg: 60,
  style: 'Keep the rod upright.',
}
// The template's rig, used for the dial tests.
const RIG = { maxTorque: 0.8, stepMs: 80, gustEvery: 10, gustStrength: 0.55 }

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-pendulum-test-'))
  writeFileSync(join(ws, 'pendulum.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startPendulumViewer } = await import(viewerPath)
  const viewer = await startPendulumViewer({ workspace: ws, port: 0 })
  const port = viewer.url.split(':').pop()
  const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json()
  const ctl = async (cmd, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
    return res.status
  }
  return { ws, viewer, port, state, ctl }
}

/** Poll /state until `ok(state)` holds. Only used to wait for the file watcher, never for the rig. */
async function until(state, ok, ms = 4000) {
  const deadline = Date.now() + ms
  let s = await state()
  while (!ok(s) && Date.now() < deadline) { await wait(40); s = await state() }
  return s
}

test('Jev Pendulum ticks and Jev forms a balancing action', async () => {
  const { viewer, port } = await freshViewer()
  try {
    const deadline = Date.now() + 3000
    let saw = false
    while (Date.now() < deadline) {
      await wait(150)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.step >= 3 && s.history.length > 0) {
        assert.ok(ORDER.includes(s.lastAction))
        assert.ok(typeof s.angle === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the rod to tick and Jev to act')
  } finally {
    await viewer.close()
  }
})

test('Jev Pendulum writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) { await wait(150); if (existsSync(join(ws, '.harness/verdict.json'))) break }
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Pendulum control commands answer 200', async () => {
  const { viewer, ctl } = await freshViewer()
  try {
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'gust', 'stand']) assert.equal(await ctl(cmd), 200, cmd)
    assert.equal(await ctl('tick', { n: 25 }), 200)
    assert.equal(await ctl('set', { key: 'gravity', value: 9 }), 200)
    assert.equal(await ctl('flick', { v: 0.8 }), 200)
    assert.equal(await ctl('no-such-command'), 200)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const { viewer, state, ctl } = await freshViewer({ gravity: 11.5, length: 1.4, maxTorque: 1.25, title: 'Heavy rod' })
  try {
    await ctl('pause')
    const s = await state()
    assert.equal(s.title, 'Heavy rod')
    assert.equal(s.dials.gravity, 11.5)
    assert.equal(s.dials.length, 1.4)
    assert.equal(s.shove, 2.5, 'the hardest shove is 2 x maxTorque')
    assert.ok(Math.abs(s.noReturnDeg - Math.atan(2.5 / 11.5) * 180 / Math.PI) < 1e-9)
    assert.match(s.stateText, /gravity: 11\.5/)
    assert.match(s.stateText, /rod of length 1\.40/)
  } finally {
    await viewer.close()
  }
})

test('tick advances exactly n decisions, and the frame carries Jev\'s probabilities', async () => {
  const { viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    const before = (await state()).step
    await ctl('tick', { n: 500 })
    const s = await state()
    assert.equal(s.step, before + 500)
    const probs = Object.values(s.decision.probs)
    assert.equal(probs.length, 5)
    assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-6, 'probabilities sum to 1')
    assert.ok(s.decision.conf > 0 && s.decision.conf <= 1)
    assert.ok(s.decision.steady >= 0 && s.decision.steady <= 1)
    assert.deepEqual(Object.keys(s.pushes), ORDER)
    assert.ok(s.trace.length > 100)
  } finally {
    await viewer.close()
  }
})

test('the sliders override the dials, and an edit to pendulum.json resets them', async () => {
  const { ws, viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    await ctl('set', { key: 'gravity', value: 12 })
    await ctl('set', { key: 'length', value: 0.6 })
    await ctl('set', { key: 'gustStrength', value: 1.1 })
    await ctl('set', { key: 'title', value: 'not a dial' })
    let s = await state()
    assert.equal(s.dials.gravity, 12)
    assert.equal(s.dials.length, 0.6)
    assert.equal(s.dials.gustStrength, 1.1)
    assert.equal(s.title, 'Test Rod', 'only the listed dials can be set')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['gravity', 'gustStrength', 'length'])
    await ctl('set', { key: 'gravity', value: 9999 })
    assert.equal((await state()).dials.gravity, 30, 'out-of-range values are clamped')

    writeFileSync(join(ws, 'pendulum.json'), JSON.stringify({ ...CFG, gravity: 5 }))
    s = await until(state, (x) => x.dials.gravity === 5)
    assert.equal(s.dials.gravity, 5)
    assert.deepEqual(s.overrides, {})
    assert.equal(s.dials.length, 1)
  } finally {
    await viewer.close()
  }
})

test('a flick swings the rod that way, a gust kicks it, stand starts a new run', async () => {
  const { viewer, state, ctl } = await freshViewer({ gustEvery: 0 })
  try {
    await ctl('pause')
    await ctl('tick', { n: 20 })
    let s = await state()
    await ctl('flick', { v: 1.2 })
    let t = await state()
    assert.ok(Math.abs(t.vel - (s.vel + 1.2)) < 1e-9, 'a flick to the right adds swing to the right')
    assert.equal(t.events.at(-1).e, 'flick')
    await ctl('flick', { v: -1.2 })
    await ctl('flick', { v: -1.0 })
    t = await state()
    assert.ok(t.vel < s.vel, 'a flick to the left swings it left')

    s = await state()
    await ctl('gust', { dir: 1 })
    t = await state()
    assert.ok(t.vel > s.vel)
    assert.equal(t.events.at(-1).e, 'gust')

    const episode = t.episode
    await ctl('stand')
    t = await state()
    assert.equal(t.episode, episode + 1)
    assert.equal(t.phase, 'balance')
    assert.equal(t.thisRun, 0)
    assert.ok(Math.abs(t.angle) < 5)
  } finally {
    await viewer.close()
  }
})

test('after a fall the result shows for a moment, then a new run starts on its own', async () => {
  const { viewer, state, ctl } = await freshViewer({ ...RIG, gravity: 16 })
  try {
    await ctl('pause')
    let s = await state()
    for (let i = 0; i < 400 && s.phase !== 'fallen'; i++) { await ctl('tick', { n: 5 }); s = await state() }
    assert.equal(s.phase, 'fallen', 'gravity 16 must topple the rod')
    assert.equal(s.falls, 1)
    const episode = s.episode
    await ctl('tick', { n: s.hold + 1 })
    s = await state()
    assert.equal(s.phase, 'balance')
    assert.equal(s.episode, episode + 1)
  } finally {
    await viewer.close()
  }
})

test('a bad pendulum.json edit keeps the rig alive and reports the error', async () => {
  const { ws, viewer, state, ctl } = await freshViewer({ gravity: 8 })
  try {
    await ctl('pause')
    writeFileSync(join(ws, 'pendulum.json'), '{ "gravity": 12, oops')
    let s = await until(state, (x) => !!x.cfgError)
    assert.match(s.cfgError, /pendulum\.json/)
    assert.equal(s.dials.gravity, 8, 'the last good rig stays')
    const before = s.step
    await ctl('tick', { n: 40 })
    s = await state()
    assert.equal(s.step, before + 40, 'the rig keeps going')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(v.findings.some((f) => f.severity === 'error'))

    writeFileSync(join(ws, 'pendulum.json'), JSON.stringify({ ...CFG, gravity: 12 }))
    s = await until(state, (x) => !x.cfgError)
    assert.equal(s.cfgError, null)
    assert.equal(s.dials.gravity, 12)
  } finally {
    await viewer.close()
  }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer, port } = await freshViewer()
  try {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'))
      let data = ''
      sock.on('data', (d) => { data += d })
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
    assert.doesNotMatch(reply, /"angle"/)
  } finally {
    await viewer.close()
  }
})

test('the offline stand-in adds no randomness: a falling rod is always pushed back', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  const ask = async (state, salt) => (await evaluate({ state, questions: { action: { type: 'choice', instructions: 'Which push steadies the rod right now?', options: ORDER } }, salt })).answers.action
  // The text the viewer wrote before the uplift (a torque on a fixed pivot). The old reader let a
  // clearly falling rod go in 5 of 400 answers at hardness 0 and 16 of 400 at hardness 1.
  const oldState = (hardness) => `Keep the rod upright.
A stiff rod of length 1 stands on a pivot. You apply a torque every tick to keep it upright.
angle: 12.0°  velocity: 0.40 rad/s   (falls at ±60°)
hardness: ${hardness.toFixed(2)}
Choose the torque that corrects the lean and steadies the rod. Be decisive.`
  // The text the viewer writes now (a cart). Leaning right wants a push to the RIGHT, to get under it.
  const { sanitize, createWorld, stateText } = await import(join(HERE, '../viewer/sim.mjs'))
  const cfg = sanitize({}), w = createWorld(cfg)
  w.angle = 9 * Math.PI / 180; w.vel = 0.4
  const cartState = stateText(w, cfg)
  let oldWrong = 0, cartWrong = 0
  for (let salt = 1; salt <= 400; salt++) {
    if (!/^LEFT/.test((await ask(oldState(1), salt)).choice)) oldWrong++
    if (!/^RIGHT/.test((await ask(cartState, salt)).choice)) cartWrong++
  }
  assert.equal(oldWrong, 0)
  assert.equal(cartWrong, 0)
  const a = await ask(cartState, 1)
  assert.ok(a.confidence > 0.5 && a.confidence < 0.99, `clear favourite, never one-hot (${a.confidence})`)
  w.angle = -9 * Math.PI / 180; w.vel = -0.4
  assert.match((await ask(stateText(w, cfg), 1)).choice, /^LEFT/)
})

test('the difficulty dials: low gravity never falls, high gravity does; a short rod is harder than a long one', async () => {
  const run = async (over, ticks = 3000) => {
    const { viewer, state, ctl } = await freshViewer({ ...RIG, ...over })
    try {
      await ctl('pause'); await ctl('reset')
      await ctl('tick', { n: ticks })
      const s = await state()
      return { falls: s.falls, bestSecs: (s.bestRun * 80) / 1000, noReturnDeg: Number(s.noReturnDeg.toFixed(1)) }
    } finally {
      await viewer.close()
    }
  }
  const easy = await run({ gravity: 4 }), mid = await run({ gravity: 7 }), hard = await run({ gravity: 12 })
  console.log('  gravity 4 :', JSON.stringify(easy))
  console.log('  gravity 7 :', JSON.stringify(mid))
  console.log('  gravity 12:', JSON.stringify(hard))
  assert.equal(easy.falls, 0, 'at gravity 4 the stand-in must not fall')
  assert.ok(hard.falls >= 15, `at gravity 12 the rod should topple often, got ${hard.falls}`)
  assert.ok(mid.falls <= hard.falls / 3, 'the template sits between the two')
  assert.ok(easy.bestSecs > hard.bestSecs * 5)
  const short = await run({ length: 0.5 }), long = await run({ length: 1.6 })
  console.log('  length 0.5:', JSON.stringify(short))
  console.log('  length 1.6:', JSON.stringify(long))
  assert.ok(short.falls >= 10 && short.falls >= long.falls * 3 + 5, `a short rod (${short.falls} falls) should be much harder than a long one (${long.falls})`)
})

test('every fall is an honest one: the rod was past what the hardest shove can save', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  const { sanitize, createWorld, step, stateText, budgetOf } = await import(join(HERE, '../viewer/sim.mjs'))
  const cfg = sanitize({ gravity: 11 })
  const w = createWorld(cfg)
  let salt = 1, falls = 0, neverLost = 0, peak = 0
  for (let i = 0; i < 5000; i++) {
    let action = 'CENTER'
    if (w.phase === 'balance') {
      action = (await evaluate({ state: stateText(w, cfg), questions: { action: { type: 'choice', instructions: 'Which push steadies the rod right now?', options: ORDER } }, salt: salt++ })).answers.action.choice
      peak = Math.max(peak, Math.abs(budgetOf(w, cfg)))
    }
    for (const e of step(w, cfg, action)) if (e.e === 'fall') { falls++; if (peak < 0.9) neverLost++; peak = 0 }
  }
  console.log(`  ${falls} falls, ${neverLost} of them without the lean budget ever running out`)
  assert.ok(falls > 10)
  assert.equal(neverLost, 0)
})
