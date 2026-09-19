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

// ---------------------------------------------------------------------------
// The person's own transcript ("source"). Every transcript below is made up.
// ---------------------------------------------------------------------------
const { parseTranscript, resolveSource, loadTranscript } = await import(join(ROOT, 'viewer/transcript.mjs'))
const { symlinkSync, mkdirSync, readdirSync } = await import('node:fs')

const big = (word, n) => Array.from({ length: n }, (_, i) => `${word} handles ${word}_${i % 7}(${word})`).join('\n')
const CLAUDE_LINES = [
  JSON.stringify({ type: 'summary', summary: 'made-up session' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please fix the webhook retry backoff so failed delivery attempts use jitter.' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will read the webhook retry code.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/app/src/webhook/retry_backoff.ts' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `export function retry_webhook(delivery) { const backoff = jitter(delivery); return backoff }\n${big('webhook', 200)}` }] } }),
  '{ this is not json',
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm install', description: 'Install' } }, { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'backoff', path: 'src/' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: `12 matches for backoff in src/webhook/retry.ts delivery jitter\n${big('match', 80)}` }] }, { type: 'tool_result', tool_use_id: 't2', content: `npm WARN deprecated inflight@1.0.6 · added 1,423 packages\n${big('lodash', 900)}` }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent thread' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'mcp__tracker__get_issue', input: { query: 'login cookie' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: big('cookie', 300) }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'Edit', input: { file_path: '/work/app/src/orphan.ts', old_string: 'a', new_string: 'b' } }] } }),
  'also not json',
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>made-up</system-reminder>' } }),
]
const GENERIC_LINES = [
  JSON.stringify({ role: 'user', content: 'Speed up the invoice search query and its index.' }),
  JSON.stringify({ role: 'assistant', content: 'Looking at the search index.' }),
  JSON.stringify({ role: 'tool', name: 'Read', input: { file_path: 'src/search/invoice_index.ts' }, content: `export function search_invoice(query) { const index = query.index; return index }\n${big('invoice', 120)}` }),
  JSON.stringify({ role: 'tool', name: 'Bash', input: 'docker build .', content: `#12 DEBUG cache hit layer sha256\n${big('layer', 700)}` }),
  JSON.stringify({ role: 'tool', content: 'a result with no tool name' }),
  'garbage line',
  JSON.stringify({ role: 'system', content: 'ignored role' }),
]
const SECRETS = ['npm WARN deprecated', 'retry_webhook(delivery)', 'Please fix the webhook']

async function freshOwn(lines, overrides = {}, file = 'my-session.jsonl') {
  const ws = mkdtempSync(join(tmpdir(), 'jev-compactor-own-'))
  const template = JSON.parse(readFileSync(join(ROOT, 'template/session.json'), 'utf8'))
  if (lines) writeFileSync(join(ws, file), lines.join('\n') + '\n')
  writeFileSync(join(ws, 'session.json'), JSON.stringify({ ...template, source: file, ...overrides }))
  const viewer = await startCompactorViewer({ workspace: ws, port: 0 })
  const ctl = async (cmd, extra = {}) => {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...extra }) })
    return { status: res.status, body: await res.json() }
  }
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  await ctl('pause')   // also cancels the automatic first compaction, so tests decide when it runs
  return { ws, viewer, ctl, state }
}

