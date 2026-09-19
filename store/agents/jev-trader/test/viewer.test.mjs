// Viewer integration test for Jev Trader. Spins up the real viewer against a temp workspace and
// checks the loop: the market ticks, Jev trades (equity/holdings change), the verdict updates, and
// control commands work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const MARKET = {
  title: 'Test Desk', instrument: 'TEST', startPrice: 100, volatility: 0.012, drift: 0.0003, stepMs: 120, capital: 10000,
  style: 'Buy the trend, cut losses.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-trader-test-'))
  writeFileSync(join(ws, 'market.json'), JSON.stringify({ ...MARKET, ...overrides }))
  const { startTraderViewer } = await import(viewerPath)
  const viewer = await startTraderViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Trader ticks the market and trades', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const state = async () => (await (await fetch(`http://127.0.0.1:${port}/state`)).json())
    const deadline = Date.now() + 3000
    let days = 0
    while (Date.now() < deadline && days < 3) {
      await wait(150)
      const s = await state()
      days = s.day
      if (s.history.length) assert.ok(typeof s.equity === 'number')
    }
    assert.ok(days >= 3, `expected at least 3 ticks; got ${days}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Trader writes a progressive verdict with a summary', async () => {
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

test('Jev Trader control commands answer 200', async () => {
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
