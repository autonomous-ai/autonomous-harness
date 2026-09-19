// Viewer integration test for Jev Lander. Spins up the real viewer against a temp workspace and
// checks the loop: the booster descends, Jev sets throttles, the verdict updates, control commands
// answer, a bad edit is survived, only loopback is served, and the difficulty dials are honest.
// Time is driven with the `tick` control, never with sleeps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')
const ACTIONS = ['CUT', 'COAST', 'HOVER', 'BURN']

const CFG = {
  title: 'Test Landing', instrument: 'LANDER', tickMs: 100, gravity: 1.2, fuel: 260, altitude: 80, safeSpeed: 2.0,
  style: 'Bring it down to the pad gently.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-lander-test-'))
  writeFileSync(join(ws, 'lander.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startLanderViewer } = await import(viewerPath)
  const viewer = await startLanderViewer({ workspace: ws, port: 0 })
  const port = viewer.url.split(':').pop()
  const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json()
  const ctl = async (cmd, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
    return res.status
  }
  return { ws, viewer, port, state, ctl }
}

/** Poll /state until `ok(state)` holds. Only used to wait for the file watcher, never for the flight. */
async function until(state, ok, ms = 4000) {
  const deadline = Date.now() + ms
  let s = await state()
  while (!ok(s) && Date.now() < deadline) { await wait(40); s = await state() }
  return s
}

test('Jev Lander descends and Jev sets throttles', async () => {
  const { viewer, port } = await freshViewer()
  try {
    const deadline = Date.now() + 2500
    let saw = false
    while (Date.now() < deadline) {
      await wait(120)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.history.length >= 3) {
        assert.ok(ACTIONS.includes(s.thrust))
        assert.ok(typeof s.y === 'number')
        assert.ok(typeof s.v === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the booster to descend and Jev to set throttles')
  } finally {
    await viewer.close()
  }
})

test('Jev Lander writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 1500
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

test('Jev Lander control commands answer 200', async () => {
  const { viewer, ctl } = await freshViewer()
  try {
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'shove', 'leak', 'flameout', 'launch']) assert.equal(await ctl(cmd), 200, cmd)
    assert.equal(await ctl('tick', { n: 25 }), 200)
    assert.equal(await ctl('set', { key: 'gravity', value: 2 }), 200)
    assert.equal(await ctl('no-such-command'), 200)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const { viewer, state, ctl } = await freshViewer({ gravity: 1.85, fuel: 140, altitude: 120, safeSpeed: 1.5, title: 'Heavy world' })
  try {
    await ctl('pause')
    const s = await state()
    assert.equal(s.title, 'Heavy world')
    assert.equal(s.gravity, 1.85)
    assert.equal(s.dials.gravity, 1.85)
    assert.equal(s.dials.fuel, 140)
    assert.equal(s.tank, 140)
    assert.equal(s.dials.safeSpeed, 1.5)
    assert.ok(Math.abs(s.brake - 0.75) < 1e-9, 'full burn brakes by 2.6 - gravity')
    assert.ok(s.startAlt >= 120 * 0.9 && s.startAlt <= 120 * 1.1, 'the drop height follows the config')
    assert.match(s.stateText, /G 1\.85/)
  } finally {
    await viewer.close()
  }
})

test('tick advances exactly n decisions, and the frame carries Jev\'s probabilities', async () => {
  const { viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    const before = (await state()).t
    await ctl('tick', { n: 500 })
    const s = await state()
    assert.equal(s.t, before + 500)
    assert.ok(s.landed + s.crashed >= 5, 'flights finish and new ones start on their own')
    const probs = Object.values(s.decision.probs)
    assert.equal(probs.length, 4)
    assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-6, 'probabilities sum to 1')
    assert.ok(s.decision.conf > 0 && s.decision.conf <= 1)
    assert.ok(s.decision.soft >= 0 && s.decision.soft <= 1)
    assert.deepEqual(Object.keys(s.levels), ACTIONS)
  } finally {
    await viewer.close()
  }
})

test('after a touchdown the result shows for a moment, then a new booster drops on its own', async () => {
  const { viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    let s = await state()
    for (let i = 0; i < 200 && s.phase === 'flight'; i++) { await ctl('tick'); s = await state() }
    assert.equal(s.phase, 'landed')
    assert.equal(s.finished.ok, true)
    assert.ok(s.finished.crashSpeed <= 2)
    const episode = s.episode, hold = s.hold
    assert.ok(hold >= 3)
    await ctl('tick', { n: hold - 1 })
    assert.equal((await state()).phase, 'landed', 'the result stays up')
    await ctl('tick')
    s = await state()
    assert.equal(s.phase, 'flight')
    assert.equal(s.episode, episode + 1)
    assert.equal(s.fuel, 260)
  } finally {
    await viewer.close()
  }
})

test('the sliders override the dials, and an edit to lander.json resets them', async () => {
  const { ws, viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    await ctl('tick', { n: 4 })
    let s = await state()
    const share = s.fuel / s.tank
    await ctl('set', { key: 'gravity', value: 2.1 })
    await ctl('set', { key: 'fuel', value: 130 })
    await ctl('set', { key: 'title', value: 'not a dial' })
    s = await state()
    assert.equal(s.dials.gravity, 2.1)
    assert.equal(s.tank, 130)
    assert.ok(Math.abs(s.fuel / s.tank - share) < 1e-9, 'a new tank keeps the same share of fuel, so the gauge moves at once')
    assert.equal(s.title, 'Test Landing', 'only the listed dials can be set')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['fuel', 'gravity'])
    await ctl('set', { key: 'gravity', value: 9999 })
    assert.equal((await state()).dials.gravity, 5, 'out-of-range values are clamped')

    writeFileSync(join(ws, 'lander.json'), JSON.stringify({ ...CFG, gravity: 0.9 }))
    s = await until(state, (x) => x.dials.gravity === 0.9)
    assert.equal(s.dials.gravity, 0.9)
    assert.deepEqual(s.overrides, {})
    assert.equal(s.tank, 260)
  } finally {
    await viewer.close()
  }
})

test('a shove changes the fall, a leak drains the tank, a flame-out kills the engine, launch drops a new booster', async () => {
  const { viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    await ctl('tick', { n: 3 })
    let s = await state()
    await ctl('shove', { dv: -3 })
    let t = await state()
    assert.ok(Math.abs(t.v - (s.v - 3)) < 1e-9, 'a downdraft adds 3 to the fall')
    assert.equal(t.events.at(-1).e, 'shove')
    await ctl('shove', { dv: 3 })
    assert.ok(Math.abs((await state()).v - s.v) < 1e-9, 'an updraft takes it back')

    await ctl('leak', { share: 0.3 })
    t = await state()
    assert.ok(Math.abs(t.fuel - s.fuel * 0.7) < 1e-9)
    assert.equal(t.events.at(-1).e, 'leak')

    await ctl('flameout', { ticks: 4 })
    t = await state()
    assert.equal(t.flameout, 4)
    assert.match(t.stateText, /engine: OUT for 4 more ticks/)
    const fuel = t.fuel
    await ctl('tick', { n: 4 })
    t = await state()
    assert.equal(t.fuel, fuel, 'a dead engine burns nothing')
    assert.equal(t.fired, 0)
    assert.equal(t.flameout, 0)
    await ctl('tick')
    assert.match((await state()).stateText, /engine: OK/)

    const episode = t.episode
    await ctl('launch')
    t = await state()
    assert.equal(t.episode, episode + 1)
    assert.equal(t.phase, 'flight')
    assert.equal(t.fuel, 260)
  } finally {
    await viewer.close()
  }
})

test('a bad lander.json edit keeps the flight alive and reports the error', async () => {
  const { ws, viewer, state, ctl } = await freshViewer({ gravity: 1.5 })
  try {
    await ctl('pause')
    writeFileSync(join(ws, 'lander.json'), '{ "gravity": 2, oops')
    let s = await until(state, (x) => !!x.cfgError)
    assert.match(s.cfgError, /lander\.json/)
    assert.equal(s.dials.gravity, 1.5, 'the last good settings stay')
    const before = s.t
    await ctl('tick', { n: 40 })
    s = await state()
    assert.equal(s.t, before + 40, 'the flight keeps going')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(v.findings.some((f) => f.severity === 'error'))

    writeFileSync(join(ws, 'lander.json'), JSON.stringify({ ...CFG, gravity: 2 }))
    s = await until(state, (x) => !x.cfgError)
    assert.equal(s.cfgError, null)
    assert.equal(s.dials.gravity, 2)
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
    assert.doesNotMatch(reply, /"thrust"/)
  } finally {
    await viewer.close()
  }
})

test('the offline stand-in adds no randomness: a fast fall near the pad always gets a BURN', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  // The text the viewer wrote before the uplift. The old reader took a worse throttle in 11 of 400
  // answers at G 1.2 and 60 of 400 at G 3.0, for this same falling booster.
  const oldState = (g) => `Bring it down to the pad gently.
Telemetry (alt above pad, vertical speed, gravity, fuel remaining):
ALT 12.0 VY -4.0 G ${g.toFixed(2)} FUEL 80%
Which throttle do you set for this tick? ${ACTIONS.join(' / ')}`
  const ask = async (state, salt) => (await evaluate({ state, questions: { thrust: { type: 'choice', instructions: 'Which throttle do you set for this tick?', options: ACTIONS } }, salt })).answers.thrust
  for (const g of [1.2, 3.0]) {
    let wrong = 0
    for (let salt = 1; salt <= 400; salt++) if ((await ask(oldState(g), salt)).choice !== 'BURN') wrong++
    assert.equal(wrong, 0, `gravity label ${g}`)
  }
  const a = await ask(oldState(1.2), 1)
  assert.ok(a.confidence > 0.5 && a.confidence < 0.99, `clear favourite, never one-hot (${a.confidence})`)
  // High up and barely moving, it lets the booster fall.
  const high = await ask(oldState(1.2).replace('ALT 12.0 VY -4.0', 'ALT 78.0 VY -0.5'), 1)
  assert.ok(['CUT', 'COAST'].includes(high.choice), high.choice)
})

