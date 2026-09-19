// Viewer tests for Jev Sheets. Each test spins up the real viewer against a temp workspace.
// Time is driven with the `tick` and `drain` controls, never with sleeps on the wave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHeader } from '../viewer/grammar.mjs'
import { startSheetsViewer } from '../viewer/viewer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = JSON.parse(readFileSync(join(HERE, '../template/sheet.json'), 'utf8'))
const CHECK = join(HERE, '../toolchain/check.mjs')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function fresh(overrides = {}, opts = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-test-'))
  const file = join(ws, 'sheet.json')
  writeFileSync(file, JSON.stringify({ ...TEMPLATE, ...overrides }))
  const viewer = await startSheetsViewer({ workspace: ws, port: 0, ...opts })
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  const post = async (cmd, body = {}) => fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
  const ctl = async (cmd, body) => (await post(cmd, body)).json()
  const until = async (pred, ms = 4000) => { const end = Date.now() + ms; for (;;) { const s = await state(); if (pred(s)) return s; if (Date.now() > end) assert.fail('timed out waiting for the viewer'); await wait(40) } }
  return { ws, file, viewer, state, post, ctl, until }
}

test('the loop advances: one tick judges one row, every Jev column in one call', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    let s = await v.state()
    assert.equal(s.stats.cellsFilled, 0)
    assert.equal(s.stats.cellsTotal, 180)
    assert.deepEqual(await v.ctl('tick'), { ok: true, row: 'm01' })
    s = await v.state()
    assert.equal(s.stats.calls, 1, 'one call for the row')
    assert.equal(s.stats.cellsFilled, 3, 'three columns answered by that one call')
    const c = s.cells.m01
    assert.ok(c.urgent.p >= 0 && c.urgent.p <= 1 && [0, 1].includes(c.urgent.v))
    assert.ok(c.team.v >= 0 && c.team.v < 3 && c.team.c > 0 && c.team.c <= 1)
    assert.ok(c.anger.v >= 0 && c.anger.v < 3 && c.anger.s >= 0 && c.anger.s <= 2)
    await v.ctl('tick')
    s = await v.state()
    assert.equal(s.stats.calls, 2)
    assert.equal(s.stats.cellsFilled, 6)
    assert.ok(s.stats.costUsd > 0, 'cost is metered')
    assert.equal(s.client, 'mock')
    // { n } runs many ticks at once, and a finished sheet ticks idle
    assert.deepEqual(await v.ctl('tick', { n: 10 }), { ok: true, row: 'm12' })
    assert.equal((await v.state()).stats.cellsFilled, 36)
    await v.ctl('tick', { n: 500 })
    s = await v.state()
    assert.equal(s.stats.cellsFilled, 180)
    assert.equal(s.stats.calls, 60)
    assert.deepEqual(await v.ctl('tick'), { ok: true, idle: true })
  } finally { await v.viewer.close() }
})

test('the sheet fills by itself in a wave, in about a second', async () => {
  const v = await fresh()
  try {
    const t0 = Date.now()
    const s = await v.until((x) => x.stats.cellsFilled === 180 && !x.stats.busy)
    assert.ok(Date.now() - t0 < 3000, 'wave finished quickly')
    assert.equal(s.stats.calls, 60, 'one call per row')
    assert.ok(s.stats.cellsPerSec > 50, `cells per second is measured (${s.stats.cellsPerSec})`)
  } finally { await v.viewer.close() }
})

