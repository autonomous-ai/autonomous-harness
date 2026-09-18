/** A package mutation may also come from a standalone CLI while the daemon is installing it. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshRootDir } from './installed.js'
import { DSH_ID_RE } from './manifest.js'

export function lockDsh(id: string): (() => void) | null {
  if (!DSH_ID_RE.test(id)) return null
  const root = dshRootDir()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, `.lock-${id.replace('/', '_')}`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Only one contender may reap a dead owner. Re-read under this guard so a second
      // contender never removes the live lock the first one just acquired.
      const reaper = `${path}.reap`
      try { mkdirSync(reaper, { mode: 0o700 }) } catch { return null }
      try {
        const pid = Number(readFileSync(join(path, 'pid'), 'utf8'))
        if (!Number.isSafeInteger(pid) || pid <= 0) return null
        try { process.kill(pid, 0); return null } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') return null
        }
        rmSync(path, { recursive: true, force: true })
        continue
      } catch { return null } finally { rmSync(reaper, { recursive: true, force: true }) }
    }
    try { writeFileSync(join(path, 'pid'), String(process.pid), { mode: 0o600 }) } catch (error) {
      rmSync(path, { recursive: true, force: true })
      throw error
    }
    return () => rmSync(path, { recursive: true, force: true })
  }
  return null
}

export function dshBusy(id: string): { ok: false; error: string; detail: string } {
  return { ok: false, error: 'DSH_BUSY', detail: `${id} is already being installed, updated or removed. Try again when it finishes.` }
}
