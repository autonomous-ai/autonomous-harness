/**
 * Opt-in deployment integration: two CLI processes, two backend instances sharing real Mongo/Redis,
 * password linking, store viewers, browser interaction, and lifecycle failures. All roles run on
 * this host. This is not a physical two-machine, hosted-relay, or complete Flutter UI test.
 * See docs/plans/2026-09-17-004-remote-viewers.md for prerequisites and the exact scope.
 */
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, cp, symlink } from 'node:fs/promises'
import { tmpdir, hostname, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'

if (process.env.HARNESS_VIEWER_STACK !== '1') throw new Error('Opt in with HARNESS_VIEWER_STACK=1')
const servicesDir = process.env.HARNESS_E2E_SERVICES_DIR
if (!servicesDir) throw new Error('HARNESS_E2E_SERVICES_DIR must contain mongodb-memory-server and redis-memory-server')
const services = createRequire(join(resolve(servicesDir), 'package.json'))
const { MongoMemoryReplSet } = services('mongodb-memory-server')
const { RedisMemoryServer } = services('redis-memory-server')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { chromium } = createRequire(join(repo, 'store/agents/godogen/package.json'))('playwright')
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'harness-viewer-stack-'))
const cleanups: Array<() => unknown | Promise<unknown>> = []
const checks: string[] = []
let completed = false
const checkpoint = (message: string) => { checks.push(message); console.log(`PASS ${message}`) }
console.log(`Artifacts and logs: ${root}`)
async function until(label: string, check: () => unknown | Promise<unknown>, ms = 45_000) {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; logs: ${root}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
async function freePort(): Promise<number> {
  const server = netServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return
  const exited = once(child, 'exit')
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 8000)
  await exited
  clearTimeout(timer)
}
function run(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = createWriteStream(join(root, `${name}.log`), { flags: 'a' })
  child.stdout!.pipe(output)
  child.stderr!.pipe(output)
  cleanups.push(() => stop(child))
  return child
}
async function commandWithInput(args: string[], env: NodeJS.ProcessEnv, input: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: join(repo, 'cli'), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanups.push(() => stop(child))
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  child.stdin.end(input + '\n')
  const timer = setTimeout(() => { void stop(child) }, 45_000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  assert.equal(code, 0, `CLI ${args[0]} failed: ${output}`)
  return output
}
async function desktop(port: number, machineId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`)
  cleanups.push(() => ws.terminate())
  const frames: any[] = []
  ws.on('message', (raw, binary) => { if (!binary) frames.push(JSON.parse(raw.toString())) })
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
  await until('desktop selected machine', () => frames.some(f => f.type === 'connected'))
  return {
    ws, frames,
    async rpc(type: string, payload: object = {}) {
      const requestId = randomUUID()
      ws.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
      await until(type, () => frames.some(f => f.payload?.requestId === requestId), 60_000)
      const response = frames.find(f => f.payload?.requestId === requestId).payload
      assert.ok(!response.error, `${type}: ${JSON.stringify(response)}`)
      return response
    },
  }
}

try {
  const mongo = await MongoMemoryReplSet.create({
    binary: { ...(process.env.HARNESS_E2E_MONGOD ? { systemBinary: process.env.HARNESS_E2E_MONGOD } : {}) },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  })
  cleanups.push(() => mongo.stop())
  const redis = new RedisMemoryServer({ binary: {
    ...(process.env.HARNESS_E2E_REDIS_SERVER ? { systemBinary: process.env.HARNESS_E2E_REDIS_SERVER } : {}),
  } })
  cleanups.push(() => redis.stop())
  const redisPort = await redis.getPort()
  const token = `viewer-fixture-${randomUUID()}`
  const userId = randomUUID().replaceAll('-', '')
  const sso = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: userId, email: `${userId}@local.invalid` } }))
  }).listen(0, '127.0.0.1')
  await once(sso, 'listening')
  cleanups.push(() => { sso.closeAllConnections(); sso.close() })
  const backendPorts = [await freePort(), await freePort()]
  const proxyPorts = [await freePort(), await freePort()]
  const backendEnv = { ...process.env, NODE_ENV: 'test', DATABASE_URL: mongo.getUri('viewer'),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    TERMINAL_P2P_ROLLOUT_PERCENT: '0', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    cwd: join(repo, 'backend'), env: backendEnv, timeout: 60_000,
  })
  async function bootBackend(index: number) {
    const child = run(`backend-${index}`, join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], {
      ...backendEnv, PORT: String(backendPorts[index]), PORT_APP_PROXY: String(proxyPorts[index]), BACKEND_INSTANCE_ID: `viewer-${index}`,
    })
    await until('backend health', () => fetch(`http://127.0.0.1:${backendPorts[index]}/api/health`).then(r => r.ok).catch(() => false))
    return child
  }
  await bootBackend(0)
  let localBackend = await bootBackend(1)
  const engine = join(root, 'claude')
  await writeFile(engine, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0) }