test('config takes effect: non-default values from sheet.json show up in /state', async () => {
  const v = await fresh({
    title: 'Test Sheet 42', reviewBelow: 0.42, concurrency: 3, textLabel: 'Review', demo: false,
    columns: ['Spam?', { id: 'stars', header: 'Stars: one < two < three < four < five' }],
    rows: [{ id: 'a', text: 'Great product, love it, thanks!' }, { id: 'b', text: 'Click here for a limited offer, act now, bitcoin lottery' }],
    suggestions: ['Rude?'],
  }, { autostart: false })
  try {
    await v.ctl('drain')
    const s = await v.state()
    assert.equal(s.title, 'Test Sheet 42')
    assert.equal(s.reviewBelow, 0.42)
    assert.equal(s.concurrency, 3)
    assert.equal(s.textLabel, 'Review')
    assert.equal(s.ghost.enabled, false)
    assert.deepEqual(s.columns.map((c) => [c.id, c.type]), [['spam', 'noul'], ['stars', 'score']])
    assert.equal(s.columns[1].levels.length, 5)
    assert.deepEqual(s.rows.map((r) => r.id), ['a', 'b'])
    assert.deepEqual(s.suggestions, ['Rude?'])
    assert.equal(s.cells.b.spam.v, 1, 'the spam row reads as spam')
    assert.equal(s.cells.a.spam.v, 0)
  } finally { await v.viewer.close() }
})

test('the verdict file is written with spec, summary, findings and phases', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    const file = join(v.ws, '.harness/verdict.json')
    let verdict
    for (let i = 0; i < 60; i++) { await wait(50); if (existsSync(file)) { verdict = JSON.parse(readFileSync(file, 'utf8')); if (verdict.ready) break } }
    assert.equal(verdict.spec, 1)
    assert.equal(verdict.ready, true)
    assert.ok(verdict.summary && verdict.summary.length <= 200)
    assert.ok(Array.isArray(verdict.findings) && verdict.findings.length >= 3)
    for (const f of verdict.findings) assert.ok(['error', 'warning', 'info'].includes(f.severity) && f.message)
    assert.ok(Array.isArray(verdict.phases) && verdict.phases.length === 3)
    assert.equal(verdict.artifact, 'sheet.json')
    const team = verdict.sheet.columns.find((c) => c.id === 'team')
    assert.ok(team.accuracy > 0.8 && Array.isArray(team.weakest), 'the agent can read accuracy and the weakest rows')
  } finally { await v.viewer.close() }
})

test('every control command answers 200', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    const cmds = [
      ['pause'], ['tick'], ['start'], ['drain'], ['touch'],
      ['addColumn', { header: 'Wants a refund?' }], ['addColumn', { header: 'Broken: only one' }],
      ['sort', { col: 'team' }], ['sort', { col: 'nope' }], ['reviewOnly', { on: true }], ['reviewOnly', { on: false }],
      ['setReview', { value: 0.5 }], ['setReview', { value: 7 }], ['editRow', { id: 'm02', text: 'Thanks, all good now.' }], ['editRow', { id: 'zz', text: 'x' }],
      ['inspect', { row: 'm01', col: 'team' }], ['removeColumn', { id: 'wants_a_refund' }], ['demo', { on: false }], ['demo', { on: true }],
      ['ghost'], ['reset'], ['no-such-command'],
    ]
    for (const [cmd, body] of cmds) assert.equal((await v.post(cmd, body)).status, 200, cmd)
    assert.equal((await v.ctl('no-such-command')).ok, false)
    const bad = await fetch(`${v.viewer.url}/control`, { method: 'POST', body: '{nope' })
    assert.equal(bad.status, 400)
  } finally { await v.viewer.close() }
})

test('a bad JSON edit keeps the demo alive and reports the error', async () => {
  const v = await fresh()
  try {
    await v.until((s) => s.stats.cellsFilled === 180)
    writeFileSync(v.file, '{ "title": "broken", "rows": [ ')
    let s = await v.until((x) => x.error)
    assert.match(s.error, /sheet\.json/)
    assert.equal(s.rows.length, 60, 'the last good sheet is still there')
    assert.equal(s.stats.cellsFilled, 180)
    assert.equal((await v.post('tick')).status, 200)
    // valid JSON, but no usable rows: still alive, still the last good sheet
    writeFileSync(v.file, JSON.stringify({ title: 'Empty', rows: 'oops' }))
    s = await v.until((x) => /rows/.test(x.error ?? ''))
    assert.equal(s.rows.length, 60)
    // a good edit heals it
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, title: 'Healed' }))
    s = await v.until((x) => x.title === 'Healed')
    assert.equal(s.error, null)
  } finally { await v.viewer.close() }
})

