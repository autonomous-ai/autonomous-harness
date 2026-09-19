/** Grid's complete argv API, carried over the existing paired-machine connection. No shell. */
import { spawn } from 'node:child_process'
import { gridBinaryPath, gridChildEnv } from './gridExec.js'

export const GRID_FLEET_PROTOCOL = 1
export const GRID_FLEET_MAX_TIMEOUT_MS = 30 * 60_000
const MAX_OUTPUT = 512 * 1024
export interface GridFleetRequest { args: string[]; timeoutMs: number; thinking?: boolean }
export interface GridFleetResult { ok: boolean; code: number; stdout: string; stderr: string; error: string | null }

/** Grid redraws download progress for every MiB, even on pipes. Retain the current terminal line
 * instead of counting those redraws as permanent output; completed diagnostic lines stay intact. */
export class GridOutputCapture {
  private completed = ''
  private line = ''
  private rewind = false
  append(chunk: string): void {
    for (const part of chunk.split(/([\r\n])/)) {
      if (!part) continue
      if (part === '\r') this.rewind = true
      else if (part === '\n') { this.completed += this.line + '\n'; this.line = ''; this.rewind = false }
      else { if (this.rewind) this.line = ''; this.rewind = false; this.line += part }
    }
  }
  get text(): string { return this.completed + this.line }
}

export function parseGridFleetRequest(payload: Record<string, unknown>): GridFleetRequest | null {
  const { args, timeoutMs = 30_000, thinking } = payload
  if (!Array.isArray(args) || !args.length || args.length > 256
    || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 16_384)
    || args.reduce((n, a) => n + a.length, 0) > 128 * 1024
    || !Number.isInteger(timeoutMs) || (timeoutMs as number) < 100 || (timeoutMs as number) > GRID_FLEET_MAX_TIMEOUT_MS
    || (thinking !== undefined && typeof thinking !== 'boolean')) return null
  return { args: args as string[], timeoutMs: timeoutMs as number, ...(thinking === undefined ? {} : { thinking: thinking as boolean }) }
}

/** Bounded, connection-owned jobs. Dropping a connection does not repeat or silently roll back a deployment. */
export class GridFleetRpc {
  private readonly jobs = new Map<string, AbortController>()
  constructor(private readonly processEnv: NodeJS.ProcessEnv = process.env) {}

  cancel(owner: string, id: string): boolean {
    const job = this.jobs.get(JSON.stringify([owner, id]))
    job?.abort()
    return !!job
  }

  async run(owner: string, id: string, request: GridFleetRequest): Promise<GridFleetResult> {
    const fail = (code: number, error: string): GridFleetResult => ({ ok: false, code, stdout: '', stderr: '', error })
    if (!owner || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return fail(2, 'Invalid Grid request identity.')
    const key = JSON.stringify([owner, id])
    if (this.jobs.has(key)) return fail(2, 'This Grid command is already running; it was not started again.')
    if (this.jobs.size >= 8) return fail(75, 'This machine is already running eight Grid commands. Retry when one finishes.')
    const controller = new AbortController()
    this.jobs.set(key, controller)
    try {
      return await new Promise<GridFleetResult>(resolve => {
        const output = { stdout: new GridOutputCapture(), stderr: new GridOutputCapture() }
        let stopped: string | null = null, done = false
        let timeout: ReturnType<typeof setTimeout>, kill: ReturnType<typeof setTimeout> | undefined
        const child = spawn(gridBinaryPath(this.processEnv), request.args, {
          env: { ...gridChildEnv(this.processEnv), ...(request.thinking === undefined ? {} : {
            LLAMA_ARG_CHAT_TEMPLATE_KWARGS: JSON.stringify({ enable_thinking: request.thinking }),
          }) }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        const finish = (code: number, error: string | null) => {
          if (done) return
          done = true; clearTimeout(timeout); clearTimeout(kill)
          resolve({ ok: code === 0 && !error, code, stdout: output.stdout.text, stderr: output.stderr.text, error })
        }
        const stop = (reason: string) => {
          if (stopped || done) return
          stopped = reason; child.kill('SIGTERM')
          kill = setTimeout(() => { child.kill('SIGKILL'); finish(124, reason) }, 1500)
        }
        const capture = (which: 'stdout' | 'stderr', chunk: string) => {
          if (stopped) return
          output[which].append(chunk)
          if (Buffer.byteLength(output.stdout.text) + Buffer.byteLength(output.stderr.text) > MAX_OUTPUT) {
            stop('Grid output exceeded 512 KiB; use a narrower query.'); return
          }
        }
        child.stdout.setEncoding('utf8').on('data', (data: string) => capture('stdout', data))
        child.stderr.setEncoding('utf8').on('data', (data: string) => capture('stderr', data))
        child.once('error', () => finish(127, 'Grid could not start on this machine. Check its Grid installation.'))
        child.once('close', code => finish(stopped ? 124 : code ?? 1, stopped || (code === 0 ? null : 'Grid command failed.')))
        timeout = setTimeout(() => stop('Grid command timed out. Verify the target state before retrying a deployment.'), request.timeoutMs)
        controller.signal.addEventListener('abort', () => stop('Grid command interrupted. Verify the target state before retrying.'), { once: true })
      })
    } finally { this.jobs.delete(key) }
  }
}
