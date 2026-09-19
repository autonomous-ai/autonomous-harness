// Integration tests for Jev FPS. They boot the real viewer on an ephemeral port against a temp
// workspace and drive time with the `tick` control, so nothing here waits on a timer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const { startFpsViewer } = await import(join(ROOT, 'viewer/viewer.mjs'))
const { parseMap, DEFAULT_MAP } = await import(join(ROOT, 'viewer/sim.mjs'))
const { readState, fpsMock } = await import(join(ROOT, 'viewer/mock.mjs'))
const TEMPLATE = JSON.parse(readFileSync(join(ROOT, 'template/level.json'), 'utf8'))

async function boot(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-fps-test-'))
  writeFileSync(join(ws, 'level.json'), JSON.stringify({ ...TEMPLATE, ...overrides }))
  const viewer = await startFpsViewer({ workspace: ws, port: 0 })
  const base = viewer.url
  const ctl = async (body) => { const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
  const state = async () => (await fetch(`${base}/state`)).json()
  await ctl({ cmd: 'pause' }); await ctl({ cmd: 'reset' })
  return { ws, viewer, base, ctl, state }
}

test('the fight advances and Jev answers all four questions every tick', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'tick', n: 60 })
    const s = await v.state()
    assert.equal(s.t, 60)
    assert.equal(s.session.decisions, 60)
    assert.ok(['LEFT_HARD', 'LEFT', 'LEFT_FINE', 'AHEAD', 'RIGHT_FINE', 'RIGHT', 'RIGHT_HARD'].includes(s.decision.turn))
    assert.ok(['FORWARD', 'BACK', 'STRAFE_LEFT', 'STRAFE_RIGHT', 'HOLD'].includes(s.decision.move))
    assert.ok(s.decision.pFire >= 0 && s.decision.pFire <= 1)
    const sum = Object.values(s.decision.probs.turn).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, 'turn probabilities sum to 1')
    assert.ok(Math.max(...Object.values(s.decision.probs.turn)) < 0.999, 'a real distribution, not one-hot')
    assert.match(s.stateText, /health \d+\/100\s+ammo \d+/)
    const jev = await (await fetch(`${v.base}/jev`)).json()
    assert.equal(jev.calls, 60)
    assert.equal(jev.last.questions.length, 4)
    assert.ok(jev.costUsd > 0)
  } finally { await v.viewer.close() }
})

test('level.json really takes effect (title, map, pace), and pane overrides work', async () => {
  const map = ['##########', '#P.......#', '#........#', '#...%%...#', '#........#', '#......D.#', '#........#', '##########']
  const v = await boot({ title: 'Tiny Box', map, demonSpeed: 2.5, demons: 2, kills: 3 })
  try {
    const s = await v.state()
    assert.equal(s.title, 'Tiny Box')
    assert.deepEqual(s.map, map)
    assert.equal(s.cfg.demonSpeed, 2.5)
    assert.equal(s.need, 3)
    assert.equal(s.mapError, null)
    await v.ctl({ cmd: 'set', key: 'demonSpeed', value: 4 })
    assert.equal((await v.state()).demonSpeed, 4)
    const before = (await v.state()).demons.length
    await v.ctl({ cmd: 'spawn', x: 5, y: 2 })
    await v.ctl({ cmd: 'spawn', x: 0, y: 0 }) // a wall: must be ignored
    assert.equal((await v.state()).demons.length, before + 1)
    await v.ctl({ cmd: 'medkit', x: 3, y: 5 })
    assert.ok((await v.state()).pickups.some((k) => k.k === 'medkit'))
  } finally { await v.viewer.close() }
})

test('a progressive verdict is written', async () => {
  const v = await boot()
  try {
    await v.ctl({ cmd: 'tick', n: 30 })
    const file = join(v.ws, '.harness/verdict.json')
    assert.ok(existsSync(file))
    const verdict = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(verdict.spec, 1)
    assert.equal(verdict.ready, true)
    assert.match(verdict.summary, /wave 1/)
    assert.ok(Array.isArray(verdict.findings) && Array.isArray(verdict.phases))
    assert.equal(verdict.artifact, 'level.json')
  } finally { await v.viewer.close() }
})

test('every control command answers 200, and junk is rejected', async () => {
  const v = await boot()
  try {
    for (const cmd of ['pause', 'tick', 'start', 'pause', 'swarm', 'reset']) assert.equal((await v.ctl({ cmd })).status, 200, cmd)
    assert.equal((await v.ctl({ cmd: 'human', turn: 'LEFT', move: 'FORWARD', fire: true })).status, 200)
    assert.equal((await v.ctl({ cmd: 'set', key: 'not-a-key', value: 1 })).status, 200)
    const bad = await fetch(`${v.base}/control`, { method: 'POST', body: '{not json' })
    assert.equal(bad.status, 400)
    assert.equal((await fetch(`${v.base}/nope`)).status, 404)
  } finally { await v.viewer.close() }
})