test('a non-loopback Host header gets 403', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    const port = Number(new URL(v.viewer.url).port)
    const ask = (host) => new Promise((resolveP, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
      let buf = ''
      sock.on('data', (d) => (buf += d))
      sock.on('end', () => resolveP(buf.split('\r\n')[0]))
      sock.on('error', reject)
    })
    assert.match(await ask('evil.example.com'), / 403 /)
    assert.match(await ask(`127.0.0.1:${port}`), / 200 /)
  } finally { await v.viewer.close() }
})

test('the honest dial: clear rows beat mixed-signal rows, in confidence and in accuracy', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    const s = await v.state()
    const { clear, mixed } = s.groups
    console.log(`  clear rows: avg confidence ${clear.avgConf}, accuracy ${clear.acc} · mixed rows: avg confidence ${mixed.avgConf}, accuracy ${mixed.acc}`)
    assert.ok(clear.avgConf - mixed.avgConf >= 0.08, `clear ${clear.avgConf} vs mixed ${mixed.avgConf}`)
    assert.ok(clear.acc - mixed.acc >= 0.1, `accuracy clear ${clear.acc} vs mixed ${mixed.acc}`)
    // every starter column reaches 85% on the clear rows
    for (const col of s.columns) {
      const rows = s.rows.filter((r) => r.group === 'clear')
      const right = rows.filter((r) => s.cells[r.id][col.id].ok === 1).length
      console.log(`  ${col.name}: ${right}/${rows.length} right on clear rows`)
      assert.ok(right / rows.length >= 0.85, `${col.id} ${right}/${rows.length}`)
    }
    // the review line catches the mixed rows, not the clear ones
    const share = (g) => { const rows = s.rows.filter((r) => r.group === g); let n = 0, f = 0; for (const r of rows) for (const c of s.columns) { n++; if (s.cells[r.id][c.id].c < s.reviewBelow) f++ } return f / n }
    console.log(`  cells under the ${s.reviewBelow} line: clear ${(share('clear') * 100).toFixed(1)}%, mixed ${(share('mixed') * 100).toFixed(1)}%`)
    assert.ok(share('mixed') > share('clear') * 3)
    // and the line itself is a dial: a higher line flags more cells
    const low = (await v.ctl('setReview', { value: 0.5 })) && (await v.state()).stats.flagged
    const high = (await v.ctl('setReview', { value: 0.85 })) && (await v.state()).stats.flagged
    assert.ok(high > low * 2, `flagged at 0.85 (${high}) vs 0.5 (${low})`)
  } finally { await v.viewer.close() }
})

test('a header typed in the pane creates a column and fills every row, computing only the missing cells', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    const before = (await v.state()).stats
    const added = await v.ctl('addColumn', { header: 'Wants a refund?' })
    assert.deepEqual(added, { ok: true, id: 'wants_a_refund', type: 'noul' })
    let s = await v.state()
    assert.equal(s.stats.cellsFilled, 180, 'old cells stay, new ones are pending')
    assert.equal(s.stats.cellsTotal, 240)
    await v.ctl('drain')
    s = await v.state()
    assert.equal(s.columns.at(-1).source, 'pane')
    for (const r of s.rows) assert.ok(s.cells[r.id].wants_a_refund, `row ${r.id} filled`)
    assert.equal(s.stats.computed - before.computed, 60, 'only the 60 new cells were asked for')
    assert.equal(s.stats.calls - before.calls, 60)
    assert.equal(s.cells.m03.wants_a_refund.v, 1, 'the refund row says yes')
    assert.equal(s.cells.m16.wants_a_refund.v, 0)
    // same header again, a broken header, and the 12 column cap
    assert.equal((await v.ctl('addColumn', { header: 'Wants a refund?' })).ok, false)
    assert.match((await v.ctl('addColumn', { header: 'Team: solo' })).error, /options|levels/)
    for (let i = 0; i < 8; i++) assert.equal((await v.ctl('addColumn', { header: `Extra ${i}?` })).ok, true)
    assert.match((await v.ctl('addColumn', { header: 'One too many?' })).error, /at most 12/)
  } finally { await v.viewer.close() }
})

