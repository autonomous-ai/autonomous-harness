// The registry readers on fixture trees: the runtime's (registry.ts) and the build's
// (scripts/lib/dshRegistry.mjs), held to the same answer; the baked-in registry the release reads; and
// the store ref a branch under test moves the built-in shelf to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { env } from '../config/env.js'
import {
  bundledDshRegistry, HARNESS_MONOREPO, readRegistryDir, readStoreDir, registryEntry, registrySourceUrl,
  resetBundledDshRegistry, storeEntry, StoreEvaluationSchema, StoreExampleSchema, StoreFactsSchema,
} from './registry.js'

// @ts-expect-error — plain ESM with no declaration file, imported to hold the build to the runtime
const build = await import('../../scripts/lib/dshRegistry.mjs') as {
  storeEntry: typeof storeEntry
  readDshRegistry: (storeDir: string | URL) => unknown[]
}

const write = (path: string, body: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

describe('StoreExampleSchema: what a product page example may hold', () => {
  it('takes a prompt, an https picture and a caption; a catalog entry drops unknown fields, store.json refuses them', () => {
    expect(StoreExampleSchema.parse({ prompt: '  A desk lamp.  ', image: 'https://example.com/a.jpg', caption: 'Lamp', later: 1 }))
      .toEqual({ prompt: 'A desk lamp.', image: 'https://example.com/a.jpg', caption: 'Lamp' })
    expect(StoreExampleSchema.safeParse({ prompt: 'x', image: 'http://example.com/a.jpg' }).success).toBe(false)
    expect(StoreExampleSchema.safeParse({ prompt: '   ' }).success).toBe(false)
    expect(StoreExampleSchema.safeParse({ prompt: 'x'.repeat(601) }).success).toBe(false)
    expect(StoreFactsSchema.safeParse({ examples: [{ prompt: 'x', later: 1 }] }).success).toBe(false)
    expect(StoreFactsSchema.safeParse({ examples: Array.from({ length: 9 }, () => ({ prompt: 'x' })) }).success).toBe(false)
    expect(StoreFactsSchema.parse({ examples: [{ prompt: 'x' }] })).toEqual({ examples: [{ prompt: 'x' }] })
  })

  it('a tagline is one short line', () => {
    expect(StoreFactsSchema.parse({ tagline: 'Advanced physics simulation' })).toEqual({ tagline: 'Advanced physics simulation' })
    expect(StoreFactsSchema.safeParse({ tagline: '' }).success).toBe(false)
    expect(StoreFactsSchema.safeParse({ tagline: 'x'.repeat(81) }).success).toBe(false)
  })
})

describe('StoreEvaluationSchema: how a product page says a harness is judged', () => {
  it('takes a known method and what judges it; a catalog entry drops unknown fields, store.json refuses them', () => {
    expect(StoreEvaluationSchema.parse({ method: 'tool', by: '  KiCad DRC ', later: 1 })).toEqual({ method: 'tool', by: 'KiCad DRC' })
    expect(StoreEvaluationSchema.parse({ method: 'none' })).toEqual({ method: 'none' })
    expect(StoreEvaluationSchema.safeParse({ method: 'vibes' }).success).toBe(false)
    expect(StoreEvaluationSchema.safeParse({ method: 'review', by: 'x'.repeat(81) }).success).toBe(false)
    expect(StoreFactsSchema.safeParse({ evaluation: [{ method: 'tool', gate: true }] }).success).toBe(false)
    expect(StoreFactsSchema.safeParse({ evaluation: Array.from({ length: 5 }, () => ({ method: 'checks' })) }).success).toBe(false)
    expect(StoreFactsSchema.parse({ evaluation: [{ method: 'review', by: 'rubric' }] })).toEqual({ evaluation: [{ method: 'review', by: 'rubric' }] })
  })
})

describe('storeEntry', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['a bare agent: tier 0, only what the manifest says', { spec: 1, id: 'autonomous/bare', name: 'Bare', engine: 'claude' }, {}],
    ['a verdict: tier 1', { spec: 1, id: 'autonomous/checked', name: 'Checked', engine: 'codex', verdict: '.harness/verdict.json' }, {}],
    ['a used viewer: tier 2 and its dependency', { spec: 1, id: 'autonomous/cad', name: 'CAD', category: 'CAD', author: 'Autonomous', description: 'd', engine: 'claude', viewer: { use: 'autonomous/cad-viewer' } }, { homepage: 'https://example.com', license: 'MIT' }],
    ['a viewer package: its kind and no engine', { spec: 1, kind: 'viewer', id: 'autonomous/pane', name: 'Pane', viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } }, { upstream: 'https://example.com/up', screenshots: ['https://example.com/1.png'] }],
    ['tagline: carried as written', { spec: 1, id: 'autonomous/sim', name: 'Sim', engine: 'claude' }, { tagline: 'Advanced physics simulation' }],
    ['examples: carried as written', { spec: 1, id: 'autonomous/lamp', name: 'Lamp', engine: 'claude', viewer: { use: 'autonomous/model-viewer' } }, { examples: [{ prompt: 'A desk lamp.', image: 'https://example.com/lamp.jpg', caption: 'Lamp · glTF' }], evaluation: [{ method: 'tool', by: 'glTF validator' }] }],
  ]
  for (const [what, manifest, facts] of cases) {
    it(`${what}, the same from the build`, () => {
      const entry = storeEntry('store/agents/x', manifest, facts)
      expect(build.storeEntry('store/agents/x', manifest, facts)).toEqual(entry)
      expect(entry).toMatchObject({ id: manifest.id, repo: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/x', verified: true })
    })
  }

  it('says exactly what each case ships', () => {
    const [bare, checked, cad, pane, sim, lamp] = cases.map(([, manifest, facts]) => storeEntry('p', manifest, facts))
    expect(sim.tagline).toBe('Advanced physics simulation')
    expect(lamp.examples).toEqual([{ prompt: 'A desk lamp.', image: 'https://example.com/lamp.jpg', caption: 'Lamp · glTF' }])
    expect(lamp.evaluation).toEqual([{ method: 'tool', by: 'glTF validator' }])
    expect(bare).toEqual({ id: 'autonomous/bare', name: 'Bare', repo: HARNESS_MONOREPO, ref: 'main', path: 'p', engine: 'claude', tier: 0, verified: true })
    expect(checked.tier).toBe(1)
    expect(cad).toMatchObject({ category: 'CAD', author: 'Autonomous', description: 'd', homepage: 'https://example.com', license: 'MIT', viewerUse: 'autonomous/cad-viewer', tier: 2 })
    expect(pane).toMatchObject({ kind: 'viewer', upstream: 'https://example.com/up', screenshots: ['https://example.com/1.png'], tier: 2 })
    expect(pane).not.toHaveProperty('engine')
    expect(pane).not.toHaveProperty('viewerUse')
  })
})

