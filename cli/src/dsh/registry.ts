/**
 * The bundled registry, baked into the CLI at build time the same way the version is
 * (`__DSH_REGISTRY__`, an esbuild `define` in both `build.mjs` and `build-bundle.mjs`). Two sources
 * at the repo root: every built-in package folder, `store/<agents|viewers>/<name>` — its entry built
 * from its `harness.json` and `store.json`, so no fact is written twice — and
 * `store/registry/<owner>/<name>.json` for packages that live in repositories of their own. Under
 * `tsx`/vitest there is no define, so both are read off the source tree — the dev loop sees the same
 * entries the release does.
 *
 * A registry entry is how the desktop can offer "Install Typst" for a package this machine does not
 * have yet: it names the repo and the ref to clone, and — for the built-in shelf, which lives in this
 * monorepo under `store/` — the folder inside that repo that IS the package. Nothing here runs code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { env } from '../config/env.js'
import { ENGINES } from '../engines/types.js'
import { DSH_ID_RE } from './manifest.js'

declare const __DSH_REGISTRY__: string | undefined

/** The repo the built-in shelf lives in; its packages are `store/<agents|viewers>/<name>` folders. */
export const HARNESS_MONOREPO = 'https://github.com/autonomous-ai/autonomous-harness'

/** A folder inside a repo: relative, forward slashes, no `.`/`..` segments, no trailing slash. */
export const PACKAGE_PATH_RE = /^(?!\/)(?!.*\/$)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._\-/]+$/

export const DshRegistryEntrySchema = z.strictObject({
  id: z.string().regex(DSH_ID_RE),
  /** `agent` (default) is a tile; `viewer` is a pane other packages use — listed, installable, never a tile. */
  kind: z.enum(['agent', 'viewer']).optional(),
  name: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
  category: z.string().min(1).max(24).optional(),
  author: z.string().min(1).max(80).optional(),
  repo: z.string().min(1).max(2048),
  ref: z.string().min(1).max(200).optional(),
  /**
   * The folder inside `repo` that is the package, when the package is not the whole repo — every
   * built-in package lives at `store/agents/<name>` or `store/viewers/<name>` of the Harness monorepo.
   * Installed by a sparse clone of that folder alone.
   */
  path: z.string().min(1).max(512).regex(PACKAGE_PATH_RE, 'path must be a relative folder inside the repo').optional(),
  engine: z.enum(ENGINES).optional(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  /** Shared viewer dependency, so the Store can show reverse dependencies before installation. */
  viewerUse: z.string().regex(DSH_ID_RE).optional(),
  verified: z.boolean().optional(),
  /** The store's product page: where the thing lives, whose it is, what it is licensed under. */
  homepage: z.string().url().max(2048).optional(),
  /** The upstream project a wrapper brings into Harness (its repo), when the package is a wrapper. */
  upstream: z.string().url().max(2048).optional(),
  /** SPDX id of the wrapper's licence — "MIT", "Apache-2.0"; the upstream's is in its repo. */
  license: z.string().min(1).max(40).optional(),
  /** Pictures for the product page, in order; absent while a package has none yet. */
  screenshots: z.array(z.string().url().max(2048)).max(8).optional(),
}).refine((entry) => entry.kind === 'viewer' || entry.engine !== undefined, { path: ['engine'], message: 'an agent entry needs an engine' })

export type DshRegistryEntry = z.infer<typeof DshRegistryEntrySchema>

/** What a built-in package's `store.json` holds: the store page's facts a manifest does not know. */
export const StoreFactsSchema = z.strictObject({
  homepage: z.string().url().max(2048).optional(),
  upstream: z.string().url().max(2048).optional(),
  license: z.string().min(1).max(40).optional(),
  screenshots: z.array(z.string().url().max(2048)).max(8).optional(),
})

export type StoreFacts = z.infer<typeof StoreFactsSchema>

/** The shelf's two folders and the kind each holds. */
export const STORE_KINDS = [['agents', 'agent'], ['viewers', 'viewer']] as const

/**
 * One built-in package folder as its registry entry: the words from the manifest, the facts from
 * `store.json`, the source this repository at `main` and that folder, the tier from what the manifest
 * ships, and `verified` because every built-in is first-party. Mirrored, line for line, by
 * `storeEntry` in `scripts/lib/dshRegistry.mjs` (the build cannot import TypeScript); a spec holds
 * the two to the same answer on the real tree.
 */
export function storeEntry(path: string, manifest: Record<string, unknown>, facts: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: manifest.id }
  if (manifest.kind !== undefined) entry.kind = manifest.kind
  for (const key of ['name', 'category', 'author', 'description']) if (manifest[key] !== undefined) entry[key] = manifest[key]
  Object.assign(entry, { repo: HARNESS_MONOREPO, ref: 'main', path })
  for (const key of ['homepage', 'upstream', 'license', 'screenshots']) if (facts[key] !== undefined) entry[key] = facts[key]
  if (manifest.engine !== undefined) entry.engine = manifest.engine
  const viewer = manifest.viewer as { use?: unknown } | undefined
  if (typeof viewer?.use === 'string') entry.viewerUse = viewer.use
  entry.tier = manifest.viewer ? 2 : manifest.verdict ? 1 : 0
  entry.verified = true
  return entry
}

