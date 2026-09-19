// Viewer integration test for Jev Arena. Spins up the real viewer against a temp workspace and
// checks the loop: world parses, Jev decides, the board moves, the goal is reached, the verdict
// is written, and control commands work. The newer tests drive time with the `tick` control, so
// they never wait on a timer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const viewerPath = join(HERE, '../viewer/viewer.mjs')
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/arena.json'), 'utf8'))
const { arenaMock, readArena } = await import(join(ROOT, 'viewer/mock.mjs'))
const { sanitize, createWorld, observe } = await import(join(ROOT, 'viewer/sim.mjs'))

async function freshViewer(worldOverrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-arena-test-'))
  const world = {
    title: 'Test', size: 5, hero: { x: 0, y: 0 }, goal: { x: 4, y: 0 },
    walls: [], coins: [], rules: 'Reach the goal.', speed: 60, ...worldOverrides,
  }
  writeFileSync(join(ws, 'arena.json'), JSON.stringify(world))
  const { startArenaViewer } = await import(viewerPath)
  const viewer = await startArenaViewer({ workspace: ws, port: 0 })
  return { ws, viewer, world }
}

/** Boot paused and reset, so only `tick` moves time. */
async function boot(world) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-arena-test-'))
  writeFileSync(join(ws, 'arena.json'), JSON.stringify(world))
  const { startArenaViewer } = await import(viewerPath)
  const viewer = await startArenaViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const ctl = async (body) => { const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
  const state = async () => (await fetch(`${base}/state`)).json()
  await ctl({ cmd: 'pause' }); await ctl({ cmd: 'reset' })
  return { ws, viewer, base, ctl, state }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wallCount = (f) => f.walls.join('').split('#').length - 1

test('Jev Arena viewer drives a happy path well', async () => {
  const { ws, viewer, world } = await freshViewer()
  try {
    // Let it run a bit: it should move toward the goal and eventually reach it on a clear board.
    const deadline = Date.now() + 4000
    let reached = false
    let lastState
    while (Date.now() < deadline && !reached) {
      await new Promise((r) => setTimeout(r, 200))
      if (existsSync(join(ws, '.harness/verdict.json'))) {
        lastState = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
        if (String(lastState.summary).includes('reached goal yes')) reached = true
      }
    }
    assert.ok(reached, `expected Jev to reach the goal on an open board; summary was ${lastState?.summary}`)
    assert.ok(lastState.ready, 'verdict should be ready once reached')
    assert.ok(lastState.phases?.length, 'verdict should carry phases')
    void world
  } finally {
    await viewer.close()
  }
})

test('Jev Arena writes a verdict and updates it', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await new Promise((r) => setTimeout(r, 300))
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases) && v.phases.length)
  } finally {
    await viewer.close()
  }
})

test('check.mjs accepts a small world while the viewer runs', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const out = execFileSync('node', [join(HERE, '../toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' })
    assert.ok(out.includes('ok'))
  } finally {
    await viewer.close()
  }
})

