/**
 * Bring this machine's grid sign-in into line with its harness sign-in — on every daemon start.
 *
 * The harness sign-in and the grid sign-in used to be one act, wired to the login *event*
 * (`attachGridToSignIn` in `cli.ts`). A machine that signed in to the harness before grid existed
 * never re-runs that event, so after an update it has a `grid` binary but no grid credentials and no
 * grid to point at — the Local model picker reads "No local models on this account yet." and there
 * is nothing a person can do about it but `harness logout` / `harness login`.
 *
 * This is the reconcile that removes that step. It runs once per daemon start (the point every update
 * path — `harness start`, `harness update`, the self-update restart, the desktop's re-probe — passes
 * through) and answers one question: *is this machine already signed in to grid as the right account,
 * with the account's private grid present?* If yes, it does nothing but publish the name. If no, it
 * hands the harness token to `grid login --harness` and makes sure the grid exists — the same two
 * steps the login event does, now driven by state rather than by an event that will not fire again.
 *
 * **Best-effort by construction.** A machine with no `grid`, an older backend that mints no name, a
 * control plane having a bad minute — each is a log line and a daemon that runs exactly as before.
 * Nothing here can fail a daemon start.
 *
 * **Convergence, not a timer.** The gate below is almost entirely offline (a file read and one
 * `grid ls` that makes no network call), so the common path — a machine already set up — costs one
 * `POST /api/grid/name` (idempotent, mostly a read) and nothing else. A grid sign-in is created or
 * refreshed only when the gate says it is missing or belongs to another account.
 *
 * ⚠️ It converges only where the grid CAN exist. An account that cannot hold this grid at all — the
 * free-plan network limit is the real case — never satisfies the gate, so every daemon start signs in
 * again and tries again. That costs a token rotation per start, not a loop within one, and it is the
 * deliberate trade: the alternative is remembering a failure across starts on disk, which would also
 * remember it after the account was fixed. `ensure`'s own message says which limit was hit.
 *
 * **Overwrite is deliberate.** When this machine is signed in to grid as a *different* account, the
 * hand-off overwrites it, matching `grid login`'s own rule (a swap is a line, never a refusal) and
 * the harness's "grid sign-in is part of harness sign-in" contract. `grid login --harness` never
 * touches a running `grid join --serve` child; it only warns about one whose grid has gone.
 */
import { gridJson } from './gridExec.js'
import type { GridHandoffResult } from './gridHandoff.js'
import type { EnsureResult } from './gridEnsure.js'

export type GridAttachStatus =
  /** No `grid` on this machine — there is nothing to attach a sign-in to. */
  | 'no-cli'
  /** The backend issued no grid name (an older backend, or the control plane was unreachable). */
  | 'no-name'
  /** This machine's `grid` already knows the account's grid — signed in as the right account, grid
   *  present. Nothing was changed. */
  | 'converged'
  /** The token was handed over (a fresh sign-in, a re-sign-in, or an account swap), then the grid
   *  ensured. */
  | 'signed-in'
  /** The hand-off was needed and did not succeed. The harness sign-in is untouched. */
  | 'handoff-failed'

export interface GridAttachResult {
  status: GridAttachStatus
  /** The account's private grid name, once known; null when the backend issued none. */
  name: string | null
  /** One sentence for a caller that wants to log the outcome. Never contains a credential. */
  detail: string
}

/**
 * The seams this reconcile runs through. The grid-facing ones default to the real modules
 * ({@link defaultGridAttachDeps}); the network and daemon-facing ones are supplied by `cli.ts`,
 * which alone holds the HTTP helpers and the live `BackendSocket`.
 */
