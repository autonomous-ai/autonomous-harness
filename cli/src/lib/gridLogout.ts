/**
 * Run `grid logout` as itself, and get out of the way.
 *
 * The grid sign-out is not a credential delete: it tears every serve child on this box down FIRST,
 * while the token that makes their deregistration authoritative still exists, and it refuses — keeping
 * the credentials — when a child cannot be confirmed stopped. `--force` walks away from that refusal.
 * All of it already exists, it has been got wrong once, and a second dialect of it here would be the
 * kind that drifts. So this module reproduces none of it: it spawns the child, inherits all three
 * streams, and hands back the child's exit code.
 *
 * ⚠️ **Nothing is wrapped, under `--json` or otherwise.** `harness grid login` has two halves to
 * reconcile and emits its own terminating result line; this command has ONE, so its standard output
 * is `grid logout`'s document verbatim and its standard error is `grid logout`'s sentence verbatim.
 * An envelope added here would be a second answer to a question the child has already answered.
 *
 * The one thing this module is entitled to say is that there was no child to run at all.
 */
import { spawn } from 'node:child_process'
import { binaryOnPath } from './binaryOnPath.js'
import { GRID_BINARY } from './gridHandoff.js'

/** The verb, on the same binary the hand-off spawns. Deliberately NOT a cross-repo pin: rename it in
 *  autonomous-grid and argparse refuses it loudly, in the child's own words, on the child's own
 *  stderr — there is no silent direction to guard. */
const GRID_LOGOUT_VERB = 'logout'

const MISSING_MESSAGE =
  `No \`${GRID_BINARY}\` on PATH, so there is no grid sign-in here for this to end. If your grid CLI `
  + 'is installed somewhere else, run `grid logout` there.'

/**
 * A child ran and its exit code is the answer, or none did and this carries the sentence.
 *
 * ⚠️ `ran` is read on the FIELD. Both shapes are truthy objects, so a caller testing the outcome
 * itself would take a missing `grid` for a clean sign-out.
 */
export type GridLogoutOutcome =
  | { ran: true; exitCode: number }
  | { ran: false; exitCode: number; message: string }

const missing = (): GridLogoutOutcome => ({ ran: false, exitCode: 1, message: MISSING_MESSAGE })

/**
 * Spawn `grid logout`, forwarding `args` untouched, and resolve with what it did.
 *
 * `args` is whatever followed `harness grid logout`, passed through rather than allow-listed: a flag
 * `grid logout` grows tomorrow works here the day it ships, and this file never becomes a second
 * place that has to know what the sign-out accepts.
 */
export async function passThroughToGridLogout(args: string[]): Promise<GridLogoutOutcome> {
  // Asking PATH rather than spawning to find out, exactly as the hand-off does: an absent `grid` is
  // a sentence, not a spawn error every caller would have to recognise. It also catches the case a
  // spawn cannot — a `grid` that is present but not executable answers EACCES, never ENOENT.
  if (!binaryOnPath(GRID_BINARY)) return missing()
  return await new Promise<GridLogoutOutcome>((resolve) => {
    // All three streams inherited: the child talks to the terminal directly, which is what makes
    // this a passthrough rather than a re-narration of one.
    const child = spawn(GRID_BINARY, [GRID_LOGOUT_VERB, ...args], { stdio: 'inherit' })
    let settled = false
    const settle = (outcome: GridLogoutOutcome): void => { if (!settled) { settled = true; resolve(outcome) } }

    // Between the PATH check and the spawn the binary can still be gone.
    child.once('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT'
      ? missing()
      : { ran: false, exitCode: 1, message: `Could not run \`${GRID_BINARY}\`: ${err.message}` }))

    // A child killed by a signal has no status. It reports as an ordinary non-zero exit, because
    // that is what a shell would see and because the signal reached this process too — the person
    // who sent it needs no sentence from here.
    child.once('close', (status) => settle({ ran: true, exitCode: status ?? 1 }))
  })
}
