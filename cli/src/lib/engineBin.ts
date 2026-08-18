/**
 * Per-engine command labels, explicit binary overrides, and local executable ownership.
 *
 * User-facing labels stay stable, while process discovery and Cursor recap use file identity so the
 * colliding `agent` alias is never assigned from its basename alone.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, normalize, sep } from 'node:path'
import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'

/** Every engine the adapter can discover and drive. */
export const ENGINES: readonly AgentEngine[] = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok',
  'agy',
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
  agy: 'agy',
}

export interface ExecutableFileIdentity {
  path: string
  realPath: string
  fileKey: string
}

export type AgentAliasOwner = 'cursor' | 'grok' | 'unknown' | 'conflict'

/**
 * Per-machine evidence used only for the colliding `agent` command.
 *
 * Cursor installs `agent` and `cursor-agent` as aliases of one launcher. Grok Build installs `agent`
 * and `grok` as aliases of one compiled binary. Comparing the resolved file is independent of PATH
 * order, symlink depth, package-manager prefix, and the name retained in `ps`.
 */
export interface AgentCommandOwnershipSnapshot {
  cursorFileKeys: ReadonlySet<string>
  grokFileKeys: ReadonlySet<string>
  conflictingFileKeys: ReadonlySet<string>
  agentCandidates: readonly ExecutableFileIdentity[]
  cursorAgentCandidates: readonly ExecutableFileIdentity[]
  grokCandidates: readonly ExecutableFileIdentity[]
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

function looksLikePath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\')
}

/** Resolve every visible command candidate, not only the first PATH hit. */
function commandCandidates(command: string): ExecutableFileIdentity[] {
  const paths = looksLikePath(command)
    ? [command]
    : pathEntries().map((entry) => join(entry, command))
  const seen = new Set<string>()
  const result: ExecutableFileIdentity[] = []
  for (const path of paths) {
    try { accessSync(path, constants.X_OK) } catch { continue }
    const identity = executableFileIdentity(path)
    if (!identity || seen.has(identity.path)) continue
    seen.add(identity.path)
    result.push(identity)
  }
  return result
}

/** Stable while a file exists; deliberately local-only and never sent over the wire. */
export function executableFileIdentity(path: string): ExecutableFileIdentity | null {
  try {
    const realPath = realpathSync(path)
    const stat = statSync(realPath)
    if (!stat.isFile()) return null
    return { path: normalize(path), realPath, fileKey: `${String(stat.dev)}:${String(stat.ino)}` }
  } catch {
    return null
  }
}

function cursorInstallLayout(path: string): boolean {
  const normalized = path.split(sep).join('/')
  return /\/cursor-agent\/versions\/[^/]+\/cursor-agent$/.test(normalized)
}

function addAll(target: Set<string>, identities: readonly ExecutableFileIdentity[]): void {
  for (const identity of identities) target.add(identity.fileKey)
}

/** Build once per process-table pass; callers pass the snapshot through every row comparison. */
export function agentCommandOwnershipSnapshot(): AgentCommandOwnershipSnapshot {
  const agentCandidates = commandCandidates('agent')
  const cursorAgentCandidates = commandCandidates('cursor-agent')
  const grokCandidates = [...commandCandidates('grok')]

  const cursorFileKeys = new Set<string>()
  const grokFileKeys = new Set<string>()
  addAll(cursorFileKeys, cursorAgentCandidates)
  addAll(grokFileKeys, grokCandidates)

  // Existing explicit overrides are ownership declarations, but a declaration that resolves to the
  // other vendor's canonical binary becomes a conflict below instead of silently winning by basename.
  if (env.CURSOR_PATH) addAll(cursorFileKeys, commandCandidates(env.CURSOR_PATH))
  if (env.GROK_PATH) addAll(grokFileKeys, commandCandidates(env.GROK_PATH))

  // Grok's own state-root override already describes its standard installer root. This seed keeps
  // discovery correct when the daemon PATH differs from an interactive tmux shell's PATH.
  const grokHomeBin = commandCandidates(join(env.GROK_HOME, 'bin', 'grok'))[0]
  if (grokHomeBin) {
    grokFileKeys.add(grokHomeBin.fileKey)
    if (!grokCandidates.some((candidate) => candidate.path === grokHomeBin.path)) grokCandidates.push(grokHomeBin)
  }

  // Cursor's launcher target carries a vendor-specific package layout even when `cursor-agent` itself
  // is absent from the daemon PATH (for example, a pane inherited a newer interactive shell PATH).
  for (const candidate of agentCandidates) {
    if (cursorInstallLayout(candidate.realPath)) cursorFileKeys.add(candidate.fileKey)
  }

  const conflictingFileKeys = new Set(
    [...cursorFileKeys].filter((fileKey) => grokFileKeys.has(fileKey)),
  )
  return {
    cursorFileKeys,
    grokFileKeys,
    conflictingFileKeys,
    agentCandidates,
    cursorAgentCandidates,
    grokCandidates,
  }
}

