/** Stop the exact discovered engine process while leaving the user's tmux pane and shell alive. */

import type { RegisteredSession } from './registry.js'
import type { RuntimeCheck } from './tmux.js'

/** Delete has already removed the UI entry; signal the saved process immediately. */
export const TERMINATE_CHECK_MS = 0
/** After SIGTERM. Matches the daemon's own stop sequence rather than inventing a tighter one. */
export const FALLBACK_KILL_GRACE_MS = 3_000
const POLL_MS = 250

export type TerminateOutcome =
  /** It left before or during signalling. */
  | 'gone'
  /** SIGTERM was enough. */
  | 'terminated'
  /** It ignored SIGTERM and had to be killed. */
  | 'killed'
  /** The pane holds a DIFFERENT process now; signalling it would hit an innocent bystander. */
  | 'not-ours'
  /** We could not signal it (permissions, gone mid-flight). The engine may still be running. */
  | 'failed'

export interface TerminateDeps {
  /** Three-valued exact identity check. Probe failure is not evidence that the process is gone. */
  checkRuntime: (session: RegisteredSession) => Promise<RuntimeCheck>
  /** `process.kill`. Throws on EPERM/ESRCH like the real one. */
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

/**
 * Validate the saved PID/start marker, then stop the engine if it is still there. Never throws.
 *
 * Failures are logged loudly on purpose: by the time this runs the UI already says the agent is gone, so
 * a silently-swallowed EPERM would leave a running engine that nothing on screen accounts for.
 */
export async function terminateDeletedAgent(
  session: RegisteredSession,
  deps: TerminateDeps,
  checkAfterMs = TERMINATE_CHECK_MS,
  killGraceMs = FALLBACK_KILL_GRACE_MS,
): Promise<TerminateOutcome> {
  await deps.sleep(checkAfterMs)

  const check = async (): Promise<RuntimeCheck> => {
    try { return await deps.checkRuntime(session) }
    catch (err) { return { state: 'unknown', reason: err instanceof Error ? err.message : String(err) } }
  }
  // PID + start marker validation is what prevents a recycled PID from receiving our signal. Unknown
  // means we cannot prove the target and must leave the runtime suppressed rather than call it gone.
  const initial = await check()
  if (initial.state === 'gone') return 'gone'
  if (initial.state === 'unknown') {
    deps.log(`[delete] could not validate ${session.engine} runtime: ${initial.reason}`)
    return 'failed'
  }

  const pid = session.processIdentity?.pid
  if (!pid) return 'not-ours'

  const signal = (sig: NodeJS.Signals): boolean => {
    try { deps.kill(pid, sig); return true } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // ESRCH = it exited between the check and the signal. Anything else (EPERM…) is a real failure to
      // enforce the delete, and the person who pressed delete has already been told it worked.
      if (code !== 'ESRCH') {
        deps.log(`[delete] could not ${sig} ${session.engine} pid ${pid}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return false
    }
  }

  deps.log(`[delete] ${session.engine} did not exit on request — SIGTERM pid ${pid}`)
  if (!signal('SIGTERM')) return (await check()).state === 'gone' ? 'gone' : 'failed'

  for (let waited = 0; waited < killGraceMs; waited += POLL_MS) {
    await deps.sleep(POLL_MS)
    if ((await check()).state === 'gone') return 'terminated'
  }

  deps.log(`[delete] ${session.engine} ignored SIGTERM — SIGKILL pid ${pid}`)
  if (!signal('SIGKILL')) return (await check()).state === 'gone' ? 'gone' : 'failed'
  await deps.sleep(POLL_MS)
  if ((await check()).state !== 'gone') {
    deps.log(`[delete] ${session.engine} pid ${pid} is STILL running after SIGKILL`)
    return 'failed'
  }
  return 'killed'
}
