import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { dshRootDir, invalidateInstalledDsh, readInstalledIndex, resolveInstalled, isBrokenDsh, type InstalledDsh } from './installed.js'
import { catalogEntry, refreshDshRegistry } from './catalog.js'
import { cloneInstall, finishInstall, type DshInstallOptions, type DshInstallResult } from './install.js'
import { lockDsh, dshBusy } from './lock.js'
import { samePackageSource } from './updates.js'

export interface DshUpdateOptions {
  id: string
  registry?: DshInstallOptions['registry']
  onProgress?: DshInstallOptions['onProgress']
  onLine?: DshInstallOptions['onLine']
  setupTimeoutMs?: number
}

/** Replace only the package, retaining the old files and index until the new doctor passes. */
export async function updateDsh(opts: DshUpdateOptions): Promise<DshInstallResult> {
  const result = await updatePackage(opts)
  opts.onProgress?.({ id: opts.id, phase: result.ok ? 'done' : 'failed', ...(!result.ok ? { detail: result.detail } : {}) })
  return result
}

async function updatePackage(opts: DshUpdateOptions): Promise<DshInstallResult> {
  const record = readInstalledIndex().find(row => row.id === opts.id)
  if (!record) return { ok: false, error: 'NOT_INSTALLED', detail: `${opts.id} is not installed` }
  if (record.linked) return { ok: false, error: 'LINKED_INSTALL', detail: `${opts.id} is linked to a checkout. Update that checkout directly.` }
  const unlock = lockDsh(opts.id)
  if (!unlock) return dshBusy(opts.id)
  let staged: string | null = null
  let backup: string | null = null
  let placed = false
  let committed = false
  try {
    if (!opts.registry) await refreshDshRegistry(true)
    const catalog = (opts.registry ?? catalogEntry)(opts.id)
    // A catalog entry with the same id cannot redirect someone's private fork or another folder.
    const entry = catalog && samePackageSource(record, catalog) ? catalog : undefined
    const ref = entry?.ref ?? record.ref ?? undefined
    const path = record.path ?? undefined
    opts.onProgress?.({ id: opts.id, phase: 'clone', detail: `fetching ${record.source}` })
    const cloned = await cloneInstall(record.source, ref, path, opts.onLine)
    if (!cloned.ok) return cloned
    staged = cloned.tmpDir
    if (cloned.manifest.id !== record.id) {
      return { ok: false, error: 'PACKAGE_ID_MISMATCH', detail: `Expected ${record.id}, but the update declares ${cloned.manifest.id}` }
    }
    const previous = resolveInstalled(record)
    if (!isBrokenDsh(previous)) {
      if ((previous.manifest.kind ?? 'agent') !== (cloned.manifest.kind ?? 'agent')) {
        return { ok: false, error: 'PACKAGE_KIND_MISMATCH', detail: `The update changes ${record.id} from an agent to a viewer or vice versa` }
      }
      if ((record.revision && record.revision === cloned.revision) || (record.commit && record.commit === cloned.commit)) {
        opts.onLine?.(`${record.id} is already up to date`)
        return { ok: true, installed: previous, doctor: { ok: true, lines: [] }, setupLines: [] }
      }
    }
    if (existsSync(record.dir)) {
      // Do not follow a checkout link even if an older/corrupt record calls it a clone.
      if (lstatSync(record.dir).isSymbolicLink()) return { ok: false, error: 'LINKED_INSTALL', detail: `${record.id} is linked to a checkout. Update that checkout directly.` }
      backup = join(dshRootDir(), `.previous-${randomUUID()}`)
      renameSync(record.dir, backup)
    }
    mkdirSync(dirname(record.dir), { recursive: true, mode: 0o700 })
    renameSync(staged, record.dir)
    placed = true
    const installed: InstalledDsh = { ...record, ref: ref ?? null, commit: cloned.commit, revision: cloned.revision,
      updatedAt: Date.now(), manifest: cloned.manifest, realDir: realpathSync(record.dir) }
    const result = await finishInstall(installed, {
      ...opts, source: record.source,
      onProgress: p => { if (p.phase !== 'done' && p.phase !== 'failed') opts.onProgress?.(p) },
    }, false)
    committed = result.ok
    return result
  } catch (error) {
    return { ok: false, error: 'UPDATE_FAILED', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      if (!committed) {
        if (placed) rmSync(record.dir, { recursive: true, force: true })
        if (backup) renameSync(backup, record.dir)
      } else if (backup) {
        // Cleanup cannot turn a successfully committed update into a reported failure.
        try { rmSync(backup, { recursive: true, force: true }) } catch { opts.onLine?.(`Previous package retained at ${backup}`) }
      }
      if (staged) rmSync(staged, { recursive: true, force: true })
    } finally {
      invalidateInstalledDsh()
      unlock()
    }
  }
}
