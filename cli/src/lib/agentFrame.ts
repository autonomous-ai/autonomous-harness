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
import { agentProject, type AgentProject } from './agentProject.js'
import type { GridAssignment } from './gridAssignment.js'
import type { GridWebSearchStatus } from './gridLaunch.js'
import { projectDisplayName, sessionDisplayTitle, type RegisteredSession } from './registry.js'
import { engineCanFork } from './forkAgent.js'
import type { DshVerdict } from '../dsh/verdict.js'

/**
 * The grid block on the wire: where the agent's inference goes, and — when the daemon built the
 * launch — whether it can search the web. `webSearch` is absent, not null, when there is nothing to
 * say: a discovered grid agent, or a row from before the daemon recorded it. The app shows nothing
 * for absent and for `on`; the two degraded words each get a sentence.
 */
export type GridFrameBlock = GridAssignment & { webSearch?: GridWebSearchStatus }

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
  /**
   * What the agent is on, in its own words — the session title (Claude Code's, Codex's), cleaned;
   * null when there is none or it is the name already. It is usually the name too (registry.ts,
   * projectDisplayName), but not once the person renames the agent, and a client searching for
   * "board fab check" must still find it by this, not by luck in a recap.
   */
  title: string | null
  status: string
  launch: NonNullable<RegisteredSession['launch']>
  createdAt: string
  updatedAt: string
  tmuxPane: string | null
  terminal: { available: boolean; primary: string; runtimes: RegisteredSession['runtimes'] }
  engine: RegisteredSession['engine']
  selectedModel: string | null
  grid: GridFrameBlock | null
  codexHome: string | null
  project: AgentProject | null
  /** The domain-specific harness this agent was created as, or null for a plain engine. */
  dsh: string | null
  /** Its display name from the installed manifest; null when unknown here (not installed, plain engine). */
  dshName: string | null
  /** Where this agent's viewer is being served right now, or null when it has none up. */
  viewerUrl: string | null
  /** What its viewer pane is called ("3D Viewer", "Marp Viewer"); null with no viewer or none known. */
  viewerName: string | null
  /** The DSH's last verdict for this workspace, reduced for the pane header; null when none yet. */
  verdict: DshVerdict | null
  /** The agent this one was forked from (`agent_fork`), or null — a real answer, like `dsh: null`. */
  forkedFrom: { agentId: string; name: string } | null
  /** Whether `agent_fork` can do anything for this engine (lib/forkAgent.ts) — natively, or by a
   *  handoff. A client hides the Fork action on a false rather than offering a button that refuses. */
  forkable: boolean
}

/** What the daemon knows about an agent's DSH — looked up by the caller, never here. */
export interface AgentDshContext {
  /** The harness's CURRENT id — an agent created under a former name (`formerly`) reports the new one. */
  id: string | null
  name: string | null
  viewerUrl: string | null
  /** manifest.ts, dshViewerName. */
  viewerName?: string | null
  verdict: DshVerdict | null
}

/** What the caller knows and this module deliberately does not look up for itself. */
export interface AgentFrameContext {
  /** The runtime profile's answer for this session, or null when there is none. */
  selectedModel: string | null
  /** `registry.terminalAvailable(agentId)` — the caller already holds the registry. */
  terminalAvailable: boolean
  /** The DSH companions' state for this agent; absent when the caller has none to give. */
  dsh?: AgentDshContext | null
}

/**
 * When the conversation last moved, in epoch ms: the transcript's mtime, else the last time the engine
 * reported in (a hook, or a session bind — the agent's creation at the latest).
 *
 * ⚠️ Never the registry's `updatedAt`. That is bookkeeping: discovery rewrites it on every pass
 * (`updateRuntimes`), so falling back to it stamped every agent without a readable transcript "now"
 * — and a client sorting by recency put exactly those agents above the ones just used.
 */
export async function lastActivityAt(s: RegisteredSession): Promise<number> {
  const st = s.transcriptPath ? await stat(s.transcriptPath).catch(() => null) : null
  return st?.mtimeMs ?? s.lastHookAt
}

function frameTitle(s: RegisteredSession): string | null {
  const title = sessionDisplayTitle(s)
  return title && title !== projectDisplayName(s) ? title : null
}

/**
 * One agent as every client consumes it. `updatedAt` is {@link lastActivityAt}, so a client sorting by
 * recency follows the conversation rather than the daemon's housekeeping.
 */
export async function agentFrame(
  s: RegisteredSession,
  { selectedModel, terminalAvailable, dsh }: AgentFrameContext,
): Promise<AgentFrame> {
  return {
    id: s.agentId,
    sessionId: s.sessionId,
    userId: '',
    name: projectDisplayName(s),
    title: frameTitle(s),
    status: s.active ? 'active' : 'offline',
    launch: s.launch ?? { state: 'ready' },
    createdAt: new Date(s.registeredAt).toISOString(),
    updatedAt: new Date(await lastActivityAt(s)).toISOString(),
    tmuxPane: s.tmuxPane || null,
    terminal: { available: terminalAvailable, primary: s.primaryRuntimeKey, runtimes: s.runtimes },
    engine: s.engine,
    selectedModel,
    // Where this agent's inference actually goes, so a client can tell which agents a newly picked
    // grid has left behind. Read off the live process by discovery; carries no credential. Null is
    // a real answer ("on no grid") and must be sent as one — omitting the key would make every push
    // indistinguishable from a daemon too old to know about grids. The web-search status rides on
    // the block — decided by the launch, kept on the row — so it is gone the moment the block is.
    grid: s.grid ? { ...s.grid, ...(s.gridWebSearch ? { webSearch: s.gridWebSearch } : {}) } : null,
    // The Codex profile folder this agent launched against, if one was chosen instead of the
    // engine's own login. Codex only; null is a real answer ("uses ~/.codex") for the same reason
    // `grid: null` is above.
    codexHome: s.codexHome ?? null,
    project: await agentProject(s.cwd),
    // All five are real answers when null, for the reason the module doc gives: a frame that omits
    // them would erase a viewer URL or a verdict an earlier frame had reported.
    dsh: dsh?.id ?? s.dsh ?? null,
    dshName: dsh?.name ?? null,
    viewerUrl: dsh?.viewerUrl ?? null,
    viewerName: dsh?.viewerName ?? null,
    verdict: dsh?.verdict ?? null,
    forkedFrom: s.forkedFrom ? { agentId: s.forkedFrom.agentId, name: s.forkedFrom.name } : null,
    forkable: engineCanFork(s.engine),
  }
}