/** Every `store/<agents|viewers>/<name>` folder with a manifest, as registry entries. */
export function readStoreDir(storeDir: string): unknown[] {
  const out: unknown[] = []
  for (const [plural] of STORE_KINDS) {
    let names: string[]
    try { names = readdirSync(join(storeDir, plural)).sort() } catch { continue }
    for (const name of names) {
      const dir = join(storeDir, plural, name)
      let manifest: Record<string, unknown>
      try { manifest = JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')) as Record<string, unknown> } catch { continue }
      let facts: Record<string, unknown> = {}
      try { facts = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as Record<string, unknown> } catch { facts = {} }
      out.push(storeEntry(`store/${plural}/${name}`, manifest, facts))
    }
  }
  return out
}

function parseEntries(values: unknown[], storeRef = env.HARNESS_STORE_REF): DshRegistryEntry[] {
  const entries: DshRegistryEntry[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const parsed = DshRegistryEntrySchema.safeParse(value)
    if (!parsed.success) continue
    // The built-in folder is read first, so an outside entry claiming the same id never replaces it.
    if (seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    // A store branch under test: the built-in packages install from it, everything else as listed.
    const builtIn = storeRef && parsed.data.path && parsed.data.repo.replace(/\.git$/, '') === HARNESS_MONOREPO
    entries.push(builtIn ? { ...parsed.data, ref: storeRef } : parsed.data)
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/** Read `store/registry/<owner>/<name>.json` from a checkout: the packages that live elsewhere. */
export function readRegistryDir(dir: string): unknown[] {
  const out: unknown[] = []
  let owners: string[]
  try {
    owners = readdirSync(dir)
  } catch {
    return out
  }
  for (const owner of owners) {
    const ownerDir = join(dir, owner)
    let files: string[]
    try {
      if (!statSync(ownerDir).isDirectory()) continue
      files = readdirSync(ownerDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        out.push(JSON.parse(readFileSync(join(ownerDir, file), 'utf8')))
      } catch {
        // A malformed entry is a registry bug, not a runtime one; the conformance check catches it.
      }
    }
  }
  return out
}

let cached: DshRegistryEntry[] | null = null

export function bundledDshRegistry(): DshRegistryEntry[] {
  if (cached) return cached
  if (typeof __DSH_REGISTRY__ !== 'undefined') {
    try {
      cached = parseEntries(JSON.parse(__DSH_REGISTRY__) as unknown[])
      return cached
    } catch {
      cached = []
      return cached
    }
  }
  // src/dsh/registry.ts → ../../../store (the same relative walk from dist/dsh/registry.js).
  const store = fileURLToPath(new URL('../../../store', import.meta.url))
  cached = parseEntries([...readStoreDir(store), ...readRegistryDir(join(store, 'registry'))])
  return cached
}

/**
 * Where a person can READ a package: the repo itself, or — for a package that is a folder of a
 * GitHub repo — that folder's page at the entry's ref. The store's "Package source" link.
 */
export function registrySourceUrl(entry: Pick<DshRegistryEntry, 'repo' | 'ref' | 'path'>): string {
  if (!entry.path) return entry.repo
  const github = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/.exec(entry.repo)
  if (!github) return entry.repo
  const repo = entry.repo.replace(/\/$/, '').replace(/\.git$/, '')
  return `${repo}/tree/${entry.ref ?? 'main'}/${entry.path}`
}

export function registryEntry(id: string): DshRegistryEntry | undefined {
  return bundledDshRegistry().find((entry) => entry.id === id)
}

/** Test seam. */
export function resetBundledDshRegistry(): void {
  cached = null
}
