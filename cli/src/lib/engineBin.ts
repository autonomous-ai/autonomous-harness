/**
 * Per-engine CLI binary resolution — the single source of truth shared by the recap one-shots
 * (`oneshot.ts`) and the `harness <engine>` launcher (`launch.ts`).
 *
 * Each engine honours its own `*_PATH` override (see `config/env.ts`) and otherwise resolves the plain
 * command name from PATH. `codex` reads `process.env` directly because it has no entry in the validated
 * env schema (only `CODEX_HOME` does) — kept as-is so behaviour matches what oneshot.ts already shipped.
 */

import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'

/** Every engine the adapter can drive — also the set of `harness <engine>` launch subcommands. */
export const ENGINES: readonly AgentEngine[] = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse',
] as const

/**
 * Names users actually type. Several CLIs install more than one binary for the same product, and people
 * reach for whichever one they know — `harness cmd` must mean Command Code, not "unknown command".
 * Verified on disk: command-code ships `commandcode`/`command-code`/`cmd`/`cmdc` (all the same file), and
 * Cursor's CLI is installed as `agent` / `cursor-agent`.
 */
const ENGINE_ALIASES: Readonly<Record<string, AgentEngine>> = {
  cmd: 'commandcode',
  cmdc: 'commandcode',
  'command-code': 'commandcode',
  agent: 'cursor',
  'cursor-agent': 'cursor',
}

/**
 * The spelling machine ADVERTISES for an engine, which is not always its id. The id is an internal name
 * — it travels to the web, the device and the database, so it stays put — but help should tell you to
 * type what the vendor calls their CLI. Command Code's own usage line reads `cmd <command> [options]`
 * and `cmd` is the first entry in its package `bin`, so the command to show is `harness cmd`.
 */
const PRIMARY_COMMAND: Partial<Record<AgentEngine, string>> = {
  commandcode: 'cmd',
}

/** What to print as `harness <this>` for an engine. Every spelling still works — see aliasesFor. */
export function engineCommand(engine: AgentEngine): string {
  return PRIMARY_COMMAND[engine] ?? engine
}

export function isEngine(value: string): value is AgentEngine {
  return (ENGINES as readonly string[]).includes(value)
}

/** The canonical engine for a name the user typed (its own id or a known alias), else null. */
export function resolveEngine(value: string): AgentEngine | null {
  if (isEngine(value)) return value
  return ENGINE_ALIASES[value] ?? null
}

/**
 * The other accepted spellings for an engine, for help text — everything it answers to except the one
 * already shown as primary. That includes the engine's own id when the primary is a vendor name, so
 * `harness commandcode` is still documented as working, just no longer the headline.
 */
export function aliasesFor(engine: AgentEngine): string[] {
  const primary = engineCommand(engine)
  const spellings = [
    engine as string,
    ...Object.entries(ENGINE_ALIASES).filter(([, e]) => e === engine).map(([a]) => a),
  ]
  return spellings.filter((name) => name !== primary)
}

export function engineBin(engine: AgentEngine): string {
  switch (engine) {
    case 'claude': return env.CLAUDE_PATH || 'claude'
    case 'codex': return process.env.CODEX_PATH || 'codex'
    // Cursor's CLI is installed as `agent`, not `cursor`.
    case 'cursor': return env.CURSOR_PATH || 'agent'
    case 'opencode': return env.OPENCODE_PATH || 'opencode'
    case 'pi': return env.PI_PATH || 'pi'
    case 'hermes': return env.HERMES_PATH || 'hermes'
    // command-code's package `bin` lists `cmd` first and its README uses it — that is the official
    // command. (`cmdc`/`command-code`/`commandcode` are the same file, kept as aliases below.)
    case 'commandcode': return env.COMMANDCODE_PATH || 'cmd'
    case 'devin': return env.DEVIN_PATH || 'devin'
    case 'muse': return env.MUSE_PATH || 'muse'
  }
}
