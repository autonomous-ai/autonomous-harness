import { afterEach, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { BackendSocket, type Frame } from '../backendSocket.js'
import { attachLocalWsServer } from '../localWsServer.js'
import { env } from '../config/env.js'
import { DshViewerManager } from '../dsh/viewer.js'
import { E2eeStore } from './e2ee/store.js'
import { b64e, fingerprint, newIdentity } from './e2ee/core.js'
import { MachinePeerStore } from './e2ee/machinePeers.js'
import { RemoteRelayPool } from './remoteRelay.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledDsh } from '../dsh/installed.js'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** An opaque backend fixture: real sockets and production daemon handlers on both sides. */
it('desktop local-ws → relay → E2EE → daemon → spawned viewer, including restart and revocation', async () => {
  const machineId = 'a1234567890123456789012345678901a'
  const localIdentity = newIdentity()
  const remoteStore = new E2eeStore()
  const remoteIdentity = remoteStore.init()
  remoteStore.addPaired(b64e(localIdentity.pub), 'viewer e2e fixture', Date.now())
  const peers = new MachinePeerStore()
  peers.pin(machineId, b64e(remoteIdentity.pub), 'viewer e2e fixture')
  const relayServer = createServer()
  const relay = new WebSocketServer({ server: relayServer })
  let remote: WebSocket | undefined
  let client: WebSocket | undefined
  const encrypted: string[] = []
  relay.on('connection', (ws, req) => {
    if (req.url?.startsWith('/api/adapter-ws')) {
      remote = ws
      ws.on('message', (raw) => {
        const envelope = JSON.parse(raw.toString())
        if (envelope.t !== 'up') return
        if (String(envelope.frame.type).startsWith('viewer_')) encrypted.push(raw.toString())
        if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(envelope.frame))
      })
    } else {
      client = ws
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'machine_select') { ws.send(JSON.stringify({ type: 'connected', payload: { machineId } })); return }
        if (String(frame.type).startsWith('viewer_')) encrypted.push(raw.toString())
        remote?.send(JSON.stringify({ t: 'down', connId: 'viewer-client', frame }))
      })
      ws.on('close', () => remote?.readyState === WebSocket.OPEN && remote.send(JSON.stringify({ t: 'down', connId: 'viewer-client', frame: { type: '__client_disconnected' } })))
    }
  })
  relayServer.listen(0, '127.0.0.1')
  await once(relayServer, 'listening')
  cleanup.push(() => { for (const ws of relay.clients) ws.terminate(); relay.close(); relayServer.close() })
  const base = `ws://127.0.0.1:${(relayServer.address() as AddressInfo).port}`
  const previousBase = env.BACKEND_WS_URL
  env.BACKEND_WS_URL = base
  cleanup.push(() => { env.BACKEND_WS_URL = previousBase })
  let connected!: () => void
  const online = new Promise<void>((resolve) => { connected = resolve })
  const daemon = new BackendSocket(machineId, undefined, (up) => { if (up) connected() })
  cleanup.push(() => daemon.stop())
  daemon.connect()
  await online

  const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-e2e-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'viewer.mjs'), `import http from 'node:http';
import { WebSocketServer } from ${JSON.stringify(import.meta.resolve('ws'))};
const server = http.createServer((req, res) => {
  if (req.url === '/events') { res.writeHead(200, {'Content-Type': 'text/event-stream'}); res.write('data: encrypted-live-output\\n\\n'); }
  else if (req.url === '/asset.svg') { res.writeHead(200, {'Content-Type': 'image/svg+xml'}); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="30" fill="green"/></svg>'); }
  else if (req.url === '/api' && req.method === 'POST') {
    if (req.headers.origin !== 'http://127.0.0.1:' + process.env.HARNESS_VIEWER_PORT) { res.writeHead(403).end(); return; }
    req.pipe(res);
  }
  else res.end(${JSON.stringify(`<html><body>encrypted-viewer-output<img src="/asset.svg"><script>
