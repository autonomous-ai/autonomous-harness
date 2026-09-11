/**
 * `harness stop`'s core, shared by `stop`, `reset`, `logout`, `update` and `flash`.
 *
 * Takes the spawn lock first, so a stop can never land in the middle of an update handoff — the one
 * window where "the daemon" is two processes and killing the pid on file leaves the other one
 * running. It waits its turn, but not forever: stop is the escape hatch for everything else here, so
 * a holder that has been busy for longer than the wait is reported and then overridden.
 */

import { rmSync } from 'fs'
import { PID_FILE, isAlive, readPid } from './daemonState.js'
import { acquireSpawnLock, describeSpawnLockFailure, describeSpawnLockOwner, SPAWN_LOCK_WAIT_MS } from './daemonSpawnLock.js'

export interface StopDeps {
  readPid: () => number | null
  isAlive: (pid: number) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Acquire the spawn lock; resolves to a release. Injected so the stop sequence is testable alone. */
  lock: () => Promise<() => void>
  warn: (message: string) => void
}

export function defaultStopDeps(): StopDeps {
  return {
    readPid,
    isAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    lock: async () => {
      try {
        return await acquireSpawnLock('stop', {
          waitMs: SPAWN_LOCK_WAIT_MS,
          onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
        })
      } catch (error) {
        // ANY failure to take the lock — a holder that outlived the wait, a directory that is not a
        // lock at all — ends the same way: stop proceeds. It is the escape hatch for everything else
        // here, and an escape hatch that can be locked is not one.
        console.warn(`  ! the daemon spawn lock is ${describeSpawnLockFailure(error)} — stopping anyway`)
        return () => {}
      }
    },
    warn: (m) => console.warn(m),
  }
}

export const STOP_GRACE_MS = 3_000

/** SIGTERM the daemon named by the pid file, SIGKILL if it lingers. Returns what was stopped. */
export async function stopDaemonProcess(deps: StopDeps = defaultStopDeps()): Promise<{ pid: number | null; stopped: boolean }> {
  const release = await deps.lock()
  try {
    const pid = deps.readPid()
    if (!pid || !deps.isAlive(pid)) {
      // A pid file naming nothing is debris from a crash; nobody else can be relying on it.
      try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
      return { pid: null, stopped: false }
    }
    try { deps.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = deps.now() + STOP_GRACE_MS
    while (deps.now() < deadline && deps.isAlive(pid)) await deps.sleep(150)
    if (deps.isAlive(pid)) { try { deps.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    // Only if it is still OUR daemon's file: a SIGTERM'd daemon removes its own pid on the way out
    // (shutdown), and a daemon that came up meanwhile — impossible under the lock, but cheap to
    // respect — must not lose its record to us.
    if (deps.readPid() === pid) { try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ } }
    return { pid, stopped: true }
  } finally {
    release()
  }
}
