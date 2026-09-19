// Viewer integration test for Jev Catcher. Spins up the real viewer against a temp workspace and
// checks the loop: balls fall, Jev slides the glove, the verdict updates, the pane's controls change
// what Jev faces, a bad edit never kills the field, and the fall-time dial is honest.
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
  title: 'Test Run', instrument: 'CATCHER', tickMs: 100, fallTicks: 8, gloveReach: 1.6, fieldWidth: 24, balls: 10,
  style: 'Catch every pop fly.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-catcher-test-'))
  writeFileSync(join(ws, 'catcher.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startCatcherViewer } = await import(viewerPath)
  const viewer = await startCatcherViewer({ workspace: ws, port: 0 })
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

test('Jev Catcher fields and Jev slides the glove', async () => {
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
        assert.ok(typeof s.glove === 'number')
        assert.ok(Array.isArray(s.balls) && s.balls.length === 10)
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected Jev to field and slide the glove')
  } finally {
    await viewer.close()
  }
})

test('Jev Catcher writes a progressive verdict', async () => {
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

test('Jev Catcher control commands answer 200', async () => {
  const { viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    for (const cmd of ['pause', 'tick', 'start', 'reset', 'gust', 'slowmo', 'drop']) assert.equal(await ctl(cmd), 200, cmd)
  } finally {
    await viewer.close()
  }
})

test('a non-default config value shows up in /state', async () => {
  const v = await boot({ fallTicks: 13, gloveReach: 0.9, fieldWidth: 30, balls: 7 })
  try {
    const s = await v.state()
    assert.equal(s.fallTicks, 13); assert.equal(s.gloveReach, 0.9); assert.equal(s.fieldWidth, 30); assert.equal(s.ballsTotal, 7)
    assert.equal(s.balls.length, 7); assert.equal(s.air[0].total, 13); assert.equal(s.title, 'Test Run')
  } finally { await v.viewer.close() }
})

test('tick takes a count, carries probabilities, and never stops at a finished session', async () => {
  const v = await boot({ balls: 3, fallTicks: 6 })
  try {
    assert.equal((await v.ctl({ cmd: 'tick', n: 500 })).ok, true)
    const s = await v.state()
    assert.ok(s.session.decisions > 150, `decisions ${s.session.decisions}`) // the rest of the 500 ticks held finished sessions on screen
    assert.ok(s.session.sessions >= 5, `sessions ${s.session.sessions}`)
    assert.ok(s.episode >= 5, 'a new session starts on its own')
    const total = Object.values(s.probs).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(total - 1) < 0.01, 'the frame carries the full distribution')
    assert.ok(s.conf > 0 && s.conf < 1)
  } finally { await v.viewer.close() }
})

test('sliders override the file, and an edit to catcher.json clears them', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'set', key: 'fallTicks', value: 4 })
    await v.ctl({ cmd: 'set', key: 'gloveReach', value: 99 })
    let s = await v.state()
    assert.equal(s.fallTicks, 4); assert.equal(s.gloveReach, 4, 'clamped to the dial range')
    assert.deepEqual(Object.keys(s.overrides).sort(), ['fallTicks', 'gloveReach'])
    assert.equal((await v.ctl({ cmd: 'set', key: 'balls', value: 1 })).ok, false, 'only dials can be set')
    writeFileSync(join(v.ws, 'catcher.json'), JSON.stringify({ ...CFG, fallTicks: 11 }))
    assert.ok(await until(async () => (await v.state()).fallTicks === 11), 'the edit wins')
    s = await v.state()
    assert.deepEqual(s.overrides, {}); assert.equal(s.gloveReach, 1.6)
  } finally { await v.viewer.close() }
})

