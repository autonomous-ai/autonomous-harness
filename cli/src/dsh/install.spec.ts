// `harness dsh install` on real (local) git repositories: a harness that uses a viewer package
// installs the viewer too, and narrates the viewer's phases under its own id.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { installDsh, type DshInstallProgress } from './install.js'
import { installedDsh, invalidateInstalledDsh, listInstalledDsh, readInstalledIndex } from './installed.js'
import type { DshRegistryEntry } from './registry.js'

function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    // a script is committed executable, the way a real repo carries it; a clone keeps the bit
    writeFileSync(join(dir, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture')
  return dir
}

describe('installDsh with a used viewer', () => {
  let root: string
  let savedDshDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  it('installs the viewer package the harness uses, from the registry, and narrates it under the harness', async () => {
    const viewerRepo = gitRepo(join(root, 'src', 'viewer'), {
      'harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', toolchain: { doctor: './doctor.sh' }, viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/?file=${artifact}', artifactExtensions: ['.step'] } }),
      'doctor.sh': '#!/bin/sh\necho "ok   viewer"\n',
      'viewer.sh': '#!/bin/sh\nsleep 1000\n',
    })
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', agent: { instructions: 'AGENTS.md' }, viewer: { use: 'acme/viewer' } }),
      'AGENTS.md': '# Thing\n',
    })
    const registry = (id: string): DshRegistryEntry | undefined => (id === 'acme/viewer' ? { id, kind: 'viewer', name: 'Viewer', repo: viewerRepo, tier: 2 } : undefined)
    const frames: DshInstallProgress[] = []
    const result = await installDsh({ source: harnessRepo, registry, onProgress: (p) => frames.push(p) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // both are installed, each under its own id
    expect(listInstalledDsh().map((d) => d.id).sort()).toEqual(['acme/thing', 'acme/viewer'])
    expect(installedDsh('acme/viewer')?.manifest.kind).toBe('viewer')
    // every frame the dialog sees carries the harness's id; the viewer's phases ride in the detail
    expect(frames.every((f) => f.id === null || f.id === 'acme/thing'), JSON.stringify(frames)).toBe(true)
    const viewerFrames = frames.filter((f) => f.detail?.startsWith('viewer acme/viewer'))
    expect(viewerFrames.map((f) => f.phase)).toEqual(expect.arrayContaining(['clone', 'doctor', 'setup']))
    expect(viewerFrames.some((f) => f.detail?.includes('installed'))).toBe(true)
    // the harness's own done is the last word
    expect(frames.at(-1)).toMatchObject({ id: 'acme/thing', phase: 'done' })
  })

  it('a used viewer that is already installed is not installed again', async () => {
    const viewerRepo = gitRepo(join(root, 'src', 'viewer'), {
      'harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }),
      'viewer.sh': '#!/bin/sh\nsleep 1000\n',
    })
    const first = await installDsh({ source: viewerRepo })
    expect(first.ok).toBe(true)
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', viewer: { use: 'acme/viewer' } }),
    })
    let asked = 0
    const result = await installDsh({ source: harnessRepo, registry: () => { asked++; return undefined } })
    expect(result.ok).toBe(true)
    expect(asked).toBe(0)
  })

  it('a used viewer that is neither installed nor in the registry is said, and the harness still installs', async () => {
    const harnessRepo = gitRepo(join(root, 'src', 'thing'), {
      'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', viewer: { use: 'acme/missing' } }),
    })
    const lines: string[] = []
    const result = await installDsh({ source: harnessRepo, registry: () => undefined, onLine: (l) => lines.push(l) })
    expect(result.ok).toBe(true)
    expect(lines.join('\n')).toContain('viewer acme/missing is not installed and not in the registry')
  })
})

describe('installDsh from one folder of a repo (the built-in shelf)', () => {
  let root: string
  let savedDshDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-install-path-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
  })
  afterEach(() => {
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  // A monorepo in miniature: an app beside the store, two packages that use each other.
  const monorepo = (): string => gitRepo(join(root, 'src', 'mono'), {
    'README.md': '# the monorepo\n',
    'cli/src/index.ts': 'export {}\n',
    'store/agents/thing/harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] }, toolchain: { setup: './setup.sh' }, viewer: { use: 'acme/viewer' } }),
    'store/agents/thing/AGENTS.md': '# Thing\n',
    'store/agents/thing/skills/draw/SKILL.md': '---\nname: draw\n---\n',
    'store/agents/thing/setup.sh': '#!/bin/sh\ntouch set-up\n',
    'store/viewers/viewer/harness.json': JSON.stringify({ spec: 1, kind: 'viewer', id: 'acme/viewer', name: 'Viewer', viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }),
    'store/viewers/viewer/viewer.sh': '#!/bin/sh\nsleep 1000\n',
  })

  it('installs only that folder, laid out like a whole-repo install, and records where it came from', async () => {
    const repo = monorepo()
    const registry = (id: string): DshRegistryEntry | undefined => (id === 'acme/viewer'
      ? { id, kind: 'viewer', name: 'Viewer', repo, ref: 'main', path: 'store/viewers/viewer' }
      : undefined)
    const frames: DshInstallProgress[] = []
    const result = await installDsh({ source: repo, ref: 'main', path: 'store/agents/thing', registry, onProgress: (p) => frames.push(p) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    // the manifest sits at the install's root; nothing else of the monorepo came along, not even .git
    const dir = result.installed.realDir
    expect(readdirSync(dir).sort()).toEqual(['AGENTS.md', 'harness.json', 'set-up', 'setup.sh', 'skills'])
    expect(existsSync(join(dir, 'skills', 'draw', 'SKILL.md'))).toBe(true)
    // setup ran in the folder, and the script kept its executable bit through the sparse clone
    expect(existsSync(join(dir, 'set-up'))).toBe(true)
    // the viewer it uses came from ITS folder of the same repo
    expect(installedDsh('acme/viewer')?.manifest.kind).toBe('viewer')
    expect(readdirSync(installedDsh('acme/viewer')!.realDir).sort()).toEqual(['harness.json', 'viewer.sh'])
    const row = readInstalledIndex().find((r) => r.id === 'acme/thing')
    expect(row).toMatchObject({ source: repo, ref: 'main', path: 'store/agents/thing', linked: false })
    expect(row?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(frames[0]?.detail).toContain('store/agents/thing')
    // no temporary clone is left in the install root
    expect(readdirSync(env.DSH_DIR).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('a folder the repo does not have fails cleanly and leaves nothing behind', async () => {
    const repo = monorepo()
    const result = await installDsh({ source: repo, path: 'store/agents/nope' })
    expect(result).toMatchObject({ ok: false, error: 'CLONE_FAILED' })
    if (!result.ok) expect(result.detail).toContain('has no folder store/agents/nope')
    expect(listInstalledDsh()).toEqual([])
    expect(readdirSync(env.DSH_DIR).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('refuses a path that climbs out of the repo before cloning anything', async () => {
    for (const path of ['../elsewhere', '/abs', 'store/../..', 'store/agents/thing/']) {
      const result = await installDsh({ source: join(root, 'never-cloned'), path })
      expect(result, path).toMatchObject({ ok: false, error: 'INVALID_SOURCE' })
    }
  })
})
