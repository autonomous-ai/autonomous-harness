/** Live Store metadata. Fetching a catalog never installs or executes a package. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { ENGINES } from '../engines/types.js'
import { bundledDshRegistry, DshRegistryEntrySchema, HARNESS_MONOREPO, type DshRegistryEntry } from './registry.js'

export const STORE_CATALOG_URL = 'https://raw.githubusercontent.com/autonomous-ai/openharness/store-catalog/catalog.json'
export const CATALOG_REFRESH_MS = 5 * 60_000
const RETRY_MS = 30_000
const MAX_BYTES = 16 * 1024 * 1024

export interface StoreCatalog { spec: 1; entries: DshRegistryEntry[] }

/** Ignore future optional fields/engines, but never cache a damaged or ambiguous catalog. */
export function parseStoreCatalog(value: unknown): StoreCatalog {
  if (!value || typeof value !== 'object') throw new Error('Invalid Store catalog')
  const catalog = value as Record<string, unknown>
  if (catalog.spec !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > 25_000) throw new Error('Unsupported Store catalog')
  const entries: DshRegistryEntry[] = []
  const seen = new Set<string>()
  for (const raw of catalog.entries) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid catalog entry')
    const item = raw as Record<string, unknown>
    if (item.kind !== undefined && item.kind !== 'agent' && item.kind !== 'viewer') continue
    if (item.kind !== 'viewer' && typeof item.engine === 'string' && !(ENGINES as readonly string[]).includes(item.engine)) continue
    const parsed = DshRegistryEntrySchema.strip().parse(item)
    const url = new URL(parsed.repo)
    if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20\x7f]/.test(parsed.repo)) throw new Error('Catalog sources must be public HTTPS repositories')
    if (seen.has(parsed.id)) throw new Error(`Duplicate catalog id: ${parsed.id}`)
    seen.add(parsed.id)
    // A community entry cannot grant itself first-party installation trust.
    const firstParty = parsed.repo.replace(/\.git$/, '') === HARNESS_MONOREPO
      && parsed.id.startsWith('autonomous/')
      && parsed.path === `store/${parsed.kind === 'viewer' ? 'viewers' : 'agents'}/${parsed.id.slice('autonomous/'.length)}`
    entries.push({ ...parsed, verified: firstParty && parsed.verified === true })
  }
  return { spec: 1, entries: entries.sort((a, b) => a.id.localeCompare(b.id)) }
}

/**
 * [document] is the catalog exactly as published, and it is what goes to disk: [catalog] is that
 * document parsed by THIS CLI, which drops every field it does not know. A cache of the parsed copy
 * outlived the CLI that wrote it — upgraded, the next one sent the saved ETag, heard 304 and kept a
 * catalog cut down to the old CLI's fields (no examples, then no taglines) until the Store next changed.
 */
interface Cache { url: string; checkedAt: number; etag?: string; catalog: StoreCatalog; document: unknown }
interface CatalogOptions {
  url: string
  cacheFile: string
  fallback: () => DshRegistryEntry[]
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** One request per refresh interval, shared by concurrent readers and persisted across restarts. */
export class LiveStoreCatalog {
  private cache: Cache | null = null
  private nextAttempt = 0
  private inFlight: Promise<DshRegistryEntry[]> | null = null
  private readonly now: () => number
  private readonly fetcher: typeof fetch

  constructor(private readonly options: CatalogOptions) {
    this.now = options.now ?? Date.now
    this.fetcher = options.fetch ?? fetch
    try {
      if (statSync(options.cacheFile).size > MAX_BYTES) return
      const saved = JSON.parse(readFileSync(options.cacheFile, 'utf8')) as Record<string, unknown>
      if (saved.url !== options.url || typeof saved.checkedAt !== 'number' || !Number.isFinite(saved.checkedAt)) return
      const catalog = parseStoreCatalog(saved.catalog)
      // A cache from before `whole` holds only what the CLI that wrote it knew. Serve it, but download
      // the whole document at the first refresh rather than revalidating a copy that is missing fields.
      const whole = saved.whole === true
      this.cache = { url: saved.url, checkedAt: Math.min(saved.checkedAt, this.now()), catalog, document: saved.catalog,
        ...(whole && typeof saved.etag === 'string' && saved.etag.length < 500 ? { etag: saved.etag } : {}) }
      this.nextAttempt = whole ? this.cache.checkedAt + CATALOG_REFRESH_MS : 0
    } catch { /* First launch, unreadable cache, or old format: use the bundled shelf. */ }
  }

