// Viewer integration test for Jev Launcher. Spins up the real viewer against a temp workspace and
// checks the loop: posting a query makes Jev rank the palette (a top pick with probabilities), the
// verdict updates, and control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const LAUNCHER = {
  title: 'Test Palette', description: 'x', prompt: 'Pick the best match, be decisive.',
  targets: [
    { name: 'Run tests', category: 'Dev', aliases: ['test', 'pytest', 'spec'], featured: true },
    { name: 'Deploy to prod', category: 'Ops', aliases: ['ship', 'release', 'deploy'] },
    { name: 'Music', category: 'Media', aliases: ['spotify', 'play', 'tunes'] },
    { name: 'Open Editor', category: 'Apps', aliases: ['code', 'vscode', 'ide'] },
  ],
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-launcher-test-'))
  writeFileSync(join(ws, 'launcher.json'), JSON.stringify({ ...LAUNCHER, ...overrides }))
  const { startLauncherViewer } = await import(viewerPath)
  const viewer = await startLauncherViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

const post = async (port, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.status
}

test('Jev Launcher posts a query and ranks a target with probabilities', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    assert.equal(await post(port, { cmd: 'query', query: 'deploy' }), 200)
    const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
    assert.equal(s.query, 'deploy')
    assert.ok(s.history.length >= 1)
    const last = s.history[s.history.length - 1]
    assert.ok(last.top, 'expected a top pick')
    assert.ok(last.conf >= 0 && last.conf <= 1)
    assert.ok(s.rank, 'expected full probabilities')
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher matching query picks the right target', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    await post(port, { cmd: 'query', query: 'test' })
    const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
    assert.equal(s.history[s.history.length - 1].top, 'Run tests')
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    await post(port, { cmd: 'query', query: 'edit' })
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
    assert.ok(v.ready)
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    assert.equal(await post(port, { cmd: 'query', query: 'music' }), 200)
    assert.equal(await post(port, { cmd: 'launch' }), 200)
    assert.equal(await post(port, { cmd: 'reset' }), 200)
  } finally {
    await viewer.close()
  }
})

// ---------------------------------------------------------------------------------------------
// The tests below drive the demo typist with the `tick` control, so none of them waits on a clock.
// ---------------------------------------------------------------------------------------------
import { connect } from 'node:net'
import { cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TEMPLATE = JSON.parse(readFileSync(join(HERE, '../template/launcher.json'), 'utf8'))

/** A paused palette with fresh stats, so `tick` alone drives the demo typist. */
async function pausedPalette(config = LAUNCHER) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-launcher-test-'))
  writeFileSync(join(ws, 'launcher.json'), JSON.stringify(config))
  const { startLauncherViewer } = await import(viewerPath)
  const viewer = await startLauncherViewer({ workspace: ws, port: 0 })
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  const ctl = async (body) => (await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  await ctl({ cmd: 'pause' })
  await ctl({ cmd: 'reset' })
  return { ws, viewer, state, ctl }
}

async function until(fn, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await wait(40) }
  return null
}

test('a non-default launcher.json really shows up in /state', async () => {
  const { viewer, state } = await pausedPalette({ ...LAUNCHER, title: 'Odd Deck', typos: 0.31, chars: 4, lookalikes: 2, stepMs: 77, idleMs: 9000 })
  try {
    const s = await state()
    assert.equal(s.title, 'Odd Deck')
    assert.deepEqual(s.dials, { typos: 0.31, chars: 4, lookalikes: 2, stepMs: 77, idleMs: 9000 })
    assert.equal(s.targets.length, LAUNCHER.targets.length + 2, 'two look-alike twins were added')
    assert.equal(s.targets.filter((t) => t.twin).length, 2)
    assert.ok(s.targets.some((t) => t.name === 'Music'))
  } finally {
    await viewer.close()
  }
})

test('a typed query is ranked in the reply itself, with a probability for every target', async () => {
  const { viewer, ctl } = await pausedPalette()
  try {
    const t0 = Date.now()
    const r = await ctl({ cmd: 'query', text: 'spot' })
    const ms = Date.now() - t0
    assert.ok(ms < 100, `a keystroke is ranked inside about 100 ms (took ${ms} ms)`)
    const f = r.frame
    assert.equal(f.query, 'spot')
    assert.equal(f.mode, 'human', 'a human key stops the demo typist at once')
    assert.equal(f.demo.intent, null)
    assert.equal(f.mind.top, 'Music')
    assert.deepEqual(Object.keys(f.rank).sort(), LAUNCHER.targets.map((t) => t.name).sort())
    const sum = Object.values(f.rank).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `probabilities sum to ${sum}`)
    assert.ok(f.mind.confidence > 0.3 && f.mind.confidence < 1, 'never exactly one-hot')
    assert.ok(f.mind.ready >= 0 && f.mind.ready <= 1)
    assert.equal(f.rankings, 2, 'the reset ranking and this one')
  } finally {
    await viewer.close()
  }
})