test('answers are cached by row text plus column definition', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    assert.equal((await v.state()).stats.calls, 60)
    // the agent adds one row: only that row is judged
    const rows = [...TEMPLATE.rows, { id: 'new1', text: 'Our whole office is down, this is an emergency, fix it immediately!' }]
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, rows }))
    await v.until((s) => s.rows.length === 61)
    await v.ctl('drain')
    let s = await v.state()
    assert.equal(s.stats.calls, 61)
    assert.equal(s.cells.new1.urgent.v, 1)
    // the agent rewords one column: only that column is asked again, one question per call
    const columns = TEMPLATE.columns.map((c) => (c.id === 'urgent' ? { id: 'urgent', header: 'Needs a reply today?' } : c))
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, rows, columns }))
    await v.until((x) => x.columns[0].header === 'Needs a reply today?')
    await v.ctl('drain')
    s = await v.state()
    assert.equal(s.stats.calls, 122)
    assert.equal(s.stats.computed, 183 + 61)
  } finally { await v.viewer.close() }
})

test('editing a row re-judges it at once across all columns', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    let s = await v.state()
    assert.deepEqual([s.cells.m01.urgent.v, s.cells.m01.team.v, s.cells.m01.anger.v], [0, 0, 0], 'calm billing row')
    const calls = s.stats.calls
    assert.equal((await v.ctl('editRow', { id: 'm01', text: 'The sync service is down, we are losing money every hour. This outage is unacceptable, it is a nightmare!!!' })).ok, true)
    s = await v.state()
    assert.equal(s.cells.m01, undefined, 'its cells are cleared and waiting')
    assert.equal(s.rows[0].edited, true)
    await v.ctl('drain')
    s = await v.state()
    assert.equal(s.stats.calls, calls + 1, 'one call re-judged the row')
    assert.deepEqual([s.cells.m01.urgent.v, s.cells.m01.team.v, s.cells.m01.anger.v], [1, 1, 2], 'urgent, tech, furious')
    assert.equal(s.cells.m01.urgent.ok, undefined, 'the old truth label no longer applies')
  } finally { await v.viewer.close() }
})

test('sort, the review filter and the review line', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    assert.deepEqual((await v.ctl('sort', { col: 'anger' })).sort, { col: 'anger', dir: 'desc' })
    let s = await v.state()
    const score = (id) => s.cells[id].anger.v // the level: 0 calm, 1 annoyed, 2 furious
    for (let i = 1; i < s.order.length; i++) assert.ok(score(s.order[i - 1]) >= score(s.order[i]))
    assert.deepEqual((await v.ctl('sort', { col: 'anger' })).sort, { col: 'anger', dir: 'asc' })
    s = await v.state()
    assert.ok(score(s.order[0]) <= score(s.order.at(-1)))
    assert.equal((await v.ctl('sort', { col: 'anger' })).sort, null)
    assert.deepEqual((await v.state()).order, TEMPLATE.rows.map((r) => r.id))

    await v.ctl('reviewOnly', { on: true })
    s = await v.state()
    assert.ok(s.order.length > 0 && s.order.length < 60)
    for (const id of s.order) assert.ok(Object.values(s.cells[id]).some((c) => c.c < s.reviewBelow), `${id} has a flagged cell`)
    await v.ctl('setReview', { value: 0 })
    assert.equal((await v.state()).order.length, 0)
    await v.ctl('setReview', { value: 1 })
    assert.equal((await v.state()).order.length, 60)
  } finally { await v.viewer.close() }
})

