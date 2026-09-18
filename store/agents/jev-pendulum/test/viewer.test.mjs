// Viewer integration test for Jev Pendulum. Spins up the real viewer against a temp workspace and
// checks the loop: the rod ticks and leans, Jev forms a balancing action, the verdict updates, and
// control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Rod', instrument: 'ROD', gravity: 7, length: 1.0, damping: 0.5, maxTorque: 2.0,
  stepMs: 60, gustEvery: 10, gustStrength: 0.5, fallDeg: 60,
  style: 'Keep the rod upright.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-pendulum-test-'))
  writeFileSync(join(ws, 'pendulum.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startPendulumViewer } = await import(viewerPath)
  const viewer = await startPendulumViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Pendulum ticks and Jev forms a balancing action', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 3000
    let saw = false
    while (Date.now() < deadline) {
      await wait(150)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.step >= 3 && s.history.length > 0) {
        assert.ok(['LEFT_HARD', 'LEFT', 'CENTER', 'RIGHT', 'RIGHT_HARD'].includes(s.lastAction))
        assert.ok(typeof s.angle === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the rod to tick and Jev to act')
  } finally {
    await viewer.close()
  }
})

test('Jev Pendulum writes a progressive verdict', async () => {
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

test('Jev Pendulum control commands answer 200', async () => {
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
