/** Disposable one-shot processes used by device recaps and voice routing. */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { homedir, tmpdir, userInfo } from 'os'
import { env } from '../config/env.js'
import { findCursorTranscript } from '../engines/cursor/discovery.js'
import { cursorRuntimeBin } from './engineBin.js'
import {
  DisposableOneShotPool,
  type ActiveEngineCounts,
  type DisposableWorker,
  type OneShotEngine,
} from './disposableOneShotPool.js'
import { scrubTerminalContext } from './terminalEnvironment.js'

function claudeBin(): string {
  return env.CLAUDE_PATH || 'claude'
}

/**
 * Add one directory to devin's trusted-workspace list, if it is not already there.
 *
 * Devin 3000.3.22 refuses to run anywhere it has not been trusted interactively:
 *
 *   Error: Refusing to run in an untrusted workspace: <dir>
 *   Start `devin` interactively in this directory to trust it, or set
 *   `respect_workspace_trust: false` in your config to restore the previous behavior.
 *
 * The recap is headless and runs in a scratch dir machine just created, so there is no prompt for anyone
 * to answer and no session that survives it — hence this narrow exception to "harness edits no config":
 * ONE path is appended, the one being created here. The config-wide `respect_workspace_trust: false`
 * would switch the check off for the user's real projects too; every other entry, and the setting
 * itself, is left alone. The interactive vendor CLI does NOT use this — its pane can ask.
 */