test('click a row to mark the right answer: the pane scores Jev\'s first row', async () => {
  const { viewer, ctl } = await pausedPalette()
  try {
    await ctl({ cmd: 'query', text: 'deploy' })
    let f = (await ctl({ cmd: 'mark', name: 'Deploy to prod' })).frame
    assert.equal(f.judge.ok, true)
    assert.equal(f.judge.place, 1)
    assert.equal(f.stats.human.judged, 1)
    assert.equal(f.stats.accuracy, 1)
    f = (await ctl({ cmd: 'mark', name: 'Music' })).frame // changed my mind: the same ranking is re-scored, not counted twice
    assert.equal(f.judge.ok, false)
    assert.ok(f.judge.place > 1)
    assert.equal(f.stats.human.judged, 1)
    assert.equal(f.stats.accuracy, 0)
    f = (await ctl({ cmd: 'mark', name: 'No Such Target' })).frame
    assert.equal(f.stats.human.judged, 1, 'an unknown name is ignored')
  } finally {
    await viewer.close()
  }
})

test('Enter launches a row on paper: it is logged and the input clears', async () => {
  const { viewer, ctl } = await pausedPalette()
  try {
    await ctl({ cmd: 'query', text: 'pytest' })
    const f = (await ctl({ cmd: 'launch', name: 'Run tests' })).frame
    assert.equal(f.query, '')
    const last = f.launches.at(-1)
    assert.equal(last.name, 'Run tests')
    assert.equal(last.by, 'you')
    assert.equal(last.ok, true)
    assert.equal(last.query, 'pytest')
  } finally {
    await viewer.close()
  }
})

test('the demo typist is tagged, types a letter per tick, and steps aside for a human key', async () => {
  const { viewer, ctl } = await pausedPalette()
  try {
    let f = (await ctl({ cmd: 'tick', n: 3 })).frame
    assert.equal(f.mode, 'demo')
    assert.ok(f.demo.intent, 'the demo typist has a target in mind')
    assert.equal(f.query, f.demo.planned.slice(0, f.demo.typed))
    assert.equal(f.mind.by, 'demo')
    f = (await ctl({ cmd: 'touch' })).frame
    assert.equal(f.mode, 'human')
    assert.equal(f.demo.intent, null)
    f = (await ctl({ cmd: 'demo' })).frame
    assert.equal(f.mode, 'demo')
    await ctl({ cmd: 'pause' })
  } finally {
    await viewer.close()
  }
})

test('the sliders override launcher.json, clamp, and an edit to launcher.json resets them', async () => {
  const { ws, viewer, state, ctl } = await pausedPalette()
  try {
    await ctl({ cmd: 'set', key: 'typos', value: 0.4 })
    await ctl({ cmd: 'set', key: 'chars', value: 99 })       // clamped down to 12
    await ctl({ cmd: 'set', key: 'lookalikes', value: 3 })
    await ctl({ cmd: 'set', key: 'stepMs', value: 1 })       // clamped up to 40
    await ctl({ cmd: 'set', key: 'seed', value: 5 })         // not settable from the pane
    let s = await state()
    assert.equal(s.dials.typos, 0.4)
    assert.equal(s.dials.chars, 12)
    assert.equal(s.dials.lookalikes, 3)
    assert.equal(s.dials.stepMs, 40)
    assert.equal(s.targets.filter((t) => t.twin).length, 3)
    assert.deepEqual(Object.keys(s.overrides).sort(), ['chars', 'lookalikes', 'stepMs', 'typos'])
    writeFileSync(join(ws, 'launcher.json'), JSON.stringify({ ...LAUNCHER, title: 'Edited', typos: 0.1 }))
    s = await until(async () => { const t = await state(); return t.title === 'Edited' ? t : null })
    assert.ok(s, 'the edit reached the viewer')
    assert.deepEqual(s.overrides, {})
    assert.equal(s.dials.typos, 0.1)
    assert.equal(s.targets.filter((t) => t.twin).length, 0)
  } finally {
    await viewer.close()
  }
})

