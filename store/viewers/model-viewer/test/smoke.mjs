// The server, end to end, without a browser: it starts viewer.mjs the way Harness does, on a
// scratch workspace, and checks what the page depends on — the shell and its modules, three.js from
// node_modules, the state feed (models newest first, the report beside them, the build feed with a
// dead pid reported as stopped), workspace files with byte ranges, nothing outside the workspace,
// and a server-sent `state` event when the agent writes a new export.
//
//   npm test            (HARNESS_VIEWER_PORT picks the port; a free one otherwise)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT) || await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})
const base = `http://127.0.0.1:${port}`
const ws = mkdtempSync(join(tmpdir(), 'model-viewer-smoke-'))

// a one-triangle glTF with its buffer embedded: enough to be a model
function gltf(scale = 1) {
  const positions = new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0])
  const b64 = Buffer.from(positions.buffer).toString('base64')
  return JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0], extras: { harness: { metres_per_unit: 0.001 } } }],
    nodes: [{ mesh: 0, name: 'Tri' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [scale, scale, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
  })
}

mkdirSync(join(ws, 'out'), { recursive: true })
mkdirSync(join(ws, '.harness'), { recursive: true })
writeFileSync(join(ws, 'out/old.gltf'), gltf(1))
await new Promise((r) => setTimeout(r, 20))
writeFileSync(join(ws, 'out/model.gltf'), gltf(2))
writeFileSync(join(ws, 'out/report.json'), JSON.stringify({ size_mm: [2, 0, 2] }))
writeFileSync(join(ws, 'out/turntable.mp4'), Buffer.alloc(4096, 7))
writeFileSync(join(ws, '.harness/build.json'), JSON.stringify({ state: 'building', step: 'Rendering', pid: 999999 }))

const server = spawn(process.execPath, [join(here, '..', 'viewer.mjs')], { env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: ws }, stdio: ['ignore', 'pipe', 'inherit'] })
const cleanup = () => { server.kill(); rmSync(ws, { recursive: true, force: true }) }
process.on('exit', cleanup)

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the viewer did not start')), 8000)
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
  })

  const page = await fetch(`${base}/?file=out/turntable.mp4`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /importmap/, 'the shell maps three to the package copy')
  for (const path of ['/app/app.js', '/app/viewport.js', '/app/style.css', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/loaders/GLTFLoader.js']) {
    assert.equal((await fetch(base + path)).status, 200, path)
  }
  assert.equal((await fetch(`${base}/vendor/three/package.json`)).status, 403, 'only build/ and examples/jsm/ are served from three')

  const state = await (await fetch(`${base}/api/state`)).json()
  assert.deepEqual(state.models.map((m) => m.path), ['out/model.gltf', 'out/old.gltf'], 'models, newest first')
  assert.equal(state.models[0].report, 'out/report.json', 'the report beside the export')
  assert.equal(state.videos[0].path, 'out/turntable.mp4')
  assert.equal(state.build.state, 'stopped', 'a building feed whose process is gone reads as stopped')

  const range = await fetch(`${base}/ws/out/turntable.mp4`, { headers: { range: 'bytes=10-19' } })
  assert.equal(range.status, 206)
  assert.equal((await range.arrayBuffer()).byteLength, 10)
  // raw requests: fetch would normalise the dots away before they reached the server
  const raw = (path) => new Promise((resolve, reject) => { request({ host: '127.0.0.1', port, path }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject).end() })
  assert.notEqual(await raw('/ws/%2e%2e/%2e%2e/%2e%2e/etc/hosts'), 200, 'nothing outside the workspace')
  assert.notEqual(await raw('/ws/../../../etc/hosts'), 200, 'nothing outside the workspace, unencoded either')
  assert.notEqual(await raw('/app/%2e%2e/viewer.mjs'), 200, 'nothing outside the web folder')
  assert.notEqual(await raw('/%2e%2e/%2e%2e/%2e%2e/etc/hosts'), 200, 'nor through the legacy root paths')

  // live: a new export arrives as a state event
  const controller = new AbortController()
  const events = await fetch(`${base}/events`, { signal: controller.signal })
  const reader = events.body.getReader()
  let buffer = ''
  let pending = null // one read at a time: a read abandoned to a timeout would swallow its chunk
  const next = async (predicate, ms = 6000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      pending ??= reader.read()
      const result = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 250))])
      if (!result) continue
      pending = null
      const { value, done } = result
      if (done) break
      if (value) buffer += new TextDecoder().decode(value)
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop()
      for (const block of blocks) {
        const data = block.split('\n').find((l) => l.startsWith('data: '))
        if (data && predicate(JSON.parse(data.slice(6)))) return true
      }
    }
    return false
  }
  assert.ok(await next((s) => s.models?.length === 2), 'the first event is the current state')
  writeFileSync(join(ws, 'out/lamp.gltf'), gltf(3))
  assert.ok(await next((s) => s.models?.[0]?.path === 'out/lamp.gltf'), 'a new export is announced')
  controller.abort()
  console.log('ok   model-viewer server: shell, three, state, ranges, sandbox, live events')
} finally {
  cleanup()
}
