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
  TerminalRuntimeRef,
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
}