export function trustDevinWorkspace(dir: string, onError?: (message: string) => void): void {
  const file = join(env.DEVIN_HOME, 'trusted_workspaces.json')
  let config: { trusted_paths?: unknown } = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
  } catch { /* absent or unreadable — a fresh list below is the right answer either way */ }
  const paths = Array.isArray(config.trusted_paths)
    ? config.trusted_paths.filter((p): p is string => typeof p === 'string')
    : []
  if (paths.includes(dir)) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...config, trusted_paths: [...paths, dir] }, null, 2)}\n`)
  } catch (err) {
    // Never fatal: devin then refuses with its own message, which is clearer than anything said here.
    onError?.(err instanceof Error ? err.message : String(err))
  }
}

function cursorBin(): string {
  const bin = cursorRuntimeBin()
  if (bin) return bin
  throw new Error('Cursor CLI command is ambiguous or unavailable; install cursor-agent or set CURSOR_PATH to its absolute path')
}

function buildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || homedir(),
    USER: process.env.USER || userInfo().username,
    LOGNAME: process.env.LOGNAME || process.env.USER || userInfo().username,
    TMPDIR: tmpdir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: process.env.TERM || 'xterm-256color',
    NODE_ENV: process.env.NODE_ENV || 'production',
    ...(process.env.ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
    ...(process.env.ANTHROPIC_AUTH_TOKEN && { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN }),
  }
}

export interface OneShotOptions {
  prompt: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
}

type OneShotResult = { text: string; sessionId: string | null }

function abortError(engine: OneShotEngine): Error {
  return Object.assign(new Error(`${engine} one-shot aborted`), { name: 'AbortError' })
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid == null || child.exitCode != null) return
  try { process.kill(-child.pid, signal) } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

export async function cleanupCursorOneShotSession(sessionId: string): Promise<void> {
  const transcript = await findCursorTranscript(env.CURSOR_HOME, sessionId)
  if (transcript) await rm(dirname(transcript), { recursive: true, force: true }).catch(() => {})

  const chatsRoot = join(env.CURSOR_HOME, 'chats')
  const workspaces = await readdir(chatsRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(workspaces
    .filter((entry) => entry.isDirectory())
    .map((entry) => rm(join(chatsRoot, entry.name, sessionId), { recursive: true, force: true }).catch(() => {})))
}

abstract class ProcessWorker implements DisposableWorker<OneShotOptions, OneShotResult> {
  readonly createdAt = Date.now()
  protected assigned = false
  protected readonly child: ChildProcess
  private readonly exitListeners = new Set<() => void>()
  private readonly spawned: Promise<void>

  abstract readonly engine: OneShotEngine
  abstract run(options: OneShotOptions): Promise<OneShotResult>

  constructor(child: ChildProcess) {
    this.child = child
    this.spawned = new Promise((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    child.once('close', () => {
      for (const listener of this.exitListeners) listener()
      this.exitListeners.clear()
    })
  }

  ready(): Promise<this> {
    return this.spawned.then(() => this)
  }

  isAlive(): boolean {
    return this.child.exitCode == null && !this.child.killed
  }

  onExit(listener: () => void): void {
    this.exitListeners.add(listener)
  }

  dispose(): void {
    killGroup(this.child)
  }
}

class ClaudeWorker extends ProcessWorker {
  readonly engine = 'claude' as const
  private buffer = ''
  private stderr = ''
  private sessionId: string | null = null
  private resultText = ''
  private readonly assistantParts: string[] = []
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(cwd: string, model?: string, effort?: OneShotOptions['effort']) {
    const args = [
      '--print', '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--no-session-persistence',
      // Recap is pure text condensation. Keep Claude from loading project/user customizations,
      // slash-command skills, MCP servers, or built-in tools.
      '--safe-mode',
      '--disable-slash-commands',
      '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ]
    const child = spawn(claudeBin(), args, {
      cwd, env: buildEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (this.buffer.trim()) this.handleLine(this.buffer)
      if (!this.pending) return
      const text = (this.resultText || this.assistantParts.join('')).trim()
      if (!text && code !== 0) this.fail(new Error(`claude one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('claude recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`claude one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('claude recap worker is not writable'))
        return
      }
      try {
        this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: options.prompt } }) + '\n')
      } catch (err) {
        this.fail(err)
      }
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.handleLine(line)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try { evt = JSON.parse(trimmed) } catch { return }
    if (typeof evt.session_id === 'string' && !this.sessionId) this.sessionId = evt.session_id
    if (evt.type === 'assistant') {
      const content = (evt.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
      if (Array.isArray(content)) {
        const text = content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
        if (text) this.assistantParts.push(text)
      }
    }
    if (evt.type === 'result') {
      if (typeof evt.result === 'string') this.resultText = evt.result
      this.complete((this.resultText || this.assistantParts.join('')).trim())
    }
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    const pending = this.cleanupPending()
    pending?.resolve({ text, sessionId: this.sessionId })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

class CodexWorker extends ProcessWorker {
  readonly engine = 'codex' as const
  private stderr = ''
  private readonly output: string
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(cwd: string, model?: string, effort?: OneShotOptions['effort']) {
    const output = join(cwd, `.codex-recap-${randomUUID()}.txt`)
    const args = [
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--ignore-user-config', '--ignore-rules', '--output-last-message', output,
      ...(model ? ['--model', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      '-',
    ]
    const processEnv = scrubTerminalContext({ ...process.env })
    const child = spawn(process.env.CODEX_PATH || 'codex', args, {
      cwd, env: processEnv, detached: true, stdio: ['pipe', 'ignore', 'pipe'],
    })
    super(child)
    this.output = output
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => { void this.onClose(code) })
  }

  override dispose(): void {
    super.dispose()
    void unlink(this.output).catch(() => {})
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('codex recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`codex one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('codex recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  private async onClose(code: number | null): Promise<void> {
    if (!this.pending) return
    const text = (await readFile(this.output, 'utf8').catch(() => '')).trim()
    await unlink(this.output).catch(() => {})
    if (!text && code !== 0) this.fail(new Error(`codex one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
    else this.complete(text)
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: null })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

class CursorWorker extends ProcessWorker {
  readonly engine = 'cursor' as const
  private buffer = ''
  private stderr = ''
  private sessionId: string | null = null
  private resultText = ''
  private cleanupScheduled = false
  private readonly assistantParts: string[] = []
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(cwd: string, model?: string) {
    const args = [
      '--print',
      '--mode', 'ask',
      '--sandbox', 'enabled',
      '--trust',
      '--output-format', 'stream-json',
      ...(model ? ['--model', model] : []),
    ]
    const processEnv = scrubTerminalContext({ ...process.env })
    const child = spawn(cursorBin(), args, {
      cwd, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (this.buffer.trim()) this.handleLine(this.buffer)
      if (!this.pending) return
      const text = (this.resultText || this.assistantParts.join('')).trim()
      if (!text && code !== 0) this.fail(new Error(`cursor one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('cursor recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`cursor one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('cursor recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  override dispose(): void {
    super.dispose()
    if (this.cleanupScheduled) return
    this.cleanupScheduled = true
    const cleanup = (): void => {
      if (this.sessionId) void cleanupCursorOneShotSession(this.sessionId)
    }
    if (this.child.exitCode != null) cleanup()
    else this.child.once('close', cleanup)
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.handleLine(line)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try { evt = JSON.parse(trimmed) } catch { return }
    if (typeof evt.session_id === 'string' && !this.sessionId) this.sessionId = evt.session_id
    if (evt.type === 'assistant') {
      const content = (evt.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
      if (Array.isArray(content)) {
        const text = content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
        if (text) this.assistantParts.push(text)
      }
    }
    if (evt.type !== 'result') return
    if (typeof evt.result === 'string') this.resultText = evt.result
    if (evt.is_error === true || evt.subtype === 'error') {
      this.fail(new Error(`cursor one-shot failed: ${(this.resultText || this.stderr).slice(0, 500)}`))
      return
    }
    this.complete((this.resultText || this.assistantParts.join('')).trim())
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: this.sessionId })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

function opencodeBin(): string {
  return env.OPENCODE_PATH || 'opencode'
}

// Recap runs in an isolated OpenCode data dir so ephemeral summary sessions never land in the user's
// real opencode.db, while still reading their ~/.config/opencode provider/model config.
const OPENCODE_RECAP_DATA_DIR = join(env.ADAPTER_DATA_DIR, 'opencode-recap')

class OpencodeWorker extends ProcessWorker {
  readonly engine = 'opencode' as const
  private buffer = ''
  private stderr = ''
  private readonly assistantParts: string[] = []
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(model?: string) {
    // `opencode run` reads the prompt from stdin (pipe → EOF), so the worker can be pre-warmed and fed
    // the prompt later. `--pure` skips external plugins (so the machine discovery plugin never
    // self-registers this ephemeral recap session). `--format json` streams `{type:'text',part:{text}}`.
    mkdirSync(OPENCODE_RECAP_DATA_DIR, { recursive: true, mode: 0o700 })
    const args = ['run', '--pure', '--format', 'json', ...(model ? ['--model', model] : [])]
    const processEnv = scrubTerminalContext({ ...process.env })
    processEnv.OPENCODE_DATA_DIR = OPENCODE_RECAP_DATA_DIR
    const child = spawn(opencodeBin(), args, {
      cwd: OPENCODE_RECAP_DATA_DIR, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (this.buffer.trim()) this.handleLine(this.buffer)
      if (!this.pending) return
      const text = this.assistantParts.join('').trim()
      if (!text && code !== 0) this.fail(new Error(`opencode one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('opencode recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`opencode one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('opencode recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.handleLine(line)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try { evt = JSON.parse(trimmed) } catch { return }
    if (evt.type === 'text') {
      const part = evt.part as { text?: string } | undefined
      if (part && typeof part.text === 'string') this.assistantParts.push(part.text)
    }
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: null })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

function kiloBin(): string {
  return env.KILO_PATH || 'kilo'
}

/**
 * Recap runs in an isolated Kilo data dir so ephemeral summary sessions never land in the user's real
 * kilo.db, while still reading their ~/.config/kilo provider/model config.
 *
 * The isolation mechanism is where kilo parts company with the opencode it forked. Opencode honours
 * `OPENCODE_DATA_DIR`; kilo has no equivalent — measured with `kilo debug paths`, it ignores both
 * `KILO_DATA_DIR` and `OPENCODE_DATA_DIR` and moves its store only for `XDG_DATA_HOME`. So the child is
 * given that instead, and because kilo appends its own name, the store lands at `<dir>/kilo/kilo.db`.
 *
 * `XDG_CONFIG_HOME` is deliberately NOT set: it would move the config root too and the recap would lose
 * the user's provider and model, which is the one thing this worker has to inherit.
 *
 * First spawn into a fresh dir prints `Performing one time database migration` and pays for it; the pool
 * pre-warms workers, so that cost lands before a recap is ever asked for.
 */
const KILO_RECAP_DATA_DIR = join(env.ADAPTER_DATA_DIR, 'kilo-recap')

/**
 * The argv + env for one kilo recap worker. Exported so the containment rules below are testable — a
 * spawn is not, and both of these have already failed in production once.
 */
export function kiloOneShotSpawn(
  model: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
  dataDir: string = KILO_RECAP_DATA_DIR,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    'run', '--pure', '--auto', '--format', 'json', '--dir', dataDir,
    ...(model ? ['--model', model] : []),
  ]
  const childEnv = scrubTerminalContext({ ...parentEnv })
  childEnv.XDG_DATA_HOME = dataDir
  // Belt and braces with `--dir`. `spawn({cwd})` does NOT rewrite `PWD`, and kilo resolves its project
  // from that variable, so without this the child inherits the DAEMON's directory.
  childEnv.PWD = dataDir
  return { args, env: childEnv }
}

class KiloWorker extends ProcessWorker {
  readonly engine = 'kilo' as const
  private buffer = ''
  private stderr = ''
  private readonly assistantParts: string[] = []
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(model?: string) {
    // `kilo run` reads the prompt from stdin (pipe → EOF), so the worker can be pre-warmed and fed the
    // prompt later. `--pure` skips external plugins (so the discovery plugin never self-registers this
    // ephemeral recap session). `--format json` streams one JSON envelope per line.
    //
    // `--auto` is REQUIRED for this disposable worker only. Measured:
    // without it a recap run whose model reaches for any tool dies outright — kilo auto-rejects the
    // permission and ends the run (`run ended with an auto-rejected permission; pass --auto for
    // autonomous use`), emitting an `error` envelope and NO text. A summariser has no user to ask, and a
    // recap that returns nothing is the failure this flag prevents. Note the asymmetry that makes this
    // easy to get wrong: `--auto` is a valid flag of the `run` SUBCOMMAND, while the bare TUI rejects it
    // — the interactive TUI remains entirely under the user's own permission configuration.
    mkdirSync(KILO_RECAP_DATA_DIR, { recursive: true, mode: 0o700 })
    // `--dir` pins the workspace explicitly. Do NOT rely on the spawn `cwd` alone: kilo resolves its
    // project from `$PWD`, and `spawn({cwd})` does not rewrite that variable — the child inherits the
    // DAEMON's `PWD`. Measured in production: the worker logged
    // `kilocode-indexing workspacePath=<the daemon's launch directory> initializing project indexing`
    // the moment a prompt arrived, i.e. every recap ran against the user's real repository instead of an
    // empty scratch dir. It then hung indexing and gathering context until the 60s timeout, so no
    // `turn_summary` was ever emitted and the device tile stayed on `processing` forever.
    const { args, env: processEnv } = kiloOneShotSpawn(model, process.env)
    const child = spawn(kiloBin(), args, {
      cwd: KILO_RECAP_DATA_DIR, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (this.buffer.trim()) this.handleLine(this.buffer)
      if (!this.pending) return
      const text = this.assistantParts.join('').trim()
      if (!text && code !== 0) this.fail(new Error(`kilo one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('kilo recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`kilo one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('kilo recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.handleLine(line)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try { evt = JSON.parse(trimmed) } catch { return }
    if (evt.type === 'text') {
      const part = evt.part as { text?: string } | undefined
      if (part && typeof part.text === 'string') this.assistantParts.push(part.text)
    }
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: null })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

function piBin(): string {
  return env.PI_PATH || 'pi'
}

class PiWorker extends ProcessWorker {
  readonly engine = 'pi' as const
  private stdout = ''
  private stderr = ''
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(cwd: string, model?: string) {
    // `pi -p` reads the prompt from piped stdin (merged into the initial prompt) and prints the plain
    // answer, so the worker can be pre-warmed and fed later. `--no-session` keeps the recap out of the
    // user's session store; `--no-extensions` stops the machine discovery extension from registering it.
    const args = ['-p', '--no-session', '--no-extensions', ...(model ? ['--model', model] : [])]
    const processEnv = scrubTerminalContext({ ...process.env })
    const child = spawn(piBin(), args, {
      cwd, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => { this.stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (!this.pending) return
      const text = this.stdout.trim()
      if (!text && code !== 0) this.fail(new Error(`pi one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('pi recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`pi one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('pi recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: null })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

function commandCodeBin(): string {
  return env.COMMANDCODE_PATH || 'commandcode'
}

class CommandCodeWorker extends ProcessWorker {
  readonly engine = 'commandcode' as const
  private stdout = ''
  private stderr = ''
  private pending: {
    resolve: (result: OneShotResult) => void
    reject: (err: unknown) => void
    timer: NodeJS.Timeout
    signal?: AbortSignal
    onAbort: () => void
  } | null = null

  constructor(cwd: string, model?: string) {
    // `commandcode -p` reads the prompt from piped stdin (verified), so the worker pre-warms and is fed
    // later. `--no-session` keeps the recap out of the user's project/session list — without it every
    // recap shows up as a session. There is no --no-hooks flag; the scrubbed terminal context below
    // stops our own SessionStart hook registering this process.
    const args = ['-p', '--no-session', ...(model ? ['-m', model] : [])]
    const processEnv = scrubTerminalContext({ ...process.env })
    const child = spawn(commandCodeBin(), args, {
      cwd, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    super(child)
    child.stdout?.on('data', (chunk: Buffer) => { this.stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    child.stdin?.on('error', (err) => this.fail(err))
    child.on('error', (err) => this.fail(err))
    child.on('close', (code) => {
      if (!this.pending) return
      const text = this.stdout.trim()
      if (!text && code !== 0) this.fail(new Error(`commandcode one-shot exited ${code}: ${this.stderr.slice(0, 500)}`))
      else this.complete(text)
    })
  }

  run(options: OneShotOptions): Promise<OneShotResult> {
    if (this.assigned) return Promise.reject(new Error('commandcode recap worker already consumed'))
    this.assigned = true
    if (options.signal?.aborted) return Promise.reject(abortError(this.engine))
    const timeoutMs = options.timeoutMs ?? 60_000
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.fail(abortError(this.engine)); this.dispose() }
      const timer = setTimeout(() => {
        this.fail(new Error(`commandcode one-shot timed out after ${timeoutMs}ms`))
        this.dispose()
      }, timeoutMs)
      this.pending = { resolve, reject, timer, signal: options.signal, onAbort }
      options.signal?.addEventListener('abort', onAbort)
      if (!this.child.stdin || this.child.stdin.destroyed || !this.isAlive()) {
        this.fail(new Error('commandcode recap worker is not writable'))
        return
      }
      try { this.child.stdin.end(options.prompt) } catch (err) { this.fail(err) }
    })
  }

  private cleanupPending(): typeof this.pending {
    const pending = this.pending
    if (!pending) return null
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    return pending
  }

  private complete(text: string): void {
    this.cleanupPending()?.resolve({ text, sessionId: null })
  }

  private fail(err: unknown): void {
    this.cleanupPending()?.reject(err)
  }
}

let config: {
  cwd: string
  claudeModel?: string
  codexModel?: string
  cursorModel?: string
  opencodeModel?: string
  kiloModel?: string
  piModel?: string
  commandcodeModel?: string
  effort?: OneShotOptions['effort']
} | null = null
const pool = new DisposableOneShotPool<OneShotOptions, OneShotResult>(async (engine) => {
  if (!config) throw new Error('recap pool is not configured')
  if (engine === 'claude') return new ClaudeWorker(config.cwd, config.claudeModel, config.effort).ready()
  if (engine === 'codex') return new CodexWorker(config.cwd, config.codexModel, config.effort).ready()
  if (engine === 'cursor') return new CursorWorker(config.cwd, config.cursorModel).ready()
  if (engine === 'pi') return new PiWorker(config.cwd, config.piModel).ready()
  if (engine === 'commandcode') return new CommandCodeWorker(config.cwd, config.commandcodeModel).ready()
  if (engine === 'kilo') return new KiloWorker(config.kiloModel).ready()
  return new OpencodeWorker(config.opencodeModel).ready()
})

export function configureOneShotPool(next: {
  cwd: string
  claudeModel?: string
  codexModel?: string
  cursorModel?: string
  opencodeModel?: string
  kiloModel?: string
  piModel?: string
  commandcodeModel?: string
  effort?: OneShotOptions['effort']
}): void {
  const changed = config != null && (
    config.cwd !== next.cwd || config.claudeModel !== next.claudeModel ||
    config.codexModel !== next.codexModel || config.cursorModel !== next.cursorModel ||
    config.opencodeModel !== next.opencodeModel || config.kiloModel !== next.kiloModel ||
    config.piModel !== next.piModel ||
    config.commandcodeModel !== next.commandcodeModel || config.effort !== next.effort
  )
  config = next
  if (changed) pool.recycleReady()
}

export function setOneShotPoolActiveCounts(counts: ActiveEngineCounts): void {
  pool.setActiveCounts(counts)
}

export function setOneShotPoolDeviceConnected(connected: boolean): void {
  pool.setDeviceConnected(connected)
}

export function shutdownOneShotPool(): void {
  pool.shutdown()
}

/** Spawn ONE worker for an engine. Shared by the cold path and both warm pools so a pooled worker can
 *  never be started differently from a direct one. */
function createOneShotWorker(
  engine: OneShotEngine,
  cwd: string,
  model?: string,
  effort?: OneShotOptions['effort'],
): Promise<DisposableWorker<OneShotOptions, OneShotResult>> {
  return engine === 'claude'
    ? new ClaudeWorker(cwd, model, effort).ready()
    : engine === 'codex'
      ? new CodexWorker(cwd, model, effort).ready()
      : engine === 'cursor'
        ? new CursorWorker(cwd, model).ready()
        : engine === 'pi'
          ? new PiWorker(cwd, model).ready()
          : engine === 'commandcode'
            ? new CommandCodeWorker(cwd, model).ready()
            : engine === 'kilo'
              ? new KiloWorker(model).ready()
              : new OpencodeWorker(model).ready()
}

async function runDirect(engine: OneShotEngine, opts: OneShotOptions): Promise<OneShotResult> {
  const worker = await createOneShotWorker(engine, opts.cwd, opts.model, opts.effort)
  try { return await worker.run(opts) } finally { worker.dispose() }
}

export function runClaudeOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('claude'))
  if (!config || config.cwd !== opts.cwd || config.claudeModel !== opts.model || config.effort !== opts.effort) {
    return runDirect('claude', opts)
  }
  return pool.run('claude', opts)
}

export function runCodexOneShot(opts: OneShotOptions): Promise<{ text: string; sessionId: null }> {
  if (opts.signal?.aborted) return Promise.reject(abortError('codex'))
  const run = !config || config.cwd !== opts.cwd || config.codexModel !== opts.model || config.effort !== opts.effort
    ? runDirect('codex', opts)
    : pool.run('codex', opts)
  return run.then((result) => ({ text: result.text, sessionId: null }))
}

export function runCursorOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('cursor'))
  if (!config || config.cwd !== opts.cwd || config.cursorModel !== opts.model) {
    return runDirect('cursor', opts)
  }
  return pool.run('cursor', opts)
}

/** The measured Grok 1.0.0 headless invocation. A fresh GROK_HOME contains every persisted session. */
export function grokOneShotSpawn(
  opts: Pick<OneShotOptions, 'prompt' | 'model' | 'effort' | 'cwd'>,
  scratchHome: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    '--cwd', opts.cwd,
    '--always-approve', '--no-memory', '--no-plan', '--max-turns', '1',
    '--output-format', 'json',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
    '-p', opts.prompt,
  ]
  const childEnv: NodeJS.ProcessEnv = scrubTerminalContext({ ...parentEnv, GROK_HOME: scratchHome })
  delete childEnv.MACHINE_ID
  return { args, env: childEnv }
}

function grokOutputText(stdout: string): string {
  const candidates = [stdout.trim(), ...stdout.trim().split('\n').reverse()]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { text?: unknown; result?: unknown }
      if (typeof parsed.text === 'string') return parsed.text.trim()
      if (typeof parsed.result === 'string') return parsed.result.trim()
    } catch { /* try the next complete JSON value */ }
  }
  return ''
}

/** Grok takes its print prompt on argv, so it cannot be pre-warmed. Its real CLI always persists a
 * session; isolating GROK_HOME and deleting it afterwards is the no-pollution equivalent. */
export async function runGrokOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) throw Object.assign(new Error('grok one-shot aborted'), { name: 'AbortError' })
  mkdirSync(opts.cwd, { recursive: true })
  const scratchHome = await mkdtemp(join(opts.cwd, '.grok-recap-'))
  try {
    // Copy auth/config into the short-lived home. A symlink would keep session writes isolated but still
    // let a token refresh or config migration mutate the user's real files through the link.
    for (const name of ['auth.json', 'config.toml']) {
      const source = join(env.GROK_HOME, name)
      if (!existsSync(source)) continue
      const target = join(scratchHome, name)
      await copyFile(source, target)
      await chmod(target, 0o600)
    }
    const { args, env: processEnv } = grokOneShotSpawn(opts, scratchHome)
    const timeoutMs = opts.timeoutMs ?? 60_000
    return await new Promise<OneShotResult>((resolve, reject) => {
      const child = spawn(env.GROK_PATH || 'grok', args, {
        cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const kill = (): void => killGroup(child)
      const onAbort = (): void => {
        finish(() => reject(Object.assign(new Error('grok one-shot aborted'), { name: 'AbortError' })))
        kill()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`grok one-shot timed out after ${timeoutMs}ms`)))
        kill()
      }, timeoutMs)
      opts.signal?.addEventListener('abort', onAbort)
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', (err) => finish(() => reject(err)))
      child.on('close', (code) => {
        const text = grokOutputText(stdout)
        finish(() => {
          if (!text) reject(new Error(`grok one-shot exited ${code}: ${stderr.slice(0, 500)}`))
          else resolve({ text, sessionId: null })
        })
      })
    })
  } finally {
    await rm(scratchHome, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The measured Antigravity 1.1.14 headless invocation.
 *
 * `-p` takes the prompt on argv, so this cannot be pre-warmed into the worker pool.
 *
 * Two deliberate omissions:
 *  - **No scratch data dir.** `ANTIGRAVITY_EXECUTABLE_DATA_DIR` looks like the override and is not one
 *    (measured: the run still wrote to the real `~/.gemini/antigravity-cli`), and a scratch `HOME` DOES
 *    isolate the store but takes the credentials with it — the re-auth prompt makes it unusable for a
 *    background worker. So the run lands in the user's store and is deleted afterwards by id.
 *  - **No workspace.** `-p` opens none, and agy refuses every tool without one ("no active workspace"),
 *    which is exactly the confinement a recap wants: it cannot read or write the user's files at all.
 */
export function agyOneShotSpawn(
  opts: Pick<OneShotOptions, 'prompt' | 'model' | 'effort'>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    '--output-format', 'json',
    // A recap prompt is user text; without this a leading `/` would be expanded as a slash command.
    '--disable-slash-commands',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    '-p', opts.prompt,
  ]
  const childEnv = scrubTerminalContext({ ...parentEnv })
  delete childEnv.MACHINE_ID
  return { args, env: childEnv }
}

interface AgyOneShotOutput {
  text: string
  conversationId: string
}

/** agy prints one JSON object: `{conversation_id, status, response, duration_seconds, usage}`. */
export function agyOutputText(stdout: string): AgyOneShotOutput {
  const raw = stdout.trim()
  // The id is needed for cleanup even when the envelope does not parse, so read it directly too.
  const idMatch = /"conversation_id"\s*:\s*"([0-9a-f-]{16,})"/i.exec(raw)
  const conversationId = idMatch ? idMatch[1] : ''
  for (const candidate of [raw, ...raw.split('\n').reverse()]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { response?: unknown; conversation_id?: unknown }
      if (typeof parsed.response === 'string') {
        return { text: parsed.response.trim(), conversationId: typeof parsed.conversation_id === 'string' ? parsed.conversation_id : conversationId }
      }
    } catch { /* try the next complete JSON value */ }
  }
  return { text: '', conversationId }
}

/**
 * Remove the conversation a recap created.
 *
 * One `-p` run leaves exactly five artifacts, all named by the conversation id (measured):
 * `brain/<id>/`, `conversations/<id>.db` plus its `-wal`/`-shm`, and `presence/<id>.lock`. Deleting by
 * id touches nothing else, so a concurrent interactive agy session is never at risk.
 */
async function removeAgyConversation(conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{16,}$/i.test(conversationId)) return
  const targets = [
    join(env.AGY_HOME, 'brain', conversationId),
    join(env.AGY_HOME, 'conversations', `${conversationId}.db`),
    join(env.AGY_HOME, 'conversations', `${conversationId}.db-wal`),
    join(env.AGY_HOME, 'conversations', `${conversationId}.db-shm`),
    join(env.AGY_HOME, 'presence', `${conversationId}.lock`),
  ]
  for (const target of targets) await rm(target, { recursive: true, force: true }).catch(() => {})
}

export async function runAgyOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) throw Object.assign(new Error('agy one-shot aborted'), { name: 'AbortError' })
  const { args, env: processEnv } = agyOneShotSpawn(opts)
  const timeoutMs = opts.timeoutMs ?? 60_000
  let created = ''
  try {
    return await new Promise<OneShotResult>((resolve, reject) => {
      const child = spawn(env.AGY_PATH || 'agy', args, {
        cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const kill = (): void => killGroup(child)
      const onAbort = (): void => {
        created = created || agyOutputText(stdout).conversationId
        finish(() => reject(Object.assign(new Error('agy one-shot aborted'), { name: 'AbortError' })))
        kill()
      }
      const timer = setTimeout(() => {
        created = created || agyOutputText(stdout).conversationId
        finish(() => reject(new Error(`agy one-shot timed out after ${timeoutMs}ms`)))
        kill()
      }, timeoutMs)
      opts.signal?.addEventListener('abort', onAbort)
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', (err) => finish(() => reject(err)))
      child.on('close', (code) => {
        const { text, conversationId } = agyOutputText(stdout)
        created = conversationId
        finish(() => {
          if (!text) reject(new Error(`agy one-shot exited ${code}: ${stderr.slice(0, 500)}`))
          else resolve({ text, sessionId: null })
        })
      })
    })
  } finally {
    // An aborted run may still have created the conversation before it died, so this runs either way.
    if (created) await removeAgyConversation(created)
  }
}

/**
 * The measured Copilot CLI 1.0.80 headless invocation.
 *
 * Three things settled by running it:
 *
 *  - **`--no-color` makes stdout the answer and nothing else.** The "Changes / AI Credits / Tokens /
 *    Resume" block goes to stderr, so the recap needs no parsing at all — 12 bytes of stdout for a
 *    12-byte reply.
 *  - **`--available-tools` with no values leaves the model no tools.** `-p` demands
 *    `--allow-all-tools`, which on its own would let a recap run shell commands; pairing the two gives
 *    a run that can answer but cannot touch anything.
 *  - **`--session-id` accepts a UUID we choose for a NEW session**, so the state this leaves behind is
 *    known before it exists and can be removed by name rather than by scraping stderr.
 */
export function copilotOneShotSpawn(
  opts: Pick<OneShotOptions, 'prompt' | 'model'>,
  sessionId: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    '-p', opts.prompt,
    '--allow-all-tools',
    '--available-tools',
    '--no-color',
    '--session-id', sessionId,
    ...(opts.model ? ['--model', opts.model] : []),
  ]
  const childEnv = scrubTerminalContext({ ...parentEnv })
  delete childEnv.MACHINE_ID
  return { args, env: childEnv }
}

/**
 * Remove the session a recap created.
 *
 * The event stream lives in a directory named by the id, so it goes cleanly. The row Copilot also
 * writes into `session-store.db` is deliberately left alone: that database belongs to the user's
 * running CLI, and deleting from it to tidy a recap is not worth writing into a live vendor store.
 * The cost is an unnamed entry in `copilot --resume`.
 */
async function removeCopilotSession(sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return
  await rm(join(env.COPILOT_HOME, 'session-state', sessionId), { recursive: true, force: true }).catch(() => {})
}

export async function runCopilotOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) throw Object.assign(new Error('copilot one-shot aborted'), { name: 'AbortError' })
  const sessionId = randomUUID()
  const { args, env: processEnv } = copilotOneShotSpawn(opts, sessionId)
  const timeoutMs = opts.timeoutMs ?? 60_000
  try {
    return await new Promise<OneShotResult>((resolve, reject) => {
      const child = spawn(env.COPILOT_PATH || 'copilot', args, {
        cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const kill = (): void => killGroup(child)
      const onAbort = (): void => {
        finish(() => reject(Object.assign(new Error('copilot one-shot aborted'), { name: 'AbortError' })))
        kill()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`copilot one-shot timed out after ${timeoutMs}ms`)))
        kill()
      }, timeoutMs)
      opts.signal?.addEventListener('abort', onAbort)
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', (err) => finish(() => reject(err)))
      child.on('close', (code) => {
        const text = stdout.trim()
        finish(() => {
          if (!text) reject(new Error(`copilot one-shot exited ${code}: ${stderr.slice(0, 500)}`))
          else resolve({ text, sessionId: null })
        })
      })
    })
  } finally {
    await removeCopilotSession(sessionId)
  }
}

function hermesBin(): string {
  return env.HERMES_PATH || 'hermes'
}

/**
 * Hermes recap. Unlike every other engine, `hermes chat -q` takes the prompt as **argv, not stdin**, so
 * a worker cannot be pre-warmed — each recap spawns a fresh process (Hermes is deliberately absent from
 * `OneShotEngine`/the warm pool).
 *
 * Notably we do NOT pass `--safe-mode`: it implies `--ignore-user-config`, which would discard the
 * user's model/provider (their whole reason for a working recap). Self-registration is prevented the
 * same way every other worker does it: every terminal location variable is scrubbed. `--source tool`
 * keeps it out of the user's session list.
 */
function museBin(): string {
  return env.MUSE_PATH || 'muse'
}

/**
 * One-shot recap through `muse exec`.
 *
 * Prompt goes as ARGV (muse has no stdin mode), so this worker cannot be pre-warmed the way a stdin-fed
 * CLI can — it is deliberately outside the pool. `--json` is not used: the recap wants the answer, not
 * the event stream. Terminal context is stripped so the worker cannot register itself as an agent, and
 * MUSE_NO_AUTO_UPDATE keeps a background self-update from swapping the binary mid-run.
 */
export function runMuseOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('muse one-shot aborted'), { name: 'AbortError' }))
  const args = ['exec', opts.prompt, ...(opts.model ? ['--model', opts.model] : [])]
  const processEnv: NodeJS.ProcessEnv = scrubTerminalContext({ ...process.env, MUSE_NO_AUTO_UPDATE: '1' })
  const timeoutMs = opts.timeoutMs ?? 60_000

  return new Promise<OneShotResult>((resolve, reject) => {
    const child = spawn(museBin(), args, {
      cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      if (child.pid == null || child.exitCode != null) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
    const onAbort = (): void => {
      finish(() => reject(Object.assign(new Error('muse one-shot aborted'), { name: 'AbortError' })))
      kill()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`muse one-shot timed out after ${timeoutMs}ms`)))
      kill()
    }, timeoutMs)
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      // muse prints a `muse: workspace root: …` preamble before the answer — drop it.
      const text = stdout.split('\n').filter((line) => !/^\s*muse:\s/.test(line)).join('\n').trim()
      finish(() => {
        if (!text && code !== 0) reject(new Error(`muse one-shot exited ${code}: ${stderr.slice(0, 500)}`))
        else resolve({ text, sessionId: null })
      })
    })
  })
}

/**
 * One-shot recap through `amp -x`.
 *
 * The prompt goes as ARGV, so like muse this worker cannot be pre-warmed and stays outside the pool.
 *
 * `model` here is an agent MODE, not a model name: Amp exposes no model list and `-m low|medium|high|ultra`
 * is what chooses one. `low` is both the cheapest and plenty for a one-sentence recap.
 *
 * Self-registration is prevented twice over. The adapter's Amp plugin already refuses to do anything
 * without machine and terminal context, and both are scrubbed here; `AMP_DISABLE_PLUGINS` then stops it
 * loading at all, which also keeps a user's own plugins out of a recap. `-x` archives the thread it
 * creates once it finishes, so recaps do not accumulate in the user's thread list.
 */
/**
 * One attempt at `amp -x`. Resolves with the text, or null when Amp gave up on its own.
 *
 * The prompt goes on STDIN, not argv. Measured, and the difference is not subtle: with a real ~1KB
 * recap prompt as an argument, 1 run in 10 produced output — the other nine died at a flat ~32s on
 * Amp's own `Error: Network timeout. Check your connection or proxy settings and retry.` The same
 * prompt through stdin succeeded 2 in 3. (A trivial "reply OK" prompt succeeds either way, which is
 * exactly why the first round of testing missed this.)
 */
function ampOneShotAttempt(opts: OneShotOptions, timeoutMs: number): Promise<OneShotResult | null> {
  const args = ['-x', '--no-notifications', '-m', opts.model || env.AMP_SUMMARY_MODE]
  const processEnv: NodeJS.ProcessEnv = scrubTerminalContext({ ...process.env, AMP_DISABLE_PLUGINS: '1' })
  delete processEnv.MACHINE_ID

  return new Promise<OneShotResult | null>((resolve, reject) => {
    const child = spawn(env.AMP_PATH || 'amp', args, {
      cwd: opts.cwd, env: processEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      if (child.pid == null || child.exitCode != null) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
    const onAbort = (): void => {
      finish(() => reject(Object.assign(new Error('amp one-shot aborted'), { name: 'AbortError' })))
      kill()
    }
    const timer = setTimeout(() => { finish(() => resolve(null)); kill() }, timeoutMs)
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', () => {
      const text = stdout.trim()
      // Amp exits non-zero even on runs that DID answer (seen repeatedly), so the output is the verdict,
      // not the exit code. Empty output means this attempt failed, whatever the code says.
      if (!text && stderr) console.warn(`[amp] one-shot attempt failed: ${stderr.replace(/\s+/g, ' ').slice(0, 120)}`)
      finish(() => resolve(text ? { text, sessionId: null } : null))
    })
    try { child.stdin?.end(opts.prompt) } catch { /* the close handler reports it */ }
  })
}

/**
 * One-shot recap through `amp -x`, retried.
 *
 * Amp is the only engine here that needs retrying, and it asks for it in its own error text. Its client
 * gives up on the network at a flat ~30s and exits with nothing; the very next run of the identical
 * prompt often succeeds. Three attempts turn the common transient failure into an answer, and a genuine
 * outage still ends in the same "no recap" it would have reached anyway.
 */
export async function runAmpOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) throw Object.assign(new Error('amp one-shot aborted'), { name: 'AbortError' })
  const perAttemptMs = opts.timeoutMs ?? 90_000
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await ampOneShotAttempt(opts, perAttemptMs)
    if (result) return result
    if (opts.signal?.aborted) throw Object.assign(new Error('amp one-shot aborted'), { name: 'AbortError' })
    if (attempt < 3) console.warn(`[amp] one-shot produced nothing — retrying (${attempt + 1}/3)`)
  }
  throw new Error('amp one-shot produced no output after 3 attempts')
}

export function runHermesOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('hermes one-shot aborted'), { name: 'AbortError' }))
  const args = ['chat', '-q', opts.prompt, '-Q', '--source', 'tool', ...(opts.model ? ['-m', opts.model] : [])]
  const processEnv = scrubTerminalContext({ ...process.env })
  const timeoutMs = opts.timeoutMs ?? 60_000

  return new Promise<OneShotResult>((resolve, reject) => {
    const child = spawn(hermesBin(), args, {
      cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      if (child.pid == null || child.exitCode != null) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
    const onAbort = (): void => {
      finish(() => reject(Object.assign(new Error('hermes one-shot aborted'), { name: 'AbortError' })))
      kill()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`hermes one-shot timed out after ${timeoutMs}ms`)))
      kill()
    }, timeoutMs)
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      // `-Q` still prints a `session_id: …` line before the answer — drop it.
      const text = stdout.split('\n').filter((line) => !/^\s*session_id:\s/.test(line)).join('\n').trim()
      finish(() => {
        if (!text && code !== 0) reject(new Error(`hermes one-shot exited ${code}: ${stderr.slice(0, 500)}`))
        else resolve({ text, sessionId: null })
      })
    })
  })
}

