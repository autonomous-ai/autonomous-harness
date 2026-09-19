// Viewer integration tests for Jev Firehose. Each test spins up the real viewer against a temp
// workspace. Time is driven with the `tick` control (one decision per tick), never with sleeps,
// except where a test waits for the file watcher or the free-running loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startFirehoseViewer, sanitize, makeMessage, loadDefaults, TRIAGE_COLUMNS } = await import(join(ROOT, 'viewer/viewer.mjs'))
const { loadSource, parseDelimited, csvCell } = await import(join(ROOT, 'viewer/source.mjs'))
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/firehose.json'), 'utf8'))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function fresh(overrides = {}, rawText = null, files = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-firehose-test-'))
  const file = join(ws, 'firehose.json')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(ws, name), text)
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
    assert.equal(s.batch, 321); assert.equal(s.own, false); assert.equal(s.source, null)
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


// ---------------------------------------------------------------------------------------------
// Your-data mode: `source` names a file in the workspace. No generator, no ground truth, and the
// results are handed back as triage.csv. Every message below is made up for the test.
// ---------------------------------------------------------------------------------------------
const OWN_TEAMS = TEMPLATE.teams.map((t) => ({ id: t.id, description: t.description }))   // no phrases on purpose
const OWN = { title: 'My inbox', desk: 'Made-up test inbox.', source: 'inbox.jsonl', threshold: 0.55, ratePerSec: 200, concurrency: 8, teams: OWN_TEAMS }
const BODIES = [
  'my card was charged twice for the same payment', 'the courier lost the package during delivery', 'the lamp arrived broken and I want a replacement',
  'I cannot login, the password reset email never comes', 'the app shows a crash report when I open the cart page', 'please cancel my order, I picked the wrong colour',
  'I want to pause my club subscription for two months', 'we are a reseller and need a bulk quote', 'click this link to claim your prize, lucky winner, free gift', 'hello, a question about something else entirely',
]
const jsonl = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ ticket: `T-${1000 + i}`, customer: `person${i}@example.test`, channel: i % 3 ? 'email' : 'chat', body: BODIES[i % BODIES.length] + (i % 4 === 0 ? ', also the refund for my payment' : '') })).join('\n') + '\n'
const readCsv = (ws) => parseDelimited(readFileSync(join(ws, 'triage.csv'), 'utf8'), ',')
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await wait(60) } }

test('your data: a jsonl file is loaded, triaged once, and handed back as triage.csv', async () => {
  const v = await fresh(OWN, null, { 'inbox.jsonl': jsonl(60) })
  try {
    let s = await v.state()
    assert.equal(s.own, true)
    assert.equal(s.error, null)
    assert.deepEqual({ name: s.source.name, textColumn: s.source.textColumn, idColumn: s.source.idColumn, used: s.source.used }, { name: 'inbox.jsonl', textColumn: 'body', idColumn: 'ticket', used: 60 })
    assert.equal(s.stats.batch, 60, 'the batch is the file, not the batch setting')
    assert.equal(s.batch, 60, 'the pane is told the real size of the run')
    assert.deepEqual(s.warnings, [], 'teams need no phrases when a source is set')
    await v.hold()
    const t = await v.ctl('tick', { n: 60 })
    assert.equal(t.body.did, 60)
    s = await v.state()
    assert.equal(s.phase, 'done')
    assert.equal(s.summary.own, true); assert.equal(s.summary.messages, 60); assert.equal(s.summary.output, 'triage.csv')
    const rows = readCsv(v.ws)
    assert.deepEqual(rows[0], [...TRIAGE_COLUMNS, 'customer', 'channel', 'body'], 'header: the triage columns, then the file\'s own columns')
    assert.deepEqual(TRIAGE_COLUMNS, ['id', 'team', 'team_confidence', 'urgency', 'spam', 'needs_human', 'mood', 'escalated'])
    assert.equal(rows.length, 61, 'one line per message, plus the header')
    assert.deepEqual(rows.slice(1).map((r) => r[0]), Array.from({ length: 60 }, (_, i) => `T-${1000 + i}`), 'the file\'s own ids, in the file\'s order')
    const ids = new Set(OWN_TEAMS.map((x) => x.id))
    for (const r of rows.slice(1)) {
      assert.ok(ids.has(r[1]), `team ${r[1]}`); assert.ok(Number(r[2]) > 0 && Number(r[2]) <= 1)
      assert.ok(['no_rush', 'this_week', 'today', 'urgent', 'emergency'].includes(r[3])); assert.ok(['calm', 'annoyed', 'furious'].includes(r[6]))
      for (const k of [4, 5, 7]) assert.ok(['yes', 'no'].includes(r[k]))
    }
    assert.equal(rows[1][1], 'billing'); assert.equal(rows[2][1], 'shipping'); assert.equal(rows[9][4], 'yes', 'the prize message is flagged as spam')
    assert.equal(rows[1][10], BODIES[0] + ', also the refund for my payment', 'the original text rides along untouched')
    // processed once: it does not loop
    assert.equal((await v.ctl('tick', { n: 5 })).body.did, 0)
    assert.equal((await v.state()).n, 60)
    const again = await v.ctl('again')
    assert.equal(again.status, 200)
    s = await v.state()
    assert.equal(s.phase, 'run'); assert.equal(s.n < 60, true)
  } finally { await v.viewer.close() }
})

