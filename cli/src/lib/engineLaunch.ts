import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { isAbsolute, basename } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { binaryOnPath } from './binaryOnPath.js'
import { engineBin } from './engineBin.js'

/**
 * Best-effort "skip permission prompts" flag per engine, confirmed against each vendor's own docs.
 * `null` = no known/safe flag — callers must hide the option rather than guess one.
 */
export const BYPASS_PERMISSION_FLAGS: Readonly<Record<AgentEngine, string[] | null>> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  cursor: ['--force'],
  opencode: ['--auto'],
  // No permission-prompt system to bypass (pi), or config-file based rather than a flag (hermes).
  pi: null,
  hermes: null,
  // Unconfirmed — do not guess a flag for a CLI we haven't verified.
  commandcode: null,
  devin: null,
  muse: null,
  amp: null,
  kilo: null,
  grok: null,
  agy: null,
  copilot: null,
}

/**
 * How to name an existing session on the command line, for the engines that need it here.
 *
 * Deliberately separate from `RESUME_ARGS` in `tmux.ts`, which reads argv the other way round to
 * recover an id and omits claude on purpose. This table is for WRITING a launch, and it exists for
 * one caller: moving a running agent to a grid re-execs it, and an engine that came back empty would
 * have thrown away the conversation the user was in the middle of. Only engines that can be pointed
 * at a grid at all need an entry — see `GRID_ENGINE_ENV` in `gridLaunch.ts`.
 */
export const RESUME_FLAGS: Partial<Record<AgentEngine, string>> = {
  claude: '--resume',
}

export interface LaunchCommandOptions {
  bypassPermission?: boolean
  /**
   * Resume this engine session instead of starting a new conversation.
   *
   * Ignored when the engine has no entry in [RESUME_FLAGS], and callers pass null for an agent that
   * has not bound a session yet — there is nothing to resume, and guessing with a `--continue` style
   * flag could attach a DIFFERENT agent's conversation from the same folder.
   */
  resumeSessionId?: string | null
}

/** The executable argv, before the interactive-shell wrapper is applied. */
export function buildEngineCommandArgv(engine: AgentEngine, opts: LaunchCommandOptions = {}): string[] {
  const argv = [engineBin(engine)]
  if (opts.bypassPermission) {
    const flags = BYPASS_PERMISSION_FLAGS[engine]
    if (flags) argv.push(...flags)
  }
  const resumeFlag = opts.resumeSessionId ? RESUME_FLAGS[engine] : undefined
  if (resumeFlag) argv.push(resumeFlag, opts.resumeSessionId as string)
  return argv
}

export interface InteractiveEngineShell {
  path: string
  args: readonly string[]
  label: string
}

/**
 * The shell users get in a terminal is not the detached daemon's environment.
 *
 * zsh needs its login files as well as .zshrc; Ubuntu's usual bash setup puts
 * nvm/asdf and vendor PATH edits in .bashrc, so it must be interactive but not
 * login.  Other POSIX-like shells get the portable interactive form.
 */
function currentUserShell(): string | undefined {
  if (process.env.SHELL && isAbsolute(process.env.SHELL)) return process.env.SHELL
  try {
    const shell = userInfo().shell
    return shell && isAbsolute(shell) ? shell : undefined
  } catch {
    return undefined
  }
}

export function interactiveEngineShell(shell: string | undefined = undefined): InteractiveEngineShell | null {
  const candidate = shell === undefined ? currentUserShell() : shell
  if (!candidate || !isAbsolute(candidate)) return null
  switch (basename(candidate).toLowerCase()) {
    case 'zsh': return { path: candidate, args: ['-lic'], label: 'zsh login shell' }
    case 'bash': return { path: candidate, args: ['-ic'], label: 'bash interactive shell' }
    default: return { path: candidate, args: ['-ic'], label: `${basename(candidate)} interactive shell` }
  }
}

/**
 * Full argv for a fresh tmux pane. `exec` replaces the shell with the engine,
 * preserving process discovery while loading the same startup files a user
 * gets in Terminal/iTerm/Ubuntu Terminal. Arguments are positional, not a
 * shell command string, so engine paths and flags cannot be interpolated.
 */
export function buildEngineLaunchArgv(
  engine: AgentEngine,
  opts: LaunchCommandOptions = {},
  shell: string | undefined = undefined,
): string[] {
  const command = buildEngineCommandArgv(engine, opts)
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return command
  return [interactive.path, ...interactive.args, 'exec "$@"', 'harness-engine', ...command]
}

const AVAILABILITY_SCRIPT = 'resolved="$(command -v "$1" 2>/dev/null)" || exit 1\n'
  + '[ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]'

/**
 * Does the same interactive shell that launches a new agent resolve this CLI?
 *
 * The fallback is intentionally the daemon PATH: without a usable absolute
 * SHELL there is no safer context to consult and direct launch is used too.
 */
export async function commandAvailableInInteractiveShell(
  command: string,
  shell: string | undefined = undefined,
): Promise<boolean> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return binaryOnPath(command)
  return await new Promise((resolve) => {
    execFile(
      interactive.path,
      [...interactive.args, AVAILABILITY_SCRIPT, 'harness-engine-probe', command],
      { timeout: 5_000 },
      (error) => resolve(!error),
    )
  })
}
