import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

type Payload = Record<string, unknown>
type Listener = (frame: Payload) => void

export function viewerTarget(value: string | null): string | null {
  try {
    const url = new URL(value ?? '')
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password) return null
    return url.href
  } catch { return null }
}

export function viewerBrowser(): string | null {
  const paths = [process.env.HARNESS_VIEWER_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  return paths.find((p): p is string => !!p && existsSync(p)) ?? null
}

/** A private, credential-free renderer. Only JPEGs cross the sharing boundary, never HTTP requests. */
export class ViewerCapture {
  private child: ChildProcess | null = null
  private ws: WebSocket | null = null
  private directory: string | null = null
  private id = 0
  private pending = new Map<number, { resolve: (value: Payload) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private closed = false
  private session = ''
  async start(url: string): Promise<void> {
    const target = viewerTarget(url), browser = viewerBrowser()
    if (!target) throw new Error('This harness has no live viewer yet.')
    if (!browser) throw new Error('The owner needs Chrome or Chromium to share this viewer.')
    this.directory = await mkdtemp(join(tmpdir(), 'harness-shared-viewer-'))
    if (this.closed) { await this.stop(); return }
    this.child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-extensions', '--disable-background-networking', '--mute-audio',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${this.directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The live viewer took too long to start.')), 15_000)
      let buffer = ''
      this.child!.stderr!.on('data', (bytes: Buffer) => {
        buffer = (buffer + bytes.toString()).slice(-8192)
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      this.child!.once('error', () => { clearTimeout(timer); reject(new Error('The live viewer could not start.')) })
      this.child!.once('exit', () => { clearTimeout(timer); reject(new Error('The live viewer stopped.')); this.failPending() })
    })
    if (this.closed) return
    this.ws = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024 })
    this.ws.on('error', () => this.failPending())
    this.ws.on('close', () => this.failPending())
    this.ws.on('message', raw => {
      let message: { id?: number; result?: Payload; error?: unknown }
      try { message = JSON.parse(raw.toString()) } catch { return }
      const entry = this.pending.get(message.id ?? -1)
      if (!entry) return
      this.pending.delete(message.id!); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error('The viewer could not render this frame.'))
      else entry.resolve(message.result ?? {})
    })
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve); this.ws!.once('error', () => reject(new Error('The viewer renderer disconnected.')))
      this.ws!.once('close', () => reject(new Error('The viewer renderer disconnected.')))
    })
    const page = await this.call('Target.createTarget', { url: 'about:blank' })
    const attached = await this.call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    this.session = String(attached.sessionId)
    await this.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await this.call('Page.enable')
    const navigation = await this.call('Page.navigate', { url: target })
    if (navigation.errorText) throw new Error('The owner’s viewer is not answering yet.')
  }
  private call(method: string, params: Payload = {}): Promise<Payload> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws?.readyState !== WebSocket.OPEN) { reject(new Error('The viewer renderer disconnected.')); return }
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The viewer is taking too long to respond.')) }, 8000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(this.session ? { sessionId: this.session } : {}) }))
    })
  }
  async capture(): Promise<string> {
    const result = await this.call('Page.captureScreenshot', { format: 'jpeg', quality: 75, captureBeyondViewport: false })
    if (typeof result.data !== 'string' || result.data.length > 2 * 1024 * 1024) throw new Error('This viewer frame is too large.')
    return result.data
  }
  private failPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The viewer renderer disconnected.')) }
    this.pending.clear()
  }
  async stop(): Promise<void> {
    this.closed = true; this.failPending(); this.ws?.terminate(); this.ws = null
    const child = this.child; this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
    const directory = this.directory; this.directory = null
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** One renderer per watched harness, shared by all observers; released when its last watcher leaves. */
export class SharedViewerPool {
  private entries = new Map<string, { listeners: Set<Listener>; stop: () => void }>()
  constructor(private readonly target: (agentId: string) => string | null,
    private readonly create = () => new ViewerCapture()) {}
  watch(agentId: string, listener: Listener): () => void {
    const existing = this.entries.get(agentId)
    if (existing) { existing.listeners.add(listener); return () => this.remove(agentId, listener) }
    if (this.entries.size >= 8) { listener({ state: 'unavailable', message: 'The owner is already sharing eight live viewers.' }); return () => {} }
    const listeners = new Set([listener])
    let stopped = false, capture: ViewerCapture | null = null, timer: NodeJS.Timeout | null = null, current: string | null = null
    const send = (frame: Payload) => { if (!stopped) for (const receive of listeners) receive(frame) }
    const tick = async () => {
      try {
        const next = viewerTarget(this.target(agentId))
        if (next !== current) { await capture?.stop(); capture = null; current = next }
        if (stopped) return
        if (!next) send({ state: 'waiting', message: 'The viewer will appear when this harness produces an output.' })
        else {
          if (!capture) { send({ state: 'loading' }); capture = this.create(); await capture.start(next) }
          if (!stopped) send({ state: 'live', mime: 'image/jpeg', data: await capture.capture(), capturedAt: Date.now() })
        }
      } catch (error) {
        send({ state: 'unavailable', message: error instanceof Error ? error.message : 'The viewer is temporarily unavailable.' })
        await capture?.stop(); capture = null
      } finally { if (!stopped) timer = setTimeout(() => { void tick() }, capture ? 400 : 3000) }
    }
    this.entries.set(agentId, { listeners, stop: () => { stopped = true; if (timer) clearTimeout(timer); void capture?.stop() } })
    void tick()
    return () => this.remove(agentId, listener)
  }
  private remove(id: string, listener: Listener): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.listeners.delete(listener)
    if (!entry.listeners.size) { entry.stop(); this.entries.delete(id) }
  }
  stop(): void { for (const entry of this.entries.values()) entry.stop(); this.entries.clear() }
}