test('the ghost typist adds a demo column, fills it, and retires the older one; touch pauses it', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    const one = await v.ctl('ghost')
    assert.equal(one.typed, TEMPLATE.suggestions[0])
    let s = await v.state()
    assert.equal(s.columns.at(-1).source, 'demo')
    assert.equal(s.stats.cellsFilled, 240)
    const two = await v.ctl('ghost')
    assert.deepEqual(two.removed, [one.added])
    s = await v.state()
    assert.deepEqual(s.columns.filter((c) => c.source === 'demo').map((c) => c.id), [two.added])
    assert.equal(s.ghost.pausedMs, 0)
    await v.ctl('touch')
    assert.ok((await v.state()).ghost.pausedMs > 55000, 'an interaction rests the ghost for a minute')
    await v.ctl('demo', { on: false })
    assert.equal((await v.state()).ghost.enabled, false)
  } finally { await v.viewer.close() }
})

test('reset drops what was done in the pane', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    await v.ctl('drain')
    await v.ctl('addColumn', { header: 'Urgency' })
    await v.ctl('editRow', { id: 'm05', text: 'Never mind.' })
    await v.ctl('sort', { col: 'team' })
    await v.ctl('setReview', { value: 0.9 })
    await v.ctl('reset')
    await v.ctl('drain')
    const s = await v.state()
    assert.deepEqual(s.columns.map((c) => c.id), ['urgent', 'team', 'anger'])
    assert.equal(s.rows[4].text, TEMPLATE.rows[4].text)
    assert.equal(s.sort, null)
    assert.equal(s.reviewBelow, 0.65)
    assert.equal(s.stats.cellsFilled, 180)
  } finally { await v.viewer.close() }
})

test('the header grammar', () => {
  const ok = (h) => { const p = parseHeader(h); assert.ok(p.ok, `${h}: ${p.error}`); return p.column }
  assert.deepEqual([ok('Urgent?').type, ok('Urgent?').id], ['noul', 'urgent'])
  const team = ok('Team: billing = payment or invoice problems | tech = bugs and outages | sales')
  assert.equal(team.type, 'choice')
  assert.deepEqual(team.options, ['billing', 'tech', 'sales'])
  assert.deepEqual(team.descriptions, { billing: 'payment or invoice problems', tech: 'bugs and outages' })
  const anger = ok('Anger: calm < annoyed < furious')
  assert.deepEqual([anger.type, anger.levels], ['score', ['calm', 'annoyed', 'furious']])
  assert.deepEqual([ok('Urgency').type, ok('Urgency').levels, ok('Urgency').bare], ['score', ['low', 'medium', 'high'], true])
  assert.equal(ok(`Pick: ${Array.from({ length: 255 }, (_, i) => `o${i}`).join(' | ')}`).options.length, 255)
  for (const bad of ['', '   ', 'Team: solo', 'Team:', 'Mix: a | b < c', 'Dup: a | A', `Big: ${Array.from({ length: 256 }, (_, i) => `o${i}`).join(' | ')}`, 'Long: 1<2<3<4<5<6<7<8<9<10<11', 'Gap: a < < c'])
    assert.equal(parseHeader(bad).ok, false, `"${bad.slice(0, 30)}" should be rejected`)
})

test('check.mjs accepts the template and rejects out-of-range values', () => {
  const run = (sheet) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-check-'))
    writeFileSync(join(ws, 'sheet.json'), typeof sheet === 'string' ? sheet : JSON.stringify(sheet))
    return spawnSync(process.execPath, [CHECK], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' })
  }
  const good = run(TEMPLATE)
  assert.equal(good.status, 0, good.stdout)
  assert.match(good.stdout, /ok .*60 rows, 3 Jev columns/)
  assert.equal(run({ ...TEMPLATE, reviewBelow: 1.5 }).status, 1)
  assert.equal(run({ ...TEMPLATE, rows: [] }).status, 1)
  assert.equal(run({ ...TEMPLATE, rows: [{ id: 'a', text: '  ' }] }).status, 1)
  assert.equal(run({ ...TEMPLATE, columns: ['Heat: 1<2<3<4<5<6<7<8<9<10<11'] }).status, 1)
  assert.equal(run({ ...TEMPLATE, columns: ['Team: solo'] }).status, 1)
  assert.equal(run({ ...TEMPLATE, columns: Array.from({ length: 13 }, (_, i) => `Q${i}?`) }).status, 1)
  assert.equal(run({ ...TEMPLATE, rows: [{ id: 'a', text: 'hi', truth: { team: 'marketing' } }] }).status, 1)
  assert.equal(run('{ nope').status, 1)
})

