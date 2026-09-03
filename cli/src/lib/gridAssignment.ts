/**
 * Which grid is a running agent ACTUALLY on?
 *
 * The desktop app can point an agent at a grid when it is created (`gridLaunch.ts`), and can move an
 * existing one (`agent_retarget`). Both work by changing how the engine was launched, which means the
 * answer is not in any record this daemon keeps — it is in the process. So it is read from the
 * process, the same way `gatewayRuntime.ts` reads which endpoint a pane is talking to, and for the
 * same reason: a bookkeeping map drifts the moment anything happens that the bookkeeper did not do,
 * and plenty does. A daemon restart forgets nothing. An agent the user started themselves with
 * `ANTHROPIC_BASE_URL=… claude` in their own shell — which this product discovers and adopts —
 * reports the truth rather than "none".
 *
 * Each engine is read through the same knob it was written through, so this table and
 * `GRID_ENGINE_CONTRACTS` must stay in step: an engine written by environment is read from the
 * environment, and Codex, which is written on the command line, is read from argv.
 *
 * **The key is never read.** The pane's credential is the pane's business; what leaves here is the
 * endpoint and the model, both of which the app already knows because it chose them.
 */

import type { AgentEngine } from '../engines/types.js'
import { readProcessEnv } from './processEnv.js'
import type { ProcessIdentity } from './registry.js'

/** Where an agent's inference goes, as far as anyone outside the pane needs to know. */
export interface GridAssignment {
  /** The relay root the engine was handed. The grid id is a path segment inside it. */
  baseUrl: string
  /** The model the launch pinned. Null = the engine's own choice. */
  model: string | null
}

/** The environment variable each engine's endpoint was written to, where it is one. */
const BASE_URL_VAR: Partial<Record<AgentEngine, string>> = {
  claude: 'ANTHROPIC_BASE_URL',
  opencode: 'OPENAI_BASE_URL',
  hermes: 'OPENAI_BASE_URL',
  grok: 'GROK_MODELS_BASE_URL',
  copilot: 'COPILOT_PROVIDER_BASE_URL',
}

/** The environment variable each engine's model was written to, where it is one. */
const MODEL_VAR: Partial<Record<AgentEngine, string>> = {
  claude: 'ANTHROPIC_MODEL',
  hermes: 'HERMES_INFERENCE_MODEL',
  copilot: 'COPILOT_MODEL',
}

/** Engines whose model was written into argv as `-m <model>` rather than an environment variable. */
const MODEL_IN_ARGV = new Set<AgentEngine>(['codex', 'grok'])

/** `-c model_providers.<name>.base_url="…"` — how Codex's endpoint is written, so how it is read. */
const CODEX_BASE_URL = /model_providers\.[A-Za-z0-9_-]+\.base_url=(?:"([^"]+)"|(\S+))/
const ARGV_MODEL = /(?:^|\s)-m\s+(\S+)/

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

/** Classify an already-read environment and argv. Exported so a spec can pin the rules with no I/O. */
export function classifyGridAssignment(
  engine: AgentEngine,
  processEnv: Record<string, string>,
  args = '',
): GridAssignment | null {
  const urlVar = BASE_URL_VAR[engine]
  const fromArgv = urlVar ? null : CODEX_BASE_URL.exec(args)
  const baseUrl = (urlVar ? processEnv[urlVar] : (fromArgv?.[1] ?? fromArgv?.[2]))?.trim()
  if (!baseUrl || !isGridUrl(baseUrl)) return null
  const modelVar = MODEL_VAR[engine]
  const model = modelVar
    ? processEnv[modelVar]?.trim()
    : MODEL_IN_ARGV.has(engine)
      ? ARGV_MODEL.exec(args)?.[1]
      : undefined
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
export async function probeGridAssignment(
  identity: ProcessIdentity,
  engine: AgentEngine,
  args = '',
): Promise<GridAssignment | null> {
  const processEnv = await readProcessEnv(identity)
  return processEnv ? classifyGridAssignment(engine, processEnv, args) : null
}

/** Is this agent already where `networkId` is served, on `model`? */
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