function devinBin(): string {
  return env.DEVIN_PATH || 'devin'
}


/**
 * Devin recap. Like Hermes — and unlike every pooled engine — the prompt must be **argv**: piping it to
 * `devin -p` panics the CLI outright (`called Result::unwrap() on an Err value`, verified on 3000.2.17),
 * so a worker cannot be pre-warmed and Devin is deliberately absent from `OneShotEngine`/the warm pool.
 *
 * `devin -p "<prompt>"` prints just the answer and exits 0. There is no `--no-session` equivalent, so the
 * recap does leave a row in `sessions.db`; it cannot register as an agent because every terminal
 * location variable is scrubbed.
 */
export function runDevinOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('devin one-shot aborted'), { name: 'AbortError' }))
  if (opts.cwd) trustDevinWorkspace(opts.cwd, (m) => console.warn('[recap] could not trust the devin scratch dir:', m))
  const args = ['-p', opts.prompt, ...(opts.model ? ['--model', opts.model] : [])]
  const processEnv = scrubTerminalContext({ ...process.env })
  const timeoutMs = opts.timeoutMs ?? 60_000

  return new Promise<OneShotResult>((resolve, reject) => {
    const child = spawn(devinBin(), args, {
      cwd: opts.cwd, env: processEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      if (child.pid == null || child.exitCode != null) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }
    const onAbort = (): void => {
      finish(() => reject(Object.assign(new Error('devin one-shot aborted'), { name: 'AbortError' })))
      kill()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`devin one-shot timed out after ${timeoutMs}ms`)))
      kill()
    }, timeoutMs)
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      const text = stdout.trim()
      finish(() => {
        if (!text && code !== 0) reject(new Error(`devin one-shot exited ${code}: ${stderr.slice(0, 500)}`))
        else resolve({ text, sessionId: null })
      })
    })
  })
}

