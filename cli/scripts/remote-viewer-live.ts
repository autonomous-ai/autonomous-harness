/** Real-host client. `init <dir>` prints a disposable public key; `run <dir> <peer-info.json>` tests it. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, arch } from 'node:os'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

if (process.env.HARNESS_VIEWER_LIVE_TEST !== '1') throw new Error('Opt in with HARNESS_VIEWER_LIVE_TEST=1')
const root = resolve(process.argv[3] || 'viewer-client')
process.env.ADAPTER_DATA_DIR = join(root, 'data')
process.env.ADAPTER_RUNTIME_DIR = join(root, 'runtime')
process.env.DSH_DIR = join(root, 'dsh')
const { E2eeStore } = await import('../src/lib/e2ee/store.js')
const { b64e } = await import('../src/lib/e2ee/core.js')
const identity = new E2eeStore().init()
if (process.argv[2] === 'init') {
  console.log(b64e(identity.pub))
  process.exit(0)
}
assert.equal(process.argv[2], 'run')
const peer = JSON.parse(readFileSync(process.argv[4]!, 'utf8'))
const { MachinePeerStore } = await import('../src/lib/e2ee/machinePeers.js')
const { RemoteRelayPool } = await import('../src/lib/remoteRelay.js')
const { AuthSessionManager, readAuthSession } = await import('../src/lib/authSession.js')
const { decodeTerminalLocal, TerminalBinaryKind } = await import('../src/lib/terminalBinary.js')
const peers = new MachinePeerStore()
peers.pin(peer.machineId, peer.pub, 'Disposable physical viewer test')
const auth = new AuthSessionManager(peer.base)
const pool = new RemoteRelayPool(auth, peer.base.replace(/^http/, 'ws'), identity, peers)
const frames: any[] = []
const checks: string[] = []
const revokeCheck = process.env.HARNESS_VIEWER_REVOKE_CHECK === '1'
let closedCode: number | undefined
const checkpoint = (s: string) => { checks.push(s); console.log(`PASS ${s}`) }
async function until(label: string, fn: () => unknown | Promise<unknown>, ms = 60_000) {
  const deadline = Date.now() + ms
  while (!await fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
let terminalText = ''
let link = await pool.acquire(peer.machineId, readAuthSession()!.autonomousEnv,
  { type: 'machine_select', payload: { machineId: peer.machineId, localProtocolVersion: 1 } }, {
    sendFrame: f => { frames.push(f); return true },
    sendBinary: bytes => {
      const f = decodeTerminalLocal(bytes)
      if (f) { terminalText += Buffer.from(f.bytes).toString(); void link?.send({ type: 'terminal_ack', payload: { streamId: f.streamId, seq: f.seq } }) }
      return true
    },
  }, (code, reason) => { closedCode = code; console.log(`Relay closed ${code}: ${reason}`) })
async function rpc(type: string, payload: object = {}) {
  const requestId = randomUUID()
  await link.send({ type, payload: { ...payload, requestId } })
  await until(type, () => frames.some(f => f.payload?.requestId === requestId))
  const result = frames.find(f => f.payload?.requestId === requestId).payload
  assert.ok(!result.error && !result.code, `${type}: ${JSON.stringify(result)}`)
  return result
}
async function viewerUrl(id: string) {
  let url: string | undefined
  await until('forwarded viewer URL', async () => {
    const agent = (await rpc('agents_list')).agents.find((a: any) => a.id === id)
    assert.ok(!agent?.viewerError, agent?.viewerError)
    url = agent?.viewerUrl
    return url
  })
  assert.ok(url!.includes('/__harness_viewer/'))
  return url!
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { chromium } = createRequire(join(repo, 'store/agents/godogen/package.json'))('playwright')
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.HARNESS_VIEWER_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-unsafe-swiftshader'],
})
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
const agents: string[] = []
let complete = false
try {
  for (const [name, workspace] of Object.entries(peer.workspaces) as Array<[string, any]>) {
    if (revokeCheck && name !== 'marp') continue
    const created = await rpc('agent_create', { creationId: randomUUID(), engine: workspace.engine, cwd: workspace.path, dsh: `autonomous/${name}` })
    assert.ok(created.agent?.id)
    const id = created.agent.id
    agents.push(id)
    const url = await viewerUrl(id)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e: Error) => errors.push(e.message))
    const response = await page.goto(url)
    assert.equal(response.status(), 200)
    if (name === 'blender') {
      await page.waitForFunction(() => document.querySelector('#model-name')?.textContent === 'triangle.gltf' && !!document.querySelector('#tree .row'))
      const terminal = await rpc('terminal_open', { protocolVersion: 3, agentId: id, cols: 100, rows: 30, compression: [] })
      const heartbeat = setInterval(() => { void link.send({ type: 'terminal_alive', payload: { streamId: terminal.streamId } }) }, 5000)
      try {
        const download = page.request.get(new URL('/ws/out/large.bin', page.url()).href, { timeout: 120_000 })
        await link.sendBinary({ kind: TerminalBinaryKind.input, streamId: terminal.streamId, seq: 0, compressed: false,
          bytes: Buffer.from('remote-viewer-concurrent-terminal\r') })
        await until('concurrent terminal input echoed', () => terminalText.includes('ECHO:remote-viewer-concurrent-terminal'))
        const result = await download
        assert.equal(result.status(), 200)
        assert.equal(createHash('sha256').update(await result.body()).digest('hex'), createHash('sha256').update(Buffer.alloc(12 * 1024 * 1024 + 17, 0x5a)).digest('hex'))
        const range = await page.request.get(new URL('/ws/out/large.bin', page.url()).href, { headers: { Range: 'bytes=17-1048592' } })
        assert.equal(range.status(), 206)
        assert.equal((await range.body()).length, 1048576)
      } finally {
        clearInterval(heartbeat)
        await link.send({ type: 'terminal_close', payload: { streamId: terminal.streamId } })
      }
      checkpoint('12 MiB hashed download, Range response and simultaneous real remote terminal echo')
    } else if (name === 'marp') {
      await page.waitForFunction(() => document.querySelectorAll('#stage svg').length > 0)
      const before = await page.locator('#counter').innerText()
      await page.locator('#next').click()
      assert.notEqual(await page.locator('#counter').innerText(), before)
      await rpc('agent_restart', { agentId: id })
      const restarted = await viewerUrl(id)
      assert.equal(new URL(restarted).origin, new URL(url).origin)
      assert.equal((await fetch(url, { redirect: 'manual' })).status, 302)
      await page.goto(restarted)
      await page.waitForFunction(() => document.querySelectorAll('#stage svg').length > 0)
      checkpoint('remote Marp navigation and real agent restart preserve the healthy viewer')
    } else if (name === 'manim') {
      await page.waitForFunction(() => (document.querySelector('#video') as HTMLVideoElement)?.readyState >= 2)
      await page.evaluate(() => { const v = document.querySelector('#video') as HTMLVideoElement; v.currentTime = 1.5; return v.play() })
      await page.waitForFunction(() => (document.querySelector('#video') as HTMLVideoElement)?.currentTime > 1.6)
    } else if (name === 'godogen') {
      await page.waitForFunction(() => document.querySelector('#frames iframe.active') && !(document.querySelector('#play') as HTMLButtonElement)?.disabled, null, { timeout: 90_000 })
      await page.locator('#play').click()
      await page.waitForTimeout(500)
      await page.keyboard.down('KeyD'); await page.waitForTimeout(500); await page.keyboard.up('KeyD')
      const src = await page.locator('#frames iframe.active').getAttribute('src')
      const frame = page.frames().find((f: any) => f.url() === new URL(src, page.url()).href)
      assert.ok(await frame.evaluate(() => (window as any).harnessGame.stats().positionX > 0))
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(root, `${name}-${peer.host}.png`) })
    checkpoint(`${name} browser viewer on ${peer.host} (${peer.arch}) → ${hostname()} (${arch()}) through ${peer.base}`)
    if (process.env.HARNESS_VIEWER_WEBKIT) {
      const expressions: Record<string, string> = {
        blender: "document.querySelector('#model-name')?.textContent === 'triangle.gltf' && !!document.querySelector('#tree .row')",
        marp: "document.querySelectorAll('#stage svg').length > 0",
        manim: "(() => { const v=document.querySelector('#video'); if(!v || v.readyState<2) return false; v.play().catch(()=>{}); return v.currentTime>0.2; })()",
        godogen: "!!document.querySelector('#frames iframe.active') && !document.querySelector('#play')?.disabled",
      }
      const result = await promisify(execFile)(process.env.HARNESS_VIEWER_WEBKIT, [await viewerUrl(id), expressions[name]!, join(root, `${name}-webkit.png`)], { timeout: 100_000 })
      assert.ok(result.stdout.includes('PASS WKWebView'), result.stdout)
      checkpoint(`${name}: native WKWebView loaded the forwarded viewer`)
    }
  }
  if (revokeCheck) {
    const url = await viewerUrl(agents[0]!)
    const boot = await fetch(url, { redirect: 'manual' })
    const cookie = boot.headers.get('set-cookie')!.split(';')[0]!
    const stream = await fetch(new URL('/events', url), { headers: { cookie } })
    const reader = stream.body!.getReader()
    assert.ok((await reader.read()).value?.length)
    console.log(`READY_FOR_REVOCATION test daemon port=${peer.port}; POST /api/revoke-all on that peer only`)
    await until('remote owner revokes the disposable test identity', () => closedCode === 4404, 180_000)
    await assert.rejects(reader.read())
    await assert.rejects(fetch(url))
    assert.equal(peers.get(peer.machineId), null)
    checkpoint('physical remote revocation interrupts an active SSE response and removes the local gateway and trust pin')
    peers.pin(peer.machineId, peer.pub, 'Verify revoked identity is refused')
    await assert.rejects(pool.acquire(peer.machineId, readAuthSession()!.autonomousEnv,
      { type: 'machine_select', payload: { machineId: peer.machineId } },
      { sendFrame: () => true, sendBinary: () => true }, () => {}), (error: any) => error.message === 'NO_PEER_LINK')
    assert.equal(peers.get(peer.machineId), null)
    checkpoint('revoked identity cannot establish a new encrypted session through the hosted relay')
  }
  complete = true
} finally {
  if (!complete) for (const [i, page] of context.pages().entries()) {
    await page.screenshot({ path: join(root, `failure-${i}.png`), timeout: 5000 }).catch(() => {})
    writeFileSync(join(root, `failure-${i}.html`), await page.content().catch(() => 'unavailable'))
  }
  if (closedCode !== 4404) for (const id of agents) { try { assert.equal((await rpc('agent_delete', { agentId: id })).deleted, true) } catch (error) { complete = false; console.error(`Test agent cleanup failed: ${id}`, error) } }
  await browser.close()
  pool.invalidate(peer.machineId)
  writeFileSync(join(root, revokeCheck ? 'results-revocation.json' : 'results.json'), JSON.stringify({ complete, local: { hostname: hostname(), arch: arch() },
    remote: { hostname: peer.host, arch: peer.arch }, relay: peer.base, checks,
    nativeWebKitTested: !!process.env.HARNESS_VIEWER_WEBKIT,
    stopPeerToCleanUp: revokeCheck,
    limitations: ['fixture model CLI and media', 'temporary identity pins', 'complete Flutter desktop not exercised'] }, null, 2))
}
// werift can retain STUN retry timers after pool teardown; this standalone runner has no other work.
process.exit(complete ? 0 : 1)