test('Jev Arena control: pause, start, reset', async () => {
  const { viewer } = await freshViewer()
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
    assert.equal(await ctl('step'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

test('Jev answers four questions per call, and the full spread reaches the pane', async () => {
  const v = await boot(TEMPLATE)
  try {
    // The call counter lives in jev.mjs and is shared by every viewer in this process, so count the change.
    const callsBefore = (await (await fetch(`${v.base}/jev`)).json()).calls
    await v.ctl({ cmd: 'tick', n: 3 })
    const s = await v.state()
    assert.equal(s.state.moves, 3)
    const last = s.frame.last
    const sum = Object.values(last.probabilities).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, 'move probabilities add up to 1')
    assert.ok(Math.max(...Object.values(last.probabilities)) < 0.999, 'never one-hot')
    assert.equal(Object.keys(last.probabilities).length, 5)
    assert.ok(last.confidence > 0 && last.confidence < 1)
    assert.ok(Array.isArray(s.frame.plan) && s.frame.plan.length > 0, 'the route the step counts point along is in the frame')
    const jev = await (await fetch(`${v.base}/jev`)).json()
    assert.equal(jev.calls - callsBefore, 3)
    assert.deepEqual(jev.last.questions.map((q) => q.id), ['move', 'heading', 'sure', 'boxed_in'])
    assert.ok(jev.costUsd > 0)
  } finally { await v.viewer.close() }
})

test('arena.json really takes effect, pane overrides work, and a file edit resets them', async () => {
  const v = await boot({ ...TEMPLATE, title: 'Night Shift', width: 9, height: 7, hero: { x: 0, y: 0 }, goal: { x: 8, y: 6 }, walls: [{ x: 4, y: 3 }], coins: [{ x: 2, y: 2 }], sight: 3, speed: 450, remix: false, seed: 42 })
  try {
    let s = await v.state()
    assert.equal(s.world.title, 'Night Shift')
    assert.equal(s.world.width, 9); assert.equal(s.world.height, 7)
    assert.equal(s.world.sight, 3); assert.equal(s.world.speed, 450); assert.equal(s.world.remix, false); assert.equal(s.world.seed, 42)
    assert.deepEqual(s.world.walls, [{ x: 4, y: 3 }])
    assert.equal(s.frame.w, 9); assert.equal(s.frame.sight, 3)
    assert.match(s.frame.stateText, /You see 3 cells around you/)
    await v.ctl({ cmd: 'set', key: 'sight', value: 99 })
    await v.ctl({ cmd: 'set', key: 'speed', value: 120 })
    s = await v.state()
    assert.equal(s.frame.sight, 99); assert.equal(s.frame.speed, 120)
    assert.match(s.frame.stateText, /You can see the whole board/)
    assert.ok(s.frame.seen.every((row) => !row.includes('0')), 'whole board seen')
    writeFileSync(join(v.ws, 'arena.json'), JSON.stringify({ ...TEMPLATE, title: 'Edited', sight: 5 }))
    await sleep(250)
    s = await v.state()
    assert.equal(s.world.title, 'Edited')
    assert.equal(s.frame.sight, 5, 'the file wins again after an edit')
    assert.deepEqual(s.frame.overrides, {})
  } finally { await v.viewer.close() }
})

test('a person can build and break walls, drop coins and move the goal', async () => {
  const v = await boot({ size: 7, hero: { x: 0, y: 0 }, goal: { x: 6, y: 6 }, walls: [], coins: [], sight: 99, speed: 200 })
  try {
    let r = await v.ctl({ cmd: 'wall', x: 3, y: 3 })
    assert.equal(r.json.ok, true)
    let f = (await v.state()).frame
    assert.equal(f.walls[3][3], '#')
    assert.equal((await v.ctl({ cmd: 'wall', x: 3, y: 3 })).json.ok, true)
    f = (await v.state()).frame
    assert.equal(f.walls[3][3], '.', 'a second click breaks it')
    assert.equal((await v.ctl({ cmd: 'wall', x: 0, y: 0 })).json.ok, false, 'not on the hero')
    assert.equal((await v.ctl({ cmd: 'wall', x: 6, y: 6 })).json.ok, false, 'not on the goal')
    assert.equal((await v.ctl({ cmd: 'wall', x: 70, y: 1 })).json.ok, false, 'not off the board')
    assert.equal((await v.ctl({ cmd: 'coin', x: 2, y: 0 })).json.ok, true)
    f = (await v.state()).frame
    assert.deepEqual(f.coins, [[2, 0]])
    assert.equal(f.heading, 'coin')
    await v.ctl({ cmd: 'tick', n: 2 })
    f = (await v.state()).frame
    assert.equal(f.coinsCollected, 1, 'Jev went for the dropped coin first')
    assert.deepEqual(f.last.coin, [2, 0])
    assert.equal((await v.ctl({ cmd: 'goal', x: 4, y: 0 })).json.ok, true)
    f = (await v.state()).frame
    assert.deepEqual(f.goal, [4, 0])
    await v.ctl({ cmd: 'tick', n: 2 })
    f = (await v.state()).frame
    assert.equal(f.status, 'won', 'the goal was dragged next to Jev')
  } finally { await v.viewer.close() }
})

test('every control command answers 200, tick takes n, and junk is turned away', async () => {
  const v = await boot(TEMPLATE)
  try {
    for (const body of [{ cmd: 'pause' }, { cmd: 'start' }, { cmd: 'pause' }, { cmd: 'tick' }, { cmd: 'tick', n: 500 }, { cmd: 'step' }, { cmd: 'remix' }, { cmd: 'set', key: 'density', value: 0.2 }, { cmd: 'reset' }]) {
      const r = await v.ctl(body)
      assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(r.json.ok, true, JSON.stringify(body))
    }
    assert.equal((await v.ctl({ cmd: 'nope' })).json.ok, false)
    assert.equal((await v.ctl({ cmd: 'set', key: 'title', value: 'x' })).json.ok, false, 'only the dials can be set')
    const bad = await fetch(`${v.base}/control`, { method: 'POST', body: '{nope' })
    assert.equal(bad.status, 400)
    await v.ctl({ cmd: 'tick', n: 500 })
    const s = await v.state()
    assert.ok(s.frame.totals.decisions >= 300, `500 ticks ran (${s.frame.totals.decisions} decisions)`)
  } finally { await v.viewer.close() }
})

test('the New layout button and the walls dial build a fresh seeded layout', async () => {
  const v = await boot(TEMPLATE)
  try {
    const a = (await v.state()).frame
    assert.equal(wallCount(a), TEMPLATE.walls.length)
    await v.ctl({ cmd: 'remix' })
    const b = (await v.state()).frame
    assert.equal(b.episode, 1)
    assert.notDeepEqual(b.walls, a.walls)
    assert.equal(wallCount(b), TEMPLATE.walls.length, 'same number of walls as the file')
    assert.equal(b.coins.length, TEMPLATE.coins.length)
    await v.ctl({ cmd: 'set', key: 'density', value: 0.1 })
    const c = (await v.state()).frame
    assert.equal(wallCount(c), Math.round(0.1 * c.w * c.h))
    // the same seed gives the same layout again
    const w1 = createWorld(sanitize(TEMPLATE), 3, { x: 2, y: 2 }), w2 = createWorld(sanitize(TEMPLATE), 3, { x: 2, y: 2 })
    assert.deepEqual([...w1.wall], [...w2.wall]); assert.deepEqual(w1.coins, w2.coins); assert.deepEqual(w1.goal, w2.goal)
  } finally { await v.viewer.close() }
})

test('it never ends: a short banner, then a fresh layout, and the hero carries on from where it stands', async () => {
  const v = await boot({ size: 6, hero: { x: 0, y: 0 }, goal: { x: 3, y: 0 }, walls: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 3 }], coins: [{ x: 1, y: 0 }], sight: 99, speed: 1000 })
  try {
    await v.ctl({ cmd: 'tick', n: 3 })
    let f = (await v.state()).frame
    assert.equal(f.status, 'won')
    assert.deepEqual(f.result, { status: 'won', moves: 3, par: 3, coins: 1, coinsTotal: 1 })
    assert.equal(f.totals.goals, 1)
    await v.ctl({ cmd: 'tick', n: 2 })
    assert.equal((await v.state()).frame.status, 'won', 'the result stays up for about three seconds')
    await v.ctl({ cmd: 'tick', n: 1 })
    f = (await v.state()).frame
    assert.equal(f.status, 'play'); assert.equal(f.episode, 1)
    assert.deepEqual(f.hero, [3, 0], 'no teleport')
    assert.notDeepEqual(f.goal, [3, 0])
    await v.ctl({ cmd: 'tick', n: 40 })
    assert.ok((await v.state()).frame.totals.goals >= 2, 'and it keeps reaching goals')
  } finally { await v.viewer.close() }
})

test('remix false replays the designed world from its start', async () => {
  const v = await boot({ size: 6, hero: { x: 0, y: 0 }, goal: { x: 2, y: 0 }, walls: [{ x: 3, y: 3 }], coins: [], sight: 99, speed: 1500, remix: false })
  try {
    await v.ctl({ cmd: 'tick', n: 4 })
    const f = (await v.state()).frame
    assert.equal(f.episode, 1); assert.equal(f.status, 'play')
    assert.deepEqual(f.hero, [0, 0]); assert.deepEqual(f.goal, [2, 0]); assert.equal(f.walls[3][3], '#')
  } finally { await v.viewer.close() }
})

test('a wall straight ahead does not freeze Jev, and being walled in ends the run', async () => {
  // The general stand-in in jev.mjs waits for ever here (the goal is straight ahead behind a wall).
  const v = await boot({ size: 5, hero: { x: 0, y: 0 }, goal: { x: 4, y: 0 }, walls: [{ x: 1, y: 0 }], coins: [], sight: 99, speed: 1500 })
  try {
    await v.ctl({ cmd: 'tick', n: 6 })
    let f = (await v.state()).frame
    assert.equal(f.status, 'won'); assert.equal(f.result.moves, 6)
    await v.ctl({ cmd: 'reset' })
    for (const [x, y] of [[3, 0], [3, 1], [4, 1]]) await v.ctl({ cmd: 'wall', x, y })
    f = (await v.state()).frame
    assert.equal(f.status, 'stuck', 'Jev sees the whole board, so it knows at once')
    assert.equal(f.heading, 'none')
    await v.ctl({ cmd: 'tick', n: 3 })
    f = (await v.state()).frame
    assert.equal(f.status, 'play', 'a fresh layout follows')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((x) => /walled in/.test(x.message)))
  } finally { await v.viewer.close() }
})

