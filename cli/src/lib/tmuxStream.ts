import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  type TerminalActionResult,
  type TerminalReadResult,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
  type TerminalStreamSnapshot,
  type TmuxRuntimeRef,
} from './terminalTypes.js'

const MIN_COLS = 40
const MAX_COLS = 300
const MIN_ROWS = 12
const MAX_ROWS = 120
const SMALL_INPUT_BYTES = 4 * 1024

interface PaneMeta {
  sessionId: string
  windowId: string
  windowPanes: number
  windowWidth: number
  windowHeight: number
  paneWidth: number
  paneHeight: number
  alternateOn: boolean
  cursorX: number
  cursorY: number
  mouseStandard: boolean
  mouseButton: boolean
  mouseAll: boolean
  mouseUtf8: boolean
  mouseSgr: boolean
}

function boundedSize(size: TerminalStreamSize): TerminalStreamSize {
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(size.cols))),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(size.rows))),
  }
}

function execTmux(args: string[], timeout = 2_000): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '') })
    })
  })
}

async function paneMeta(paneId: string): Promise<PaneMeta | null> {
  const format = [
    '#{session_id}', '#{window_id}', '#{window_panes}', '#{window_width}', '#{window_height}',
    '#{pane_width}', '#{pane_height}', '#{alternate_on}', '#{cursor_x}', '#{cursor_y}',
    '#{mouse_standard_flag}', '#{mouse_button_flag}', '#{mouse_all_flag}', '#{mouse_utf8_flag}', '#{mouse_sgr_flag}',
  ].join('|')
  const result = await execTmux(['display-message', '-p', '-t', paneId, format])
  if (!result.ok) return null
  const fields = result.stdout.toString('utf8').trim().split('|')
  if (fields.length !== 15 || !/^\$\d+$/.test(fields[0]) || !/^@\d+$/.test(fields[1])) return null
  const nums = fields.slice(2).map(Number)
  if (nums.some((value) => !Number.isFinite(value))) return null
  return {
    sessionId: fields[0],
    windowId: fields[1],
    windowPanes: nums[0],
    windowWidth: nums[1],
    windowHeight: nums[2],
    paneWidth: nums[3],
    paneHeight: nums[4],
    alternateOn: nums[5] === 1,
    cursorX: nums[6],
    cursorY: nums[7],
    mouseStandard: nums[8] === 1,
    mouseButton: nums[9] === 1,
    mouseAll: nums[10] === 1,
    mouseUtf8: nums[11] === 1,
    mouseSgr: nums[12] === 1,
  }
}

/** Decode the octal escaping used by tmux control-mode `%output` notifications. */
export function decodeTmuxControlData(encoded: string): Uint8Array {
  const chunks: Buffer[] = []
  let plainStart = 0
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== '\\' || !/^[0-7]{3}$/.test(encoded.slice(i + 1, i + 4))) continue
    if (i > plainStart) chunks.push(Buffer.from(encoded.slice(plainStart, i), 'utf8'))
    chunks.push(Buffer.from([Number.parseInt(encoded.slice(i + 1, i + 4), 8)]))
    i += 3
    plainStart = i + 1
  }
  if (plainStart < encoded.length) chunks.push(Buffer.from(encoded.slice(plainStart), 'utf8'))
  return Buffer.concat(chunks)
}

function mouseModes(meta: PaneMeta): string {
  let out = ''
  if (meta.mouseAll) out += '\u001b[?1003h'
  else if (meta.mouseButton) out += '\u001b[?1002h'
  else if (meta.mouseStandard) out += '\u001b[?1000h'
  if (meta.mouseUtf8) out += '\u001b[?1005h'
  if (meta.mouseSgr) out += '\u001b[?1006h'
  return out
}

