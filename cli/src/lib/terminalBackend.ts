import type {
  TerminalActionResult,
  TerminalBackendName,
  TerminalCaptureOptions,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalInventoryResult,
  TerminalLogicalKey,
  TerminalProcessExpectation,
  TerminalReadResult,
  TerminalRespawnRequest,
  TerminalRuntimeRef,
  TerminalStreamHandle,
  TerminalStreamSink,
  TerminalStreamSize,
  RuntimeValidation,
} from './terminalTypes.js'

/** Backend-specific terminal I/O. Process ownership and registry reconciliation deliberately live above it. */
export interface TerminalBackend<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly name: TerminalBackendName
  readonly instanceId: string

  create(request: TerminalCreateRequest): Promise<TerminalCreateResult<Ref>>
  kill(runtime: Ref): Promise<TerminalActionResult>
  inventory(): Promise<TerminalInventoryResult>
  /** Current user-visible titles keyed by backend-scoped terminal route key. */
  titles(): Promise<TerminalReadResult<Map<string, string>>>
  validate(runtime: Ref, expected: TerminalProcessExpectation): Promise<RuntimeValidation>
  capture(runtime: Ref, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>>
  typeLiteral(runtime: Ref, text: string): Promise<TerminalActionResult>
  submitText(runtime: Ref, text: string): Promise<TerminalActionResult>
  sendKey(runtime: Ref, key: TerminalLogicalKey): Promise<TerminalActionResult>
  setTitle(runtime: Ref, title: string): Promise<TerminalActionResult>
  notify(runtime: Ref, title: string, body: string): Promise<TerminalActionResult>

  /** Byte streaming is optional per backend. MVP is implemented by tmux; Herdr remains capture-only. */
  openStream?(
    runtime: Ref,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
  ): Promise<TerminalReadResult<TerminalStreamHandle<Ref>>>

  /** Restart's two primitives. Optional per backend — only tmux (a real multiplexer pane) supports an
   *  in-place process swap; a backend without them makes restart report RESTART_UNSUPPORTED_BACKEND. */
  /** Re-arm a pane's "keep it when the process dies" behavior ahead of killing that process. */
  holdOpen?(runtime: Ref): Promise<TerminalActionResult>
  /** Replace the process occupying an existing pane/session in place, preserving its identity. */
  respawn?(runtime: Ref, request: TerminalRespawnRequest): Promise<TerminalActionResult>
}