test('the person can take the controls, and Jev gets them back', async () => {
  const v = await boot()
  try {
    const a0 = (await v.state()).player.a
    await v.ctl({ cmd: 'human', turn: 'RIGHT_HARD', move: 'HOLD', fire: false })
    await v.ctl({ cmd: 'tick' })
    const s = await v.state()
    assert.equal(s.driver, 'human')
    assert.ok(Math.abs(s.player.a - a0) > 0.4, 'a hard right turn moved the view')
    await new Promise((r) => setTimeout(r, 450))
    assert.equal((await v.state()).driver, 'jev')
  } finally { await v.viewer.close() }
})

test('a broken level.json keeps the fight alive and reports the problem', async () => {
  const v = await boot()
  try {
    writeFileSync(join(v.ws, 'level.json'), '{ "title": "oops", ')
    await new Promise((r) => setTimeout(r, 250))
    await v.ctl({ cmd: 'tick', n: 5 })
    let s = await v.state()
    assert.match(String(s.cfgError), /level\.json/)
    assert.ok(s.t >= 5)
    writeFileSync(join(v.ws, 'level.json'), JSON.stringify({ ...TEMPLATE, map: ['####', '#P.#', '####'] }))
    await new Promise((r) => setTimeout(r, 250))
    s = await v.state()
    assert.equal(s.cfgError, null)
    assert.match(String(s.mapError), /map must be 8 to 40 rows/)
    assert.deepEqual(s.map, DEFAULT_MAP, 'falls back to the built-in map')
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

test('the dial is honest: fast demons kill Jev far more often than slow ones', async () => {
  const run = async (demonSpeed) => {
    const v = await boot({ demonSpeed })
    try { await v.ctl({ cmd: 'tick', n: 4000 }); return (await v.state()).session } finally { await v.viewer.close() }
  }
  const easy = await run(1.0), hard = await run(4.5)
  assert.ok(easy.kills > 100 && hard.kills > 100, 'Jev fights in both')
  assert.ok(hard.deaths >= easy.deaths * 2 && hard.deaths >= easy.deaths + 3, `deaths easy ${easy.deaths} vs hard ${hard.deaths}`)
  assert.ok(easy.bestWave > hard.bestWave, `best wave easy ${easy.bestWave} vs hard ${hard.bestWave}`)
})

test('map validation catches the common mistakes', () => {
  assert.equal(parseMap(DEFAULT_MAP).ok, true)
  const box = (rows) => parseMap(rows)
  assert.match(box(['########', '#P.....#', '#......#', '#......#', '#......#', '#......#', '#......#', '########']).error, /at least one D/)
  assert.match(box(['########', '#P....D#', '#......#', '#......#', '#......#', '#......#', '#.....P#', '########']).error, /exactly one P/)
  assert.match(box(['########', '#P....D.', '#......#', '#......#', '#......#', '#......#', '#......#', '########']).error, /border must be wall/)
  assert.match(box(['########', '#P..#.D#', '#...#..#', '#...#..#', '#...#..#', '#...#..#', '#...#..#', '########']).error, /walled off/)
  assert.match(box(['########', '#P...D#', '#......#', '#......#', '#......#', '#......#', '#......#', '########']).error, /wide, expected/)
})

test('the offline stand-in reads only the state text and answers sensibly', () => {
  const text = [
    'You are the marine. style', 'wave 1   kills 0/12   health 80/100   ammo 30',
    'walls: ahead 6.0  left 2.0  right 3.0  behind 4.0', 'one decision turns you: HARD 36 deg, normal 13 deg, FINE 4 deg',
    'demons in sight (bearing in degrees off your crosshair, negative is left):', '  demon#3 bearing -30 distance 5.0',
    'heard but not seen: nothing', 'route to nearest demon: bearing -28 steps 5', 'crosshair on: nothing',
  ].join('\n')
  assert.equal(readState(text).seen[0].b, -30)
  const opts = { options: ['LEFT_HARD', 'LEFT', 'LEFT_FINE', 'AHEAD', 'RIGHT_FINE', 'RIGHT', 'RIGHT_HARD'] }
  assert.equal(fpsMock(text, 'turn', opts).choice, 'LEFT_HARD')
  assert.ok(fpsMock(text, 'fire', {}).noul < 0.2)
  assert.ok(fpsMock(text.replace('crosshair on: nothing', 'crosshair on: demon#3 distance 5.0'), 'fire', {}).noul > 0.8)
  assert.equal(fpsMock('nothing to do with a shooter', 'turn', opts), null)
})

test('check.mjs accepts the template and rejects bad values', () => {
  const run = (level) => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-fps-check-'))
    writeFileSync(join(ws, 'level.json'), JSON.stringify(level))
    try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'toolchain/check.mjs')], { env: { ...process.env, HARNESS_WORKSPACE: ws }, encoding: 'utf8' }) } }
    catch (e) { return { code: e.status, out: String(e.stdout) } }
  }
  assert.equal(run(TEMPLATE).code, 0)
  const fast = run({ ...TEMPLATE, demonSpeed: 99 })
  assert.equal(fast.code, 1); assert.match(fast.out, /demonSpeed/)
  const holed = run({ ...TEMPLATE, map: TEMPLATE.map.map((r, i) => (i === 0 ? r.replace('#', '.') : r)) })
  assert.equal(holed.code, 1); assert.match(holed.out, /border must be wall/)
})