export function runCommandCodeOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('commandcode'))
  if (!config || config.cwd !== opts.cwd || config.commandcodeModel !== opts.model) {
    return runDirect('commandcode', opts)
  }
  return pool.run('commandcode', opts)
}

export function runPiOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('pi'))
  if (!config || config.cwd !== opts.cwd || config.piModel !== opts.model) {
    return runDirect('pi', opts)
  }
  return pool.run('pi', opts)
}

export function runOpencodeOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('opencode'))
  if (!config || config.cwd !== opts.cwd || config.opencodeModel !== opts.model) {
    return runDirect('opencode', opts)
  }
  return pool.run('opencode', opts)
}

export function runKiloOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError('kilo'))
  if (!config || config.cwd !== opts.cwd || config.kiloModel !== opts.model) {
    return runDirect('kilo', opts)
  }
  return pool.run('kilo', opts)
}

// ── Voice-router warm worker ─────────────────────────────────────────────────────────────────────────
// The Overview voice router runs a tiny classifier on EVERY voice turn. Spawning the CLI each time paid a
// cold start (Node boot + CLI init + auth) that occasionally blew the 12s budget → "voice_route timed out".
// Keep ONE router worker warm (device-gated, like the recap pool) so the classify skips the spawn. Separate
// from the recap `pool` because the router uses its own small model, and only ever needs one worker.
//
// The ENGINE is chosen by the caller from the machine's live agents (see voiceRouter.chooseRouterEngine).
// It used to be pinned to claude here, which meant a machine with no Claude CLI never routed at all: the
// warm spawn failed on a loop and every voice fell through to the name-matching heuristic, whose capped
// confidence can never clear the backend's auto-dispatch threshold.
let routerConfig: { engine: OneShotEngine; cwd: string; model?: string; effort?: OneShotOptions['effort'] } | null = null
const routerPool = new DisposableOneShotPool<OneShotOptions, OneShotResult>(
  async () => {
    if (!routerConfig) throw new Error('router pool is not configured')
    return createOneShotWorker(routerConfig.engine, routerConfig.cwd, routerConfig.model, routerConfig.effort)
  },
  5 * 60_000,
  (line) => console.log(line.replace('[recap-pool]', '[router-pool]')),
)

