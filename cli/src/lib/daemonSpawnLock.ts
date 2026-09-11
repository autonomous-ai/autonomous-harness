/**
 * ONE process may spawn, hand off, or stop the daemon at a time.
 *
 * Three things used to do it with no coordination: `harness start` (the desktop app re-runs it every
 * few seconds whenever the daemon looks down), the daemon's own self-update handoff, and
 * `harness update`. The control port is fixed, so two spawners in the same second is a coin toss for
 * which child binds — and the loser, having already written its pid, either left `adapter.pid`
 * naming a corpse or deleted the file that named the winner. That is the orphan on :18473 that
 * `harness stop` cannot see and every later `harness start` trips over.
 *
 * Same shape as the registry lock (a directory created with mkdir + an `owner.json` written O_EXCL,
 * reclaimed only when the owning process is provably gone), with three differences it needs:
 *  - waiting is ASYNC — the daemon takes this lock on its own event loop during a handoff, and the
 *    registry's `Atomics.wait` would freeze it;
 *  - it is RE-ENTRANT within a process — `harness update` calls `launch()`, `harness start` stages
 *    the bundle and then calls `launch()`, and the updater's tick runs the whole handoff — each of
 *    those is one critical section, not two;
 *  - it is released on `process.exit`, because the CLI exits from a dozen places inside the section.
 *
 * There is deliberately NO age-based staleness. A holder is a holder for as long as its process is
 * alive — a handoff supervises the new build for up to a minute and a download on a slow link can
 * take longer — and the only thing an age bound would buy is letting a second spawner in while the
 * first is still working, which is the bug this exists to prevent. The escape hatch is
 * `harness stop`, which waits its turn and then proceeds regardless.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { env } from '../config/env.js'
import { lockOwnerAlive, processStartMarker } from './processLiveness.js'
import { secureStateDirectory } from './secureState.js'

export type SpawnLockPurpose = 'start' | 'update' | 'handoff' | 'stop'

export interface SpawnLockOwner {
  pid: number
  startMarker: string
  token: string
  purpose: SpawnLockPurpose
  since: number
}

export const SPAWN_LOCK_DIR = join(env.ADAPTER_DATA_DIR, 'adapter.spawn.lock')
const OWNER_FILE = 'owner.json'
const POLL_MS = 100
export const SPAWN_LOCK_WAIT_MS = 45_000
/** A directory with no owner.json is a crash between mkdir and the O_EXCL write — a window of
 *  microseconds. Anything older than this with no owner is debris, not a lock. */
const OWNERLESS_STALE_MS = 5_000

/**
 * The lock could not be taken. `owner` names a live holder when there is one; `reason` is set instead
 * when the lock cannot be taken for a reason waiting will not fix — something that is not a lock this
 * CLI made sits at the lock path — so the message can tell a human what to remove.
 */
export class SpawnLockBusyError extends Error {
  constructor(readonly owner: SpawnLockOwner | null, readonly reason?: string) {
    super(
      reason ?? (owner ? `daemon spawn lock is held (${describeSpawnLockOwner(owner)})` : 'daemon spawn lock is busy'),
    )
    this.name = 'SpawnLockBusyError'
  }
}

/** What to say about a failed acquire, for a command that has to explain itself and move on. */
export function describeSpawnLockFailure(error: unknown): string {
  if (error instanceof SpawnLockBusyError) {
    if (error.reason) return error.reason
    return error.owner ? `held — the daemon is ${describeSpawnLockOwner(error.owner)}` : 'held by an unknown process'
  }
  return `unusable (${error instanceof Error ? error.message : String(error)})`
}

export function describeSpawnLockOwner(owner: SpawnLockOwner): string {
  const verb: Record<SpawnLockPurpose, string> = {
    start: 'being started', update: 'being updated', handoff: 'restarting for an update', stop: 'being stopped',
  }
  const secs = Math.max(0, Math.round((Date.now() - owner.since) / 1000))
  return `${verb[owner.purpose]} by pid ${owner.pid} for ${secs}s`
}

let held: { token: string; purpose: SpawnLockPurpose; depth: number } | null = null
let exitHookInstalled = false

