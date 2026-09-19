/**
 * The DSH requests on the wire — `dsh_list`, `dsh_install`, `dsh_remove` — as backendSocket.ts answers
 * them on the machine they are asked of: what each reads off a payload and what each replies. The
 * socket only sends what these return; the contract is store/spec/README.md § Wire.
 */
import type { DshInstallProgress } from './install.js'
import { listInstalledDsh, type InstalledDsh } from './installed.js'
import { DSH_ID_RE, dshTier, viewerUse } from './manifest.js'
import { registrySourceUrl, type DshRegistryEntry } from './registry.js'
import { currentDshRegistry } from './catalog.js'
import { dshUpdateInfo } from './updates.js'

/**
 * `dsh_list`: the harnesses installed on this machine, then what the registry offers that is not.
 * The store's facts (repo, homepage, upstream, licence, pictures) come from the registry whether or not
 * the package is installed: a manifest does not carry them.
 */
export function dshListRows(
  installed: readonly InstalledDsh[] = listInstalledDsh(),
  registry: readonly DshRegistryEntry[] = currentDshRegistry(),
): Record<string, unknown>[] {
  const byId = new Map(registry.map(entry => [entry.id, entry]))
  const facts = (id: string): Record<string, unknown> => {
    const known = byId.get(id)
    return {
      verified: known?.verified === true,
      // Where a person can read the package: its folder page for a built-in (store/…) one.
      repo: known ? registrySourceUrl(known) : null,
      homepage: known?.homepage ?? null,
      upstream: known?.upstream ?? null,
      license: known?.license ?? null,
      tagline: known?.tagline ?? null,
      screenshots: known?.screenshots ?? [],
      examples: known?.examples ?? [],
      evaluation: known?.evaluation ?? [],
    }
  }
  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []
  for (const entry of installed) {
    seen.add(entry.id)
    rows.push({
      id: entry.id,
      kind: entry.manifest.kind ?? 'agent',
      name: entry.manifest.name,
      description: entry.manifest.description ?? null,
      category: entry.manifest.category ?? null,
      author: entry.manifest.author ?? null,
      engine: entry.manifest.engine ?? null,
      installed: true,
      linked: entry.linked === true,
      viewer: !!entry.manifest.viewer,
      viewerUse: viewerUse(entry.manifest),
      tier: dshTier(entry.manifest),
      ...facts(entry.id),
      ...dshUpdateInfo(entry, byId.get(entry.id)),
    })
  }
  for (const entry of registry) {
    if (seen.has(entry.id)) continue
    rows.push({
      id: entry.id,
      kind: entry.kind ?? 'agent',
      name: entry.name,
      description: entry.description ?? null,
      category: entry.category ?? null,
      author: entry.author ?? null,
      engine: entry.engine ?? null,
      installed: false,
      linked: false,
      viewer: (entry.tier ?? 0) >= 2,
      viewerUse: entry.viewerUse ?? null,
      tier: entry.tier ?? 0,
      ...facts(entry.id),
    })
  }
  return rows
}

/** `dsh_remove { id }`: the id, when it is one. */
export function dshRemoveId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.id === 'string' && DSH_ID_RE.test(payload.id) ? payload.id : undefined
}

export type DshWireResult = { ok: true } | { ok: false; error: string; detail: string }

export function dshRemoveReply(id: string, result: DshWireResult): Record<string, unknown> {
  return result.ok ? { ok: true, id } : { error: result.error, detail: result.detail }
}

export interface DshInstallRequest { id?: string; url?: string; ref?: string }

/**
 * `dsh_install { id?, url?, ref? }`: what is usable of each field — an id that is one, a URL of bounded
 * length with no control characters, a ref of bounded length — or null when neither an id nor a URL is.
 */
export function dshInstallRequest(payload: Record<string, unknown>): DshInstallRequest | null {
  const id = typeof payload.id === 'string' && DSH_ID_RE.test(payload.id) ? payload.id : undefined
  const url = typeof payload.url === 'string' && payload.url.length <= 2048 && !/[\x00-\x1f\x7f]/.test(payload.url) ? payload.url : undefined
  const ref = typeof payload.ref === 'string' && payload.ref.length <= 200 ? payload.ref : undefined
  if (!id && !url) return null
  return { id, url, ref }
}

/** A `dsh_install_status` push: the phase, under the id asked for until the manifest names one. */
export function dshInstallStatus(progress: DshInstallProgress, request: DshInstallRequest): Record<string, unknown> {
  return { ...progress, id: progress.id ?? request.id ?? null }
}

export function dshInstallReply(result: { ok: true; id: string } | { ok: false; error: string; detail: string }): Record<string, unknown> {
  return result.ok ? { ok: true, id: result.id } : { error: result.error, detail: result.detail }
}
