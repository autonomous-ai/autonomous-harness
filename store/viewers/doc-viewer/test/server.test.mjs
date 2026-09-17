// The server as Harness runs it: viewer.sh with a port and a workspace. Serves the reader and pdf.js
// from this package, the workspace read-only, the state over SSE, and refuses what it must.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
let child, base, ws

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) }) })

before(async () => {
  ws = mkdtempSync(join(tmpdir(), 'doc-viewer-srv-'))
  mkdirSync(join(ws, 'out'))
  writeFileSync(join(ws, 'main.typ'), '= Hi')
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(join(ws, 'out', 'main.pdf'), '%PDF-1.7\n%%EOF\n')
  const port = Number(process.env.DOC_VIEWER_TEST_PORT) || await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(join(here, '..', 'viewer.sh'), { env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: ws, DOC_VIEWER_OPEN: 'log' }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((ok, fail) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) ok() })
    child.on('exit', (code) => fail(new Error(`viewer exited ${code}`)))
  })
})
after(() => { child?.kill(); rmSync(ws, { recursive: true, force: true }) })

test('serves the reader and pdf.js from the package', async () => {
  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /\/app\/app\.js/)
  for (const path of ['/app/app.js', '/app/app.css', '/vendor/build/pdf.min.mjs', '/vendor/build/pdf.worker.min.mjs', '/vendor/web/pdf_viewer.mjs', '/vendor/web/pdf_viewer.css', '/vendor/legacy/build/pdf.min.mjs', '/vendor/legacy/web/pdf_viewer.mjs']) {
    const r = await fetch(base + path, { method: 'HEAD' })
    assert.equal(r.status, 200, path)
  }
  assert.equal((await fetch(base + '/vendor/../package.json')).status, 404)
  assert.equal((await fetch(base + '/vendor/node_modules/x')).status, 404)
})

test('serves the workspace read-only and never outside it', async () => {
  const pdf = await fetch(base + '/ws/out/main.pdf')
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.match(pdf.headers.get('cache-control'), /no-store/)
  assert.match((await fetch(base + '/ws/out/main.pdf?download=1')).headers.get('content-disposition'), /attachment/)
  assert.equal((await fetch(base + '/ws/%2e%2e/%2e%2e/etc/passwd')).status, 404)
  assert.equal((await fetch(base + '/out/main.pdf')).status, 200, 'the old root URLs still work')
})

test('the state names the PDF, and the event stream pushes it', async () => {
  const s = await (await fetch(base + '/api/state?file=out/main.pdf')).json()
  assert.equal(s.file, 'out/main.pdf')
  assert.equal(s.build, 'idle')
  assert.equal(s.canOpen, true)
  const ac = new AbortController()
  const r = await fetch(base + '/events?file=', { signal: ac.signal })
  const reader = r.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
  ac.abort()
  assert.match(text, /^event: state\ndata: /)
  assert.equal(JSON.parse(text.split('data: ')[1]).file, 'out/main.pdf')
})

test('opening things needs the page\'s own header, and only opens web links and workspace files', async () => {
  const post = (body, headers = { 'x-doc-viewer': '1' }) => fetch(base + '/api/open', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal((await post({ kind: 'url', url: 'https://typst.app' }, {})).status, 403)
  assert.equal((await post({ kind: 'url', url: 'https://typst.app' })).status, 200)
  assert.equal((await post({ kind: 'url', url: 'file:///etc/passwd' })).status, 400)
  assert.equal((await post({ kind: 'url', url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post({ kind: 'open', path: 'out/main.pdf' })).status, 200)
  assert.equal((await post({ kind: 'reveal', path: '../../etc/passwd' })).status, 404)
})
