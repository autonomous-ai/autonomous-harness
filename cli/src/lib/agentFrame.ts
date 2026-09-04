/**
 * The one shape an agent takes on the wire.
 *
 * Every client — the web, the device, and the desktop window — rebuilds its whole agent from
 * whichever of these frames arrived last: `agents_list` replies and `agent_synced` pushes are the
 * same object, not a snapshot and a patch. So a field this function forgets is not merely missing
 * from one frame; it is ERASED on the next push from whatever an earlier frame had reported.
 *
 * That is not hypothetical. This module exists because there were two hand-maintained copies of the
 * shape — one in `cli.ts` behind `agent_synced`, one in `backendSocket.ts` behind `agents_list` —
 * and `grid` was added to the second only. The desktop showed an agent's grid correctly the moment
 * it was moved, then the next reconciliation pushed a frame with no `grid` at all, the app read that
 * as "on no grid", and its "N running agents are on an older target" banner came back for agents
 * that were already exactly where the user had put them.
 *
 * Pure on purpose: the two callers own the registry, so what they know (is the terminal available,
 * which model did the runtime profile resolve) is passed in rather than looked up here. That is what
 * makes the shape testable without a registry, which is the whole reason the drift went unnoticed.
 */

import { stat } from 'node:fs/promises'
import type { GridAssignment } from './gridAssignment.js'
import { projectDisplayName, type RegisteredSession } from './registry.js'

/**
 * One agent as it travels to every client.
 *
 * A `type` rather than an `interface` so it stays assignable to the `Record<string, unknown>` the
 * frame senders take — an interface gets no implicit index signature.
 */
export type AgentFrame = {
  id: string
  sessionId: string
  userId: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
  tmuxPane: string | null
  terminal: { available: boolean; primary: string; runtimes: RegisteredSession['runtimes'] }
  engine: RegisteredSession['engine']
  selectedModel: string | null
  grid: GridAssignment | null
}

/** What the caller knows and this module deliberately does not look up for itself. */
export interface AgentFrameContext {
  /** The runtime profile's answer for this session, or null when there is none. */
  selectedModel: string | null
  /** `registry.terminalAvailable(agentId)` — the caller already holds the registry. */
  terminalAvailable: boolean
}

/**
 * One agent as every client consumes it.
 *
 * `updatedAt` prefers the transcript's mtime over the registry's own bookkeeping so a client sorting
 * by recency follows the conversation rather than the daemon's housekeeping; an unreadable or absent
 * transcript falls back to the registry, never to "now".
 */
export async function agentFrame(
  s: RegisteredSession,
  { selectedModel, terminalAvailable }: AgentFrameContext,
): Promise<AgentFrame> {
  const st = s.transcriptPath ? await stat(s.transcriptPath).catch(() => null) : null
  return {
    id: s.agentId,
    sessionId: s.sessionId,
    userId: '',
    name: projectDisplayName(s),
    status: s.active ? 'active' : 'offline',
    createdAt: new Date(s.registeredAt).toISOString(),
    updatedAt: new Date(st?.mtimeMs ?? s.updatedAt).toISOString(),
    tmuxPane: s.tmuxPane || null,
    terminal: { available: terminalAvailable, primary: s.primaryRuntimeKey, runtimes: s.runtimes },
    engine: s.engine,
    selectedModel,
    // Where this agent's inference actually goes, so a client can tell which agents a newly picked
    // grid has left behind. Read off the live process by discovery; carries no credential. Null is
    // a real answer ("on no grid") and must be sent as one — omitting the key would make every push
    // indistinguishable from a daemon too old to know about grids.
    grid: s.grid ?? null,
  }
}
