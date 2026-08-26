/**
 * The environment the user's own shell would give a command — for engine one-shots only.
 *
 * A recap child inherits the DAEMON's environment, and the daemon is detached: its parent is launchd
 * (or systemd), not a shell, so it never read the user's profile. An engine that resolves its
 * credential from an environment variable therefore works in the user's pane and fails in the recap.
 *
 * Measured, and this is the whole bug behind "pi stopped recapping": `~/.pi/agent/models.json` holds
 *     "apiKey": "$LOCAL_API_KEY"
 * and that variable is exported from `~/.zshrc`. The daemon has no such variable, so pi exited 1 with
 * "No API key found for the selected model" after 14ms, every time, while `pi` in a tmux pane was fine.
 *
 * INTERACTIVE login shell, deliberately. `zsh -lc` reads .zprofile/.zlogin and would NOT have found it;
 * `.zshrc` is only read for interactive shells. Verified both ways on the reporting machine.
 *
 * This is not a new privilege: an engine started in a pane already runs with exactly this environment.
 * All it does is let the recap run where the agent it summarises runs.
 */
import { spawnSync } from 'node:child_process'

/** Printed before the dump so anything a chatty rc file writes to stdout is skipped, not parsed. */
const SENTINEL = '__HARNESS_ENV_BEGIN__'
const CAPTURE_TIMEOUT_MS = 5_000

let cached: NodeJS.ProcessEnv | null = null

/** What was captured, or `{}` if nothing has been. NEVER spawns — see warmLoginShellEnvironment. */
export function loginShellEnvironment(): NodeJS.ProcessEnv {
  return cached ?? {}
}

/**
 * Perform the capture. Best-effort and once per process; a shell that is missing, slow, or broken
 * yields `{}` and the caller still gets `process.env`, i.e. exactly today's behaviour.
 *
 * This is a SYNCHRONOUS spawn and it is deliberately not called lazily from the one-shot path. It was,
 * and it cost ~1s inside `runDevinOneShot`, which raced that suite's 200ms timeout into a flaky
 * failure — a live turn would have paid the same stall. The daemon warms it during startup instead,
 * where blocking work already happens, and tests never spawn a shell at all.
 */
export function warmLoginShellEnvironment(): NodeJS.ProcessEnv {
  if (cached) return cached
  cached = {}
  if (process.platform === 'win32') return cached
  const shell = process.env.SHELL
  if (!shell || !shell.startsWith('/')) return cached

  let result
  try {
    result = spawnSync(shell, ['-lic', `printf %s ${SENTINEL}; env -0`], {
      timeout: CAPTURE_TIMEOUT_MS,
      encoding: 'utf8',
      // An interactive shell with no tty still runs rc files; keep its stdin closed so nothing waits.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { return cached }
  const stdout = result?.stdout
  if (result?.error || typeof stdout !== 'string') return cached
  const start = stdout.indexOf(SENTINEL)
  if (start < 0) return cached

  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of stdout.slice(start + SENTINEL.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    parsed[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  cached = parsed
  return cached
}

/**
 * The base environment for a one-shot child: the user's shell environment, with the daemon's own
 * environment layered ON TOP.
 *
 * That precedence is the safety property — every variable the daemon already has keeps its current
 * value, so nothing that works today can change. The shell only fills in what is missing.
 */
export function oneShotParentEnv(): NodeJS.ProcessEnv {
  return { ...loginShellEnvironment(), ...process.env }
}

/** Test seam. */
export function resetLoginShellEnvironmentCache(): void { cached = null }