  current(): DshRegistryEntry[] { return this.cache?.catalog.entries ?? this.options.fallback() }

  refresh(force = false): Promise<DshRegistryEntry[]> {
    if (this.inFlight) return this.inFlight
    if (!force && this.now() < this.nextAttempt) return Promise.resolve(this.current())
    this.inFlight = this.update().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async update(): Promise<DshRegistryEntry[]> {
    try {
      const response = await this.fetcher(this.options.url, {
        headers: { accept: 'application/json', ...(this.cache?.etag ? { 'if-none-match': this.cache.etag } : {}) },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 4_000),
        redirect: 'error',
      })
      // Only an answer to our own If-None-Match: a copy we did not ask about is never "not modified".
      if (response.status === 304 && this.cache?.etag) {
        this.cache = { ...this.cache, checkedAt: this.now() }
      } else {
        if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`)
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Catalog too large')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Empty catalog response')
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > MAX_BYTES) throw new Error('Catalog too large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        const document: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const catalog = parseStoreCatalog(document)
        const etag = response.headers.get('etag')
        this.cache = { url: this.options.url, checkedAt: this.now(), catalog, document, ...(etag && etag.length < 500 ? { etag } : {}) }
      }
      this.nextAttempt = this.now() + CATALOG_REFRESH_MS
      // A read-only disk must not discard metadata that was fetched successfully.
      try {
        mkdirSync(dirname(this.options.cacheFile), { recursive: true, mode: 0o700 })
        const temporary = `${this.options.cacheFile}.${randomUUID()}.tmp`
        const { url, checkedAt, etag, document } = this.cache
        // `catalog` keeps its name so an older CLI still reads this file (and parses it for itself).
        writeFileSync(temporary, JSON.stringify({ url, checkedAt, ...(etag ? { etag } : {}), whole: true, catalog: document }), { mode: 0o600 })
        renameSync(temporary, this.options.cacheFile)
      } catch { /* The in-memory catalog still works. */ }
    } catch {
      this.nextAttempt = this.now() + RETRY_MS
      // Offline, rate-limited, timed out, or invalid: keep the last complete catalog.
    }
    return this.current()
  }
}

let live: { key: string; catalog: LiveStoreCatalog } | null = null
function liveCatalog(): LiveStoreCatalog {
  const url = env.HARNESS_STORE_CATALOG_URL ?? STORE_CATALOG_URL
  const cacheFile = join(env.DSH_DIR, '.catalog', `${createHash('sha256').update(url).digest('hex').slice(0, 20)}.json`)
  const key = `${cacheFile}:${url}`
  if (live?.key !== key) live = { key, catalog: new LiveStoreCatalog({ url, cacheFile, fallback: bundledDshRegistry }) }
  return live.catalog
}

function withStoreRef(entries: DshRegistryEntry[]): DshRegistryEntry[] {
  const ref = env.HARNESS_STORE_REF
  return ref ? entries.map(entry => entry.path && entry.repo.replace(/\.git$/, '') === HARNESS_MONOREPO ? { ...entry, ref } : entry) : entries
}

export function currentDshRegistry(): DshRegistryEntry[] { return withStoreRef(liveCatalog().current()) }
export async function refreshDshRegistry(force = false): Promise<DshRegistryEntry[]> { return withStoreRef(await liveCatalog().refresh(force)) }
export function catalogEntry(id: string): DshRegistryEntry | undefined { return currentDshRegistry().find(entry => entry.id === id) }

/** Test seam: also resets the source/cache identity when a test changes DSH_DIR. */
export function resetLiveDshRegistry(): void { live = null }
