// Viewer tests for Jev Blocks. Each test starts the real viewer on an ephemeral port against a temp
// workspace and drives time with the `tick` control (one Jev decision per tick), never with sleeps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startBlocksViewer } = await import(join(ROOT, 'viewer/viewer.mjs'))
const game = await import(join(ROOT, 'viewer/game.mjs'))
const { canon } = await import(join(ROOT, 'toolchain/jev.mjs'))

const CFG = { title: 'Test Well', seed: 7, gravity: 2, speedup: 0, decisionMs: 110, moveMs: 35, garbageRows: 0, style: 'Keep the stack low and flat. Go for four when it is safe.' }

async function fresh(overrides = {}, raw = null) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-blocks-test-'))
  writeFileSync(join(ws, 'blocks.json'), raw ?? JSON.stringify({ ...CFG, ...overrides }))
  const viewer = await startBlocksViewer({ workspace: ws, port: 0 })
  const ctl = async (body) => {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  await ctl({ cmd: 'pause' }) // tests own the clock
  return { ws, viewer, ctl, state }
}

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 40)) } }

test('the loop advances and Jev decides every piece', async () => {
  const { viewer, ctl, state } = await fresh()
  try {
    await ctl({ cmd: 'reset' })
    const before = await state()
    await ctl({ cmd: 'tick', n: 30 })
    const s = await state()
    assert.ok(s.session.decisions >= before.session.decisions + 30, 'thirty decisions were applied')
    assert.ok(s.session.pieces >= 29, `pieces locked (${s.session.pieces})`)
    assert.equal(s.client, 'mock')
    // Jev's mind is published: one probability per legal placement, the chosen one on top
    assert.ok(s.mind && s.mind.cands.length >= 9 && s.mind.cands.length <= 34, `9..34 placements (${s.mind?.cands.length})`)
    assert.match(s.mind.chosen, /^r\d+c\d+$/)
    assert.equal(s.mind.cands[0].id, s.mind.chosen)
    const sum = s.mind.cands.reduce((a, c) => a + c.p, 0)
    assert.ok(Math.abs(sum - 1) < 0.01, `probabilities sum to 1 (${sum})`)
    assert.ok(s.mind.cands[0].p >= 0.45 && s.mind.cands[0].p <= 0.86, `top choice is confident but not one-hot (${s.mind.cands[0].p})`)
    assert.ok(s.danger && s.danger.score >= 0 && s.danger.score <= 3)
    assert.ok(s.four >= 0 && s.four <= 1)
    assert.equal(s.game.board.length, 200)
    assert.equal(s.game.queue.length, 3)
    // one call carries three parallel questions
    const jev = await (await fetch(`${viewer.url}/jev`)).json()
    assert.deepEqual(jev.last.questions.map((q) => q.id), ['place', 'danger', 'go_for_four'])
    assert.ok(jev.costUsd > 0)
  } finally { await viewer.close() }
})

test('a non-default config really shows up in /state', async () => {
  const { viewer, state } = await fresh({ title: 'Heavy Rain', gravity: 17.5, speedup: 1.5, decisionMs: 240, moveMs: 60, garbageRows: 5, weights: { S: 2, Z: 1 } })
  try {
    const s = await state()
    assert.equal(s.title, 'Heavy Rain')
    assert.equal(s.cfg.gravity, 17.5)
    assert.equal(s.game.gravity, 17.5)
    assert.equal(s.cfg.speedup, 1.5)
    assert.equal(s.cfg.decisionMs, 240)
    assert.equal(s.cfg.moveMs, 60)
    assert.equal(s.cfg.garbageRows, 5)
    assert.deepEqual(s.cfg.weights, { I: 0, O: 0, T: 0, S: 2, Z: 1, J: 0, L: 0 })
    assert.ok(s.game.queue.every((t) => t === 'S' || t === 'Z'), 'only S and Z come out of the bag')
    const rows = s.game.board.match(/.{10}/g)
    assert.equal(rows.filter((r) => /[1-9]/.test(r)).length, 5, 'five garbage rows')
    assert.ok(rows.slice(-5).every((r) => (r.match(/0/g) || []).length === 1), 'one gap per garbage row')
  } finally { await viewer.close() }
})

test('a custom starting board is drawn from ASCII rows, and Jev takes the four', async () => {
  const board = ['#########.', '#########.', '#########.', '#########.']
  const { viewer, ctl, state } = await fresh({ board, weights: { I: 1 } })
  try {
    const s0 = await state()
    assert.equal(s0.game.board.match(/.{10}/g).slice(-4).join('|'), Array(4).fill('8888888880').join('|'))
    await ctl({ cmd: 'tick', n: 2 })
    const s = await state()
    assert.equal(s.game.lines, 4, 'the I piece went down the open column')
    assert.equal(s.game.fours, 1)
  } finally { await viewer.close() }
})