process.title = 'claude'; process.stdin.setRawMode?.(true);
console.log('VIEWER_STACK_READY');
process.stdin.on('data', chunk => process.stdout.write('ECHO:' + chunk.toString() + '\\r\\n'));
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  const harnesses = ['blender', 'marp', 'manim', 'godogen']
  const packages = [...harnesses.map(name => `agents/${name}`), ...['game', 'model', 'video'].map(name => `viewers/${name}-viewer`)]
  async function machine(name: string, index: number) {
    const dir = join(root, name), data = join(dir, 'data'), auth = join(dir, 'auth')
    const computerId = randomUUID().replaceAll('-', ''), port = await freePort()
    const socket = join(dir, 'tmux.sock')
    for (const path of [data, auth, join(dir, 'dsh'), join(dir, 'runtime'), join(dir, 'claude')]) await mkdir(path, { recursive: true })
    const base = `http://127.0.0.1:${backendPorts[index]}`
    const response = await fetch(`${base}/api/machines/resolve-computer`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-autonomous-env': 'prod' },
      body: JSON.stringify({ computerId, label: `viewer-test-${name}` }),
    })
    const result = await response.json() as any
    assert.ok(response.ok && result.data?.machine?.machineId, JSON.stringify(result))
    const id = result.data.machine.machineId
    await writeFile(join(auth, 'session.json'), JSON.stringify({ version: 1, accessToken: token, refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000, autonomousEnv: 'prod', computerId, machineId: id, updatedAt: Date.now() }), { mode: 0o600 })
    // Seed the installed index with this checkout. Toolchain installation/model execution is outside
    // this viewer test; manifests, materialization, viewer commands and processes are unchanged.
    await writeFile(join(dir, 'dsh/installed.json'), JSON.stringify(packages.map(path => {
      const pkg = join(repo, 'store', path)
      return { id: JSON.parse(readFileSync(join(pkg, 'harness.json'), 'utf8')).id, dir: pkg,
        source: pkg, ref: null, commit: null, linked: true, installedAt: Date.now() }
    })))
    await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'])
    cleanups.push(() => exec('tmux', ['-S', socket, 'kill-server']).catch(() => {}))
    const env = { ...process.env, NODE_ENV: 'test', TMUX: `${socket},0,0`, PORT: String(port),
      HARNESS_AUTH_DIR: auth, ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(dir, 'computer-id'),
      ADAPTER_DATA_DIR: data, ADAPTER_RUNTIME_DIR: join(dir, 'runtime'), DSH_DIR: join(dir, 'dsh'), CLAUDE_PATH: engine,
      CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_PROJECTS_DIR: join(dir, 'claude/projects'),
      BACKEND_WS_URL: base.replace('http:', 'ws:'), WEB_URL: base, HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
      DISABLE_HOOK_INSTALL: 'true', ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false',
      RECAP_WITHOUT_DEVICE: 'false', CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true', TERMINAL_BACKENDS: 'tmux',
      TMUX_REAP_INTERVAL_MS: '5000', TERMINAL_RECONCILE_INTERVAL_MS: '5000' }
    async function boot() {
      const child = run(`cli-${name}`, join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], env)
      await until(`${name} CLI connected`, () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-adapter-local': '1' } })
        .then(r => r.json()).then((v: any) => v.connected && v.discoveryReady).catch(() => false))
      return child
    }
    return { id, port, dir, env, boot, child: await boot() }
  }
  const remote = await machine('remote', 0)
  const local = await machine('local', 1)
  const password = `viewer-test-${randomUUID()}`
  await commandWithInput(['remote-password', 'set', '--stdin'], remote.env, password)
  await commandWithInput(['link', 'connect', remote.id, '--stdin', '--json'], local.env, password)
  checkpoint('real password linking across two backend instances and Redis')
  let remoteDesktop = await desktop(local.port, remote.id)
  const directDesktop = await desktop(remote.port, remote.id)
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.HARNESS_VIEWER_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'],
  })
  cleanups.push(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  cleanups.push(async () => {
    if (!completed) for (const [index, page] of context.pages().entries()) {
      await page.screenshot({ path: join(root, `failure-${index}.png`), timeout: 5000 }).catch(() => {})
      await writeFile(join(root, `failure-${index}.html`), await page.content().catch(() => 'page unavailable'))
    }
  })
  const agents = new Map<string, { id: string; workspace: string; page: any; localUrl: string; remoteUrl: string }>()
  async function agentUrl(client: Awaited<ReturnType<typeof desktop>>, id: string) {
    let url: string | undefined
    await until('viewer URL', async () => {
      const rows = (await client.rpc('agents_list')).agents
      url = rows.find((a: any) => a.id === id)?.viewerUrl
      return url
    })
    return url!
  }
  for (const name of harnesses) {
    const workspace = join(remote.dir, 'workspaces', name)
    await cp(join(repo, 'store/agents', name, 'template'), workspace, { recursive: true })
    if (name === 'godogen') await symlink(join(repo, 'store/agents/godogen/node_modules'), join(workspace, 'node_modules'))
    if (name === 'blender') {
      await mkdir(join(workspace, 'out'), { recursive: true })
      const data = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]).buffer)
      await writeFile(join(workspace, 'out/triangle.gltf'), JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'Remote triangle' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ uri: `data:application/octet-stream;base64,${data.toString('base64')}`, byteLength: data.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }] }))
      await writeFile(join(workspace, 'out/large.bin'), Buffer.alloc(12 * 1024 * 1024 + 17, 0x5a))
    }
    if (name === 'manim') {
      await mkdir(join(workspace, 'out'), { recursive: true })
      await exec(process.env.HARNESS_E2E_FFMPEG || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15',
        '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(workspace, 'out/sample.mp4')], { timeout: 30_000 })
    }
    const created = await remoteDesktop.rpc('agent_create', { engine: 'claude', cwd: workspace,
      dsh: `autonomous/${name}`, creationId: randomUUID() })
    assert.ok(created.agent?.id, JSON.stringify(created))
    const id = created.agent.id
    const localUrl = await agentUrl(directDesktop, id)
    const remoteUrl = await agentUrl(remoteDesktop, id)
    assert.notEqual(new URL(localUrl).origin, new URL(remoteUrl).origin)
    assert.ok(remoteUrl.includes('/__harness_viewer/'))
    assert.equal((await fetch(localUrl)).status, 200)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.goto(remoteUrl)
    if (name === 'godogen') {
      await page.waitForFunction(() => document.querySelector('#frames iframe.active') && !(document.querySelector('#play') as HTMLButtonElement)?.disabled, null, { timeout: 90_000 })
      await page.locator('#play').click()
      await page.waitForTimeout(500)
      await page.keyboard.down('KeyD')
      await page.waitForTimeout(400)
      await page.keyboard.up('KeyD')
      const activeSrc = await page.locator('#frames iframe.active').getAttribute('src')
      const frame = page.frames().find((f: any) => f.url() === new URL(activeSrc, page.url()).href)
      assert.ok(await frame.evaluate(() => (window as any).harnessGame.stats().positionX > 0), 'the active game responds to keyboard input')
    } else if (name === 'blender') {
      await page.waitForFunction(() => document.querySelector('#model-name')?.textContent === 'triangle.gltf' && !!document.querySelector('#tree .row'), null, { timeout: 45_000 })
      const expected = createHash('sha256').update(await import('node:fs/promises').then(fs => fs.readFile(join(workspace, 'out/large.bin')))).digest('hex')
      const response = await page.request.get(new URL('/ws/out/large.bin', page.url()).href)
      assert.equal(createHash('sha256').update(await response.body()).digest('hex'), expected)
      const range = await page.request.get(new URL('/ws/out/large.bin', page.url()).href, { headers: { Range: 'bytes=17-1048592' } })
      assert.equal(range.status(), 206)
      assert.equal((await range.body()).length, 1048576)
      assert.equal(await page.evaluate(async () => (await fetch('/ws/out/large.bin', { method: 'HEAD' })).status), 200)
    } else if (name === 'marp') {
      await page.waitForFunction(() => (document.querySelectorAll('#strip .thumb').length || document.querySelectorAll('#stage svg').length) > 0)
      const deck = join(workspace, 'deck.md')
      await writeFile(deck, readFileSync(deck, 'utf8') + '\n---\n\n# Remote edit arrived\n')
      await page.waitForFunction(() => document.body.textContent?.includes('Remote edit arrived'))
      const counter = await page.locator('#counter').innerText()
      await page.locator('#prev').click()
      assert.notEqual(await page.locator('#counter').innerText(), counter)
    } else {
      await page.waitForFunction(() => (document.querySelector('#video') as HTMLVideoElement)?.readyState >= 2)
      assert.equal((await page.request.get(new URL('/api/library', page.url()).href)).status(), 200)
      await page.evaluate(() => { const video = document.querySelector('#video') as HTMLVideoElement; video.currentTime = 1.5; return video.play() })
      await page.waitForFunction(() => (document.querySelector('#video') as HTMLVideoElement)?.currentTime > 1.6)
    }
    assert.deepEqual(errors, [], `${name} browser exceptions`)
    await page.screenshot({ path: join(root, `${name}-forwarded.png`) })
    agents.set(name, { id, workspace, page, localUrl, remoteUrl })
    checkpoint(`${name}: real viewer command, direct HTTP and encrypted browser forwarding`)
  }
  // Verify the SAME store viewer locally in a fresh browser context, without the forwarding gateway.
  const localContext = await browser.newContext()
  for (const [name, agent] of agents) {
    const page = await localContext.newPage()
    assert.equal((await page.goto(agent.localUrl)).status(), 200)
    await page.waitForLoadState('load')
    await page.screenshot({ path: join(root, `${name}-direct.png`) })
    await page.close()
  }
  await localContext.close()
  checkpoint('all four viewers also opened directly in Chrome')
  const slides = agents.get('marp')!
  const oldUrl = slides.remoteUrl
  await remoteDesktop.rpc('agent_restart', { agentId: slides.id })
  const restarted = await agentUrl(remoteDesktop, slides.id)
  // Restarting the model process deliberately keeps its healthy viewer running.
  assert.equal(new URL(restarted).origin, new URL(oldUrl).origin)
  assert.equal((await fetch(oldUrl, { redirect: 'manual' })).status, 302)
  await slides.page.goto(restarted)
  await slides.page.waitForFunction(() => document.body.textContent?.includes('Remote edit arrived'))
  checkpoint('real agent restart preserves the healthy viewer and edited slides')

  remoteDesktop.ws.terminate()
  await stop(localBackend)
  await until('gateway closes on relay outage', () => fetch(restarted).then(() => false).catch(() => true))
  localBackend = await bootBackend(1)
  remoteDesktop = await desktop(local.port, remote.id)
  const reconnected = await agentUrl(remoteDesktop, slides.id)
  await slides.page.goto(reconnected)
  await slides.page.waitForFunction(() => document.body.textContent?.includes('Remote edit arrived'))
  checkpoint('backend process outage, reconnect and viewer recovery')

  const localStatus = await fetch(`http://127.0.0.1:${local.port}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()) as any
  const revoked = await fetch(`http://127.0.0.1:${remote.port}/api/revoke`, { method: 'POST',
    headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: localStatus.fingerprint }) })
  assert.equal(revoked.status, 200)
  await until('revocation closes local forwarding', () => fetch(reconnected).then(() => false).catch(() => true))
  assert.ok(!readFileSync(join(local.dir, 'data/e2e/machinePeers.json'), 'utf8').includes(remote.id))
  checkpoint('revocation removes persisted peer trust and closes forwarded access')
  for (const agent of agents.values()) await directDesktop.rpc('agent_delete', { agentId: agent.id })
  assert.equal((await directDesktop.rpc('agents_list')).agents.length, 0)
  checkpoint('all test agents deleted through real daemon RPC')
  completed = true
} finally {
  for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch (error) { console.error('Cleanup:', error) } }
  await writeFile(join(root, 'results.json'), JSON.stringify({ host: hostname(), os: `${process.platform} ${release()}`,
    topology: 'one physical host; two CLIs; two backend instances; real Redis and MongoDB; fixture SSO/model CLI',
    completed, checks, nativeDesktopTested: false, physicalRemoteTested: false }, null, 2))
}
