// Viewer integration tests for Jev Compactor. Each test starts the real viewer on a temp workspace
// and drives time with the `tick` control, never with sleeps (except where a file watcher must fire).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startCompactorViewer, compactorMock, normalize, DEFAULT } = await import(join(ROOT, 'viewer/viewer.mjs'))
const { canon, jev } = await import(join(ROOT, 'toolchain/jev.mjs'))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function fresh(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-compactor-test-'))
  const template = JSON.parse(readFileSync(join(ROOT, 'template/session.json'), 'utf8'))
  writeFileSync(join(ws, 'session.json'), JSON.stringify({ ...template, ...overrides }))
  const viewer = await startCompactorViewer({ workspace: ws, port: 0 })
  const ctl = async (cmd, extra = {}) => {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...extra }) })
    return { status: res.status, body: await res.json() }
  }
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  await ctl('pause')
  return { ws, viewer, ctl, state }
}

async function untilCompaction(v, n = 1, max = 4000) {
  for (let i = 0; i < max; i += 20) {
    await v.ctl('tick', { n: 20 })
    const s = await v.state()
    if (s.totals.compactions >= n) return s
  }
  throw new Error('no compaction happened')
}

test('the session advances and Jev judges every tool result when the budget is hit', async () => {
  const v = await fresh()
  try {
    const s0 = await v.state()
    assert.ok(s0.tokens > 0 && s0.blocks.length > 5, 'the window starts partly full')
    await v.ctl('tick', { n: 5 })
    const s1 = await v.state()
    assert.ok(s1.n >= s0.n + 5, 'five ticks add five events')
    // count tool results right before the first compaction fires
    let toolsBefore = 0, s = s1
    while (s.totals.compactions === 0) {
      toolsBefore = s.blocks.filter((b) => b[5] !== 3).length
      await v.ctl('tick')
      s = await v.state()
      assert.ok(s.n < 3000, 'a compaction must fire')
    }
    const last = s.last
    assert.ok(last.before > s.cfg.budget, 'it fired because the window passed the budget')
    assert.ok(last.after < last.before * 0.7, `a real reduction (${last.before} -> ${last.after})`)
    assert.ok(last.questions >= toolsBefore, `one question per tool result (${last.questions} vs ${toolsBefore})`)
    assert.equal(last.keep + last.trim + last.drop, last.questions)
    assert.equal(last.calls, Math.max(1, Math.ceil(last.questions / 100)), 'as few calls as possible, 100 questions per call')
    assert.ok(last.ms >= 0 && last.costUsd > 0)
    assert.ok(last.recall > 0.85, `easy setting keeps the needles (recall ${last.recall})`)
    assert.ok(s.tokens <= s.cfg.budget * s.cfg.target + 1, `the window ends under target x budget (${s.tokens})`)
    assert.equal(s.history.length, 1)
    // every verdict has a real probability distribution, never one-hot
    for (const [, vd] of Object.entries(last.verdicts)) {
      const sum = vd[1] + vd[2] + vd[3]
      assert.ok(Math.abs(sum - 1) < 0.01, 'probabilities sum to 1')
      assert.ok(Math.max(vd[1], vd[2], vd[3]) < 0.999, 'never exactly one-hot')
    }
  } finally { await v.viewer.close() }
})

test('a non-default config really shows up in /state', async () => {
  const tasks = [
    { id: 'alpha', title: 'Tune the alpha pipeline', vocabulary: ['alpha', 'pipeline', 'stage', 'buffer', 'flush', 'batch', 'cursor'] },
    { id: 'beta', title: 'Fix the beta parser', vocabulary: ['beta', 'parser', 'grammar', 'lexer', 'symbol', 'bracket', 'escape'] },
  ]
  const v = await fresh({ title: 'My Session', repo: 'test-repo', budget: 123456, trimTo: 250, distraction: 0.33, target: 0.55, eventsPerSec: 9, tasks, currentTask: 'beta' })
  try {
    const s = await v.state()
    assert.equal(s.title, 'My Session')
    assert.equal(s.repo, 'test-repo')
    assert.equal(s.cfg.budget, 123456)
    assert.equal(s.cfg.trimTo, 250)
    assert.equal(s.cfg.distraction, 0.33)
    assert.equal(s.cfg.target, 0.55)
    assert.equal(s.cfg.eventsPerSec, 9)
    assert.deepEqual(s.tasks.map((t) => t.id), ['alpha', 'beta'])
    assert.equal(s.currentTask, 'beta')
    assert.equal(s.cfgError, null)
    assert.notEqual(s.cfg.budget, DEFAULT.budget)
  } finally { await v.viewer.close() }
})

