// Viewer integration test for Jev Guard. Spins up the real viewer against a temp workspace and
// checks the loop: an edit triggers a test run + Jev judgment, the verdict updates, and once the
// agent's fix makes the tests pass, Jev reports the goal met.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

const PROJ_JS = `export function sumTo(n){let s=0;for(let i=1;i<=n;i++)s+=i;return s}
export function factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r}
`
const TEST_JS = `import assert from 'node:assert/strict'
import { sumTo, factorial } from './score.js'
assert.equal(sumTo(5), 15)
assert.equal(factorial(5), 120)
console.log('ALL TESTS PASS')
`

async function freshViewer({ broken = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-guard-test-'))
  mkdirSync(join(ws, 'project'))
  writeFileSync(join(ws, 'goal.json'), JSON.stringify({ name: 'Guard Test', goal: 'Make project/test.js pass.', description: 'test' }))
  if (broken) {
    writeFileSync(join(ws, 'project', 'score.js'), `export function sumTo(n){return 0}\nexport function factorial(n){return n}\n`)
  } else {
    writeFileSync(join(ws, 'project', 'score.js'), PROJ_JS)
  }
  writeFileSync(join(ws, 'project', 'test.js'), TEST_JS)
  const { startGuardViewer } = await import(viewerPath)
  const viewer = await startGuardViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Guard judges the first edit and writes a verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    // Trigger a manual judge (the viewer starts idle; "Judge now" runs the loop).
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'judge' }) })
    await wait(400)
    assert.ok(existsSync(join(ws, '.harness/verdict.json')), 'verdict should exist')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.phases))
    assert.match(v.summary, /failing|judging|1 runs/, `summary should reflect a judged run: ${v.summary}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard detects the agent fixing the tests: passing run → goal met', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
    await ctl('start')
    // The agent fixes the module.
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(ws, 'project', 'score.js'), PROJ_JS)
    const deadline = Date.now() + 4000
    let done = false
    while (Date.now() < deadline && !done) {
      await wait(250)
      const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
      if (/goal met/i.test(v.summary) || /passing/i.test(v.summary)) done = true
    }
    assert.ok(done, `expected a passing/green judgment after the fix; summary was ${readFileSync(join(ws, '.harness/verdict.json'), 'utf8')}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    assert.equal(await ctl('judge'), 200)
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard judges a workspace that already passes', async () => {
  const { ws, viewer } = await freshViewer({ broken: false })
  try {
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'judge' }) })
    await wait(400)
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.match(v.summary, /goal met|passing/i, `summary: ${v.summary}`)
  } finally {
    await viewer.close()
  }
})

