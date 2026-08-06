/**
 * On-disk daemon state that BOTH the daemon (`cli.ts`) and short-lived CLI commands need to read —
 * the pid file, the saved credential, and the fixed loopback control port.
 *
 * Kept in its own module so `launch.ts` (the `harness <engine>` wrapper) can check "is the daemon
 * joined and running?" without importing `cli.ts`, which would be circular (cli.ts dispatches into
 * launch.ts).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'

export const TOKEN_FILE = join(env.ADAPTER_DATA_DIR, 'token')
export const PID_FILE = join(env.ADAPTER_DATA_DIR, 'adapter.pid')

// The saved credential IS the agent apiKey — 32 random bytes as hex (64 chars).
const TOKEN_RE = /^[0-9a-f]{64}$/i

/** The daemon's localhost control port — FIXED at env.PORT (no fallback), so pair/status/stop always
 *  reach it and a leftover is findable with `lsof :<PORT>`. */
export function daemonPort(): number {
  return env.PORT
}

export function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch { return null }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Has this computer ever joined? (env override, else a well-formed token file.) Deliberately returns a
 *  boolean, not the token — callers here only need to pick the right "how to fix it" message. */
export function hasSavedToken(): boolean {
  const fromEnv = env.ADAPTER_TOKEN
  if (fromEnv && TOKEN_RE.test(fromEnv.trim())) return true
  if (!existsSync(TOKEN_FILE)) return false
  try { return TOKEN_RE.test(readFileSync(TOKEN_FILE, 'utf-8').trim()) } catch { return false }
}

/** Is the background daemon process alive right now? (pid file present AND that pid still exists) */
export function isDaemonRunning(): boolean {
  const pid = readPid()
  return pid !== null && isAlive(pid)
}
