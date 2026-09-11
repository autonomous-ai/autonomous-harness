/**
 * "Is the process that wrote this lock still the process that wrote it?" — shared by every on-disk
 * lock the CLI keeps (registry.json.lock, adapter.spawn.lock).
 *
 * A bare pid is not enough: pids are recycled, so a crashed owner's pid can belong to an unrelated
 * process by the time anyone checks. The start marker pins the process GENERATION — Linux exposes it
 * in /proc/<pid>/stat (field 22, starttime in clock ticks); elsewhere `ps -o lstart` gives it to the
 * second, which is coarse but has never collided in practice. A marker that cannot be read at all
 * degrades to "alive if the pid exists", which is what Windows gets.
 */

import { readFileSync } from 'fs'
import { execFileSync } from 'node:child_process'

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function processStartMarker(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (fields[19]) return `linux:${fields[19]}`
  } catch { /* non-Linux or exited process; use ps below */ }
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1_000,
    }).trim()
    return started ? `ps:${started}` : null
  } catch { return null }
}

export function lockOwnerAlive(pid: number, startMarker: string): boolean {
  if (!processExists(pid)) return false
  if (!startMarker) return true
  const current = processStartMarker(pid)
  return current === null || current === startMarker
}
