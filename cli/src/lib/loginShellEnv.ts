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
import { spawn } from 'node:child_process'

/** Printed before the dump so anything a chatty rc file writes to stdout is skipped, not parsed. */
const SENTINEL = '__HARNESS_ENV_BEGIN__'
const CAPTURE_TIMEOUT_MS = 5_000

let cached: NodeJS.ProcessEnv | null = null
// The in-flight capture, not just its resolved value — two overlapping warm-up calls (there is only
// ever one production caller today, but this keeps it true regardless) must join the same spawn
// rather than each starting their own shell.
let inFlight: Promise<NodeJS.ProcessEnv> | null = null

/** What was captured, or `{}` if nothing has been. NEVER spawns — see warmLoginShellEnvironment. */
export function loginShellEnvironment(): NodeJS.ProcessEnv {
  return cached ?? {}
}

function parse(stdout: string): NodeJS.ProcessEnv {
  const start = stdout.indexOf(SENTINEL)
  if (start < 0) return {}
  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of stdout.slice(start + SENTINEL.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    parsed[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return parsed
}

async function capture(shell: string): Promise<NodeJS.ProcessEnv> {
  return await new Promise<NodeJS.ProcessEnv>((resolve) => {
    let child
    try {
      child = spawn(shell, ['-lic', `printf %s ${SENTINEL}; env -0`], {
        timeout: CAPTURE_TIMEOUT_MS, // spawn (Node ≥15.14) SIGTERMs the child once this elapses
        // An interactive shell with no tty still runs rc files; keep its stdin closed so nothing waits.
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve({})
      return
    }
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', () => resolve({}))
    child.once('close', (code) => resolve(code === 0 ? parse(Buffer.concat(chunks).toString('utf8')) : {}))
  })
}

/**
 * Perform the capture. Best-effort and once per process; a shell that is missing, slow, or broken
 * yields `{}` and the caller still gets `process.env`, i.e. exactly today's behaviour.
 *
 * Async (not `spawnSync`) so the daemon can run this alongside other independent startup work
 * (e.g. `ensureTmuxOnPath`'s own login-shell probe) instead of paying for both back to back. It is
 * deliberately not called lazily from the one-shot path. It was, and it cost ~1s inside
 * `runDevinOneShot`, which raced that suite's 200ms timeout into a flaky failure — a live turn would
 * have paid the same stall. The daemon warms it during startup instead, where blocking work already
 * happens, and tests never spawn a shell at all.
 */
export function warmLoginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (inFlight) return inFlight
  if (cached) return Promise.resolve(cached)
  inFlight = (async (): Promise<NodeJS.ProcessEnv> => {
    if (process.platform === 'win32') return (cached = {})
    const shell = process.env.SHELL
    if (!shell || !shell.startsWith('/')) return (cached = {})
    return (cached = await capture(shell))
  })().finally(() => {
    inFlight = null
  })
  return inFlight
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
export function resetLoginShellEnvironmentCache(): void {
  cached = null
  inFlight = null
}