Promise.all([
  fetch('/asset.svg').then(r => { if (!r.ok) throw Error('asset'); return r.text(); }),
  fetch('/api', {method:'POST', body:'browser-post'}).then(r => r.text()).then(t => { if(t !== 'browser-post') throw Error('POST'); }),
  new Promise((resolve, reject) => { const e = new EventSource('/events'); e.onmessage = event => { e.close(); event.data === 'encrypted-live-output' ? resolve() : reject(Error('SSE')); }; e.onerror = reject; }),
  new Promise((resolve, reject) => { const w = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws'); w.onopen = () => w.send('browser-websocket'); w.onmessage = e => { w.close(); e.data === 'browser-websocket' ? resolve() : reject(Error('WebSocket')); }; w.onerror = reject; }),
]).then(() => document.body.setAttribute('data-viewer-test', 'passed')).catch(e => document.body.setAttribute('data-viewer-test', 'failed:' + e));
</script></body></html>`)});
});
const wss = new WebSocketServer({server});
wss.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, {binary})));
server.listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1');`)
  const manager = new DshViewerManager({
    onUrl: (agentId, viewerUrl) => {
      daemon.viewerForwarder.refresh(agentId)
      daemon.send({ type: 'agent_synced', payload: { agent: { id: agentId, viewerUrl, name: 'remote viewer fixture' } } })
    },
  })
  daemon.viewerTargetProvider = (agentId) => manager.forwardingUrl(agentId)
  cleanup.push(() => manager.stopAll())
  const dsh: InstalledDsh = {
    id: 'test/viewer', realDir: dir, dir, source: '', ref: null, commit: null, linked: false, installedAt: 0,
    manifest: { spec: 1, id: 'test/viewer', name: 'Viewer test', engine: 'claude', viewer: { command: `'${process.execPath.replaceAll("'", "'\\''")}' viewer.mjs`, url: 'http://127.0.0.1:${port}/?file=${artifact}' } },
  }

  const pool = new RemoteRelayPool({ accessToken: async () => 'fixture-token' } as never, base, localIdentity, peers)
  cleanup.push(() => pool.invalidate(machineId))
  const localServer = createServer()
  const localWs = attachLocalWsServer(localServer, { machineId: 'this-computer', backend: daemon, relayPool: pool, autonomousEnv: 'prod' })
  localServer.listen(0, '127.0.0.1')
  await once(localServer, 'listening')
  cleanup.push(async () => { await localWs.close(); localServer.close() })
  const desktop = new WebSocket(`ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/api/local-ws`)
  cleanup.push(() => desktop.terminate())
  const frames: Frame[] = []
  desktop.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  async function until(predicate: () => boolean | Promise<boolean>, detail = 'E2E condition'): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`${detail} did not arrive`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await once(desktop, 'open')
  desktop.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
  await until(() => frames.some((f) => f.type === 'connected'))
  await manager.start('agent', dsh, dir)
  const urls = () => frames.filter((f) => f.type === 'agent_synced').map((f) => (f.payload as any).agent.viewerUrl as string | null)
  await until(() => urls().some(Boolean))
  const url = urls().at(-1)!
  expect(new URL(url).origin).not.toBe(new URL(manager.url('agent')!).origin)
  const bootstrap = await fetch(url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]
  const localOrigin = new URL(url).origin
  const page = await fetch(localOrigin + bootstrap.headers.get('location'), { headers: { cookie } })
  expect(await page.text()).toContain('encrypted-viewer-output')
  if (process.env.HARNESS_VIEWER_BROWSER) {
    const profile = join(dir, 'browser-profile')
    const browser = spawn(process.env.HARNESS_VIEWER_BROWSER, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank',
    ], { stdio: 'ignore' })
    const exited = once(browser, 'exit')
    let devtools: WebSocket | undefined
    try {
      await until(() => existsSync(join(profile, 'DevToolsActivePort')), 'Browser debugger')
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n')
      devtools = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      await once(devtools, 'open')
      let nextId = 0
      const pending = new Map<number, (response: any) => void>()
      devtools.on('message', (raw) => {
        const response = JSON.parse(raw.toString())
        const done = pending.get(response.id)
        pending.delete(response.id)
        done?.(response)
      })
      const command = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, (r) => r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result))
        devtools!.send(JSON.stringify({ id, method, params, sessionId }))
      })
      const { targetId } = await command('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
      await command('Page.navigate', { url }, sessionId)
      await until(async () => {
        const { result } = await command('Runtime.evaluate', { expression: "document.body?.getAttribute('data-viewer-test')", returnByValue: true }, sessionId)
        if (result.value?.startsWith('failed')) throw new Error(result.value)
        return result.value === 'passed'
      }, 'Browser assets, POST, SSE and WebSocket checks')
    } finally {
      devtools?.terminate()
      browser.kill('SIGTERM')
      await exited
    }
  }
  if (process.env.HARNESS_VIEWER_WEBKIT) {
    const result = await promisify(execFile)(process.env.HARNESS_VIEWER_WEBKIT, [url,
      "document.body?.getAttribute('data-viewer-test') === 'passed'", join(dir, 'webkit.png')], { timeout: 100_000 })
    expect(result.stdout).toContain('PASS WKWebView')
  }
  const live = await fetch(localOrigin + '/events', { headers: { cookie } })
  const reader = live.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('encrypted-live-output')
  expect(encrypted.length).toBeGreaterThan(3)
  for (const raw of encrypted) {
    expect(raw).toContain('"__e2e"')
    expect(raw).not.toMatch(/encrypted-viewer-output|encrypted-live-output|"agentId"|"path"|"headers"|"data"/)
  }

  // Both incomplete streaming responses and the previous local origin die on a viewer restart.
  await manager.stop('agent')
  await expect(reader.read()).rejects.toThrow()
  await manager.start('agent', dsh, dir)
  await until(() => urls().at(-1) !== null && urls().at(-1) !== url)
  await expect(fetch(url)).rejects.toThrow()
  const restarted = urls().at(-1)!
  expect((await fetch(restarted, { redirect: 'manual' })).status).toBe(302)
  const ended = once(desktop, 'close')
  expect(daemon.revoke(fingerprint(localIdentity.pub)).ok).toBe(true)
  const [code] = await ended
  expect(code).toBe(4404)
  await expect(fetch(restarted)).rejects.toThrow()
  expect(peers.get(machineId)).toBeNull()
}, process.env.HARNESS_VIEWER_WEBKIT ? 120_000 : 40_000)