/** Routing needs exactly ONE warm worker, of the configured engine — active=1 there, 0 everywhere else. */
function pinRouterEngine(engine: OneShotEngine): void {
  routerPool.setActiveCounts({
    claude: 0, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0, [engine]: 1,
  } as Parameters<typeof routerPool.setActiveCounts>[0])
}

export function configureRouterOneShot(next: { engine: OneShotEngine; cwd: string; model?: string; effort?: OneShotOptions['effort'] }): void {
  const changed = routerConfig != null && (
    routerConfig.engine !== next.engine || routerConfig.cwd !== next.cwd ||
    routerConfig.model !== next.model || routerConfig.effort !== next.effort
  )
  routerConfig = next
  pinRouterEngine(next.engine)
  // An engine change must drop the warm worker too — it is the wrong CLI now, not just the wrong model.
  if (changed) routerPool.recycleReady()
}

export function setRouterOneShotDeviceConnected(connected: boolean): void {
  routerPool.setDeviceConnected(connected)
}

export function shutdownRouterOneShot(): void {
  routerPool.shutdown()
}

/** Like runClaudeOneShot but served from the dedicated warm router worker (a cold spawn only if the pool
 *  isn't configured for this exact cwd/model/effort). */
export function runRouterOneShot(engine: OneShotEngine, opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError(engine))
  if (!routerConfig || routerConfig.engine !== engine || routerConfig.cwd !== opts.cwd ||
      routerConfig.model !== opts.model || routerConfig.effort !== opts.effort) {
    return runDirect(engine, opts)
  }
  return routerPool.run(engine, opts)
}
