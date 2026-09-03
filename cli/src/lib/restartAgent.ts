/**
 * Stop an agent's live engine process and relaunch it in the SAME tmux pane, preserving the pane/agent
 * identity and (best-effort) resuming the same engine conversation.
 *
 * Factored out of cli.ts's `onRestartAgent` the same way deleteAgentFallback.ts factors out delete's
 * kill sequence: a small, dependency-injected core so the kill → respawn → verify → fallback ordering
 * can be exercised without the daemon's registry, tmux, and reconciler wiring. cli.ts owns everything
 * registry-shaped around a call to this function — resolving the session, `agentReconciler.holdRoute` /
 * `releaseRoute`, `registry.updateProcessIdentity`, `clearPaneRemainOnExit`, and `announceSession`.
 */

import type { AgentEngine } from '../engines/types.js'
import type { ProcessIdentity } from './registry.js'
import type { TerminateOutcome } from './deleteAgentFallback.js'

export type RestartOutcome =
  | { ok: true; processIdentity: ProcessIdentity; resumed: boolean }
  | { ok: false; detail: string }

export interface RestartAgentDeps {
  /** Re-arm `remain-on-exit` before anything is killed — see `tmuxBackend.ts`'s `holdOpen`. Without
   *  this, tmux tears the pane (and, being its only pane, the whole session) down the instant the old
   *  process exits. */
  holdOpen: () => Promise<{ ok: boolean; reason?: string }>
  /** Validate + SIGTERM/SIGKILL the saved process. Same contract as `terminateDeletedAgent`. */
  terminate: (checkAfterMs?: number) => Promise<TerminateOutcome>
  /** `tmux respawn-pane` (or equivalent) with a fully-built argv. */
  respawn: (argv: string[]) => Promise<{ ok: boolean; reason?: string }>
  /** Poll the pane for a recognizable engine process, up to an internal budget. Null on timeout. */
  waitForProcess: () => Promise<ProcessIdentity | null>
  buildArgv: (opts: { bypassPermission: boolean; resumeSessionId?: string }) => string[]
  log: (message: string) => void
}

/** Outcomes that mean the old process is confirmed gone — safe to respawn over the pane. `not-ours` and
 *  `failed` are NOT here on purpose: never respawn over a target the kill sequence could not confirm. */
const KILL_CONFIRMED: ReadonlySet<TerminateOutcome> = new Set(['gone', 'terminated', 'killed'])

export async function restartAgent(
  session: { engine: AgentEngine; sessionId: string },
  bypassPermission: boolean,
  deps: RestartAgentDeps,
): Promise<RestartOutcome> {
  const armed = await deps.holdOpen()
  if (!armed.ok) {
    return { ok: false, detail: armed.reason ?? 'could not re-arm the pane before restart' }
  }

  const outcome = await deps.terminate()
  if (!KILL_CONFIRMED.has(outcome)) {
    return { ok: false, detail: `could not confirm the running ${session.engine} process was stopped (${outcome})` }
  }

  const resumeSessionId = session.sessionId || undefined
  const spawnAndWait = async (withResume: boolean): Promise<ProcessIdentity | null> => {
    const argv = deps.buildArgv({
      bypassPermission,
      ...(withResume && resumeSessionId ? { resumeSessionId } : {}),
    })
    const spawned = await deps.respawn(argv)
    if (!spawned.ok) {
      deps.log(`[restart] ${session.engine} respawn-pane failed: ${spawned.reason ?? 'unknown reason'}`)
      return null
    }
    return deps.waitForProcess()
  }

  // Attempt a resume relaunch whenever we have a session id to resume, for every engine — an
  // unconfirmed/wrong flag is not fatal because of the fallback below. Engines with no known launch
  // resume flag never spawn a resume argv in the first place (buildArgv's `resumeSessionId` is a no-op
  // when LAUNCH_RESUME_FLAG has no entry for the engine), so `resumed` still degrades correctly.
  let resumed = !!resumeSessionId
  let identity = await spawnAndWait(resumed)
  if (!identity && resumed) {
    // Safe degradation: a working agent with a FRESH session under the same agentId/pane beats a dead
    // pane. Retry once with no resume attempt before giving up entirely.
    deps.log(`[restart] ${session.engine} did not come back up resuming its session — retrying fresh`)
    resumed = false
    identity = await spawnAndWait(false)
  }
  if (!identity) {
    return { ok: false, detail: `${session.engine} did not come back up after restart` }
  }
  return { ok: true, processIdentity: identity, resumed }
}