test('the verdict file is written with spec 1, a summary, findings and phases', async () => {
  const v = await fresh()
  try {
    const file = join(v.ws, '.harness/verdict.json')
    assert.ok(existsSync(file), 'written at start')
    const v0 = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(v0.spec, 1)
    assert.equal(v0.ready, false)
    await untilCompaction(v)
    const v1 = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(v1.spec, 1)
    assert.equal(v1.ready, true)
    assert.ok(typeof v1.summary === 'string' && v1.summary.includes('recall'))
    assert.ok(Array.isArray(v1.findings) && v1.findings.length >= 2)
    assert.ok(v1.findings.some((f) => f.kind === 'baseline' && /not a real product/.test(f.message)), 'the baseline is labelled honestly')
    assert.ok(Array.isArray(v1.phases) && v1.phases.length === 3)
    assert.equal(v1.artifact, 'session.json')
  } finally { await v.viewer.close() }
})

test('every control command answers 200', async () => {
  const v = await fresh()
  try {
    const s = await v.state()
    const tool = s.blocks.find((b) => b[5] !== 3)
    for (const [cmd, extra] of [
      ['pause', {}], ['tick', {}], ['tick', { n: 10 }], ['start', {}], ['pause', {}], ['flood', { n: 10 }], ['compact', {}],
      ['setTask', { task: 'search' }], ['setBudget', { value: 150000 }], ['setDistraction', { value: 0.4 }],
      ['pin', { id: tool[0], pinned: true }], ['inspect', { id: tool[0] }], ['reset', {}], ['unknown-command', {}],
    ]) {
      const r = await v.ctl(cmd, extra)
      assert.equal(r.status, 200, cmd)
      assert.equal(r.body.ok, true, cmd)
    }
    const bad = await fetch(`${v.viewer.url}/control`, { method: 'POST', body: '{not json' })
    assert.equal(bad.status, 400)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the demo alive and reports the error, a good edit clears it', async () => {
  const v = await fresh({ budget: 111000 })
  try {
    writeFileSync(join(v.ws, 'session.json'), '{ "budget": 99999, oops')
    let s = null
    for (let i = 0; i < 60; i++) { await wait(50); s = await v.state(); if (s.cfgError) break }
    assert.ok(s.cfgError, 'the parse error is reported')
    assert.match(s.cfgError, /session\.json/)
    assert.equal(s.cfg.budget, 111000, 'the last good config stays')
    const n = s.n
    await v.ctl('tick', { n: 30 })
    s = await v.state()
    assert.equal(s.n, n + 30, 'the session still advances')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(verdict.findings.some((f) => f.severity === 'error' && f.kind === 'config'))

    const template = JSON.parse(readFileSync(join(ROOT, 'template/session.json'), 'utf8'))
    writeFileSync(join(v.ws, 'session.json'), JSON.stringify({ ...template, budget: 99999 }))
    for (let i = 0; i < 60; i++) { await wait(50); s = await v.state(); if (!s.cfgError && s.cfg.budget === 99999) break }
    assert.equal(s.cfgError, null)
    assert.equal(s.cfg.budget, 99999)
  } finally { await v.viewer.close() }
})

test('out-of-range values are clamped and reported, never crash', async () => {
  const v = await fresh({ budget: 5, distraction: 7, trimTo: 'lots', tasks: [{ id: 'only-one', vocabulary: ['a'] }] })
  try {
    const s = await v.state()
    assert.equal(s.cfg.budget, 20000)
    assert.equal(s.cfg.distraction, 1)
    assert.equal(s.cfg.trimTo, DEFAULT.trimTo)
    assert.equal(s.tasks.length, DEFAULT.tasks.length, 'falls back to the built-in tasks')
    assert.match(s.cfgError, /budget/)
    await v.ctl('tick', { n: 50 })
    assert.ok((await v.state()).n > s.n)
  } finally { await v.viewer.close() }
})

test('a non-loopback Host header gets 403', async () => {
  const v = await fresh()
  try {
    const port = Number(new URL(v.viewer.url).port)
    const ask = (host) => new Promise((resolveP, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
      let data = ''
      sock.on('data', (c) => (data += c))
      sock.on('end', () => resolveP(data))
      sock.on('error', reject)
    })
    assert.match(await ask('evil.example.com'), /^HTTP\/1\.1 403/)
    assert.match(await ask(`127.0.0.1:${port}`), /^HTTP\/1\.1 200/)
  } finally { await v.viewer.close() }
})

test('the difficulty dial: low distraction beats high distraction by a clear margin', async () => {
  const run = async (distraction) => {
    const v = await fresh({ distraction, seed: 11 })
    try { await v.ctl('tick', { n: 1500 }); return (await v.state()).totals } finally { await v.viewer.close() }
  }
  const easy = await run(0.05)
  const hard = await run(0.9)
  console.log(`   easy d=0.05: recall ${(easy.avgRecall * 100).toFixed(1)}% junk removed ${(easy.avgJunkRemoved * 100).toFixed(1)}% reduction ${(easy.avgReduction * 100).toFixed(1)}% over ${easy.compactions} compactions`)
  console.log(`   hard d=0.90: recall ${(hard.avgRecall * 100).toFixed(1)}% junk removed ${(hard.avgJunkRemoved * 100).toFixed(1)}% reduction ${(hard.avgReduction * 100).toFixed(1)}% over ${hard.compactions} compactions`)
  assert.ok(easy.compactions >= 10 && hard.compactions >= 10)
  assert.ok(easy.avgRecall > 0.95, `easy recall is near 100% (${easy.avgRecall})`)
  assert.ok(easy.avgReduction > 0.7, `easy reduction is large (${easy.avgReduction})`)
  assert.ok(easy.avgRecall - hard.avgRecall > 0.06, `hard loses needles (${easy.avgRecall} vs ${hard.avgRecall})`)
  assert.ok(easy.avgJunkRemoved - hard.avgJunkRemoved > 0.1, `hard keeps junk (${easy.avgJunkRemoved} vs ${hard.avgJunkRemoved})`)
  assert.ok(easy.avgReduction - hard.avgReduction > 0.06, `hard cuts less (${easy.avgReduction} vs ${hard.avgReduction})`)
  assert.ok(hard.demoted > easy.demoted * 3, 'the pressure pass works much harder when junk looks like the task')
})

test('the same seed gives the same session', async () => {
  const run = async () => {
    const v = await fresh({ seed: 42 })
    try { await v.ctl('tick', { n: 300 }); const s = await v.state(); return [s.tokens, s.blocks.length, s.totals.compactions, s.baseline.tokens] } finally { await v.viewer.close() }
  }
  const a = await run()
  const b = await run()
  // the timer may add one event before the pause lands, so allow the two runs to be one step apart
  assert.ok(Math.abs(a[1] - b[1]) <= 3 && a[2] === b[2], `${a} vs ${b}`)
})

test('pinned blocks are never dropped or trimmed', async () => {
  const v = await fresh({ distraction: 0 })
  try {
    const s = await v.state()
    const junk = s.blocks.filter((b) => b[5] === 0 && b[4] === -1 && b[2] > 1500).slice(0, 3)
    assert.ok(junk.length >= 1, 'there is junk to pin')
    for (const b of junk) assert.equal((await v.ctl('pin', { id: b[0], pinned: true })).body.pinned, true)
    const after = (await v.ctl('compact')) && (await v.state())
    for (const b of junk) {
      const still = after.blocks.find((x) => x[0] === b[0])
      assert.ok(still, `pinned junk block ${b[0]} survived`)
      assert.equal(still[2], b[2], 'at full size')
      assert.equal(still[6], 1)
    }
    const info = (await v.ctl('inspect', { id: junk[0][0] })).body.block
    assert.equal(info.pinned, true)
    assert.equal(info.verdict, 'keep')
    assert.ok(['drop', 'trim'].includes(info.jev), `Jev itself wanted it gone (${info.jev})`)
    // messages are never touched
    const msgsBefore = s.blocks.filter((b) => b[5] === 3).map((b) => b[0])
    const idsAfter = new Set(after.blocks.map((b) => b[0]))
    for (const id of msgsBefore) assert.ok(idsAfter.has(id), `message ${id} is still there`)
  } finally { await v.viewer.close() }
})

test('switching the task changes what the next compaction keeps', async () => {
  const v = await fresh({ taskEvery: 0 })
  try {
    await v.ctl('tick', { n: 30 })
    await v.ctl('compact')
    let s = await v.state()
    const idx = (id) => s.tasks.findIndex((t) => t.id === id)
    const keptFor = (state, task) => state.blocks.filter((b) => b[5] !== 3 && b[7] === 1 && b[4] === idx(task)).length
    assert.ok(keptFor(s, 'refunds') >= 3, 'refunds blocks are kept while refunds is current')
    assert.equal((await v.ctl('setTask', { task: 'webhooks' })).status, 200)
    await v.ctl('tick', { n: 30 })
    await v.ctl('compact')
    s = await v.state()
    assert.equal(s.currentTask, 'webhooks')
    assert.equal(s.overrides.task, true)
    assert.ok(keptFor(s, 'webhooks') >= 2, 'now webhooks blocks are kept')
    assert.ok(keptFor(s, 'refunds') <= 1, `old refunds blocks are gone (${keptFor(s, 'refunds')} left)`)
    assert.equal(s.last.task, 'webhooks')
  } finally { await v.viewer.close() }
})

test('pane changes are runtime overrides, and an edit to session.json resets them', async () => {
  const v = await fresh({ budget: 200000, distraction: 0.12 })
  try {
    await v.ctl('setBudget', { value: 90000 })
    await v.ctl('setDistraction', { value: 0.77 })
    let s = await v.state()
    assert.equal(s.cfg.budget, 90000)
    assert.equal(s.cfg.distraction, 0.77)
    assert.deepEqual([s.overrides.budget, s.overrides.distraction], [true, true])
    const template = JSON.parse(readFileSync(join(ROOT, 'template/session.json'), 'utf8'))
    writeFileSync(join(v.ws, 'session.json'), JSON.stringify({ ...template, budget: 250000, distraction: 0.2 }))
    for (let i = 0; i < 60; i++) { await wait(50); s = await v.state(); if (s.cfg.budget === 250000) break }
    assert.equal(s.cfg.budget, 250000)
    assert.equal(s.cfg.distraction, 0.2)
    assert.deepEqual([s.overrides.budget, s.overrides.distraction], [false, false])
  } finally { await v.viewer.close() }
})

test('a big window is judged in chunks of at most 100 questions', async () => {
  const v = await fresh({ budget: 700000 })
  try {
    const s = await untilCompaction(v)
    assert.ok(s.last.questions > 100, `more than one call is needed (${s.last.questions} questions)`)
    assert.equal(s.last.calls, Math.ceil(s.last.questions / 100))
    assert.ok(s.last.perCall <= 100)
  } finally { await v.viewer.close() }
})

test('the "summarize instead" lane is tracked with the same ground truth and loses more needles', async () => {
  const v = await fresh({ seed: 5 })
  try {
    await v.ctl('tick', { n: 1200 })
    const s = await v.state()
    assert.ok(s.baseline.compactions >= 5)
    assert.ok(s.baseline.blocks.some((b) => b[1] === 7), 'it holds a summary block')
    assert.ok(s.baseline.avgRecall < 0.75, `folding the oldest half loses needles (${s.baseline.avgRecall})`)
    assert.ok(s.totals.avgRecall - s.baseline.avgRecall > 0.2, `Jev lane ${s.totals.avgRecall} vs baseline ${s.baseline.avgRecall}`)
    assert.ok(s.baseline.tokens <= s.cfg.budget, 'the baseline stays under budget')
  } finally { await v.viewer.close() }
})

test('the mock reads only the state text and the question text', () => {
  const state = ['CURRENT TASK: Fix refund rounding in the ledger', 'TASK KEYWORDS: refund, ledger, rounding, cents, reversal', 'RECENT MESSAGES:', 'user: look at the refund ledger'].join('\n')
  const ask = (text) => compactorMock(state, 'b1', canon(jev.choice({ keep: 'k', trim: 't', drop: 'd' }, text)))
  const code = ask('[Read] src/refund/ledger_cents.ts · 4,210 tokens. Preview: «export function apply_refund(ledger, cents) { const rounding = ledger.reversal(cents); return rounding }» Is this still needed?')
  const log = ask('[Bash] npm test -- refund · 9,000 tokens. Preview: «PASS test/refund/ledger.test.ts ✓ rounding cents ✓ reversal handles refund · Tests: 12 passed · output 900 lines» Is this still needed?')
  const junk = ask('[Bash] npm install · 22,000 tokens. Preview: «npm WARN deprecated inflight@1.0.6 · added 1,423 packages in 41s · postinstall lodash chalk ok» Is this still needed?')
  assert.equal(code.choice, 'keep')
  assert.equal(log.choice, 'trim')
  assert.equal(junk.choice, 'drop')
  for (const a of [code, log, junk]) {
    const p = Object.values(a.probabilities)
    assert.ok(Math.abs(p.reduce((x, y) => x + y, 0) - 1) < 1e-9)
    assert.ok(Math.max(...p) < 0.99 && Math.min(...p) > 0.005, 'a real distribution, never one-hot')
    assert.equal(a.confidence, Math.max(...p))
  }
  assert.equal(compactorMock(state, 'x', canon(jev.noul('anything'))), null, 'other questions fall through to the generic mock')
  assert.equal(normalize({ budget: 1e9 }).cfg.budget, 2000000)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const check = join(ROOT, 'toolchain/check.mjs')
  const ok = spawnSync(process.execPath, [check, join(ROOT, 'template/session.json')], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /ok\s+session\.json is valid/)
  const ws = mkdtempSync(join(tmpdir(), 'jev-compactor-check-'))
  cpSync(join(ROOT, 'template/session.json'), join(ws, 'session.json'))
  const p = JSON.parse(readFileSync(join(ws, 'session.json'), 'utf8'))
  for (const [patch, pattern] of [
    [{ budget: 5000 }, /budget/], [{ distraction: 1.5 }, /distraction/], [{ trimTo: 10 }, /trimTo/], [{ eventsPerSec: 200 }, /eventsPerSec/],
    [{ tasks: [p.tasks[0]] }, /2 to 12/], [{ tasks: [p.tasks[0], { id: 'thin', title: 'Thin', vocabulary: ['one', 'two'] }] }, /at least 6/],
    [{ currentTask: 'nope' }, /currentTask/],
  ]) {
    writeFileSync(join(ws, 'session.json'), JSON.stringify({ ...p, ...patch }))
    const bad = spawnSync(process.execPath, [check], { encoding: 'utf8', env: { ...process.env, HARNESS_WORKSPACE: ws } })
    assert.equal(bad.status, 1, JSON.stringify(patch))
    assert.match(bad.stdout, pattern)
    assert.match(bad.stdout, /fail\s+invalid session\.json/)
  }
})
