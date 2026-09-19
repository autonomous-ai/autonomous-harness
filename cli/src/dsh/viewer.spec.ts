import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstalledDsh } from './installed.js'
import { DshViewerManager, buildViewerUrl, freeLoopbackPort, resolveViewer, waitForLoopbackPort } from './viewer.js'

// Off by default: set `net.fake` to hand the viewer a scripted server or socket instead of a real one.
const net = vi.hoisted(() => ({ fake: null as null | { createServer?: () => unknown; connect?: () => unknown } }))
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  const createServer = ((...args: Parameters<typeof actual.createServer>) => (net.fake?.createServer ? net.fake.createServer() : actual.createServer(...args))) as typeof actual.createServer
  const connect = ((...args: Parameters<typeof actual.connect>) => (net.fake?.connect ? net.fake.connect() : (actual.connect as (...a: unknown[]) => unknown)(...args))) as typeof actual.connect
  return { ...actual, createServer, connect, default: { ...actual, createServer, connect } }
})

function fakeChild(): ChildProcess & { exitWith: (code: number) => void } {
  const child = new EventEmitter() as ChildProcess & { exitWith: (code: number) => void }
  Object.assign(child, {
    // No pid: killProcessGroup returns early instead of signalling a real process group.
    pid: undefined,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitWith: (code: number) => child.emit('exit', code, null),
  })
  return child
}

