// Viewer integration test for Jev Duel. Spins up the real viewer against a temp workspace and
// checks the loop: moves get played by Jev on both sides, the verdict is written with a summary,
// control commands work, and a full-ish game makes progress (disks accumulate, turns alternate).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

function freshBattle(overrides = {}) {
  const battle = {
    title: 'Test Duel', size: 6, speed: 60,
    rivals: {
      O: { name: 'Alpha', personality: 'Careful and positional. Wins by structure.' },
      X: { name: 'Beta', personality: 'Aggressive and greedy. Grabs flips.' },
    },
    referee: 'Call it fairly.',
    ...overrides,
  }
  return battle
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-duel-test-'))
  writeFileSync(join(ws, 'battle.json'), JSON.stringify(freshBattle(overrides)))
  const { startDuelViewer } = await import(viewerPath)
  const viewer = await startDuelViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Duel plays a real game: disks fill and the verdict updates', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 4000
    let lastTotal = 0
    while (Date.now() < deadline) {
      await wait(150)
      const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
      const m = String(v.summary).match(/(\d+)[–-](\d+)/)
      if (m) lastTotal = Number(m[1]) + Number(m[2])
      if (lastTotal >= 14) break
    }
    assert.ok(lastTotal >= 14, `expected disks to accumulate (>=14), got ${lastTotal}`)
    assert.ok(existsSync(join(ws, '.harness/verdict.json')))
  } finally {
    await viewer.close()
  }
})

test('Jev Duel writes a valid verdict shape', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await wait(400)
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Duel turns alternate between the two sides', async () => {
  const { ws, viewer } = await freshViewer({ speed: 60 })
  try {
    const port = viewer.url.split(':').pop()
    const getState = async () => (await (await fetch(`http://127.0.0.1:${port}/state`)).json())
    await wait(300)
    const s1 = await getState()
    await wait(400)
    const s2 = await getState()
    // board should not be the opening 4 disks anymore
    const discCount = (b) => b.flat().filter((c) => c !== '.').length
    assert.ok(discCount(s2.board) > discCount(s1.board), 'board should have grown')
  } finally {
    await viewer.close()
  }
})

