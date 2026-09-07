/**
 * Where the `grid` CLI keeps this machine's grid sign-in — located, and nothing more.
 *
 * `harness logout` detaches the harness and only the harness, so the one thing it owes a person is
 * a sentence about the credential it is leaving behind. That sentence needs no more than the
 * existence of the file: nothing here opens it, parses it, writes to it, or removes it.
 *
 * **No marker is written into the store.** A key recording *how* the sign-in happened was considered
 * and dropped — its only remaining purpose was redirecting an expiry message, and a year-long
 * session removed the need (PRD `harness-grid-login`, Implementation Decision 8).
 *
 * ⚠️ **The layout below is hand-duplicated from autonomous-grid's `shared/paths.py`** — there is no
 * import path between the two repositories. It drifts SILENTLY: move the store there and this check
 * finds nothing, which is spelled exactly like a machine that was never signed in, so `harness
 * logout` would stop warning and no test in either repository would notice. autonomous-grid's
 * `tests/test_harness_login_lockstep.py` pins these three literals against its own for that reason.
 */
import { existsSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The environment variable that relocates the whole of `grid`'s state. */
export const GRID_HOME_ENV = 'GRID_HOME'
/** What `grid` falls back to, under the user's home directory. */
export const GRID_HOME_DEFAULT = '.grid'
/** The store itself. Present ⇒ signed in; absent ⇒ signed out. */
export const GRID_CREDENTIALS_FILE = 'credentials.toml'

/**
 * The credential store's path, honouring `GRID_HOME` the way `grid` does.
 *
 * ⚠️ **Set-but-empty is not the same as unset**, and the fallback keys on the key being ABSENT for
 * that reason. `grid` reads `os.getenv("GRID_HOME", "~/.grid")`, which hands an empty value straight
 * through to a relative path — a pathological configuration, but one where guessing `~/.grid`
 * instead would put this check somewhere `grid` is demonstrably not looking.
 *
 * The value is otherwise taken verbatim. `grid` runs `expanduser()` over it as well, which matters
 * only for a literal leading `~` — and a shell has already expanded that at the point of assignment,
 * so the two agree on every path either of them can actually be given.
 */
export function gridCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[GRID_HOME_ENV]
  const home = configured === undefined ? join(homedir(), GRID_HOME_DEFAULT) : expandLeadingTilde(configured)
  return join(home, GRID_CREDENTIALS_FILE)
}

/** `~` and `~/…` resolved against this user's home, because `grid` runs `expanduser()` over the same
 *  value and the two must not disagree about where the file is.
 *
 *  ⚠️ A shell expands `~` at the point of assignment, so this only matters where nothing does:
 *  a systemd unit, a Docker `ENV`, a `.env` file, a CI variable. There the two would otherwise land
 *  in different places — `grid` writes to `$HOME/…` and this looks for a directory literally named
 *  `~` — and the miss reads exactly like a machine that was never signed in.
 *
 *  `~otheruser` is NOT resolved (`expanduser` does; there is no equivalent in Node without reading
 *  the password database) and neither is a Windows `~\`. Both are documented gaps rather than
 *  silent ones: nothing in this stack has been seen to use either. */
function expandLeadingTilde(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/** Is there a grid sign-in on this machine?
 *
 *  `existsSync` answers `false` for a path it cannot even stat rather than raising, and that is the
 *  property this needs rather than a happy accident: the caller is a sign-out that is local and must
 *  not be able to fail — least of all over a cosmetic warning. */
export function gridCredentialsExist(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(gridCredentialsPath(env))
}

/**
 * Say — once, on standard error — that a grid sign-in is still on this machine, if one is.
 *
 * Both harness sign-outs call this, and that is the point rather than tidiness. `harness logout` and
 * `harness reset` are two doors onto the same act (`clearAuthSession`), and a warning written at one
 * of them is a warning the other silently does without. One function, so they cannot drift.
 *
 * ⚠️ **`writeSync`, not `console.error`.** Both callers finish with `process.exit(0)`, and stderr to
 * a **pipe is asynchronous on macOS** — which `process.exit` does not flush. The one line this owes a
 * person could therefore be dropped exactly when it is being captured by a script or a CI job, and a
 * dropped line is spelled identically to "there were no grid credentials". The `catch` is not a
 * swallowed error: it is the case where stderr itself is gone, and a sign-out must not fail over its
 * own caveat.
 */
export function warnIfGridSignInRemains(env: NodeJS.ProcessEnv = process.env): void {
  if (!gridCredentialsExist(env)) return
  try {
    writeSync(2, 'Your grid sign-in is still on this machine — run `harness grid logout` to end that too.\n')
  } catch { /* no stderr to say it on; the sign-out itself still stands */ }
}
