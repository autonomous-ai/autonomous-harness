// The server as Harness runs it: a real process on a loopback port, a scratch workspace and a scratch
// Menagerie. What the pane opens for every shape a workspace can be in (a rollout, a verdict that
// names the video, a report only, a script and no rollout yet, a bare scene, nothing), the files a
// model needs, Range requests for video, path safety, and the change feed.
//
//   npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { createServer } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'mujoco-viewer-test-'))
const workspace = join(root, 'ws')
const menagerie = join(root, 'menagerie')
// A free loopback port unless one is given: setup.sh runs this on machines where anything may be listening.
const port = Number(process.env.TEST_PORT) || await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)) })
})

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

write(join(menagerie, 'bot', 'scene.xml'), `<mujoco><include file="bot.xml"/><worldbody><geom type="plane" size="1 1 .1"/></worldbody></mujoco>`)
write(join(menagerie, 'bot', 'bot.xml'), `<mujoco><compiler meshdir="assets"/><asset><mesh name="m" file="part.obj"/><texture name="t" type="2d" file="skin.png"/></asset>
  <worldbody><body><freejoint/><geom type="mesh" mesh="m"/></body></worldbody></mujoco>`)
write(join(menagerie, 'bot', 'assets', 'part.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
write(join(menagerie, 'bot', 'skin.png'), 'png')
write(join(menagerie, 'bot', 'README.md'), 'not a model file')

const get = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  req.end()
})
const json = async (path) => JSON.parse((await get(path)).body.toString())

const child = spawn(process.execPath, [join(here, '..', 'viewer.mjs')], {
  env: { ...process.env, HARNESS_VIEWER_PORT: String(port), HARNESS_WORKSPACE: workspace, MENAGERIE: menagerie },
  stdio: ['ignore', 'pipe', 'inherit'],
})
mkdirSync(workspace, { recursive: true })
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve() })
  child.on('exit', (code) => reject(new Error(`viewer exited ${code}`)))
  setTimeout(() => reject(new Error('viewer did not start')), 10_000)
})