function dsh(viewer: NonNullable<InstalledDsh['manifest']['viewer']>): InstalledDsh {
  return {
    id: 'acme/thing', dir: '/i/acme/thing', realDir: '/i/acme/thing', source: '', ref: null, commit: null,
    linked: false, installedAt: 0,
    manifest: { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', viewer },
  }
}

describe('buildViewerUrl', () => {
  it('fills the port and url-encodes the artifact per segment', () => {
    expect(buildViewerUrl('http://127.0.0.1:${port}/?file=${artifact}', 4790, 'models/my part.step'))
      .toBe('http://127.0.0.1:4790/?file=models/my%20part.step')
    expect(buildViewerUrl('http://127.0.0.1:${port}/', 4790, null)).toBe('http://127.0.0.1:4790/')
    expect(buildViewerUrl('http://127.0.0.1:${port}/?file=${artifact}', 1, null)).toBe('http://127.0.0.1:1/?file=')
  })
})

describe('DshViewerManager', () => {
  let manager: DshViewerManager | null = null
  afterEach(async () => { await manager?.stopAll(); manager = null })

  function setup(opts: { portUp?: boolean; now?: () => number } = {}) {
    const spawned: Array<{ child: ReturnType<typeof fakeChild>; env: Record<string, string>; cwd: string }> = []
    const urls: Array<string | null> = []
    manager = new DshViewerManager({
      onUrl: (_agentId, url) => urls.push(url),
      freePort: async () => 4790 + spawned.length,
      waitForPort: async () => opts.portUp ?? true,
      spawn: ((_script: string, o: { cwd: string; env?: Record<string, string> }) => {
        const child = fakeChild()
        spawned.push({ child, env: o.env ?? {}, cwd: o.cwd })
        return child
      }) as typeof import('./shell.js').spawnDshCommand,
      now: opts.now,
    })
    return { spawned, urls }
  }

  it('publishes a URL once the port answers, with the env the contract promises', async () => {
    const { spawned, urls } = setup()
    await manager!.start('a1', dsh({ command: 'toolchain/viewer.sh', url: 'http://127.0.0.1:${port}/' }), '/ws')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cwd).toBe('/i/acme/thing')
    expect(spawned[0].env).toMatchObject({
      HARNESS_DSH: 'acme/thing', HARNESS_DSH_DIR: '/i/acme/thing', HARNESS_WORKSPACE: '/ws', HARNESS_VIEWER_PORT: '4790',
    })
    expect(urls).toEqual(['http://127.0.0.1:4790/'])
    expect(manager!.url('a1')).toBe('http://127.0.0.1:4790/')
  })

  it('is idempotent for the same agent, DSH and workspace', async () => {
    const { spawned } = setup()
    const d = dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' })
    await manager!.start('a1', d, '/ws')
    await manager!.start('a1', d, '/ws')
    expect(spawned).toHaveLength(1)
  })

  it('forwards only a running viewer on the allocated loopback port', async () => {
    setup()
    expect(manager!.forwardingUrl('a1')).toBeNull()
    await manager!.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    expect(manager!.forwardingUrl('a1')).toBe('http://127.0.0.1:4790/')
    await manager!.stop('a1')
    expect(manager!.forwardingUrl('a1')).toBeNull()
  })

  it.each(['http://127.0.0.1:22/', 'http://example.com:${port}/', 'https://127.0.0.1:${port}/'])('does not forward a manifest URL outside its managed HTTP port: %s', async (url) => {
    setup()
    await manager!.start('a1', dsh({ command: 'v', url }), '/ws')
    expect(manager!.url('a1')).not.toBeNull()
    expect(manager!.forwardingUrl('a1')).toBeNull()
  })

  it('republishes when the verdict names an artifact, and only when the URL changes', async () => {
    const { urls } = setup()
    await manager!.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/?file=${artifact}' }), '/ws')
    manager!.setVerdictArtifact('a1', 'models/a.step')
    manager!.setVerdictArtifact('a1', 'models/a.step')
    manager!.setVerdictArtifact('a1', null)
    expect(urls).toEqual([
      'http://127.0.0.1:4790/?file=',
      'http://127.0.0.1:4790/?file=models/a.step',
      'http://127.0.0.1:4790/?file=',
    ])
  })

  it('publishes null when the port never answers, and stops the child', async () => {
    const { urls } = setup({ portUp: false })
    await manager!.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    expect(urls).toEqual([])
    expect(manager!.url('a1')).toBeNull()
  })

  it('restarts a viewer that exits, then gives up after four exits in a minute', async () => {
    let clock = 0
    const { spawned, urls } = setup({ now: () => clock })
    await manager!.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    expect(urls).toEqual(['http://127.0.0.1:4790/'])
    spawned[0].child.exitWith(1)
    expect(urls.at(-1)).toBeNull()
    // The restart is scheduled with a real timer (1s); the fourth exit inside the window gives up.
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_100 * 2 ** i))
      expect(spawned).toHaveLength(i + 2)
      clock += 1_000
      spawned[i + 1].child.exitWith(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(spawned).toHaveLength(4)
  }, 15_000)

  it('stops publish null and forgets the agent', async () => {
    const { urls } = setup()
    await manager!.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    await manager!.stop('a1')
    expect(urls.at(-1)).toBeNull()
    expect(manager!.url('a1')).toBeNull()
  })

  it('publishes no URL before the port answers, even when the verdict names an artifact meanwhile', async () => {
    // The pane navigates to whatever URL it is handed; a port nobody serves yet is a connection error
    // it never recovers from. A viewer that writes the verdict as it boots used to trigger exactly that.
    const urls: Array<string | null> = []
    let release!: (up: boolean) => void
    let spawnedOne!: () => void
    const spawned = new Promise<void>((resolve) => { spawnedOne = resolve })
    manager = new DshViewerManager({
      onUrl: (_agentId, url) => urls.push(url),
      freePort: async () => 4790,
      waitForPort: () => new Promise((resolve) => { release = resolve }),
      spawn: (() => { spawnedOne(); return fakeChild() }) as unknown as typeof import('./shell.js').spawnDshCommand,
    })
    const starting = manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/?file=${artifact}' }), '/ws')
    await spawned
    manager.setVerdictArtifact('a1', 'deck.md')
    expect(urls).toEqual([])
    expect(manager.url('a1')).toBeNull()
    release(true)
    await starting
    expect(urls).toEqual(['http://127.0.0.1:4790/?file=deck.md'])
  })

  it('opens on the artifact a verdict named before the viewer started, and forgets it once stopped', async () => {
    // The daemon watches the verdict before it starts the viewer, and the watch publishes the verdict
    // already on disk at once: a restored agent's artifact arrived when there was no viewer to tell.
    const { urls } = setup()
    const d = dsh({ command: 'v', url: 'http://127.0.0.1:${port}/?file=${artifact}' })
    manager!.setVerdictArtifact('a1', 'boards/main.board.json')
    await manager!.start('a1', d, '/ws')
    expect(urls).toEqual(['http://127.0.0.1:4790/?file=boards/main.board.json'])
    // a restart in another workspace keeps what the verdict last said
    await manager!.start('a1', d, '/ws2')
    expect(urls.at(-1)).toBe('http://127.0.0.1:4791/?file=boards/main.board.json')
    await manager!.stop('a1')
    await manager!.start('a1', d, '/ws')
    expect(urls.at(-1)).toBe('http://127.0.0.1:4792/?file=')
  })
})