describe('reading a store tree', () => {
  let store: string
  beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'dsh-store-')) })
  afterEach(() => rmSync(store, { recursive: true, force: true }))

  const fixture = (): void => {
    write(join(store, 'agents', 'typst', 'harness.json'), JSON.stringify({ spec: 1, id: 'autonomous/typst', name: 'Typst', engine: 'claude' }))
    write(join(store, 'agents', 'typst', 'store.json'), JSON.stringify({ license: 'MIT' }))
    write(join(store, 'agents', 'no-facts', 'harness.json'), JSON.stringify({ spec: 1, id: 'autonomous/no-facts', name: 'No facts', engine: 'codex' }))
    write(join(store, 'agents', 'bad-facts', 'harness.json'), JSON.stringify({ spec: 1, id: 'autonomous/bad-facts', name: 'Bad facts', engine: 'codex' }))
    write(join(store, 'agents', 'bad-facts', 'store.json'), '{nope')
    write(join(store, 'agents', 'no-manifest', 'README.md'), '# not a package\n')
    write(join(store, 'agents', 'bad-manifest', 'harness.json'), '{nope')
    // no viewers/ folder at all
    write(join(store, 'registry', 'README.md'), '# entries for packages elsewhere\n')
    write(join(store, 'registry', 'acme', 'thing.json'), JSON.stringify({ id: 'acme/thing', name: 'Thing', repo: 'https://example.com/thing.git', engine: 'claude' }))
    write(join(store, 'registry', 'acme', 'notes.txt'), 'not an entry')
    symlinkSync(join(store, 'nowhere'), join(store, 'registry', 'dangling'))
  }

  it('turns each package folder into its entry, skipping folders with no readable manifest', () => {
    fixture()
    const entries = readStoreDir(store) as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.id)).toEqual(['autonomous/bad-facts', 'autonomous/no-facts', 'autonomous/typst'])
    expect(entries.find((entry) => entry.id === 'autonomous/typst')).toMatchObject({ license: 'MIT', path: 'store/agents/typst' })
    expect(entries.find((entry) => entry.id === 'autonomous/bad-facts')).not.toHaveProperty('license')
    expect(readStoreDir(join(store, 'missing'))).toEqual([])
  })

  it('reads the outside entries, skipping stray files, links to nothing and malformed JSON', () => {
    fixture()
    write(join(store, 'registry', 'acme', 'broken.json'), '{nope')
    expect(readRegistryDir(join(store, 'registry'))).toEqual([{ id: 'acme/thing', name: 'Thing', repo: 'https://example.com/thing.git', engine: 'claude' }])
    expect(readRegistryDir(join(store, 'missing'))).toEqual([])
  })

  it('the build reads the same tree to the same answer, from a path or a file URL', () => {
    fixture()
    const runtime = [...readStoreDir(store), ...readRegistryDir(join(store, 'registry'))]
    expect(build.readDshRegistry(store)).toEqual(runtime)
    expect(build.readDshRegistry(pathToFileURL(store))).toEqual(runtime)
    expect(build.readDshRegistry(join(store, 'missing'))).toEqual([])
  })

  it('the build refuses a malformed outside entry the runtime skips, naming the file', () => {
    fixture()
    write(join(store, 'registry', 'acme', 'broken.json'), '{nope')
    expect(() => build.readDshRegistry(store)).toThrow(/registry[/\\]acme[/\\]broken\.json/)
  })
})