test('the pane files are served, and nothing else', async () => {
  const v = await fresh({}, { autostart: false })
  try {
    for (const f of ['/', '/studio.js', '/studio.css', '/base.css', '/jev-hud.js', '/grammar.mjs', '/jev']) assert.equal((await fetch(v.viewer.url + f)).status, 200, f)
    assert.match(await (await fetch(v.viewer.url + '/')).text(), /Jev Sheets/)
    for (const f of ['/mock.mjs', '/viewer.mjs', '/../toolchain/jev.mjs', '/sheet.json']) assert.equal((await fetch(v.viewer.url + f)).status, 404, f)
  } finally { await v.viewer.close() }
})

test("rows can come from the person's own CSV in the workspace, and the file is watched", async () => {
  const { loadSource, parseDelimited } = await import('../viewer/source.mjs')
  assert.deepEqual(parseDelimited('a,b\n"x, ""quoted""",2\r\n3,4\n'), [['a', 'b'], ['x, "quoted"', '2'], ['3', '4']])
  const v = await fresh({ rows: undefined, source: 'leads.csv', columns: ['Urgent?'], demo: false }, { autostart: false })
  try {
    // No file yet: the demo stays up and says what is wrong.
    let s = await v.state()
    assert.match(String(s.configError ?? s.error ?? JSON.stringify(s)), /leads\.csv/)
    writeFileSync(join(v.ws, 'leads.csv'), 'company,message,seats\nAcme,"Our checkout is down, please call today",40\nBolt,Just browsing for next year,3\n')
    writeFileSync(v.file, JSON.stringify({ ...TEMPLATE, rows: undefined, source: 'leads.csv', columns: ['Urgent?'], demo: false }))
    s = await v.until((x) => x.rows?.length === 2)
    assert.equal(s.source.name, 'leads.csv'); assert.equal(s.source.textColumn, 'message')
    assert.equal(s.rows[0].text, 'Our checkout is down, please call today')
    assert.deepEqual(s.rows[0].meta, { company: 'Acme', seats: 40 })
    // Editing the CSV reloads the sheet.
    writeFileSync(join(v.ws, 'leads.csv'), 'company,message,seats\nAcme,"Our checkout is down, please call today",40\nBolt,Just browsing for next year,3\nCato,Invoice question,12\n')
    s = await v.until((x) => x.rows?.length === 3)
    assert.equal(s.rows[2].meta.company, 'Cato')
    // A named text column, and a column that does not exist.
    assert.equal(loadSource(v.ws, 'leads.csv', { textColumn: 'company' }).rows[0].text, 'Acme')
    assert.match(loadSource(v.ws, 'leads.csv', { textColumn: 'nope' }).error, /not a column/)
  } finally { await v.viewer.close() }
})

test('a source file must stay inside the workspace, and JSONL works too', async () => {
  const { loadSource } = await import('../viewer/source.mjs')
  const ws = mkdtempSync(join(tmpdir(), 'jev-sheets-src-'))
  assert.match(loadSource(ws, '../../etc/passwd').error, /inside the workspace/)
  assert.match(loadSource(ws, '/etc/passwd').error, /inside the workspace/)
  assert.match(loadSource(ws, '.harness/verdict.json').error, /\.harness/)
  assert.match(loadSource(ws, 'notes.pdf').error, /cannot be read|must be a/)
  writeFileSync(join(ws, 'tickets.jsonl'), '{"id":"T1","body":"Refund me now","plan":"pro"}\n"a bare string row"\n{"body":""}\n')
  const got = loadSource(ws, 'tickets.jsonl')
  assert.equal(got.error, null)
  assert.equal(got.rows.length, 2, 'rows without text are skipped')
  assert.deepEqual(got.rows[0], { text: 'Refund me now', id_: 'T1', plan: 'pro' })
  assert.equal(got.info.textColumn, 'body')
})