describe('viewer.use (spec 1.1)', () => {
  const pkg: InstalledDsh = {
    id: 'acme/viewer', dir: '/i/acme/viewer', realDir: '/real/acme/viewer', source: '', ref: null, commit: null, linked: false, installedAt: 0,
    manifest: { spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: 'viewer.sh', url: 'http://127.0.0.1:${port}/?file=${artifact}', artifactExtensions: ['.step', '.glb'] } },
  }
  const lookup = (id: string) => (id === 'acme/viewer' ? pkg : undefined)

  it('resolves a used viewer to the package: its command and directory, the harness narrowing url and extensions', () => {
    const own = resolveViewer(dsh({ command: 'mine.sh', url: 'http://127.0.0.1:${port}/' }), lookup)
    expect(own.ok && own.viewer).toEqual({ id: 'acme/thing', dir: '/i/acme/thing', command: 'mine.sh', url: 'http://127.0.0.1:${port}/', artifactExtensions: [] })
    const used = resolveViewer(dsh({ use: 'acme/viewer' }), lookup)
    expect(used.ok && used.viewer).toEqual({ id: 'acme/viewer', dir: '/real/acme/viewer', command: 'viewer.sh', url: 'http://127.0.0.1:${port}/?file=${artifact}', artifactExtensions: ['.step', '.glb'] })
    const narrowed = resolveViewer(dsh({ use: 'acme/viewer', artifactExtensions: ['.step'] }), lookup)
    expect(narrowed.ok && narrowed.viewer.artifactExtensions).toEqual(['.step'])
    const missing = resolveViewer(dsh({ use: 'acme/nope' }), lookup)
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error).toContain('not installed')
    const notViewer = resolveViewer(dsh({ use: 'acme/viewer' }), () => dsh({ command: 'x', url: 'http://127.0.0.1:${port}/' }))
    expect(!notViewer.ok && notViewer.error).toContain('not a viewer package')
  })

  it('launches a used viewer in the package directory, naming both the harness and the viewer in the env', async () => {
    const spawned: Array<{ env: Record<string, string>; cwd: string }> = []
    const urls: Array<string | null> = []
    const manager = new DshViewerManager({
      onUrl: (_a, url) => urls.push(url),
      freePort: async () => 4800,
      waitForPort: async () => true,
      spawn: ((_script: string, o: { cwd: string; env?: Record<string, string> }) => { spawned.push({ env: o.env ?? {}, cwd: o.cwd }); return fakeChild() }) as typeof import('./shell.js').spawnDshCommand,
      lookup,
    })
    try {
      await manager.start('a9', dsh({ use: 'acme/viewer' }), '/ws')
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.cwd).toBe('/real/acme/viewer')
      expect(spawned[0]!.env).toMatchObject({ HARNESS_DSH: 'acme/thing', HARNESS_DSH_DIR: '/i/acme/thing', HARNESS_VIEWER: 'acme/viewer', HARNESS_VIEWER_DIR: '/real/acme/viewer', HARNESS_WORKSPACE: '/ws', HARNESS_VIEWER_PORT: '4800' })
      expect(urls).toEqual(['http://127.0.0.1:4800/?file='])
      // a harness whose viewer package is missing gets no pane and no crash
      const logs: string[] = []
      const bare = new DshViewerManager({ onUrl: () => undefined, log: (l) => logs.push(l), lookup: () => undefined })
      await bare.start('a10', dsh({ use: 'acme/viewer' }), '/ws')
      expect(bare.url('a10')).toBeNull()
      expect(logs.join(' ')).toContain('not installed')
    } finally {
      await manager.stopAll()
    }
  })

  it('a used viewer with no extensions anywhere follows only the verdict; a harness with no viewer resolves to none', () => {
    const bare: InstalledDsh = { ...pkg, manifest: { spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: 'viewer.sh', url: 'http://127.0.0.1:${port}/' } } }
    const used = resolveViewer(dsh({ use: 'acme/viewer' }), () => bare)
    expect(used.ok && used.viewer.artifactExtensions).toEqual([])
    const none: InstalledDsh = { ...dsh({ command: 'x', url: 'y' }), manifest: { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude' } }
    expect(resolveViewer(none, lookup)).toEqual({ ok: false, error: 'acme/thing has no viewer' })
  })
})

