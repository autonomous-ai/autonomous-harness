/**
 * Make `tmux` runnable from the daemon, not just from the user's terminal.
 *
 * Every tmux call in this CLI is `execFile('tmux', …)`, which resolves against the DAEMON's PATH.
 * That is fine while the daemon was started from a terminal and inherits the user's environment,
 * and it breaks the moment it is not: a login/launch-agent context gets a minimal PATH, Homebrew's
 * `/opt/homebrew/bin` is not on it, and every tmux call fails with ENOENT. The visible symptom is
 * agent creation failing for EVERY engine right after a reboot, since nothing else changed.
 *
 * The engine launch was already hardened against exactly this hazard — `buildEngineLaunchArgv`
 * wraps the engine in the user's interactive login shell — but the tmux calls underneath it never
 * were. This closes that asymmetry by asking the same shell where tmux is and putting its directory
 * on the daemon's PATH, once, at startup. Every existing `execFile('tmux', …)` then works unchanged.
 */
import { execFile } from 'node:child_process'
import { delimiter, dirname, isAbsolute } from 'node:path'
import { binaryOnPath } from './binaryOnPath.js'
import { interactiveEngineShell } from './engineLaunch.js'

// `$0` is a label, `$1` the command being resolved — the same positional shape the engine
// availability probe uses, so a command name can never be interpolated into shell source.
const RESOLVE_SCRIPT = 'command -v "$1" 2>/dev/null'

export type TmuxPathOutcome =
  /** Already resolvable; the daemon's PATH was left alone. */
  | { state: 'present'; path?: string }
  /** Found via the user's shell and its directory prepended to PATH. */
  | { state: 'adopted'; path: string; from: string }
  /** Not resolvable either way — tmux is genuinely absent, or there is no usable login shell. */
  | { state: 'absent'; reason: string }

export type AvailableTmuxPathOutcome = Exclude<TmuxPathOutcome, { state: 'absent' }>

/** Refuse to start a daemon that cannot create terminals. */
export function requireTmuxAvailable(outcome: TmuxPathOutcome): AvailableTmuxPathOutcome {
  if (outcome.state === 'absent') {
    throw new Error(
      `tmux is required but unavailable: ${outcome.reason}. `
      + 'Install tmux, verify `tmux -V`, then run `harness start` again.',
    )
  }
  return outcome
}

/** Where the user's own interactive shell finds a command, which is not where the daemon looks. */
export async function resolveViaLoginShell(
  command: string,
  shell: string | undefined = undefined,
): Promise<string | null> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return null
  const found = await probe(interactive.path, interactive.args, command)
  if (found) return found
  // ASK AGAIN AS A LOGIN SHELL, because for bash the first ask reads the wrong file.
  //
  // interactiveEngineShell gives zsh `-lic` and bash `-ic`, and that asymmetry is deliberate: a
  // deliberate test pins bash to interactive-only startup files. It is right for LAUNCHING an engine
  // and wrong for ASKING WHERE A BINARY IS, because the two conventions differ — a zsh user's PATH is
  // in .zshrc, which `-i` reads, and a bash user's is conventionally in .bash_profile, which only `-l`
  // reads (.bashrc runs for every subshell, so a PATH built there compounds).
  //
  // Measured on a bash machine here: `bash -ic` resolved nothing, `bash -lic` returned
  // /usr/local/bin/tmux. The daemon therefore logged "tmux: unavailable (spawn tmux ENOENT)" and served
  // ZERO agents while nine tmux sessions were running — the dial showed an empty wheel and nothing said
  // why. Terminal.app runs a login shell on macOS, so this second ask is also the one that matches what
  // the user sees in their own terminal.
  //
  // Only ever a FALLBACK: the first ask stands when it answers, so nothing changes for the shells that
  // already worked, and this costs one extra spawn only on a machine that was about to fail anyway.
  if (interactive.args.includes('-lic')) return null
  return await probe(interactive.path, ['-lic'], command)
}

/** One question to one shell: where is `command`? Null unless it answers with an absolute path. */
function probe(shellPath: string, args: readonly string[], command: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      shellPath,
      [...args, RESOLVE_SCRIPT, 'harness-tmux-probe', command],
      { timeout: 5_000 },
      (error, stdout) => {
        // Login rc files are allowed to be chatty. In particular, nvm commonly prints a
        // "Now using node …" banner before `command -v` writes the actual path. Looking only at
        // stdout's first line then made a perfectly installed Homebrew tmux appear absent whenever
        // Harness was started by the desktop app's minimal PATH.
        const found = String(stdout ?? '').split('\n').map((line) => line.trim()).find(isAbsolute)
        resolve(!error && found ? found : null)
      },
    )
  })
}

/**
 * Idempotent: safe to call on every start, and a no-op when the daemon can already run tmux.
 *
 * The directory is PREPENDED rather than the binary path being threaded through call sites: the
 * tmux client and the tmux server have to agree on their socket, and a daemon that found tmux one
 * way while a helper found it another is how a machine ends up talking to two servers.
 */
export async function ensureTmuxOnPath(
  env: NodeJS.ProcessEnv = process.env,
  shell: string | undefined = undefined,
): Promise<TmuxPathOutcome> {
  if (binaryOnPath('tmux', env)) return { state: 'present' }
  const resolved = await resolveViaLoginShell('tmux', shell)
  if (!resolved) {
    return {
      state: 'absent',
      reason: interactiveEngineShell(shell)
        ? 'the user\'s login shell does not resolve tmux either'
        : 'no usable login shell to ask, and tmux is not on the daemon PATH',
    }
  }
  const dir = dirname(resolved)
  env.PATH = env.PATH ? `${dir}${delimiter}${env.PATH}` : dir
  return { state: 'adopted', path: resolved, from: dir }
}
