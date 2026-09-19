// Viewer integration test for Jev Slalom. Spins up the real viewer against a temp workspace and
// checks the loop: the skier descends, Jev steers, the verdict updates, the pane's controls change
// what Jev faces, a bad edit never kills the course, and the speed dial is honest.
// Time is driven with the `tick` control, so nothing here waits on the sim's own timer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Run', instrument: 'SLALOM', tickMs: 100, speed: 2.0, gates: 10, valleyWidth: 18,
  style: 'Thread the gates.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-slalom-test-'))
  writeFileSync(join(ws, 'slalom.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startSlalomViewer } = await import(viewerPath)
  const viewer = await startSlalomViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

/** A paused viewer plus helpers, so a test moves time only with `tick`. */
async function boot(overrides = {}) {
  const { ws, viewer } = await freshViewer(overrides)
  const ctl = async (body) => (await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  await ctl({ cmd: 'pause' })
  return { ws, viewer, ctl, state }
}
/** Poll for something the file watcher does (that is the OS, not the sim clock). */
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(40) } return false }

test('Jev Slalom descends and Jev steers', async () => {
  const { viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 2500
    let saw = false
    while (Date.now() < deadline) {
      await wait(120)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.history.length >= 3) {
        assert.ok(['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST'].includes(s.move))
        assert.ok(typeof s.x === 'number')
        assert.ok(typeof s.rows === 'number')
        assert.ok(Array.isArray(s.gates) && s.gates.length === 10)
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the skier to descend and Jev to steer')
  } finally {
    await viewer.close()
  }
})

test('Jev Slalom writes a progressive verdict', async () => {
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

test('Jev Slalom control commands answer 200', async () => {
  const { viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'gust', 'slowmo', 'plant']) assert.equal(await ctl(cmd), 200, cmd)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const v = await boot({ speed: 1.7, gates: 7, valleyWidth: 22, gateGap: 4.5 })
  try {
    const s = await v.state()
    assert.equal(s.speed, 1.7); assert.equal(s.valleyWidth, 22); assert.equal(s.gateGap, 4.5); assert.equal(s.gatesTotal, 7)
    assert.ok(s.gates.every((g) => g.gap === 4.5)); assert.equal(s.title, 'Test Run')
    const auto = await boot()
    try { assert.equal((await auto.state()).gateGap, 6, 'without gateGap the course keeps its old gap') } finally { await auto.viewer.close() }
  } finally { await v.viewer.close() }
})

test('tick takes a count, carries probabilities, and never stops at a finished run', async () => {
  const v = await boot({ gates: 3 })
  try {
    assert.equal((await v.ctl({ cmd: 'tick', n: 500 })).ok, true)
    const s = await v.state()
    assert.ok(s.session.decisions > 150, `decisions ${s.session.decisions}`) // the rest of the 500 ticks held finished runs on screen
    assert.ok(s.session.runs >= 5, `runs ${s.session.runs}`)
    assert.ok(s.episode >= 5, 'a new run starts on its own')
    const total = Object.values(s.probs).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(total - 1) < 0.01, 'the frame carries the full distribution')
    assert.ok(s.conf > 0 && s.conf < 1)
  } finally { await v.viewer.close() }
})

test('sliders override the file, and an edit to slalom.json clears them', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'set', key: 'speed', value: 3.3 })
    await v.ctl({ cmd: 'set', key: 'gateGap', value: 3 })
    let s = await v.state()
    assert.equal(s.speed, 3.3); assert.equal(s.gateGap, 3)
    assert.ok(s.gates.filter((g) => !g.passed).every((g) => g.gap === 3), 'gates ahead are re-cut at once')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['gateGap', 'speed'])
    await v.ctl({ cmd: 'set', key: 'speed', value: 99 })
    assert.equal((await v.state()).speed, 6, 'clamped to the dial range')
    assert.equal((await v.ctl({ cmd: 'set', key: 'gates', value: 1 })).ok, false, 'only dials can be set')
    writeFileSync(join(v.ws, 'slalom.json'), JSON.stringify({ ...CFG, speed: 1.5 }))
    assert.ok(await until(async () => (await v.state()).speed === 1.5), 'the edit wins')
    s = await v.state()
    assert.deepEqual(s.overrides, {}); assert.equal(s.gateGap, 6)
  } finally { await v.viewer.close() }
})

