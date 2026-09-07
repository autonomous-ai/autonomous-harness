import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''
let runtimeDir = ''
let binDir = ''
let cliDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  process.env.HARNESS_BIN_DIR = binDir
  process.env.ADAPTER_CLI_DIR = cliDir
  process.env.ADAPTER_RUNTIME_METADATA_URL = 'https://example.test/runtime/metadata.json'
  return import('./runtimeInstall.js')
}

/** A real gzipped tarball laid out the way nodejs.org ships one, with a runnable `bin/node`. */
function buildArchive(version: string, key: string): { bytes: Buffer; root: string } {
  const archiveRoot = `node-${version}-${key}`
  const source = join(root, 'src')
  mkdirSync(join(source, archiveRoot, 'bin'), { recursive: true })
  writeFileSync(join(source, archiveRoot, 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const archive = join(root, `${archiveRoot}.tar.gz`)
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, archiveRoot])
  return { bytes: readFileSync(archive), root: archiveRoot }
}

function currentPlatformKey(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}

/** Serves the manifest and the archive; any other URL is a test bug. */
function stubFetch(manifest: unknown, archive?: Buffer): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('metadata.json')) {
      return { ok: true, json: async () => manifest } as unknown as Response
    }
    if (archive && url.endsWith('.tar.gz')) {
      return { ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) } as unknown as Response
    }
    return { ok: false, status: 404 } as unknown as Response
  })
}

describe('ensureManagedRuntime', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-runtime-install-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(cliDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL']) {
      delete process.env[key]
    }
  })

  it('does nothing, and fetches nothing, when a runtime is already installed', async () => {
    const node = join(runtimeDir, 'node-v22', 'bin', 'node')
    mkdirSync(join(runtimeDir, 'node-v22', 'bin'), { recursive: true })
    writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-node'), `${node}\n`)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBe(node)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('downloads, verifies and unpacks a runtime, then records it', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'https://example.test/runtime/node.tar.gz',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()
    const node = await ensureManagedRuntime()

    expect(node).toBe(join(runtimeDir, `node-v22.23.2-${key}`, 'bin', 'node'))
    expect(existsSync(node!)).toBe(true)
    expect(readFileSync(join(runtimeDir, 'current-node'), 'utf8').trim()).toBe(node)
    // Staging never survives, whatever happened.
    expect(readdirSync(runtimeDir).filter((n) => n.startsWith('.node-staging-'))).toEqual([])
  })

  it('refuses an archive whose bytes do not match the manifest', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'https://example.test/runtime/node.tar.gz',
          sha256: 'a'.repeat(64),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBeNull()
    expect(existsSync(join(runtimeDir, 'current-node'))).toBe(false)
  })

  // Served as a fully valid, correctly-hashed archive — so the ONLY thing that can reject it is the
  // scheme check. Anything less and this passes for the wrong reason.
  it('refuses a plaintext archive URL even when the bytes are otherwise valid', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'http://example.test/runtime/node.tar.gz',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBeNull()
    expect(existsSync(join(runtimeDir, 'current-node'))).toBe(false)
  })

  // A daemon must not fail to start because a download failed; it keeps the interpreter it has.
  it('returns null instead of throwing when the manifest is unreachable', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ENOTFOUND') })

    const { ensureManagedRuntime } = await load()

    await expect(ensureManagedRuntime()).resolves.toBeNull()
  })
})

describe('ensureLauncher', () => {
  const NODE = '/opt/harness/runtime/node-v22/bin/node'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-launcher-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL']) {
      delete process.env[key]
    }
  })

  const launcherPath = () => join(binDir, 'harness')
  const cliPath = () => join(cliDir, 'cli.js')

  it('repairs the bare-node launcher install-cli.sh used to write', async () => {
    writeFileSync(launcherPath(), `#!/bin/sh\nexec node "${cliPath()}" "$@"\n`, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(`#!/bin/sh\nexec '${NODE}' '${cliPath()}' "$@"\n`)
  })

  it('repairs an absolute system-Node launcher from the public installer', async () => {
    writeFileSync(launcherPath(), `#!/bin/sh\nexec '/opt/homebrew/bin/node' '${cliPath()}' "$@"\n`, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toContain(`exec '${NODE}'`)
    expect(readFileSync(launcherPath(), 'utf8')).not.toContain('homebrew')
  })

  // The pin is the promise that no release reaches this computer on its own. Repairing the
  // interpreter must not quietly revoke it.
  it('fixes a dev-pinned launcher without disarming the pin', async () => {
    const pinned = [
      '#!/bin/sh',
      '# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).',
      '# Self-update is off: no release will ever reach this computer on its own, not even a newer one.',
      'ADAPTER_UPDATE_DISABLE=true',
      'export ADAPTER_UPDATE_DISABLE',
      `exec node "${cliPath()}" "$@"`,
      '',
    ].join('\n')
    writeFileSync(launcherPath(), pinned, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    const out = readFileSync(launcherPath(), 'utf8')
    expect(out).toContain('ADAPTER_UPDATE_DISABLE=true')
    expect(out).toContain('export ADAPTER_UPDATE_DISABLE')
    expect(out).toContain('# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).')
    expect(out).toContain(`exec '${NODE}' '${cliPath()}' "$@"`)
    expect(out).not.toContain('exec node')
  })

  it('leaves a launcher that already points at the right Node untouched', async () => {
    const correct = `#!/bin/sh\nexec '${NODE}' '${cliPath()}' "$@"\n`
    writeFileSync(launcherPath(), correct, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(correct)
  })

  it('never touches a script it did not write', async () => {
    const foreign = '#!/bin/sh\nexec /usr/local/bin/somebody-elses-tool "$@"\n'
    writeFileSync(launcherPath(), foreign, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(foreign)
  })

  it('does not create a launcher where none exists', async () => {
    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(existsSync(launcherPath())).toBe(false)
  })
})