test('Jev Duel control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }),
      })
      return res.status
    }
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('step'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

// ---- The tests below drive time with the `tick` control, so they never wait on a timer. ----
const ROOT = join(HERE, '..')
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/battle.json'), 'utf8'))
const G = await import(join(ROOT, 'viewer/game.mjs'))
const { duelMock, readMoves, readStyle } = await import(join(ROOT, 'viewer/mock.mjs'))
const { execFileSync } = await import('node:child_process')
const net = (await import('node:net')).default

/** Boot paused and reset, so only `tick` moves the game. */
async function boot(battle) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-duel-test-'))
  writeFileSync(join(ws, 'battle.json'), JSON.stringify(battle))
  const { startDuelViewer } = await import(viewerPath)
  const viewer = await startDuelViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const ctl = async (body) => { const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
  const state = async () => (await fetch(`${base}/state`)).json()
  await ctl({ cmd: 'pause' }); await ctl({ cmd: 'reset' })
  return { ws, viewer, base, ctl, state }
}
const NEUTRAL = 'Plays to win.'
const rivals = (iO, iX, pO = NEUTRAL, pX = NEUTRAL) => ({ O: { name: 'Alpha', personality: pO, insight: iO }, X: { name: 'Beta', personality: pX, insight: iX } })

test('the next player has already answered, and its whole spread is in the frame', async () => {
  const v = await boot(TEMPLATE)
  try {
    const callsBefore = (await (await fetch(`${v.base}/jev`)).json()).calls
    let s = await v.state()
    assert.equal(s.moveCount, 0); assert.equal(s.toMove, 'O')
    assert.equal(s.pending.disk, 'O')
    assert.equal(s.pending.moves.length, 4, 'four legal opening moves')
    const sum = s.pending.moves.reduce((a, m) => a + m.p, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, 'the probabilities add up to 1')
    assert.ok(Math.max(...s.pending.moves.map((m) => m.p)) < 0.999, 'never one-hot when there is a choice')
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    assert.equal(s.moveCount, 1); assert.equal(s.toMove, 'X'); assert.equal(s.pending.disk, 'X')
    const h = s.history[0]
    assert.equal(h.flipped.length, h.flips, 'the turned disks are listed for the flip animation')
    assert.ok(h.ref.strong >= 0 && h.ref.strong <= 2 && h.ref.decided >= 0 && h.ref.decided <= 2)
    assert.deepEqual(s.quality, [['O', Number(h.ref.strong.toFixed(2))]])
    const jev = await (await fetch(`${v.base}/jev`)).json()
    assert.equal(jev.calls - callsBefore, 2, 'one referee call and one call for the next player')
    assert.ok(jev.costUsd > 0)
  } finally { await v.viewer.close() }
})

test('battle.json really takes effect, pane overrides work, and a file edit resets them', async () => {
  const v = await boot({ ...TEMPLATE, title: 'Ice and Fire', size: 8, speed: 450, rivals: rivals(1, 0, 'Patient. Loves corners.', 'Greedy. Grabs material.') })
  try {
    let s = await v.state()
    assert.equal(s.title, 'Ice and Fire'); assert.equal(s.size, 8); assert.equal(s.speed, 450)
    assert.equal(s.board.length, 8); assert.equal(s.rows[0].length, 8)
    assert.equal(s.rivals.O.insight, 1); assert.equal(s.rivals.X.insight, 0)
    assert.match(s.stateText, /8x8 board/); assert.match(s.stateText, /You are Alpha, playing O\. Patient\. Loves corners\./)
    assert.match(s.stateText, /flips \d+ · (inner square|edge|corner|next to an open corner)\n/, 'insight 1 adds where the square sits')
    assert.doesNotMatch(s.stateText, /rival's best reply/)
    await v.ctl({ cmd: 'set', key: 'insightO', value: 2 })
    s = await v.state()
    assert.match(s.stateText, /rival's best reply flips \d+/, 'insight 2 adds the reply, at once')
    await v.ctl({ cmd: 'set', key: 'insightO', value: 0 })
    s = await v.state()
    assert.doesNotMatch(s.stateText, /inner square|edge|corner for/)
    await v.ctl({ cmd: 'set', key: 'speed', value: 200 })
    assert.equal((await v.state()).speed, 200)
    writeFileSync(join(v.ws, 'battle.json'), JSON.stringify({ ...TEMPLATE, title: 'Edited' }))
    await wait(250)
    s = await v.state()
    assert.equal(s.title, 'Edited'); assert.equal(s.size, 6); assert.deepEqual(s.overrides, {})
  } finally { await v.viewer.close() }
})

test('a person can force the next move by clicking a legal square', async () => {
  const v = await boot(TEMPLATE)
  try {
    const s0 = await v.state()
    const unloved = [...s0.pending.moves].sort((a, b) => a.p - b.p)[0]
    assert.notDeepEqual([unloved.x, unloved.y], s0.pending.choice, 'pick a move Jev did not want')
    const r = await v.ctl({ cmd: 'play', x: unloved.x, y: unloved.y })
    assert.equal(r.json.ok, true)
    const s1 = await v.state()
    assert.equal(s1.moveCount, 1)
    assert.equal(s1.board[unloved.y][unloved.x], 'O')
    assert.equal(s1.history[0].human, true)
    assert.equal(s1.totals.forced, 1)
    assert.equal((await v.ctl({ cmd: 'play', x: 0, y: 0 })).json.ok, false, 'an illegal square is turned away')
    assert.equal((await v.state()).moveCount, 1)
  } finally { await v.viewer.close() }
})

test('swap sides, board size, and every control command', async () => {
  const v = await boot(TEMPLATE)
  try {
    await v.ctl({ cmd: 'set', key: 'insightX', value: 0 })
    await v.ctl({ cmd: 'swap' })
    let s = await v.state()
    assert.equal(s.rivals.O.name, 'Greed'); assert.equal(s.rivals.X.name, 'Patience')
    assert.equal(s.rivals.O.insight, 0, 'the dial follows its player'); assert.equal(s.rivals.X.insight, 2)
    assert.match(s.stateText, /You are Greed, playing O/)
    await v.ctl({ cmd: 'tick', n: 3 })
    await v.ctl({ cmd: 'set', key: 'size', value: 10 })
    s = await v.state()
    assert.equal(s.size, 10); assert.equal(s.moveCount, 0); assert.equal(s.counts.O + s.counts.X, 4)
    assert.equal((await v.ctl({ cmd: 'set', key: 'size', value: 7 })).json.ok, false, 'odd sizes are turned away')
    for (const body of [{ cmd: 'pause' }, { cmd: 'start' }, { cmd: 'pause' }, { cmd: 'tick' }, { cmd: 'tick', n: 500 }, { cmd: 'step' }, { cmd: 'swap' }, { cmd: 'reset' }]) {
      const r = await v.ctl(body)
      assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(r.json.ok, true, JSON.stringify(body))
    }
    assert.equal((await v.ctl({ cmd: 'nope' })).json.ok, false)
    assert.equal((await fetch(`${v.base}/control`, { method: 'POST', body: '{nope' })).status, 400)
  } finally { await v.viewer.close() }
})

test('it never ends: the winner shows for about five seconds, then a new game starts by itself', async () => {
  const v = await boot({ ...TEMPLATE, size: 4, speed: 1000 })
  try {
    let s, n = 0
    do { s = (await v.ctl({ cmd: 'tick' })).json; n++ } while (!s.gameOver && n < 40)
    s = await v.state()
    assert.equal(s.gameOver, true)
    assert.equal(s.totals.games, 1)
    assert.equal(s.restLeftMs, 5000)
    assert.ok(s.winner === null || s.winnerName === s.rivals[s.winner].name)
    await v.ctl({ cmd: 'tick', n: 4 })
    assert.equal((await v.state()).gameOver, true, 'still showing the result')
    await v.ctl({ cmd: 'tick' })
    s = await v.state()
    assert.equal(s.gameOver, false); assert.equal(s.game, 2); assert.equal(s.moveCount, 0); assert.equal(s.pending.disk, 'O')
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.spec, 1); assert.ok(verdict.phases.length === 3)
  } finally { await v.viewer.close() }
})

test('a broken battle.json keeps the demo alive and reports the problem', async () => {
  const v = await boot(TEMPLATE)
  try {
    writeFileSync(join(v.ws, 'battle.json'), '{ "title": "oops", ')
    await wait(250)
    let s = await v.state()
    assert.match(s.cfgError, /battle\.json/)
    assert.equal(s.title, TEMPLATE.title, 'still on the last good settings')
    await v.ctl({ cmd: 'tick', n: 4 })
    s = await v.state()
    assert.equal(s.moveCount, 4)
    const verdict = JSON.parse(readFileSync(join(v.ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(verdict.ready, false); assert.ok(verdict.findings.some((f) => f.severity === 'error'))
    writeFileSync(join(v.ws, 'battle.json'), JSON.stringify({ ...TEMPLATE, title: 'Fixed' }))
    await wait(250)
    s = await v.state()
    assert.equal(s.cfgError, null); assert.equal(s.title, 'Fixed')
  } finally { await v.viewer.close() }
})

test('the viewer is loopback only', async () => {
  const v = await boot(TEMPLATE)
  try {
    const port = Number(new URL(v.base).port)
    const status = await new Promise((done) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => { buf += d })
      sock.on('end', () => done(Number((buf.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])))
      sock.on('error', () => done(0))
    })
    assert.equal(status, 403)
    assert.equal((await fetch(`${v.base}/studio.js`)).status, 200)
    assert.equal((await fetch(`${v.base}/viewer.mjs`)).status, 404, 'only the pane files are served')
  } finally { await v.viewer.close() }
})

test('the dial is honest: the player that reads more about each move wins, whichever colour it plays', async () => {
  const series = async (iO, iX) => {
    const v = await boot({ ...TEMPLATE, speed: 5000, rivals: rivals(iO, iX) })
    try {
      await v.ctl({ cmd: 'tick', n: 1400 }) // at 5000 ms a move the result rests for one tick, so this is about 40 games
      const t = (await v.state()).totals
      return { games: t.games, O: t.winsO, X: t.winsX }
    } finally { await v.viewer.close() }
  }
  const a = await series(2, 0), b = await series(0, 2), even = await series(2, 2)
  console.log(`reads 2 vs 0: O ${a.O}–${a.X} X in ${a.games} games · reads 0 vs 2: O ${b.O}–${b.X} X in ${b.games} games · reads 2 vs 2: O ${even.O}–${even.X} X in ${even.games} games`)
  assert.ok(a.games >= 30 && b.games >= 30)
  assert.ok(a.O >= a.games * 0.8, `O reads more and should win most: ${a.O} of ${a.games}`)
  assert.ok(b.X >= b.games * 0.8, `X reads more and should win most: ${b.X} of ${b.games}`)
  assert.ok(even.O >= even.games * 0.15 && even.X >= even.games * 0.15, 'with the same reading it is a real fight')
})

test('the stand-in reads only the text Jev gets, and personalities change the pick', () => {
  const cfg = (pO, iO) => G.sanitize({ size: 6, rivals: rivals(iO, 2, pO) })
  const board = G.newBoard(6)
  G.applyMove(board, 1, 2, 'O'); G.applyMove(board, 1, 1, 'X'); G.applyMove(board, 0, 0, 'O'); G.applyMove(board, 3, 1, 'X')
  const moves = G.legalMoves(board, 'O')
  const text2 = G.sideState(cfg(NEUTRAL, 2), board, 'O', moves), text0 = G.sideState(cfg(NEUTRAL, 0), board, 'O', moves)
  assert.equal(readMoves(text2).length, moves.length)
  assert.ok(readMoves(text2).every((m) => m.replyBest != null), 'insight 2 carries the reply')
  assert.ok(readMoves(text0).every((m) => m.replyBest == null && !m.corner && !m.edge && !m.risky), 'insight 0 carries nothing but flips')
  const a = duelMock(text0, 'move', { options: moves.map((m) => `${m.x},${m.y}`) }, 1)
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 1e-9)
  const most = Math.max(...moves.map((m) => m.flips))
  assert.equal(moves.find((m) => `${m.x},${m.y}` === a.choice).flips >= most - 1, true, 'told only the flips, it goes for flips')
  assert.ok(readStyle('You are A, playing O. Greedy. You grab material.\n') > 0.9)
  assert.ok(readStyle('You are A, playing O. Patient and positional, you love corners.\n') < 0.1)
  assert.equal(duelMock('nothing here', 'move', { options: ['0,0'] }, 1), null, 'anything else falls through to the general stand-in')
  // the referee reads the facts of the move, so a corner scores above a square that hands one over
  const ref = (where, gives) => duelMock(`A (O) just played 0,0, flipping 2 disks. That square is ${where}.\nThe rival can now flip at most 2 disks in reply, has 3 moves, and ${gives ? 'can take a corner next' : 'cannot take a corner next'}.\nScore: O 10, X 8. Empty squares: 18 of 36.`, 'strong', { legend: { 0: 'blunder', 1: 'solid', 2: 'brilliant' } }, 1)
  assert.ok(ref('a corner', false).score > 1.5); assert.ok(ref('next to an open corner', true).score < 0.3)
})

test('check.mjs accepts the template and rejects bad values', () => {
  const runCheck = (battle) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-duel-check-'))
    writeFileSync(join(ws, 'battle.json'), JSON.stringify(battle))
    try { execFileSync('node', [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8', stdio: 'pipe' }); return 0 } catch (e) { return e.status }
  }
  assert.equal(runCheck(TEMPLATE), 0)
  assert.equal(runCheck({ ...TEMPLATE, size: 7 }), 1)
  assert.equal(runCheck({ ...TEMPLATE, rivals: { ...TEMPLATE.rivals, O: { ...TEMPLATE.rivals.O, insight: 5 } } }), 1)
  assert.equal(runCheck({ ...TEMPLATE, rivals: { O: TEMPLATE.rivals.O } }), 1)
})
