import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, basename, dirname, join } from 'node:path'
import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import { binaryOnPath, resolveBinaryOnPath } from './binaryOnPath.js'
import { engineBin } from './engineBin.js'
import type { EngineInstallRecipe } from './engineInstall.js'
import { GRID_NO_UPDATE_CHECK_VAR, gridBinaryPath } from './gridExec.js'
import { managedNodePath } from './nodeRuntime.js'
import { RAISE_OPEN_FILES_SH } from './openFiles.js'
import { ENGINE_EXIT_PANE_OPTION } from './tmux.js'

/**
 * Best-effort "skip permission prompts" flag per engine, confirmed against each vendor's own docs.
 * `null` = no known/safe flag — callers must hide the option rather than guess one.
 */
export const BYPASS_PERMISSION_FLAGS: Readonly<Record<AgentEngine, string[] | null>> = {
  // The engines' own auto modes, not their "skip every check" switches: Claude Code's auto mode
  // approves routine actions and still runs its safety checks on risky ones, and Codex routes each
  // approval to its automatic review and keeps commands in the workspace sandbox.
  claude: ['--permission-mode', 'auto'],
  codex: ['--approve-for-me'],
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
  // A shell has no permissions to bypass.
  terminal: null,
}

/**
 * The permission modes a person can pick for a new agent (New Harness ▸ Advanced), per engine, and the
 * argv each one launches with. `auto` is the default and is exactly [BYPASS_PERMISSION_FLAGS]; `ask`
 * adds nothing, so the engine behaves as its own settings say; the rest are the engines' documented
 * modes (`claude --help`: `--permission-mode acceptEdits|plan`; `codex --help`: `--sandbox read-only`,
 * `--dangerously-bypass-approvals-and-sandbox`). An engine absent here offers no choice.
 *
 * The desktop mirrors this table in `lib/core/permission_modes.dart` — keep both in step.
 */