test('a broken arena.json keeps the demo alive and reports the problem', async () => {
  const v = await boot(TEMPLATE)
  try {
    writeFileSync(join(v.ws, 'arena.json'), '{ "title": "oops", ')
    await sleep(250)
    let s = await v.state()
    assert.match(s.frame.cfgError, /arena\.json/)
    assert.equal(s.frame.title, TEMPLATE.title, 'still on the last good world')
    const before = s.frame.totals.decisions
    await v.ctl({ cmd: 'tick', n: 5 })
    s = await v.state()
    assert.equal(s.frame.totals.decisions, before + 5)
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false)
    assert.ok(verdict.findings.some((x) => x.severity === 'error'))
    writeFileSync(join(v.ws, 'arena.json'), JSON.stringify({ ...TEMPLATE, title: 'Fixed' }))
    await sleep(250)
    s = await v.state()
    assert.equal(s.frame.cfgError, null); assert.equal(s.frame.title, 'Fixed')
  } finally { await v.viewer.close() }
})

test('the viewer is loopback only', async () => {
  const v = await boot(TEMPLATE)
  try {
    const port = Number(new URL(v.base).port)
    const status = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => { buf += d })
      sock.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])))
      sock.on('error', () => resolve(0))
    })
    assert.equal(status, 403)
    assert.equal((await fetch(`${v.base}/studio.js`)).status, 200)
    assert.equal((await fetch(`${v.base}/viewer.mjs`)).status, 404, 'only the pane files are served')
  } finally { await v.viewer.close() }
})

