/**
 * The parts of starting a daemon that decide whether it WORKED — pulled out of cli.ts so they can be
 * tested without a backend, a bundle, or a real child.
 *
 * Two phases, and the split is the point. A spawned child first has to BIND the fixed control port;
 * only then does it try the backend. The old single wait watched the log for "[backend] connected"
 * and, when that never came inside ten seconds, gave up with "unreachable" — leaving a child that was
 * still booting (a slow login shell, tmux adoption) with no pid file and nothing guarding it, which is
 * exactly when a second `harness start` would spawn a competitor for the port.
 *
 * The bind signal is the pid file itself: the daemon writes its own pid there ONLY after the port is
 * bound (see runForeground), so `readPid() === child.pid` is something only a bound child can
 * produce. No parsing, no shared-log ambiguity.
 */

import { readFileSync, rmSync } from 'fs'
import { PID_FILE, isAlive, readPid } from './daemonState.js'

export interface LaunchDeps {
  readPid: () => number | null
  isAlive: (pid: number) => boolean
  /** The daemon log from a byte offset — decoded AFTER slicing, see waitForReady. */
  readLogSlice: (sinceOffset: number) => string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** The fixed control port, for the EADDRINUSE message. */
  port: number
}

export function defaultLaunchDeps(logFile: string, port: number): LaunchDeps {
  return {
    readPid,
    isAlive,
    readLogSlice: (sinceOffset) => {
      // Slice the raw BYTES from sinceOffset (a Buffer byte length) THEN decode. The log is full of
      // multi-byte glyphs (→ · ─ ● …), so decoding first and slicing the STRING by that byte count
      // overshoots (byte length > char length) and returns "" — the classic false "no connection".
      try { return readFileSync(logFile).subarray(sinceOffset).toString('utf-8') } catch { return '' }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    port,
  }
}

// 'fatal'       = misconfig; retrying is pointless → kill the daemon + error out.
// 'unreachable' = transient (backend deploying / 5xx / slow / not up yet) → the daemon keeps retrying
//                 in the background and connects on its own, so DON'T kill it — just report the state.
// 'deauth' = the saved credential is invalid/revoked (401/403) → clear it and ask for a fresh token.
// 'busy'   = this machine is already connected from another computer (409) → keep token, stop, inform.
export interface ReadyResult { state: 'connected' | 'deauth' | 'fatal' | 'unreachable' | 'busy'; detail?: string }

export interface ConnectFailure { detail: string; fatal: boolean; deauth?: boolean; busy?: boolean }

/** Classify a backend connection error from the log tail: a human reason + fatal (won't self-heal) vs
 *  transient (will), and `deauth` for 401/403 (the token is no longer valid). null = no signal yet. */
export function connectFailure(tail: string, port: number): ConnectFailure | null {
  // The daemon logs this marker when the backend rejected us with 409 (machine held by another computer).
  if (tail.includes('[backend] machine busy')) {
    return { detail: 'this machine is already connected from another computer', fatal: true, busy: true }
  }
  // The daemon couldn't bind the (fixed) hook port → another adapter is almost certainly already
  // running. Fatal: don't sit on "retrying"; tell the user how to find/stop the other one.
  if (/EADDRINUSE|already in use/.test(tail)) {
    return { detail: `hook port ${port} is already in use — is another machine daemon running? (harness stop, or lsof -ti :${port} | xargs kill)`, fatal: true }
  }
  const m = tail.match(/Unexpected server response: (\d+)/)
  if (m) {
    const code = Number(m[1])
    // 401/403 = this computer's machine was deleted/revoked (or a bad token) → deauth: clear + re-join.
    // 409 = one machine per machine: already connected from another computer → busy (keep token, stop).
    // 404 = wrong backend / route not deployed → misconfig (fatal, don't wipe the token).
    // 5xx (esp. 502/503/504) = gateway up but the app is deploying/restarting → transient, keep retrying.
    if (code === 409) return { detail: 'this machine is already connected from another computer', fatal: true, busy: true }
    const deauth = code === 401 || code === 403
    return { detail: `backend returned HTTP ${code}`, fatal: deauth || code === 404, deauth }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(tail)) return { detail: 'host not found (DNS)', fatal: true }
  if (/certificate|CERT_|self-signed/i.test(tail)) return { detail: 'TLS certificate error', fatal: true }
  if (/ECONNREFUSED/.test(tail)) return { detail: 'connection refused', fatal: false } // backend not up yet → retry
  // A 1006 close with no HTTP code — generic "couldn't reach it right now"; transient.
  if (/disconnected \(close 1006\)/.test(tail)) return { detail: 'cannot reach backend', fatal: false }
  return null
}

/** Poll the log until the adapter connects, hits a FATAL error, or the window ends. Transient errors
 *  don't short-circuit — the connection may recover within the window (e.g. a 502 during a deploy). */
export async function waitForReady(sinceOffset: number, timeoutMs: number, deps: LaunchDeps): Promise<ReadyResult> {
  const deadline = deps.now() + timeoutMs
  let lastTransient: string | undefined
  while (deps.now() < deadline) {
    const tail = deps.readLogSlice(sinceOffset)
    if (tail.includes('[backend] connected')) return { state: 'connected' }
    const fail = connectFailure(tail, deps.port)
    if (fail?.busy) return { state: 'busy', detail: fail.detail }
    if (fail?.deauth) return { state: 'deauth', detail: fail.detail }
    if (fail?.fatal) return { state: 'fatal', detail: fail.detail }
    if (fail) lastTransient = fail.detail // remember, but keep waiting — it may connect on a retry
    await deps.sleep(250)
  }
  return { state: 'unreachable', detail: lastTransient ?? `no connection within ${timeoutMs / 1000}s` }
}

/** How long a spawned child gets to bind the control port. Generous on purpose: this covers a cold
 *  login shell and tmux adoption, and nothing else can spawn while the caller holds the spawn lock. */
export const BIND_WAIT_MS = 60_000

export type BindResult = 'bound' | 'exited' | 'timeout'

/** Wait for the child to claim the pid file — which it does only once the port is bound. */
export async function waitForBind(
  childPid: number,
  exited: () => boolean,
  timeoutMs: number,
  deps: LaunchDeps,
): Promise<BindResult> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    if (deps.readPid() === childPid) return 'bound'
    if (exited()) return 'exited'
    if (deps.now() >= deadline) return 'timeout'
    await deps.sleep(250)
  }
}

/** Remove the pid file only if it still names `pid`. A spawner that deletes unconditionally after ITS
 *  child failed can erase the record of the daemon that actually won the port. */
export function removePidFileIf(pid: number | undefined, deps: Pick<LaunchDeps, 'readPid'> = { readPid }): boolean {
  if (pid === undefined || deps.readPid() !== pid) return false
  try { rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
  return true
}