test('the difficulty dials: low gravity always lands, high gravity runs the tank dry; a small tank crashes', async () => {
  const run = async (over, flights = 20) => {
    const { viewer, state, ctl } = await freshViewer({ tickMs: 300, fuel: 60, ...over })
    try {
      await ctl('pause'); await ctl('reset')
      let s = await state()
      for (let i = 0; i < 60 && s.landed + s.crashed < flights; i++) { await ctl('tick', { n: 50 }); s = await state() }
      const f = s.flights.slice(-flights)
      return { landed: s.landed, crashed: s.crashed, meanTouchdown: Number((f.reduce((a, b) => a + b.speed, 0) / f.length).toFixed(2)), meanFuelLeft: Number((f.reduce((a, b) => a + b.fuelLeft, 0) / f.length).toFixed(1)) }
    } finally {
      await viewer.close()
    }
  }
  const easy = await run({ gravity: 1.0 }), mid = await run({ gravity: 1.6 }), hard = await run({ gravity: 2.3 })
  console.log('  gravity 1.0:', JSON.stringify(easy))
  console.log('  gravity 1.6:', JSON.stringify(mid))
  console.log('  gravity 2.3:', JSON.stringify(hard))
  assert.equal(easy.crashed, 0, 'at gravity 1.0 the stand-in must land every time')
  assert.equal(mid.crashed, 0)
  assert.ok(mid.meanFuelLeft < easy.meanFuelLeft - 8, 'more gravity burns more fuel')
  assert.ok(hard.crashed >= hard.landed * 3 && hard.crashed >= 12, `gravity 2.3 should mostly crash, got ${JSON.stringify(hard)}`)
  const small = await run({ gravity: 1.2, fuel: 22 }), roomy = await run({ gravity: 1.2, fuel: 60 })
  console.log('  tank 22    :', JSON.stringify(small))
  console.log('  tank 60    :', JSON.stringify(roomy))
  assert.equal(roomy.crashed, 0)
  assert.ok(small.crashed >= 15, `a tank of 22 cannot cover the descent, got ${JSON.stringify(small)}`)
  const beyond = await run({ gravity: 2.8, fuel: 400 }, 8)
  console.log('  gravity 2.8:', JSON.stringify(beyond))
  assert.equal(beyond.landed, 0, 'past 2.6 full burn cannot slow the booster at all')
})

