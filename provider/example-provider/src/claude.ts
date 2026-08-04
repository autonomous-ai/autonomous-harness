/**
 * Spawning the `claude` CLI for one turn.
 *
 * The invocation mirrors `apps/agent-node/brain/src/prefrontal/process.ts:444-463` — the flags are
 * infrastructural, and the user's message is passed VERBATIM. No wrapper text, no prepended hints.
 *
 * ⚠ This runs with `--dangerously-skip-permissions`: Claude executes tools without asking. That is a
 * deliberate choice for this example (it matches the product's `auto` autonomy) and it means the
 * agent can modify anything under its `cwd`. Point `agents.json` at a directory you are happy to
 * hand over. See README.md.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { StreamLine } from './mapper.js'

export interface TurnOptions {
  claudeBin: string
  cwd: string
  /** The user's text, passed through untouched. */
  text: string
  /** Present on every turn after the first in a session. */
  resumeSessionId?: string
  model?: string
  signal?: AbortSignal
}

export interface TurnHandle {
  /** Resolves when the process exits. Never rejects — a failure is reported through `onLine`. */
  done: Promise<{ code: number | null; killed: boolean }>
  kill: () => void
}

/**
 * Start a turn. `onLine` receives each parsed stdout line in order.
 *
 * Unparsable stdout is skipped rather than thrown on: the CLI is free to print things that are not
 * our JSON, and a stray line must not kill a turn.
 */
export function runTurn(opts: TurnOptions, onLine: (line: StreamLine) => void, onStderr?: (chunk: string) => void): TurnHandle {
  const args = [
    ...(opts.model ? ['--model', opts.model] : []),
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
  ]

  const child = spawn(opts.claudeBin, args, {
    cwd: opts.cwd,
    // Its own process group, so cancelling kills the tools it started too. A bare child.kill()
    // leaves those orphaned — the same reason brain uses kill(-pid) in oneshot.ts.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  let killed = false
  const kill = (): void => {
    if (killed || child.exitCode !== null) return
    killed = true
    killGroup(child)
  }
  opts.signal?.addEventListener('abort', kill, { once: true })

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (raw) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      let parsed: StreamLine
      try {
        parsed = JSON.parse(trimmed) as StreamLine
      } catch {
        return // not our JSON — ignore rather than fail the turn
      }
      onLine(parsed)
    })
  }
  if (child.stderr && onStderr) {
    child.stderr.on('data', (chunk: Buffer) => onStderr(chunk.toString()))
  }

  // The user's message, verbatim, in the input-format stream-json envelope (brain: process.ts:809).
  try {
    child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: opts.text }] } })}\n`)
    child.stdin?.end()
  } catch {
    kill()
  }

  const done = new Promise<{ code: number | null; killed: boolean }>((resolve) => {
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', kill)
      resolve({ code, killed })
    }
    child.on('close', finish)
    child.on('error', () => finish(null))
  })

  return { done, kill }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid == null || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal) // negative pid = the whole group
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}
