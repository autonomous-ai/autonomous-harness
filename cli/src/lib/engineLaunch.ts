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

export interface LaunchCommandOptions {
  bypassPermission?: boolean
  /** Resume this engine session id on launch, when a launch-resume flag is known for the engine. */
  resumeSessionId?: string
  /**
   * Extra argv the caller has already composed, appended last.
   *
   * Exists for engines whose endpoint is configured on the command line rather than through the
   * environment — Codex's `-c model_providers.*`, Grok's `-m`. See `gridLaunch.ts`; a credential
   * never travels this way.
   */
  extraArgs?: readonly string[]
}

/**
 * Best-known "resume this session id" launch flag per engine — kept SEPARATE from tmux.ts's
 * `RESUME_ARGS` (parsing-only, reverse-engineered from an already-running process's argv, never proven
 * as a launch argument). `claude` and `codex` are populated here from confirmed real invocations (see
 * the `resumeSessionId` test fixtures in tmux.spec.ts: `'claude --resume <id>'`, `'codex resume <id>'`)
 * even though `RESUME_ARGS` has no entry for either — that map's silence reflects that neither engine
 * ever needed argv-based repair (both fire their own SessionStart hook on resume), not an absent flag.
 * `amp` needs its full subcommand chain (`amp threads continue <id>`, confirmed by the same fixture
 * file) rather than the bare `continue` alternative `RESUME_ARGS` also accepts for parsing purposes.
 *
 * A wrong or unsupported entry here is not fatal: restart (cli.ts's `onRestartAgent`) falls back to a
 * fresh, no-resume relaunch automatically if the flagged relaunch doesn't produce a recognizable
 * process within budget — a working agent under a fresh session beats a dead pane.
 *
 * Moving a running agent to a grid re-execs it through the same path, and relies on the same table for
 * the same reason: an engine that came back with no way to resume would have thrown away the
 * conversation the user was in the middle of.
 *
 * A leading token that does NOT start with `-` is a SUBCOMMAND (`resume`, `threads continue`) and must
 * be the first argv after the binary, ahead of any other flag — `buildEngineCommandArgv` branches on
 * this. `devin` has no known resume flag at all (not even for `RESUME_ARGS` parsing) and is
 * deliberately omitted, so no resume is ever attempted for it.
 */
export const LAUNCH_RESUME_FLAG: Readonly<Partial<Record<AgentEngine, string[]>>> = {
  claude: ['--resume'],
  codex: ['resume'],
  cursor: ['--resume'],
  opencode: ['--session'],
  kilo: ['--session'],
  pi: ['--session'],
  hermes: ['--resume'],
  commandcode: ['--resume'],
  muse: ['resume'],
  amp: ['threads', 'continue'],
  grok: ['--resume'],
  agy: ['--conversation'],
  copilot: ['--resume'],
}

/** The executable argv, before the interactive-shell wrapper is applied. */
export function buildEngineCommandArgv(engine: AgentEngine, opts: LaunchCommandOptions = {}): string[] {
  const argv = [engineBin(engine)]
  const resumeFlag = opts.resumeSessionId ? LAUNCH_RESUME_FLAG[engine] : undefined
  const resumeIsSubcommand = !!resumeFlag?.length && !resumeFlag[0].startsWith('-')
  // Subcommand-style resume (`codex resume <id>`, `amp threads continue <id>`, `muse resume <id>`) is
  // parsed positionally and must be the first argv after the binary, ahead of any other flag.
  if (resumeIsSubcommand && resumeFlag && opts.resumeSessionId) {
    argv.push(...resumeFlag, opts.resumeSessionId)
  }
  if (opts.bypassPermission) {
    const flags = BYPASS_PERMISSION_FLAGS[engine]
    if (flags) argv.push(...flags)
  }
  if (!resumeIsSubcommand && resumeFlag && opts.resumeSessionId) {
    argv.push(...resumeFlag, opts.resumeSessionId)
  }
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs)
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