test('the verdict file is written with spec, summary, findings and phases', async () => {
  const { ws, viewer, ctl } = await fresh()
  try {
    await ctl({ cmd: 'tick', n: 12 })
    const file = join(ws, '.harness/verdict.json')
    assert.ok(existsSync(file))
    const v = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(v.spec, 1)
    assert.equal(v.ready, true)
    assert.ok(typeof v.summary === 'string' && v.summary.includes('Test Well'))
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases) && v.phases.length === 3)
    assert.equal(v.artifact, 'blocks.json')
    assert.ok(v.findings.some((f) => f.kind === 'timing'), 'reports how many pieces landed short')
  } finally { await viewer.close() }
})

test('every control command answers 200 and does what it says', async () => {
  const { viewer, ctl, state } = await fresh({ garbageRows: 2 })
  try {
    for (const body of [{ cmd: 'pause' }, { cmd: 'start' }, { cmd: 'pause' }, { cmd: 'tick' }, { cmd: 'reset' }, { cmd: 'set', gravity: 9 }, { cmd: 'set', slow: true }, { cmd: 'set', slow: false }, { cmd: 'garbage' }, { cmd: 'junk', col: 3 }, { cmd: 'cycleNext', index: 0 }, { cmd: 'nonsense' }]) {
      const r = await ctl(body)
      assert.equal(r.status, 200, JSON.stringify(body))
      assert.equal(r.json.ok, true)
    }
    await ctl({ cmd: 'reset' })
    const s0 = await state()
    const rows0 = s0.game.board.match(/.{10}/g)

    // (1) gravity slider: pins the real falling speed, at once
    await ctl({ cmd: 'set', gravity: 33 })
    let s = await state()
    assert.equal(s.game.gravity, 33); assert.equal(s.cfg.pinned, true)
    await ctl({ cmd: 'set', gravity: null })
    s = await state()
    assert.equal(s.game.gravity, 2); assert.equal(s.cfg.pinned, false)
    await ctl({ cmd: 'set', decisionMs: 400 })
    assert.equal((await state()).cfg.decisionMs, 400)

    // (2) drop garbage: the stack rises by one row with one gap
    await ctl({ cmd: 'garbage' })
    s = await state()
    const rows1 = s.game.board.match(/.{10}/g)
    assert.equal(rows1.filter((r) => /[1-9]/.test(r)).length, rows0.filter((r) => /[1-9]/.test(r)).length + 1)
    assert.equal((rows1[19].match(/0/g) || []).length, 1)

    // (3) click a column: one junk block lands on top of that column
    const col = 4
    const topBefore = rows1.findIndex((r) => r[col] !== '0')
    await ctl({ cmd: 'junk', col })
    s = await state()
    const rows2 = s.game.board.match(/.{10}/g)
    assert.equal(rows2[topBefore - 1][col], '9', 'a junk block sits on top of the column')
    assert.ok(s.events.some((e) => e.kind === 'junk' && e.col === col))

    // (4) click a next piece: it cycles to another piece
    const was = s.game.queue[1]
    await ctl({ cmd: 'cycleNext', index: 1 })
    s = await state()
    assert.notEqual(s.game.queue[1], was)

    // a paused board change makes Jev think again, so the mind on the board is never stale
    await ctl({ cmd: 'tick' })
    const m1 = (await state()).mind.seq
    await ctl({ cmd: 'junk', col: 0 })
    assert.ok((await state()).mind.seq > m1)
  } finally { await viewer.close() }
})

test('a bad JSON edit keeps the demo alive and reports the error; a good edit clears pane changes', async () => {
  const { ws, viewer, ctl, state } = await fresh({ gravity: 3 })
  try {
    await ctl({ cmd: 'set', gravity: 25 })
    await ctl({ cmd: 'tick', n: 5 })
    writeFileSync(join(ws, 'blocks.json'), '{ "gravity": 3, oops')
    const broken = await until(async () => { const s = await state(); return s.error ? s : null })
    assert.ok(broken, 'the parse error is reported')
    assert.match(broken.error, /blocks\.json/)
    assert.equal(broken.cfg.gravity, 3, 'the last good config stays')
    await ctl({ cmd: 'tick', n: 5 })
    assert.ok((await state()).session.decisions >= 10, 'the game keeps going')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(v.findings.some((f) => f.severity === 'error'))

    writeFileSync(join(ws, 'blocks.json'), JSON.stringify({ ...CFG, gravity: 6, title: 'Fixed' }))
    const fixed = await until(async () => { const s = await state(); return !s.error && s.title === 'Fixed' ? s : null })
    assert.ok(fixed, 'the fixed file is picked up')
    assert.equal(fixed.game.gravity, 6, 'the pinned gravity from the pane was cleared')
    assert.equal(fixed.cfg.pinned, false)
    assert.equal(fixed.game.pieces, 0, 'a new game started')
  } finally { await viewer.close() }
})