test('an extra fly, a gust and slow motion change what Jev faces', async () => {
  const v = await boot({ fallTicks: 12 })
  try {
    await v.ctl({ cmd: 'tick', n: 3 })
    await v.ctl({ cmd: 'drop', x: 2 })
    let s = await v.state()
    assert.equal(s.air.length, 2, 'two balls in the air')
    const extra = s.air.find((b) => b.extra)
    assert.equal(extra.land, 2); assert.equal(extra.ticks, 12); assert.equal(s.session.extras, 1)
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    assert.match(s.stateText, /Also falling: x 2\.0, 12 away/, "Jev was told about the second ball before it decided")
    assert.equal(s.primary, s.air.find((b) => !b.extra).id, 'the ball landing soonest comes first')
    const before = s.air.map((b) => b.land)
    await v.ctl({ cmd: 'gust', dir: 1 })
    assert.ok((await v.state()).gust >= 1)
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    assert.ok(s.air.every((b, i) => b.land > before[i] || b.land === 23), 'the wind carried the landing spots')
    await v.ctl({ cmd: 'tick', n: 8 })
    assert.equal((await v.state()).gust, 0, 'the gust dies down')
    const ballsBefore = (await v.state()).session.balls
    await v.ctl({ cmd: 'tick', n: 12 })
    s = await v.state()
    assert.ok(s.session.balls > ballsBefore, 'the extra ball was settled and counted')
    assert.ok(s.log.some((p) => p.extra), 'the play log names the extra ball')
    const base = s.tickMs
    await v.ctl({ cmd: 'slowmo' })
    s = await v.state()
    assert.equal(s.slowmo, true); assert.equal(s.tickMs, base * 3)
    await v.ctl({ cmd: 'reset' })
    s = await v.state()
    assert.equal(s.slowmo, false); assert.equal(s.session.decisions, 0); assert.equal(s.step, 0); assert.equal(s.air.length, 1)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the field alive and reports the problem', async () => {
  const v = await boot({ fallTicks: 9 })
  try {
    writeFileSync(join(v.ws, 'catcher.json'), '{ "title": "oops", ')
    assert.ok(await until(async () => (await v.state()).cfgError), 'the error is reported')
    await v.ctl({ cmd: 'tick', n: 20 })
    const s = await v.state()
    assert.match(String(s.cfgError), /catcher\.json/)
    assert.equal(s.fallTicks, 9, 'still on the last good config')
    assert.ok(s.session.decisions >= 20, 'still deciding')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(join(v.ws, 'catcher.json'), JSON.stringify({ ...CFG, fallTicks: 7 }))
    assert.ok(await until(async () => (await v.state()).cfgError === null), 'a good edit clears it')
    assert.equal((await v.state()).fallTicks, 7)
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

test('the dial is honest: slow flies are all caught, fast ones land before the glove arrives', async () => {
  const run = async (fallTicks) => {
    const v = await boot({ fallTicks, balls: 14 })
    try { await v.ctl({ cmd: 'tick', n: 1500 }); return (await v.state()).session } finally { await v.viewer.close() }
  }
  const easy = await run(12), hard = await run(3)
  assert.ok(easy.balls > 80 && hard.balls > 80, 'Jev fields in both')
  const e = easy.caught / easy.balls, h = hard.caught / hard.balls
  assert.ok(e > 0.95, `easy catch rate ${e.toFixed(2)}`)
  assert.ok(h < 0.75, `hard catch rate ${h.toFixed(2)}`)
  assert.ok(e - h > 0.25, `margin ${(e - h).toFixed(2)}`)
  assert.ok(easy.cleanSessions > hard.cleanSessions, `clean sessions easy ${easy.cleanSessions} vs hard ${hard.cleanSessions}`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const tpl = JSON.parse(readFileSync(join(HERE, '../template/catcher.json'), 'utf8'))
  const run = (cfg) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-catcher-check-'))
    writeFileSync(join(ws, 'catcher.json'), JSON.stringify(cfg))
    try { return execFileSync(process.execPath, [join(HERE, '../toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) }
    catch (e) { return String(e.stdout) }
  }
  assert.match(run(tpl), /ok\s+catcher\.json is valid/)
  assert.match(run({ ...tpl, fallTicks: 999 }), /fallTicks/)
})
