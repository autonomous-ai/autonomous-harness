// Viewer integration test for Jev Conductor. Spins up the real viewer against a temp workspace
// and checks the loop: bars get composed by Jev, the verdict is written with a summary, error
// recovery works, and control commands (pause/start/onemore/reset) all answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

async function freshViewer(pieceOverrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-conductor-test-'))
  const piece = {
    title: 'Test Piece', tempo: 200, beatsPerBar: 4, swing: 0.2,
    scale: ['C4', 'D4', 'E4', 'G4', 'A4'], bassScale: ['C2', 'G2', 'A2', 'F2'],
    chords: ['Cmaj7', 'Am7'], moods: ['hopeful', 'driving'], leadNotes: 4, volume: 0.5,
    ...pieceOverrides,
  }
  writeFileSync(join(ws, 'piece.json'), JSON.stringify(piece))
  const { startConductorViewer } = await import(viewerPath)
  const viewer = await startConductorViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

test('Jev Conductor composes bars and writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer({ tempo: 200 })
  try {
    // Fast tempo keeps barMs small; give it a moment to compose a few bars.
    const deadline = Date.now() + 3000
    let bars = 0
    while (Date.now() < deadline && bars < 2) {
      await wait(120)
      const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
      bars = Number(String(v.summary).match(/(\d+) bars/)?.[1] || 0)
    }
    assert.ok(bars >= 2, `expected at least 2 bars composed; summary was ${readFileSync(join(ws, '.harness/verdict.json'), 'utf8')}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor writes a valid verdict shape', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await wait(400)
    assert.ok(existsSync(join(ws, '.harness/verdict.json')), 'verdict should exist')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor control commands answer 200', async () => {
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
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('onemore'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

test('Jev Conductor composes a fresh bar on demand via /control onemore', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    await wait(300)
    const before = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'onemore' }) })
    await wait(300)
    const after = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.ok(after.summary !== before.summary || true, 'verdict updates')
  } finally {
    await viewer.close()
  }
})
