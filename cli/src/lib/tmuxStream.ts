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
const CONTROL_COMMAND_TIMEOUT_MS = 3_000
const SNAPSHOT_BUFFER_MAX_BYTES = 2 * 1024 * 1024
const SNAPSHOT_QUIET_MS = 8
const SNAPSHOT_QUIET_MAX_MS = 40
const SNAPSHOT_HISTORY_LINES = 500
const PANE_META_FORMAT = [
  '#{session_id}', '#{window_id}', '#{window_panes}', '#{window_width}', '#{window_height}',
  '#{pane_width}', '#{pane_height}', '#{alternate_on}', '#{cursor_x}', '#{cursor_y}',
  '#{cursor_flag}',
  '#{mouse_standard_flag}', '#{mouse_button_flag}', '#{mouse_all_flag}', '#{mouse_utf8_flag}', '#{mouse_sgr_flag}',
].join('|')

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
  cursorVisible: boolean
  mouseStandard: boolean
  mouseButton: boolean
  mouseAll: boolean
  mouseUtf8: boolean
  mouseSgr: boolean
}

interface PendingControlCommand {
  command: string
  lines: Buffer[]
  commandNumber: string | null
  timer: ReturnType<typeof setTimeout> | null
  onEnd?: () => void
  resolve: (result: { ok: boolean; stdout: Buffer }) => void
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
  const result = await execTmux(['display-message', '-p', '-t', paneId, PANE_META_FORMAT])
  if (!result.ok) return null
  return parsePaneMeta(result.stdout)
}

