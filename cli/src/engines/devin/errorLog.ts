/**
 * Devin turn-failure detection.
 *
 * Devin has no `StopFailure` counterpart to claude's: when a turn dies on a provider error it writes NO
 * assistant row and fires NO `Stop` hook, so both of the reader's turn-close signals are absent and the
 * web spins on the typing indicator forever. Observed live (session `tested-crabapple`): the user row
 * landed, `[turn] started` was logged, and nothing followed.
 *
 * Devin does record the failure in its own rotating log, one line, 0.7s after the turn began:
 *
 *   2026-07-28T06:38:22.096212Z  WARN chisel_core::translator: ACP: agent error (Internal):
 *   Permission denied: … We're currently facing high demand for this model. … (trace ID: acb60788…)
 *
 * That is a far better signal than scraping the TUI, and the session→log mapping is exact:
 * `session_locks/<id>.lock` holds the owning PID and the log is `logs/devin_<stamp>_<pid>.log`.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/** The ACP translator line Devin logs when a turn dies. WARN-level, but terminal for the turn. */
const AGENT_ERROR_RE = /\bACP: agent error(?:\s*\(([^)]*)\))?:\s*(.+)$/
/** Every log line starts with an RFC3339 UTC stamp: `2026-07-28T06:38:22.096212Z  WARN …`. */
const LEADING_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/
/** Look-back cap for `scanSince` — the failure we heal is always at the very tail of the log. */
const SCAN_BACK_BYTES = 256 * 1024

/** Resolve a session's current log file through its lock PID; null when either is missing. */
export function devinLogPathForSession(devinHome: string, sessionId: string): string | null {
  let pid: number
  try {
    pid = Number(readFileSync(join(devinHome, 'session_locks', `${sessionId}.lock`), 'utf8').trim())
  } catch { return null }
  if (!Number.isInteger(pid) || pid <= 0) return null

  const suffix = `_${pid}.log`
  let newest: { path: string; mtime: number } | null = null
  let entries: string[]
  try { entries = readdirSync(join(devinHome, 'logs')) } catch { return null }
  for (const name of entries) {
    if (!name.startsWith('devin_') || !name.endsWith(suffix)) continue
    const path = join(devinHome, 'logs', name)
    try {
      const mtime = statSync(path).mtimeMs
      if (!newest || mtime > newest.mtime) newest = { path, mtime }
    } catch { /* rotated away mid-scan */ }
  }
  return newest?.path ?? null
}

/** Strip Devin's doubled prefixes and the trace id so the web/device message stays readable. */
export function cleanDevinErrorMessage(raw: string): string {
  let text = raw.trim().replace(/\s*\(trace ID:\s*[0-9a-f]+\)\s*$/i, '')
  // "Permission denied: Permission denied: …" — the translator wraps the provider message verbatim.
  let previous = ''
  while (previous !== text) {
    previous = text
    text = text.replace(/^([^:]{3,40}):\s*\1:\s*/, '$1: ')
  }
  return text.trim()
}

/**
 * Byte-offset tail over one session's Devin log, yielding only agent-error messages.
 * Starts at EOF so a failure logged before the watcher attached never fires retroactively.
 */
export class DevinErrorTail {
  private path: string | null = null
  private offset = 0

  constructor(private readonly devinHome: string, private readonly sessionId: string) {}

  /** Bind to the current log file and skip everything already written. */
  seekToEnd(): void {
    this.path = devinLogPathForSession(this.devinHome, this.sessionId)
    if (!this.path) return
    try { this.offset = statSync(this.path).size } catch { this.offset = 0 }
  }

  /**
   * Agent errors logged AFTER `isoTimestamp`, regardless of the tail offset. Used once at attach to heal a
   * turn that died before the daemon started: its failure sits behind `seekToEnd`, so `poll()` never sees
   * it and the web would stay on the typing indicator across a restart.
   */
  scanSince(isoTimestamp: string): string[] {
    if (!this.path) this.path = devinLogPathForSession(this.devinHome, this.sessionId)
    if (!this.path) return []
    const since = Date.parse(isoTimestamp)
    if (!Number.isFinite(since)) return []

    let text: string
    try {
      const buffer = readFileSync(this.path)
      // Bounded look-back: a long-lived session's log can be large and only the tail can be relevant.
      text = buffer.subarray(Math.max(0, buffer.length - SCAN_BACK_BYTES)).toString('utf8')
    } catch { return [] }

    const out: string[] = []
    for (const line of text.split('\n')) {
      const match = AGENT_ERROR_RE.exec(line)
      if (!match) continue
      const stamp = Date.parse(LEADING_TIMESTAMP_RE.exec(line)?.[1] ?? '')
      if (Number.isFinite(stamp) && stamp < since) continue // predates the turn we are healing
      out.push(cleanDevinErrorMessage(match[2]))
    }
    return out
  }

  /** New agent-error messages since the last call (empty when the log is missing/unchanged). */
  poll(): string[] {
    // Re-resolve until found: `devin -r` writes its lock before the log file appears.
    if (!this.path) {
      this.seekToEnd()
      return []
    }
    let size: number
    try { size = statSync(this.path).size } catch { this.path = null; return [] }
    if (size < this.offset) this.offset = 0 // rotated/truncated
    if (size === this.offset) return []

    let chunk: string
    try {
      const fd = readFileSync(this.path)
      chunk = fd.subarray(this.offset, size).toString('utf8')
    } catch { return [] }
    this.offset = size

    const out: string[] = []
    for (const line of chunk.split('\n')) {
      const match = AGENT_ERROR_RE.exec(line)
      if (match) out.push(cleanDevinErrorMessage(match[2]))
    }
    return out
  }
}
