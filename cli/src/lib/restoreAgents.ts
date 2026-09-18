/**
 * Bring registered agents back after their tmux panes died with the daemon down — a reboot, a
 * `tmux kill-server`, a pane closed by hand.
 *
 * The registry outlives the tmux server: it still knows each agent's id, engine, cwd, session and
 * launch shape. This recreates a pane for every agent whose pane is gone, launches the same engine
 * there — resuming its engine session when it has one — and keeps the SAME agentId, so a desktop
 * tile that remembered the agent attaches to it again without anyone recreating anything.
 *
 * Dependency-injected like restartAgent.ts: cli.ts owns the tmux, registry and reconciler wiring,
 * and this owns the ordering, which is the part worth testing without a daemon:
 *
 *   1. Every missing pane is recreated inside ONE registry transaction. A new tmux server hands out
 *      pane ids from `%0` again, so a restored pane's id can equal another stale row's dead pane —
 *      and `registry.save()` evicts whichever row loses that collision. Deferring the save until
 *      every row holds its new pane is what keeps the second row alive.
 *   2. The new route is HELD in the reconciler until the engine process is bound here. Otherwise the
 *      reconciler's discovery half sees an unclaimed engine process and mints a fresh agentId for it.
 *   3. The row keeps `launch: starting` and only gets its process identity from here. The reconcile
 *      pass after the release then matches the process, sees a launch in progress, and does the
 *      full ready → attach → announce sequence it already does for `agent_create`.
 *
 * A grid agent comes back onto its grid: the registry kept the launch it was created or retargeted
 * with (`gridLaunch`, credential included), and `buildLaunch` turns that back into the same env and
 * argv `agent_create` used. A row that only knows WHERE it pointed (`grid` without `gridLaunch`,
 * written before the credential was persisted) is not relaunched — on the engine's own login it would
 * spend the wrong account while looking identical — and is marked so the app can say why.
 */

