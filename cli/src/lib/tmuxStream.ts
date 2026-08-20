import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const CONTROL_OUTPUT_SETTLE_MS = 24

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
  return decodeTmuxControlBytes(Buffer.from(encoded, 'utf8'))
}

/** Decode control-mode escaping without first interpreting payload bytes as
 * UTF-8. A Unicode scalar may be split across separate `%output` records; a
 * string decoder would permanently replace both halves with U+FFFD. */
export function decodeTmuxControlBytes(encoded: Uint8Array): Uint8Array {
  const input = Buffer.from(encoded)
  const chunks: Buffer[] = []
  let plainStart = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== 0x5c
      || i + 3 >= input.length
      || input[i + 1] < 0x30 || input[i + 1] > 0x37
      || input[i + 2] < 0x30 || input[i + 2] > 0x37
      || input[i + 3] < 0x30 || input[i + 3] > 0x37) continue
    if (i > plainStart) chunks.push(input.subarray(plainStart, i))
    const value = ((input[i + 1] - 0x30) << 6)
      | ((input[i + 2] - 0x30) << 3)
      | (input[i + 3] - 0x30)
    chunks.push(Buffer.from([value]))
    i += 3
    plainStart = i + 1
  }
  if (plainStart < input.length) chunks.push(input.subarray(plainStart))
  return Buffer.concat(chunks)
}

