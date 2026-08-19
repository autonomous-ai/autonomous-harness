import type { LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'

/**
 * Every engine this CLI integrates, as a value.
 *
 * `AgentEngine` alone cannot be iterated, and analytics has to report exactly what it instruments —
 * so the list lives here once and both forms are derived from it. A new engine added to the union
 * without being added here fails to compile.
 */
export const ENGINES = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes',
  'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot',
] as const

export type AgentEngine = (typeof ENGINES)[number]

export interface EngineNormalizer {
  ingest(line: string): LiveEvent[]
  finishReplay(): LiveEvent[]
  readonly turnOpen: boolean
}

export interface EngineAdapter {
  readonly engine: AgentEngine
  createNormalizer(session: RegisteredSession, mode: 'live' | 'replay'): EngineNormalizer
}
