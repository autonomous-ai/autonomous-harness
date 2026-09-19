// Viewer integration tests for Jev Firehose. Each test spins up the real viewer against a temp
// workspace. Time is driven with the `tick` control (one decision per tick), never with sleeps,
// except where a test waits for the file watcher or the free-running loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startFirehoseViewer, sanitize, makeMessage, loadDefaults } = await import(join(ROOT, 'viewer/viewer.mjs'))
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/firehose.json'), 'utf8'))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function fresh(overrides = {}, rawText = null) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-firehose-test-'))
  const file = join(ws, 'firehose.json')
  writeFileSync(file, rawText ?? JSON.stringify({ ...TEMPLATE, ...overrides }))
  const viewer = await startFirehoseViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const state = async () => (await fetch(`${base}/state`)).json()
  const ctl = async (cmd, extra = {}) => {
    const res = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...extra }) })
    return { status: res.status, body: await res.json() }
  }
  /** Stop the free-running loop and start from a clean batch, so `tick` alone moves time. */
  const hold = async () => { await ctl('pause'); await ctl('reset') }
  return { ws, file, viewer, base, state, ctl, hold }
}

test('the loop advances on its own and Jev answers five questions per message', async () => {
  const v = await fresh()
  try {
    let s
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) { s = await v.state(); if (s.n >= 5) break; await wait(60) }
    assert.ok(s.n >= 5, 'expected the stream to move without any input')
    assert.equal(s.running, true)
    assert.deepEqual(s.questions, ['team', 'urgency', 'spam', 'needs_human', 'mood'])
    const a = s.last.answers
    assert.ok(s.teams.map((t) => t.id).includes(a.team.choice), 'team answer is one of the configured teams')
    assert.ok(a.team.confidence > 0 && a.team.confidence <= 1)
    const sum = Object.values(a.team.probabilities).reduce((x, y) => x + y, 0)
    assert.ok(Math.abs(sum - 1) < 0.02, 'team probabilities are a distribution')
    assert.ok(Math.max(...Object.values(a.team.probabilities)) < 1, 'never exactly one-hot')
    assert.equal(a.urgency.type, 'score'); assert.equal(a.mood.type, 'score')
    assert.ok(a.spam.noul >= 0 && a.spam.noul <= 1); assert.ok(a.needs_human.noul >= 0 && a.needs_human.noul <= 1)
    assert.ok(s.costUsd > 0 && s.tokens > 0, 'cost is metered')
    assert.equal(s.stats.done, s.n)
    assert.equal(s.stats.answers, s.n * 5)
    assert.equal(s.client, 'mock')
  } finally { await v.viewer.close() }
})

test('config from firehose.json really shows up in /state', async () => {
  const teams = [
    { id: 'brakes', description: 'Brake pads, rotor, lever, squeal, hydraulic bleed.', phrases: ['my brake lever is soft after the bleed', 'the rotor rubs the brake pads', 'hydraulic brake squeal on the rotor', 'new pads but the lever still pulls to the bar'] },
    { id: 'wheels', description: 'Wheel, tyre, tube, puncture, spoke, rim.', phrases: ['a spoke broke and the rim is bent', 'the tyre keeps losing air, maybe the tube', 'puncture again on the rear wheel', 'the rim tape moved and cut the tube'] },
    { id: 'fitting', description: 'Bike fit: saddle height, reach, stem, handlebar, knee pain.', phrases: ['knee pain since I raised the saddle', 'the reach feels long, do I want a shorter stem', 'handlebar width for my fit', 'saddle height after the new stem'] },
  ]
  const v = await fresh({ title: 'Spoke & Chain', desk: 'A made-up bike shop.', noise: 0.33, threshold: 0.61, targetAccuracy: 0.9, ratePerSec: 77, concurrency: 3, batch: 321, llmSecondsPerItem: 5, spamRate: 0.2, seed: 99, teams })
  try {
    const s = await v.state()
    assert.equal(s.title, 'Spoke & Chain')
    assert.equal(s.noise, 0.33); assert.equal(s.threshold, 0.61)
    assert.deepEqual(s.config, { noise: 0.33, threshold: 0.61, targetAccuracy: 0.9, ratePerSec: 77, concurrency: 3, batch: 321, llmSecondsPerItem: 5, spamRate: 0.2, seed: 99 })
    assert.deepEqual(s.teams.map((t) => t.id), ['brakes', 'wheels', 'fitting'])
    assert.equal(s.stats.batch, 321)
    assert.deepEqual(s.warnings, [])
    await v.hold()
    const t = await v.ctl('tick', { n: 40 })
    assert.equal(t.body.did, 40)
    assert.ok(['brakes', 'wheels', 'fitting'].includes(t.body.last.answers.team.choice))
    assert.equal(t.body.stats.bins.length, 3 + 2, 'one bin per team, plus spam, plus the escalate lane')
  } finally { await v.viewer.close() }
})

