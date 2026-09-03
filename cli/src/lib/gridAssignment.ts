/**
 * Which grid is a running agent ACTUALLY on?
 *
 * The desktop app can point an agent at a grid when it is created (`gridLaunch.ts`), and can move an
 * existing one (`agent_retarget`). Both work by setting the engine's environment, which means the
 * answer is not in any record this daemon keeps — it is in the process. So it is read from the process,
 * the same way `gatewayRuntime.ts` reads which endpoint a pane is talking to, and for the same reason:
 * a bookkeeping map drifts the moment anything happens that the bookkeeper did not do, and plenty does.
 * A daemon restart forgets nothing. An agent the user started themselves with `ANTHROPIC_BASE_URL=…`
 * in their own shell — which this product discovers and adopts — reports the truth rather than "none".
 *
 * **The key is never read.** The pane's credential is the pane's business; what leaves here is the
 * endpoint and the model, both of which the app already knows because it chose them.
 */

import { readProcessEnv } from './processEnv.js'
import type { ProcessIdentity } from './registry.js'

/** Where an agent's inference goes, as far as anyone outside the pane needs to know. */
export interface GridAssignment {
  /** `ANTHROPIC_BASE_URL` verbatim — the grid id is a path segment inside it. */
  baseUrl: string
  /** `ANTHROPIC_MODEL`, when the launch pinned one. Null = the engine's own choice. */
  model: string | null
}

/**
 * Only Claude Code can be pointed at a grid today (see `GRID_ENGINE_ENV`), so only its variables are
 * read. An engine that gains an environment contract gets its variables added here at the same time.
 */
const BASE_URL_VAR = 'ANTHROPIC_BASE_URL'
const MODEL_VAR = 'ANTHROPIC_MODEL'

/**
 * A base URL that is not a grid is not an assignment.
 *
 * An agent can be pointed somewhere else entirely — OpenRouter through `ori`, a corporate proxy, a
 * local llama server — and reporting those as "on a grid" would make the app offer to move an agent
 * away from a place the user deliberately sent it.
 */
function isGridUrl(value: string): boolean {
  try {
    // The relay always lives under `/relay`, whatever host serves it — that is the one part of the
    // shape the control plane and both CLIs agree on (`<grid>/relay` for Messages, `/relay/v1` for
    // OpenAI clients). Matching on the host would pin this to one deployment.
    return new URL(value).pathname.split('/').includes('relay')
  } catch {
    return false
  }
}

/** Classify an already-read environment. Exported so a spec can pin the rules without any I/O. */
export function classifyGridAssignment(processEnv: Record<string, string>): GridAssignment | null {
  const baseUrl = processEnv[BASE_URL_VAR]?.trim()
  if (!baseUrl || !isGridUrl(baseUrl)) return null
  const model = processEnv[MODEL_VAR]?.trim()
  return { baseUrl, model: model || null }
}

/**
 * Read one live engine process's grid.
 *
 * Null covers both "not on a grid" and "could not look", deliberately: the caller renders an agent
 * whose assignment is unknown the same as one with none, which at worst offers a move that turns out
 * to be a no-op. The opposite error — claiming an agent is already on the right grid when nobody
 * checked — would leave it quietly running somewhere else.
 */
export async function probeGridAssignment(identity: ProcessIdentity): Promise<GridAssignment | null> {
  const processEnv = await readProcessEnv(identity)
  return processEnv ? classifyGridAssignment(processEnv) : null
}

/** Is this agent already where `networkId` is served? */
export function assignmentMatches(
  assignment: GridAssignment | null | undefined,
  networkId: string,
  model: string | null,
): boolean {
  if (!assignment) return false
  // Containment rather than a parsed id: the grid id IS a path segment of the relay URL today, and
  // asking "does this endpoint name the grid I picked" survives a control plane that rearranges the
  // rest of the path. A false negative costs one needless move; a false positive would leave an agent
  // somewhere the user did not choose and say it was fine.
  if (!assignment.baseUrl.includes(networkId)) return false
  return (assignment.model ?? null) === (model ?? null)
}