describe('bundledDshRegistry, as baked into a release', () => {
  const savedRef = env.HARNESS_STORE_REF
  afterEach(() => {
    vi.unstubAllGlobals()
    env.HARNESS_STORE_REF = savedRef
    resetBundledDshRegistry()
  })

  const bake = (entries: unknown[]): void => {
    vi.stubGlobal('__DSH_REGISTRY__', JSON.stringify(entries))
    resetBundledDshRegistry()
  }

  it('keeps valid entries once each, first one wins, sorted by id, and caches the answer', () => {
    env.HARNESS_STORE_REF = undefined
    bake([
      { id: 'zeta/one', name: 'Zeta', repo: 'https://example.com/zeta', engine: 'codex' },
      { id: 'alpha/one', name: 'Alpha', repo: 'https://example.com/alpha', engine: 'claude' },
      { id: 'alpha/one', name: 'Impostor', repo: 'https://example.com/impostor', engine: 'claude' },
      { id: 'no/engine', name: 'Agent without an engine', repo: 'https://example.com/x' },
      { id: 'Bad Id', name: 'Bad', repo: 'https://example.com/x', engine: 'claude' },
      { id: 'pane/viewer', kind: 'viewer', name: 'Pane', repo: 'https://example.com/pane' },
    ])
    const first = bundledDshRegistry()
    expect(first.map((entry) => `${entry.id} ${entry.name}`)).toEqual(['alpha/one Alpha', 'pane/viewer Pane', 'zeta/one Zeta'])
    expect(bundledDshRegistry()).toBe(first)
    expect(registryEntry('zeta/one')?.repo).toBe('https://example.com/zeta')
    expect(registryEntry('nobody/here')).toBeUndefined()
  })

  it('a malformed bake is an empty registry, not a crash', () => {
    vi.stubGlobal('__DSH_REGISTRY__', '{not json')
    resetBundledDshRegistry()
    expect(bundledDshRegistry()).toEqual([])
    expect(bundledDshRegistry()).toEqual([])
  })

  it('HARNESS_STORE_REF moves only the built-in folders of this repository to the branch under test', () => {
    env.HARNESS_STORE_REF = 'store-e2e'
    bake([
      { id: 'autonomous/typst', name: 'Typst', repo: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/typst', engine: 'claude' },
      { id: 'autonomous/dotgit', name: 'Dot git', repo: `${HARNESS_MONOREPO}.git`, ref: 'main', path: 'store/agents/dotgit', engine: 'claude' },
      { id: 'autonomous/whole', name: 'Whole repo', repo: HARNESS_MONOREPO, ref: 'main', engine: 'claude' },
      { id: 'acme/folder', name: 'Elsewhere', repo: 'https://example.com/acme', ref: 'v1', path: 'pkg', engine: 'claude' },
    ])
    expect(Object.fromEntries(bundledDshRegistry().map((entry) => [entry.id, entry.ref]))).toEqual({
      'autonomous/typst': 'store-e2e',
      'autonomous/dotgit': 'store-e2e',
      'autonomous/whole': 'main',
      'acme/folder': 'v1',
    })
  })
})

describe('registrySourceUrl', () => {
  it('links a folder of a GitHub repo to its tree page, and anything else to the repo', () => {
    expect(registrySourceUrl({ repo: 'https://github.com/acme/mono.git/', path: 'pkgs/a' })).toBe('https://github.com/acme/mono/tree/main/pkgs/a')
    expect(registrySourceUrl({ repo: 'https://github.com/acme/mono', ref: 'v2', path: 'pkgs/a' })).toBe('https://github.com/acme/mono/tree/v2/pkgs/a')
    expect(registrySourceUrl({ repo: 'https://gitlab.example.com/acme/mono', ref: 'v2', path: 'pkgs/a' })).toBe('https://gitlab.example.com/acme/mono')
    expect(registrySourceUrl({ repo: 'https://github.com/acme/mono' })).toBe('https://github.com/acme/mono')
  })
})
