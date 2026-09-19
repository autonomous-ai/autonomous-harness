// Integration tests for Jev Browser. They boot the real viewer on an ephemeral port against a temp
// workspace and drive time with the `tick` control, so nothing here waits on a timer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startBrowserViewer, sanitize } = await import(join(ROOT, 'viewer/viewer.mjs'))
const { DEFAULT, createWorld, observe, act, elements, bestFlight } = await import(join(ROOT, 'viewer/sim.mjs'))
const { browserMock, readTask } = await import(join(ROOT, 'viewer/mock.mjs'))
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/site.json'), 'utf8'))

async function boot(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-browser-test-'))
  writeFileSync(join(ws, 'site.json'), JSON.stringify({ ...TEMPLATE, ...overrides }))
  const viewer = await startBrowserViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const ctl = async (body) => { const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
  const state = async () => (await fetch(`${base}/state`)).json()
  await ctl({ cmd: 'pause' }); await ctl({ cmd: 'reset' })
  return { ws, viewer, base, ctl, state }
}

/** Run bookings straight on the sim with the stand-in: fast, no server. */
function runBookings(cfg, n) {
  let ok = 0, steps = 0, mis = 0
  for (let i = 0; i < n; i++) {
    const w = createWorld(cfg, i, Math.floor(i / cfg.tasks.length))
    while (w.status === 'running') { const o = observe(w, cfg); act(w, cfg, browserMock(o.text, 'action', { options: Object.keys(o.options), descriptions: o.options }).choice) }
    if (w.result.ok) ok++; steps += w.steps; mis += w.misclicks
  }
  return { right: ok / n, steps: steps / n, misclicks: mis / n }
}

test('Jev books a flight step by step, answering three questions per call', async () => {
  const v = await boot({ distraction: 0 })
  try {
    await v.ctl({ cmd: 'tick', n: 3 })
    let s = await v.state()
    assert.equal(s.steps, 3)
    assert.equal(s.page, 'search')
    assert.deepEqual(s.els.filter((e) => e.role === 'input').map((e) => e.value), ['SFO', 'JFK', 'Friday'])
    const sum = Object.values(s.last.probs).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6 && Math.max(...Object.values(s.last.probs)) < 0.999, 'a real distribution')
    await v.ctl({ cmd: 'tick', n: 7 })
    s = await v.state()
    assert.equal(s.status, 'done')
    assert.equal(s.result.ok, true, s.result.why)
    assert.equal(s.steps, 10)
    assert.equal(s.session.tasks, 1)
    const jev = await (await fetch(`${v.base}/jev`)).json()
    assert.equal(jev.calls, 10)
    assert.equal(jev.last.questions.length, 3)
    assert.ok(jev.costUsd > 0)
  } finally { await v.viewer.close() }
})

test('it never ends: after a booking the next task starts by itself', async () => {
  const v = await boot({ distraction: 0, stepMs: 200 })
  try {
    await v.ctl({ cmd: 'tick', n: 10 })
    assert.equal((await v.state()).task.index, 0)
    await v.ctl({ cmd: 'tick', n: 14 }) // 2.6 s of rest at 200 ms a step, then the new task's first step
    const s = await v.state()
    assert.equal(s.task.index, 1)
    assert.match(s.task.goal, /SEA to AUS/)
  } finally { await v.viewer.close() }
})

test('site.json really takes effect, and pane overrides work', async () => {
  const tasks = [{ from: 'LIS', to: 'OSL', day: 'Tuesday', pick: 'latest', nonstop: false, name: 'Ines Costa', email: 'ines@example.com', bags: 3 }]
  const v = await boot({ title: 'Nordic Run', site: 'FjordAir', tasks, distraction: 0.6, stepMs: 400 })
  try {
    let s = await v.state()
    assert.equal(s.title, 'Nordic Run'); assert.equal(s.site, 'FjordAir')
    assert.equal(s.url, 'https://fjordair.example/')
    assert.equal(s.distraction, 0.6); assert.equal(s.stepMs, 400)
    assert.match(s.task.goal, /latest flight from LIS to OSL on Tuesday for Ines Costa \(ines@example.com\), 3 checked bags/)
    await v.ctl({ cmd: 'set', key: 'distraction', value: 0.1 })
    assert.equal((await v.state()).distraction, 0.1)
    await v.ctl({ cmd: 'set', key: 'nope', value: 5 })
    await v.ctl({ cmd: 'popup' })
    s = await v.state()
    assert.equal(s.overlay, 'popup')
    assert.match(s.stateText, /OVERLAY: a pop-up covers the page/)
  } finally { await v.viewer.close() }
})

test('a person can click the page, and the click is a real step', async () => {
  const v = await boot({ distraction: 0 })
  try {
    await v.ctl({ cmd: 'click', id: 'to' })
    let s = await v.state()
    assert.equal(s.steps, 1)
    assert.equal(s.els.find((e) => e.id === 'to').value, 'JFK')
    assert.match(s.lastAction.note, /you clicked/)
    await v.ctl({ cmd: 'click', id: 'search-flights' }) // still disabled: a wasted step, the page does not move
    s = await v.state()
    assert.equal(s.page, 'search'); assert.equal(s.wasted, 1); assert.equal(s.shake, 'search-flights')
    await v.ctl({ cmd: 'tick', n: 12 })
    assert.equal((await v.state()).result.ok, true, 'Jev still finishes the booking')
  } finally { await v.viewer.close() }
})

