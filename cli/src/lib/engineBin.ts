/**
 * Per-engine command labels, explicit binary overrides, and local executable ownership.
 *
 * User-facing labels stay stable, while process discovery and Cursor recap use file identity so the
 * colliding `agent` alias is never assigned from its basename alone.
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, normalize, sep } from 'node:path'
import { env } from '../config/env.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'

// Keep this historical import surface for callers, but never duplicate the
// catalog here. `engines/types.ts` is the one iterable source of truth.
export { ENGINES }

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
  copilot: 'copilot',
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
  /** Installed command/override identities for every engine, not only the colliding `agent` alias. */
  engineFileKeys?: ReadonlyMap<AgentEngine, ReadonlySet<string>>
  engineCandidates?: ReadonlyMap<AgentEngine, readonly ExecutableFileIdentity[]>
  cursorFileKeys: ReadonlySet<string>
  grokFileKeys: ReadonlySet<string>
  conflictingFileKeys: ReadonlySet<string>
  agentCandidates: readonly ExecutableFileIdentity[]
  cursorAgentCandidates: readonly ExecutableFileIdentity[]
  grokCandidates: readonly ExecutableFileIdentity[]
}

/** Commands whose public aliases can legitimately identify the same engine. */
export const ENGINE_CLI_ALIASES: Readonly<Record<AgentEngine, readonly string[]>> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['agent', 'cursor-agent'],
  opencode: ['opencode'],
  pi: ['pi'],
  hermes: ['hermes', 'hermes-agent'],
  commandcode: ['cmd', 'command-code', 'commandcode'],
  devin: ['devin'],
  muse: ['muse'],
  amp: ['amp'],
  kilo: ['kilo', 'kilocode'],
  grok: ['grok', 'agent'],
  agy: ['agy'],
  copilot: ['copilot'],
}

let interactivePathCache: { shell: string; daemonPath: string; value: string[] } | null = null

/**
 * Resolve commands from the same shell startup context used by New Agent.
 *
 * A GUI/launchd/systemd daemon commonly lacks ~/.local/bin, Homebrew, nvm and vendor installer edits.
 * Looking only at its PATH made an installed native binary impossible to identify even though the pane
 * launched it successfully. Tests deliberately use their injected PATH and never read a developer's rc.
 */