export function parseTmuxControlOutput(lineBytes: Uint8Array): { paneId: string; data: Uint8Array } | null {
  const line = Buffer.from(lineBytes)
  const plainPrefix = Buffer.from('%output ')
  if (line.subarray(0, plainPrefix.length).equals(plainPrefix)) {
    const separator = line.indexOf(0x20, plainPrefix.length)
    if (separator < 0) return null
    const paneId = line.subarray(plainPrefix.length, separator).toString('ascii')
    if (!/^%\d+$/.test(paneId)) return null
    return { paneId, data: decodeTmuxControlBytes(line.subarray(separator + 1)) }
  }

  const extendedPrefix = Buffer.from('%extended-output ')
  if (!line.subarray(0, extendedPrefix.length).equals(extendedPrefix)) return null
  // latin1 is deliberately used only to locate the ASCII protocol header;
  // each code unit still maps one-to-one to the original payload byte.
  const header = /^%extended-output\s+(%\d+)\s+\d+\s+:?\s?/.exec(line.toString('latin1'))
  if (!header) return null
  return { paneId: header[1], data: decodeTmuxControlBytes(line.subarray(header[0].length)) }
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

/** `capture-pane -p` separates screen rows with a bare LF. A VT terminal's
 * LF moves down without returning to column zero, so replaying the capture as
 * received makes every row staircase to the right. tmux also encodes each
 * captured row independently: it may leave a background SGR active at EOL
 * while emitting the following default-style blank row as an empty string.
 * Reset SGR at every row boundary so styled trailing cells remain on their row
 * instead of bleeding into the next one when the snapshot is replayed. */
export function normalizeTmuxCaptureLines(capture: Uint8Array): Uint8Array {
  const raw = Buffer.from(capture)
  // `capture-pane -p` prints a line terminator after its final screen row.
  // Replaying that terminator in a terminal already containing paneHeight rows
  // scrolls the snapshot by one, while cursor metadata stays in tmux's original
  // coordinate space. Drop only this command-output delimiter; separators
  // between captured rows are still normalized below.
  let end = raw.length
  if (end > 0 && raw[end - 1] === 0x0a) {
    end--
    if (end > 0 && raw[end - 1] === 0x0d) end--
  }
  const input = raw.subarray(0, end)
  let loneLf = 0
  for (let index = 0; index < input.length; index++) {
    if (input[index] === 0x0a && (index === 0 || input[index - 1] !== 0x0d)) loneLf++
  }
  const sgrReset = Buffer.from('\u001b[0m')
  const output = Buffer.allocUnsafe(input.length + loneLf * (1 + sgrReset.length) + sgrReset.length)
  let write = 0
  for (let index = 0; index < input.length; index++) {
    if (input[index] === 0x0a && (index === 0 || input[index - 1] !== 0x0d)) {
      sgrReset.copy(output, write)
      write += sgrReset.length
      output[write++] = 0x0d
    }
    output[write++] = input[index]
  }
  sgrReset.copy(output, write)
  write += sgrReset.length
  return output.subarray(0, write)
}

export function synthesizeTmuxSnapshot(capture: Uint8Array, meta: PaneMeta): Uint8Array {
  const cursorRow = Math.max(1, Math.min(meta.paneHeight, meta.cursorY + 1))
  const cursorCol = Math.max(1, Math.min(meta.paneWidth, meta.cursorX + 1))
  const prefix = Buffer.from(`\u001bc\u001b[?25l\u001b[H\u001b[2J\u001b[3J${mouseModes(meta)}`, 'utf8')
  const suffix = Buffer.from(`\u001b[${cursorRow};${cursorCol}H\u001b[?25h`, 'utf8')
  return Buffer.concat([prefix, normalizeTmuxCaptureLines(capture), suffix])
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
  private lineBuffer = Buffer.alloc(0)
  private closed = false
  private closeNotified = false
  private outputPaused = false
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
    this.lineBuffer = Buffer.concat([this.lineBuffer, chunk])
    while (true) {
      const newline = this.lineBuffer.indexOf(0x0a)
      if (newline < 0) break
      let line = this.lineBuffer.subarray(0, newline)
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1)
      this.lineBuffer = this.lineBuffer.subarray(newline + 1)
      this.onControlLine(line)
    }
  }

  private onControlLine(line: Buffer): void {
    const output = parseTmuxControlOutput(line)
    if (output) {
      if (output.paneId === this.runtime.paneId) this.sink.onData(output.data)
      return
    }
    const text = line.toString('ascii')
    const paused = /^%pause\s+(%\d+)$/.exec(text)
    if (paused?.[1] === this.runtime.paneId && !this.closed && !this.outputPaused) {
      this.child.stdin.write(`refresh-client -A ${this.runtime.paneId}:continue\n`)
      return
    }
    if (text.startsWith('%exit')) this.notifyClose(this.closed ? 'closed' : 'tmux pane/control client closed')
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
    // -N is required for TUI fidelity: styled blank cells (for example the
    // Codex input box background) live in trailing spaces that tmux otherwise
    // trims from each captured row.
    const args = ['capture-pane', '-p', '-e', '-N', '-t', this.runtime.paneId]
    if (!meta.alternateOn && boundedHistory > 0) args.push('-S', `-${boundedHistory}`)
    // Give resize-triggered TUI output a short window to enter the manager's
    // snapshot buffer before capture, then drain notifications queued just
    // behind capture-pane's callback. The manager recaptures when either side
    // of this window observed a repaint.
    await new Promise((resolve) => setTimeout(resolve, CONTROL_OUTPUT_SETTLE_MS))
    const capture = await execTmux(args, 3_000)
    if (!capture.ok) return { state: 'failed', reason: 'tmux snapshot failed' }
    // capture-pane runs in a separate tmux client. Its exec callback can win
    // the event-loop race against repaint notifications already queued for the
    // control client. Keep the manager in snapshotting mode long enough to
    // observe those late deltas; it will then discard them and recapture.
    await new Promise((resolve) => setTimeout(resolve, CONTROL_OUTPUT_SETTLE_MS))
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

  async pauseOutput(): Promise<TerminalActionResult> {
    if (this.closed || !this.child.stdin.writable) return terminalActionNotStarted('terminal stream is closed')
    try {
      this.outputPaused = true
      this.child.stdin.write(`refresh-client -A ${this.runtime.paneId}:pause\n`)
      return TERMINAL_ACTION_SUCCEEDED
    } catch {
      this.outputPaused = false
      return terminalActionPossiblyExecuted('tmux output pause did not complete')
    }
  }

  async resumeOutput(): Promise<TerminalActionResult> {
    if (this.closed || !this.child.stdin.writable) return terminalActionNotStarted('terminal stream is closed')
    try {
      this.outputPaused = false
      this.child.stdin.write(`refresh-client -A ${this.runtime.paneId}:continue\n`)
      return TERMINAL_ACTION_SUCCEEDED
    } catch {
      this.outputPaused = true
      return terminalActionPossiblyExecuted('tmux output resume did not complete')
    }
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
