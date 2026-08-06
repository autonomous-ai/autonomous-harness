/**
 * The backstop for deleting an agent: make sure the engine actually stopped.
 *
 * Deleting asks the launcher to shut its child down over the machine socket. That is the good path — the
 * launcher owns its child and can end it cleanly, leaving the tmux pane alive. But it cannot be relied
 * on alone: OTA ships one bundle while a launcher already running keeps its old build for hours, and an
 * old launcher does not know the `exit` frame — it ignores it in silence, exactly as designed.
 *
 * So this does not GUESS whether the request was understood, it MEASURES: wait past the launcher's own
 * shutdown budget, look at the pane again, and only then signal the engine directly. Killing the engine
 * makes even an ancient launcher exit, because its child-exit handler ends the process.
 *
 * What it deliberately does NOT do is kill the tmux pane. That is the whole point of the change: the
 * agent belongs to machine, the window belongs to the user. The trade is real and accepted — a pane kill
 * used to hang up the entire foreground process group, so anything the agent had spawned (a dev server, an
 * MCP subprocess) died with it, and now it does not.
 */

import type { RegisteredSession } from './registry.js'

/**
 * Must exceed the launcher's own SIGTERM→SIGKILL budget (`LAUNCHER_EXIT_GRACE_MS` in launch.ts), so a
 * launcher that DID understand the request always finishes first and this never fires. The two constants
 * are coupled; changing one without the other either kills a graceful shutdown mid-way (too short) or
 * leaves a deleted agent running (too long).
 */
export const FALLBACK_CHECK_MS = 4_500
/** After SIGTERM. Matches the daemon's own stop sequence rather than inventing a tighter one. */
export const FALLBACK_KILL_GRACE_MS = 3_000
const POLL_MS = 250

export type TerminateOutcome =
  /** It left on its own — the launcher did its job, or the user closed it. */
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
  /** `validateSessionRuntime`: the pane still holds THIS session's engine (pid + start time match). */
  isAlive: (session: RegisteredSession) => Promise<boolean>
  /** `process.kill`. Throws on EPERM/ESRCH like the real one. */
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

/**
 * Wait out the launcher, then stop the engine if it is still there. Never throws.
 *
 * Failures are logged loudly on purpose: by the time this runs the UI already says the agent is gone, so
 * a silently-swallowed EPERM would leave a running engine that nothing on screen accounts for.
 */
export async function terminateDeletedAgent(
  session: RegisteredSession,
  deps: TerminateDeps,
  checkAfterMs = FALLBACK_CHECK_MS,
  killGraceMs = FALLBACK_KILL_GRACE_MS,
): Promise<TerminateOutcome> {
  await deps.sleep(checkAfterMs)

  // isAlive compares pid AND start time, so a pane that now runs something else reads as not-alive here —
  // which is why the pid below can never land on a recycled pid.
  if (!await deps.isAlive(session).catch(() => false)) return 'gone'

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
  if (!signal('SIGTERM')) return await deps.isAlive(session).catch(() => false) ? 'failed' : 'gone'

  for (let waited = 0; waited < killGraceMs; waited += POLL_MS) {
    await deps.sleep(POLL_MS)
    if (!await deps.isAlive(session).catch(() => false)) return 'terminated'
  }

  deps.log(`[delete] ${session.engine} ignored SIGTERM — SIGKILL pid ${pid}`)
  if (!signal('SIGKILL')) return await deps.isAlive(session).catch(() => false) ? 'failed' : 'gone'
  await deps.sleep(POLL_MS)
  if (await deps.isAlive(session).catch(() => false)) {
    deps.log(`[delete] ${session.engine} pid ${pid} is STILL running after SIGKILL`)
    return 'failed'
  }
  return 'killed'
}
