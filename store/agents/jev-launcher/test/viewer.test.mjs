// Viewer integration test for Jev Launcher. Spins up the real viewer against a temp workspace and
// checks the loop: posting a query makes Jev rank the palette (a top pick with probabilities), the
// verdict updates, and control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const LAUNCHER = {
  title: 'Test Palette', description: 'x', prompt: 'Pick the best match, be decisive.',
  targets: [
    { name: 'Run tests', category: 'Dev', aliases: ['test', 'pytest', 'spec'], featured: true },
    { name: 'Deploy to prod', category: 'Ops', aliases: ['ship', 'release', 'deploy'] },
    { name: 'Music', category: 'Media', aliases: ['spotify', 'play', 'tunes'] },
    { name: 'Open Editor', category: 'Apps', aliases: ['code', 'vscode', 'ide'] },
  ],
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-launcher-test-'))
  writeFileSync(join(ws, 'launcher.json'), JSON.stringify({ ...LAUNCHER, ...overrides }))
  const { startLauncherViewer } = await import(viewerPath)
  const viewer = await startLauncherViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

const post = async (port, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.status
}

test('Jev Launcher posts a query and ranks a target with probabilities', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    assert.equal(await post(port, { cmd: 'query', query: 'deploy' }), 200)
    const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
    assert.equal(s.query, 'deploy')
    assert.ok(s.history.length >= 1)
    const last = s.history[s.history.length - 1]
    assert.ok(last.top, 'expected a top pick')
    assert.ok(last.conf >= 0 && last.conf <= 1)
    assert.ok(s.rank, 'expected full probabilities')
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher matching query picks the right target', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    await post(port, { cmd: 'query', query: 'test' })
    const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
    assert.equal(s.history[s.history.length - 1].top, 'Run tests')
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher writes a progressive verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    await post(port, { cmd: 'query', query: 'edit' })
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
    assert.ok(v.ready)
  } finally {
    await viewer.close()
  }
})

test('Jev Launcher control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    assert.equal(await post(port, { cmd: 'query', query: 'music' }), 200)
    assert.equal(await post(port, { cmd: 'launch' }), 200)
    assert.equal(await post(port, { cmd: 'reset' }), 200)
  } finally {
    await viewer.close()
  }
})