test('a planted gate, a gust and slow motion change what Jev faces', async () => {
  const v = await boot()
  try {
    let s = await v.state()
    const first = s.gates[0]
    assert.equal((await v.ctl({ cmd: 'plant', x: 9, y: 2 })).ok, false, 'too close to the skier')
    assert.equal((await v.ctl({ cmd: 'plant', x: 9, y: first.y + 2 })).ok, false, 'too close to another gate')
    assert.equal((await v.ctl({ cmd: 'plant', x: 9, y: first.y - 6 })).ok, true)
    s = await v.state()
    assert.equal(s.gates.length, 11); assert.equal(s.gatesTotal, 11); assert.equal(s.session.planted, 1)
    assert.equal(s.gates[0].planted, true, 'the planted gate is now the next gate')
    assert.equal(s.gates[0].x, 9)
    await v.ctl({ cmd: 'tick' })
    assert.match((await v.state()).stateText, /Next gate: x 9\.0/, 'Jev is told about the planted gate')
    const x0 = (await v.state()).x
    await v.ctl({ cmd: 'gust', dir: 1 })
    assert.ok((await v.state()).gust >= 1)
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    const moved = s.x - x0, steer = s.nudge[s.move]
    assert.ok(moved - steer >= 0.99, `the wind pushed the skier ${(moved - steer).toFixed(2)} slots past its own steer`)
    await v.ctl({ cmd: 'tick', n: 8 })
    assert.equal((await v.state()).gust, 0, 'the gust dies down')
    const base = (await v.state()).tickMs
    await v.ctl({ cmd: 'slowmo' })
    s = await v.state()
    assert.equal(s.slowmo, true); assert.equal(s.tickMs, base * 3)
    await v.ctl({ cmd: 'reset' })
    s = await v.state()
    assert.equal(s.slowmo, false); assert.equal(s.session.decisions, 0); assert.equal(s.step, 0); assert.equal(s.gates.length, 10)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the course alive and reports the problem', async () => {
  const v = await boot({ speed: 1.8 })
  try {
    writeFileSync(join(v.ws, 'slalom.json'), '{ "title": "oops", ')
    assert.ok(await until(async () => (await v.state()).cfgError), 'the error is reported')
    await v.ctl({ cmd: 'tick', n: 20 })
    const s = await v.state()
    assert.match(String(s.cfgError), /slalom\.json/)
    assert.equal(s.speed, 1.8, 'still on the last good config')
    assert.ok(s.session.decisions >= 20, 'still deciding')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(join(v.ws, 'slalom.json'), JSON.stringify({ ...CFG, speed: 1.9 }))
    assert.ok(await until(async () => (await v.state()).cfgError === null), 'a good edit clears it')
    assert.equal((await v.state()).speed, 1.9)
    const res = await fetch(`${v.viewer.url}/control`, { method: 'POST', body: '{ nope' })
    assert.equal(res.status, 400, 'a bad control body is refused, not fatal')
    assert.equal((await v.ctl({ cmd: 'tick' })).ok, true)
  } finally { await v.viewer.close() }
})

test('the viewer is loopback only', async () => {
  const v = await boot()
  try {
    const port = Number(new URL(v.viewer.url).port)
    const status = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => { buf += d })
      sock.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])))
      sock.on('error', () => resolve(0))
    })
    assert.equal(status, 403)
  } finally { await v.viewer.close() }
})

test('the dial is honest: a calm descent is clean, a fast one falls at the second gate', async () => {
  const run = async (speed) => {
    const v = await boot({ speed, gates: 18 })
    try { await v.ctl({ cmd: 'tick', n: 1500 }); return (await v.state()).session } finally { await v.viewer.close() }
  }
  const easy = await run(1.6), hard = await run(3.6)
  assert.ok(easy.runs >= 5 && hard.runs >= 5, 'Jev races in both')
  assert.equal(easy.cleanRuns, easy.runs, `easy: ${easy.cleanRuns} clean of ${easy.runs}`)
  assert.equal(hard.cleanRuns, 0, `hard: ${hard.cleanRuns} clean of ${hard.runs}`)
  const e = easy.gatesPassed / easy.gatesFaced, h = hard.gatesPassed / hard.gatesFaced
  assert.ok(e > 0.95 && h < 0.6, `gates threaded easy ${e.toFixed(2)} vs hard ${h.toFixed(2)}`)
  assert.ok(easy.bestGates > hard.bestGates, `best run easy ${easy.bestGates} vs hard ${hard.bestGates}`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const tpl = JSON.parse(readFileSync(join(HERE, '../template/slalom.json'), 'utf8'))
  const run = (cfg) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-slalom-check-'))
    writeFileSync(join(ws, 'slalom.json'), JSON.stringify(cfg))
    try { return execFileSync(process.execPath, [join(HERE, '../toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) }
    catch (e) { return String(e.stdout) }
  }
  assert.match(run(tpl), /ok\s+slalom\.json is valid/)
  assert.match(run({ ...tpl, gateGap: 4 }), /ok\s+slalom\.json is valid/)
  assert.match(run({ ...tpl, gates: 999 }), /gates should be/)
  assert.match(run({ ...tpl, gateGap: 40 }), /gateGap/)
})
