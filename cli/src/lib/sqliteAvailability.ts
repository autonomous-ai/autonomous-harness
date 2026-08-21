/**
 * Is the `sqlite3` CLI present?
 *
 * Four engines keep their conversations in SQLite rather than in a transcript file and are read by
 * shelling out to `sqlite3` (`engines/{opencode,kilo,hermes,devin}/reader.ts`), as is one branch of
 * session repair. macOS ships `/usr/bin/sqlite3` in the base system, so this has never had to be
 * checked; a stock `ubuntu:24.04` does NOT ship it (measured), and neither does a slim Node image, so
 * on Linux those four engines silently mirror nothing until the user installs it.
 *
 * Resolved from PATH directly rather than by spawning: this runs on the startup path and the answer is
 * only used for one advisory log line.
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Engines that cannot be mirrored without the CLI. Keep in sync with the readers listed above. */
export const SQLITE_BACKED_ENGINES = ['opencode', 'kilo', 'hermes', 'devin'] as const

let cached: boolean | null = null

export function hasSqliteCli(): boolean {
  if (cached !== null) return cached
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  cached = (process.env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false
    return exts.some((ext) => {
      try { accessSync(join(dir, `sqlite3${ext}`), constants.X_OK); return true } catch { return false }
    })
  })
  return cached
}

/** One advisory line at startup. Says what is affected and exactly how to fix it — never throws. */
export function sqlitePreflightMessage(): string | null {
  if (hasSqliteCli()) return null
  const install = process.platform === 'linux'
    ? 'sudo apt install sqlite3   (or your distro\'s equivalent)'
    : 'install the sqlite3 CLI and make sure it is on PATH'
  return `[preflight] sqlite3 CLI not found on PATH — ${SQLITE_BACKED_ENGINES.join(', ')}`
    + ` agents cannot be mirrored. Every other engine is unaffected. Fix: ${install}`
}

/** Test seam: forget the cached answer. */
export function resetSqliteAvailabilityCache(): void { cached = null }
