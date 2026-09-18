// The DSH wire contract (store/spec/README.md § Wire): what dsh_list rows say, and what dsh_install and
// dsh_remove accept from a payload and answer.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { invalidateInstalledDsh, type InstalledDsh } from './installed.js'
import { HARNESS_MONOREPO, resetBundledDshRegistry, type DshRegistryEntry } from './registry.js'
import { dshInstallReply, dshInstallRequest, dshInstallStatus, dshListRows, dshRemoveId, dshRemoveReply } from './wire.js'

const installed = (manifest: InstalledDsh['manifest'], linked = false): InstalledDsh => ({
  id: manifest.id, dir: `/Users/example/.harness/dsh/${manifest.id}`, realDir: `/Users/example/.harness/dsh/${manifest.id}`,
  source: 'https://example.com/x.git', ref: null, commit: null, linked, installedAt: 0, manifest,
})

describe('dshListRows', () => {
  const registry: DshRegistryEntry[] = [
    {
      id: 'autonomous/typst', name: 'Typst', category: 'Documents', author: 'Autonomous', description: 'Typeset.', engine: 'claude',
      repo: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/typst', tier: 2, verified: true, viewerUse: 'autonomous/doc-viewer',
      homepage: 'https://typst.example.com', upstream: 'https://example.com/typst', license: 'MIT', tagline: 'Typesetting for the rest of us', screenshots: ['https://example.com/1.png'],
      examples: [{ prompt: 'A spec sheet for an M3 standoff.', image: 'https://example.com/spec.jpg', caption: 'Spec sheet · PDF' }],
    },
    { id: 'autonomous/doc-viewer', kind: 'viewer', name: 'Doc Viewer', repo: HARNESS_MONOREPO, ref: 'main', path: 'store/viewers/doc-viewer', tier: 2, verified: true },
    { id: 'acme/bare', name: 'Bare', repo: 'https://example.com/bare.git', engine: 'codex' },
  ]

  it('an installed harness is its manifest\'s words plus the registry\'s facts, listed once, before what is only offered', () => {
    const rows = dshListRows([
      installed({ spec: 1, id: 'autonomous/typst', name: 'Typst (local)', engine: 'claude', viewer: { use: 'autonomous/doc-viewer' } }, true),
      installed({ spec: 1, id: 'acme/private', kind: 'viewer', name: 'Private', verdict: '.harness/verdict.json', viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } }),
    ], registry)
    expect(rows).toEqual([
      {
        id: 'autonomous/typst', kind: 'agent', name: 'Typst (local)', description: null, category: null, author: null, engine: 'claude',
        installedCommit: null, availableCommit: null, updateAvailable: false,
        installed: true, linked: true, viewer: true, viewerUse: 'autonomous/doc-viewer', tier: 2,
        verified: true, repo: `${HARNESS_MONOREPO}/tree/main/store/agents/typst`, homepage: 'https://typst.example.com',
        upstream: 'https://example.com/typst', license: 'MIT', tagline: 'Typesetting for the rest of us', screenshots: ['https://example.com/1.png'],
        examples: [{ prompt: 'A spec sheet for an M3 standoff.', image: 'https://example.com/spec.jpg', caption: 'Spec sheet · PDF' }],
      },
      {
        id: 'acme/private', kind: 'viewer', name: 'Private', description: null, category: null, author: null, engine: null,
        installedCommit: null, availableCommit: null, updateAvailable: false,
        installed: true, linked: false, viewer: true, viewerUse: null, tier: 2,
        verified: false, repo: null, homepage: null, upstream: null, license: null, tagline: null, screenshots: [], examples: [],
      },
      {
        id: 'autonomous/doc-viewer', kind: 'viewer', name: 'Doc Viewer', description: null, category: null, author: null, engine: null,
        installed: false, linked: false, viewer: true, viewerUse: null, tier: 2,
        verified: true, repo: `${HARNESS_MONOREPO}/tree/main/store/viewers/doc-viewer`, homepage: null, upstream: null, license: null, tagline: null, screenshots: [], examples: [],
      },
      {
        id: 'acme/bare', kind: 'agent', name: 'Bare', description: null, category: null, author: null, engine: 'codex',
        installed: false, linked: false, viewer: false, viewerUse: null, tier: 0,
        verified: false, repo: 'https://example.com/bare.git', homepage: null, upstream: null, license: null, tagline: null, screenshots: [], examples: [],
      },
    ])
  })

  it('an installed harness keeps its own description, category and author; an offered one keeps the registry\'s', () => {
    const [local, offered] = dshListRows([
      installed({ spec: 1, id: 'acme/local', name: 'Local', description: 'Mine.', category: 'Tools', author: 'Example', engine: 'codex', verdict: '.harness/verdict.json' }),
    ], registry.slice(0, 1))
    expect(local).toMatchObject({ description: 'Mine.', category: 'Tools', author: 'Example', viewer: false, tier: 1 })
    expect(offered).toMatchObject({ description: 'Typeset.', category: 'Documents', author: 'Autonomous', viewerUse: 'autonomous/doc-viewer' })
  })

  it('reads this machine\'s index and the bundled registry when given nothing', () => {
    const saved = env.DSH_DIR
    env.DSH_DIR = mkdtempSync(join(tmpdir(), 'dsh-wire-'))
    vi.stubGlobal('__DSH_REGISTRY__', JSON.stringify([{ id: 'acme/bare', name: 'Bare', repo: 'https://example.com/bare.git', engine: 'codex' }]))
    resetBundledDshRegistry()
    invalidateInstalledDsh()
    try {
      expect(dshListRows().map((row) => [row.id, row.installed])).toEqual([['acme/bare', false]])
    } finally {
      rmSync(env.DSH_DIR, { recursive: true, force: true })
      env.DSH_DIR = saved
      vi.unstubAllGlobals()
      resetBundledDshRegistry()
      invalidateInstalledDsh()
    }
  })
})

