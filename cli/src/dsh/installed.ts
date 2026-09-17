/**
 * What is installed on THIS machine: `~/.harness/dsh/installed.json` plus one directory (or, for a
 * `--link` install, one symlink) per DSH under `~/.harness/dsh/<owner>/<name>`.
 *
 * The index is the source of truth for "installed"; a directory without an index row is ignored,
 * and a row whose manifest no longer parses is reported broken rather than silently dropped, so a
 * DSH that breaks on update is visible in `harness dsh list` instead of vanishing from the picker.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { DSH_ID_RE, readDshManifest, type DshManifest } from './manifest.js'

export interface InstalledDshRecord {
  id: string
  /** `<root>/<owner>/<name>`, whether a clone or a symlink. */
  dir: string
  /** The git URL or local path it came from. */
  source: string
  ref: string | null
  /** The folder of `source` that was installed, for a package that is one folder of a repo. */
  path?: string | null
  commit: string | null
  /** True when `dir` is a symlink to a checkout — the development loop. */
  linked: boolean
  installedAt: number
}

export interface InstalledDsh extends InstalledDshRecord {
  manifest: DshManifest
  /** `dir` with symlinks resolved — where the files really are. */
  realDir: string
}

export interface BrokenDsh extends InstalledDshRecord {
  error: string
}

const INDEX_FILE = 'installed.json'

export function dshRootDir(): string {
  return env.DSH_DIR
}

export function dshInstallDir(id: string): string {
  return join(dshRootDir(), ...id.split('/'))
}

function indexPath(): string {
  return join(dshRootDir(), INDEX_FILE)
}

function validRecord(value: unknown): value is InstalledDshRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<InstalledDshRecord>
  return typeof row.id === 'string' && DSH_ID_RE.test(row.id)
    && typeof row.dir === 'string' && row.dir.length > 0
    && typeof row.source === 'string'
    && (row.ref === null || typeof row.ref === 'string')
    && (row.commit === null || typeof row.commit === 'string')
    && typeof row.linked === 'boolean'
    && typeof row.installedAt === 'number'
}

export function readInstalledIndex(): InstalledDshRecord[] {
  let text: string
  try {
    text = readFileSync(indexPath(), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter(validRecord) : []
  } catch {
    return []
  }
}

export function writeInstalledIndex(records: readonly InstalledDshRecord[]): void {
  mkdirSync(dshRootDir(), { recursive: true, mode: 0o700 })
  writeFileSync(indexPath(), JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
}

export function upsertInstalledRecord(record: InstalledDshRecord): void {
  const others = readInstalledIndex().filter((row) => row.id !== record.id)
  writeInstalledIndex([...others, record].sort((a, b) => a.id.localeCompare(b.id)))
  invalidateInstalledDsh()
}

export function removeInstalledRecord(id: string): boolean {
  const before = readInstalledIndex()
  const after = before.filter((row) => row.id !== id)
  if (after.length === before.length) return false
  writeInstalledIndex(after)
  invalidateInstalledDsh()
  return true
}

/** Load one record's manifest, or say why it is broken. */
export function resolveInstalled(record: InstalledDshRecord): InstalledDsh | BrokenDsh {
  if (!existsSync(record.dir)) return { ...record, error: `${record.dir} is missing` }
  let realDir: string
  try {
    realDir = realpathSync(record.dir)
  } catch (error) {
    return { ...record, error: `${record.dir} cannot be resolved (${error instanceof Error ? error.message : String(error)})` }
  }
  const manifest = readDshManifest(realDir)
  if (!manifest.ok) return { ...record, error: manifest.error }
  if (manifest.manifest.id !== record.id) {
    return { ...record, error: `manifest id ${manifest.manifest.id} does not match the installed id ${record.id}` }
  }
  return { ...record, manifest: manifest.manifest, realDir }
}

export function isBrokenDsh(value: InstalledDsh | BrokenDsh): value is BrokenDsh {
  return 'error' in value
}

// The daemon asks "is this agent's DSH installed" on every frame it projects, which is every
// announce of every agent. A short cache keeps that off the disk; installs and removals clear it.
const CACHE_TTL_MS = 2_000
let cache: { at: number; installed: InstalledDsh[]; broken: BrokenDsh[] } | null = null

function stateNow(): { installed: InstalledDsh[]; broken: BrokenDsh[] } {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache
  const installed: InstalledDsh[] = []
  const broken: BrokenDsh[] = []
  for (const entry of readInstalledIndex().map(resolveInstalled)) {
    if (isBrokenDsh(entry)) broken.push(entry)
    else installed.push(entry)
  }
  cache = { at: Date.now(), installed, broken }
  return cache
}

/** Forget the cached index — after an install, a removal, or in a spec that rewrites the directory. */
export function invalidateInstalledDsh(): void {
  cache = null
}

/** Every installed DSH whose manifest loads. Broken ones are returned separately by `listDshState`. */
export function listInstalledDsh(): InstalledDsh[] {
  return stateNow().installed
}

export function listDshState(): { installed: InstalledDsh[]; broken: BrokenDsh[] } {
  return stateNow()
}

/**
 * The installed harness for an id — by its own id first, then by a name it went by before
 * (`formerly` in the manifest): an agent created under the old name keeps its harness, its viewer
 * and its verdict across a rename instead of falling back to a plain engine.
 */
export function installedDsh(id: string): InstalledDsh | undefined {
  const { installed } = stateNow()
  return installed.find((entry) => entry.id === id)
    ?? installed.find((entry) => entry.manifest.formerly?.includes(id))
}