test('the verdict file is written with spec 1, a summary, findings and phases', async () => {
  const v = await fresh()
  try {
    await v.hold()
    await v.ctl('tick', { n: 120 })
    const file = join(v.ws, '.harness/verdict.json')
    assert.ok(existsSync(file))
    const verdict = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(verdict.spec, 1)
    assert.equal(verdict.ready, true)
    assert.match(verdict.summary, /synthetic messages/)
    assert.ok(Array.isArray(verdict.findings) && verdict.findings.length >= 2)
    assert.ok(verdict.findings.some((f) => f.kind === 'threshold'), 'reports the lowest threshold that meets the target')
    assert.ok(Array.isArray(verdict.phases) && verdict.phases.length === 3)
    assert.equal(verdict.artifact, 'firehose.json')
  } finally { await v.viewer.close() }
})

test('every control command answers 200', async () => {
  const v = await fresh()
  try {
    for (const [cmd, extra] of [['pause'], ['tick'], ['tick', { n: 25 }], ['threshold', { value: 0.7 }], ['noise', { value: 0.5 }], ['burst', { n: 100 }], ['inspect', { id: 3 }], ['bin', { bucket: 0 }], ['sweep'], ['clearOverrides'], ['start'], ['reset'], ['no-such-command']]) {
      const r = await v.ctl(cmd, extra)
      assert.equal(r.status, 200, cmd)
      assert.equal(r.body.ok, true, cmd)
    }
    const bad = await fetch(`${v.base}/control`, { method: 'POST', body: '{nope' })
    assert.equal(bad.status, 400)
  } finally { await v.viewer.close() }
})

test('inspect returns the message text, every answer and the truth', async () => {
  const v = await fresh()
  try {
    await v.hold()
    await v.ctl('tick', { n: 30 })
    const { body } = await v.ctl('inspect', { id: 12 })
    const r = body.record
    assert.equal(r.id, 12)
    assert.ok(r.text.length > 20 && Array.isArray(r.parts))
    assert.deepEqual(Object.keys(r.answers), ['team', 'urgency', 'spam', 'needs_human', 'mood'])
    assert.ok(Number.isInteger(r.truth) && Number.isInteger(r.bucket))
    assert.ok([true, false, null].includes(r.right))
    const bin = await v.ctl('bin', { bucket: r.bucket })
    assert.ok(bin.body.list.length >= 1)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the demo alive and reports the error; a good edit clears it', async () => {
  const v = await fresh({ noise: 0.1 })
  try {
    await v.hold()
    await v.ctl('tick', { n: 10 })
    writeFileSync(v.file, '{ "noise": 0.9, oops')
    let s
    for (let i = 0; i < 40; i++) { s = await v.state(); if (s.error) break; await wait(75) }
    assert.ok(s.error, 'the parse error is reported')
    assert.match(s.error, /firehose\.json/)
    assert.equal(s.noise, 0.1, 'the last good config still runs')
    const t = await v.ctl('tick', { n: 10 })
    assert.equal(t.body.did, 10, 'the stream still advances')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, noise: 0.6 }))
    for (let i = 0; i < 40; i++) { s = await v.state(); if (!s.error && s.noise === 0.6) break; await wait(75) }
    assert.equal(s.error, null)
    assert.equal(s.noise, 0.6)
  } finally { await v.viewer.close() }
})