test('your data: a csv file with quotes, commas, line breaks and a clashing column survives the round trip', async () => {
  const nasty = 'He said "hi", then\nleft, twice'
  const csv = ['id,subject,message,team', '7,"Refund, please","my card was charged twice, the refund for my payment is missing",old-team', `8,Broken,${csvCell(nasty + ' the lamp arrived broken and I want a replacement')},`, '9,Empty,,x', '10,Parcel,"the courier lost the package during delivery"," padded "'].join('\r\n') + '\r\n'
  const v = await fresh({ ...OWN, source: 'mail.csv' }, null, { 'mail.csv': csv })
  try {
    const s = await v.state()
    assert.equal(s.own, true)
    assert.equal(s.source.textColumn, 'message'); assert.equal(s.source.idColumn, 'id'); assert.equal(s.source.used, 3); assert.equal(s.source.skipped, 1)
    await v.hold(); await v.ctl('tick', { n: 10 })
    const rows = readCsv(v.ws)
    assert.deepEqual(rows[0], [...TRIAGE_COLUMNS, 'subject', 'message', 'source_team'], 'a column called team is renamed, never dropped')
    assert.deepEqual(rows.slice(1).map((r) => r[0]), ['7', '8', '10'], 'the row with no text is skipped')
    assert.equal(rows[1][8], 'Refund, please'); assert.equal(rows[1][10], 'old-team')
    assert.equal(rows[2][9], nasty + ' the lamp arrived broken and I want a replacement', 'quotes, commas and a line break come back exactly')
    assert.equal(rows[3][10], ' padded ', 'outer spaces are kept')
    assert.equal(rows[1][1], 'billing'); assert.equal(rows[2][1], 'returns'); assert.equal(rows[3][1], 'shipping')
  } finally { await v.viewer.close() }
})

test('your data: a source outside the workspace is refused and nothing is written', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'jev-firehose-outside-'))
  writeFileSync(join(outside, 'secret.csv'), 'text\nthis must never be read\n')
  for (const source of [`../${outside.split('/').pop()}/secret.csv`, join(outside, 'secret.csv'), '.harness/x.jsonl', 'triage.csv', 'notes.txt']) {
    const v = await fresh({ ...OWN, source }, null, { 'triage.csv': 'mine\n', 'notes.txt': 'x\n' })
    try {
      const s = await v.state()
      assert.equal(s.own, false, source)
      assert.ok(s.error, `an error is shown for ${source}`)
      assert.match(s.error, /inside the workspace|\.harness|results are written|must be a \.csv/)
      assert.equal(s.source, null)
      await v.hold()
      assert.equal((await v.ctl('tick', { n: 5 })).body.did, 5, 'the synthetic desk keeps the pane alive')
      assert.equal(readFileSync(join(v.ws, 'triage.csv'), 'utf8'), 'mine\n', 'an existing triage.csv is not touched')
      const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
      assert.equal(verdict.ready, false); assert.ok(verdict.findings.some((f) => f.kind === 'source' && f.severity === 'error')); assert.equal(verdict.triage, undefined)
    } finally { await v.viewer.close() }
  }
  const direct = loadSource(outside, '../etc/passwd.csv')
  assert.equal(direct.rows.length, 0); assert.match(direct.error, /inside the workspace/)
})

