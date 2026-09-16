import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { InstalledDsh } from './installed.js'
import { DshViewerManager, buildViewerUrl, resolveViewer } from './viewer.js'

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
})
