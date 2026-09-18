import { updateDsh } from './update.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { env } from '../config/env.js'
import { dshInstallDir, installedDsh, invalidateInstalledDsh, readInstalledIndex, upsertInstalledRecord } from './installed.js'
import { installDsh, removeDsh, type DshInstallProgress } from './install.js'
import { materializeWorkspace } from './materialize.js'
import { dshUpdateInfo } from './updates.js'
import { type DshRegistryEntry } from './registry.js'
import { dshListRows } from './wire.js'

const faults = vi.hoisted(() => ({ cleanup: false, place: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.place && String(args[0]).includes('/.tmp-') && String(args[1]).endsWith('/acme/thing')) throw new Error('disk full while placing update')
      return fs.renameSync(...args)
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (faults.cleanup && String(args[0]).includes('/.previous-')) throw new Error('backup is busy')
      return fs.rmSync(...args)
    },
  }
})

describe('package updates', { timeout: 30_000 }, () => {
  let root: string
  let savedRoot: string
  const id = 'acme/thing'
  const manifest = { spec: 1, id, name: 'Thing', engine: 'claude',
    agent: { instructions: 'AGENTS.md', skills: ['skills'] },
    workspace: { template: 'template', marker: 'project.txt' },
    toolchain: { setup: './setup.sh', doctor: './doctor.sh' } }
  const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' },
  }).trim()
  const write = (dir: string, files: Record<string, string>): void => {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
    }
  }
  const commit = (repo: string): string => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'package version'); return git(repo, 'rev-parse', 'HEAD') }
  const create = (path?: string): string => {
    const repo = join(root, 'repo')
    const dir = path ? join(repo, path) : repo
    write(dir, {
      'harness.json': JSON.stringify(manifest), 'AGENTS.md': '# Original instructions\n',
      'skills/task/SKILL.md': '# Original skill\n', 'template/project.txt': 'template\n',
      'setup.sh': '#!/bin/sh\npwd > setup-path\n', 'doctor.sh': '#!/bin/sh\ntest -f setup-path\n',
    })
    git(repo, 'init', '-q', '-b', 'main'); commit(repo)
    return repo
  }
  const catalog = (repo: string, ref: string, path?: string): DshRegistryEntry => ({
    id, name: 'Thing', engine: 'claude', repo, ref, path,
    revision: git(repo, 'rev-parse', path ? `${ref}:${path}` : `${ref}^{tree}`),
  })
  const update = (entry?: DshRegistryEntry, progress?: DshInstallProgress[]) => updateDsh({ id,
    registry: candidate => candidate === id ? entry : undefined, onProgress: p => progress?.push(p) })
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-update-')))
    const shell = join(root, 'test-shell')
    writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
    vi.stubEnv('SHELL', shell)
    savedRoot = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    faults.cleanup = false
    faults.place = false
    vi.unstubAllEnvs()
    env.DSH_DIR = savedRoot
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  it('refreshes the default catalog and treats the same recorded commit as a no-op for legacy installs', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const [record] = readInstalledIndex()
    delete record.revision
    upsertInstalledRecord(record)
    const lines: string[] = []
    expect((await updateDsh({ id, onLine: line => lines.push(line) })).ok).toBe(true)
    expect(lines).toContain(`${id} is already up to date`)
  })

  it('repairs a missing installed directory and a record with unknown commit/ref', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const [record] = readInstalledIndex()
    upsertInstalledRecord({ ...record, commit: null, revision: null })
    rmSync(record.dir, { recursive: true })
    expect((await update()).ok).toBe(true)
    expect(installedDsh(id)?.commit).toBe(git(repo, 'rev-parse', 'HEAD'))
  })

  it('rejects a kind change, but updates viewer packages independently', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const viewer = { spec: 1, id, kind: 'viewer', name: 'Viewer', viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }
    write(repo, { 'harness.json': JSON.stringify(viewer) })
    expect(await update(catalog(repo, commit(repo)))).toMatchObject({ ok: false, error: 'PACKAGE_KIND_MISMATCH' })
    removeDsh(id)
    await installDsh({ source: repo })
    write(repo, { 'harness.json': JSON.stringify({ ...viewer, name: 'Updated viewer' }) })
    expect((await update(catalog(repo, commit(repo)))).ok).toBe(true)
    expect(installedDsh(id)?.manifest.name).toBe('Updated viewer')
  })

  it('refuses a symlink even if its installed record incorrectly calls it a clone', async () => {
    const repo = create()
    await installDsh({ source: repo, link: true })
    const [record] = readInstalledIndex()
    upsertInstalledRecord({ ...record, linked: false })
    write(repo, { 'AGENTS.md': '# Changed checkout' })
    expect(await update(catalog(repo, commit(repo)))).toMatchObject({ ok: false, error: 'LINKED_INSTALL' })
    expect(lstatSync(record.dir).isSymbolicLink()).toBe(true)
  })

  it('restores the old package if moving the new files fails and retains a busy backup after success', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const before = readInstalledIndex()
    write(repo, { 'AGENTS.md': '# Updated' })
    const entry = catalog(repo, commit(repo))
    faults.place = true
    expect(await update(entry)).toMatchObject({ ok: false, error: 'UPDATE_FAILED', detail: 'disk full while placing update' })
    expect(readInstalledIndex()).toEqual(before)
    expect(readFileSync(join(dshInstallDir(id), 'AGENTS.md'), 'utf8')).toBe('# Original instructions\n')
    faults.place = false
    faults.cleanup = true
    const lines: string[] = []
    expect((await updateDsh({ id, registry: () => entry, onLine: line => lines.push(line) })).ok).toBe(true)
    expect(lines.some(line => line.startsWith('Previous package retained at'))).toBe(true)
    expect(installedDsh(id)?.commit).toBe(entry.ref)
  })

  it('reports non-Error failures and releases its lock', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const result = await updateDsh({ id, registry: () => { throw 'connection closed' } })
    expect(result).toMatchObject({ ok: false, error: 'UPDATE_FAILED', detail: 'connection closed' })
    expect((await update()).ok).toBe(true)
  })

  for (const path of [undefined, 'store/agents/thing']) {
    it(`updates ${path ?? 'a whole repo'} at the catalog commit, preserving workspace files and skill links`, async () => {
      const repo = create(path)
      expect((await installDsh({ source: repo, ref: 'main', path })).ok).toBe(true)
      const before = installedDsh(id)!
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      await materializeWorkspace(before, workspace)
      write(workspace, { 'project.txt': 'my finished work\n', 'AGENTS.md': 'my custom instructions\n', '.harness/verdict.json': '{"ready":true}', 'notes.md': 'my notes' })
      const skill = join(workspace, '.claude', 'skills', 'task')
      const link = readlinkSync(skill)
      const dir = path ? join(repo, path) : repo
      write(dir, { 'skills/task/SKILL.md': '# Updated skill\n', 'AGENTS.md': '# New instructions\n', 'template/project.txt': 'new template\n' })
      const ref = commit(repo)
      const entry = catalog(repo, ref, path)
      expect(dshListRows([before], [entry])[0]).toMatchObject({ installedCommit: before.commit, availableCommit: ref, updateAvailable: true })
      write(dir, { 'skills/task/SKILL.md': '# Unpublished skill\n' }); commit(repo)
      const phases: DshInstallProgress[] = []
      const result = await update(entry, phases)
      expect(result.ok, JSON.stringify(result)).toBe(true)
      const after = installedDsh(id)!
      expect(after).toMatchObject({ commit: ref, revision: entry.revision, dir: before.dir, installedAt: before.installedAt, updatedAt: expect.any(Number) })
      expect(readFileSync(join(after.dir, 'setup-path'), 'utf8').trim()).toBe(after.dir)
      expect(readFileSync(join(workspace, 'project.txt'), 'utf8')).toBe('my finished work\n')
      expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('my custom instructions\n')
      expect(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8')).toBe('{"ready":true}')
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('my notes')
      expect(readlinkSync(skill)).toBe(link)
      expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('# Updated skill\n')
      expect(dshUpdateInfo(after, entry).updateAvailable).toBe(false)
      expect(phases.map(p => p.phase)).toEqual(['clone', 'setup', 'doctor', 'done'])
      expect(readdirSync(env.DSH_DIR).filter(name => name.startsWith('.'))).toEqual([])
    })
  }

  for (const failure of ['setup', 'doctor']) {
    it(`restores the complete old package and index when ${failure} fails, then supports retry`, async () => {
      const repo = create()
      await installDsh({ source: repo, ref: 'main' })
      const before = readInstalledIndex()
      write(dshInstallDir(id), { 'local-cache': 'keep me' })
      write(repo, { [`${failure}.sh`]: '#!/bin/sh\necho "miss broken update"\nexit 1\n', 'AGENTS.md': '# Bad version' })
      const entry = catalog(repo, commit(repo))
      expect(await update(entry)).toMatchObject({ ok: false, error: `${failure.toUpperCase()}_FAILED` })
      expect(readInstalledIndex()).toEqual(before)
      expect(readFileSync(join(dshInstallDir(id), 'AGENTS.md'), 'utf8')).toBe('# Original instructions\n')
      expect(readFileSync(join(dshInstallDir(id), 'local-cache'), 'utf8')).toBe('keep me')
      write(repo, { [`${failure}.sh`]: '#!/bin/sh\npwd > setup-path\necho "ok fixed"\n' })
      expect((await update(catalog(repo, commit(repo)))).ok).toBe(true)
    })
  }

  it('uses the recorded source/ref for an unlisted install and does not redirect a fork with the same id', async () => {
    const repo = create()
    await installDsh({ source: repo, ref: 'main' })
    write(repo, { 'AGENTS.md': '# New version\n' })
    const ref = commit(repo)
    const unrelated = { ...catalog(repo, ref), repo: join(root, 'different-source') }
    expect(dshUpdateInfo(installedDsh(id)!, unrelated).updateAvailable).toBe(false)
    expect((await update(unrelated)).ok).toBe(true)
    expect(installedDsh(id)?.commit).toBe(ref)
  })

  it('records local clone sources absolutely so updates do not depend on the original working directory', async () => {
    const repo = create()
    await installDsh({ source: relative(process.cwd(), repo) })
    expect(readInstalledIndex()[0]!.source).toBe(repo)
    write(repo, { 'AGENTS.md': '# Latest' })
    const ref = commit(repo)
    expect((await update()).ok).toBe(true)
    expect(installedDsh(id)?.commit).toBe(ref)
  })

  it('restores the harness if its update introduces a viewer that cannot be installed', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const before = readInstalledIndex()
    write(repo, { 'harness.json': JSON.stringify({ ...manifest, viewer: { use: 'acme/unpublished' } }) })
    expect(await update(catalog(repo, commit(repo)))).toMatchObject({ ok: false, error: 'VIEWER_UNAVAILABLE' })
    expect(readInstalledIndex()).toEqual(before)
    expect(installedDsh(id)?.manifest.viewer).toBeUndefined()
  })

  it('skips unchanged package content even when another folder changed in the monorepo', async () => {
    const path = 'store/agents/thing'
    const repo = create(path)
    await installDsh({ source: repo, path, ref: 'main' })
    const before = readInstalledIndex()
    write(repo, { 'unrelated.txt': 'new app version' })
    const entry = catalog(repo, commit(repo), path)
    expect(dshUpdateInfo(installedDsh(id)!, entry).updateAvailable).toBe(false)
    const phases: DshInstallProgress[] = []
    expect((await update(entry, phases)).ok).toBe(true)
    expect(phases.map(p => p.phase)).toEqual(['clone', 'done'])
    expect(readInstalledIndex()).toEqual(before)
  })

  it('handles older records with no revision and refuses to change a linked checkout', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const [record] = readInstalledIndex()
    delete record.revision
    upsertInstalledRecord(record)
    write(repo, { 'AGENTS.md': '# Updated' })
    const entry = catalog(repo, commit(repo))
    expect(dshUpdateInfo(record, entry).updateAvailable).toBe(true)
    expect((await update(entry)).ok).toBe(true)
    expect(installedDsh(id)?.revision).toBe(entry.revision)
    await installDsh({ source: repo, link: true })
    expect(dshUpdateInfo(installedDsh(id)!, entry).updateAvailable).toBe(false)
    expect(await update(entry)).toMatchObject({ ok: false, error: 'LINKED_INSTALL' })
    expect(lstatSync(dshInstallDir(id)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('# Updated')
  })

  it('leaves the installation intact after a clone failure or wrong package identity', async () => {
    expect(await update()).toMatchObject({ ok: false, error: 'NOT_INSTALLED' })
    const repo = create()
    await installDsh({ source: repo })
    const before = readInstalledIndex()
    expect(await update({ ...catalog(repo, git(repo, 'rev-parse', 'HEAD')), ref: 'no-such-ref' })).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
    write(repo, { 'harness.json': JSON.stringify({ ...manifest, id: 'acme/other' }) })
    expect(await update(catalog(repo, commit(repo)))).toMatchObject({ ok: false, error: 'PACKAGE_ID_MISMATCH' })
    expect(readInstalledIndex()).toEqual(before)
    expect(installedDsh(id)?.manifest.id).toBe(id)
  })

  it('blocks concurrent updates, installs and removal until the update finishes', async () => {
    const repo = create()
    await installDsh({ source: repo })
    const gate = join(root, 'release')
    write(repo, { 'setup.sh': `#!/bin/sh\necho waiting\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\npwd > setup-path\n` })
    const entry = catalog(repo, commit(repo))
    let waiting = false
    const pending = updateDsh({ id, registry: () => entry, onLine: line => { if (line === 'waiting') waiting = true } })
    try {
      await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5000 })
      expect(removeDsh(id)).toMatchObject({ ok: false, error: 'DSH_BUSY' })
      expect(await update(entry)).toMatchObject({ ok: false, error: 'DSH_BUSY' })
      expect(await installDsh({ source: repo })).toMatchObject({ ok: false, error: 'DSH_BUSY' })
    } finally { writeFileSync(gate, '') }
    expect((await pending).ok).toBe(true)
    expect(existsSync(join(dshInstallDir(id), 'harness.json'))).toBe(true)
  })
})
