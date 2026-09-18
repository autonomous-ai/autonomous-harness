/** Version facts only: reading the Store never fetches or executes package code. */
import type { InstalledDshRecord } from './installed.js'
import type { DshRegistryEntry } from './registry.js'

export const GIT_REVISION_RE = /^[a-f0-9]{40}$/i

export function samePackageSource(installed: InstalledDshRecord, entry: DshRegistryEntry): boolean {
  const normalize = (source: string): string => source.replace(/\/$/, '').replace(/\.git$/, '')
  return normalize(installed.source) === normalize(entry.repo) && (installed.path ?? '') === (entry.path ?? '')
}

export function dshUpdateInfo(installed: InstalledDshRecord, entry?: DshRegistryEntry): {
  installedCommit: string | null; availableCommit: string | null; updateAvailable: boolean
} {
  const availableCommit = entry && samePackageSource(installed, entry) && entry.ref && GIT_REVISION_RE.test(entry.ref)
    ? entry.ref : null
  const changed = installed.revision && entry?.revision
    ? installed.revision !== entry.revision
    : installed.commit !== availableCommit
  return { installedCommit: installed.commit, availableCommit,
    updateAvailable: !installed.linked && availableCommit !== null && changed }
}
