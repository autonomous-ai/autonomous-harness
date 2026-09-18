// Viewer integration test for Jev Guard. Spins up the real viewer against a temp workspace and
// checks the loop: an edit triggers a test run + Jev judgment, the verdict updates, and once the
// agent's fix makes the tests pass, Jev reports the goal met.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

const PROJ_JS = `export function sumTo(n){let s=0;for(let i=1;i<=n;i++)s+=i;return s}
export function factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r}
`
const TEST_JS = `import assert from 'node:assert/strict'
import { sumTo, factorial } from './score.js'
assert.equal(sumTo(5), 15)
assert.equal(factorial(5), 120)
console.log('ALL TESTS PASS')
`

async function freshViewer({ broken = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-guard-test-'))
  mkdirSync(join(ws, 'project'))
  writeFileSync(join(ws, 'goal.json'), JSON.stringify({ name: 'Guard Test', goal: 'Make project/test.js pass.', description: 'test' }))
  if (broken) {
    writeFileSync(join(ws, 'project', 'score.js'), `export function sumTo(n){return 0}\nexport function factorial(n){return n}\n`)
  } else {
    writeFileSync(join(ws, 'project', 'score.js'), PROJ_JS)
  }
  writeFileSync(join(ws, 'project', 'test.js'), TEST_JS)
  const { startGuardViewer } = await import(viewerPath)
  const viewer = await startGuardViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Guard judges the first edit and writes a verdict', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    // Trigger a manual judge (the viewer starts idle; "Judge now" runs the loop).
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'judge' }) })
    await wait(400)
    assert.ok(existsSync(join(ws, '.harness/verdict.json')), 'verdict should exist')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.phases))
    assert.match(v.summary, /failing|judging|1 runs/, `summary should reflect a judged run: ${v.summary}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard detects the agent fixing the tests: passing run → goal met', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
    await ctl('start')
    // The agent fixes the module.
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(ws, 'project', 'score.js'), PROJ_JS)
    const deadline = Date.now() + 4000
    let done = false
    while (Date.now() < deadline && !done) {
      await wait(250)
      const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
      if (/goal met/i.test(v.summary) || /passing/i.test(v.summary)) done = true
    }
    assert.ok(done, `expected a passing/green judgment after the fix; summary was ${readFileSync(join(ws, '.harness/verdict.json'), 'utf8')}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    assert.equal(await ctl('judge'), 200)
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('reset'), 200)
  } finally {
    await viewer.close()
  }
})

test('Jev Guard judges a workspace that already passes', async () => {
  const { ws, viewer } = await freshViewer({ broken: false })
  try {
    const port = viewer.url.split(':').pop()
    await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'judge' }) })
    await wait(400)
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.match(v.summary, /goal met|passing/i, `summary: ${v.summary}`)
  } finally {
    await viewer.close()
  }
})