export interface GridAttachDeps {
  /** Awaited first: the managed grid runtime may still be landing, and the hand-off must run on the
   *  pinned binary rather than whatever PATH had a moment earlier. A rejection is ignored — a failed
   *  download is the binary check's story to tell, not this await's. */
  managedGridReady: Promise<unknown>
  /** Is there a `grid` to run at all? */
  gridAvailable: () => boolean
  /** `POST /api/grid/name` — the account's private grid name, minted if this is its first ask. Null
   *  when the backend predates the route. Throws when the control plane cannot be reached. */
  mintName: () => Promise<string | null>
  /** A live harness access token, for the hand-off. Throws when the SSO session is gone. */
  accessToken: () => Promise<string>
  /** The email `grid` recorded for this machine's sign-in, or null when signed out of grid. */
  signedInEmail: () => string | null
  /** The grid names this machine's `grid` knows locally (`grid --remote ls`, no network call). */
  gridNames: () => Promise<string[]>
  /** Run `grid login --harness` with this token. */
  handoff: (token: string) => Promise<GridHandoffResult>
  /** Make sure the account's private grid exists. */
  ensure: (name: string) => Promise<EnsureResult>
  /** Publish the confirmed name into the daemon and drop the grid memos, so the next `grid_models_list`
   *  / retarget answers with this account's grid rather than a stale or absent one. */
  onName: (name: string) => void
  /** One sentence, prefixed by the caller. */
  log: (line: string) => void
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Reconcile this machine's grid sign-in with its harness account. See the module comment for the
 * shape of the decision; the branches below are exactly its four answers.
 */
export async function reconcileGridAttach(deps: GridAttachDeps): Promise<GridAttachResult> {
  // A download must not hold this back, but the hand-off below needs whatever it produced.
  try { await deps.managedGridReady } catch { /* the binary check answers a failed download */ }

  if (!deps.gridAvailable()) {
    deps.log('no grid CLI on this machine yet — nothing to attach a sign-in to')
    return { status: 'no-cli', name: null, detail: '' }
  }

  let name: string | null
  try {
    name = await deps.mintName()
  } catch (err) {
    deps.log(`could not read this account's grid name (${msg(err)}) — will try again on the next start`)
    return { status: 'no-name', name: null, detail: msg(err) }
  }
  if (!name) {
    deps.log('this account has no grid name yet (older backend) — skipping grid setup')
    return { status: 'no-name', name: null, detail: '' }
  }

  // The exact, unambiguous signal that this machine is already set up: the account's grid name is
  // GLOBALLY UNIQUE (its suffix is a hash of the account id), so this machine's `grid` knowing that
  // name locally can only mean it is signed in as this account AND the grid exists. A weaker check —
  // "is the signed-in email's private-grid pattern a match" — would false-positive across two
  // accounts sharing an email local-part (`kelvin@personal` vs `kelvin@company`), skip the overwrite
  // decision (1) calls for, and then `ensure` under the wrong account. `grid ls` is a local read
  // (no network), so this stays cheap on the common, already-set-up path.
  const email = deps.signedInEmail()
  let names: string[] = []
  if (email) {
    try {
      names = await deps.gridNames()
    } catch (err) {
      // Could not read the local registry. That cannot PROVE the machine is set up, so it falls
      // through to the hand-off below — which rewrites that registry, so the next start reads it.
      deps.log(`could not read this machine's grid list (${msg(err)}) — signing in again to rebuild it`)
    }
  }
  if (email && names.includes(name)) {
    deps.onName(name)
    deps.log(`already signed in with grid '${name}' — nothing to do`)
    return { status: 'converged', name, detail: '' }
  }

  // Everything else — signed out, signed in as a DIFFERENT account, or the grid not yet created /
  // synced on this machine — is resolved by (re)signing in as this account and making sure the grid
  // exists. When the machine was signed in as a different account, this overwrites it, by design
  // (decision 1, and the module comment). When it was already the right account but the grid was
  // merely missing locally, this re-fetches the account's grids before ensuring — a small redundancy
  // that only recurs until the grid is created and synced, after which the converged path skips it.
  let token: string
  try {
    token = await deps.accessToken()
  } catch (err) {
    deps.log(`no harness token to hand to grid (${msg(err)})`)
    return { status: 'handoff-failed', name, detail: msg(err) }
  }
  const handoff = await deps.handoff(token)
  if (handoff.code !== 'OK') {
    deps.log(`grid sign-in did not happen: ${handoff.message}`)
    return { status: 'handoff-failed', name, detail: handoff.message }
  }
  const ensured = await deps.ensure(name)
  deps.onName(name)
  deps.log(`signed grid in and ensured '${name}': ${ensured.status}${ensured.message ? ` — ${ensured.message}` : ''}`)
  return { status: 'signed-in', name, detail: ensured.message }
}

/**
 * The grid names this machine's `grid` knows locally. `grid --remote ls` reads the stored registry
 * and makes no network call (autonomous-grid `cli/remote_grid.py`), so the reconcile's gate stays
 * cheap. An unparsable answer is no names, which the caller treats as "ensure it".
 */
export interface GridAttachRunnerOptions {
  /** Runs one reconcile. Injected so the coordination below is testable without a daemon. */
  attempt: () => Promise<GridAttachResult>
  /** How many attempts this runner will ever make before it stops trying. */
  maxAttempts: number
  /** The soonest a new attempt may START after the previous one did. */
  minIntervalMs: number
  /** How long an in-flight attempt is worth making an RPC wait for, from when it started. */
  ceilingMs: number
  /** Injected clock, for tests. */
  now?: () => number
  log: (line: string) => void
}

export interface GridAttachRunner {
  /** Start an attempt if one is warranted. Safe to call as often as a reconnect fires. */
  run: () => void
  /** The in-flight attempt while it is still worth waiting for, else null. */
  probe: () => Promise<unknown> | null
  /** How many attempts have been started. Diagnostics and tests. */
  attempts: () => number
}

/**
 * Decides WHEN to reconcile, as opposed to {@link reconcileGridAttach}, which decides what to do.
 *
 * Its own unit because the daemon calls `run()` from two places — once at start, then on every
 * backend reconnect — and every interesting property is about the interaction of those calls: two
 * attempts must not overlap, a burst of reconnects must not turn into a burst of grid sign-ins, and
 * the whole thing must eventually stop rather than rotate this account's tokens forever.
 *
 * **A burst collapses into one attempt, it does not burn the budget.** A laptop waking, changing
 * network or toggling a VPN produces several reconnects in seconds. Counting each as an attempt
 * spent the entire allowance on one moment of ordinary churn and then went quiet for the daemon's
 * life — which can be days. Requests inside `minIntervalMs` are therefore DEFERRED to the end of
 * that window rather than dropped, so the churn yields exactly one attempt and the opportunity is
 * not lost either. The timer is unref'd: it must never be a reason a process stays alive.
 *
 * **It gives up out loud.** Reaching the cap says so once. Silence there was indistinguishable from
 * a feature that was working.
 */
export function createGridAttachRunner(opts: GridAttachRunnerOptions): GridAttachRunner {
  const now = opts.now ?? Date.now
  let inFlight: Promise<unknown> | null = null
  let deferred: ReturnType<typeof setTimeout> | null = null
  let done = false
  let attempts = 0
  let lastStartedAt = Number.NEGATIVE_INFINITY
  let deadline = 0
  let saidGaveUp = false

  const run = (): void => {
    if (done || inFlight || deferred) return
    if (attempts >= opts.maxAttempts) {
      if (!saidGaveUp) {
        saidGaveUp = true
        opts.log(`no grid after ${attempts} attempts — giving up until this machine restarts, or you sign in to Harness again`)
      }
      return
    }
    const wait = opts.minIntervalMs - (now() - lastStartedAt)
    if (wait > 0) {
      deferred = setTimeout(() => { deferred = null; run() }, wait)
      deferred.unref?.()
      return
    }
    attempts += 1
    lastStartedAt = now()
    deadline = lastStartedAt + opts.ceilingMs
    inFlight = opts.attempt()
      .then((result) => {
        // Only an outcome that actually attached stops the retries. `no-cli`, `no-name` and
        // `handoff-failed` are all "this machine or the control plane was not ready", which is
        // exactly what a later connect may have fixed.
        if (result.status === 'converged' || result.status === 'signed-in') done = true
      })
      .catch((err) => { opts.log(`attempt failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`) })
      .finally(() => { inFlight = null })
  }

  return {
    run,
    probe: () => (inFlight && now() < deadline ? inFlight : null),
    attempts: () => attempts,
  }
}

export async function gridNamesLocal(): Promise<string[]> {
  const { value, result } = await gridJson<Array<{ grid?: unknown }>>(['--remote', 'ls'])
  // ⚠️ A FAILED read is NOT an empty list, and conflating the two is how "this machine has no grids"
  // stops being a fact and becomes a guess — one that would make the gate below answer "not set up"
  // forever on a machine whose registry is unreadable. Thrown rather than returned as `[]` so the
  // caller says which of the two happened in its log.
  if (result.code !== 'OK') {
    throw new Error(result.stderr.trim() || result.message || `\`grid ls\` exited ${result.exitCode}`)
  }
  if (!Array.isArray(value)) throw new Error('`grid ls --json` did not answer a list')
  return value.map((row) => (typeof row.grid === 'string' ? row.grid : '')).filter(Boolean)
}