test('a file edit resets the pane overrides', async () => {
  const v = await fresh({ noise: 0.1, threshold: 0.5 })
  try {
    await v.hold()
    await v.ctl('noise', { value: 0.77 }); await v.ctl('threshold', { value: 0.88 })
    let s = await v.state()
    assert.equal(s.noise, 0.77); assert.equal(s.threshold, 0.88)
    assert.deepEqual(s.overrides, { noise: true, threshold: true })
    assert.equal(s.config.noise, 0.1, 'the file value is still known')
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, noise: 0.25, threshold: 0.45 }))
    for (let i = 0; i < 40; i++) { s = await v.state(); if (s.noise === 0.25) break; await wait(75) }
    assert.equal(s.noise, 0.25); assert.equal(s.threshold, 0.45)
    assert.deepEqual(s.overrides, { noise: false, threshold: false })
  } finally { await v.viewer.close() }
})

test('out-of-range values are clamped and reported, never fatal', async () => {
  const v = await fresh({ noise: 7, ratePerSec: 99999, concurrency: 0, batch: 3, teams: [{ id: 'only-one', description: 'x', phrases: ['a'] }] })
  try {
    const s = await v.state()
    assert.equal(s.noise, 1); assert.equal(s.config.ratePerSec, 400); assert.equal(s.config.concurrency, 1); assert.equal(s.config.batch, 50)
    assert.ok(s.teams.length >= 2, 'falls back to the starter desk when fewer than 2 teams are usable')
    assert.ok(s.warnings.length >= 4)
  } finally { await v.viewer.close() }
  const { cfg, warnings } = sanitize({ ...loadDefaults(), threshold: -2, spamRate: 3 })
  assert.equal(cfg.threshold, 0); assert.equal(cfg.spamRate, 0.5); assert.equal(warnings.length, 2)
})

test('a non-loopback Host header gets 403', async () => {
  const v = await fresh()
  try {
    const port = Number(new URL(v.base).port)
    const ask = (host) => new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
      let buf = ''
      sock.on('data', (d) => { buf += d })
      sock.on('end', () => resolve(buf.split('\r\n')[0]))
      sock.on('error', reject)
    })
    assert.match(await ask('evil.example.com'), / 403 /)
    assert.match(await ask(`127.0.0.1:${port}`), / 200 /)
  } finally { await v.viewer.close() }
})

test('the noise dial is honest: low noise is accurate with few escalations, high noise is not', async () => {
  const run = async (noise) => {
    const v = await fresh({ noise, threshold: 0.55, batch: 1000 })
    try {
      await v.hold()
      const t = await v.ctl('tick', { n: 400 })
      assert.equal(t.body.did, 400)
      return t.body.stats
    } finally { await v.viewer.close() }
  }
  const easy = await run(0.05), hard = await run(0.85)
  console.log(`      noise 0.05: ${(easy.accuracy * 100).toFixed(1)}% right, ${(easy.escalatedPct * 100).toFixed(1)}% escalated | noise 0.85: ${(hard.accuracy * 100).toFixed(1)}% right, ${(hard.escalatedPct * 100).toFixed(1)}% escalated`)
  assert.ok(easy.accuracy > 0.9, `easy accuracy ${easy.accuracy}`)
  assert.ok(easy.escalatedPct < 0.1, `easy escalations ${easy.escalatedPct}`)
  assert.ok(hard.accuracy < easy.accuracy - 0.2, `hard accuracy ${hard.accuracy} should fall well below easy ${easy.accuracy}`)
  assert.ok(hard.escalatedPct > easy.escalatedPct + 0.1, `hard escalations ${hard.escalatedPct} should rise well above easy ${easy.escalatedPct}`)
})

test('noise only adds wrong-team phrases, never more than the true ones', () => {
  const { cfg } = sanitize(loadDefaults())
  let a = 1
  const rng = () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296 }
  let low = 0, high = 0
  for (let i = 0; i < 500; i++) {
    const lo = makeMessage(cfg, rng, 0.05), hi = makeMessage(cfg, rng, 0.95)
    for (const m of [lo, hi]) { assert.ok(m.nNoise <= m.nTrue || m.spam); assert.ok(m.text.length > 10); if (!m.spam) assert.ok(m.truth >= 0 && m.truth < cfg.teams.length) }
    low += lo.nNoise; high += hi.nNoise
  }
  assert.ok(high > low * 4, `noise phrases: low ${low}, high ${high}`)
})

