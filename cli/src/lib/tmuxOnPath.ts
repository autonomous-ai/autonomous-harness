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

/** Where the user's own interactive shell finds a command, which is not where the daemon looks. */
export async function resolveViaLoginShell(
  command: string,
  shell: string | undefined = undefined,
): Promise<string | null> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return null
  return await new Promise<string | null>((resolve) => {
    execFile(
      interactive.path,
      [...interactive.args, RESOLVE_SCRIPT, 'harness-tmux-probe', command],
      { timeout: 5_000 },
      (error, stdout) => {
        const first = String(stdout ?? '').trim().split('\n')[0]?.trim() ?? ''
        resolve(!error && isAbsolute(first) ? first : null)
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