describe('the loopback helpers', () => {
  const servers: Server[] = []
  afterEach(async () => {
    net.fake = null
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  })
  const listen = (port = 0): Promise<number> => new Promise((resolve) => {
    const server = createServer((socket) => socket.end())
    servers.push(server)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })

  it('freeLoopbackPort answers a port nothing holds, which can then be listened on', async () => {
    const port = await freeLoopbackPort()
    expect(port).toBeGreaterThan(0)
    expect(await listen(port)).toBe(port)
  })

  it('freeLoopbackPort rejects when loopback cannot be bound', async () => {
    const server = Object.assign(new EventEmitter(), {
      unref: () => undefined,
      listen: () => { queueMicrotask(() => server.emit('error', new Error('listen EADDRNOTAVAIL 127.0.0.1'))) },
    })
    net.fake = { createServer: () => server }
    await expect(freeLoopbackPort()).rejects.toThrow('EADDRNOTAVAIL')
  })

  it('waitForLoopbackPort: yes for a listening port, no once the deadline passes, and yes for one that opens late', async () => {
    const port = await listen()
    expect(await waitForLoopbackPort(port, 1_000)).toBe(true)
    const closed = await freeLoopbackPort()
    expect(await waitForLoopbackPort(closed, 0)).toBe(false)
    const started = Date.now()
    expect(await waitForLoopbackPort(closed, 600)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
    const late = await freeLoopbackPort()
    setTimeout(() => { void listen(late) }, 300)
    expect(await waitForLoopbackPort(late, 5_000)).toBe(true)
  })

  it('waitForLoopbackPort treats a connect that hangs past its second as not yet up, and tries again', async () => {
    const sockets: EventEmitter[] = []
    net.fake = {
      connect: () => {
        const socket = Object.assign(new EventEmitter(), { setTimeout: () => undefined, destroy: () => undefined })
        sockets.push(socket)
        queueMicrotask(() => socket.emit(sockets.length === 1 ? 'timeout' : 'connect'))
        return socket
      },
    }
    expect(await waitForLoopbackPort(1, 5_000)).toBe(true)
    expect(sockets).toHaveLength(2)
  })
})

describe('DshViewerManager, the rest of a viewer\'s life', () => {
  let manager: DshViewerManager | null = null
  let root: string
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-viewer-'))) })
  afterEach(async () => {
    await manager?.stopAll()
    manager = null
    rmSync(root, { recursive: true, force: true })
  })

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  function setup(deps: Partial<ConstructorParameters<typeof DshViewerManager>[0]> = {}) {
    const spawned: Array<ReturnType<typeof fakeChild>> = []
    const urls: Array<string | null> = []
    const logs: string[] = []
    manager = new DshViewerManager({
      onUrl: (_agentId, url) => urls.push(url),
      log: (line) => logs.push(line),
      freePort: async () => 4790 + spawned.length,
      waitForPort: async () => true,
      spawn: (() => { const child = fakeChild(); spawned.push(child); return child }) as unknown as typeof import('./shell.js').spawnDshCommand,
      ...deps,
    })
    return { spawned, urls, logs, manager }
  }

  it('runs a bare script name as the package\'s own file, the way `harness dsh check` reads it', async () => {
    writeFileSync(join(root, 'viewer.sh'), '#!/bin/sh\n', { mode: 0o755 })
    const scripts: string[] = []
    const { manager } = setup({ spawn: ((script: string) => { scripts.push(script); return fakeChild() }) as unknown as typeof import('./shell.js').spawnDshCommand })
    const own = (command: string): InstalledDsh => ({ ...dsh({ command, url: 'http://127.0.0.1:${port}/' }), dir: root, realDir: root })
    await manager.start('a1', own('viewer.sh'), '/ws')
    await manager.start('a2', own('node viewer.mjs --port $HARNESS_VIEWER_PORT'), '/ws')
    expect(scripts).toEqual([`'${join(root, 'viewer.sh')}'`, 'node viewer.mjs --port $HARNESS_VIEWER_PORT'])
  })

  it('does nothing for a harness with no viewer', async () => {
    const { spawned, logs, manager } = setup()
    await manager.start('a1', { ...dsh({ command: 'v', url: 'u' }), manifest: { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude' } }, '/ws')
    expect(spawned).toEqual([])
    expect(logs).toEqual([])
  })

  it('moving to another workspace stops the old viewer and starts a new one', async () => {
    const { spawned, urls, manager } = setup()
    const d = dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' })
    await manager.start('a1', d, '/ws')
    await manager.start('a1', d, '/elsewhere')
    expect(spawned).toHaveLength(2)
    expect(urls).toEqual(['http://127.0.0.1:4790/', null, 'http://127.0.0.1:4791/'])
    await manager.stop('never-started')
  })

  it('logs when no port is free, whatever the failure was, and starts nothing', async () => {
    const d = dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' })
    const { spawned, urls, logs, manager } = setup({ freePort: async () => { throw new Error('EMFILE') } })
    await manager.start('a1', d, '/ws')
    const other = new DshViewerManager({ onUrl: () => undefined, log: (line) => logs.push(line), freePort: () => Promise.reject('no ports left'), spawn: () => { throw new Error('never') } })
    await other.start('a2', d, '/ws')
    expect(spawned).toEqual([])
    expect(urls).toEqual([])
    expect(logs).toEqual(['[dsh] acme/thing viewer: no free port · EMFILE', '[dsh] acme/thing viewer: no free port · no ports left'])
  })

  it('a stop while the port is being found, or while the viewer comes up, publishes nothing', async () => {
    let freePort!: (port: number) => void
    const { spawned, urls, manager } = setup({ freePort: () => new Promise((resolve) => { freePort = resolve }) })
    const d = dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' })
    const first = manager.start('a1', d, '/ws')
    await settle(0)
    await manager.stop('a1')
    freePort(4790)
    await first
    expect(spawned).toEqual([])

    let up!: (ok: boolean) => void
    const second = setup({ waitForPort: () => new Promise((resolve) => { up = resolve }) })
    const starting = second.manager.start('a1', d, '/ws')
    await vi.waitFor(() => expect(second.spawned).toHaveLength(1))
    await second.manager.stop('a1')
    up(true)
    await starting
    expect(second.urls).toEqual([])
    expect(urls).toEqual([])
  })

  it('logs what the viewer prints, up to forty lines, without blank lines or zsh noise, and a failure to start', async () => {
    const { spawned, logs, manager } = setup()
    await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    const printed = Array.from({ length: 45 }, (_, i) => `line ${i}`)
    spawned[0].stdout!.emit('data', Buffer.from(`\n${printed.slice(0, 20).join('\n')}\n   \n`))
    spawned[0].stderr!.emit('data', Buffer.from(`zsh: can't change option: zle\n${printed.slice(20).join('\n')}\n`))
    spawned[0].emit('error', new Error('spawn EACCES'))
    const viewerLines = logs.filter((line) => line.startsWith('[dsh] acme/thing viewer · '))
    expect(viewerLines).toEqual(printed.slice(0, 40).map((line) => `[dsh] acme/thing viewer · ${line}`))
    expect(logs).toContain('[dsh] acme/thing viewer could not start · spawn EACCES')
  })

  it('an exit after a stop is ignored; an exit during a stop publishes null and restarts nothing', async () => {
    const { spawned, urls, logs, manager } = setup()
    const workspace = join(root, 'ws')
    mkdirSync(workspace)
    await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/', artifactExtensions: ['.step'] }), workspace)
    // the stop is waiting on the artifact watcher to close when the child goes
    const stopping = manager.stop('a1')
    spawned[0].emit('exit', null, 'SIGTERM')
    await stopping
    spawned[0].exitWith(0)
    await settle(1_200)
    expect(spawned).toHaveLength(1)
    expect(urls).toEqual(['http://127.0.0.1:4790/', null])
    expect(logs.filter((line) => line.includes('restarting'))).toEqual([])
  })

  it('a viewer killed by a signal is restarted, and the log says which signal', async () => {
    const { spawned, logs, manager } = setup({ now: undefined })
    await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    spawned[0].emit('exit', null, 'SIGSEGV')
    expect(logs.at(-1)).toBe('[dsh] acme/thing viewer exited SIGSEGV · restarting in 1000ms')
    await vi.waitFor(() => expect(spawned).toHaveLength(2), { timeout: 3_000 })
  })

  it('gives up after four exits inside a minute, naming how the last one ended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let clock = 0
      const { spawned, logs, manager } = setup({ now: () => clock })
      await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
      for (let i = 0; i < 3; i++) {
        spawned[i].emit('exit', null, 'SIGKILL')
        await vi.advanceTimersByTimeAsync(1_000 * 2 ** i)
        expect(spawned).toHaveLength(i + 2)
        clock += 1_000
      }
      spawned[3].emit('exit', null, 'SIGKILL')
      expect(logs.at(-1)).toBe('[dsh] acme/thing viewer exited SIGKILL 4 times in a minute · giving up')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(spawned).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a viewer that never listens is logged and stopped', async () => {
    const { logs, urls, manager } = setup({ waitForPort: async () => false })
    await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/' }), '/ws')
    expect(urls).toEqual([])
    expect(logs).toContain('[dsh] acme/thing viewer did not listen on 4790 within 60s')
  })

  it('follows the newest artifact as files change, in a workspace whose own path has an ignored name in it', async () => {
    // `build` is a folder name the artifact scan skips INSIDE a workspace; a workspace that itself lives
    // under a build/ folder used to have every change refused, so the pane never followed a new file.
    const workspace = join(root, 'build', 'ws')
    mkdirSync(join(workspace, 'models'), { recursive: true })
    const at = (rel: string, seconds: number): void => {
      mkdirSync(join(workspace, rel, '..'), { recursive: true })
      writeFileSync(join(workspace, rel), rel)
      utimesSync(join(workspace, rel), seconds, seconds)
    }
    at('models/old.step', 1_000)
    const { urls, logs, manager } = setup()
    await manager.start('a1', dsh({ command: 'v', url: 'http://127.0.0.1:${port}/?file=${artifact}', artifactExtensions: ['.step'] }), workspace)
    expect(urls).toEqual(['http://127.0.0.1:4790/?file=models/old.step'])
    await settle(300)

    at('models/new.step', 2_000)
    await vi.waitFor(() => expect(urls.at(-1)).toBe('http://127.0.0.1:4790/?file=models/new.step'), { timeout: 5_000 })
    // not artifacts, or not where artifacts are looked for: nothing changes
    at('notes.txt', 3_000)
    at('node_modules/lib/newest.step', 3_000)
    at('.cache/newest.step', 3_000)
    // the same newest file touched again, twice inside the debounce: one rescan, same answer
    at('models/new.step', 2_001)
    at('models/new.step', 2_002)
    await settle(900)
    expect(urls).toEqual(['http://127.0.0.1:4790/?file=models/old.step', 'http://127.0.0.1:4790/?file=models/new.step'])

    rmSync(join(workspace, 'models', 'new.step'))
    await vi.waitFor(() => expect(urls.at(-1)).toBe('http://127.0.0.1:4790/?file=models/old.step'), { timeout: 5_000 })
    rmSync(join(workspace, 'models', 'old.step'))
    await vi.waitFor(() => expect(urls.at(-1)).toBe('http://127.0.0.1:4790/?file='), { timeout: 5_000 })

    const inner = (manager as unknown as { states: Map<string, { watcher: EventEmitter }> }).states.get('a1')!.watcher
    inner.emit('error', new Error('EMFILE'))
    inner.emit('error', 'lost')
    expect(logs.filter((line) => line.includes('artifact watch error'))).toEqual(['[dsh] artifact watch error · EMFILE', '[dsh] artifact watch error · lost'])

    // a stop with a rescan still pending cancels it, and a watcher that fails to close does not fail the stop
    const state = (manager as unknown as { states: Map<string, { rescanTimer: unknown; watcher: { close: () => Promise<void> } }> }).states.get('a1')!
    const close = state.watcher.close.bind(state.watcher)
    state.watcher.close = async () => { await close(); throw new Error('close failed') }
    at('models/newest.step', 5_000)
    await vi.waitFor(() => expect(state.rescanTimer).not.toBeNull(), { timeout: 5_000 })
    await manager.stop('a1')
    await settle(500)
    expect(urls.at(-1)).toBeNull()
    expect(urls.filter((url) => url?.endsWith('newest.step'))).toEqual([])
  }, 20_000)

  it('runs a real viewer through the user\'s shell, on the port it was given, and stops it', async () => {
    const urls: Array<string | null> = []
    manager = new DshViewerManager({ onUrl: (_agentId, url) => urls.push(url) })
    const server = `require('http').createServer((q, s) => s.end(process.env.HARNESS_VIEWER + ' ' + process.env.HARNESS_WORKSPACE)).listen(+process.env.HARNESS_VIEWER_PORT, '127.0.0.1')`
    const d: InstalledDsh = { ...dsh({ command: `'${process.execPath}' -e "${server}"`, url: 'http://127.0.0.1:${port}/' }), dir: root, realDir: root }
    await manager.start('a1', d, root)
    const url = urls.at(-1)!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(await (await fetch(url)).text()).toBe(`acme/thing ${root}`)
    await manager.stop('a1')
    await vi.waitFor(async () => { await expect(fetch(url)).rejects.toThrow() }, { timeout: 5_000 })
    expect(urls.at(-1)).toBeNull()
  }, 30_000)
})
