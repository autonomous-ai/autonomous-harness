/**
 * On-disk daemon state that BOTH the daemon (`cli.ts`) and short-lived CLI commands need to read —
 * the pid file, the saved credential, and the fixed loopback control port.
 *
 * Kept in its own module so management commands can inspect daemon state without importing `cli.ts`,
 * which would execute the command dispatcher.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'
import { hasAuthSession } from './authSession.js'

export const PID_FILE = join(env.ADAPTER_DATA_DIR, 'adapter.pid')

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

/** Whether a durable SSO session exists for this computer. */
export function hasSavedAuthSession(): boolean { return hasAuthSession() }

/** Is the background daemon process alive right now? (pid file present AND that pid still exists) */
export function isDaemonRunning(): boolean {
  const pid = readPid()
  return pid !== null && isAlive(pid)
}