test('a progressive verdict is written', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'tick', n: 40 })
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.spec, 1); assert.equal(verdict.ready, true)
    assert.match(verdict.summary, /bookings · \d+% exactly right/)
    assert.ok(Array.isArray(verdict.findings) && Array.isArray(verdict.phases))
    assert.equal(verdict.artifact, 'site.json')
  } finally { await v.viewer.close() }
})

test('every control command answers 200, and junk is rejected', async () => {
  const v = await boot()
  try {
    for (const cmd of ['pause', 'tick', 'start', 'pause', 'popup', 'reset']) assert.equal((await v.ctl({ cmd })).status, 200, cmd)
    assert.equal((await v.ctl({ cmd: 'task', index: 2 })).status, 200)
    assert.match((await v.state()).task.goal, /BOS to LAX/)
    assert.equal((await v.ctl({ cmd: 'click', id: 'no-such-element' })).status, 200)
    assert.equal((await fetch(`${v.base}/control`, { method: 'POST', body: '{not json' })).status, 400)
    assert.equal((await fetch(`${v.base}/nope`)).status, 404)
  } finally { await v.viewer.close() }
})

test('a broken site.json keeps the demo alive and reports the problem', async () => {
  const v = await boot()
  try {
    writeFileSync(join(v.ws, 'site.json'), '{ "title": "oops", ')
    await new Promise((r) => setTimeout(r, 250))
    await v.ctl({ cmd: 'tick', n: 5 })
    let s = await v.state()
    assert.match(String(s.cfgError), /site\.json/)
    assert.ok(s.steps >= 5)
    writeFileSync(join(v.ws, 'site.json'), JSON.stringify({ ...TEMPLATE, title: 'Back again', distraction: 99, tasks: 'nonsense' }))
    await new Promise((r) => setTimeout(r, 250))
    s = await v.state()
    assert.equal(s.cfgError, null); assert.equal(s.title, 'Back again')
    assert.equal(s.distraction, 1, 'out-of-range values are clamped')
    assert.equal(s.task.count, DEFAULT.tasks.length, 'a bad task list falls back to the built-in tasks')
  } finally { await v.viewer.close() }
})

test('the viewer is loopback only', async () => {
  const v = await boot()
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
  } finally { await v.viewer.close() }
})

test('the dial is honest: distraction costs steps and correct bookings', () => {
  const clean = runBookings(sanitize({ ...DEFAULT, distraction: 0 }), 200)
  const hostile = runBookings(sanitize({ ...DEFAULT, distraction: 0.9 }), 200)
  assert.equal(clean.right, 1); assert.equal(clean.steps, 10); assert.equal(clean.misclicks, 0)
  assert.ok(hostile.right < 0.92 && hostile.right > 0.5, `hostile right ${hostile.right}`)
  assert.ok(hostile.steps > clean.steps * 1.4, `hostile steps ${hostile.steps}`)
  assert.ok(hostile.misclicks > 1.5, `hostile misclicks ${hostile.misclicks}`)
})

test('a layout shift makes the click land on what is there now', () => {
  const cfg = sanitize({ ...DEFAULT, distraction: 1 })
  // Walk many bookings until a sponsored row shifts the results under a Select click.
  for (let i = 0; i < 80; i++) {
    const w = createWorld(cfg, i, 0)
    while (w.status === 'running') {
      const o = observe(w, cfg)
      const id = browserMock(o.text, 'action', { options: Object.keys(o.options), descriptions: o.options }).choice
      const rec = act(w, cfg, id)
      if (rec.shift === 'sponsored row' && id.startsWith('select-')) {
        assert.notEqual(rec.landed, id, 'the list moved down, so the click hit another element')
        assert.match(rec.note, /layout shifted/)
        assert.ok(elements(w, cfg).length > 0)
        return
      }
    }
  }
  assert.fail('no sponsored-row shift happened in 80 bookings at distraction 1')
})

test('every task has exactly one right flight, and the stand-in reads only the text', () => {
  const cfg = sanitize(DEFAULT)
  for (let i = 0; i < 40; i++) {
    const w = createWorld(cfg, i, i)
    const best = bestFlight(w.task, w.flights)
    assert.ok(best, 'a right answer exists')
    if (w.task.nonstop) assert.equal(best.stops, 0)
  }
  const w = createWorld(sanitize({ ...DEFAULT, distraction: 0 }), 0, 0)
  const o = observe(w, sanitize({ ...DEFAULT, distraction: 0 }))
  assert.deepEqual(readTask(o.text), { pick: 'cheapest', nonstop: true, from: 'SFO', to: 'JFK', day: 'Friday', name: 'Ada Park', email: 'ada@example.com', bags: 1 })
  assert.equal(browserMock(o.text, 'action', { options: Object.keys(o.options), descriptions: o.options }).choice, 'from')
  assert.equal(browserMock('nothing to do with a browser', 'action', { options: ['a', 'b'] }), null)
})

test('check.mjs accepts the template and rejects bad values', () => {
  const run = (site) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-browser-check-'))
    writeFileSync(join(ws, 'site.json'), JSON.stringify(site))
    try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) } }
    catch (e) { return { code: e.status, out: String(e.stdout) } }
  }
  assert.equal(run(TEMPLATE).code, 0)
  const loud = run({ ...TEMPLATE, distraction: 3 })
  assert.equal(loud.code, 1); assert.match(loud.out, /distraction/)
  const badTask = run({ ...TEMPLATE, tasks: [{ ...TEMPLATE.tasks[0], pick: 'fanciest', bags: 9 }] })
  assert.equal(badTask.code, 1); assert.match(badTask.out, /pick must be/); assert.match(badTask.out, /bags must be/)
  assert.ok(existsSync(join(ROOT, 'LICENSE')))
})