test('own transcript: a Claude Code style file parses, tool_use pairs with tool_result, bad lines are skipped', () => {
  const { blocks, stats } = parseTranscript(CLAUDE_LINES.join('\n'))
  assert.equal(stats.skipped, 2, 'two lines are not JSON')
  assert.equal(stats.ignored, 2, 'the summary line and the sub-agent line are not part of this context')
  assert.equal(stats.toolResults, 4)
  assert.equal(stats.unpairedUses, 1, 'the Edit call has no result in the file')
  const tools = blocks.filter((b) => b.role === 'tool')
  assert.deepEqual(tools.map((b) => [b.tool, b.kind]), [['Read', 'Read'], ['Bash', 'Bash'], ['Grep', 'Grep'], ['mcp__tracker__get_issue', 'Tool'], ['Edit', 'Edit']])
  assert.equal(tools[0].input, '/work/app/src/webhook/retry_backoff.ts')
  assert.equal(tools[1].input, 'npm install')
  assert.equal(tools[2].input, 'backoff in src/')
  // results arrive out of order (t3 before t2) and still land on the right call
  assert.match(tools[1].preview, /^npm WARN deprecated/)
  assert.match(tools[2].preview, /^12 matches for backoff/)
  assert.ok(tools[1].tokens > tools[2].tokens && tools[1].tokens > 3000, 'tokens are characters / 4')
  assert.equal(tools[0].tokens, Math.ceil(tools[0].chars / 4))
  assert.ok(tools.every((b) => b.preview.length <= 300), 'only a short head is kept')
  const users = blocks.filter((b) => b.role === 'user')
  assert.equal(users.filter((b) => b.taskText).length, 1, 'the system-reminder line is a message but never a task choice')
})

test('own transcript: the generic role format parses too', () => {
  const { blocks, stats } = parseTranscript(GENERIC_LINES.join('\n'))
  assert.equal(stats.skipped, 1)
  assert.equal(stats.ignored, 1)
  assert.equal(stats.messages, 2)
  assert.deepEqual(blocks.filter((b) => b.role === 'tool').map((b) => [b.tool, b.kind, b.input]), [['Read', 'Read', 'src/search/invoice_index.ts'], ['Bash', 'Bash', 'docker build .'], ['Tool', 'Tool', '']])
  assert.deepEqual(parseTranscript('').blocks, [])
  assert.equal(parseTranscript(null).stats.lines, 0)
})

test('own transcript: a source outside the workspace, under .harness, reserved or missing is refused without throwing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'jev-compactor-paths-'))
  const outside = mkdtempSync(join(tmpdir(), 'jev-compactor-outside-'))
  writeFileSync(join(outside, 'secret.jsonl'), GENERIC_LINES.join('\n'))
  mkdirSync(join(ws, '.harness'), { recursive: true })
  writeFileSync(join(ws, '.harness', 'inside.jsonl'), GENERIC_LINES.join('\n'))
  writeFileSync(join(ws, 'ok.jsonl'), GENERIC_LINES.join('\n'))
  symlinkSync(join(outside, 'secret.jsonl'), join(ws, 'link.jsonl'))
  for (const [src, pattern] of [
    ['../secret.jsonl', /outside the workspace/], [join(outside, 'secret.jsonl'), /outside the workspace/], ['sub/../../x.jsonl', /outside the workspace/],
    ['.harness/inside.jsonl', /\.harness/], ['.HARNESS/inside.jsonl', /\.harness/], ['link.jsonl', /outside the workspace/],
    ['compaction-plan.json', /harness writes/], ['session.json', /harness writes/], ['nope.jsonl', /not found/], ['', /file name/], [42, /file name/], ['.', /outside|not a file/],
  ]) {
    const r = resolveSource(ws, src)
    assert.equal(r.ok, false, String(src))
    assert.match(r.error, pattern, String(src))
    assert.equal(loadTranscript(ws, src).ok, false)
  }
  assert.equal(resolveSource(ws, 'ok.jsonl').ok, true)
  assert.equal(resolveSource(ws, './ok.jsonl').rel, 'ok.jsonl')

  // in the viewer: the error is shown, nothing crashes, and the made-up session runs instead
  const v = await freshOwn(null, { source: '../secret.jsonl' })
  try {
    const s = await v.state()
    assert.equal(s.mode, 'synthetic')
    assert.match(s.cfgError, /outside the workspace/)
    await v.ctl('tick', { n: 20 })
    assert.ok((await v.state()).n > s.n, 'the demo stays alive')
    assert.equal(existsSync(join(v.ws, 'compaction-plan.json')), false)
  } finally { await v.viewer.close() }
})