export const PERMISSION_MODES: Readonly<Partial<Record<AgentEngine, Readonly<Record<string, readonly string[]>>>>> = {
  claude: {
    auto: ['--permission-mode', 'auto'],
    acceptEdits: ['--permission-mode', 'acceptEdits'],
    plan: ['--permission-mode', 'plan'],
    ask: [],
    full: ['--dangerously-skip-permissions'],
  },
  codex: {
    auto: ['--approve-for-me'],
    readOnly: ['--sandbox', 'read-only'],
    ask: [],
    full: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  cursor: { auto: ['--force'], ask: [] },
  opencode: { auto: ['--auto'], ask: [] },
}

/** The argv of [mode] for [engine], or null when the engine has no such mode. */
export function permissionModeFlags(engine: AgentEngine, mode: string): readonly string[] | null {
  const modes = PERMISSION_MODES[engine]
  return modes && Object.hasOwn(modes, mode) ? modes[mode] : null
}

/** Whether [mode] lets the agent act without stopping to ask — what `bypassPermission` records. */
export function permissionModeApproves(mode: string): boolean {
  return mode === 'auto' || mode === 'full'
}

/**
 * How each engine takes a FIRST prompt on launch: the interactive session opens with that message
 * already submitted, so the pane's first visible thing is the agent's answer rather than an empty
 * input waiting for one. `null` = no documented mechanism; the caller refuses (`PROMPT_UNSUPPORTED`)
 * rather than guess, the way `gridLaunch.ts` refuses an engine with no endpoint contract.
 *
 * An entry is the argv placed BEFORE the text: a flag (`['--prompt']`) or nothing at all for an
 * engine that reads a bare positional. Each entry cites where it was read from.
 */
export const FIRST_PROMPT_ARGS: Readonly<Record<AgentEngine, readonly string[] | null>> = {
  // `opencode --help`: `--prompt  prompt to use`, a TUI flag — the interactive session starts with
  // the message submitted. A flag rather than a positional because opencode's own positional is
  // `[project]`, a directory: handed the text bare, it would try to open a folder by that name.
  opencode: ['--prompt'],
  // `claude --help`: `Usage: claude [options] [command] [prompt]`, "prompt: Your prompt".
  claude: [],
  // Per vendor CLI help: `codex [OPTIONS] [PROMPT]`, the optional positional the interactive TUI
  // opens with. Not verified on a local install when this entry was written.
  codex: [],
  // No documented first-prompt argument for an interactive launch. Not guessed.
  cursor: null,
  pi: null,
  hermes: null,
  commandcode: null,
  devin: null,
  muse: null,
  amp: null,
  kilo: null,
  grok: null,
  agy: null,
  copilot: null,
  terminal: null,
}

/** A first prompt is a message, not a document. Enforced at the wire (`agent_create`) before any pane
 *  exists, so an over-long one is refused rather than truncated into something the agent was not asked. */
export const MAX_FIRST_PROMPT_CHARS = 2000

/** The refusal for an engine with no entry in [FIRST_PROMPT_ARGS]. `code` is the wire error. */
export class FirstPromptUnsupportedError extends Error {
  readonly code = 'PROMPT_UNSUPPORTED' as const
  constructor(readonly engine: AgentEngine) {
    super(`${engine} has no documented way to start with a first prompt, so the agent was not created.`)
    this.name = 'FirstPromptUnsupportedError'
  }
}

export function supportsFirstPrompt(engine: AgentEngine): boolean {
  return FIRST_PROMPT_ARGS[engine] !== null
}

/** The argv that hands `prompt` to `engine` as its first message. Throws [FirstPromptUnsupportedError]
 *  for an engine with no contract, so a caller cannot build an argv that silently drops the prompt. */
export function firstPromptArgs(engine: AgentEngine, prompt: string): string[] {
  const lead = FIRST_PROMPT_ARGS[engine]
  if (lead === null) throw new FirstPromptUnsupportedError(engine)
  return [...lead, prompt]
}

/**
 * How each engine opens AS one of its named agents — its own name in the footer, its own system
 * prompt — rather than as a general session. `null` = no documented mechanism; the caller refuses
 * (`AGENT_UNSUPPORTED`) before a pane exists, the way [FIRST_PROMPT_ARGS] does for a prompt.
 *
 * An entry is the argv placed BEFORE the name. Unlike a first prompt, the agent IS part of the
 * relaunch record (`RegisteredSession.agent`, carried by `launchOverrides.ts`): a pane opened as
 * `harness-compute` comes back as `harness-compute`.
 */
export const NAMED_AGENT_ARGS: Readonly<Record<AgentEngine, readonly string[] | null>> = {
  // `opencode --help`: `--agent  agent to use`. The name is one of opencode's own agents
  // (`~/.config/opencode/agents/<name>.md`, `mode: primary`).
  opencode: ['--agent'],
  // No documented "open as this named agent" argument for an interactive launch. Not guessed.
  claude: null,
  codex: null,
  cursor: null,
  pi: null,
  hermes: null,
  commandcode: null,
  devin: null,
  muse: null,
  amp: null,
  kilo: null,
  grok: null,
  agy: null,
  copilot: null,
  terminal: null,
}

/** An agent name is an identifier the engine looks a file up by — never a path, never prose. */
export const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The refusal for an engine with no entry in [NAMED_AGENT_ARGS]. `code` is the wire error. */
export class NamedAgentUnsupportedError extends Error {
  readonly code = 'AGENT_UNSUPPORTED' as const
  constructor(readonly engine: AgentEngine) {
    super(`${engine} has no documented way to open as a named agent, so the agent was not created.`)
    this.name = 'NamedAgentUnsupportedError'
  }
}

export function supportsNamedAgent(engine: AgentEngine): boolean {
  return NAMED_AGENT_ARGS[engine] !== null
}

/** The argv that opens `engine` as its named agent `agent`. Throws [NamedAgentUnsupportedError] for
 *  an engine with no contract, so a caller cannot build an argv that silently drops the name. */
export function namedAgentArgs(engine: AgentEngine, agent: string): string[] {
  const lead = NAMED_AGENT_ARGS[engine]
  if (lead === null) throw new NamedAgentUnsupportedError(engine)
  return [...lead, agent]
}

export interface LaunchCommandOptions {
  bypassPermission?: boolean
  /** A mode from [PERMISSION_MODES]; when the engine has it, it decides the flags and
   *  `bypassPermission` is ignored. */
  permissionMode?: string
  /** Resume this engine session id on launch, when a launch-resume flag is known for the engine. */
  resumeSessionId?: string
  /** FORK this engine session id on launch — a new session that starts with its history, the source
   *  untouched ([LAUNCH_FORK_FLAG]). Takes precedence over `resumeSessionId`. */
  forkSessionId?: string
  /**
   * The message the session opens with, already submitted — see [FIRST_PROMPT_ARGS]. Appended LAST,
   * after every flag, because two of the three engines take it positionally and a positional is only
   * unambiguous once the options are exhausted.
   *
   * A launch option and nothing more: it is never written to the registry row, so a relaunch (which
   * resumes a session that already has its first turn) never repeats it. Never logged either — it is
   * what the user typed.
   */
  firstPrompt?: string
  /**
   * Terminal only: print the tile's banner before the first prompt — the wordmark, where this pane
   * is, that an agent typed here becomes the tile, and `harness remote`. Every NEW terminal tile
   * gets it (`agent_create`); a pane rebuilt by restore or restart is not a new tile and names
   * nothing here.
   */
  terminalHint?: { machineName: string }
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
  /**
   * A DSH agent: when the pane's shell, rc files and all, has no `node`, the Node this daemon runs on
   * joins the END of its PATH before the engine starts, so the agent's own tool calls can run what the
   * harness's skills tell them to (`node "$MARP_TOOLCHAIN/check.mjs"`, a package's tscircuit CLI). A
   * machine with no node on PATH is the normal case since the runtime went private; a plain engine
   * launch is left exactly as it was.
   */
  harnessNode?: boolean
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

/**
 * "Open a NEW session that starts with everything session <id> has" — a fork, per engine. Confirmed
 * against each CLI's own `--help` (2026-09-18): `claude --resume <id> --fork-session` ("When resuming,
 * create a new session ID") and `codex fork <id>` ("Fork a previous interactive session"). The source
 * session is left exactly as it was; the two then diverge.
 *
 * Same shape rule as [LAUNCH_RESUME_FLAG]: a leading token that does not start with `-` is a
 * subcommand and goes first. `after` is appended once the id is in place. An engine absent here has no
 * native fork; `forkAgent.ts` falls back to a handoff (a composed first prompt) where the engine takes
 * one, and refuses otherwise — never a plain `--resume`, which would put two processes on ONE session.
 */
export const LAUNCH_FORK_FLAG: Readonly<Partial<Record<AgentEngine, { lead: string[]; after?: string[] }>>> = {
  claude: { lead: ['--resume'], after: ['--fork-session'] },
  codex: { lead: ['fork'] },
}

export function supportsNativeFork(engine: AgentEngine): boolean {
  return LAUNCH_FORK_FLAG[engine] !== undefined
}

/** The executable argv, before the interactive-shell wrapper is applied. */
export function buildEngineCommandArgv(engine: AgentEngine, opts: LaunchCommandOptions = {}): string[] {
  const argv = [engineBin(engine)]
  // A fork is a resume that leaves the source alone; the two are exclusive, and the fork wins.
  const fork = opts.forkSessionId ? LAUNCH_FORK_FLAG[engine] : undefined
  const resumeFlag = fork ? fork.lead : opts.resumeSessionId ? LAUNCH_RESUME_FLAG[engine] : undefined
  const sessionArg = fork ? opts.forkSessionId : opts.resumeSessionId
  const resumeIsSubcommand = !!resumeFlag?.length && !resumeFlag[0].startsWith('-')
  // Subcommand-style resume (`codex resume <id>`, `amp threads continue <id>`, `muse resume <id>`) is
  // parsed positionally and must be the first argv after the binary, ahead of any other flag.
  if (resumeIsSubcommand && resumeFlag && sessionArg) {
    argv.push(...resumeFlag, sessionArg, ...(fork?.after ?? []))
  }
  const modeFlags = opts.permissionMode ? permissionModeFlags(engine, opts.permissionMode) : null
  if (modeFlags) {
    argv.push(...modeFlags)
  } else if (opts.bypassPermission) {
    const flags = BYPASS_PERMISSION_FLAGS[engine]
    if (flags) argv.push(...flags)
  }
  if (!resumeIsSubcommand && resumeFlag && sessionArg) {
    argv.push(...resumeFlag, sessionArg, ...(fork?.after ?? []))
  }
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs)
  if (opts.firstPrompt) argv.push(...firstPromptArgs(engine, opts.firstPrompt))
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
  gridBinary: string = gridBinaryPath(),
  tmuxBinary: string | null = resolveBinaryOnPath('tmux'),
): string[] {
  if (isTerminalEngine(engine)) return buildTerminalLaunchArgv(opts, shell)
  const command = buildEngineCommandArgv(engine, opts)
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return command
  const enginePrelude = engineFallbackPrelude(engine, interactive.path, tmuxBinary)
  // The clear comes FIRST, before the install as well as before the engine. An installer is a child
  // of this shell and inherits what it inherits: `npm` is not going to spend someone's Anthropic key,
  // but an install script that probes for credentials to configure itself would, and the whole point
  // of this launch is that the agent's environment is the one the user asked for.
  // Then the grid's PATH entry at the FRONT (its dir holds only `grid`), and — for a DSH agent — Harness's
  // Node at the END, only when the shell found none. The two never meet: one prepends, one appends.
  const prelude = enginePrelude + clearEnvPrelude(opts.clearEnv) + gridPanePrelude(gridBinary) + (opts.harnessNode ? harnessNodePrelude(runtimeNode) : '')
  // rc files (notably nvm) call getcwd() before running this command. Start the shell in a safe
  // directory and enter the selected workspace only after those files have loaded: an IDE can replace
  // a workspace inode between the desktop picker resolving it and tmux spawning the pane.
  const cwdPrelude = opts.cwd
    ? `if ! cd -- "$1"; then printf '%s\\n' 'harness: the selected working directory is unavailable.' >&2; exit 1; fi\n`
      + unreadableCwdGuard()
      + 'shift\n'
    : ''
  const body = opts.installIfMissing
    ? installIfMissingThenExecScript(opts.installIfMissing, runtimeNode)
    : opts.installFirst
      ? installThenExecScript(opts.installFirst)
      : 'harness_engine "$@"'
  // The open-files raise goes ahead of everything, the installer included: a pane inherits the tmux
  // SERVER's soft limit, which is launchd's 256 whenever the desktop app started the daemon that
  // started the server, and an engine (Claude Code refuses outright) or an npm install under 256 is
  // the failure the person then reads in the pane. See openFiles.ts.
  return [interactive.path, ...interactive.args, RAISE_OPEN_FILES_SH + prelude + cwdPrelude + body, 'harness-engine', ...(opts.cwd ? [opts.cwd] : []), ...command]
}

/**
 * The shell function every engine launch runs its engine through, instead of a bare `exec`.
 *
 * The engine is a CHILD of the pane's shell, and when it exits — `/exit`, Ctrl-C, a crash — the
 * pane does not die with it: the wrapper records the exit status on the pane (`ENGINE_EXIT_PANE_OPTION`,
 * which is how the daemon tells "the engine left" from "the install is still running") and `exec`s
 * the user's interactive shell in its place, exactly as a terminal opened with ⌘⇧T is. The daemon
 * then turns the row back into a terminal (`registry.releaseEngine`) rather than deleting it, and
 * typing the engine's name into that shell adopts it again (`adoptEngine`). A 127 is the one exit
 * that still ends the pane: the command was not found at all, and "not installed" needs to stay
 * a failure the app can name rather than a prompt with an error above it.
 *
 * `tmuxBinary` is the daemon's own tmux, quoted into the script, because the pane's shell may not
 * have it on PATH (the managed runtime never is). Without one the marker is skipped and the fallback
 * still happens — only a failure at launch then takes the daemon's full wait to notice.
 *
 * Without a terminal on stdin there is nobody to hand a shell to, so the function exits with the
 * engine's status instead — which is also what keeps the specs that run these scripts honest.
 *
 * `"$@" || status=$?` rather than `"$@"; status=$?`: a rc file that turned on `set -e` would end
 * the script on the engine's non-zero exit before the fallback ran (see RAISE_OPEN_FILES_SH).
 */
export function engineFallbackPrelude(engine: AgentEngine, shellPath: string, tmuxBinary: string | null): string {
  const loginArgs = basename(shellPath).toLowerCase() === 'zsh' ? ' -l' : ''
  // Named by the command a person would type (`cursor-agent`, `cmd`), not the engine id.
  const command = basename(engineBin(engine)) || engine
  const mark = tmuxBinary && isAbsolute(tmuxBinary)
    ? `  [ -n "\${TMUX_PANE:-}" ] && ${shellSingleQuote(tmuxBinary)} set-option -p -t "$TMUX_PANE" ${ENGINE_EXIT_PANE_OPTION} "$harness_status" >/dev/null 2>&1 || true\n`
    : ''
  return 'harness_engine() {\n'
    + '  harness_status=0\n'
    + '  "$@" || harness_status=$?\n'
    + '  if [ "$harness_status" -eq 127 ]; then exit 127; fi\n'
    + mark
    // Only a pane — something with a terminal on stdin — gets a shell to type into. Run without one
    // (a spec exercising the script, a wrapper piped somewhere) the engine's own status is the answer.
    + '  if ! [ -t 0 ]; then exit "$harness_status"; fi\n'
    + `  printf '\\n%s\\n' ${shellSingleQuote(`harness: ${command} exited ($harness_status). This pane is a shell now — run ${command} again, or stop the pane.`).replace('($harness_status)', `('"$harness_status"')`)}\n`
    + `  exec ${shellSingleQuote(shellPath)}${loginArgs}\n`
    + '}\n'
}

/**
 * The wordmark, as `cli/scripts/install.sh` prints it when an install is done (its `print_logo`);
 * `engineLaunch.spec.ts` holds the two to the same five lines. Printed through `printf '%s\n'` with
 * every line single-quoted, so the backslashes and the backtick reach the pane as drawn.
 */
export const HARNESS_WORDMARK_LINES: readonly string[] = [
  '    _',
  '   | |__   __ _ _ __ _ __   ___  ___ ___',
  "   | '_ \\ / _` | '__| '_ \\ / _ \\/ __/ __|",
  '   | | | | (_| | |  | | | |  __/\\__ \\__ \\',
  '   |_| |_|\\__,_|_|  |_| |_|\\___||___/___/',
]

/**
 * What a new terminal tile says before its prompt, every time one is opened — the installer's
 * finale, in the tile: the wordmark, where this pane is, and three things to type, each explained
 * in a column. An agent typed here becomes the tile (and the shell is back when it exits);
 * `harness remote` is the one thing only a tile can act on, since it swaps the tile it is typed in.
 * Every line stays under 78 columns — a pane is 80 wide when it prints them, before the app has
 * sized it, and a wrapped line stays wrapped in the scrollback. The block ends on a blank line, so
 * the prompt does not sit against it.
 */
export function terminalHintLines(machineName: string): string[] {
  // A hostname can be long (a cloud VM's FQDN runs to 50 characters); past the width the line has
  // left it is cut with an ellipsis rather than wrapped, which is the one thing the block promises.
  const name = machineName.trim() || 'this machine'
  const where = name.length > 62 ? `${name.slice(0, 61)}…` : name
  const row = (command: string, what: string): string => `    ${command.padEnd(29)}  ${what}`
  return [
    '',
    ...HARNESS_WORDMARK_LINES,
    '',
    `  Terminal on ${where}`,
    '',
    row('claude · codex · opencode …', 'run an agent here — this tile becomes it'),
    row('harness remote', 'open a terminal on another machine'),
    row('harness --help', 'everything else'),
    '',
  ]
}

/**
 * Full argv for a plain terminal pane: the user's login shell, nothing exec'd over it.
 *
 * The outer `-c` shell is non-interactive on purpose — it loads no rc files, only raises the
 * open-files limit (a `claude` typed into this terminal later would otherwise refuse under
 * launchd's 256, exactly as a launched engine would) and enters the workspace — then `exec`s the
 * interactive shell, which loads the user's startup files once, the way Terminal.app would. zsh
 * gets `-l` so its login files run; bash reads .bashrc on an interactive non-login start, which is
 * where Ubuntu keeps nvm and vendor PATH edits, so it gets no flag (same reasoning as
 * `interactiveEngineShell`). Without a resolvable shell the pane runs `/bin/sh`, which at least
 * gives the person a prompt.
 */
export function buildTerminalLaunchArgv(
  opts: Pick<LaunchCommandOptions, 'cwd' | 'terminalHint'> = {},
  shell: string | undefined = undefined,
): string[] {
  const candidate = shell === undefined ? currentUserShell() : shell
  const path = candidate && isAbsolute(candidate) ? candidate : '/bin/sh'
  const loginArgs = basename(path).toLowerCase() === 'zsh' ? ['-l'] : []
  const cwdPrelude = opts.cwd
    ? `if ! cd -- "$1"; then printf '%s\\n' 'harness: the selected working directory is unavailable.' >&2; fi\n`
    : ''
  const hintPrelude = opts.terminalHint
    ? `printf '%s\\n' ${terminalHintLines(opts.terminalHint.machineName).map(shellSingleQuote).join(' ')}\n`
    : ''
  return [path, '-c', RAISE_OPEN_FILES_SH + cwdPrelude + hintPrelude + 'shift\nexec "$@"', 'harness-terminal', opts.cwd ?? '', path, ...loginArgs]
}

/**
 * Refuse a workspace the shell could enter but cannot read, and say why — before the engine finds
 * out on its own terms.
 *
 * `cd` succeeding proves only the search bit. macOS privacy protection (TCC) leaves exactly that:
 * a process whose responsible app was never granted Documents, Desktop or Downloads may enter the
 * folder and is refused its first readdir with EPERM. The engine then dies with nothing to go on —
 * Claude Code printed "An unknown error occurred (Unexpected)" on a machine whose tmux server had
 * been started by a terminal app without Documents access, and every pane the daemon opened on
 * that server inherited the refusal — so the check is made here, where the reason can be given.
 * `[ -r . ]` is `access(2)`, which TCC answers the same way as the readdir would.
 *
 * The hint names the fix for the platform this daemon generates the script on, which is the one
 * the pane runs on. `$PWD` is left to the shell so the message names the folder as entered. Short
 * lines, the action first: a dialog that relays the pane's last lines keeps about 180 characters
 * (agentCreateDiagnosis.ts), and the folder path alone can take half of that.
 */
export function unreadableCwdGuard(platform: NodeJS.Platform = process.platform): string {
  const hints = platform === 'darwin'
    ? [
        'harness: on macOS, grant Full Disk Access to the app that started tmux (and to Harness), then run: tmux kill-server',
        'harness: or pick a folder outside Documents, Desktop and Downloads (System Settings › Privacy & Security).',
      ]
    : ['harness: check the folder\'s permissions for this user.']
  return `if ! [ -r . ]; then printf '%s\\n' "harness: cannot read $PWD — the agent was not started." `
    + `${hints.map(shellSingleQuote).join(' ')} >&2; exit 1; fi\n`
}

/** Harness's Node at the end of PATH when the shell found none — see `LaunchCommandOptions.harnessNode`. */
export function harnessNodePrelude(runtimeNode: string = managedNodePath()): string {
  return `if ! command -v node >/dev/null 2>&1; then PATH="\${PATH:+$PATH:}"${shellSingleQuote(dirname(runtimeNode))}; export PATH; fi\n`
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
    `if eval ${JSON.stringify(install)}; then harness_engine "$@"; fi`,
    `printf '\\n%s\\n' 'harness: the install failed, so the agent was not started. The command is above; fix it and create the agent again.'`,
    'exit 1',
  ].join('\n')
}