function ownerPath(): string { return join(SPAWN_LOCK_DIR, OWNER_FILE) }

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * Read the owner record, refusing anything an attacker could have planted (a symlink, another
 * account's directory, a loose mode). Returns null when there is no readable owner — which callers
 * must NOT take as "free": it is also what a lock mid-creation looks like.
 */
export function readSpawnLockOwner(): SpawnLockOwner | null {
  const me = uid()
  try {
    const dir = lstatSync(SPAWN_LOCK_DIR)
    if (!dir.isDirectory() || dir.isSymbolicLink() || (me !== null && dir.uid !== me) || (dir.mode & 0o777) !== 0o700) {
      throw new Error(`daemon spawn lock ${SPAWN_LOCK_DIR} has an unsafe owner, mode, or type`)
    }
    const file = lstatSync(ownerPath())
    if (!file.isFile() || file.isSymbolicLink() || (me !== null && file.uid !== me) || (file.mode & 0o777) !== 0o600) {
      throw new Error(`daemon spawn lock owner ${ownerPath()} has an unsafe owner, mode, or type`)
    }
    const raw = JSON.parse(readFileSync(ownerPath(), 'utf8')) as Partial<Record<keyof SpawnLockOwner, unknown>>
    const pid = Number(raw.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof raw.token !== 'string' || !raw.token) return null
    return {
      pid,
      startMarker: typeof raw.startMarker === 'string' ? raw.startMarker : '',
      token: raw.token,
      purpose: isPurpose(raw.purpose) ? raw.purpose : 'start',
      since: Number.isFinite(Number(raw.since)) ? Number(raw.since) : 0,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('daemon spawn lock')) throw error
    return null
  }
}

function isPurpose(value: unknown): value is SpawnLockPurpose {
  return value === 'start' || value === 'update' || value === 'handoff' || value === 'stop'
}

/** Create the lock for this process. Returns the token, or null when someone else holds it. */
function tryCreate(purpose: SpawnLockPurpose): string | null {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  const token = randomUUID()
  let created = false
  try {
    mkdirSync(SPAWN_LOCK_DIR, { mode: 0o700 })
    created = true
    const fd = openSync(ownerPath(), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const owner: SpawnLockOwner = {
        pid: process.pid, startMarker: processStartMarker(process.pid) ?? '', token, purpose, since: Date.now(),
      }
      writeFileSync(fd, JSON.stringify(owner))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    return token
  } catch (error) {
    if (created) releaseOwnedBy(token)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return null
  }
}

function releaseOwnedBy(token: string): void {
  try {
    const saved = JSON.parse(readFileSync(ownerPath(), 'utf8')) as { token?: unknown }
    if (saved.token === token) rmSync(SPAWN_LOCK_DIR, { recursive: true, force: true })
  } catch {
    // A directory we created but never got to write an owner into is ours to remove; anything else
    // belongs to someone.
    try {
      lstatSync(ownerPath())
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ENOENT') rmSync(SPAWN_LOCK_DIR, { recursive: true, force: true })
    }
  }
}

/** Remove a lock whose owner is gone — re-read first so a lock that changed hands meanwhile survives. */
function reclaimIfStale(owner: SpawnLockOwner): boolean {
  if (lockOwnerAlive(owner.pid, owner.startMarker)) return false
  try {
    const current = readSpawnLockOwner()
    if (current && current.pid === owner.pid && current.startMarker === owner.startMarker
      && current.token === owner.token && !lockOwnerAlive(owner.pid, owner.startMarker)) {
      rmSync(SPAWN_LOCK_DIR, { recursive: true, force: true })
      return true
    }
  } catch { /* changed or vanished under us; let the loop look again */ }
  return false
}

function reclaimIfOwnerless(): boolean {
  try {
    const dir = lstatSync(SPAWN_LOCK_DIR)
    try { lstatSync(ownerPath()); return false } catch { /* no owner file */ }
    if (Date.now() - dir.mtimeMs > OWNERLESS_STALE_MS) {
      rmSync(SPAWN_LOCK_DIR, { recursive: true, force: true })
      return true
    }
  } catch { /* gone already */ }
  return false
}

function releaseSync(): void {
  const mine = held
  held = null
  if (mine) releaseOwnedBy(mine.token)
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', releaseSync)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Take the lock, waiting up to `waitMs` for a live holder to finish. Resolves to the release
 * function. Re-entrant: a process that already holds it gets a nested handle immediately, and the
 * lock is dropped when the outermost handle releases.
 *
 * `onWaiting` fires once, the first time a live holder is seen, so a command can say who it is
 * waiting for rather than sitting silent for most of a minute.
 */
export async function acquireSpawnLock(
  purpose: SpawnLockPurpose,
  opts: { waitMs?: number; onWaiting?: (owner: SpawnLockOwner) => void } = {},
): Promise<() => void> {
  if (held) {
    held.depth += 1
    return release
  }
  const waitMs = opts.waitMs ?? SPAWN_LOCK_WAIT_MS
  const deadline = Date.now() + waitMs
  let announced = false
  for (;;) {
    const token = tryCreate(purpose)
    if (token) {
      held = { token, purpose, depth: 1 }
      installExitHook()
      return release
    }
    let owner: SpawnLockOwner | null
    try {
      owner = readSpawnLockOwner()
    } catch (error) {
      // A symlink, another account's directory, a plain file where the directory should be: not a
      // lock this CLI made, and not one waiting will ever turn into one. Say what is there, now —
      // 45 seconds of silence before the same answer helps nobody.
      throw new SpawnLockBusyError(
        null,
        `not a lock this CLI made: ${SPAWN_LOCK_DIR} — remove it by hand (${error instanceof Error ? error.message : error})`,
      )
    }
    if (owner ? reclaimIfStale(owner) : reclaimIfOwnerless()) continue
    if (owner && !announced) {
      announced = true
      opts.onWaiting?.(owner)
    }
    if (Date.now() >= deadline) throw new SpawnLockBusyError(owner)
    await sleep(POLL_MS)
  }
}

function release(): void {
  if (!held) return
  held.depth -= 1
  if (held.depth > 0) return
  releaseSync()
}

export async function withSpawnLock<T>(
  purpose: SpawnLockPurpose,
  fn: () => Promise<T>,
  opts: { waitMs?: number; onWaiting?: (owner: SpawnLockOwner) => void } = {},
): Promise<T> {
  const done = await acquireSpawnLock(purpose, opts)
  try {
    return await fn()
  } finally {
    done()
  }
}
