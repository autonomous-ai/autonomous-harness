// Viewer integration test for Jev Pong. Spins up the real viewer against a temp workspace and
// checks the loop: the court ticks and the ball moves, Jev forms a defensive move, the verdict
// updates, and control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Pong', instrument: 'PONG', courtW: 200, courtH: 120, paddleH: 26, ballR: 3,
  speed: 6, maxSpeed: 3, accel: 0.5, topSpeed: 14, stepMs: 40,
  style: 'Keep the rally alive.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-pong-test-'))
  writeFileSync(join(ws, 'pong.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startPongViewer } = await import(viewerPath)
  const viewer = await startPongViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Pong ticks and Jev forms a defensive move', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 3000
    let saw = false
    while (Date.now() < deadline) {
      await wait(150)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.step >= 3 && s.history.length > 0) {
        assert.ok(['MOVE_UP_FAST', 'MOVE_UP', 'HOLD', 'MOVE_DOWN', 'MOVE_DOWN_FAST'].includes(s.lastMove))
        assert.ok(typeof s.ball.x === 'number' && typeof s.ball.y === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the court to tick and Jev to move')
  } finally {
    await viewer.close()
  }
})

test('Jev Pong writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) { await wait(150); if (existsSync(join(ws, '.harness/verdict.json'))) break }
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Pong control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('tick'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})
