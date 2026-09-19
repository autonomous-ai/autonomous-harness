/** Disposable real-machine peer for remote-viewer-live.ts. Requires explicit opt-in. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, createWriteStream, rmSync } from 'node:fs'
import { homedir, hostname, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { newIdentity, b64e } from '../src/lib/e2ee/core.js'

if (process.env.HARNESS_VIEWER_LIVE_TEST !== '1') throw new Error('Opt in with HARNESS_VIEWER_LIVE_TEST=1')
const clientPub = process.argv[2]
if (!clientPub || Buffer.from(clientPub, 'base64').length !== 32) throw new Error('Provide the disposable test client public key')
const root = resolve(process.argv[3] || 'viewer-peer')
if (existsSync(root)) throw new Error('Use a new peer directory')
mkdirSync(root, { recursive: true, mode: 0o700 })
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const originalAuth = JSON.parse(readFileSync(join(homedir(), '.harness/auth/session.json'), 'utf8'))
const status = await fetch('http://127.0.0.1:18473/api/status', { headers: { 'x-adapter-local': '1' } }).then(r => r.json()) as any
const base = String(status.backendUrl).replace(/^ws/, 'http').replace(/\/$/, '')
if (!base.startsWith('https://')) throw new Error('Expected the existing authenticated hosted backend')
const headers = { authorization: `Bearer ${originalAuth.accessToken}`, 'content-type': 'application/json', 'x-autonomous-env': originalAuth.autonomousEnv }
const computerId = randomUUID()
const registered = await fetch(`${base}/api/machines/resolve-computer`, { method: 'POST', headers,
  body: JSON.stringify({ computerId, label: `Viewer QA ${hostname()}` }) })
const registration = await registered.json() as any
if (!registered.ok || !registration.data?.machine?.machineId) throw new Error(`Test machine registration failed (${registered.status})`)
const machineId = registration.data.machine.machineId as string
writeFileSync(join(root, 'registration.json'), JSON.stringify({ machineId, base, computerId }))
const identity = newIdentity()
const socket = join(root, 'tmux.sock')
let child: ReturnType<typeof spawn> | undefined
let stopping = false
async function cleanup() {
  if (stopping) return
  stopping = true
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit')
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    const timer = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL') } catch {} }, 8000)
    await exited
    clearTimeout(timer)
  }
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch {}
  const removed = await fetch(`${base}/api/machines/${machineId}`, { method: 'DELETE', headers })
  console.log(JSON.stringify({ cleanup: true, machineId, deleted: removed.ok, status: removed.status }))
  rmSync(join(root, 'auth'), { recursive: true, force: true })
  process.exit(removed.ok ? 0 : 1)
}
process.on('SIGTERM', () => { void cleanup() })
process.on('SIGINT', () => { void cleanup() })
try {
  for (const path of ['data/e2e', 'auth', 'runtime', 'dsh', 'claude', 'workspaces']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'data/e2e/identity.json'), JSON.stringify({ priv: b64e(identity.priv), pub: b64e(identity.pub) }), { mode: 0o600 })
  writeFileSync(join(root, 'data/e2e/paired.json'), JSON.stringify([{ identityPub: clientPub, label: 'Disposable viewer QA client', pairedAt: Date.now(), role: 'web' }]), { mode: 0o600 })
  // No refresh token is copied. The test borrows this already-authorized access token without rotating
  // the running app's session. Trust keys, computer id, registry and terminal socket are independent.
  writeFileSync(join(root, 'auth/session.json'), JSON.stringify({ ...originalAuth, refreshToken: undefined,
    computerId, machineId, updatedAt: Date.now() }), { mode: 0o600 })
  const installed = JSON.parse(readFileSync(join(homedir(), '.harness/dsh/installed.json'), 'utf8'))
  writeFileSync(join(root, 'dsh/installed.json'), JSON.stringify(installed))
  const workspaces: Record<string, { path: string; engine: string }> = {}
  for (const name of ['blender', 'marp', 'manim', 'godogen']) {
    const pkg = installed.find((p: any) => p.id === `autonomous/${name}`)
    if (!pkg) throw new Error(`${name} must already be installed on the selected test machine`)
    const manifest = JSON.parse(readFileSync(join(pkg.dir, 'harness.json'), 'utf8'))
    const workspace = join(root, 'workspaces', name)
    cpSync(join(pkg.dir, manifest.workspace.template), workspace, { recursive: true })
    mkdirSync(join(workspace, 'out'), { recursive: true })
    if (name === 'blender') {
      const data = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]).buffer)
      writeFileSync(join(workspace, 'out/triangle.gltf'), JSON.stringify({ asset: { version: '2.0' }, scene: 0,
        scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Remote triangle' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ uri: `data:application/octet-stream;base64,${data.toString('base64')}`, byteLength: data.length }],
        bufferViews: [{ buffer: 0, byteLength: data.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }] }))
      writeFileSync(join(workspace, 'out/large.bin'), Buffer.alloc(12 * 1024 * 1024 + 17, 0x5a))
    }
    if (name === 'manim') execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(workspace, 'out/sample.mp4')], { stdio: 'ignore' })
    if (name === 'godogen') {
      const { symlinkSync } = await import('node:fs')
      symlinkSync(join(pkg.dir, 'node_modules'), join(workspace, 'node_modules'))
    }
    workspaces[name] = { path: workspace, engine: manifest.engine }
  }
  const engine = join(root, 'claude-fixture')
  writeFileSync(engine, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('2.1.0 (Claude Code)');process.exit(0)}
process.title='claude';process.stdin.setRawMode?.(true);console.log('VIEWER_REMOTE_READY');
process.stdin.on('data',c=>process.stdout.write('ECHO:'+c+'\\r\\n'));setInterval(()=>{},1000);
`, { mode: 0o700 })
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'])
  const env = { ...process.env, TMUX: `${socket},0,0`, PORT: String(port), HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'), ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), DSH_DIR: join(root, 'dsh'), CLAUDE_PATH: engine,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDE_PROJECTS_DIR: join(root, 'claude/projects'),
    BACKEND_WS_URL: status.backendUrl, WEB_URL: status.webUrl, HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
    DISABLE_HOOK_INSTALL: 'true', ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false',
    RECAP_WITHOUT_DEVICE: 'false', CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true', TERMINAL_BACKENDS: 'tmux' }
  child = spawn(process.execPath, ['dist/cli.js', '__run'], { cwd: cli, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(root, 'daemon.log'))
  child.stdout!.pipe(log); child.stderr!.pipe(log)
  const deadline = Date.now() + 60_000
  while (true) {
    const ready = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-adapter-local': '1' } })
      .then(r => r.json()).then((s: any) => s.connected && s.discoveryReady).catch(() => false)
    if (ready) break
    if (Date.now() > deadline) throw new Error('Test daemon did not become ready')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const info = { machineId, pub: b64e(identity.pub), host: hostname(), arch: arch(), port, root, base, workspaces }
  writeFileSync(join(root, 'peer-info.json'), JSON.stringify(info, null, 2))
  console.log(JSON.stringify({ ready: true, ...info }))
  const expires = Date.now() + 60 * 60_000
  setInterval(() => { if (existsSync(join(root, 'stop')) || Date.now() > expires) void cleanup() }, 500)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await cleanup()
}
