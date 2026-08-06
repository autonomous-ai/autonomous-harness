/**
 * One muse agent per directory.
 *
 * Muse is the only engine that hands back NO identity for the session it opens. Measured, and every other
 * channel ruled out: no hook fires (in `exec` or the TUI); `MUSE_CURRENT_SESSION_LOG` is something muse
 * sets for its own children, not something it reads from us; `MUSE_SESSIONS` moves nothing; `--workspace`
 * is realpath'd before it is recorded, so handing each agent its own symlink collapses to one string.
 *
 * So binding rests entirely on `workspace_root`, and two muse agents in one directory make it ambiguous
 * forever: `fileEngineSession` sees two equally valid candidates and — correctly — refuses both, leaving
 * NEITHER agent able to stream. The alternative was a per-agent `XDG_DATA_HOME`, the one thing that does
 * isolate muse; it was rejected because an agent id is minted fresh on every launch, so each relaunch
 * would open an empty history and strand the previous one's sessions, memory and cron.
 *
 * Turning the second agent away is the honest trade: nothing that worked stops working, and the user gets
 * a sentence instead of an agent that silently never streams.
 */

import { realpathSync } from 'fs'
import type { AgentEngine } from '../engines/types.js'

/** Engines that cannot tell two agents in one directory apart. Deliberately a list of one. */
const ONE_PER_DIRECTORY: ReadonlySet<string> = new Set<AgentEngine>(['muse'])

/** `sameDir` from sessionRepair without the await — the launcher handshake is synchronous, and this runs
 *  once per launch. `/tmp` vs `/private/tmp` is the case raw string equality misses. */
export function sameDirSync(a: string, b: string): boolean {
  if (a === b) return true
  const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
  return real(a) === real(b)
}

/**
 * What the person in the pane reads when their launch is turned away.
 *
 * The REASON comes from the daemon (it owns the rule); the launcher only adds what to do about it. Three
 * lines, because a bare refusal reads like a broken CLI: what happened, why it has to be that way, and
 * the way forward.
 */
export function refusalMessage(reason: string | undefined): string[] {
  return [
    `harness: ${reason || 'this agent was refused by the machine'}`,
    '  Two agents in one directory cannot be told apart, so only one can run here.',
    '  Close the other one, or start this agent in a different directory.',
  ]
}

export interface AgentLocation { agentId: string; engine: string; cwd?: string | null }

export interface DuplicateCheck {
  /** The asking launcher's own agent id. It RECONNECTS under the same one, so it must never block itself. */
  selfId: string
  /** Whether an agent id still has a launcher on the socket. */
  isLive: (agentId: string) => boolean
}

/**
 * The message to turn a launcher away with, or null to let it through.
 *
 * `known` is the registry as-is. Both filters below are load-bearing, and were learned by breaking it:
 * the registry is PERSISTED, so a restarted daemon starts out holding agents that may be long gone, and a
 * launcher reconnects under the id it already owns. Reading that list literally refused the very
 * launchers the rule exists to protect — measured: a daemon restart killed two live muse panes, each
 * turned away by its own saved entry, because `exit` means exactly what it says.
 */
export function refuseDuplicateAgent(
  known: readonly AgentLocation[],
  engine: string,
  cwd: string | null | undefined,
  { selfId, isLive }: DuplicateCheck,
): string | null {
  if (!ONE_PER_DIRECTORY.has(engine) || !cwd) return null
  const taken = known.some((agent) => agent.engine === engine
    && agent.agentId !== selfId
    && isLive(agent.agentId)
    && agent.cwd && sameDirSync(agent.cwd, cwd))
  return taken ? `a ${engine} agent is already running in ${cwd} — one ${engine} agent per directory` : null
}
