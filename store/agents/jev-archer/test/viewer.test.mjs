// Viewer integration test for Jev Archer. Spins up the real viewer against a temp workspace and
// checks the loop: the target slides, Jev tracks it with the aim, the verdict updates, the pane's
// controls change what Jev faces, a bad edit never kills the range, and the speed dial is honest.
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
  title: 'Test Range', instrument: 'ARCHER', tickMs: 100, speed: 0.6, bullHalf: 1.0, targetWidth: 24, shots: 10,
  style: 'Track the target and plant the bullseye.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-archer-test-'))
  writeFileSync(join(ws, 'archer.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startArcherViewer } = await import(viewerPath)
  const viewer = await startArcherViewer({ workspace: ws, port: 0 })
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

test('Jev Archer tracks and the target slides', async () => {
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
        assert.ok(typeof s.aim === 'number')
        assert.ok(typeof s.target === 'number')
        assert.ok(typeof s.fuse === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected Jev to aim and the target to slide')
  } finally {
    await viewer.close()
  }
})

test('Jev Archer writes a progressive verdict', async () => {
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

test('Jev Archer control commands answer 200', async () => {
  const { viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'gust', 'slowmo', 'shove']) assert.equal(await ctl(cmd), 200, cmd)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const v = await boot({ speed: 1.35, bullHalf: 0.7, targetWidth: 30, shots: 9 })
  try {
    const s = await v.state()
    assert.equal(s.speed, 1.35); assert.equal(s.bullHalf, 0.7); assert.equal(s.targetWidth, 30); assert.equal(s.shots, 9)
    assert.equal(s.title, 'Test Range')
  } finally { await v.viewer.close() }
})

test('tick takes a count, carries probabilities, and never stops at a finished range', async () => {
  const v = await boot({ shots: 3 })
  try {
    const r = await v.ctl({ cmd: 'tick', n: 500 })
    assert.equal(r.ok, true)
    const s = await v.state()
    assert.ok(s.session.decisions > 150, `decisions ${s.session.decisions}`) // the rest of the 500 ticks held finished ranges on screen
    assert.ok(s.session.ranges >= 5, `ranges ${s.session.ranges}`)
    assert.ok(s.episode >= 5, 'a new range starts on its own')
    const total = Object.values(s.probs).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(total - 1) < 0.01, 'the frame carries the full distribution')
    assert.ok(s.conf > 0 && s.conf < 1)
  } finally { await v.viewer.close() }
})

test('sliders override the file, and an edit to archer.json clears them', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'set', key: 'speed', value: 2.25 })
    await v.ctl({ cmd: 'set', key: 'bullHalf', value: 99 })
    let s = await v.state()
    assert.equal(s.speed, 2.25); assert.equal(s.bullHalf, 4, 'clamped to the dial range')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['bullHalf', 'speed'])
    assert.equal((await v.ctl({ cmd: 'set', key: 'shots', value: 1 })).ok, false, 'only dials can be set')
    writeFileSync(join(v.ws, 'archer.json'), JSON.stringify({ ...CFG, speed: 0.45 }))
    assert.ok(await until(async () => (await v.state()).speed === 0.45), 'the edit wins')
    s = await v.state()
    assert.deepEqual(s.overrides, {}); assert.equal(s.bullHalf, 1)
  } finally { await v.viewer.close() }
})

test('shove, gust and slow motion change what Jev faces', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'shove', x: 3 })
    let s = await v.state()
    assert.equal(s.target, 3); assert.equal(s.session.shoves, 1)
    assert.ok(s.events.some((e) => e.e === 'shove'))
    await v.ctl({ cmd: 'gust', dir: 1 })
    s = await v.state()
    assert.ok(s.gust > 1, `gust ${s.gust}`)
    const before = s.target
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    assert.ok(s.target - before > 0.45, 'the gust pushed the target right, even against its own slide')
    await v.ctl({ cmd: 'tick', n: 12 })
    assert.equal((await v.state()).gust, 0, 'the gust dies down')
    const base = (await v.state()).tickMs
    await v.ctl({ cmd: 'slowmo' })
    s = await v.state()
    assert.equal(s.slowmo, true); assert.equal(s.tickMs, base * 3)
    await v.ctl({ cmd: 'reset' })
    s = await v.state()
    assert.equal(s.slowmo, false); assert.equal(s.session.decisions, 0); assert.equal(s.step, 0)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the range alive and reports the problem', async () => {
  const v = await boot({ speed: 0.5 })
  try {
    writeFileSync(join(v.ws, 'archer.json'), '{ "title": "oops", ')
    assert.ok(await until(async () => (await v.state()).cfgError), 'the error is reported')
    await v.ctl({ cmd: 'tick', n: 20 })
    const s = await v.state()
    assert.match(String(s.cfgError), /archer\.json/)
    assert.equal(s.speed, 0.5, 'still on the last good config')
    assert.ok(s.session.decisions >= 20, 'still deciding')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(join(v.ws, 'archer.json'), JSON.stringify({ ...CFG, speed: 0.55 }))
    assert.ok(await until(async () => (await v.state()).cfgError === null), 'a good edit clears it')
    assert.equal((await v.state()).speed, 0.55)
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

test('the dial is honest: a slow target is planted, a fast one outruns the aim', async () => {
  const run = async (speed) => {
    const v = await boot({ speed, shots: 16 })
    try { await v.ctl({ cmd: 'tick', n: 1500 }); return (await v.state()).session } finally { await v.viewer.close() }
  }
  const easy = await run(0.3), hard = await run(1.4)
  assert.ok(easy.arrows > 150 && hard.arrows > 150, 'Jev shoots in both')
  const e = easy.hits / easy.arrows, h = hard.hits / hard.arrows
  assert.ok(e > 0.9, `easy bullseye rate ${e.toFixed(2)}`)
  assert.ok(h < 0.3, `hard bullseye rate ${h.toFixed(2)}`)
  assert.ok(easy.cleanRanges > hard.cleanRanges, `clean ranges easy ${easy.cleanRanges} vs hard ${hard.cleanRanges}`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const tpl = JSON.parse(readFileSync(join(HERE, '../template/archer.json'), 'utf8'))
  const run = (cfg) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-archer-check-'))
    writeFileSync(join(ws, 'archer.json'), JSON.stringify(cfg))
    try { return execFileSync(process.execPath, [join(HERE, '../toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) }
    catch (e) { return String(e.stdout) }
  }
  assert.match(run(tpl), /ok\s+archer\.json is valid/)
  assert.match(run({ ...tpl, speed: 99 }), /speed/)
})