test('your data: moving the threshold re-buckets and rewrites triage.csv', async () => {
  const v = await fresh({ ...OWN, threshold: 0.3 }, null, { 'inbox.jsonl': jsonl(120) })
  try {
    await v.hold(); await v.ctl('tick', { n: 120 })
    const yes = () => readCsv(v.ws).slice(1).filter((r) => r[7] === 'yes').length
    const before = yes(), loose = (await v.state()).stats
    assert.equal(before, loose.escalated)
    const strict = (await v.ctl('threshold', { value: 0.9 })).body.stats
    assert.ok(strict.escalated > loose.escalated + 10, `escalated ${loose.escalated} -> ${strict.escalated}`)
    assert.equal(await until(() => yes() === strict.escalated), true, 'the file on disk follows the slider')
    assert.equal(readCsv(v.ws).length, 121, 'still one line per message')
    const s = await v.state()
    assert.equal(s.summary.escalated, strict.escalated, 'the kept summary card shows the new split')
    const verdict = await until(() => { const x = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8')); return x.triage?.escalated === strict.escalated ? x : null })
    assert.equal(verdict.triage.path, 'triage.csv'); assert.equal(verdict.triage.file, join(v.ws, 'triage.csv')); assert.equal(verdict.triage.complete, true)
    assert.equal(verdict.triage.messages, 120); assert.equal(verdict.triage.done, 120); assert.equal(verdict.triage.threshold, 0.9)
    assert.equal(Object.values(verdict.triage.teams).reduce((a, b) => a + b, 0) + verdict.triage.spam + verdict.triage.escalated, 120, 'the counts add up')
    assert.match(verdict.summary, /your data .* results in triage\.csv/)
  } finally { await v.viewer.close() }
})

test('your data: there is no ground truth, so no accuracy anywhere', async () => {
  const v = await fresh(OWN, null, { 'inbox.jsonl': jsonl(80) })
  try {
    await v.hold(); await v.ctl('tick', { n: 80 })
    const s = await v.state()
    for (const k of ['accuracy', 'right', 'binRight', 'recentAccuracy']) assert.equal(k in s.stats, false, `stats.${k}`)
    assert.equal(s.suggested, null)
    assert.equal('accuracy' in s.summary, false); assert.equal('right' in s.summary, false)
    assert.ok(s.stats.meanConfidence > 0 && s.stats.routedPct > 0)
    const rec = (await v.ctl('inspect', { id: 5 })).body.record
    assert.equal(rec.own, true); assert.equal('right' in rec, false); assert.equal('truth' in rec, false)
    assert.equal(rec.sourceId, 'T-1005'); assert.ok(rec.text.length > 5); assert.deepEqual(Object.keys(rec.answers), ['team', 'urgency', 'spam', 'needs_human', 'mood'])
    const sweep = (await v.ctl('sweep')).body.sweep
    assert.equal('accuracy' in sweep[50], false); assert.ok(sweep[90].escalatedPct >= sweep[10].escalatedPct)
    const bin = (await v.ctl('bin', { bucket: 0 })).body
    assert.equal(bin.own, true); assert.ok(bin.most.confidence >= bin.least.confidence, 'most and least confident message of the team')
    assert.equal('right' in bin.list[0], false)
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(/\bright\b/.test(JSON.stringify(verdict.findings)), false, 'the verdict claims no accuracy')
  } finally { await v.viewer.close() }
})

test('your data: the free-running loop finishes the file, stops, and keeps the summary', async () => {
  const v = await fresh({ ...OWN, ratePerSec: 400 }, null, { 'inbox.jsonl': jsonl(90) })
  try {
    const s = await until(async () => { const x = await v.state(); return x.phase === 'done' ? x : null }, 6000)
    assert.ok(s, 'the file finishes on its own')
    assert.equal(s.n, 90)
    await wait(3600)   // longer than the synthetic summary pause: it must NOT start another batch
    const later = await v.state()
    assert.equal(later.phase, 'done'); assert.equal(later.n, 90); assert.equal(later.batchNo, 1)
    assert.equal(readCsv(v.ws).length, 91)
  } finally { await v.viewer.close() }
})

test('the loader never throws, caps the file, and csv cells are quoted properly', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-firehose-loader-'))
  writeFileSync(join(ws, 'bad.jsonl'), '{"text":"fine"}\n{not json\n')
  assert.match(loadSource(ws, 'bad.jsonl').error, /could not be parsed/)
  assert.match(loadSource(ws, 'missing.csv').error, /cannot be read/)
  assert.match(loadSource(ws, 42).error, /file name/)
  writeFileSync(join(ws, 'list.json'), JSON.stringify(['first message', { note: 'second message', n: 7, nested: { a: 1 } }, 5]))
  const list = loadSource(ws, 'list.json', { textColumn: 'note' })
  assert.equal(list.error, null); assert.deepEqual(list.rows.map((r) => r.text), ['first message', 'second message'], 'a bare string is a message, a bare number is skipped')
  assert.deepEqual(list.rows[0].cells, ['first message', '', ''], 'a bare string lands in the text column')
  assert.deepEqual(list.rows[1].cells, ['second message', '7', '{"a":1}'], 'other values are kept as they were')
  writeFileSync(join(ws, 'many.tsv'), 'text\tn\n' + Array.from({ length: 50 }, (_, i) => `message ${i}\t${i}`).join('\n'))
  const capped = loadSource(ws, 'many.tsv', { limit: 20 })
  assert.equal(capped.rows.length, 20); assert.equal(capped.info.truncated, true); assert.equal(capped.rows[19].id, '20', 'row numbers when the file has no id column')
  assert.match(loadSource(ws, 'many.tsv', { textColumn: 'nope' }).error, /not a column/)
  assert.equal(csvCell('plain'), 'plain'); assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('two\nlines'), '"two\nlines"'); assert.equal(csvCell(null), '')
})

