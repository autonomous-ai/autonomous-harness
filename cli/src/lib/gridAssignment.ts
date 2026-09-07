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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { GRID_ROUTER_MODEL } from './gridLaunch.js'
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
  // opencode is deliberately absent: its endpoint moved into a config file (see
  // `readOpencodeGridAssignment`), and leaving it here would read a stray OPENAI_BASE_URL from the
  // user's own shell as proof this agent is on a grid.
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

/**
 * Pi's endpoint is in neither its environment nor its argv — it is in the `models.json` inside the
 * config directory `PI_CODING_AGENT_DIR` points at. So that is where it is read from, because the
 * alternative is to trust a note we wrote ourselves about what we did.
 */
const PI_CONFIG_DIR_VAR = 'PI_CODING_AGENT_DIR'
/** `--model grid/<model>` — how Pi is told which provider and model to use. */
const PI_ARGV_MODEL = /(?:^|\s)--model\s+([A-Za-z0-9_-]+)\/(\S+)/

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
 * Pi's provider block, read out of the config directory its process was pointed at.
 *
 * Exported so a spec can drive the real read against real files: the process half of the probe
 * cannot be faked (an environment is fixed at exec), and a round trip that re-implemented this
 * would prove nothing about the code that runs.
 *
 * Every failure lands on null — an unreadable or rewritten directory is "we cannot tell", which the
 * caller already treats as "not on the grid you picked".
 */
export async function readPiGridAssignment(
  processEnv: Record<string, string>,
  args: string,
): Promise<GridAssignment | null> {
  const dir = processEnv[PI_CONFIG_DIR_VAR]?.trim()
  if (!dir) return null
  const model = PI_ARGV_MODEL.exec(args)
  if (!model) return null
  try {
    const raw = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as {
      providers?: Record<string, { baseUrl?: unknown }>
    }
    const baseUrl = raw.providers?.[model[1]]?.baseUrl
    if (typeof baseUrl !== 'string' || !isGridUrl(baseUrl)) return null
    return { baseUrl, model: model[2] }
  } catch {
    return null
  }
}

/** The config file OpenCode was pointed at. Fixed at exec; nothing the engine does can change it. */
const OPENCODE_CONFIG_VAR = 'OPENCODE_CONFIG'

/**
 * OpenCode's endpoint and model, read out of the config file its process was pointed at.
 *
 * Same shape as Pi's, and for the same reason: neither engine carries its endpoint in an environment
 * variable, so the only honest answer comes from the file the process is actually reading. Reading
 * our own record of what we launched would answer a different question — what we intended — and that
 * is precisely the disagreement a probe exists to catch.
 *
 * **It deliberately does not read argv.** The first version matched `-m <provider>/<model>` there,
 * and the app's grid pill flickered between the model and "own login" while an agent was answering:
 * every re-probe during a turn had to re-parse a live process's command line, and a command line is
 * that process's to rewrite. The file is written once by the launch and is exactly one provider on
 * one grid with one model, so those are read straight out of it — a fact that cannot move.
 *
 * Every failure lands on null. "We cannot tell" and "not on a grid" are treated alike by the caller;
 * the opposite error, claiming a grid nobody verified, would leave an agent quietly somewhere else.
 */
export async function readOpencodeGridAssignment(
  processEnv: Record<string, string>,
): Promise<GridAssignment | null> {
  const configPath = processEnv[OPENCODE_CONFIG_VAR]?.trim()
  if (!configPath) return null
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider?: Record<string, { options?: { baseURL?: unknown }; models?: Record<string, unknown> }>
    }
    const providers = Object.values(raw.provider ?? {})
    // More than one provider is not a file this launch wrote. Rather than guess which one the engine
    // would pick, say nothing — the caller reads that as "not on the grid you picked", which is the
    // safe direction to be wrong in.
    if (providers.length !== 1) return null
    const baseUrl = providers[0].options?.baseURL
    if (typeof baseUrl !== 'string' || !isGridUrl(baseUrl)) return null
    const models = Object.keys(providers[0].models ?? {})
    if (models.length !== 1) return null
    // The router reports as NO model, the same as every other engine launched without one.
    //
    // OpenCode is the only engine whose provider block has to name something, so a launch with no
    // model picked writes the relay's router id there. That is an OpenCode implementation detail and
    // must not leak: the app's own "Auto" is `model: null`, and a raw `Auto` coming back would be the
    // same state under a different name — the header would print the id instead of "Auto", and
    // `assignmentMatches` would compare 'Auto' against null and report every such agent as being on
    // the wrong target, forever. See the desktop's `kAutoModelId`, and the commit that stopped the
    // model menu offering the router beside its own Auto row.
    const model = models[0]
    return { baseUrl, model: model.toLowerCase() === GRID_ROUTER_MODEL.toLowerCase() ? null : model }
  } catch {
    return null
  }
}

/**
 * Read one live engine process's grid.
 *
 * **Three answers, not two.** `null` is a finding — this process was read and is on no grid.
 * `undefined` is the absence of one: the environment could not be read at all, so there is nothing to
 * report. They were the same value until the app's grid pill was seen flickering between an agent's
 * model and "own login" for the length of every turn: each failed read overwrote a known-good
 * assignment with "on no grid", and the next successful one put it back.
 *
 * The reads that fail are ordinary — `ps eww` carries a 2s timeout and a discovery sweep runs one per
 * agent while the machine is busy answering. Which of them fails does not matter, and chasing that
 * was the wrong instinct: what matters is that failing to look must not erase what was already seen.
 * A process's environment cannot change under it (see `processEnv.ts`), so an earlier successful read
 * of THIS process stays true.
 *
 * `gateway` in the same registry has worked this way all along — `undefined` there means "the probe
 * failed" and leaves the stored value alone. Both `openProcessAgent` and `updateProcessIdentity`
 * already guard on `!== undefined`; the grid simply never used it.
 */
export async function probeGridAssignment(
  identity: ProcessIdentity,
  engine: AgentEngine,
  args = '',
): Promise<GridAssignment | null | undefined> {
  const processEnv = await readProcessEnv(identity)
  if (!processEnv) return undefined
  // The two engines whose provider lives in a file this daemon wrote, rather than in a variable.
  if (engine === 'pi') return await readPiGridAssignment(processEnv, args)
  if (engine === 'opencode') return await readOpencodeGridAssignment(processEnv)
  return classifyGridAssignment(engine, processEnv, args)
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
