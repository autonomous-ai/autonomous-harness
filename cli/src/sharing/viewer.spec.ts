import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), directory: vi.fn(), rm: vi.fn(), sockets: [] as any[], reply: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: m.spawn }))
vi.mock('node:fs', async actual => ({ ...await actual<typeof import('node:fs')>(), existsSync: m.exists }))
vi.mock('node:fs/promises', () => ({ mkdtemp: m.directory, rm: m.rm }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class Socket extends EventEmitter {
    static OPEN = 1
    readyState = 1
    send = vi.fn((raw: string) => {
      const request = JSON.parse(raw), response = m.reply(request)
      if (response !== undefined) queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: request.id, ...response }))))
    })
    terminate = vi.fn(() => this.emit('close'))
    constructor(..._args: unknown[]) { super(); m.sockets.push(this); queueMicrotask(() => this.emit('open')) }
  }
  return { WebSocket: Socket }
})
import { EventEmitter } from 'node:events'
import { ViewerCapture, SharedViewerPool, viewerTarget, viewerBrowser } from './viewer.js'
class Child extends EventEmitter {
  stderr = new EventEmitter(); exitCode: number | null = null; signalCode: string | null = null
  kill = vi.fn((signal: string) => { this.signalCode = signal; queueMicrotask(() => this.emit('exit')); return true })
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
describe('private viewer capture', () => {
  let capture: ViewerCapture, child: Child
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); m.sockets = []
    m.exists.mockReturnValue(true); m.directory.mockResolvedValue('/tmp/share-viewer-fixture'); m.rm.mockResolvedValue(undefined)
    child = new Child(); m.spawn.mockImplementation(() => {
      queueMicrotask(() => child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:1234/devtools/browser/test\n')))
      return child
    })
    m.reply.mockImplementation(({ method }) => ({ result: method === 'Target.createTarget' ? { targetId: 'page' }
      : method === 'Target.attachToTarget' ? { sessionId: 'session' }
      : method === 'Page.captureScreenshot' ? { data: 'jpeg' } : {} }))
    capture = new ViewerCapture()
  })
  afterEach(async () => { await capture.stop(); vi.useRealTimers(); vi.unstubAllEnvs() })
  it('accepts only explicit loopback viewer URLs without credentials', () => {
    for (const url of ['http://127.0.0.1:1234/', 'http://localhost:1234/result', 'http://[::1]:1234/']) expect(viewerTarget(url)).toBe(url)
    for (const url of [null, '', 'bad', 'file:///tmp/result', 'https://127.0.0.1:1234', 'http://example.com:1234',
      'http://localhost/', 'http://user:password@localhost:1234/', 'http://127.0.0.1.evil:1234']) expect(viewerTarget(url)).toBeNull()
    vi.stubEnv('HARNESS_VIEWER_BROWSER', '/custom/browser'); expect(viewerBrowser()).toBe('/custom/browser')
    m.exists.mockReturnValue(false); expect(viewerBrowser()).toBeNull()
  })
  it('launches an isolated, credential-free renderer and sends only constrained screenshot commands', async () => {
    await capture.start('http://localhost:1234/')
    expect(m.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--headless=new', '--disable-sync', '--disable-extensions', '--remote-debugging-address=127.0.0.1', '--user-data-dir=/tmp/share-viewer-fixture']))
    expect(await capture.capture()).toBe('jpeg')
    const requests = m.sockets[0].send.mock.calls.map((args: any[]) => JSON.parse(args[0]))
    expect(requests.find((r: any) => r.method === 'Page.navigate')).toMatchObject({ sessionId: 'session', params: { url: 'http://localhost:1234/' } })
    expect(requests.some((r: any) => r.method.startsWith('Input.'))).toBe(false)
    m.sockets[0].emit('message', Buffer.from('bad JSON')); m.sockets[0].emit('message', Buffer.from('{}'))
    await capture.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(m.rm).toHaveBeenCalledWith('/tmp/share-viewer-fixture', { recursive: true, force: true })
    await expect(capture.capture()).rejects.toThrow('disconnected')
  })
  it('handles unavailable browsers, invalid targets, navigation failures and invalid screenshots', async () => {
    await expect(capture.start('file:///tmp/x')).rejects.toThrow('no live viewer')
    m.exists.mockReturnValue(false)
    await expect(capture.start('http://localhost:1234')).rejects.toThrow('Chrome')
    m.exists.mockReturnValue(true)
    m.reply.mockImplementation(({ method }) => ({ result: method === 'Page.navigate' ? { errorText: 'not found' } : {} }))
    await expect(capture.start('http://localhost:1234')).rejects.toThrow('not answering')
    for (const data of [undefined, 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      m.reply.mockReturnValue({ result: { data } }); await expect(capture.capture()).rejects.toThrow('too large')
    }
    m.reply.mockReturnValue({ error: { message: 'render error' } })
    await expect(capture.capture()).rejects.toThrow('render this frame')
    m.reply.mockReturnValue({})
    await expect(capture.capture()).rejects.toThrow('too large')
  })
  it('bounds startup and capture time and rejects pending work on disconnect', async () => {
    m.spawn.mockReturnValue(child)
    const startup = capture.start('http://localhost:1234'); const slow = expect(startup).rejects.toThrow('too long to start')
    await vi.advanceTimersByTimeAsync(15000); await slow
    await capture.stop(); capture = new ViewerCapture(); child = new Child()
    m.spawn.mockImplementation(() => { queueMicrotask(() => child.stderr.emit('data', Buffer.from('DevTools listening on ws://localhost:1234/test'))); return child })
    await capture.start('http://localhost:1234')
    m.reply.mockReturnValue(undefined)
    const frame = capture.capture(); const timeout = expect(frame).rejects.toThrow('too long to respond')
    await vi.advanceTimersByTimeAsync(8000); await timeout
    const pending = capture.capture(); const disconnected = expect(pending).rejects.toThrow('disconnected')
    m.sockets.at(-1).emit('error', new Error('gone')); await disconnected
  })
  it('handles process startup errors and exits and cancellation before allocating a renderer', async () => {
    m.spawn.mockReturnValue(child)
    const startup = capture.start('http://localhost:1234'), failure = expect(startup).rejects.toThrow('could not start')
    await flush(); child.emit('error', new Error('ENOENT')); await failure
    await capture.stop(); capture = new ViewerCapture(); child = new Child(); m.spawn.mockReturnValue(child)
    const again = capture.start('http://localhost:1234'), exit = expect(again).rejects.toThrow('stopped')
    await flush(); child.emit('exit'); await exit
    await capture.stop(); capture = new ViewerCapture(); await capture.stop()
    const count = m.spawn.mock.calls.length
    await capture.start('http://localhost:1234')
    expect(m.spawn).toHaveBeenCalledTimes(count)
  })
  it('force-stops a hung renderer and tolerates already-deleted temporary files', async () => {
    await capture.start('http://localhost:1234')
    child.kill.mockReturnValue(true); m.rm.mockRejectedValue(new Error('already removed'))
    const stopped = capture.stop(); await vi.advanceTimersByTimeAsync(3000); await stopped
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('handles partial browser diagnostics and cancellation immediately after its endpoint appears', async () => {
    m.spawn.mockReturnValue(child)
    const startup = capture.start('http://localhost:1234'); await flush()
    child.stderr.emit('data', Buffer.from('browser startup diagnostics\n'))
    child.stderr.emit('data', Buffer.from('DevTools listening on ws://localhost:1234/test\n'))
    const stopping = capture.stop()
    await startup; await stopping
    expect(m.sockets).toHaveLength(0)
  })
})

describe('viewer sharing pool', () => {
  let pool: SharedViewerPool, target: string | null, create: ReturnType<typeof vi.fn<() => ViewerCapture>>, renderers: Array<{ start: any; capture: any; stop: any }>
  beforeEach(() => {
    vi.useFakeTimers(); target = null; renderers = []
    create = vi.fn(() => {
      const renderer = { start: vi.fn(async () => {}), capture: vi.fn(async () => 'jpeg'), stop: vi.fn(async () => {}) }
      renderers.push(renderer); return renderer as unknown as ViewerCapture
    })
    pool = new SharedViewerPool(() => target, () => create() as ViewerCapture)
  })
  afterEach(() => { pool.stop(); vi.useRealTimers() })
  it('waits for output, shares one camera between recipients, updates targets and releases the last watcher', async () => {
    const ken = vi.fn(), diego = vi.fn()
    const leaveKen = pool.watch('agent', ken), leaveDiego = pool.watch('agent', diego)
    await flush(); expect(ken).toHaveBeenCalledWith(expect.objectContaining({ state: 'waiting' })); expect(create).not.toHaveBeenCalled()
    target = 'http://localhost:1234'; await vi.advanceTimersByTimeAsync(3000)
    expect(create).toHaveBeenCalledTimes(1)
    expect(ken).toHaveBeenCalledWith(expect.objectContaining({ state: 'live', data: 'jpeg' }))
    expect(diego).toHaveBeenCalledWith(expect.objectContaining({ state: 'live' }))
    leaveKen(); await vi.advanceTimersByTimeAsync(400)
    expect(renderers[0].stop).not.toHaveBeenCalled()
    target = 'http://localhost:2345'; await vi.advanceTimersByTimeAsync(400)
    expect(renderers[0].stop).toHaveBeenCalled(); expect(create).toHaveBeenCalledTimes(2)
    leaveDiego(); leaveDiego(); await flush()
    expect(renderers[1].stop).toHaveBeenCalledTimes(1)
  })
  it('limits cameras and retries startup failures without exposing an HTTP proxy', async () => {
    target = 'http://localhost:1234'
    for (let i = 0; i < 8; i++) pool.watch(`agent-${i}`, vi.fn())
    const refused = vi.fn(); pool.watch('too-many', refused)()
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ state: 'unavailable' }))
    await flush(); pool.stop()
    const callback = vi.fn()
    pool.watch('retry', callback); await flush()
    renderers.at(-1)!.capture.mockRejectedValueOnce(new Error('viewer asleep'))
    await vi.advanceTimersByTimeAsync(400)
    expect(callback).toHaveBeenCalledWith({ state: 'unavailable', message: 'viewer asleep' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'live' }))
    renderers.at(-1)!.capture.mockRejectedValueOnce('opaque failure')
    await vi.advanceTimersByTimeAsync(400)
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'The viewer is temporarily unavailable.' }))
  })
  it('does not leak a camera or emit frames when the last viewer leaves during startup', async () => {
    target = 'http://localhost:1234'
    let finish!: () => void
    create.mockImplementationOnce(() => {
      const renderer = { start: vi.fn(() => new Promise<void>(resolve => { finish = resolve })), capture: vi.fn(), stop: vi.fn(async () => {}) }
      renderers.push(renderer); return renderer as unknown as ViewerCapture
    })
    const callback = vi.fn(), leave = pool.watch('agent', callback)
    await flush(); leave(); finish(); await flush()
    expect(renderers[0].stop).toHaveBeenCalledTimes(1)
    expect(renderers[0].capture).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledTimes(1)
  })
  it('contains late errors and a stopped target switch without reopening the renderer', async () => {
    target = 'http://localhost:1234'; const callback = vi.fn(), leave = pool.watch('agent', callback)
    await flush()
    let fail!: (reason: unknown) => void
    renderers[0].capture.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await vi.advanceTimersByTimeAsync(400); leave(); fail(new Error('late failure')); await flush()
    expect(callback).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'unavailable' }))
    pool.watch('another', callback); await flush()
    let stop!: () => void
    renderers.at(-1)!.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stop = resolve }))
    target = 'http://localhost:2345'; await vi.advanceTimersByTimeAsync(400)
    const count = create.mock.calls.length; pool.stop(); stop(); await flush()
    expect(create).toHaveBeenCalledTimes(count)
  })
  it('can use the production renderer factory', async () => {
    const production = new SharedViewerPool(() => 'http://localhost:1234')
    const callback = vi.fn(); const stop = production.watch('agent', callback)
    await flush(); stop(); production.stop()
    expect(callback).toHaveBeenCalledWith({ state: 'loading' })
  })
})
