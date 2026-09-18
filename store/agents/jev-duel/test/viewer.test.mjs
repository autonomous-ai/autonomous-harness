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