test('out-of-range values are clamped, never trusted', async () => {
  const { viewer, state } = await fresh({ gravity: 9999, speedup: -4, decisionMs: 1, moveMs: 'fast', garbageRows: 99, weights: { I: 0, O: 0 }, board: ['too short'] })
  try {
    const s = await state()
    assert.equal(s.cfg.gravity, 40); assert.equal(s.cfg.speedup, 0); assert.equal(s.cfg.decisionMs, 30); assert.equal(s.cfg.moveMs, 35); assert.equal(s.cfg.garbageRows, 12)
    assert.ok(s.warnings.length >= 2, 'warns about the zero weights and the bad board')
  } finally { await viewer.close() }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer } = await fresh()
  try {
    const port = Number(new URL(viewer.url).port)
    const reply = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => (buf += d)); sock.on('end', () => resolve(buf)); sock.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
    const ok = await fetch(`${viewer.url}/state`)
    assert.equal(ok.status, 200)
  } finally { await viewer.close() }
})

async function play(overrides, pieces = 300) {
  const { viewer, ctl, state } = await fresh(overrides)
  try {
    let s = await state()
    for (let i = 0; i < 400 && s.session.pieces < pieces; i++) { await ctl({ cmd: 'tick', n: 25 }); s = await state() }
    return { pieces: s.session.pieces, lines: s.session.lines, per300: (s.session.lines / s.session.pieces) * 300, misses: s.session.misses, topOuts: s.session.topOuts, games: s.session.games }
  } finally { await viewer.close() }
}

test('the honest dial: low gravity clears far more lines per 300 pieces than very high gravity', async () => {
  const same = { speedup: 0, garbageRows: 8, seed: 7 }
  const easy = await play({ ...same, gravity: 1 })
  const hard = await play({ ...same, gravity: 40 })
  console.log(`      gravity 1 : ${easy.per300.toFixed(0)} lines per 300 pieces, ${easy.misses} missed, ${easy.topOuts} top-outs`)
  console.log(`      gravity 40: ${hard.per300.toFixed(0)} lines per 300 pieces, ${hard.misses} missed, ${hard.topOuts} top-outs`)
  assert.ok(easy.per300 >= 110, `low gravity plays clean (${easy.per300.toFixed(0)} lines)`)
  assert.ok(easy.per300 >= hard.per300 * 2, `easy ${easy.per300.toFixed(0)} vs hard ${hard.per300.toFixed(0)}`)
  assert.ok(easy.misses <= 3 && easy.topOuts === 0, 'no misses and no top-outs when there is time')
  assert.ok(hard.misses >= 50, `placements land short when there is no time (${hard.misses})`)
  assert.ok(hard.topOuts >= 5, `and the stack tops out (${hard.topOuts})`)
})

test('thinking time is the same dial: a slow decider breaks at a gravity a fast one survives', async () => {
  const same = { speedup: 0, gravity: 14, seed: 11 }
  const fast = await play({ ...same, decisionMs: 110 }, 200)
  const slow = await play({ ...same, decisionMs: 900 }, 200)
  console.log(`      110 ms: ${fast.per300.toFixed(0)} lines per 300, ${fast.misses} missed · 900 ms: ${slow.per300.toFixed(0)} lines per 300, ${slow.misses} missed`)
  assert.ok(fast.misses <= 3 && fast.topOuts === 0)
  assert.ok(slow.misses >= 20 && slow.per300 < fast.per300 * 0.8)
})

test('it never ends: a top-out is followed by a new game, and the best is kept', async () => {
  const { viewer, ctl, state } = await fresh({ gravity: 40, garbageRows: 12, speedup: 0 })
  try {
    let s = await state()
    for (let i = 0; i < 60 && s.session.topOuts < 2; i++) { await ctl({ cmd: 'tick', n: 10 }); s = await state() }
    assert.ok(s.session.topOuts >= 2, 'topped out at least twice')
    assert.ok(s.session.games >= 3, 'and a new game followed each time')
    assert.ok(s.session.best >= 0 && s.session.lastTopOut)
    assert.ok(s.log.some((l) => /Topped out/.test(l.text)))
  } finally { await viewer.close() }
})