import type { AgentEngine } from '../engines/types.js'
import type { AgentLaunch, ProcessIdentity, RegisteredSession } from './registry.js'
import type { TerminalRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'

export interface RestoreLaunch {
  argv: string[]
  env?: Record<string, string>
}

export type RestoreLaunchResult = RestoreLaunch | { error: string; detail: string }

/** The row knows it was on a grid but not how to get back there. */
export const GRID_CREDENTIAL_REQUIRED = 'GRID_CREDENTIAL_REQUIRED'

export interface RestoreAgentsDeps {
  registry: {
    list(): RegisteredSession[]
    byAgent(agentId: string): RegisteredSession | undefined
    transaction<T>(apply: () => T | Promise<T>): Promise<T>
    clearProcessIdentity(agentId: string): boolean
    updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean
    setLaunch(agentId: string, launch: AgentLaunch): RegisteredSession | null
    updateProcessIdentity(agentId: string, processIdentity: ProcessIdentity): boolean
    unbindSession(sessionId: string): boolean
    inheritName(fromSessionId: string, toSessionId: string): void
  }
  /** The engine process still running in this row's pane, or null when tmux does not know the pane
   *  at all — including when no tmux server is running — or the pane has become something else. */
  liveProcess: (entry: RegisteredSession, runtime: TmuxRuntimeRef) => Promise<ProcessIdentity | null>
  /** Is this row's folder there right now? Only `CWD_NOT_FOUND` is allowed to retry itself, and only
   *  because it is the one recorded failure whose precondition is observable from outside the agent:
   *  put the folder back (recreate the worktree, remount the disk) and the row becomes launchable
   *  again without anyone touching it. */
  cwdAvailable: (cwd: string) => boolean
  /** The pane's launch — engine argv plus whatever puts it back on its grid / profile. A grid the
   *  machine cannot honour (unsupported engine, tmux too old, config dir unwritable) is a refusal. */
  buildLaunch: (entry: RegisteredSession, opts: { resumeSessionId?: string }) => Promise<RestoreLaunchResult>
  createPane: (entry: RegisteredSession, launch: RestoreLaunch) => Promise<
    | { ok: true; runtime: TmuxRuntimeRef }
    | { ok: false; reason: string }
  >
  /** `tmux respawn-pane` over the restored pane — the resume → fresh fallback. */
  respawn: (runtime: TmuxRuntimeRef, launch: RestoreLaunch) => Promise<{ ok: boolean; reason?: string }>
  /** One probe of the pane for a recognizable engine process. */
  probeProcess: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<ProcessIdentity | null>
  /** Null when tmux no longer knows the pane. */
  paneState: (runtime: TmuxRuntimeRef) => Promise<{ dead: boolean } | null>
  clearRemainOnExit: (runtime: TmuxRuntimeRef) => Promise<void>
  holdRoute: (routeKey: string, autoReleaseMs: number) => void
  releaseRoute: (routeKey: string) => void
  triggerHint: (runtime: TmuxRuntimeRef, engine: AgentEngine) => Promise<void>
  log: (message: string) => void
  /** How long a restored pane may take to show an engine process. Default matches `agent_create`. */
  budgetMs?: number
  /** How long the engine must stay up after appearing before the pane is handed over. */
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface RestoreSummary {
  /** Agents whose pane was recreated; their engine process is bound in the background. */
  restored: string[]
  skipped: Array<{ agentId: string; reason: string }>
  failed: Array<{ agentId: string; reason: string }>
}

const DEFAULT_BUDGET_MS = 10 * 60_000
const DEFAULT_SETTLE_MS = 10_000
const SETTLE_POLL_MS = 500
const HOLD_SLACK_MS = 30_000

/** A row that failed for a missing folder, whose folder is back. Every other failure stays skipped:
 *  nothing outside the agent says whether an engine that exited would exit again. */
function workdirFailureCleared(deps: RestoreAgentsDeps, entry: RegisteredSession): boolean {
  const launch = entry.launch
  if (!launch || launch.state !== 'failed' || launch.error !== 'CWD_NOT_FOUND') return false
  return !!entry.cwd && deps.cwdAvailable(entry.cwd)
}

function tmuxRuntime(entry: RegisteredSession): TmuxRuntimeRef | null {
  const runtime = entry.runtimes.find((candidate): candidate is TmuxRuntimeRef => candidate.backend === 'tmux')
  return runtime ?? null
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Watch a pane whose engine just appeared: 'settled' once it has stayed up for `settleMs`, 'gone' the
 *  moment tmux reports it dead or forgotten. */
async function waitForSettle(deps: RestoreAgentsDeps, runtime: TmuxRuntimeRef, settleMs: number): Promise<'settled' | 'gone'> {
  const sleep = deps.sleep ?? defaultSleep
  const until = Date.now() + settleMs
  while (Date.now() < until) {
    await sleep(Math.min(SETTLE_POLL_MS, until - Date.now()))
    const state = await deps.paneState(runtime)
    if (!state || state.dead) return 'gone'
  }
  return 'settled'
}

/**
 * Recreate every missing pane, then return. Binding each pane's engine process continues in the
 * background; the summary says which agents that is happening for.
 */
export async function restoreAgents(deps: RestoreAgentsDeps): Promise<RestoreSummary> {
  const summary: RestoreSummary = { restored: [], skipped: [], failed: [] }
  const missing: Array<{ entry: RegisteredSession; runtime: TmuxRuntimeRef }> = []

  for (const entry of deps.registry.list()) {
    const runtime = tmuxRuntime(entry)
    if (!runtime) { summary.skipped.push({ agentId: entry.agentId, reason: 'no tmux pane' }); continue }
    if (entry.launch?.state === 'failed' && !workdirFailureCleared(deps, entry)) {
      summary.skipped.push({ agentId: entry.agentId, reason: 'last launch failed' }); continue
    }
    const live = await deps.liveProcess(entry, runtime)
    if (live) {
      // Still running. A row that lost its identity without losing its pane (a reboot the boot
      // clock misread; a tmux server that outlived the daemon) is re-identified right here, so the
      // reconciler adopts it by process instead of treating it as an unbound route.
      if (!entry.processIdentity) deps.registry.updateProcessIdentity(entry.agentId, live)
      continue
    }
    // A grid row without its launch: written before the credential was persisted, or a grid agent
    // discovery adopted from a pane the daemon never launched (it saw the endpoint, never the key).
    // Launching it on the engine's own login instead would spend the wrong account while looking
    // identical — refusing is the rule gridLaunch.ts already sets. Marked, not just skipped: the row
    // has no pane to come back to, and the app should be able to say why before discovery lets it go.
    if (entry.grid && !entry.gridLaunch) {
      const reason = 'grid agent; credential not persisted'
      summary.skipped.push({ agentId: entry.agentId, reason })
      deps.registry.setLaunch(entry.agentId, {
        state: 'failed',
        error: GRID_CREDENTIAL_REQUIRED,
        detail: `${entry.engine} was on a grid, but this machine no longer holds the credential to put it back there. Create it again from the app.`,
      })
      deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · skipped · ${reason}`)
      continue
    }
    missing.push({ entry, runtime })
  }
  if (!missing.length) return summary

  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const watches: Array<() => Promise<void>> = []
  await deps.registry.transaction(async () => {
    for (const { entry, runtime: dead } of missing) {
      // No process survives its pane; clear it now or discovery would refuse to adopt the new one
      // into this agent (route adoption requires either no identity or a matching pid).
      deps.registry.clearProcessIdentity(entry.agentId)
      const resumeSessionId = entry.sessionId || undefined
      const launch = await deps.buildLaunch(entry, resumeSessionId ? { resumeSessionId } : {})
      if ('error' in launch) {
        summary.failed.push({ agentId: entry.agentId, reason: launch.detail })
        deps.registry.setLaunch(entry.agentId, { state: 'failed', error: launch.error, detail: launch.detail })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not build its launch · ${launch.detail}`)
        continue
      }
      const created = await deps.createPane(entry, launch)
      if (!created.ok) {
        summary.failed.push({ agentId: entry.agentId, reason: created.reason })
        deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · could not open a pane · ${created.reason}`)
        continue
      }
      const key = terminalRouteKey(created.runtime)
      deps.holdRoute(key, budgetMs + HOLD_SLACK_MS)
      deps.registry.updateRuntimes(entry.agentId, [created.runtime], key)
      deps.registry.setLaunch(entry.agentId, { state: 'starting' })
      summary.restored.push(entry.agentId)
      // The grid is named because the pane gives nothing away: the engine looks exactly like one on
      // its own login. The key is never printed.
      deps.log(`[restore] ${entry.engine} · agent ${entry.agentId} · pane ${dead.paneId} → ${created.runtime.paneId}`
        + (resumeSessionId ? ` · resuming ${resumeSessionId.slice(0, 8)}` : ' · fresh session')
        + (entry.gridLaunch ? ` · grid ${entry.gridLaunch.networkName}` : ''))
      watches.push(() => watchRestoredPane(deps, entry, created.runtime, !!resumeSessionId, budgetMs))
    }
  })
  for (const watch of watches) void watch()
  return summary
}

async function watchRestoredPane(
  deps: RestoreAgentsDeps,
  entry: RegisteredSession,
  runtime: TmuxRuntimeRef,
  resuming: boolean,
  budgetMs: number,
): Promise<void> {
  const { agentId, engine } = entry
  const key = terminalRouteKey(runtime)
  const sleep = deps.sleep ?? defaultSleep
  const fail = (error: string, detail: string): void => {
    deps.registry.setLaunch(agentId, { state: 'failed', error, detail })
    deps.log(`[restore] ${engine} · agent ${agentId} · failed · ${detail}`)
  }
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  let mayRetryFresh = resuming
  /** The pane's engine is gone. True when a fresh relaunch is now under way, false when this is the end. */
  const relaunchFresh = async (): Promise<boolean> => {
    if (!mayRetryFresh) {
      fail('ENGINE_DID_NOT_START', `${engine} exited before its engine process became ready. See the terminal output for details.`)
      return false
    }
    // A resume id the engine no longer honours is not worth a dead agent: the row's name comes
    // along to the agent itself, the stale binding goes, and the engine gets one fresh start.
    mayRetryFresh = false
    deps.log(`[restore] ${engine} · agent ${agentId} · did not come back up resuming its session — retrying fresh`)
    // BUILD FIRST. A launch that cannot be built at all — its folder is gone — must not also cost the
    // agent the conversation it was resuming: the binding is the only thing that makes the row worth
    // repairing, and a repair that has to re-find the transcript by hand is not a repair.
    const launch = await deps.buildLaunch(entry, {})
    if ('error' in launch) {
      fail(launch.error, launch.detail)
      return false
    }
    // Only now is there something to put in the binding's place.
    deps.registry.inheritName(entry.sessionId, agentId)
    deps.registry.unbindSession(entry.sessionId)
    const spawned = await deps.respawn(runtime, launch)
    if (!spawned.ok) {
      fail('ENGINE_DID_NOT_START', `${engine} could not be relaunched fresh: ${spawned.reason ?? 'unknown reason'}`)
      return false
    }
    // The fresh start gets the full budget again; the hold's auto-release must outlast it.
    deps.holdRoute(key, budgetMs + HOLD_SLACK_MS)
    return true
  }
  try {
    const startedAt = Date.now()
    let delayMs = 50
    while (Date.now() - startedAt < budgetMs) {
      if (!deps.registry.byAgent(agentId)) return
      const identity = await deps.probeProcess(runtime, engine)
      if (identity) {
        deps.registry.updateProcessIdentity(agentId, identity)
        // A resume the engine rejects does not fail to start — it starts, prints why, and exits a
        // few seconds later. Keep the pane (and the fallback) for a settling window before handing
        // it over; a pane let go at first sight of the process vanished with the engine and took
        // the agent with it (measured: claude resuming a conversation another client still held).
        const settled = await waitForSettle(deps, runtime, settleMs)
        if (settled === 'gone') {
          if (!await relaunchFresh()) return
          delayMs = 50
          continue
        }
        await deps.clearRemainOnExit(runtime)
        // Release BEFORE the hint: the pass it triggers is the one that must see this route again.
        deps.releaseRoute(key)
        await deps.triggerHint(runtime, engine)
        deps.log(`[restore] ${engine} · agent ${agentId} · engine up · ${Date.now() - startedAt}ms`)
        return
      }
      const state = await deps.paneState(runtime)
      if (!state) {
        fail('ENGINE_DID_NOT_START', `${engine}'s restored pane disappeared before its engine process became ready.`)
        return
      }
      if (state.dead) {
        if (!await relaunchFresh()) return
        delayMs = 50
        continue
      }
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 750)
    }
    fail('START_TIMEOUT', `${engine} did not expose an engine process within ${Math.round(budgetMs / 60_000)} minutes. The terminal remains available.`)
  } catch (error) {
    deps.log(`[restore] ${engine} · agent ${agentId} · watch failed · ${error instanceof Error ? error.message : error}`)
  } finally {
    deps.releaseRoute(key)
  }
}
