/** Real backend, Mongo/Redis, three isolated daemons, tmux and Chrome. Only SSO and the model are fixtures.
 * HARNESS_SHARE_E2E_SERVICES points to {"mongo":"mongodb://127.0.0.1:.../?replicaSet=...","redis":"redis://127.0.0.1:..."}.
 * Services MUST be disposable. Every daemon, browser, identity, terminal and project belongs to this run.
 */
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from '../src/lib/terminalBinary.js'

if (!process.env.HARNESS_SHARE_E2E_SERVICES) throw new Error('Set HARNESS_SHARE_E2E_SERVICES to disposable service URLs.')
const exec = promisify(execFile), repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'harness-share-e2e-'))
const services = JSON.parse(await readFile(process.env.HARNESS_SHARE_E2E_SERVICES, 'utf8'))
const mongo = new URL(services.mongo), redis = new URL(services.redis)
assert.equal(mongo.hostname, '127.0.0.1'); assert.equal(redis.hostname, '127.0.0.1')
mongo.pathname = `/sharing_${randomUUID().replaceAll('-', '')}`
const children: ChildProcess[] = [], sockets: WebSocket[] = []
const tmuxSockets: string[] = []
const accounts = ['owner', 'ken', 'diego', 'stranger'].map(name => ({ name, token: randomUUID(), id: randomUUID(), email: `${name}@sharing.local.invalid` }))
let backendUrl = ''
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(label: string, check: () => boolean | Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(60) }
  throw new Error(`Timed out: ${label}. Logs: ${root}`)
}
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function run(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(root, `${name}.log`)); child.stdout!.pipe(log); child.stderr!.pipe(log)
  children.push(child); return child
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await until('child exit', () => child.exitCode != null || child.signalCode != null, 5000)
    .catch(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} })
}
async function api(account: typeof accounts[number], path: string, method = 'GET', body?: unknown) {
  const response = await fetch(backendUrl + path, { method,
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json', 'x-autonomous-env': 'prod' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  return { status: response.status, body: await response.json() as any }
}
class Peer {
  readonly frames: any[] = []
  readonly binary: TerminalBinaryClear[] = []
  text = ''; stream = ''; closedCode: number | undefined; private inputSequence = 0
  private heartbeat: NodeJS.Timeout
  constructor(readonly ws: WebSocket) {
    sockets.push(ws)
    ws.on('message', (raw, binary) => {
      if (binary) {
        const frame = decodeTerminalLocal(new Uint8Array(raw as Buffer))
        if (!frame) return
        this.binary.push(frame)
        this.text += (frame.compressed ? inflateSync(frame.bytes) : Buffer.from(frame.bytes)).toString()
        this.send('terminal_ack', { streamId: frame.streamId, lastSeq: frame.seq })
      } else {
        const frame = JSON.parse(raw.toString()); this.frames.push(frame)
        if (frame.type === 'terminal_ready') { this.stream = frame.payload.streamId; this.inputSequence = 0 }
      }
    })
    ws.on('error', () => {})
    ws.on('close', code => { this.closedCode = code; clearInterval(this.heartbeat) })
    this.heartbeat = setInterval(() => { if (this.stream) this.send('terminal_alive', { streamId: this.stream }) }, 5000)
  }
  static async connect(port: number, machineId: string, shareId?: string) {
    const peer = new Peer(new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`))
    await new Promise<void>((resolve, reject) => { peer.ws.once('open', resolve); peer.ws.once('error', reject) })
    peer.send('machine_select', { machineId, localProtocolVersion: 1, ...(shareId ? { shareId } : {}) })
    await until('local peer admission', () => peer.frames.some(f => f.type === 'connected') || peer.closedCode !== undefined)
    return peer
  }
  send(type: string, payload: Record<string, unknown> = {}) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, payload }))
  }
  async rpc(type: string, payload: Record<string, unknown> = {}) {
    const requestId = randomUUID(); this.send(type, { ...payload, requestId })
    await until(type, () => this.frames.some(f => f.payload?.requestId === requestId))
    return this.frames.find(f => f.payload?.requestId === requestId)!.payload
  }
  async open(agentId: string, cols = 120, rows = 40) {
    const response = await this.rpc('terminal_open', { protocolVersion: 3, agentId, cols, rows })
    assert.ok(!response.code && this.stream, JSON.stringify(response))
    await until('terminal snapshot', () => this.binary.some(f => f.kind === TerminalBinaryKind.keyframe))
    return response
  }
  input(text: string) {
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: this.stream, seq: this.inputSequence++, compressed: false, bytes: Buffer.from(text) })!
    this.ws.send(frame)
  }
  async close() { clearInterval(this.heartbeat); this.ws.close(); await until('socket close', () => this.closedCode !== undefined) }
}
const sso = createServer((req, res) => {
  const user = accounts.find(a => req.headers.authorization === `Bearer ${a.token}`)
  res.setHeader('content-type', 'application/json')
  if (!user) { res.writeHead(401); res.end('{}'); return }
  res.end(JSON.stringify({ status: 1, data: { id: user.id, email: user.email } }))
})
let success = false
try {
  await new Promise<void>(resolve => sso.listen(0, '127.0.0.1', resolve))
  const [backendPort, proxyPort] = await Promise.all([freePort(), freePort()])
  backendUrl = `http://127.0.0.1:${backendPort}`
  const backendEnv = { ...process.env, NODE_ENV: 'test', PORT: String(backendPort), PORT_APP_PROXY: String(proxyPort),
    DATABASE_URL: mongo.href, REDIS_URL: redis.href, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    TERMINAL_P2P_ROLLOUT_PERCENT: '0', HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { cwd: join(repo, 'backend'), env: backendEnv, timeout: 60_000 })
  run('backend', join(repo, 'backend'), ['--import', 'tsx', 'src/server.ts'], backendEnv)
  await until('backend', async () => fetch(`${backendUrl}/api/health`).then(r => r.ok).catch(() => false))
  const engine = join(root, 'codex')
  await writeFile(engine, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0) }\nprocess.title = 'codex'; process.stdin.setRawMode?.(true); console.log('SHARING_READY'); process.stdin.on('data', x => process.stdout.write('ECHO:' + x + '\\r\\n')); setInterval(() => {}, 1000);\n`, { mode: 0o700 })
  const fixture = join(root, 'harness-source')
  await mkdir(join(fixture, 'template'), { recursive: true })
  await writeFile(join(fixture, 'harness.json'), JSON.stringify({ spec: 1, id: 'fixture/sharing', name: 'Sharing demo', engine: 'codex',
    workspace: { template: 'template', marker: 'result.txt' }, agent: { instructions: 'AGENTS.md' },
    viewer: { command: './viewer.mjs', url: 'http://127.0.0.1:${port}/' }, verdict: '.harness/verdict.json' }))
  await writeFile(join(fixture, 'AGENTS.md'), 'Share harness test fixture.\n')
  await writeFile(join(fixture, 'template/result.txt'), 'Sharing demo')
  await writeFile(join(fixture, 'viewer.mjs'), `#!${process.execPath}\nimport { createServer } from 'node:http';\ncreateServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="background:#152238;color:white;font:40px sans-serif"><h1>Live harness</h1><p id="clock"></p><script>setInterval(() => document.getElementById("clock").textContent=Date.now(), 200)</script></body></html>'); }).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1');\n`, { mode: 0o700 })
  const machines: Array<{ machineId: string; port: number; env: NodeJS.ProcessEnv; child: ChildProcess; socket: string; workspace: string }> = []
  for (const account of accounts.slice(0, 3)) {
    const folder = join(root, account.name), data = join(folder, 'data'), auth = join(folder, 'auth'), workspace = join(folder, 'project')
    for (const dir of [data, auth, workspace]) await mkdir(dir, { recursive: true })
    const computerId = randomUUID(), port = await freePort(), socket = join(folder, 'tmux.sock')
    tmuxSockets.push(socket)
    const registered = await api(account, '/api/machines/resolve-computer', 'POST', { computerId, label: `${account.name} test machine` })
    assert.equal(registered.status, 200, JSON.stringify(registered))
    const machineId = registered.body.data.machine.machineId
    await writeFile(join(auth, 'session.json'), JSON.stringify({ version: 1, accessToken: account.token, refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000, autonomousEnv: 'prod', computerId, machineId, updatedAt: Date.now() }), { mode: 0o600 })
    await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'])
    const env = { ...process.env, NODE_ENV: 'test', TMUX: `${socket},0,0`, PORT: String(port), HARNESS_AUTH_DIR: auth,
      ADAPTER_COMPUTER_ID: computerId, ADAPTER_COMPUTER_ID_FILE: join(folder, 'computer-id'), ADAPTER_DATA_DIR: data,
      ADAPTER_RUNTIME_DIR: join(folder, 'runtime'), DSH_DIR: join(folder, 'dsh'), CODEX_PATH: engine,
      BACKEND_WS_URL: `ws://127.0.0.1:${backendPort}`, WEB_URL: backendUrl, HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog',
      DISABLE_HOOK_INSTALL: 'true', ADAPTER_UPDATE_DISABLE: 'true', ANALYTICS_ENABLED: 'false', RECAP_FORCE: 'false',
      RECAP_WITHOUT_DEVICE: 'false', CABLE_DISABLE: 'true', CABLE_FW_DISABLE: 'true', TERMINAL_BACKENDS: 'tmux',
      CLAUDE_PROJECTS_DIR: join(folder, 'claude-projects') }
    if (account.name === 'owner') await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dsh', 'install', fixture, '--link'], { cwd: join(repo, 'cli'), env, timeout: 30_000 })
    const child = run(account.name, join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], env)
    await until(`${account.name} daemon`, async () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()).then((r: any) => r.connected === true).catch(() => false))
    machines.push({ machineId, port, env, child, socket, workspace })
  }
  const [host, kenMachine, diegoMachine] = machines
  let owner = await Peer.connect(host.port, host.machineId)
  const created = await owner.rpc('agent_create', { creationId: randomUUID(), engine: 'codex', cwd: host.workspace, dsh: 'fixture/sharing' })
  assert.equal(created.state, 'created', JSON.stringify(created)); const agentId = created.agent.id
  console.log('Created owner harness', agentId)
  await owner.open(agentId, 110, 33)
  await until('fixture model ready', () => owner.text.includes('SHARING_READY'))
  owner.input('owner-before-sharing')
  await until('owner terminal input', () => owner.text.includes('ECHO:owner-before-sharing'))
  console.log('Owner input verified; inviting Ken and Diego')
  const invitation = await owner.rpc('harness_share_invite', { agentId, emails: [accounts[1].email.toUpperCase(), accounts[2].email], days: 30 })
  assert.equal(invitation.shares.length, 2, JSON.stringify(invitation))
  assert.ok(invitation.shares.every((s: any) => !s.pending && !s.error), JSON.stringify(invitation))
  const kenShare = invitation.shares.find((s: any) => s.email === accounts[1].email).id
  const diegoShare = invitation.shares.find((s: any) => s.email === accounts[2].email).id
  for (const account of accounts.slice(1, 3)) {
    const discovery = await api(account, '/api/harness-shares')
    assert.equal(discovery.body.data.machines.length, 1)
    const m = discovery.body.data.machines[0]
    assert.equal(m.shared, true); assert.equal(m.status, 'running'); assert.equal(m.shares.length, 1)
    assert.equal(m.shares[0].agentId, agentId); assert.ok(!m.apiKey && !m.computerId && !m.hostname)
  }
  assert.deepEqual((await api(accounts[3], '/api/harness-shares')).body.data.machines, [])
  assert.equal((await api(accounts[1], `/api/harness-shares/${kenShare}`, 'DELETE')).status, 404)
  console.log('Account discovery verified; connecting observers')
  let ken = await Peer.connect(kenMachine.port, host.machineId, kenShare)
  const diego = await Peer.connect(diegoMachine.port, host.machineId, diegoShare)
  for (const peer of [ken, diego]) {
    const ready = await peer.open(agentId, 200, 100)
    assert.equal(ready.readOnly, true)
    const frame = peer.binary.find(f => f.kind === TerminalBinaryKind.keyframe)!
    assert.equal(frame.cols, 110); assert.equal(frame.rows, 33)
    assert.ok(peer.text.includes('owner-before-sharing'))
    assert.equal((await peer.rpc('agent_delete', { agentId })).error, 'VIEW_ONLY')
    assert.equal((await peer.rpc('terminal_resize', { streamId: peer.stream, cols: 1, rows: 1 })).error, 'VIEW_ONLY')
    peer.input('UNAUTHORIZED_INPUT')
    peer.send('observer_viewer', { agentId })
  }
  owner.input('two-observers-世界')
  await until('owner and both observers receive live output', () => [owner, ken, diego].every(p => p.text.includes('ECHO:two-observers-世界')))
  assert.ok(!owner.text.includes('UNAUTHORIZED_INPUT'))
  await until('two recipients receive live viewer pixels', () => [ken, diego].every(p => p.frames.some(f => f.type === 'observer_viewer' && f.payload.state === 'live')), 45_000)
  const firstImage = ken.frames.find(f => f.type === 'observer_viewer' && f.payload.state === 'live').payload.data
  assert.equal(Buffer.from(firstImage, 'base64').subarray(0, 2).toString('hex'), 'ffd8')
  await until('viewer visibly updates', () => ken.frames.some(f => f.type === 'observer_viewer' && f.payload.data && f.payload.data !== firstImage))
  assert.equal((await owner.rpc('harness_share_list', { agentId })).shares.reduce((n: number, s: any) => n + s.watching, 0), 2)
  await ken.close()
  ken = await Peer.connect(kenMachine.port, host.machineId, kenShare); await ken.open(agentId)
  owner.input('reconnected-observer')
  await until('observer reconnect catches up', () => ken.text.includes('ECHO:reconnected-observer'))
  await owner.rpc('harness_share_remove', { agentId, id: kenShare })
  await until('immediate removal closes Ken', () => ken.closedCode === 4403)
  assert.deepEqual((await api(accounts[1], '/api/harness-shares')).body.data.machines, [])
  owner.input('only-diego-now')
  await until('Diego continues while Ken loses access', () => diego.text.includes('ECHO:only-diego-now'))
  assert.ok(!ken.text.includes('only-diego-now'))
  const denied = await Peer.connect(kenMachine.port, host.machineId, kenShare)
  assert.equal(denied.closedCode, 4403)
  await owner.close(); await stop(host.child)
  await until('owner disconnect is recoverable', () => diego.closedCode === 1012)
  await until('offline grant stays discoverable', async () => (await api(accounts[2], '/api/harness-shares')).body.data.machines[0]?.status === 'offline')
  host.child = run('owner-restarted', join(repo, 'cli'), ['--import', 'tsx', 'src/cli.ts', '__run'], host.env)
  await until('owner restarted', async () => fetch(`http://127.0.0.1:${host.port}/api/status`, { headers: { 'x-adapter-local': '1' } }).then(r => r.json()).then((r: any) => r.connected === true).catch(() => false))
  owner = await Peer.connect(host.port, host.machineId)
  assert.equal((await owner.rpc('harness_share_list', { agentId })).shares.length, 1)
  const rejoined = await Peer.connect(diegoMachine.port, host.machineId, diegoShare); await rejoined.open(agentId)
  await owner.open(agentId); owner.input('after-daemon-restart')
  await until('durable permission reconnect', () => rejoined.text.includes('ECHO:after-daemon-restart'))
  await owner.rpc('harness_share_remove', { agentId, id: diegoShare })
  await until('last observer removed', () => rejoined.closedCode === 4403)
  success = true
  console.log('PASS: invite → account discovery → two read-only observers → encrypted live terminal/viewer → denied controls → reconnect → immediate revocation → offline discovery → durable daemon restart.')
} catch (error) {
  console.error(error)
  throw error
} finally {
  for (const ws of sockets) ws.terminate()
  await Promise.all(children.reverse().map(stop))
  for (const socket of tmuxSockets) await exec('tmux', ['-S', socket, 'kill-server'], { timeout: 3000 }).catch(() => {})
  sso.closeAllConnections()
  await new Promise<void>(resolve => sso.close(() => resolve()))
  if (success && process.env.HARNESS_SHARE_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Sharing E2E logs: ${root}`)
}