test('the dial is honest: with the whole board in sight Jev walks the shortest way, with one cell of sight it wastes steps in dead ends', async () => {
  const run = async (sight) => {
    const v = await boot({ ...TEMPLATE, sight, speed: 2000 })
    try {
      await v.ctl({ cmd: 'set', key: 'density', value: 0.36 })
      await v.ctl({ cmd: 'tick', n: 2500 })
      const t = (await v.state()).frame.totals
      return { goals: t.goals, score: t.wonPar / t.wonMoves, wasted: (t.wonMoves - t.wonPar) / t.goals, results: t.results }
    } finally { await v.viewer.close() }
  }
  const easy = await run(99), hard = await run(1)
  console.log(`sight all: ${easy.goals} goals, score ${easy.score.toFixed(3)}, ${easy.wasted.toFixed(1)} wasted steps a run · sight 1: ${hard.goals} goals, score ${hard.score.toFixed(3)}, ${hard.wasted.toFixed(1)} wasted steps a run`)
  assert.ok(easy.goals >= 20 && hard.goals >= 20, 'both keep reaching goals')
  assert.ok(easy.score > 0.97, `easy score ${easy.score}`)
  assert.ok(hard.score < easy.score - 0.08, `hard ${hard.score} vs easy ${easy.score}`)
  assert.ok(easy.wasted < 2 && hard.wasted > 4 * Math.max(1, easy.wasted), `wasted steps: easy ${easy.wasted}, hard ${hard.wasted}`)
  assert.ok(easy.goals > hard.goals, 'and the same number of decisions reaches more goals')
})

test('the stand-in reads only the text Jev gets', () => {
  const text = [
    'You are @ on a grid.', '@.#', '..G',
    'You are at (0,0). The goal is at (2,1). Coins left: 0.', 'Your last move: wait.',
    'Steps to the nearest coin after each move: no coins left.',
    'Steps to the goal after each move, counting ? as open: up wall, down 2, left wall, right 4, wait 3.',
  ].join('\n')
  const a = arenaMock(text, 'move', { options: ['up', 'down', 'left', 'right', 'wait'] }, 1)
  assert.equal(a.choice, 'down')
  assert.ok(a.probabilities.down > 0.6 && a.probabilities.down < 0.95)
  assert.ok(a.probabilities.up < 0.01, 'walls get almost nothing')
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 1e-9)
  assert.equal(readArena(text).heading, 'goal')
  assert.equal(arenaMock('no grid here', 'move', { options: ['up'] }, 1), null, 'anything else falls through to the general stand-in')
  // what the sim writes is what the reader reads
  const cfg = sanitize(TEMPLATE), w = createWorld(cfg, 0)
  const o = observe(w, cfg)
  assert.equal(readArena(o.text).heading, o.heading)
  assert.ok(!o.text.includes('undefined') && o.text.split('\n').filter((l) => /^[.#$G@?]+$/.test(l)).length === cfg.h)
})

test('check.mjs accepts the template and rejects bad values', () => {
  const runCheck = (world) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-arena-check-'))
    writeFileSync(join(ws, 'arena.json'), JSON.stringify(world))
    try { return { code: 0, out: execFileSync('node', [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { code: e.status, out: String(e.stderr) } }
  }
  assert.equal(runCheck(TEMPLATE).code, 0)
  assert.equal(runCheck({ ...TEMPLATE, sight: 0 }).code, 1)
  assert.equal(runCheck({ ...TEMPLATE, width: 64 }).code, 1)
  assert.equal(runCheck({ ...TEMPLATE, speed: 5 }).code, 1)
  assert.match(runCheck({ ...TEMPLATE, walls: [...TEMPLATE.walls, TEMPLATE.goal] }).out, /inside a wall/)
  assert.match(runCheck({ size: 4, hero: { x: 0, y: 0 }, goal: { x: 3, y: 3 }, walls: [{ x: 2, y: 3 }, { x: 3, y: 2 }], rules: 'x' }).out, /cut the goal off/)
})
