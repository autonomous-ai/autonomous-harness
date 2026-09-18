import type { LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'

/**
 * Every engine this CLI integrates, as a value.
 *
 * `AgentEngine` alone cannot be iterated, and several places (discovery, hooks, probes) need to walk
 * every engine — so the list lives here once and both forms are derived from it. A new engine added
 * to the union without being added here fails to compile.
 */
export const ENGINES = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes',
  'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot',
  'terminal',
] as const

export type AgentEngine = (typeof ENGINES)[number]

/**
 * The one engine that is not a program: a plain login shell in a harness pane, opened by the
 * desktop's New Terminal. It has no binary to launch, no hooks, no session, no process signature —
 * the pane is the whole agent. When an engine CLI is started INSIDE it the row adopts that engine
 * (`registry.adoptEngine`) and drops back to `terminal` when it exits (`registry.releaseEngine`).
 */
export const TERMINAL_ENGINE = 'terminal' satisfies AgentEngine
export type TerminalEngine = typeof TERMINAL_ENGINE
/** An engine that is a program: every engine but the terminal. */
export type ProcessEngine = Exclude<AgentEngine, TerminalEngine>

export function isTerminalEngine(engine: string | null | undefined): engine is TerminalEngine {
  return engine === TERMINAL_ENGINE
}

/**
 * Every engine that runs as a recognizable process — what discovery scans a pane for. A shell is
 * deliberately not in it: a pane whose only process is a shell is a terminal, not an engine waiting
 * to be found.
 */
export const PROCESS_ENGINES: readonly ProcessEngine[] = ENGINES.filter((engine): engine is ProcessEngine => !isTerminalEngine(engine))

export interface EngineNormalizer {
  ingest(line: string): LiveEvent[]
  finishReplay(): LiveEvent[]
  readonly turnOpen: boolean
}

export interface EngineAdapter {
  readonly engine: AgentEngine
  createNormalizer(session: RegisteredSession, mode: 'live' | 'replay'): EngineNormalizer
}