export function agentAliasOwner(
  fileKeys: readonly (string | null | undefined)[],
  snapshot: AgentCommandOwnershipSnapshot,
): AgentAliasOwner {
  let cursor = false
  let grok = false
  for (const fileKey of fileKeys) {
    if (!fileKey) continue
    if (snapshot.conflictingFileKeys.has(fileKey)) return 'conflict'
    if (snapshot.cursorFileKeys.has(fileKey)) cursor = true
    if (snapshot.grokFileKeys.has(fileKey)) grok = true
  }
  if (cursor && grok) return 'conflict'
  if (cursor) return 'cursor'
  if (grok) return 'grok'
  return 'unknown'
}

/**
 * Cursor recap must never spawn Grok merely because Grok won the `agent` name in this daemon's PATH.
 * Return null when the machine offers no verified Cursor command; the worker then fails explicitly.
 */
export function cursorRuntimeBin(snapshot = agentCommandOwnershipSnapshot()): string | null {
  if (env.CURSOR_PATH) {
    const configured = commandCandidates(env.CURSOR_PATH)[0]
    if (!configured) return null
    return agentAliasOwner([configured.fileKey], snapshot) === 'grok'
      || agentAliasOwner([configured.fileKey], snapshot) === 'conflict'
      ? null
      : env.CURSOR_PATH
  }

  const agent = snapshot.agentCandidates[0]
  if (agent && agentAliasOwner([agent.fileKey], snapshot) === 'cursor') return 'agent'
  const cursorAgent = snapshot.cursorAgentCandidates[0]
  if (cursorAgent && agentAliasOwner([cursorAgent.fileKey], snapshot) === 'cursor') return 'cursor-agent'
  return null
}

/** Resolve an installed executable for real-engine verification without trusting a colliding alias. */
export function installedEngineBin(
  engine: AgentEngine,
  snapshot = agentCommandOwnershipSnapshot(),
): string | null {
  const command = engine === 'cursor' ? cursorRuntimeBin(snapshot) : engineBin(engine)
  if (!command) return null
  const candidates = commandCandidates(command)
  if (engine === 'cursor' || engine === 'grok') {
    return candidates.find((candidate) => agentAliasOwner([candidate.fileKey], snapshot) === engine)?.path ?? null
  }
  return candidates[0]?.path ?? null
}

/** Existing env override only; process matching must not treat a default basename as ownership proof. */
export function enginePathOverride(engine: AgentEngine): string | undefined {
  switch (engine) {
    case 'claude': return env.CLAUDE_PATH
    case 'codex': return process.env.CODEX_PATH
    case 'cursor': return env.CURSOR_PATH
    case 'opencode': return env.OPENCODE_PATH
    case 'pi': return env.PI_PATH
    case 'hermes': return env.HERMES_PATH
    case 'commandcode': return env.COMMANDCODE_PATH
    case 'devin': return env.DEVIN_PATH
    case 'muse': return env.MUSE_PATH
    case 'amp': return env.AMP_PATH
    case 'kilo': return env.KILO_PATH
    case 'grok': return env.GROK_PATH
    case 'agy': return env.AGY_PATH
  }
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
    case 'agy': return env.AGY_PATH || ENGINE_CLI_COMMANDS.agy
  }
}