test('the offline reader answers from the state text and option descriptions alone', async () => {
  const board = game.emptyBoard()
  for (let x = 0; x < 9; x++) for (let y = 16; y < 20; y++) board[y][x] = 1
  const cands = game.enumerate(board, 'I')
  assert.equal(cands.length, 17, 'an I piece has 7 flat and 10 upright placements')
  const text = game.buildState({ style: 'Go for four.', board, type: 'I', next: ['T', 'O', 'L'], level: 1, lines: 0, gravity: 2, decisionMs: 110, moveMs: 35, cands })
  assert.match(text, /\|#########\.\|/); assert.match(text, /Current piece: I\. Next pieces: T, O, L\./); assert.match(text, /r1c9/)
  const qs = game.buildQuestions('I', cands)
  const a = game.blocksMock(text, 'place', canon(qs.place))
  assert.equal(a.choice, 'r1c9', 'upright in the open column, for four lines')
  assert.equal(Object.keys(a.probabilities).length, 17)
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 1e-9)
  assert.ok(a.confidence >= 0.5 && a.confidence <= 0.85)
  assert.ok(Object.values(a.probabilities).every((p) => p > 0), 'never one-hot')
  const d = game.blocksMock(text, 'danger', canon(qs.danger))
  assert.ok(d.score < 1 && Object.keys(d.probabilities).length === 4)
  const tall = game.emptyBoard(); for (let x = 0; x < 8; x++) for (let y = 3; y < 20; y++) tall[y][x] = (x + y) % 3 ? 1 : 0
  const tallText = game.buildState({ style: 'Go for four.', board: tall, type: 'O', next: ['T', 'O', 'L'], level: 1, lines: 0, gravity: 2, decisionMs: 110, moveMs: 35, cands: game.enumerate(tall, 'O') })
  assert.ok(game.blocksMock(tallText, 'danger', canon(qs.danger)).score > 2.3, 'a tall, holey stack is dangerous')
  assert.ok(game.blocksMock(tallText, 'go_for_four', canon(qs.go_for_four)).noul < 0.2)
  assert.ok(game.blocksMock(text, 'go_for_four', canon(qs.go_for_four)).noul > 0.6)
  assert.equal(game.blocksMock('no board here', 'place', canon(qs.place)), null, 'falls through to the generic mock')
})

test('check.mjs accepts the template and rejects bad values', () => {
  const check = (obj) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-blocks-check-'))
    writeFileSync(join(ws, 'blocks.json'), typeof obj === 'string' ? obj : JSON.stringify(obj))
    return spawnSync(process.execPath, [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' })
  }
  const template = JSON.parse(readFileSync(join(ROOT, 'template/blocks.json'), 'utf8'))
  const ok = check(template)
  assert.equal(ok.status, 0, ok.stdout); assert.match(ok.stdout, /ok\s+blocks\.json is valid/)
  for (const [patch, re] of [
    [{ gravity: 41 }, /gravity/], [{ gravity: 0.1 }, /gravity/], [{ speedup: 2.5 }, /speedup/], [{ decisionMs: 10 }, /decisionMs/], [{ moveMs: 900 }, /moveMs/],
    [{ garbageRows: 13 }, /garbageRows/], [{ weights: { I: 0, O: 0, T: 0, S: 0, Z: 0, J: 0, L: 0 } }, /all zero/], [{ weights: { X: 1 } }, /unknown piece/],
    [{ board: ['#########'] }, /board row 1/], [{ board: Array(21).fill('..........') }, /21 rows/], [{ board: ['####x#####'] }, /board row 1/],
  ]) {
    const r = check({ ...template, ...patch })
    assert.equal(r.status, 1, JSON.stringify(patch)); assert.match(r.stdout, re)
  }
  assert.equal(check({ ...template, weights: { S: 1, Z: 1 }, board: ['#########.', '.#########'], garbageRows: 3 }).status, 0)
  assert.equal(check('{ nope').status, 1)
})

test('the harness never uses a trademarked game name', () => {
  const banned = new RegExp(['te', 'tr', 'is'].join(''), 'i')
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'node_modules' || n === '.harness' ? [] : walk(p)) : [p] })
  for (const file of walk(ROOT)) {
    assert.ok(!banned.test(file), `file name ${file}`)
    assert.ok(!banned.test(readFileSync(file, 'utf8')), `contents of ${file}`)
  }
})