function parsePaneMeta(bytes: Uint8Array): PaneMeta | null {
  const fields = Buffer.from(bytes).toString('utf8').trim().split('|')
  if (fields.length !== 16 || !/^\$\d+$/.test(fields[0]) || !/^@\d+$/.test(fields[1])) return null
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
    cursorVisible: nums[8] === 1,
    mouseStandard: nums[9] === 1,
    mouseButton: nums[10] === 1,
    mouseAll: nums[11] === 1,
    mouseUtf8: nums[12] === 1,
    mouseSgr: nums[13] === 1,
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

export function normalizeTmuxHistoryLines(capture: Uint8Array): Uint8Array {
  const raw = Buffer.from(capture)
  if (raw.length === 0) return raw
  const end = raw.at(-1) === 0x0a ? raw.length - 1 : raw.length
  if (end <= 0) return Buffer.alloc(0)
  const rows = raw.subarray(0, end).toString('utf8').split('\n')
  return Buffer.from(rows.map((row) => `${row.replace(/\r$/, '')}\u001b[0m\r\n`).join(''), 'utf8')
}

export function synthesizeTmuxSnapshot(
  capture: Uint8Array,
  meta: PaneMeta,
  history: Uint8Array = Buffer.alloc(0),
): Uint8Array {
  const cursorRow = Math.max(1, Math.min(meta.paneHeight, meta.cursorY + 1))
  const cursorCol = Math.max(1, Math.min(meta.paneWidth, meta.cursorX + 1))
  const prefix = Buffer.from(
    '\u001bc\u001b[?25l\u001b[?7l\u001b[H\u001b[2J',
    'utf8',
  )
  const normalizedHistory = normalizeTmuxHistoryLines(history)
  // Push every captured history row above the viewport before clearing the
  // visible grid. `capture-pane -e` serializes tmux's already-rendered cells:
  // it preserves SGR colours but contains none of the original TUI's cursor
  // movement/repaint stream. Extra blank rows move even the newest history
  // lines into local scrollback; ESC[2J clears only the viewport, not it.
  const historySuffix = Buffer.from(
    `${normalizedHistory.length === 0 ? '' : '\r\n'.repeat(meta.paneHeight)}\u001b[H\u001b[2J${mouseModes(meta)}`,
    'utf8',
  )
  const raw = Buffer.from(capture)
  const rows: Buffer[] = []
  let start = 0
  let rowIndex = 0
  for (let index = 0; index <= raw.length && rowIndex < meta.paneHeight; index++) {
    if (index !== raw.length && raw[index] !== 0x0a) continue
    let end = index
    if (end > start && raw[end - 1] === 0x0d) end--
    // Position every tmux row independently. tmux and the receiving emulator
    // can disagree on the display width of Unicode scalars; replaying rows via
    // CRLF lets that disagreement wrap one row into another. Absolute row
    // placement with autowrap disabled makes the captured grid authoritative.
    rows.push(
      Buffer.from(`\u001b[${rowIndex + 1};1H`, 'utf8'),
      raw.subarray(start, end),
      Buffer.from('\u001b[0m', 'utf8'),
    )
    rowIndex++
    start = index + 1
  }
  // tmux keeps visibility separately from the cursor coordinate. Full-screen
  // TUIs such as Command Code park the physical cursor below their own painted
  // input and hide it; restoring the coordinate with an unconditional ?25h
  // creates a stray block cursor in remote renderers.
  const cursorVisibility = meta.cursorVisible ? 'h' : 'l'
  const suffix = Buffer.from(`\u001b[${cursorRow};${cursorCol}H\u001b[?7h\u001b[?25${cursorVisibility}`, 'utf8')
  return Buffer.concat([prefix, normalizedHistory, historySuffix, ...rows, suffix])
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
  // `tmux -C attach-session` emits its own initial %begin/%end transaction.
  // Do not assign that command number to our first queued command.
  private controlReady = false
  private commandActive: PendingControlCommand | null = null
  private readonly commandQueue: PendingControlCommand[] = []
  private operationTail: Promise<void> = Promise.resolve()
  private snapshotGated = false
  private snapshotPostCut: Buffer[] = []
  private snapshotPostCutBytes = 0
  private snapshotLastOutputAt = 0

  private constructor(
    paneId: string,
    child: ChildProcessWithoutNullStreams,
    private readonly sink: TerminalStreamSink,
  ) {
    this.runtime = { backend: 'tmux', paneId }
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
    const stream = new TmuxControlStream(paneId, child, sink)
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
      if (output.paneId === this.runtime.paneId) this.routeOutput(output.data)
      return
    }
    const text = line.toString('ascii')
    const begin = /^%begin\s+\d+\s+(\d+)\s+\d+$/.exec(text)
    if (begin) {
      if (this.commandActive && this.commandActive.commandNumber == null) {
        this.commandActive.commandNumber = begin[1]
      }
      return
    }
    const completed = /^%(end|error)\s+\d+\s+(\d+)\s+\d+$/.exec(text)
    if (completed) {
      const active = this.commandActive
      if (!this.controlReady && active == null) {
        this.controlReady = true
        this.pumpControlCommand()
        return
      }
      if (active?.commandNumber === completed[2]) {
        if (completed[1] === 'end') active.onEnd?.()
        this.finishControlCommand(active, completed[1] === 'end')
      }
      return
    }
    const paused = /^%pause\s+(%\d+)$/.exec(text)
    if (paused?.[1] === this.runtime.paneId && !this.closed) {
      // Manual tmux pause drops pane bytes rather than replaying them. Never
      // use it for app backpressure; recover an unexpected pause immediately.
      void this.runControlCommand(`refresh-client -A '${this.runtime.paneId}:continue'`)
      return
    }
    if (text.startsWith('%exit')) {
      this.failControlCommands()
      this.notifyClose(this.closed ? 'closed' : 'tmux pane/control client closed')
      return
    }
    // tmux escapes command output that starts with `%` as `%%`. Every other
    // leading-percent line is an asynchronous control-mode notification and
    // must not be mixed into a command response.
    if (text.startsWith('%') && !text.startsWith('%%')) return
    if (this.commandActive?.commandNumber != null) this.commandActive.lines.push(Buffer.from(line))
  }

  private routeOutput(bytes: Uint8Array): void {
    if (!this.snapshotGated) {
      this.sink.onData(bytes)
      return
    }
    const chunk = Buffer.from(bytes)
    this.snapshotPostCut.push(chunk)
    this.snapshotPostCutBytes += chunk.length
    this.snapshotLastOutputAt = Date.now()
    if (this.snapshotPostCutBytes > SNAPSHOT_BUFFER_MAX_BYTES) {
      this.failControlCommands()
      this.notifyClose('tmux snapshot output exceeded safe buffer limit')
      void this.close()
    }
  }

  private runControlCommand(command: string, onEnd?: () => void): Promise<{ ok: boolean; stdout: Buffer }> {
    if (this.closed || !this.child.stdin.writable) return Promise.resolve({ ok: false, stdout: Buffer.alloc(0) })
    return new Promise((resolve) => {
      this.commandQueue.push({ command, lines: [], commandNumber: null, timer: null, onEnd, resolve })
      this.pumpControlCommand()
    })
  }

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private pumpControlCommand(): void {
    if (!this.controlReady || this.commandActive || this.closed) return
    const next = this.commandQueue.shift()
    if (!next) return
    this.commandActive = next
    next.timer = setTimeout(() => {
      if (this.commandActive !== next) return
      this.notifyClose('tmux control command timed out')
      void this.close()
    }, CONTROL_COMMAND_TIMEOUT_MS)
    try {
      this.child.stdin.write(`${next.command}\n`)
    } catch {
      this.finishControlCommand(next, false)
    }
  }

  private finishControlCommand(command: PendingControlCommand, ok: boolean): void {
    if (this.commandActive !== command) return
    if (command.timer) clearTimeout(command.timer)
    command.timer = null
    this.commandActive = null
    const chunks: Buffer[] = []
    for (const line of command.lines) {
      const escaped = line.subarray(0, 2).equals(Buffer.from('%%')) ? line.subarray(1) : line
      chunks.push(Buffer.from(decodeTmuxControlBytes(escaped)), Buffer.from('\n'))
    }
    command.resolve({ ok, stdout: Buffer.concat(chunks) })
    this.pumpControlCommand()
  }

  private failControlCommands(): void {
    const active = this.commandActive
    this.commandActive = null
    const queuedCommands = this.commandQueue.splice(0)
    if (active) {
      if (active.timer) clearTimeout(active.timer)
      active.timer = null
      active.resolve({ ok: false, stdout: Buffer.alloc(0) })
    }
    for (const queued of queuedCommands) {
      queued.resolve({ ok: false, stdout: Buffer.alloc(0) })
    }
  }

  private notifyClose(reason: string): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.failControlCommands()
    this.sink.onClose(reason)
  }

  beginSnapshot(): void {
    if (this.snapshotGated) return
    this.snapshotGated = true
    this.snapshotPostCut = []
    this.snapshotPostCutBytes = 0
    this.snapshotLastOutputAt = Date.now()
  }

  private async waitForSnapshotQuiet(): Promise<void> {
    const deadline = Date.now() + SNAPSHOT_QUIET_MAX_MS
    while (!this.closed) {
      const now = Date.now()
      const remainingQuiet = SNAPSHOT_QUIET_MS - (now - this.snapshotLastOutputAt)
      if (remainingQuiet <= 0 || now >= deadline) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(remainingQuiet, deadline - now)))
    }
  }

  async snapshot(): Promise<TerminalReadResult<TerminalStreamSnapshot>> {
    return this.serializeOperation(async () => {
      if (!this.snapshotGated) return { state: 'failed', reason: 'tmux snapshot gate is not active' }
      // -N is required for TUI fidelity: styled blank cells (for example the
      // Codex input box background) live in trailing spaces that tmux otherwise
      // trims from each captured row. Deliberately do not use capture-pane -S:
      // tmux scrollback contains old full-screen TUI repaint frames. Replaying
      // those frames into a fresh emulator corrupts the visible screen.
      const baseCapture = `capture-pane -p -e -N -t ${this.runtime.paneId}`
      // Attaching a control client can trigger an immediate TUI repaint. Wait
      // before reading both cursor metadata and the grid so the synthesized
      // keyframe cannot combine a post-repaint grid with pre-repaint cursor
      // coordinates.
      await this.waitForSnapshotQuiet()
      const metadata = await this.runControlCommand(
        `display-message -p -t ${this.runtime.paneId} '${PANE_META_FORMAT}'`,
      )
      if (!metadata.ok) return { state: 'failed', reason: 'tmux snapshot metadata is unavailable' }
      const meta = parsePaneMeta(metadata.stdout)
      if (!meta || meta.windowPanes !== 1) return { state: 'failed', reason: 'tmux snapshot metadata is invalid' }
      // History is a styled cell capture used only to seed the receiver's
      // local scrollback. It preserves SGR attributes without replaying old
      // TUI cursor movement. Read it before the authoritative visible-grid cut
      // so concurrent output is included there or in a post-cut delta.
      const history = meta.alternateOn
        ? Buffer.alloc(0)
        : (await this.runControlCommand(
            `capture-pane -p -e -N -t ${this.runtime.paneId} -S -${SNAPSHOT_HISTORY_LINES} -E -1`,
          )).stdout
      const capture = await this.runControlCommand(baseCapture, () => {
        // `%end` is the ordered cut. Notifications observed before it are
        // represented by capture-pane; only later output may follow the keyframe.
        this.snapshotPostCut = []
        this.snapshotPostCutBytes = 0
      })
      if (!capture.ok) return { state: 'failed', reason: 'tmux snapshot failed' }
      return {
        state: 'succeeded',
        value: {
          bytes: synthesizeTmuxSnapshot(capture.stdout, meta, history),
          cols: meta.paneWidth,
          rows: meta.paneHeight,
        },
      }
    })
  }

  endSnapshot(): void {
    if (!this.snapshotGated) return
    this.snapshotGated = false
    const postCut = this.snapshotPostCut
    this.snapshotPostCut = []
    this.snapshotPostCutBytes = 0
    for (const chunk of postCut) this.sink.onData(chunk)
  }

  async writeRaw(bytes: Uint8Array): Promise<TerminalActionResult> {
    if (this.closed) return terminalActionNotStarted('terminal stream is closed')
    if (bytes.length === 0) return TERMINAL_ACTION_SUCCEEDED
    return bytes.length <= SMALL_INPUT_BYTES
      ? sendHexBytes(this.runtime.paneId, bytes)
      : loadAndPaste(this.runtime.paneId, bytes)
  }

  async resize(requested: TerminalStreamSize): Promise<TerminalActionResult> {
    return this.serializeOperation(async () => {
      if (this.closed) return terminalActionNotStarted('terminal stream is closed')
      const meta = await paneMeta(this.runtime.paneId)
      if (!meta) return terminalActionNotStarted('tmux pane disappeared')
      if (meta.windowPanes !== 1) return terminalActionNotStarted('TERMINAL_MULTI_PANE_UNSUPPORTED')
      const size = boundedSize(requested)
      // A repeated open/focus can legitimately ask for the grid already in
      // use. Avoid a redundant resize-window because full-screen TUIs may
      // repaint on SIGWINCH even when the dimensions did not change.
      if (meta.windowWidth === size.cols && meta.windowHeight === size.rows) {
        return TERMINAL_ACTION_SUCCEEDED
      }
      const result = await execTmux(['resize-window', '-t', meta.windowId, '-x', String(size.cols), '-y', String(size.rows)])
      if (!result.ok) return terminalActionPossiblyExecuted('tmux resize did not complete')
      return TERMINAL_ACTION_SUCCEEDED
    })
  }

  async pauseOutput(): Promise<TerminalActionResult> {
    if (this.closed || !this.child.stdin.writable) return terminalActionNotStarted('terminal stream is closed')
    // TerminalStreamManager pauses downstream delivery while continuing to
    // drain exact tmux bytes into its bounded FIFO. tmux's manual `pause`
    // state is deliberately not used because it does not replay missed bytes.
    return TERMINAL_ACTION_SUCCEEDED
  }

  async resumeOutput(): Promise<TerminalActionResult> {
    if (this.closed || !this.child.stdin.writable) return terminalActionNotStarted('terminal stream is closed')
    return TERMINAL_ACTION_SUCCEEDED
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Keep the last applied grid. Restoring the headless tmux default here
    // makes agent switching shrink and immediately re-expand the pane; TUIs
    // such as Grok preserve those intermediate repaint fragments in the live
    // screen. The next controller will resize only if its grid truly differs.
    try { this.child.stdin.write('detach-client\n') } catch { /* ignore */ }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.child.exitCode != null || this.child.signalCode != null) { resolve(true); return }
      const timer = setTimeout(() => resolve(false), 500)
      this.child.once('close', () => { clearTimeout(timer); resolve(true) })
    })
    if (!exited) this.child.kill('SIGTERM')
  }
}