export function synthesizeTmuxSnapshot(capture: Uint8Array, meta: PaneMeta): Uint8Array {
  const cursorRow = Math.max(1, Math.min(meta.paneHeight, meta.cursorY + 1))
  const cursorCol = Math.max(1, Math.min(meta.paneWidth, meta.cursorX + 1))
  const prefix = Buffer.from(`\u001bc\u001b[?25l\u001b[H\u001b[2J\u001b[3J${mouseModes(meta)}`, 'utf8')
  const suffix = Buffer.from(`\u001b[${cursorRow};${cursorCol}H\u001b[?25h`, 'utf8')
  return Buffer.concat([prefix, Buffer.from(capture), suffix])
}

async function loadAndPaste(paneId: string, bytes: Uint8Array): Promise<TerminalActionResult> {
  const bufferName = `harness-terminal-${randomUUID()}`
  const loaded = await new Promise<boolean>((resolve) => {
    const child = spawn('tmux', ['load-buffer', '-b', bufferName, '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
    child.stdin.end(Buffer.from(bytes))
  })
  if (!loaded) return terminalActionNotStarted('tmux input buffer could not be loaded')
  const pasted = await execTmux(['paste-buffer', '-d', '-b', bufferName, '-t', paneId])
  if (!pasted.ok) {
    void execTmux(['delete-buffer', '-b', bufferName])
    return terminalActionPossiblyExecuted('tmux raw paste did not complete')
  }
  return TERMINAL_ACTION_SUCCEEDED
}

async function sendHexBytes(paneId: string, bytes: Uint8Array): Promise<TerminalActionResult> {
  for (let offset = 0; offset < bytes.length; offset += 256) {
    const hex = [...bytes.slice(offset, offset + 256)].map((byte) => byte.toString(16).padStart(2, '0'))
    const result = await execTmux(['send-keys', '-t', paneId, '-H', ...hex])
    if (!result.ok) return offset === 0
      ? terminalActionNotStarted('tmux raw input could not be sent')
      : terminalActionPossiblyExecuted('tmux raw input stopped after a partial write')
  }
  return TERMINAL_ACTION_SUCCEEDED
}

export class TmuxControlStream implements TerminalStreamHandle<TmuxRuntimeRef> {
  readonly runtime: TmuxRuntimeRef
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder = new StringDecoder('utf8')
  private lineBuffer = ''
  private closed = false
  private closeNotified = false
  private original: PaneMeta
  private lastApplied: TerminalStreamSize | null = null

  private constructor(
    paneId: string,
    original: PaneMeta,
    child: ChildProcessWithoutNullStreams,
    private readonly sink: TerminalStreamSink,
  ) {
    this.runtime = { backend: 'tmux', paneId }
    this.original = original
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.once('error', (error) => this.notifyClose(`tmux control client error: ${error.message}`))
    child.once('close', (code) => this.notifyClose(this.closed ? 'closed' : `tmux control client exited (${code ?? 'signal'})`))
  }

  static async open(paneId: string, size: TerminalStreamSize, sink: TerminalStreamSink): Promise<TerminalReadResult<TmuxControlStream>> {
    const original = await paneMeta(paneId)
    if (!original) return { state: 'failed', reason: 'tmux pane metadata is unavailable' }
    if (original.windowPanes !== 1) return { state: 'failed', reason: 'TERMINAL_MULTI_PANE_UNSUPPORTED' }
    const child = spawn('tmux', ['-C', 'attach-session', '-f', 'ignore-size', '-t', paneId], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const spawned = await new Promise<boolean>((resolve) => {
      let settled = false
      child.once('spawn', () => { if (!settled) { settled = true; resolve(true) } })
      child.once('error', () => { if (!settled) { settled = true; resolve(false) } })
    })
    if (!spawned) return { state: 'failed', reason: 'tmux control client could not start' }
    const stream = new TmuxControlStream(paneId, original, child, sink)
    const resized = await stream.resize(size)
    if (resized.state !== 'succeeded') {
      await stream.close()
      return { state: 'failed', reason: resized.reason }
    }
    return { state: 'succeeded', value: stream }
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += this.decoder.write(chunk)
    while (true) {
      const newline = this.lineBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.onControlLine(line)
    }
  }

  private onControlLine(line: string): void {
    const output = /^%output\s+(%\d+)\s(.*)$/.exec(line)
    if (output) {
      if (output[1] === this.runtime.paneId) this.sink.onData(decodeTmuxControlData(output[2]))
      return
    }
    const extended = /^%extended-output\s+(%\d+)\s+\d+\s+:?\s?(.*)$/.exec(line)
    if (extended) {
      if (extended[1] === this.runtime.paneId) this.sink.onData(decodeTmuxControlData(extended[2]))
      return
    }
    const paused = /^%pause\s+(%\d+)$/.exec(line)
    if (paused?.[1] === this.runtime.paneId && !this.closed) {
      this.child.stdin.write(`refresh-client -A ${this.runtime.paneId}:continue\n`)
      return
    }
    if (line.startsWith('%exit')) this.notifyClose(this.closed ? 'closed' : 'tmux pane/control client closed')
  }

  private notifyClose(reason: string): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.sink.onClose(reason)
  }

  async snapshot(historyLines: number): Promise<TerminalReadResult<TerminalStreamSnapshot>> {
    const meta = await paneMeta(this.runtime.paneId)
    if (!meta) return { state: 'failed', reason: 'tmux pane disappeared' }
    const boundedHistory = Math.max(0, Math.min(1_000, Math.floor(historyLines)))
    const args = ['capture-pane', '-p', '-e', '-t', this.runtime.paneId]
    if (!meta.alternateOn && boundedHistory > 0) args.push('-S', `-${boundedHistory}`)
    const capture = await execTmux(args, 3_000)
    if (!capture.ok) return { state: 'failed', reason: 'tmux snapshot failed' }
    return {
      state: 'succeeded',
      value: {
        bytes: synthesizeTmuxSnapshot(capture.stdout, meta),
        cols: meta.paneWidth,
        rows: meta.paneHeight,
      },
    }
  }

  async writeRaw(bytes: Uint8Array): Promise<TerminalActionResult> {
    if (this.closed) return terminalActionNotStarted('terminal stream is closed')
    if (bytes.length === 0) return TERMINAL_ACTION_SUCCEEDED
    return bytes.length <= SMALL_INPUT_BYTES
      ? sendHexBytes(this.runtime.paneId, bytes)
      : loadAndPaste(this.runtime.paneId, bytes)
  }

  async resize(requested: TerminalStreamSize): Promise<TerminalActionResult> {
    if (this.closed) return terminalActionNotStarted('terminal stream is closed')
    const meta = await paneMeta(this.runtime.paneId)
    if (!meta) return terminalActionNotStarted('tmux pane disappeared')
    if (meta.windowPanes !== 1) return terminalActionNotStarted('TERMINAL_MULTI_PANE_UNSUPPORTED')
    const size = boundedSize(requested)
    const result = await execTmux(['resize-window', '-t', meta.windowId, '-x', String(size.cols), '-y', String(size.rows)])
    if (!result.ok) return terminalActionPossiblyExecuted('tmux resize did not complete')
    this.lastApplied = size
    return TERMINAL_ACTION_SUCCEEDED
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const current = await paneMeta(this.runtime.paneId)
    if (current && current.windowPanes === 1 && this.lastApplied
      && current.windowWidth === this.lastApplied.cols && current.windowHeight === this.lastApplied.rows) {
      await execTmux([
        'resize-window', '-t', current.windowId,
        '-x', String(this.original.windowWidth), '-y', String(this.original.windowHeight),
      ])
    }
    try { this.child.stdin.write('detach-client\n') } catch { /* ignore */ }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.child.exitCode != null || this.child.signalCode != null) { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 500)
      this.child.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    if (!exited) this.child.kill('SIGTERM')
  }
}