test('every crash is an honest one: the tank was dry, or full burn could no longer stop it', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  const { sanitize, createWorld, step, stateText, stopDistance } = await import(join(HERE, '../viewer/sim.mjs'))
  const cfg = sanitize({ gravity: 2.15, fuel: 60 })
  const w = createWorld(cfg)
  let salt = 1, crashes = 0, unexplained = 0, wasDry = false, guard = 0
  while (w.landed + w.crashed < 40 && guard++ < 20000) {
    let action = 'CUT'
    if (w.phase === 'flight') {
      action = (await evaluate({ state: stateText(w, cfg), questions: { thrust: { type: 'choice', instructions: 'Which throttle do you set for this tick?', options: ACTIONS } }, salt: salt++ })).answers.thrust.choice
      wasDry = wasDry || w.fuel < 2.6
    }
    for (const e of step(w, cfg, action)) {
      if (e.e === 'crash') { crashes++; if (!wasDry) unexplained++ }
      if (e.e === 'launch') wasDry = false
    }
  }
  console.log(`  ${w.landed} landed, ${crashes} crashed, ${unexplained} crashes with fuel still in the tank`)
  assert.ok(crashes >= 5 && w.landed >= 1, 'gravity 2.15 sits on the edge: some land, some crash')
  assert.equal(unexplained, 0)
  assert.equal(stopDistance({ v: -4 }, sanitize({ gravity: 3 })), Infinity)
})
