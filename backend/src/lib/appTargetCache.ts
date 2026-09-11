import { env } from '../config/env.js'

/**
 * Per-process TTL + LRU cache: subdomain → owning machineId. The public app-proxy resolves the routing
 * target (the agent whose manager socket tunnels the request) on every request; the mapping is stable
 * so cache it and skip the 1-doc Mongo lookup for hot subdomains. TTL bounds staleness; an explicit
 * evict clears only the instance that handled a delete.
 *
 * Negative entries (machineId === null) are cached too, with a SHORTER TTL, so scans / misconfigured DNS
 * hitting nonexistent subdomains don't hit Mongo on every request (the positive TTL would be too long to
 * pin a not-yet-registered subdomain as missing).
 */

interface Entry {
  machineId: string | null // null = negative (known-missing)
  expiresAt: number
}

const MAX_ENTRIES = 50_000
const cache = new Map<string, Entry>()

/**
 * Tri-state lookup:
 *   string    → cached machineId (positive hit)
 *   null      → cached negative (known-missing → answer NO_APP without a DB read)
 *   undefined → not cached (caller must query the DB)
 */
export function getCachedAppAgent(subdomain: string): string | null | undefined {
  const e = cache.get(subdomain)
  if (!e) return undefined
  if (Date.now() > e.expiresAt) {
    cache.delete(subdomain)
    return undefined
  }
  cache.delete(subdomain)
  cache.set(subdomain, e)
  return e.machineId
}

/** Cache a resolved machineId (positive, long TTL) or a not-found result (negative, short TTL). */
export function setCachedAppAgent(subdomain: string, machineId: string | null): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(subdomain)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  const ttl = machineId === null ? env.AGENT_TARGET_NEG_CACHE_TTL_MS : env.AGENT_TARGET_CACHE_TTL_MS
  cache.set(subdomain, { machineId, expiresAt: Date.now() + ttl })
}

export function evictCachedAppTarget(subdomain: string): void {
  cache.delete(subdomain)
}
