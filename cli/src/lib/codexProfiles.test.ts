import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type * as CodexProfilesModule from './codexProfiles.js'

let dataDir = ''
let home = ''

async function loadModule(): Promise<typeof CodexProfilesModule> {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./codexProfiles.js')
}

const emptyDiscovery = { home: '/nonexistent-empty-home', environment: {} }

describe('codexProfiles', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-profiles-data-'))
    // Under the real home, not os.tmpdir(): resolveCodexProfilePath realpath-resolves everything it
    // returns, and macOS's tmpdir sits behind a /var → /private/var symlink that would otherwise
    // make the resolved path disagree with the literal folder these tests just created.
    home = mkdtempSync(join(homedir(), '.codex-profiles-test-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('resolveCodexProfilePath rejects a relative path', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('relative/codex')).toEqual({ error: 'INVALID_PATH' })
  })

  it('resolveCodexProfilePath rejects a path with control characters', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('/tmp/codex\nhome')).toEqual({ error: 'INVALID_PATH' })
  })

  it('resolveCodexProfilePath rejects a folder that does not exist', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath(join(home, 'nope'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath rejects a path that is a file, not a directory', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const file = join(home, 'not-a-dir')
    writeFileSync(file, '')
    expect(resolveCodexProfilePath(file)).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath accepts and resolves an existing absolute folder', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const folder = join(home, '.codex-work')
    mkdirSync(folder)
    expect(resolveCodexProfilePath(folder)).toEqual({ path: folder, label: '.codex-work' })
  })

  it('linkCodexProfile persists the resolved path on this machine', async () => {
    const { linkCodexProfile } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    expect(linkCodexProfile(folder)).toEqual({ path: folder, label: '.codex-linked' })
    const persisted = JSON.parse(readFileSync(join(dataDir, 'codex-profiles.json'), 'utf8'))
    expect(persisted).toEqual([folder])
  })

  it('linkCodexProfile refuses a folder that does not exist', async () => {
    const { linkCodexProfile } = await loadModule()
    expect(linkCodexProfile(join(home, 'ghost'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('listCodexProfiles returns a previously linked folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-linked' }])
  })

  it('listCodexProfiles drops a linked folder that has since vanished', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    rmSync(folder, { recursive: true, force: true })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })

  it('listCodexProfiles includes observedPaths without requiring them to be linked', async () => {
    const { listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-observed')
    mkdirSync(folder)
    expect(listCodexProfiles([folder], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-observed' }])
  })

  it('listCodexProfiles includes freshly discovered folders', async () => {
    const { listCodexProfiles } = await loadModule()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    expect(listCodexProfiles([], { home, environment: {} })).toEqual([
      { path: join(home, '.codex'), label: '.codex' },
    ])
  })

  it('listCodexProfiles dedupes linked, observed and discovered copies of the same folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex')
    mkdirSync(folder)
    writeFileSync(join(folder, 'auth.json'), '{}')
    linkCodexProfile(folder)
    expect(listCodexProfiles([folder], { home, environment: {} })).toEqual([{ path: folder, label: '.codex' }])
  })

  it('listCodexProfiles sorts by label (case-insensitive), then by path', async () => {
    const { listCodexProfiles } = await loadModule()
    const b = join(home, '.codex-Beta')
    const a = join(home, '.codex-alpha')
    mkdirSync(a)
    mkdirSync(b)
    expect(listCodexProfiles([a, b], emptyDiscovery)).toEqual([
      { path: a, label: '.codex-alpha' },
      { path: b, label: '.codex-Beta' },
    ])
  })

  it('listCodexProfiles never throws when the state file is malformed', async () => {
    const { listCodexProfiles } = await loadModule()
    writeFileSync(join(dataDir, 'codex-profiles.json'), 'not json', { mode: 0o600 })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })
})