test('own transcript: the plan file is written with the right totals, and truth-based fields are absent', async () => {
  const v = await freshOwn(CLAUDE_LINES, { trimTo: 120 })
  try {
    let s = await v.state()
    assert.equal(s.mode, 'transcript')
    assert.equal(s.source.file, 'my-session.jsonl')
    assert.equal(s.source.skipped, 2)
    assert.equal(s.baseline, null, 'no baseline lane without ground truth')
    assert.deepEqual(s.series, [])
    assert.equal(s.totals.compactions, 0, 'pause cancelled the automatic run')
    assert.equal(s.tasks.length, 1)
    assert.match(s.tasks[0].title, /webhook retry backoff/)
    assert.ok(s.cfg.budget >= s.tokens, 'the tower starts full, not over')
    const loaded = s.tokens
    assert.equal(JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8')).ready, false)
    assert.equal(existsSync(join(v.ws, 'compaction-plan.json')), false)

    assert.equal((await v.ctl('tick')).status, 200)   // one decision: Jev judges the transcript
    s = await v.state()
    assert.equal(s.totals.compactions, 1)
    const last = s.last
    assert.equal(last.before, loaded)
    assert.equal(last.questions, 5, 'one question per tool result')
    assert.equal(last.calls, 1)
    assert.equal(last.keep + last.trim + last.drop, 5)
    assert.equal(last.after, s.tokens)
    assert.ok(last.drop >= 1 && last.after < last.before, 'the install log goes')
    for (const k of ['recall', 'junkRemoved', 'needlesDropped', 'needlesTrimmed', 'junkKept']) assert.equal(k in last, false, `${k} must not exist without ground truth`)
    assert.equal('avgRecall' in s.totals, false)
    assert.equal('avgJunkRemoved' in s.totals, false)
    assert.ok(s.history.every((h) => !('recall' in h)))
    assert.equal(last.biggestDropped[0].input, 'npm install')
    assert.ok(s.blocks.filter((b) => b[5] === 3).length >= 3, 'messages are never touched')

    const planText = readFileSync(join(v.ws, 'compaction-plan.json'), 'utf8')
    const plan = JSON.parse(planText)
    assert.equal(plan.kind, 'jev-compaction-plan')
    assert.equal(plan.source, 'my-session.jsonl')
    assert.match(plan.judge, /mock/)
    assert.deepEqual(plan.results.map((r) => r.index), [0, 1, 2, 3, 4])
    assert.deepEqual(plan.results.map((r) => r.tool), ['Read', 'Bash', 'Grep', 'mcp__tracker__get_issue', 'Edit'])
    const messageTokens = plan.totals.messageTokens
    assert.equal(plan.totals.tokensBefore, plan.results.reduce((a, r) => a + r.tokens, 0) + messageTokens)
    assert.equal(plan.totals.tokensAfter, plan.results.reduce((a, r) => a + r.tokensAfter, 0) + messageTokens)
    assert.equal(plan.totals.tokensBefore, last.before)
    assert.equal(plan.totals.tokensAfter, last.after)
    assert.equal(plan.totals.tokensSaved, last.before - last.after)
    assert.deepEqual([plan.totals.keep, plan.totals.trim, plan.totals.drop], [last.keep, last.trim, last.drop])
    assert.equal(plan.totals.skippedLines, 2)
    for (const r of plan.results) {
      assert.ok(['keep', 'trim', 'drop'].includes(r.verdict))
      assert.ok(Math.abs(r.probabilities.keep + r.probabilities.trim + r.probabilities.drop - 1) < 0.01)
      assert.equal(r.tokensAfter, r.verdict === 'drop' ? 0 : r.verdict === 'trim' ? Math.min(r.tokens, 120) : r.tokens)
    }
    // the plan and the verdict name tools and inputs, never the content of the transcript
    const verdictText = readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8')
    for (const secret of SECRETS) {
      assert.equal(planText.includes(secret), false, `"${secret}" leaked into the plan`)
      assert.equal(verdictText.includes(secret), false, `"${secret}" leaked into the verdict`)
    }
    const verdict = JSON.parse(verdictText)
    assert.equal(verdict.spec, 1)
    assert.equal(verdict.ready, true)
    assert.equal(verdict.plan, 'compaction-plan.json')
    assert.equal(verdict.artifact, 'compaction-plan.json')
    assert.equal(verdict.totals.tokensBefore, last.before)
    assert.equal(verdict.totals.tokensAfter, last.after)
    assert.match(verdict.summary, /your transcript/)
    assert.ok(verdict.findings.some((f) => f.kind === 'source' && /2 lines/.test(f.message)))
    // nothing else was written to the workspace
    assert.deepEqual(readdirSync(v.ws).sort(), ['.harness', 'compaction-plan.json', 'my-session.jsonl', 'session.json'])
    assert.deepEqual(readdirSync(join(v.ws, '.harness')).sort(), ['verdict.json'])
  } finally { await v.viewer.close() }
})

test('own transcript: a pinned block is never dropped, and a pin on a dropped block brings it back', async () => {
  const v = await freshOwn(CLAUDE_LINES)
  try {
    await v.ctl('tick')
    let s = await v.state()
    const droppedId = s.last.biggestDropped[0].id
    assert.equal(s.blocks.some((b) => b[0] === droppedId), false, 'Jev dropped the install log')
    const calls = s.totals.calls
    assert.equal((await v.ctl('pin', { id: droppedId, pinned: true })).body.pinned, true)
    s = await v.state()
    const back = s.blocks.find((b) => b[0] === droppedId)
    assert.ok(back, 'the pinned block is back in the window')
    assert.equal(back[2], back[3], 'at full size')
    assert.equal(back[6], 1)
    assert.equal(s.last.trigger, 'pin')
    assert.equal(s.last.reused, true)
    assert.equal(s.totals.calls, calls, "re-applying a pin reuses Jev's answers, no new call")
    assert.equal(s.last.pinnedKept, 1)
    const plan = JSON.parse(readFileSync(join(v.ws, 'compaction-plan.json'), 'utf8'))
    const row = plan.results.find((r) => r.input === 'npm install')
    assert.deepEqual([row.verdict, row.jev, row.pinned], ['keep', 'drop', true])
    assert.equal(plan.totals.pinned, 1)
    // a fresh "Compact now" asks Jev again and still respects the pin
    await v.ctl('compact')
    s = await v.state()
    assert.equal(s.last.trigger, 'manual')
    assert.ok(s.totals.calls > calls)
    assert.ok(s.blocks.some((b) => b[0] === droppedId && b[6] === 1))
    const info = (await v.ctl('inspect', { id: droppedId })).body.block
    assert.equal(info.truth, null)
    assert.equal(info.ideal, null)
    assert.equal(info.line, 6)
    assert.equal(info.tool, 'Bash')
  } finally { await v.viewer.close() }
})

test('own transcript: the task buttons are the last user messages, and switching one changes the plan', async () => {
  const lines = [
    JSON.stringify({ role: 'user', content: 'Fix the refund ledger rounding for cents and chargeback reversal.' }),
    JSON.stringify({ role: 'tool', name: 'Read', input: { file_path: 'src/refund/ledger_cents.ts' }, content: `export function apply_refund(ledger, cents) { const rounding = ledger.reversal(cents); return rounding } // refund ledger chargeback\n${big('refund', 60)}` }),
    JSON.stringify({ role: 'user', content: 'Now rotate the login session cookie and its oauth scope expiry.' }),
    JSON.stringify({ role: 'tool', name: 'Read', input: { file_path: 'src/session/cookie_expiry.ts' }, content: `export function rotate_session(cookie, login) { const expiry = oauth.scope(cookie); return expiry } // session login rotate\n${big('session', 60)}` }),
  ]
  const v = await freshOwn(lines)
  try {
    let s = await v.state()
    assert.equal(s.tasks.length, 2)
    assert.equal(s.currentTask, s.tasks[1].id, 'the last user message is the task by default')
    await v.ctl('tick')
    s = await v.state()
    const kept = (st) => st.blocks.filter((b) => b[5] !== 3 && b[7] === 1).map((b) => b[8])
    assert.deepEqual(kept(s), ['src/session/cookie_expiry.ts'])
    assert.equal((await v.ctl('setTask', { task: s.tasks[0].id })).status, 200)
    await v.ctl('compact')
    s = await v.state()
    assert.equal(s.currentTask, s.tasks[0].id)
    assert.deepEqual(kept(s), ['src/refund/ledger_cents.ts'], 'every run starts from the whole transcript')
    // reset reloads the file; the other controls still answer
    assert.equal((await v.ctl('reset')).status, 200)
    s = await v.state()
    assert.equal(s.totals.compactions, 0)
    assert.equal(s.blocks.length, 4)
    for (const cmd of ['flood', 'start', 'pause', 'setBudget', 'setDistraction']) assert.equal((await v.ctl(cmd, { value: 0.5 })).status, 200)
  } finally { await v.viewer.close() }
})

test('own transcript: a big file is judged 100 questions per call, and the synthetic mode is unchanged', async () => {
  const lines = [JSON.stringify({ role: 'user', content: 'Fix the webhook retry backoff.' })]
  for (let i = 0; i < 230; i++) lines.push(JSON.stringify({ role: 'tool', name: i % 3 ? 'Bash' : 'Read', input: { command: `step ${i}` }, content: big(i % 5 ? 'lodash' : 'webhook retry backoff', 12) }))
  const v = await freshOwn(lines)
  try {
    await v.ctl('tick')
    const s = await v.state()
    assert.equal(s.last.questions, 230)
    assert.equal(s.last.calls, 3)
    assert.ok(s.last.perCall <= 100)
  } finally { await v.viewer.close() }

  // the same harness without `source` is the made-up session, with its ground truth and baseline intact
  const plain = await fresh()
  try {
    const s = await untilCompaction(plain)
    assert.equal(s.mode, 'synthetic')
    assert.equal(s.source, null)
    assert.ok(s.baseline && Array.isArray(s.baseline.blocks))
    assert.ok(typeof s.last.recall === 'number' && typeof s.last.junkRemoved === 'number')
    assert.ok('avgRecall' in s.totals)
    assert.equal(existsSync(join(plain.ws, 'compaction-plan.json')), false, 'the made-up session writes no plan')
    const verdict = JSON.parse(readFileSync(join(plain.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.artifact, 'session.json')
    assert.equal('plan' in verdict, false)
  } finally { await plain.viewer.close() }
})

test('check.mjs accepts a good source and rejects a bad one', () => {
  const check = join(ROOT, 'toolchain/check.mjs')
  const ws = mkdtempSync(join(tmpdir(), 'jev-compactor-check-src-'))
  const p = JSON.parse(readFileSync(join(ROOT, 'template/session.json'), 'utf8'))
  writeFileSync(join(ws, 'my-session.jsonl'), GENERIC_LINES.join('\n'))
  const run = (source) => { writeFileSync(join(ws, 'session.json'), JSON.stringify({ ...p, source })); return spawnSync(process.execPath, [check], { encoding: 'utf8', env: { ...process.env, HARNESS_WORKSPACE: ws } }) }
  const ok = run('my-session.jsonl')
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /source is set/)
  const missing = run('later.jsonl')
  assert.equal(missing.status, 0, 'a missing file is a warning, the person may copy it next')
  assert.match(missing.stdout, /warn\s+source/)
  for (const bad of ['../x.jsonl', '/etc/passwd', '.harness/verdict.json', 'compaction-plan.json', 7]) {
    const r = run(bad)
    assert.equal(r.status, 1, String(bad))
    assert.match(r.stdout, /error\s+source/)
  }
})
