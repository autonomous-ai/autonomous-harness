import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, basename, dirname, join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { binaryOnPath } from './binaryOnPath.js'
import { engineBin } from './engineBin.js'
import type { EngineInstallRecipe } from './engineInstall.js'
import { managedNodePath } from './nodeRuntime.js'

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
  /** State and account for this Codex process only; never changes the daemon's environment. */
  codexHome?: string
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
  /**
   * A shell line to run in the pane BEFORE the engine, from `engineInstall.ts` — the engine is not on
   * this machine yet and the user agreed to fetch it.
   *
   * It runs inside the same interactive shell the engine is about to be exec'd into, which is the
   * only context where installing helps: `npm`, `node` and `curl` routinely arrive through
   * `.zshrc`/`.bashrc` (nvm, asdf, vendor installers), and a prefix chosen by the daemon's PATH would
   * either not find npm or install into a prefix the engine's own shell cannot then see. The second
   * failure is the dangerous one — it looks like success and leaves the engine still missing.
   *
   * Ignored when there is no interactive shell to wrap with: without one there is no launch script to
   * put it in, and running an installer through a bare `execFile` would use the daemon's PATH, which
   * is the case above.
   */
  installFirst?: string
  /** Install only when command[0] is absent, checked inside the pane's already-started shell. */
  installIfMissing?: EngineInstallRecipe
  /**
   * Environment variables to clear in the pane before the engine starts — the vendor credentials a
   * grid launch must not leave lying around. See `gridConflictingEnvToClear` in `gridLaunch.ts`,
   * which is the only caller and which computes them from what the launch itself sets.
   *
   * It has to happen HERE rather than through tmux, because `tmux new-session -e` can only set a
   * variable, never remove one — and the value being removed was inherited from the tmux server, the
   * daemon, or the terminal that started the app, none of which this process can reach back into.
   *
   * Scoped to the engine's own process. Nothing on disk changes, and a plain shell on the same
   * machine keeps everything it had.
   */
  clearEnv?: readonly string[]
  /** Workspace entered after interactive-shell startup, not before it. */
  cwd?: string
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
  runtimeNode: string = managedNodePath(),
): string[] {
  const command = buildEngineCommandArgv(engine, opts)
  if (opts.codexHome !== undefined && engine !== 'codex') {
    throw new Error('A Codex profile can only be used with Codex')
  }
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return opts.codexHome === undefined
    ? command
    : ['env', `CODEX_HOME=${opts.codexHome}`, ...command]
  // The clear comes FIRST, before the install as well as before the engine. An installer is a child
  // of this shell and inherits what it inherits: `npm` is not going to spend someone's Anthropic key,
  // but an install script that probes for credentials to configure itself would, and the whole point
  // of this launch is that the agent's environment is the one the user asked for.
  // Apply AFTER shell startup, which may itself export a different CODEX_HOME.
  const prelude = clearEnvPrelude(opts.clearEnv)
    + (opts.codexHome === undefined ? '' : `export CODEX_HOME=${shellSingleQuote(opts.codexHome)}\n`)
  // rc files (notably nvm) call getcwd() before running this command. Start the shell in a safe
  // directory and enter the selected workspace only after those files have loaded: an IDE can replace
  // a workspace inode between the desktop picker resolving it and tmux spawning the pane.
  const cwdPrelude = opts.cwd
    ? `if ! cd -- "$1"; then printf '%s\\n' 'harness: the selected working directory is unavailable.' >&2; exit 1; fi\nshift\n`
    : ''
  const body = opts.installIfMissing
    ? installIfMissingThenExecScript(opts.installIfMissing, runtimeNode)
    : opts.installFirst
      ? installThenExecScript(opts.installFirst)
      : 'exec "$@"'
  return [interactive.path, ...interactive.args, prelude + cwdPrelude + body, 'harness-engine', ...(opts.cwd ? [opts.cwd] : []), ...command]
}

/**
 * `unset` for the variables a grid launch must not let through, or nothing at all.
 *
 * Names only — never values — and each is validated against a strict shell-identifier shape before it
 * reaches the script. The list is a constant in our own source today, so this is a guard against a
 * future caller rather than against anything on the wire; it is here because the day that changes is
 * the day nobody re-reads this function.
 */