function interactivePathEntries(): string[] {
  if (process.env.NODE_ENV === 'test') return []
  const shell = process.env.SHELL
  if (!shell || !isAbsolute(shell)) return []
  const daemonPath = process.env.PATH ?? ''
  if (interactivePathCache?.shell === shell && interactivePathCache.daemonPath === daemonPath) {
    return interactivePathCache.value
  }
  try {
    const flag = basename(shell).toLowerCase() === 'zsh' ? '-lic' : '-ic'
    const marker = '__HARNESS_ENGINE_PATH__='
    const stdout = execFileSync(shell, [flag, `printf '\n${marker}%s\n' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // Shell startup files are allowed to print banners. Read only our final marked line.
    const path = stdout.split('\n').reverse().find((line) => line.startsWith(marker))?.slice(marker.length) ?? ''
    const value = path.split(delimiter).filter(Boolean)
    interactivePathCache = { shell, daemonPath, value }
    return value
  } catch {
    interactivePathCache = { shell, daemonPath, value: [] }
    return []
  }
}

/** Only what a spawned child inherits. A hit here is safe to return as a bare name. */
function processPathEntries(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

function pathEntries(): string[] {
  return [...new Set([
    ...processPathEntries(),
    ...interactivePathEntries(),
  ])]
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
    // Stat through the supplied path first. `/proc/<pid>/exe` keeps the running inode reachable even
    // after an auto-updater replaces its pathname; realpath may then end in "(deleted)" and be
    // unstatable despite the process image still being valid.
    const stat = statSync(path)
    if (!stat.isFile()) return null
    let realPath: string
    try { realPath = realpathSync(path) } catch {
      try { realPath = readlinkSync(path) } catch { realPath = normalize(path) }
    }
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

function vendorFallbackCommands(engine: AgentEngine): string[] {
  const home = homedir()
  switch (engine) {
    case 'claude': return [join(home, '.local', 'bin', 'claude')]
    case 'cursor': return [join(home, '.local', 'bin', 'agent'), join(home, '.local', 'bin', 'cursor-agent')]
    case 'opencode': return [join(home, '.opencode', 'bin', 'opencode')]
    case 'hermes': return [join(home, '.local', 'bin', 'hermes')]
    case 'devin': return [join(home, '.local', 'bin', 'devin')]
    case 'muse': return [join(home, '.local', 'bin', 'muse')]
    case 'amp': return [join(home, '.amp', 'bin', 'amp'), join(home, '.local', 'bin', 'amp')]
    case 'kilo': return [join(home, '.kilo', 'bin', 'kilo'), join(home, '.local', 'bin', 'kilo')]
    case 'grok': return [join(env.GROK_HOME, 'bin', 'grok'), join(home, '.local', 'bin', 'grok')]
    case 'agy': return [join(home, '.local', 'bin', 'agy')]
    case 'copilot': return [join(home, '.local', 'bin', 'copilot')]
    default: return []
  }
}

function uniqueIdentities(identities: readonly ExecutableFileIdentity[]): ExecutableFileIdentity[] {
  const seen = new Set<string>()
  return identities.filter((identity) => {
    const key = `${identity.path}\0${identity.fileKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Build once per process-table pass; callers pass the snapshot through every row comparison. */
export function engineBinaryOwnershipSnapshot(): AgentCommandOwnershipSnapshot {
  const engineCandidates = new Map<AgentEngine, ExecutableFileIdentity[]>()
  const engineFileKeys = new Map<AgentEngine, Set<string>>()
  for (const engine of ENGINES) {
    const configured = enginePathOverride(engine)
    const commands = [
      ...(configured ? [configured] : []),
      ...ENGINE_CLI_ALIASES[engine],
      ...vendorFallbackCommands(engine),
    ]
    const candidates = uniqueIdentities(commands.flatMap(commandCandidates))
    engineCandidates.set(engine, candidates)
    engineFileKeys.set(engine, new Set(candidates.map((candidate) => candidate.fileKey)))
  }

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
  // `agent` is intentionally present in both public alias lists. Replace the generic sets with the
  // vendor-qualified ownership derived above so one PATH entry never makes both engines match.
  engineFileKeys.set('cursor', cursorFileKeys)
  engineFileKeys.set('grok', grokFileKeys)
  engineCandidates.set('cursor', (engineCandidates.get('cursor') ?? []).filter((candidate) =>
    cursorFileKeys.has(candidate.fileKey) && !conflictingFileKeys.has(candidate.fileKey)))
  engineCandidates.set('grok', (engineCandidates.get('grok') ?? []).filter((candidate) =>
    grokFileKeys.has(candidate.fileKey) && !conflictingFileKeys.has(candidate.fileKey)))
  return {
    engineFileKeys,
    engineCandidates,
    cursorFileKeys,
    grokFileKeys,
    conflictingFileKeys,
    agentCandidates,
    cursorAgentCandidates,
    grokCandidates,
  }
}

/** Historical name retained while callers migrate; the snapshot now covers every engine. */
export function agentCommandOwnershipSnapshot(): AgentCommandOwnershipSnapshot {
  return engineBinaryOwnershipSnapshot()
}

/** Engines owning the observed executable image. Multiple results mean the install itself is ambiguous. */
export function engineFileOwners(
  fileKeys: readonly (string | null | undefined)[],
  snapshot: AgentCommandOwnershipSnapshot,
): AgentEngine[] {
  if (!snapshot.engineFileKeys) return []
  return ENGINES.filter((engine) => fileKeys.some((fileKey) => !!fileKey && snapshot.engineFileKeys!.get(engine)?.has(fileKey)))
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

/**
 * Where OpenCode is, for the processes this daemon spawns.
 *
 * It installs itself to `~/.opencode/bin` and puts that on PATH by editing the user's SHELL profile —
 * which a GUI-launched process never reads. This daemon is started by the desktop app, so `opencode`
 * is simply not on its PATH: the recap pool logged `spawn opencode ENOENT` once a second and the
 * model catalog came back empty every time, while the same command worked fine from a terminal.
 *
 * ONE answer for the whole daemon, because there were two and they disagreed: the recap path honoured
 * `OPENCODE_PATH` and the catalog fetch did not.
 *
 * `OPENCODE_PATH` wins; a bare `opencode` remains the last answer, so a genuinely missing install
 * still fails with the message it always did.
 */
export function opencodeBin(): string {
  if (env.OPENCODE_PATH) return env.OPENCODE_PATH
  // THE CHILD'S PATH FIRST, and only that one may answer with a bare name.
  //
  // `pathEntries()` searches the interactive login shell's PATH as well as this
  // process's, and a spawned child inherits only the latter. A hit in a
  // shell-only directory therefore resolved here and then failed to spawn with
  // `ENOENT` — which is how the fallback below, added for exactly this bug, was
  // being skipped: the loop kept FINDING opencode and kept returning a name the
  // child could not resolve. Measured on a live daemon: 44 entries in the
  // process PATH, 48 in the interactive one, and `~/.opencode/bin` among the
  // four that only the shell knows about.
  for (const entry of processPathEntries()) {
    try {
      accessSync(join(entry, 'opencode'), constants.X_OK)
      return 'opencode'
    } catch { /* keep looking */ }
  }
  // Anywhere else it is reachable, it travels as an absolute path.
  for (const entry of pathEntries()) {
    const candidate = join(entry, 'opencode')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  const installed = join(homedir(), '.opencode', 'bin', 'opencode')
  try {
    accessSync(installed, constants.X_OK)
    return installed
  } catch {
    return 'opencode'
  }
}

/** Resolve an installed executable for real-engine verification without trusting a colliding alias. */
export function installedEngineBin(
  engine: AgentEngine,
  snapshot = agentCommandOwnershipSnapshot(),
): string | null {
  const installed = snapshot.engineCandidates?.get(engine)
  if (installed?.length && engine !== 'cursor' && engine !== 'grok') return installed[0].path
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
    case 'copilot': return env.COPILOT_PATH
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
    case 'copilot': return env.COPILOT_PATH || ENGINE_CLI_COMMANDS.copilot
  }
}
