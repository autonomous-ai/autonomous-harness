import type { LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'

export type AgentEngine = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin'

export interface EngineNormalizer {
  ingest(line: string): LiveEvent[]
  finishReplay(): LiveEvent[]
  readonly turnOpen: boolean
}

export interface EngineAdapter {
  readonly engine: AgentEngine
  createNormalizer(session: RegisteredSession, mode: 'live' | 'replay'): EngineNormalizer
}
