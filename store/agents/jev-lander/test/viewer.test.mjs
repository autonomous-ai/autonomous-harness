// Viewer integration test for Jev Lander. Spins up the real viewer against a temp workspace and
// checks the loop: the booster descends, Jev sets throttles, the verdict updates, and control
// commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Landing', instrument: 'LANDER', tickMs: 100, gravity: 1.2, fuel: 260, altitude: 80, safeSpeed: 2.0,
  style: 'Bring it down soft.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-lander-test-'))
  writeFileSync(join(ws, 'lander.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startLanderViewer } = await import(viewerPath)
  const viewer = await startLanderViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Lander descends and Jev sets throttles', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 2500
    let saw = false
    let lastAlt = Infinity
    while (Date.now() < deadline) {
      await wait(120)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.history.length >= 3) {
        assert.ok(['CUT', 'COAST', 'HOVER', 'BURN'].includes(s.thrust))
        assert.ok(typeof s.y === 'number')
        assert.ok(typeof s.v === 'number')
        if (s.y < lastAlt) lastAlt = s.y
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected the booster to descend and Jev to set throttles')
  } finally {
    await viewer.close()
  }
})

test('Jev Lander writes a progressive verdict', async () => {
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

test('Jev Lander control commands answer 200', async () => {
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
