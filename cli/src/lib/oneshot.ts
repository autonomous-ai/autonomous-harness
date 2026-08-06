/** Disposable, pre-spawned Claude/Codex/Cursor processes used by the device turn recap. */

import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readFile, readdir, rm, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { homedir, tmpdir, userInfo } from 'os'
import { env } from '../config/env.js'
import { findCursorTranscript } from '../engines/cursor/discovery.js'
import {
  DisposableOneShotPool,
  type ActiveEngineCounts,
  type DisposableWorker,
  type OneShotEngine,
} from './disposableOneShotPool.js'

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
 * itself, is left alone. `harness devin` does NOT use this — an interactive pane can ask.
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
  return env.CURSOR_PATH || 'agent'
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
    const processEnv = { ...process.env }
    delete processEnv.TMUX
    delete processEnv.TMUX_PANE
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
    const processEnv = { ...process.env }
    delete processEnv.TMUX
    delete processEnv.TMUX_PANE
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
    mkdirSync(OPENCODE_RECAP_DATA_DIR, { recursive: true })
    const args = ['run', '--pure', '--format', 'json', ...(model ? ['--model', model] : [])]
    const processEnv = { ...process.env }
    delete processEnv.TMUX
    delete processEnv.TMUX_PANE
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
    const processEnv = { ...process.env }
    delete processEnv.TMUX
    delete processEnv.TMUX_PANE
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
    // recap shows up as a session. There is no --no-hooks flag; the scrubbed TMUX_PANE below is what
    // stops our own SessionStart hook registering this process.
    const args = ['-p', '--no-session', ...(model ? ['-m', model] : [])]
    const processEnv = { ...process.env }
    delete processEnv.TMUX
    delete processEnv.TMUX_PANE
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
  return new OpencodeWorker(config.opencodeModel).ready()
})

export function configureOneShotPool(next: {
  cwd: string
  claudeModel?: string
  codexModel?: string
  cursorModel?: string
  opencodeModel?: string
  piModel?: string
  commandcodeModel?: string
  effort?: OneShotOptions['effort']
}): void {
  const changed = config != null && (
    config.cwd !== next.cwd || config.claudeModel !== next.claudeModel ||
    config.codexModel !== next.codexModel || config.cursorModel !== next.cursorModel ||
    config.opencodeModel !== next.opencodeModel || config.piModel !== next.piModel ||
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
 * same way every other worker does it — `TMUX`/`TMUX_PANE` are scrubbed, and the machine hook only
 * registers a session that has a tmux pane. `--source tool` keeps it out of the user's session list.
 */
export function runHermesOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('hermes one-shot aborted'), { name: 'AbortError' }))
  const args = ['chat', '-q', opts.prompt, '-Q', '--source', 'tool', ...(opts.model ? ['-m', opts.model] : [])]
  const processEnv = { ...process.env }
  delete processEnv.TMUX
  delete processEnv.TMUX_PANE
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
 * recap does leave a row in `sessions.db`; it cannot register as an agent, because `TMUX`/`TMUX_PANE` are
 * scrubbed and the machine hook only registers a session that has a tmux pane.
 */
export function runDevinOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  if (opts.signal?.aborted) return Promise.reject(Object.assign(new Error('devin one-shot aborted'), { name: 'AbortError' }))
  if (opts.cwd) trustDevinWorkspace(opts.cwd, (m) => console.warn('[recap] could not trust the devin scratch dir:', m))
  const args = ['-p', opts.prompt, ...(opts.model ? ['--model', opts.model] : [])]
  const processEnv = { ...process.env }
  delete processEnv.TMUX
  delete processEnv.TMUX_PANE
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
