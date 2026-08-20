import type { AgentEngine } from '../engines/types.js'

export type TerminalBackendName = 'tmux' | 'herdr'

/** PID reuse-safe identity for the process that owns a Harness agent. */
export interface ProcessIdentity {
  pid: number
  executable: string
  startMarker: string
}

export interface TmuxRuntimeRef {
  backend: 'tmux'
  paneId: string
}

export interface HerdrRuntimeRef {
  backend: 'herdr'
  /** Stable configured-target identifier. Never contains the socket path. */
  endpointId: string
  sessionName: string
  /** Stable within one Herdr endpoint, including across pane moves. */
  terminalId: string
  /** Mutable public route, scoped to endpointId. */
  paneId: string
}

export type TerminalRuntimeRef = TmuxRuntimeRef | HerdrRuntimeRef

/** Untrusted route hints from hooks. Herdr socket paths are lookup hints, never connection authority. */
export type HookTerminalHint =
  | { backend: 'tmux'; paneId: string }
  | { backend: 'herdr'; paneId: string; sessionName?: string; socketPath?: string }

export interface TerminalRootObservation {
  runtime: TerminalRuntimeRef
  rootPid: number
  cwd: string
  /** Route aliases reported by the backend; never treated as process identity. */
  aliases?: readonly string[]
}

export type TerminalInventoryResult =
  | { state: 'available'; roots: readonly TerminalRootObservation[] }
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }

export type RuntimeValidation =
  | { state: 'alive' }
  | { state: 'gone'; reason: string }
  | { state: 'unknown'; reason: string }

/**
 * Result of a PTY side effect. Only `not_started` and a server-confirmed `rejected` result may be
 * retried on another runtime. `possibly_executed` must be observed before any further side effect.
 */
export type TerminalActionResult =
  | { state: 'succeeded'; dispatch: 'executed' }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }

export interface TerminalCreateRequest {
  cwd?: string
  label?: string
}

export type TerminalCreateResult<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> =
  | { state: 'succeeded'; dispatch: 'executed'; runtime: Ref }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }

export type TerminalReadResult<T> =
  | { state: 'succeeded'; value: T }
  | { state: 'failed'; reason: string }

export type TerminalLogicalKey =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'backspace'
  | 'delete'
  | 'pageup'
  | 'pagedown'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'ctrl-w'
  | 'space'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'

export type TerminalCaptureMode = 'recent_unwrapped' | 'visible' | 'detection'

export interface TerminalCaptureOptions {
  mode?: TerminalCaptureMode
  historyLines?: number
  ansi?: boolean
}

export interface TerminalProcessExpectation {
  engine: AgentEngine
  processIdentity?: ProcessIdentity
}

export interface TerminalStreamSize {
  cols: number
  rows: number
}

export interface TerminalStreamSnapshot {
  bytes: Uint8Array
  cols: number
  rows: number
}

export interface TerminalStreamSink {
  onData: (bytes: Uint8Array) => void
  onClose: (reason: string) => void
}

/** A live byte-oriented terminal stream. Implementations must preserve input/output order. */
export interface TerminalStreamHandle<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly runtime: Ref
  snapshot(historyLines: number): Promise<TerminalReadResult<TerminalStreamSnapshot>>
  writeRaw(bytes: Uint8Array): Promise<TerminalActionResult>
  resize(size: TerminalStreamSize): Promise<TerminalActionResult>
  close(): Promise<void>
}

export const TERMINAL_ACTION_SUCCEEDED: TerminalActionResult = {
  state: 'succeeded',
  dispatch: 'executed',
}

export function terminalActionNotStarted(reason: string): {
  state: 'failed'; dispatch: 'not_started'; reason: string
} {
  return { state: 'failed', dispatch: 'not_started', reason }
}

export function terminalActionRejected(reason: string): {
  state: 'failed'; dispatch: 'rejected'; reason: string
} {
  return { state: 'failed', dispatch: 'rejected', reason }
}

export function terminalActionPossiblyExecuted(reason: string): {
  state: 'unknown'; dispatch: 'possibly_executed'; reason: string
} {
  return { state: 'unknown', dispatch: 'possibly_executed', reason }
}