test('the threshold re-buckets messages that were already routed', async () => {
  const v = await fresh({ noise: 0.5, threshold: 0.3, batch: 1000 })
  try {
    await v.hold()
    const loose = (await v.ctl('tick', { n: 300 })).body.stats
    const strict = (await v.ctl('threshold', { value: 0.8 })).body.stats
    assert.equal(loose.done, 300); assert.equal(strict.done, 300)
    assert.equal(loose.routed + loose.escalated, 300); assert.equal(strict.routed + strict.escalated, 300)
    assert.ok(strict.escalated > loose.escalated + 30, `escalated ${loose.escalated} -> ${strict.escalated}`)
    assert.ok(strict.accuracy > loose.accuracy, `accuracy ${loose.accuracy} -> ${strict.accuracy}`)
    assert.equal(strict.bins.reduce((x, y) => x + y, 0), 300, 'every message is in exactly one bucket')
    const back = (await v.ctl('threshold', { value: 0.3 })).body.stats
    assert.deepEqual(back.bins, loose.bins, 'moving the threshold back restores the same buckets')
    const sweep = (await v.ctl('sweep')).body.sweep
    assert.equal(sweep.length, 101)
    assert.ok(sweep[90].escalatedPct >= sweep[10].escalatedPct)
  } finally { await v.viewer.close() }
})

test('it never ends: a batch finishes with a summary, then the next batch starts with a new seed', async () => {
  const v = await fresh({ batch: 60, noise: 0.1 })
  try {
    await v.hold()
    await v.ctl('tick', { n: 60 })
    let s = await v.state()
    assert.equal(s.phase, 'summary')
    assert.equal(s.summary.messages, 60)
    assert.equal(s.summary.batchNo, 1)
    assert.ok(s.summary.costUsd > 0 && s.summary.accuracy > 0.5)
    const firstText = (await v.ctl('inspect', { id: 0 })).body.record.text
    await v.ctl('tick', { n: 1 })
    s = await v.state()
    assert.equal(s.phase, 'run'); assert.equal(s.batchNo, 2); assert.equal(s.n, 1)
    assert.equal(s.totals.batches, 1); assert.equal(s.totals.messages, 60)
    assert.notEqual((await v.ctl('inspect', { id: 0 })).body.record.text, firstText, 'a new seed gives new messages')
    // and on its own clock: run free, the summary clears itself after about three seconds
    await v.ctl('burst', { n: 200 }); await v.ctl('start')
    const deadline = Date.now() + 9000
    let sawSummary = false, sawNext = false
    while (Date.now() < deadline && !sawNext) { s = await v.state(); if (s.phase === 'summary') sawSummary = true; if (sawSummary && s.phase === 'run' && s.batchNo >= 3) sawNext = true; await wait(100) }
    assert.ok(sawSummary && sawNext, 'summary shows, then the next batch starts by itself')
  } finally { await v.viewer.close() }
})

test('the same seed gives the same stream', async () => {
  const texts = []
  for (let k = 0; k < 2; k++) {
    const v = await fresh({ seed: 4242 })
    try { await v.hold(); await v.ctl('tick', { n: 20 }); texts.push((await v.ctl('inspect', { id: 19 })).body.record.text) } finally { await v.viewer.close() }
  }
  assert.equal(texts[0], texts[1])
})

test('check.mjs accepts the template and rejects out-of-range values', () => {
  const run = (cfg) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-firehose-check-'))
    writeFileSync(join(ws, 'firehose.json'), JSON.stringify(cfg))
    return spawnSync(process.execPath, [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' })
  }
  const good = run(TEMPLATE)
  assert.equal(good.status, 0, good.stdout)
  assert.match(good.stdout, /ok\s+firehose\.json is valid/)
  const bad = run({ ...TEMPLATE, noise: 1.4, concurrency: 200, teams: TEMPLATE.teams.slice(0, 1) })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /noise is 1\.4/); assert.match(bad.stdout, /concurrency is 200/); assert.match(bad.stdout, /teams has 1 entries/)
  const thin = run({ ...TEMPLATE, teams: [{ id: 'a', description: 'Alpha things.', phrases: ['one', 'two'] }, TEMPLATE.teams[0]] })
  assert.equal(thin.status, 1); assert.match(thin.stdout, /needs at least 4/)
})
