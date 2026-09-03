/**
 * What this machine's tmux can do, for the one feature that is not universally available.
 *
 * `new-session -e VAR=value` arrived in tmux 3.2. Without a check, an older tmux answers a grid
 * launch with its own usage text — which the create path faithfully reports as `SPAWN_FAILED:
 * usage: new-session [-AdDEHPX] ...`, a dead end for anyone who did not already know the flag was
 * new. The version is worth one `tmux -V` so the refusal can name the actual cause.
 */

import { execFile } from 'node:child_process'

/** The first tmux that accepts `-e` on `new-session`. */
export const TMUX_SESSION_ENV_MIN = { major: 3, minor: 2 } as const

export interface TmuxVersion {
  major: number
  minor: number
}

/**
 * `tmux 3.5a` / `tmux next-3.6` / `tmux openbsd-7.4` → the numeric part; `null` when there is none.
 *
 * `null` means "cannot tell", not "too old" — `tmux master` reports no number at all and is newer
 * than every release, so callers treat an unparsed version as capable and let tmux itself answer.
 */
export function parseTmuxVersion(output: string): TmuxVersion | null {
  const match = /(\d+)\.(\d+)/.exec(output)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

export function supportsSessionEnv(version: TmuxVersion | null): boolean {
  if (!version) return true // see parseTmuxVersion — unknown is not old
  if (version.major !== TMUX_SESSION_ENV_MIN.major) return version.major > TMUX_SESSION_ENV_MIN.major
  return version.minor >= TMUX_SESSION_ENV_MIN.minor
}

let cached: Promise<TmuxVersion | null> | undefined

async function probe(): Promise<TmuxVersion | null> {
  return await new Promise((resolve) => {
    execFile('tmux', ['-V'], { timeout: 2_000 }, (error, stdout) => {
      // A tmux that cannot be run at all is not this check's problem: the create path already
      // reports `TMUX_UNAVAILABLE` for it, and answering "too old" here would name the wrong cause.
      resolve(error ? null : parseTmuxVersion(stdout))
    })
  })
}

/**
 * Can `TmuxBackend.create` be given an `env`? Probed once per process — tmux does not change under
 * a running daemon, and this sits in front of an interactive "create agent" click.
 */
export async function tmuxSupportsSessionEnv(): Promise<boolean> {
  cached ??= probe()
  return supportsSessionEnv(await cached)
}

/** Test seam: forget the cached probe so a spec can install its own tmux. */
export function resetTmuxVersionCache(): void {
  cached = undefined
}