function clearEnvPrelude(names: readonly string[] | undefined): string {
  const safe = (names ?? []).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  return safe.length ? `unset ${safe.join(' ')}\n` : ''
}

/**
 * Install, then become the engine — or say why not, and stop.
 *
 * Three things this script gets right, each of which was a way to lose:
 *
 *  * **`exec` only on success.** Running the engine after a failed install reproduces the exact
 *    `command not found` this feature exists to replace, with a screenful of npm output above it to
 *    bury the cause.
 *  * **The install line is not interpolated into a command.** It is the vendor's own published line
 *    from `engineInstall.ts` — a constant in our source, never anything a user or a peer supplied —
 *    and it is `eval`ed as the shell line it is written as, because `curl … | bash` is one of them.
 *    Nothing from the wire reaches here; if that ever changes, this is the line that must not.
 *  * **`"$@"` still carries the engine argv positionally**, so engine paths and flags are never
 *    re-parsed by the shell. That property is what the plain `exec "$@"` had and it is preserved.
 *
 * The banner matters more than it looks. A pane that sits silent for forty seconds of `npm install`
 * reads as a hung agent, and the person's next move is to kill it.
 */
function installThenExecScript(install: string): string {
  return [
    `printf '%s\\n' 'harness: installing the engine — this pane becomes the agent when it finishes' 'harness: $ ${install.replace(/'/g, "'\\''")}' ''`,
    `if eval ${JSON.stringify(install)}; then exec "$@"; fi`,
    `printf '\\n%s\\n' 'harness: the install failed, so the agent was not started. The command is above; fix it and create the agent again.'`,
    'exit 1',
  ].join('\n')
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function installedPathCandidates(recipe: EngineInstallRecipe): string[] {
  return [
    ...(recipe.executable.homeRelativePaths ?? []).map((path) => join(homedir(), path)),
    ...(recipe.executable.absolutePaths ?? []),
  ]
}

/**
 * Make npm recipes work on machines where Harness owns Node instead of installing it system-wide.
 *
 * The verified Node archive provisioned by `harness start` includes npm, but the daemon deliberately
 * does not mutate the user's PATH. A tmux login shell can therefore have neither `node` nor `npm`
 * even though the runtime executing Harness has both. Prefer any npm the user already configured;
 * otherwise prepend the managed runtime's bin directory for this pane only. This is portable across
 * macOS and Linux and avoids an interactive/root package-manager install in an agent launch.
 */
function npmRuntimePrelude(recipe: EngineInstallRecipe, runtimeNode: string, required: boolean): string {
  if (!recipe.executable.npmGlobal) return ''
  const bins = [...new Set([dirname(runtimeNode), dirname(process.execPath)])]
    .map(shellSingleQuote)
    .join(' ')
  return [
    'if ! command -v npm >/dev/null 2>&1; then',
    `  for harness_node_bin in ${bins}; do`,
    '    if [ -x "$harness_node_bin/node" ] && [ -x "$harness_node_bin/npm" ]; then',
    '      PATH="$harness_node_bin${PATH:+:$PATH}"',
    '      export PATH',
    '      hash -r 2>/dev/null || true',
    ...(required ? [
      `      printf '%s\\n' 'harness: npm is missing from PATH — enabling Harness managed Node.js/npm'`,
    ] : []),
    '      break',
    '    fi',
    '  done',
    'fi',
    ...(required ? [
      'if ! command -v npm >/dev/null 2>&1; then',
      `  printf '%s\\n' 'harness: npm is unavailable and the managed Node.js/npm runtime could not be used.'`,
      '  exit 1',
      'fi',
    ] : []),
  ].join('\n')
}

/**
 * Install-if-missing has to resolve twice: before installing, and again after it returns.
 *
 * A `curl | bash` installer cannot export PATH back into its parent shell. Several supported
 * vendors correctly put their binary under ~/.local/bin and update a profile for the NEXT shell,
 * which previously made this very pane print `command not found` after a successful install. The
 * source-owned candidate paths below bridge that one-shell gap without sourcing arbitrary profile
 * files a second time. npm installs also get their active global prefix as a fallback.
 */
function installIfMissingThenExecScript(recipe: EngineInstallRecipe, runtimeNode: string): string {
  const install = recipe.command
  const names = recipe.executable.names.map(shellSingleQuote).join(' ')
  const paths = installedPathCandidates(recipe).map(shellSingleQuote).join(' ')
  const candidates = [names, paths].filter(Boolean).join(' ')
  const tryCandidates = candidates
    ? `for candidate in ${candidates}; do try_engine "$candidate" "$@" || true; done`
    : ''
  const tryNpmGlobal = recipe.executable.npmGlobal
    ? [
      'npm_prefix="$(npm prefix -g 2>/dev/null)" || true',
      `if [ -n "$npm_prefix" ]; then for bin in ${names}; do try_engine "$npm_prefix/bin/$bin" "$@" || true; done; fi`,
    ].join('\n')
    : ''
  return [
    'resolve_engine() {',
    '  candidate="$1"',
    '  resolved=""',
    '  case "$candidate" in',
    '    */*) resolved="$candidate" ;;',
    '    *) resolved="$(command -v "$candidate" 2>/dev/null)" || true ;;',
    '  esac',
    '  [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]',
    '}',
    'try_engine() {',
    '  candidate="$1"',
    '  shift',
    '  if ! resolve_engine "$candidate"; then return 1; fi',
    '  shift',
    '  exec "$resolved" "$@"',
    '}',
    'try_engine "$1" "$@" || true',
    tryCandidates,
    npmRuntimePrelude(recipe, runtimeNode, true),
    tryNpmGlobal,
    `printf '%s\\n' 'harness: engine is missing — installing it in this terminal' 'harness: $ ${install.replace(/'/g, "'\\''")}' ''`,
    `if eval ${JSON.stringify(install)}; then`,
    '  hash -r 2>/dev/null || true',
    '  try_engine "$1" "$@" || true',
    `  ${tryCandidates}`,
    tryNpmGlobal.split('\n').map((line) => `  ${line}`).join('\n'),
    `  printf '\\n%s\\n' 'harness: the install completed, but its executable could not be found. Check the installer output and PATH above.'`,
    '  exit 1',
    'fi',
    `printf '\\n%s\\n' 'harness: the install failed, so the agent was not started. The command is above; fix it and create the agent again.'`,
    'exit 1',
  ].filter(Boolean).join('\n')
}

function availabilityScript(recipe: EngineInstallRecipe | undefined): string {
  const names = recipe?.executable.names.map(shellSingleQuote).join(' ') ?? ''
  const paths = recipe ? installedPathCandidates(recipe).map(shellSingleQuote).join(' ') : ''
  const candidates = [names, paths].filter(Boolean).join(' ')
  return [
    ...(recipe ? [npmRuntimePrelude(recipe, managedNodePath(), false)] : []),
    `for candidate in "$@" ${candidates}; do`,
    '  case "$candidate" in',
    '    */*) resolved="$candidate" ;;',
    '    *) resolved="$(command -v "$candidate" 2>/dev/null)" || true ;;',
    '  esac',
    '  if [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]; then exit 0; fi',
    'done',
    ...(recipe?.executable.npmGlobal ? [
      'npm_prefix="$(npm prefix -g 2>/dev/null)" || true',
      'if [ -n "$npm_prefix" ]; then',
      `  for bin in ${names}; do [ -f "$npm_prefix/bin/$bin" ] && [ -x "$npm_prefix/bin/$bin" ] && exit 0; done`,
      'fi',
    ] : []),
    'exit 1',
  ].join('\n')
}

/**
 * Does the same interactive shell that launches a new agent resolve this CLI?
 *
 * The fallback is intentionally the daemon PATH: without a usable absolute
 * SHELL there is no safer context to consult and direct launch is used too.
 */
export async function commandAvailableInInteractiveShell(
  command: string,
  shell: string | undefined = undefined,
  recipe: EngineInstallRecipe | undefined = undefined,
): Promise<boolean> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) {
    return binaryOnPath(command)
      || (recipe ? installedPathCandidates(recipe).some((candidate) => binaryOnPath(candidate)) : false)
  }
  return await new Promise((resolve) => {
    execFile(
      interactive.path,
      [...interactive.args, availabilityScript(recipe), 'harness-engine-probe', command],
      { timeout: 5_000 },
      (error) => resolve(!error),
    )
  })
}