// ---------------------------------------------------------------------------------------------
// The tests below drive the demo stream with the `tick` control, so none of them waits on a clock.
// ---------------------------------------------------------------------------------------------
import { connect } from 'node:net'
import { cpSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/** A paused console with fresh stats, so `tick` alone drives the demo stream. */
async function pausedGuard(goal = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-guard-test-'))
  mkdirSync(join(ws, 'project'))
  writeFileSync(join(ws, 'goal.json'), JSON.stringify({ name: 'Guard Test', goal: 'Make project/test.js pass.', description: 'test', ...goal }))
  writeFileSync(join(ws, 'project', 'score.js'), PROJ_JS)
  writeFileSync(join(ws, 'project', 'test.js'), TEST_JS)
  const { startGuardViewer } = await import(viewerPath)
  const viewer = await startGuardViewer({ workspace: ws, port: 0 })
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

test('a non-default goal.json really shows up in /state', async () => {
  const { viewer, state } = await pausedGuard({ name: 'Odd Guard', goal: 'Ship the odd thing.', strictness: 0.81, subtlety: 0.64, stepMs: 333, diffBudget: 2500, seed: 42 })
  try {
    const s = await state()
    assert.equal(s.title, 'Odd Guard')
    assert.equal(s.goal, 'Ship the odd thing.')
    assert.deepEqual(s.cfg, { strictness: 0.81, subtlety: 0.64, stepMs: 333, diffBudget: 2500, seed: 42 })
    assert.ok(s.files.some((f) => f.name === 'project/score.js' && f.group === 'project'), 'the real project files are in the tree')
  } finally {
    await viewer.close()
  }
})

test('tick reviews exactly n demo edits, each with probabilities, a chip, a diff and a known truth', async () => {
  const { viewer, state, ctl } = await pausedGuard()
  try {
    const r = await ctl({ cmd: 'tick', n: 30 })
    assert.equal(r.edits, 30)
    const s = await state()
    assert.equal(s.mode, 'demo', 'the made-up stream is tagged as a demo')
    assert.equal(s.edits.length, 30)
    assert.equal(s.stats.demo, 30)
    assert.equal(s.stats.risky + s.stats.safe, 30)
    for (const e of s.edits) {
      assert.equal(e.source, 'demo')
      assert.ok(['safe', 'risky'].includes(e.truth))
      assert.ok(['safe', 'review', 'block'].includes(e.chip))
      const sum = e.probs.safe + e.probs.review + e.probs.block
      assert.ok(Math.abs(sum - 1) < 1e-6, `probabilities sum to ${sum}`)
      assert.ok(e.confidence > 0.3 && e.confidence < 1, 'never exactly one-hot')
      assert.ok(e.files.length >= 1 && e.files.every((f) => f.risk == null || (f.risk >= 0 && f.risk <= 1)))
      assert.ok(Array.isArray(s.diffs[e.id]) && s.diffs[e.id][0].lines.length > 0, 'every shown edit has a diff to inspect')
    }
    assert.ok(s.gauge.safe >= 0 && s.gauge.safe <= 1)
    assert.ok(['YES', 'LOOK FIRST', 'STOP'].includes(s.gauge.word))
    assert.ok(s.files.some((f) => f.group === 'demo' && f.heat > 0), 'risk heat builds up per file')
  } finally {
    await viewer.close()
  }
})

test('the sample buttons write real files into project/ and Jev reacts to each', async () => {
  const { ws, viewer, state, ctl } = await pausedGuard()
  try {
    await ctl({ cmd: 'sample', kind: 'secret' })
    let s = await state(), e = s.edits.at(-1)
    assert.match(readFileSync(join(ws, 'project', 'sample_config.js'), 'utf8'), /sk_test_FAKE_not_a_real_key/)
    assert.equal(e.source, 'sample')
    assert.equal(s.mode, 'live', 'a real edit takes over from the demo stream')
    assert.equal(e.chip, 'block')
    assert.ok(e.flags.secret > 0.9, `secret flag ${e.flags.secret.toFixed(2)}`)
    assert.equal(s.gauge.word, 'STOP')
    assert.deepEqual(e.files.map((f) => f.name), ['project/sample_config.js'])
    assert.ok(s.diffs[e.id][0].lines.some((l) => l.t === '+' && /FAKE_not_a_real_key/.test(l.s)), 'the diff shows the leaked line as an added line')

    await ctl({ cmd: 'sample', kind: 'refactor' })
    e = (await state()).edits.at(-1)
    assert.equal(e.chip, 'safe', 'a harmless refactor is waved through')
    assert.ok(e.flags.secret < 0.3 && e.flags.destructive < 0.3)

    await ctl({ cmd: 'sample', kind: 'deltest' })
    e = (await state()).edits.at(-1)
    assert.notEqual(e.chip, 'safe', 'a deleted test is not waved through')
    assert.ok(e.flags.tests > 0.7, `tests flag ${e.flags.tests.toFixed(2)}`)
    assert.equal(e.files[0].status, 'deleted')

    await ctl({ cmd: 'sample', kind: 'cleanup' })
    assert.deepEqual(readdirSync(join(ws, 'project')).sort(), ['score.js', 'test.js'], 'clean up removes only the sample files')
  } finally {
    await viewer.close()
  }
})

test('a sample edit can never be steered outside project/', async () => {
  const { ws, viewer, state, ctl } = await pausedGuard()
  try {
    const before = (await state()).stats.edits
    for (const body of [
      { cmd: 'sample', kind: '../../evil' }, { cmd: 'sample', kind: '__proto__' }, { cmd: 'sample', kind: 'constructor' },
      { cmd: 'sample', kind: 'secret', file: '../../evil.js', path: '/tmp/evil.js', name: '../goal.json' },
    ]) await ctl(body)
    assert.deepEqual(readdirSync(ws).sort(), ['.harness', 'goal.json', 'project'], 'nothing new next to project/')
    assert.deepEqual(readdirSync(join(ws, 'project')).sort(), ['sample_config.js', 'score.js', 'test.js'], 'only the fixed sample name was written')
    assert.equal((await state()).stats.edits, before + 1, 'only the one real sample kind was reviewed')
    assert.equal(JSON.parse(readFileSync(join(ws, 'goal.json'), 'utf8')).name, 'Guard Test', 'goal.json is untouched')
  } finally {
    await viewer.close()
  }
})

test('the strictness slider moves where REVIEW and BLOCK start, clamps, and a goal.json edit resets it', async () => {
  const { ws, viewer, state, ctl } = await pausedGuard()
  try {
    const mid = (await state()).thresholds
    await ctl({ cmd: 'set', key: 'strictness', value: 0.9 })
    let s = await state()
    assert.equal(s.cfg.strictness, 0.9)
    assert.ok(s.thresholds.reviewAt < mid.reviewAt && s.thresholds.blockAt < mid.blockAt, 'stricter: both bars come down')
    await ctl({ cmd: 'set', key: 'strictness', value: 0.1 })
    s = await state()
    assert.ok(s.thresholds.reviewAt > mid.reviewAt && s.thresholds.blockAt > mid.blockAt, 'more lenient: both bars go up')
    await ctl({ cmd: 'set', key: 'subtlety', value: 7 })     // clamped down to 1
    await ctl({ cmd: 'set', key: 'stepMs', value: 1 })       // clamped up to 60
    await ctl({ cmd: 'set', key: 'diffBudget', value: 4000 })
    await ctl({ cmd: 'set', key: 'seed', value: 5 })         // not settable from the pane
    s = await state()
    assert.equal(s.cfg.subtlety, 1)
    assert.equal(s.cfg.stepMs, 60)
    assert.equal(s.cfg.diffBudget, 4000)
    assert.equal(s.cfg.seed, 7)
    assert.deepEqual(Object.keys(s.overrides).sort(), ['diffBudget', 'stepMs', 'strictness', 'subtlety'])
    writeFileSync(join(ws, 'goal.json'), JSON.stringify({ name: 'Edited', goal: 'Make project/test.js pass.', strictness: 0.3 }))
    s = await until(async () => { const t = await state(); return t.title === 'Edited' ? t : null })
    assert.ok(s, 'the edit reached the viewer')
    assert.deepEqual(s.overrides, {})
    assert.equal(s.cfg.strictness, 0.3)
    assert.equal(s.cfg.subtlety, 0.35)
  } finally {
    await viewer.close()
  }
})

test('a bad JSON edit keeps the console alive and reports the error', async () => {
  const { ws, viewer, state, ctl } = await pausedGuard({ name: 'Keep Me' })
  try {
    await ctl({ cmd: 'tick', n: 5 })
    writeFileSync(join(ws, 'goal.json'), '{ "name": "Broken", ')
    let s = await until(async () => { const t = await state(); return t.cfgError ? t : null })
    assert.ok(s, 'the parse error is reported')
    assert.match(s.cfgError, /goal\.json/)
    assert.equal(s.title, 'Keep Me', 'the last good goal stands')
    const r = await ctl({ cmd: 'tick', n: 5 })
    assert.equal(r.edits, 10, 'Jev kept reviewing')
    assert.match(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).summary, /needs a fix/)
    writeFileSync(join(ws, 'goal.json'), JSON.stringify({ name: 'Fixed', goal: 'Make project/test.js pass.' }))
    s = await until(async () => { const t = await state(); return t.title === 'Fixed' ? t : null })
    assert.ok(s && s.cfgError === null, 'a good edit clears the error')
  } finally {
    await viewer.close()
  }
})

test('a malformed control body is a 400, not a crash', async () => {
  const { viewer, state } = await pausedGuard()
  try {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal((await state()).stats.edits, 0)
  } finally {
    await viewer.close()
  }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer } = await pausedGuard()
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

test('the difficulty dial is honest: blatant risks are caught, well hidden ones slip by', async () => {
  const run = async (sets) => {
    const { viewer, ctl } = await pausedGuard()
    try {
      for (const [key, value] of Object.entries(sets)) await ctl({ cmd: 'set', key, value })
      return (await ctl({ cmd: 'tick', n: 400 })).stats
    } finally {
      await viewer.close()
    }
  }
  const easy = await run({ subtlety: 0 }), hard = await run({ subtlety: 1 })
  assert.ok(easy.risky >= 80 && hard.risky >= 80, 'both runs faced plenty of planted risks')
  assert.ok(easy.catchRate > 0.95, `easy: caught ${(easy.catchRate * 100).toFixed(0)}% of planted risks`)
  assert.ok(hard.catchRate < 0.75, `hard: ${(hard.catchRate * 100).toFixed(0)}%`)
  assert.ok(easy.catchRate - hard.catchRate > 0.25, `margin ${(easy.catchRate - hard.catchRate).toFixed(2)}`)
  assert.ok(easy.falseAlarmRate < 0.05 && hard.falseAlarmRate < 0.1, 'and it is not done by crying wolf')
  assert.equal(easy.unreadMisses, 0)
  assert.ok(hard.unreadMisses >= 10, `hard: ${hard.unreadMisses} misses were past the end of what Jev got to read`)
  // The cause is real: give Jev more of the diff to read and it catches more of the same edits.
  const tight = await run({ subtlety: 1, diffBudget: 600 }), roomy = await run({ subtlety: 1, diffBudget: 8000 })
  assert.ok(roomy.catchRate - tight.catchRate > 0.3, `reading 8000 chars catches ${(roomy.catchRate * 100).toFixed(0)}%, 600 chars ${(tight.catchRate * 100).toFixed(0)}%`)
})

test('strictness is a real trade: strict catches more hidden risks and raises more false alarms', async () => {
  const run = async (strictness) => {
    const { viewer, ctl } = await pausedGuard()
    try {
      await ctl({ cmd: 'set', key: 'subtlety', value: 1 })
      await ctl({ cmd: 'set', key: 'strictness', value: strictness })
      return (await ctl({ cmd: 'tick', n: 400 })).stats
    } finally {
      await viewer.close()
    }
  }
  const lenient = await run(0.1), strict = await run(0.9)
  assert.ok(strict.catchRate - lenient.catchRate > 0.4, `catch ${(lenient.catchRate * 100).toFixed(0)}% lenient, ${(strict.catchRate * 100).toFixed(0)}% strict`)
  assert.ok(strict.falseAlarmRate - lenient.falseAlarmRate > 0.1, `false alarms ${(lenient.falseAlarmRate * 100).toFixed(0)}% lenient, ${(strict.falseAlarmRate * 100).toFixed(0)}% strict`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const check = join(HERE, '../toolchain/check.mjs')
  const good = mkdtempSync(join(tmpdir(), 'jev-guard-check-'))
  cpSync(join(HERE, '../template'), good, { recursive: true })
  assert.equal(spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: good } }).status, 0)
  const bad = mkdtempSync(join(tmpdir(), 'jev-guard-check-'))
  cpSync(join(HERE, '../template'), bad, { recursive: true })
  writeFileSync(join(bad, 'goal.json'), JSON.stringify({ goal: 'x', strictness: 4 }))
  const r = spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: bad }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /strictness/)
})
