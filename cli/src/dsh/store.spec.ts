// The Harness Store's built-in shelf, `store/<agents|viewers>/<name>` at the repo root. Each folder is
// its own registry entry — words from `harness.json`, facts from `store.json` — so this holds the
// folders to the rules `store/README.md` writes down, and the build's copy of the entry logic to the
// runtime's.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDsh } from './check.js'
import { dshTier, readDshManifest } from './manifest.js'
import {
  bundledDshRegistry, HARNESS_MONOREPO, readRegistryDir, readStoreDir, registrySourceUrl,
  resetBundledDshRegistry, STORE_KINDS, StoreFactsSchema,
} from './registry.js'
import { resolveInstallSource } from './install.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const STORE = join(ROOT, 'store')

function storeFolders(): { folder: string; kind: 'agent' | 'viewer'; name: string; dir: string }[] {
  const out: { folder: string; kind: 'agent' | 'viewer'; name: string; dir: string }[] = []
  for (const [plural, kind] of STORE_KINDS) {
    const base = join(STORE, plural)
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name)
      if (statSync(dir).isDirectory()) out.push({ folder: `store/${plural}/${name}`, kind, name, dir })
    }
  }
  return out
}

describe('the built-in shelf (store/)', () => {
  resetBundledDshRegistry()
  const registry = bundledDshRegistry()
  const folders = storeFolders()

  it('has agents and viewers, and every folder is in the registry exactly once', () => {
    expect(folders.filter((f) => f.kind === 'agent').length).toBeGreaterThan(0)
    expect(folders.filter((f) => f.kind === 'viewer').length).toBeGreaterThan(0)
    const ids = registry.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { name } of folders) expect(ids, name).toContain(`autonomous/${name}`)
  })

  for (const { folder, kind, name, dir } of folders) {
    describe(folder, () => {
      const read = readDshManifest(dir)

      it('has a manifest whose kind is the folder it sits in and whose id is autonomous/<folder name>', () => {
        expect(read.ok, read.ok ? '' : read.error).toBe(true)
        if (!read.ok) return
        expect(read.manifest.kind ?? 'agent').toBe(kind)
        expect(read.manifest.id).toBe(`autonomous/${name}`)
      })

      it('has a store.json with only the store page\'s facts', () => {
        const file = join(dir, 'store.json')
        expect(existsSync(file), 'store.json').toBe(true)
        const facts = StoreFactsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
        expect(facts.success, facts.success ? '' : JSON.stringify(facts.error.issues)).toBe(true)
      })

      it('passes `harness dsh check`', () => {
        const result = checkDsh(dir)
        expect(result.lines.filter((line) => line.level === 'fail').map((line) => line.what)).toEqual([])
      })

      it('carries a licence and a README with its credit', () => {
        expect(existsSync(join(dir, 'LICENSE')), 'LICENSE').toBe(true)
        expect(readFileSync(join(dir, 'README.md'), 'utf8')).toMatch(/Credit and stewardship/)
      })

      it('is listed from this folder, saying what the manifest says', () => {
        if (!read.ok) return
        const entry = registry.find((row) => row.id === read.manifest.id)!
        const m = read.manifest
        expect(entry).toMatchObject({ repo: HARNESS_MONOREPO, ref: 'main', path: folder, verified: true, tier: dshTier(m) })
        expect(entry.viewerUse).toBe(m.viewer && 'use' in m.viewer ? m.viewer.use : undefined)
        expect({ kind: entry.kind ?? 'agent', name: entry.name, category: entry.category, author: entry.author, description: entry.description, engine: entry.engine })
          .toEqual({ kind: m.kind ?? 'agent', name: m.name, category: m.category, author: m.author, description: m.description, engine: m.engine })
      })
    })
  }

  it('the build bakes in exactly what the runtime reads', async () => {
    // @ts-expect-error — plain ESM with no declaration file, imported for this comparison only
    const { readDshRegistry } = await import('../../scripts/lib/dshRegistry.mjs')
    const runtime = [...readStoreDir(STORE), ...readRegistryDir(join(STORE, 'registry'))]
    expect(readDshRegistry(STORE)).toEqual(runtime)
  })

  it('an outside entry never names a built-in id', () => {
    const outside = readRegistryDir(join(STORE, 'registry')) as { id?: string }[]
    const builtIn = new Set(folders.map((f) => `autonomous/${f.name}`))
    expect(outside.filter((entry) => entry.id && builtIn.has(entry.id))).toEqual([])
  })

  it('installs a built-in package by id from its folder, and links to that folder', () => {
    expect(resolveInstallSource('autonomous/typst')).toEqual({ source: HARNESS_MONOREPO, ref: 'main', path: 'store/agents/typst', id: 'autonomous/typst' })
    const typst = registry.find((row) => row.id === 'autonomous/typst')!
    expect(registrySourceUrl(typst)).toBe(`${HARNESS_MONOREPO}/tree/main/store/agents/typst`)
    expect(registrySourceUrl({ repo: 'https://example.com/x.git' })).toBe('https://example.com/x.git')
  })

  it('a store branch under test moves the built-in shelf to it, and nothing else', async () => {
    const { env } = await import('../config/env.js')
    const saved = env.HARNESS_STORE_REF
    try {
      env.HARNESS_STORE_REF = 'viewer-packages'
      resetBundledDshRegistry()
      expect(bundledDshRegistry().filter((row) => row.path).every((row) => row.ref === 'viewer-packages')).toBe(true)
    } finally {
      env.HARNESS_STORE_REF = saved
      resetBundledDshRegistry()
    }
  })
})