try {
  // Nothing yet: nothing to open, and the picker lists the robots.
  let r = await json('/api/resolve?file=')
  assert.equal(r.model, null)
  const models = await json('/api/models')
  assert.deepEqual(models.robots.map((x) => x.name), ['bot'])

  // A script, no rollout: the model it loads.
  write(join(workspace, 'sim', 'stand.py'), 'from harness_mujoco import load_menagerie\nmodel, data = load_menagerie("bot", servos=(60, 2))\n')
  r = await json('/api/resolve?file=')
  assert.equal(r.model, 'menagerie/bot/scene.xml')
  assert.equal(r.source, 'script')

  // A script that builds the path by hand is read too.
  write(join(workspace, 'sim', 'stand.py'), 'spec = mujoco.MjSpec.from_file(str(Path(os.environ["MENAGERIE"]) / "bot" / "scene.xml"))\n')
  r = await json('/api/resolve?file=')
  assert.equal(r.model, 'menagerie/bot/scene.xml')

  // A bare scene in the workspace wins over nothing, loses to a script's model.
  rmSync(join(workspace, 'sim'), { recursive: true })
  write(join(workspace, 'scenes', 'arm.xml'), '<mujoco model="arm"><worldbody><geom size=".1"/></worldbody></mujoco>')
  r = await json('/api/resolve?file=')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.source, 'workspace')

  // An old verdict that names the video, with no trajectory: still a model (from the report), and the video on the side.
  write(join(workspace, 'out', 'rollout.mp4'), Buffer.alloc(4096, 7))
  write(join(workspace, 'out', 'rollout.json'), JSON.stringify({ model_path: 'menagerie/bot/scene.xml', video: 'out/rollout.mp4' }))
  r = await json('/api/resolve?file=out/rollout.mp4')
  assert.equal(r.model, 'menagerie/bot/scene.xml')
  assert.equal(r.video, 'out/rollout.mp4')
  assert.equal(r.trajectory, null)

  // A rollout with a compiled-model snapshot: the verdict names the trajectory, the video, the report or nothing — same answer.
  write(join(workspace, 'out', 'rollout.model.xml'), '<mujoco><compiler meshdir="assets/"/><asset><mesh name="m" file="part.obj"/></asset><worldbody><geom type="mesh" mesh="m"/></worldbody></mujoco>')
  write(join(workspace, 'out', 'rollout.qpos.json'), JSON.stringify({ version: 2, status: 'done', model: 'menagerie/bot/scene.xml', model_xml: 'out/rollout.model.xml', video: 'out/rollout.mp4', dt: 0.034, qpos: [[0, 0, 1, 1, 0, 0, 0]], ctrl: [[]] }))
  for (const file of ['out/rollout.qpos.json', 'out/rollout.mp4', 'out/rollout.json', '', 'something/else.json']) {
    r = await json(`/api/resolve?file=${encodeURIComponent(file)}`)
    assert.equal(r.trajectory, 'out/rollout.qpos.json', `from ${file || 'nothing'}`)
    assert.equal(r.model, 'menagerie/bot/scene.xml')
    assert.equal(r.modelXml, 'out/rollout.model.xml')
    assert.equal(r.video, 'out/rollout.mp4')
    assert.equal(r.trajectoryStatus, 'done')
  }
  // Picking another model sets the rollout aside.
  r = await json('/api/resolve?file=out/rollout.qpos.json&model=scenes/arm.xml')
  assert.equal(r.model, 'scenes/arm.xml')
  assert.equal(r.trajectory, null)

  // The files a model needs: includes, meshdir, textures — not the README, not the whole directory.
  const deps = await json('/api/files?model=menagerie/bot/scene.xml')
  assert.deepEqual(deps.files.map((f) => f.path).sort(), ['menagerie/bot/assets/part.obj', 'menagerie/bot/bot.xml', 'menagerie/bot/scene.xml', 'menagerie/bot/skin.png'])
  const snap = await json('/api/files?model=menagerie/bot/scene.xml&xml=out/rollout.model.xml')
  assert.ok(snap.files.some((f) => f.path === 'out/rollout.model.xml'))
  assert.ok(snap.files.some((f) => f.path === 'menagerie/bot/assets/part.obj'), 'the snapshot resolves assets from the model directory')
  assert.equal((await get('/api/files?model=menagerie/nope/scene.xml')).status, 404)

  // Video over Range, which WebKit insists on.
  const part = await get('/ws/out/rollout.mp4', { range: 'bytes=100-199' })
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 100-199/4096')
  assert.equal(part.body.length, 100)
  assert.equal((await get('/ws/out/rollout.mp4', { range: 'bytes=5000-' })).status, 416)
  assert.equal((await get('/ws/out/rollout.mp4')).headers['accept-ranges'], 'bytes')

  // The page, the engine, and nothing outside the two roots.
  assert.equal((await get('/')).status, 200)
  assert.match((await get('/static/main.js')).headers['content-type'], /javascript/)
  assert.equal((await get('/vendor/mujoco/mujoco.wasm', { range: 'bytes=0-3' })).status, 206)
  assert.equal((await get('/vendor/three/build/three.module.js', { range: 'bytes=0-3' })).status, 206)
  assert.equal((await get('/ws/../../etc/passwd')).status, 404)
  assert.equal((await get('/ws/%2e%2e/%2e%2e/etc/passwd')).status, 404)
  assert.equal((await get('/ws/out%2F..%2F..%2F..%2Fetc%2Fpasswd')).status, 404)
  assert.equal((await get('/static/../viewer.mjs')).status, 404)
  assert.equal((await get('/static/..%2Fviewer.mjs')).status, 404)
  assert.equal((await get('/api/files?model=..%2F..%2Fetc%2Fhosts')).status, 400)

  // The change feed: the agent writes, the pane hears which path.
  const heard = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        // Only what arrives after the write counts: earlier writes in this test may still be in the feed.
        for (const match of buffer.matchAll(/event: change\ndata: (.*)\n/g)) {
          const paths = JSON.parse(match[1]).paths
          if (written && paths.includes('out/rollout.qpos.json')) { req.destroy(); resolve(paths) }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
      })
    })
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e) })
    req.end()
    let written = false
    setTimeout(() => { write(join(workspace, 'out', 'rollout.qpos.json'), JSON.stringify({ status: 'recording', model: 'menagerie/bot/scene.xml', qpos: [[0]] })); written = true }, 600)
    setTimeout(() => reject(new Error('no change event')), 8000)
  })
  assert.ok(heard.includes('out/rollout.qpos.json'), `heard ${heard}`)
  r = await json('/api/resolve?file=')
  assert.equal(r.trajectoryStatus, 'recording')

  console.log('ok   viewer server: resolve (7 workspace shapes), model files, Range, path safety, change feed')
} finally {
  child.kill()
  rmSync(root, { recursive: true, force: true })
}