test('a bad JSON edit keeps the palette alive and reports the error', async () => {
  const { ws, viewer, state, ctl } = await pausedPalette({ ...LAUNCHER, title: 'Keep Me' })
  try {
    await ctl({ cmd: 'tick', n: 5 })
    writeFileSync(join(ws, 'launcher.json'), '{ "title": "Broken", ')
    let s = await until(async () => { const t = await state(); return t.cfgError ? t : null })
    assert.ok(s, 'the parse error is reported')
    assert.match(s.cfgError, /launcher\.json/)
    assert.equal(s.title, 'Keep Me', 'the last good palette stands')
    const before = s.rankings
    const f = (await ctl({ cmd: 'query', text: 'ide' })).frame
    assert.equal(f.mind.top, 'Open Editor', 'Jev still ranks')
    assert.equal(f.rankings, before + 1)
    assert.match(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).summary, /needs a fix/)
    writeFileSync(join(ws, 'launcher.json'), JSON.stringify({ ...LAUNCHER, title: 'Fixed' }))
    s = await until(async () => { const t = await state(); return t.title === 'Fixed' ? t : null })
    assert.ok(s && s.cfgError === null, 'a good edit clears the error')
  } finally {
    await viewer.close()
  }
})

test('a malformed control body is a 400, not a crash', async () => {
  const { viewer, state } = await pausedPalette()
  try {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal((await state()).mode, 'demo')
  } finally {
    await viewer.close()
  }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer } = await pausedPalette()
  try {
    const port = Number(viewer.url.split(':').pop())
    const reply = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => (buf += d))
      sock.on('end', () => resolve(buf))
      sock.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
  } finally {
    await viewer.close()
  }
})

test('the difficulty dials are honest: a clean full query beats a fumbled short one among look-alikes', async () => {
  const run = async (dials) => {
    const { viewer, state, ctl } = await pausedPalette({ ...TEMPLATE, ...dials })
    try {
      await ctl({ cmd: 'tick', n: 3000 })
      const st = (await state()).stats
      return { launched: st.demo.launched, acc: st.demo.right / st.demo.launched, byLen: st.byLen.map((b) => (b.n ? b.right / b.n : null)) }
    } finally {
      await viewer.close()
    }
  }
  const easy = await run({ typos: 0, chars: 12, lookalikes: 0 })
  const hard = await run({ typos: 0.35, chars: 3, lookalikes: 6 })
  assert.ok(easy.launched > 150 && hard.launched > 150, 'both runs launched plenty')
  assert.ok(easy.acc > 0.95, `easy: first row right on ${(easy.acc * 100).toFixed(1)}% of launches`)
  assert.ok(hard.acc < 0.55, `hard: ${(hard.acc * 100).toFixed(1)}%`)
  assert.ok(easy.acc - hard.acc > 0.4, `margin ${(easy.acc - hard.acc).toFixed(2)}`)
  // The same limit seen from inside one run: one letter is ambiguous, four letters are not.
  assert.ok(easy.byLen[0] < 0.5, `one letter typed: ${(easy.byLen[0] * 100).toFixed(0)}% right`)
  assert.ok(easy.byLen[3] > 0.9, `four letters typed: ${(easy.byLen[3] * 100).toFixed(0)}% right`)
})

test('each dial bites on its own', async () => {
  const run = async (dials) => {
    const { viewer, state, ctl } = await pausedPalette({ ...TEMPLATE, typos: 0, chars: 12, lookalikes: 0, ...dials })
    try {
      await ctl({ cmd: 'tick', n: 2000 })
      const st = (await state()).stats
      return st.demo.right / st.demo.launched
    } finally {
      await viewer.close()
    }
  }
  const clean = await run({})
  assert.ok(clean - (await run({ typos: 0.4 })) > 0.25, 'fumbled letters hurt')
  assert.ok(clean - (await run({ chars: 1 })) > 0.4, 'one letter is not enough')
  assert.ok(clean - (await run({ lookalikes: 6 })) > 0.15, 'near-duplicate targets hurt')
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const check = join(HERE, '../toolchain/check.mjs')
  const good = mkdtempSync(join(tmpdir(), 'jev-launcher-check-'))
  cpSync(join(HERE, '../template'), good, { recursive: true })
  assert.equal(spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: good } }).status, 0)
  const bad = mkdtempSync(join(tmpdir(), 'jev-launcher-check-'))
  writeFileSync(join(bad, 'launcher.json'), JSON.stringify({ ...LAUNCHER, typos: 7 }))
  const r = spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: bad }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /typos/)
})
