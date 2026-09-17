/**
 * The bundled registry: `dsh/registry/<owner>/<name>.json` at the repo root, baked into the CLI at
 * build time the same way the version is (`__DSH_REGISTRY__`, an esbuild `define` in both
 * `build.mjs` and `build-bundle.mjs`). Under `tsx`/vitest there is no define, so the files are read
 * off the source tree — the dev loop sees the same entries the release does.
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

function parseEntries(values: unknown[], storeRef = env.HARNESS_STORE_REF): DshRegistryEntry[] {
  const entries: DshRegistryEntry[] = []
  for (const value of values) {
    const parsed = DshRegistryEntrySchema.safeParse(value)
    if (!parsed.success) continue
    // A store branch under test: the built-in packages install from it, everything else as listed.
    const builtIn = storeRef && parsed.data.path && parsed.data.repo.replace(/\.git$/, '') === HARNESS_MONOREPO
    entries.push(builtIn ? { ...parsed.data, ref: storeRef } : parsed.data)
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/** Read `dsh/registry/**\/*.json` from a checkout; used by the build and by the dev fallback. */
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
  // src/dsh/registry.ts → ../../../dsh/registry (the same relative walk from dist/dsh/registry.js).
  const dir = fileURLToPath(new URL('../../../dsh/registry', import.meta.url))
  cached = parseEntries(readRegistryDir(dir))
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
