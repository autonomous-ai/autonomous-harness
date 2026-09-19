// Viewer integration test for Jev Pong. Spins up the real viewer against a temp workspace and
// checks the loop: the court ticks and the ball moves, Jev forms a defensive move, the verdict
// updates, control commands answer, a bad edit is survived, only loopback is served, and the
// difficulty dial is honest. Time is driven with the `tick` control, never with sleeps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')
const MOVES = ['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST']

const CFG = {
  title: 'Test Pong', instrument: 'PONG', courtW: 200, courtH: 120, paddleH: 26, ballR: 3,
  speed: 6, maxSpeed: 3, accel: 0.5, topSpeed: 14, stepMs: 40,
  style: 'Keep the rally alive.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-pong-test-'))
  writeFileSync(join(ws, 'pong.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startPongViewer } = await import(viewerPath)
  const viewer = await startPongViewer({ workspace: ws, port: 0 })
  const port = viewer.url.split(':').pop()
  const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json()
  const ctl = async (cmd, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
    return res.status
  }
  return { ws, viewer, port, state, ctl }
}

/** Poll /state until `ok(state)` holds. Only used to wait for the file watcher, never for the game. */
async function until(state, ok, ms = 4000) {
  const deadline = Date.now() + ms
  let s = await state()
  while (!ok(s) && Date.now() < deadline) { await wait(40); s = await state() }
  return s
}

test('Jev Pong ticks and Jev forms a defensive move', async () => {
  const { viewer, port } = await freshViewer()
  try {
    const deadline = Date.now() + 3000
    let saw = false
    while (Date.now() < deadline) {
      await wait(150)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.step >= 3 && s.history.length > 0) {
        assert.ok(MOVES.includes(s.lastMove))
        assert.ok(typeof s.ball.x === 'number' && typeof s.ball.y === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the court to tick and Jev to move')
  } finally {
    await viewer.close()
  }
})

test('Jev Pong writes a progressive verdict', async () => {
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

test('Jev Pong control commands answer 200', async () => {
  const { viewer, ctl } = await freshViewer()
  try {
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'burst', 'serve']) assert.equal(await ctl(cmd), 200, cmd)
    assert.equal(await ctl('tick', { n: 25 }), 200)
    assert.equal(await ctl('set', { key: 'speed', value: 9 }), 200)
    assert.equal(await ctl('shove', { x: 100, y: 10 }), 200)
    assert.equal(await ctl('no-such-command'), 200)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const { viewer, state, ctl } = await freshViewer({ speed: 9.5, paddleH: 34, maxSpeed: 1.5, title: 'Nine and a half' })
  try {
    await ctl('pause')
    const s = await state()
    assert.equal(s.title, 'Nine and a half')
    assert.equal(s.speed, 9.5)
    assert.equal(s.dials.speed, 9.5)
    assert.equal(s.dials.maxSpeed, 1.5)
    assert.equal(s.court.paddleH, 34)
    assert.equal(Math.abs(s.ball.vx), 9.5, 'the ball is served at the configured pace')
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
    assert.ok(s.decision.reach >= 0 && s.decision.reach <= 1)
    assert.deepEqual(Object.keys(s.ghosts), MOVES)
    assert.ok(s.intercept === null || typeof s.intercept.y === 'number')
  } finally {
    await viewer.close()
  }
})

test('the sliders override the dials, and an edit to pong.json resets them', async () => {
  const { ws, viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    await ctl('set', { key: 'speed', value: 17 })
    await ctl('set', { key: 'maxSpeed', value: 4.5 })
    await ctl('set', { key: 'paddleH', value: 40 })
    await ctl('set', { key: 'title', value: 'not a dial' })
    let s = await state()
    assert.equal(s.dials.speed, 17)
    assert.equal(s.dials.maxSpeed, 4.5)
    assert.equal(s.court.paddleH, 40)
    assert.equal(s.title, 'Test Pong', 'only the listed dials can be set')
    assert.equal(Math.abs(s.ball.vx), 17, 'a new pace reaches the ball at once')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['maxSpeed', 'paddleH', 'speed'])
    await ctl('set', { key: 'speed', value: 9999 })
    assert.equal((await state()).dials.speed, 60, 'out-of-range values are clamped')

    writeFileSync(join(ws, 'pong.json'), JSON.stringify({ ...CFG, speed: 7 }))
    s = await until(state, (x) => x.dials.speed === 7)
    assert.equal(s.dials.speed, 7)
    assert.deepEqual(s.overrides, {})
    assert.equal(s.dials.maxSpeed, 3)
  } finally {
    await viewer.close()
  }
})

test('shove bends the ball, burst makes it faster, serve throws a new ball', async () => {
  const { viewer, state, ctl } = await freshViewer()
  try {
    await ctl('pause')
    await ctl('tick', { n: 30 }) // past the serve hold, the ball is in play
    let s = await state()
    assert.equal(s.phase, 'play')
    await ctl('shove', { x: s.ball.x, y: 0 })
    let t = await state()
    assert.ok(t.ball.vy < 0, 'a shove toward the top sends the ball up')
    assert.equal(t.events.at(-1).e, 'shove')
    await ctl('shove', { x: s.ball.x, y: 120 })
    t = await state()
    assert.ok(t.ball.vy > 0, 'a shove toward the bottom sends the ball down')
    assert.equal(Math.abs(t.ball.vx), Math.abs(s.ball.vx), 'a shove does not change the pace')

    const pace = t.speedNow, rally = t.rally
    await ctl('burst', { n: 4 })
    t = await state()
    assert.equal(t.rally, rally + 4)
    assert.ok(t.speedNow > pace, `pace ${t.speedNow} should beat ${pace}`)
    assert.equal(t.events.at(-1).e, 'burst')

    const episode = t.episode
    await ctl('serve')
    t = await state()
    assert.equal(t.episode, episode + 1)
    assert.equal(t.phase, 'serve')
    assert.equal(t.rally, 0)
  } finally {
    await viewer.close()
  }
})

test('a bad pong.json edit keeps the rally alive and reports the error', async () => {
  const { ws, viewer, state, ctl } = await freshViewer({ speed: 8 })
  try {
    await ctl('pause')
    writeFileSync(join(ws, 'pong.json'), '{ "speed": 12, oops')
    let s = await until(state, (x) => !!x.cfgError)
    assert.match(s.cfgError, /pong\.json/)
    assert.equal(s.dials.speed, 8, 'the last good court stays')
    const before = s.step
    await ctl('tick', { n: 40 })
    s = await state()
    assert.equal(s.step, before + 40, 'the rally keeps going')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(v.findings.some((f) => f.severity === 'error'))

    writeFileSync(join(ws, 'pong.json'), JSON.stringify({ ...CFG, speed: 12 }))
    s = await until(state, (x) => !x.cfgError)
    assert.equal(s.cfgError, null)
    assert.equal(s.dials.speed, 12)
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
    assert.doesNotMatch(reply, /"ball"/)
  } finally {
    await viewer.close()
  }
})

test('the offline stand-in reads the ball (it used to guess blind)', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  // The text the viewer wrote before the uplift. The old reader never matched it.
  const oldState = (by, py) => `Keep the rally alive.
A paddle on the left wall (centre y ${py.toFixed(1)}, half-height 13) defends a 200×120 court.
ball: x 100.0  y ${by.toFixed(1)}  vx -6.0  vy 0.0  (toward you)
speed: 6.0   hardness: 0.25
Move the paddle to meet the ball when it crosses your wall. Be decisive.`
  const ask = async (state) => (await evaluate({ state, questions: { move: { type: 'choice', instructions: 'Which paddle move keeps the rally alive?', options: MOVES } }, salt: 3 })).answers.move
  const down = await ask(oldState(100, 20)), up = await ask(oldState(20, 100)), hold = await ask(oldState(60, 60))
  assert.match(down.choice, /^MOVE_DOWN/)
  assert.match(up.choice, /^MOVE_UP/)
  assert.equal(hold.choice, 'HOLD')
  assert.ok(down.confidence > 0.5 && up.confidence > 0.5, 'a clear-cut state must not read as a coin toss')
  assert.ok(down.confidence < 0.99, 'never one-hot')
})

test('the difficulty dial: a slow ball is never missed, a fast ball is, and the ramp ends every rally', async () => {
  const run = async (over, ticks) => {
    const { viewer, state, ctl } = await freshViewer({ maxSpeed: 2, topSpeed: 40, ...over })
    try {
      await ctl('pause'); await ctl('reset')
      await ctl('tick', { n: ticks })
      const s = await state()
      const mean = s.rallies.length ? s.rallies.reduce((a, r) => a + r.n, 0) / s.rallies.length : Infinity
      return { misses: s.misses, returns: s.returns, best: s.bestRally, mean }
    } finally {
      await viewer.close()
    }
  }
  // No ramp: the pace is the only thing that changes.
  const slow = await run({ accel: 0, speed: 5 }, 2500)
  const fast = await run({ accel: 0, speed: 30 }, 2500)
  console.log('  accel 0  speed 5 :', JSON.stringify(slow))
  console.log('  accel 0  speed 30:', JSON.stringify(fast))
  assert.equal(slow.misses, 0, 'at pace 5 the stand-in must not miss')
  assert.ok(slow.returns >= 25)
  assert.ok(fast.misses >= 15, `at pace 30 the paddle is outrun, got ${fast.misses} misses`)
  // With the ramp on, the start pace sets how long a rally lasts.
  const easy = await run({ accel: 1, speed: 3 }, 4000)
  const hard = await run({ accel: 1, speed: 20 }, 4000)
  console.log('  accel 1  speed 3 :', JSON.stringify(easy))
  console.log('  accel 1  speed 20:', JSON.stringify(hard))
  assert.ok(easy.mean >= hard.mean * 2, `easy rallies (${easy.mean}) should be at least twice as long as hard ones (${hard.mean})`)
  assert.ok(hard.misses >= easy.misses * 2)
})

test('every miss is an honest one: the ball was out of the paddle\'s reach', async () => {
  const { evaluate } = await import(join(HERE, '../toolchain/jev.mjs'))
  const { sanitize, createWorld, step, stateText, predict } = await import(join(HERE, '../viewer/sim.mjs'))
  const cfg = sanitize({ speed: 18 })
  const w = createWorld(cfg)
  let salt = 1, last = predict(w, cfg), misses = 0, unforced = 0
  for (let i = 0; i < 4000; i++) {
    let move = 'HOLD'
    if (w.phase !== 'missed') {
      const res = await evaluate({ state: stateText(w, cfg), questions: { move: { type: 'choice', instructions: 'Which paddle move gets you to the ball in time?', options: MOVES } }, salt: salt++ })
      move = res.answers.move.choice
    }
    for (const e of step(w, cfg, move)) {
      if (e.e === 'hit' || e.e === 'serve') last = predict(w, cfg)
      if (e.e === 'miss') { misses++; if (last && last.reach - last.need > 2 * cfg.maxSpeed) unforced++ }
    }
    if (w.phase === 'serve') last = predict(w, cfg)
  }
  console.log(`  ${misses} misses, ${unforced} of them with the ball still in reach`)
  assert.ok(misses > 10)
  assert.equal(unforced, 0)
})
