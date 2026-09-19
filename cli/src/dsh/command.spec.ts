// `harness dsh …` as a person at a terminal uses it: what each verb prints, and the exit code it returns.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { dshInstallDir, installedDsh, invalidateInstalledDsh, upsertInstalledRecord } from './installed.js'
import type { DshInstallOptions } from './install.js'
import { HARNESS_MONOREPO, resetBundledDshRegistry } from './registry.js'

// When `captured` is a list, installDsh records what it was asked and fails as if offline; otherwise it
// is the real one. The registry-id cases would otherwise clone from GitHub.
const seams = vi.hoisted(() => ({ captured: null as null | unknown[] }))
vi.mock('./install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install.js')>()
  return {
    ...actual,
    installDsh: (opts: DshInstallOptions) => {
      if (!seams.captured) return actual.installDsh(opts)
      seams.captured.push({ source: opts.source, ref: opts.ref, path: opts.path, link: opts.link })
      return Promise.resolve({ ok: false, error: 'OFFLINE', detail: 'no network in a test' })
    },
  }
})

const { dshCommand, dshUsage } = await import('./command.js')

function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture')
  return dir
}

describe('harness dsh', () => {
  let root: string
  let savedDshDir: string
  let savedRef: string | undefined
  let out: string[]
  let err: string[]
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-command-')))
    savedDshDir = env.DSH_DIR
    savedRef = env.HARNESS_STORE_REF
    env.DSH_DIR = join(root, 'installed')
    env.HARNESS_STORE_REF = undefined
    invalidateInstalledDsh()
    // These command-contract fixtures exercise the offline bundled fallback.
    // catalog.spec.ts covers live discovery and installation separately.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline fixture')))
    out = []
    err = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { err.push(args.join(' ')) })
    // A registry of our own instead of the real shelf: what `list` offers and what an id resolves to.
    vi.stubGlobal('__DSH_REGISTRY__', JSON.stringify([
      { id: 'acme/thing', name: 'Thing', repo: 'https://example.com/thing.git', engine: 'claude', tier: 1 },
      { id: 'autonomous/typst', name: 'Typst', repo: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/typst', engine: 'claude', tier: 2 },
      { id: 'autonomous/pane', kind: 'viewer', name: 'Pane', repo: HARNESS_MONOREPO, ref: 'main', path: 'store/viewers/pane' },
    ]))
    resetBundledDshRegistry()
  })
  afterEach(() => {
    seams.captured = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetBundledDshRegistry()
    env.DSH_DIR = savedDshDir
    env.HARNESS_STORE_REF = savedRef
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  const thing = (manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): string => gitRepo(join(root, 'src', String(manifest.id ?? 'acme/thing').replace('/', '-')), {
    'harness.json': JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude', ...manifest }),
    ...files,
  })

  it('prints its usage for no verb, help, or a verb it does not know; only the last is a failure', async () => {
    expect(await dshCommand(undefined, [])).toBe(0)
    expect(await dshCommand('help', [])).toBe(0)
    expect(await dshCommand('frobnicate', [])).toBe(1)
    expect(err).toEqual([dshUsage(), dshUsage(), dshUsage()])
    expect(dshUsage()).toContain('harness dsh install <id|url|path> [--ref <ref>] [--path <folder>] [--link]')
  })

  describe('list', () => {
    it('says so when nothing is installed and the registry is empty', async () => {
      vi.stubGlobal('__DSH_REGISTRY__', '[]')
      resetBundledDshRegistry()
      expect(await dshCommand('list', [])).toBe(0)
      expect(out).toEqual(['  (nothing installed, registry empty)'])
    })

    it('lists what is installed, what is broken, then what the registry offers that is not here', async () => {
      await dshCommand('install', [thing({ viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } })])
      await dshCommand('install', [thing({ id: 'acme/pane', kind: 'viewer', engine: undefined, viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } }), '--link'])
      upsertInstalledRecord({ id: 'acme/broken', dir: join(root, 'gone'), source: 'x', ref: null, commit: null, linked: false, installedAt: 0 })
      out = []
      expect(await dshCommand('list', [])).toBe(0)
      expect(out).toHaveLength(1)
      expect(out[0].split('\n')).toEqual([
        `  ${'acme/pane'.padEnd(28)} ${'Thing'.padEnd(12)} ${'viewer'.padEnd(11)} tier 2  installed (linked) @ ${installedDsh('acme/pane')!.commit!.slice(0, 8)} · ${dshInstallDir('acme/pane')}`,
        `  ${'acme/thing'.padEnd(28)} ${'Thing'.padEnd(12)} ${'on claude'.padEnd(11)} tier 2  installed @ ${installedDsh('acme/thing')!.commit!.slice(0, 8)} · ${dshInstallDir('acme/thing')}`,
        `  ${'acme/broken'.padEnd(28)} ${'?'.padEnd(12)} ${''.padEnd(11)} ${''.padEnd(6)}  BROKEN · ${join(root, 'gone')} is missing`,
        `  ${'autonomous/pane'.padEnd(28)} ${'Pane'.padEnd(12)} ${'viewer'.padEnd(11)} tier ?  available · ${HARNESS_MONOREPO}/tree/main/store/viewers/pane`,
        `  ${'autonomous/typst'.padEnd(28)} ${'Typst'.padEnd(12)} ${'on claude'.padEnd(11)} tier 2  available · ${HARNESS_MONOREPO}/tree/main/store/agents/typst`,
      ])
    })
  })

  describe('install', () => {
    it('installs a local repo, narrating phases and lines, and says what it installed', async () => {
      const repo = thing({ toolchain: { doctor: './doctor.sh' } }, { 'doctor.sh': '#!/bin/sh\necho "ok   all here"\n' })
      expect(await dshCommand('install', [repo])).toBe(0)
      expect(out[0]).toBe(`[dsh] ${repo} · clone · cloning ${repo}`)
      expect(out).toContain('[dsh] acme/thing · doctor')
      expect(out).toContain('    ok   all here')
      expect(out.at(-2)).toBe('[dsh] acme/thing · done')
      expect(out.at(-1)).toBe(`Installed acme/thing (Thing, runs on claude) at ${dshInstallDir('acme/thing')}`)
    })

    it('says a viewer package is one', async () => {
      const repo = thing({ id: 'acme/pane', kind: 'viewer', engine: undefined, viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } })
      expect(await dshCommand('install', [repo, '--link'])).toBe(0)
      expect(out.at(-1)).toBe(`Installed acme/pane (Thing, a viewer package) at ${dshInstallDir('acme/pane')}`)
    })

    it('fails with usage for no target, and plainly for a target that is no id, URL or path', async () => {
      expect(await dshCommand('install', [])).toBe(1)
      expect(await dshCommand('install', ['--link'])).toBe(1)
      expect(err).toEqual([dshUsage(), dshUsage()])
      expect(await dshCommand('install', ['bad\nsource'])).toBe(1)
      expect(err.at(-1)).toBe('harness dsh install: bad\nsource is not an id, URL or path')
    })

    it('reports a failed install with its error and detail', async () => {
      expect(await dshCommand('install', [join(root, 'nothing-here')])).toBe(1)
      expect(err.at(-1)).toMatch(/^harness dsh install failed · CLONE_FAILED · git clone exited 128: /)
    })

    it('an id installs from its registry entry; --ref and --path override it, and never count as the target', async () => {
      seams.captured = []
      expect(await dshCommand('install', ['autonomous/typst'])).toBe(1)
      expect(await dshCommand('install', ['--ref', 'v2', 'autonomous/typst', '--path', 'store/agents/typst-next'])).toBe(1)
      expect(await dshCommand('install', ['https://example.com/other.git', '--ref'])).toBe(1)
      expect(seams.captured).toEqual([
        { source: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/typst', link: false },
        { source: HARNESS_MONOREPO, ref: 'v2', path: 'store/agents/typst-next', link: false },
        { source: 'https://example.com/other.git', ref: undefined, path: undefined, link: false },
      ])
      expect(err.at(-1)).toBe('harness dsh install failed · OFFLINE · no network in a test')
    })

    it('HARNESS_STORE_REF moves an id from the shelf to the branch under test; --link takes no ref or path', async () => {
      env.HARNESS_STORE_REF = 'store-e2e'
      resetBundledDshRegistry()
      seams.captured = []
      await dshCommand('install', ['autonomous/typst'])
      await dshCommand('install', ['/Users/example/code/typst', '--link', '--ref', 'v2', '--path', 'x'])
      expect(seams.captured).toEqual([
        { source: HARNESS_MONOREPO, ref: 'store-e2e', path: 'store/agents/typst', link: false },
        { source: '/Users/example/code/typst', ref: undefined, path: undefined, link: true },
      ])
    })
  })

  it('updates from the recorded source, reports the version, and rejects missing or invalid targets', async () => {
    const repo = thing()
    expect(await dshCommand('install', [repo])).toBe(0)
    writeFileSync(join(repo, 'README.md'), 'new package version')
    execFileSync('git', ['-C', repo, 'add', '-A'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'updated'])
    expect(await dshCommand('update', ['acme/thing'])).toBe(0)
    expect(out.at(-1)).toMatch(/acme\/thing is up to date @ [a-f0-9]{8}. Workspaces preserved./)
    expect(await dshCommand('update', ['acme/missing'])).toBe(1)
    expect(err.at(-1)).toContain('NOT_INSTALLED')
    for (const args of [[], ['../../etc'], ['acme/thing', 'acme/other']]) {
      expect(await dshCommand('update', args)).toBe(1)
      expect(err.at(-1)).toContain('harness dsh update <id>')
    }
  })

  describe('doctor', () => {
    it('runs the installed harness\'s doctor, by its id or an id it went by before', async () => {
      await dshCommand('install', [thing({ formerly: ['acme/old-thing'], toolchain: { doctor: './doctor.sh' } }, { 'doctor.sh': '#!/bin/sh\necho "ok   fine"\n' })])
      out = []
      expect(await dshCommand('doctor', ['acme/thing'])).toBe(0)
      expect(out).toEqual(['  ok   fine', 'acme/thing is ready'])
      out = []
      expect(await dshCommand('doctor', ['acme/old-thing'])).toBe(0)
      expect(out.at(-1)).toBe('acme/thing is ready')
    })

    it('a doctor that fails is not ready; no id, or one not installed, is said', async () => {
      await dshCommand('install', [thing({ toolchain: { doctor: 'echo "miss everything"; exit 1' } })])
      out = []
      expect(await dshCommand('doctor', ['acme/thing'])).toBe(1)
      expect(out.at(-1)).toBe('acme/thing is not ready')
      expect(await dshCommand('doctor', [])).toBe(1)
      expect(await dshCommand('doctor', ['acme/nobody'])).toBe(1)
      expect(err.slice(-2)).toEqual(['harness dsh doctor: <id> is not installed', 'harness dsh doctor: acme/nobody is not installed'])
    })
  })

  describe('check', () => {
    it('prints each line and whether the checkout conforms, from a path or the current folder', async () => {
      const repo = thing({ author: 'Acme', description: 'A thing' })
      expect(await dshCommand('check', [repo])).toBe(0)
      expect(out.at(-1)).toBe('acme/thing conforms to spec 1')
      expect(out[0]).toContain('ok   harness.json parses · acme/thing "Thing" runs on claude')
      const cwd = process.cwd()
      process.chdir(repo)
      try {
        expect(await dshCommand('check', [])).toBe(0)
      } finally {
        process.chdir(cwd)
      }
      expect(out.at(-1)).toBe('acme/thing conforms to spec 1')
    })

    it('a checkout that fails names its id; one with no manifest names the path', async () => {
      const repo = thing({ toolchain: { doctor: 'missing.sh' } })
      expect(await dshCommand('check', [repo])).toBe(1)
      expect(out.at(-1)).toBe('acme/thing does not conform')
      const empty = join(root, 'empty')
      mkdirSync(empty)
      expect(await dshCommand('check', [empty])).toBe(1)
      expect(out.at(-1)).toBe(`${empty} does not conform`)
    })
  })

  describe('remove', () => {
    it('removes an installed harness; no id is usage; one not installed is a failure', async () => {
      await dshCommand('install', [thing()])
      out = []
      expect(await dshCommand('remove', ['acme/thing'])).toBe(0)
      expect(out).toEqual(['Removed acme/thing'])
      expect(await dshCommand('remove', [])).toBe(1)
      expect(err.at(-1)).toBe(dshUsage())
      expect(await dshCommand('remove', ['acme/thing'])).toBe(1)
      expect(err.at(-1)).toBe('harness dsh remove failed · NOT_INSTALLED · acme/thing is not installed')
    })
  })
})
