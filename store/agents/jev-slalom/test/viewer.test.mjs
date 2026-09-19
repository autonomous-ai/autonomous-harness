// Viewer integration test for Jev Slalom. Spins up the real viewer against a temp workspace and
// checks the loop: the skier descends, Jev steers, the verdict updates, and control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Run', instrument: 'SLALOM', tickMs: 100, speed: 2.0, gates: 10, valleyWidth: 18,
  style: 'Thread the gates.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-slalom-test-'))
  writeFileSync(join(ws, 'slalom.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startSlalomViewer } = await import(viewerPath)
  const viewer = await startSlalomViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Slalom descends and Jev steers', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 2500
    let saw = false
    while (Date.now() < deadline) {
      await wait(120)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.history.length >= 3) {
        assert.ok(['LEFT_FAST', 'LEFT', 'HOLD', 'RIGHT', 'RIGHT_FAST'].includes(s.move))
        assert.ok(typeof s.x === 'number')
        assert.ok(typeof s.rows === 'number')
        assert.ok(Array.isArray(s.gates) && s.gates.length === 10)
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the skier to descend and Jev to steer')
  } finally {
    await viewer.close()
  }
})

test('Jev Slalom writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 1500
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

test('Jev Slalom control commands answer 200', async () => {
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
