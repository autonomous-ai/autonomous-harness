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
import { gridBinaryPath, gridChildEnv } from './gridExec.js'

/** The flag on `grid login` that means "read the token off stdin" (autonomous-grid's `cli/parser.py`).
 *  WHICH `grid` is not decided here: `gridBinaryPath()` (lib/gridExec.ts) answers that for every grid
 *  call alike — the developer override, then the managed runtime, then PATH — because this call
 *  carries the token, and a sign-in on one binary with models on another would be two versions
 *  writing one `~/.grid`. */
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
  /** This module's own classification of the failure. Empty on success. Never contains the token. */
  message: string
  /** The child's stdout, captured only when `json` was asked for; otherwise it went straight out. */
  stdout: string
  /** The child's stderr — where `grid` writes every refusal — captured only when `json` was asked
   *  for, and passed through to this process's stderr either way. */
  stderr: string
}

/** A bound on what a child can put into one JSON line. `grid` answers a small document and refuses
 *  in a sentence or two, so this is not a tuning knob; it is a bound on a process whose output this
 *  one does not control, and it is applied to the CAPTURE only — the passthrough is untouched. */
const MAX_CAPTURED_CHARS = 64 * 1024

function capped(sofar: string, chunk: Buffer): string {
  return sofar.length >= MAX_CAPTURED_CHARS ? sofar : (sofar + chunk.toString()).slice(0, MAX_CAPTURED_CHARS)
}

const MISSING_MESSAGE =
  'No `grid` on PATH and no managed grid runtime, so there is nothing to hand this sign-in to. Install '
  + 'the grid CLI, then run `harness grid login` again.'

const OUTDATED_MESSAGE =
  `Your \`grid\` CLI is too old: it does not understand \`grid login ${GRID_HANDOFF_FLAG}\`. Update `
  + 'it, then run `harness grid login` again.'

/**
 * How long the child may take before it is killed and reported as a failure.
 *
 * ⚠️ Without this the spawn had no watchdog at all, unlike every other `grid` call
 * (`gridExec`'s `DEFAULT_TIMEOUT_MS`): a control plane that accepts the connection and then answers
 * nothing left this promise pending forever — a `harness login` that never returned, and, once the
 * daemon began reconciling on its own (`lib/gridAttach.ts`), an attempt that never settled.
 *
 * Longer than `gridExec`'s 30s on purpose. This child makes TWO control-plane round trips (the
 * token exchange, then the per-grid token fetch) where the others make one, and it is the call a
 * person is most likely to be watching — cutting a slow but working sign-in off would be worse than
 * waiting. It is a bound on a hang, not a performance budget.
 */
const HANDOFF_TIMEOUT_MS = 60_000

function timedOutMessage(timeoutMs: number): string {
  return `\`grid login ${GRID_HANDOFF_FLAG}\` did not answer within ${Math.round(timeoutMs / 1000)}s.`
}

function failedMessage(status: number | null, signal: NodeJS.Signals | null): string {
  const how = status === null ? `was killed by ${signal ?? 'a signal'}` : `exited ${status}`
  // No "see the output above": under --json there IS no above for whatever is reading the stream.
  // What `grid` said travels with the failure instead, on `stderr`.
  return `\`grid login ${GRID_HANDOFF_FLAG}\` ${how}.`
}

/**
 * Run `grid login --harness`, writing `token` to its standard input and closing it.
 *
 * With `json`, the child is asked for JSON too and BOTH its streams are captured, so THIS process's
 * stdout stays a clean NDJSON stream for whatever is driving it. stderr is captured **and** written
 * straight back out, because it is needed twice: `grid` refuses on stderr, so that text is the only
 * actionable thing a failure has — and a client reading NDJSON off stdout would never see it, while
 * a person watching the terminal expects it where it has always been. Without `json` both streams
 * are inherited and the child talks to the terminal directly.
 */
export async function handOffToGrid(
  token: string,
  opts: { json?: boolean; timeoutMs?: number } = {},
): Promise<GridHandoffResult> {
  // Asking by reading rather than by spawning to find out: a missing `grid` is a sentence about
  // installing one, not a spawn error the caller has to recognise — and a present-but-unrunnable
  // one (EACCES, never ENOENT) is caught too. Resolved off this process's own environment, which is
  // the one place the override and the runtime dir are read from.
  const binary = gridBinaryPath()
  if (!binaryOnPath(binary)) {
    return { code: 'GRID_CLI_MISSING', exitCode: 1, message: MISSING_MESSAGE, stdout: '', stderr: '' }
  }
  const timeoutMs = opts.timeoutMs ?? HANDOFF_TIMEOUT_MS
  const args = ['login', GRID_HANDOFF_FLAG, ...(opts.json ? ['--json'] : [])]
  return await new Promise<GridHandoffResult>((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', opts.json ? 'pipe' : 'inherit', opts.json ? 'pipe' : 'inherit'],
      // The human path inherits stderr, which is a terminal — exactly where grid would offer
      // `grid update` for a binary the harness pins. See GRID_NO_UPDATE_CHECK_VAR in gridExec.ts.
      env: gridChildEnv(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout = capped(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capped(stderr, chunk)
      process.stderr.write(chunk) // the passthrough, unbounded — only the capture is bounded
    })

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: GridHandoffResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    // The watchdog, armed before anything can block. `SIGKILL` with no `SIGTERM` first, exactly as
    // `gridExec` does: what is being bounded is a child that has stopped responding, and a graceful
    // signal it may never handle is one more thing to wait for. The `close` this provokes finds
    // `settled` already true, so the kill reports the timeout rather than a signal death.
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      settle({ code: 'GRID_LOGIN_FAILED', exitCode: 1, message: timedOutMessage(timeoutMs), stdout, stderr })
    }, timeoutMs)

    // stdio[0] is a pipe, so this is never null. Refusing loudly anyway rather than optional-chaining
    // past it: with no pipe the token is never delivered, and a `grid` left waiting for one on a
    // stdin nobody will close would hang with nothing on screen from either process.
    const { stdin } = child
    if (!stdin) {
      child.kill()
      settle({ code: 'GRID_LOGIN_FAILED', exitCode: 1, message: `Could not open a pipe to \`${binary}\`.`, stdout, stderr })
      return
    }

    // Between the PATH check and the spawn the binary can still be gone; and a child that exits
    // before reading breaks the pipe. Both are the child's story to tell, never a crash here.
    child.once('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT'
      ? { code: 'GRID_CLI_MISSING', exitCode: 1, message: MISSING_MESSAGE, stdout, stderr }
      : { code: 'GRID_LOGIN_FAILED', exitCode: 1, message: `Could not run \`${binary}\`: ${err.message}`, stdout, stderr }))
    stdin.on('error', () => { /* EPIPE — see above */ })

    // A trailing newline as well as the close: `grid` reads one bounded LINE, so the hand-off does
    // not depend on which of the two it notices first.
    stdin.end(`${token}\n`)

    // `close`, not `exit`: the captured stdout must be complete before it is reported.
    child.once('close', (status, signal) => {
      if (status === 0) { settle({ code: 'OK', exitCode: 0, message: '', stdout, stderr }); return }
      if (status === ARGPARSE_USAGE_EXIT) { settle({ code: 'GRID_CLI_OUTDATED', exitCode: status, message: OUTDATED_MESSAGE, stdout, stderr }); return }
      settle({ code: 'GRID_LOGIN_FAILED', exitCode: status ?? 1, message: failedMessage(status, signal), stdout, stderr })
    })
  })
}