test('check.mjs and measure.mjs accept a source', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-firehose-check-own-'))
  writeFileSync(join(ws, 'inbox.jsonl'), jsonl(40))
  const run = (tool, cfg, args = []) => { writeFileSync(join(ws, 'firehose.json'), JSON.stringify(cfg)); return spawnSync(process.execPath, [join(ROOT, 'toolchain', tool), ...args], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) }
  const good = run('check.mjs', OWN)
  assert.equal(good.status, 0, good.stdout)
  assert.match(good.stdout, /source inbox\.jsonl: 40 messages, text column "body", id column "ticket"/)
  const escape = run('check.mjs', { ...OWN, source: '../../etc/hosts.csv' })
  assert.equal(escape.status, 1); assert.match(escape.stdout, /inside the workspace/)
  const wrongCol = run('check.mjs', { ...OWN, textColumn: 'nope' })
  assert.equal(wrongCol.status, 1); assert.match(wrongCol.stdout, /not a column/)
  const m = run('measure.mjs', OWN, ['--n', '40'])
  assert.equal(m.status, 0, m.stdout + m.stderr)
  assert.match(m.stdout, /40 of 40 of your messages/); assert.match(m.stdout, /no accuracy/); assert.match(m.stdout, /escalated/); assert.match(m.stdout, /least confident/)
  assert.equal(/my card was charged/.test(m.stdout), false, 'measure prints ids, not the person\'s text')
})

test('triage.csv never turns a message into a spreadsheet formula', async () => {
  const { csvCell } = await import('../viewer/source.mjs')
  assert.equal(csvCell('=HYPERLINK("http://evil.example","click")'), `"'=HYPERLINK(""http://evil.example"",""click"")"`)
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('+1 555 0100'), "'+1 555 0100")
  assert.equal(csvCell('-5'), '-5')
  assert.equal(csvCell('+1.5'), '+1.5')
  assert.equal(csvCell('plain text'), 'plain text')
})
