// The registry the build bakes in as `__DSH_REGISTRY__`: every built-in package folder under
// `store/<agents|viewers>/<name>` as its entry, then `store/registry/<owner>/<name>.json` for packages
// that live elsewhere. Mirrors `storeEntry`, `readStoreDir` and `readRegistryDir` in
// src/dsh/registry.ts (the runtime dev fallback), kept in plain ESM so both build scripts can import
// it without a TypeScript step; src/dsh/store.spec.ts holds the two to the same answer.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const HARNESS_MONOREPO = 'https://github.com/autonomous-ai/autonomous-harness'

export function storeEntry(path, manifest, facts) {
  const entry = { id: manifest.id }
  if (manifest.kind !== undefined) entry.kind = manifest.kind
  for (const key of ['name', 'category', 'author', 'description']) if (manifest[key] !== undefined) entry[key] = manifest[key]
  Object.assign(entry, { repo: HARNESS_MONOREPO, ref: 'main', path })
  for (const key of ['homepage', 'upstream', 'license', 'screenshots']) if (facts[key] !== undefined) entry[key] = facts[key]
  if (manifest.engine !== undefined) entry.engine = manifest.engine
  entry.tier = manifest.viewer ? 2 : manifest.verdict ? 1 : 0
  entry.verified = true
  return entry
}

function readStoreDir(storeDir) {
  const out = []
  for (const plural of ['agents', 'viewers']) {
    let names
    try { names = readdirSync(join(storeDir, plural)).sort() } catch { continue }
    for (const name of names) {
      const dir = join(storeDir, plural, name)
      let manifest
      try { manifest = JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')) } catch { continue }
      let facts = {}
      try { facts = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) } catch { facts = {} }
      out.push(storeEntry(`store/${plural}/${name}`, manifest, facts))
    }
  }
  return out
}

function readRegistryDir(root) {
  const out = []
  let owners
  try { owners = readdirSync(root) } catch { return out }
  for (const owner of owners) {
    const ownerDir = join(root, owner)
    let files
    try {
      if (!statSync(ownerDir).isDirectory()) continue
      files = readdirSync(ownerDir)
    } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      out.push(JSON.parse(readFileSync(join(ownerDir, file), 'utf8')))
    }
  }
  return out
}

/** `storeDir` is the repo's `store/` folder, as a path or a file URL. */
export function readDshRegistry(storeDir) {
  const root = storeDir instanceof URL ? fileURLToPath(storeDir) : storeDir
  return [...readStoreDir(root), ...readRegistryDir(join(root, 'registry'))]
}