export function shellSingleQuote(value: string): string {
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
 * The `grid` this pane's agent gets is the one the daemon resolved — and stays it.
 *
 * `grid` is not only the daemon's subprocess: the Harness Compute skill has the AGENT run it, in
 * this pane, by name. A managed grid under `~/.harness/runtime` is invisible to a shell's PATH, and
 * a login file that puts `~/.local/bin` first is ordinary — which is where grid's own installer
 * (uv, on a Mac) leaves a `grid` of some other version. So the prepend is made HERE, after those
 * files have run, the way [npmRuntimePrelude] does for the managed Node — never by a symlink in
 * `~/.local/bin`, which would fight the installer for one file. Two versions of `grid` writing one
 * `~/.grid` is the outcome this exists to prevent.
 *
 * Without an absolute path to prepend — the bare name of the PATH fallback, or an override that is
 * not one — PATH is left alone. Either way grid's update check is off for the pane —
 * [GRID_NO_UPDATE_CHECK_VAR]: the agent is the process most likely to read "run `grid update`" and
 * do it, and under a managed runtime that overwrites the pin.
 *
 * Interactive shells only, like the npm prelude: a direct launch has no script to carry this.
 */
export function gridPanePrelude(binary: string): string {
  const onPath = isAbsolute(binary)
    ? [`PATH=${shellSingleQuote(dirname(binary))}"\${PATH:+:$PATH}"`, 'export PATH', 'hash -r 2>/dev/null || true']
    : []
  return [...onPath, `${GRID_NO_UPDATE_CHECK_VAR}=1`, `export ${GRID_NO_UPDATE_CHECK_VAR}`, ''].join('\n')
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
    '  harness_engine "$resolved" "$@"',
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
