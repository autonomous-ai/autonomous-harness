/**
 * Per-engine CLI binary resolution — the single source of truth shared by the recap one-shots
 * (`oneshot.ts`) plus process discovery and user-facing command hints.
 *
 * Each engine honours its own `*_PATH` override (see `config/env.ts`) and otherwise resolves the plain
 * command name from PATH. `codex` reads `process.env` directly because it has no entry in the validated
 * env schema (only `CODEX_HOME` does) — kept as-is so behaviour matches what oneshot.ts already shipped.
 */

import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'

/** Every engine the adapter can discover and drive. */
export const ENGINES: readonly AgentEngine[] = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok',
] as const

/** Public vendor command shown to users and matched by the real-binary smoke matrix. */
export const ENGINE_CLI_COMMANDS: Readonly<Record<AgentEngine, string>> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'agent',
  opencode: 'opencode',
  pi: 'pi',
  hermes: 'hermes',
  commandcode: 'cmd',
  devin: 'devin',
  muse: 'muse',
  amp: 'amp',
  kilo: 'kilo',
  grok: 'grok',
}

export function engineBin(engine: AgentEngine): string {
  switch (engine) {
    case 'claude': return env.CLAUDE_PATH || ENGINE_CLI_COMMANDS.claude
    case 'codex': return process.env.CODEX_PATH || ENGINE_CLI_COMMANDS.codex
    // Cursor's CLI is installed as `agent`, not `cursor`.
    case 'cursor': return env.CURSOR_PATH || ENGINE_CLI_COMMANDS.cursor
    case 'opencode': return env.OPENCODE_PATH || ENGINE_CLI_COMMANDS.opencode
    case 'pi': return env.PI_PATH || ENGINE_CLI_COMMANDS.pi
    case 'hermes': return env.HERMES_PATH || ENGINE_CLI_COMMANDS.hermes
    // command-code's package `bin` lists `cmd` first and its README uses it.
    case 'commandcode': return env.COMMANDCODE_PATH || ENGINE_CLI_COMMANDS.commandcode
    case 'devin': return env.DEVIN_PATH || ENGINE_CLI_COMMANDS.devin
    case 'muse': return env.MUSE_PATH || ENGINE_CLI_COMMANDS.muse
    case 'amp': return env.AMP_PATH || ENGINE_CLI_COMMANDS.amp
    case 'kilo': return env.KILO_PATH || ENGINE_CLI_COMMANDS.kilo
    case 'grok': return env.GROK_PATH || ENGINE_CLI_COMMANDS.grok
  }
}
