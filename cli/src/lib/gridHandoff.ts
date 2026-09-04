/**
 * Hand an Autonomous account token to the `grid` CLI, so signing in to a grid needs no second browser.
 *
 * The seam is a child process and nothing else: `grid login --harness` reads the token off its own
 * standard input, exchanges it at the control plane, and owns everything after that. This module's
 * whole job is to run that child honestly — put the credential somewhere a process listing cannot
 * reach, let its output and its exit code through, and turn the one exit code that means something
 * specific into a sentence.
 *
 * **Standard input, never argv and never the environment.** An argument would put a live account
 * credential into `ps` output for every user on the machine, for the life of the call; an environment
 * variable would put it in `/proc/<pid>/environ` and in anything the child later spawns.
 */
import { spawn } from 'node:child_process'
import { binaryOnPath } from './binaryOnPath.js'

/** The command, and the flag on it that means "read the token off stdin" (autonomous-grid's
 *  `cli/parser.py`). Located on PATH with no environment override: tests control PATH directly, so an
 *  override would be a knob with no user. */
export const GRID_BINARY = 'grid'
export const GRID_HANDOFF_FLAG = '--harness'

/**
 * argparse exits 2 on an unknown flag — BEFORE the handler, the network, or anything else in `grid`
 * runs. So a `grid` predating `--harness` fails here loudly and at once, which is what makes the
 * three-repo rollout order a deployment convenience rather than a correctness requirement.
 */
const ARGPARSE_USAGE_EXIT = 2

export type GridHandoffCode = 'OK' | 'GRID_CLI_MISSING' | 'GRID_CLI_OUTDATED' | 'GRID_LOGIN_FAILED'

export interface GridHandoffResult {
  code: GridHandoffCode
  /** The child's own exit code, propagated; 1 when there was no child, or it died on a signal. */
  exitCode: number
  /** Empty on success. Never contains the token. */
  message: string
  /** The child's stdout, captured only when `json` was asked for; otherwise it went straight out. */
  stdout: string
}

const MISSING_MESSAGE =
  'No `grid` on PATH, so there is nothing to hand this sign-in to. Install the grid CLI, then run '
  + '`harness grid login` again.'

const OUTDATED_MESSAGE =
  `Your \`grid\` CLI is too old: it does not understand \`grid login ${GRID_HANDOFF_FLAG}\`. Update `
  + 'it, then run `harness grid login` again.'

function failedMessage(status: number | null, signal: NodeJS.Signals | null): string {
  const how = status === null ? `was killed by ${signal ?? 'a signal'}` : `exited ${status}`
  return `\`grid login ${GRID_HANDOFF_FLAG}\` ${how}. Its own output above says why.`
}

/**
 * Run `grid login --harness`, writing `token` to its standard input and closing it.
 *
 * With `json`, the child is asked for JSON too and its stdout is captured, so THIS process's stdout
 * stays a clean NDJSON stream for whatever is driving it; its stderr still passes through, which is
 * where `grid --json` puts everything a person needs to read. Without `json` both streams are
 * inherited and the child talks to the terminal directly.
 */
export async function handOffToGrid(
  token: string,
  opts: { json?: boolean } = {},
): Promise<GridHandoffResult> {
  // Asking PATH rather than spawning to find out: a missing `grid` is a sentence about installing
  // one, not a spawn error the caller has to recognise. This process's own environment, inherited —
  // there is nothing to override, and a parameter for one would be the knob with no user the ticket
  // refuses.
  if (!binaryOnPath(GRID_BINARY)) {
    return { code: 'GRID_CLI_MISSING', exitCode: 1, message: MISSING_MESSAGE, stdout: '' }
  }
  const args = ['login', GRID_HANDOFF_FLAG, ...(opts.json ? ['--json'] : [])]
  return await new Promise<GridHandoffResult>((resolve) => {
    const child = spawn(GRID_BINARY, args, {
      stdio: ['pipe', opts.json ? 'pipe' : 'inherit', 'inherit'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

    let settled = false
    const settle = (result: GridHandoffResult): void => { if (!settled) { settled = true; resolve(result) } }

    // stdio[0] is a pipe, so this is never null. Refusing loudly anyway rather than optional-chaining
    // past it: with no pipe the token is never delivered, and a `grid` left waiting for one on a
    // stdin nobody will close would hang with nothing on screen from either process.
    const { stdin } = child
    if (!stdin) {
      child.kill()
      settle({ code: 'GRID_LOGIN_FAILED', exitCode: 1, message: `Could not open a pipe to \`${GRID_BINARY}\`.`, stdout })
      return
    }

    // Between the PATH check and the spawn the binary can still be gone; and a child that exits
    // before reading breaks the pipe. Both are the child's story to tell, never a crash here.
    child.once('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT'
      ? { code: 'GRID_CLI_MISSING', exitCode: 1, message: MISSING_MESSAGE, stdout }
      : { code: 'GRID_LOGIN_FAILED', exitCode: 1, message: `Could not run \`${GRID_BINARY}\`: ${err.message}`, stdout }))
    stdin.on('error', () => { /* EPIPE — see above */ })

    // A trailing newline as well as the close: `grid` reads one bounded LINE, so the hand-off does
    // not depend on which of the two it notices first.
    stdin.end(`${token}\n`)

    // `close`, not `exit`: the captured stdout must be complete before it is reported.
    child.once('close', (status, signal) => {
      if (status === 0) { settle({ code: 'OK', exitCode: 0, message: '', stdout }); return }
      if (status === ARGPARSE_USAGE_EXIT) { settle({ code: 'GRID_CLI_OUTDATED', exitCode: status, message: OUTDATED_MESSAGE, stdout }); return }
      settle({ code: 'GRID_LOGIN_FAILED', exitCode: status ?? 1, message: failedMessage(status, signal), stdout })
    })
  })
}