describe('dsh_remove', () => {
  it('takes only an owner/name id', () => {
    expect(dshRemoveId({ id: 'autonomous/marp' })).toBe('autonomous/marp')
    for (const id of ['../../etc', 'Autonomous/Marp', 'marp', 7, undefined]) expect(dshRemoveId({ id }), String(id)).toBeUndefined()
  })

  it('answers ok with the id, or the error and its detail', () => {
    expect(dshRemoveReply('autonomous/marp', { ok: true })).toEqual({ ok: true, id: 'autonomous/marp' })
    expect(dshRemoveReply('autonomous/marp', { ok: false, error: 'NOT_INSTALLED', detail: 'autonomous/marp is not installed' }))
      .toEqual({ error: 'NOT_INSTALLED', detail: 'autonomous/marp is not installed' })
  })
})

describe('dsh_install', () => {
  it('keeps a well-formed id, url and ref, and drops each field that is not', () => {
    expect(dshInstallRequest({ id: 'autonomous/typst', ref: 'store-e2e' })).toEqual({ id: 'autonomous/typst', url: undefined, ref: 'store-e2e' })
    expect(dshInstallRequest({ url: 'https://example.com/thing.git', ref: 'x'.repeat(201) })).toEqual({ id: undefined, url: 'https://example.com/thing.git', ref: undefined })
    expect(dshInstallRequest({ id: 'not an id', url: 'https://example.com/thing.git' })).toEqual({ id: undefined, url: 'https://example.com/thing.git', ref: undefined })
    expect(dshInstallRequest({ id: 'autonomous/typst', url: 'https://example.com/\n', ref: 3 })).toEqual({ id: 'autonomous/typst', url: undefined, ref: undefined })
  })

  it('is nothing without a usable id or url', () => {
    for (const payload of [{}, { id: '../x' }, { url: '' }, { url: `https://example.com/${'x'.repeat(2048)}` }, { url: 'https://example.com/' }, { ref: 'main' }]) {
      expect(dshInstallRequest(payload), JSON.stringify(payload).slice(0, 60)).toBeNull()
    }
  })

  it('pushes status under the manifest\'s id once known, else the id asked for, else null', () => {
    expect(dshInstallStatus({ id: 'autonomous/typst', phase: 'setup', detail: 'toolchain/setup.sh' }, { url: 'https://example.com/x.git' }))
      .toEqual({ id: 'autonomous/typst', phase: 'setup', detail: 'toolchain/setup.sh' })
    expect(dshInstallStatus({ id: null, phase: 'clone', line: 'Receiving objects: 40%' }, { id: 'autonomous/typst' }))
      .toEqual({ id: 'autonomous/typst', phase: 'clone', line: 'Receiving objects: 40%' })
    expect(dshInstallStatus({ id: null, phase: 'clone' }, { url: 'https://example.com/x.git' })).toEqual({ id: null, phase: 'clone' })
  })

  it('answers ok with the installed id, or the error and its detail', () => {
    expect(dshInstallReply({ ok: true, id: 'autonomous/typst' })).toEqual({ ok: true, id: 'autonomous/typst' })
    expect(dshInstallReply({ ok: false, error: 'DOCTOR_FAILED', detail: 'doctor failed · miss typst' })).toEqual({ error: 'DOCTOR_FAILED', detail: 'doctor failed · miss typst' })
  })
})
