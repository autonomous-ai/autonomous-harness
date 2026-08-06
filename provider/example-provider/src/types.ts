/**
 * The subset of A2A this reference implementation uses, plus the `autonomous.ai/*` metadata defined by
 * `../spec/README.md`.
 *
 * Deliberately hand-written rather than generated: a partner reading this file should be able to see
 * the entire wire surface without installing anything.
 */

export const TaskState = {
  SUBMITTED: 'TASK_STATE_SUBMITTED',
  WORKING: 'TASK_STATE_WORKING',
  COMPLETED: 'TASK_STATE_COMPLETED',
  FAILED: 'TASK_STATE_FAILED',
  CANCELED: 'TASK_STATE_CANCELED',
  REJECTED: 'TASK_STATE_REJECTED',
  INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
  AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED',
} as const

export type TaskStateValue = (typeof TaskState)[keyof typeof TaskState]

/** States after which a task accepts no further messages (A2A: "terminal"). */
export const TERMINAL_STATES: readonly TaskStateValue[] = [
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]

export const isTerminal = (s: TaskStateValue): boolean => TERMINAL_STATES.includes(s)

/** HP-210: every Autonomous-specific key is namespaced. Unknown keys in the namespace are ignored. */
export interface PartMetadata {
  'autonomous.ai/kind'?:
    | 'user_message'
    | 'thinking_delta'
    | 'thinking_title'
    | 'text_delta'
    | 'tool_start'
    | 'tool_end'
    | 'context_compact'
    | 'done'
    | 'recap_start'
    | 'recap_end'
  'autonomous.ai/thinkingId'?: string
  'autonomous.ai/toolCallId'?: string
  'autonomous.ai/parentToolCallId'?: string
  'autonomous.ai/tool'?: string
  'autonomous.ai/toolInput'?: unknown
  'autonomous.ai/isError'?: boolean
  'autonomous.ai/summary'?: string
  'autonomous.ai/durationSeconds'?: number
  'autonomous.ai/title'?: string
  /**
   * `recap_end` only (HP-212): the headline. The Part's own `text` carries the fuller body.
   * ABSENT on a `recap_end` means the turn produced no recap — the phase is over, show nothing.
   */
  'autonomous.ai/recap'?: string
  'autonomous.ai/compacted'?: {
    userMessages?: number
    assistantMessages?: number
    toolUses?: number
    contexts?: number
  }
}

export interface Part {
  text?: string
  /** base64 — HP-106 carries image attachments here with `mediaType`. */
  raw?: string
  filename?: string
  mediaType?: string
  url?: string
  metadata?: PartMetadata
}

export type Role = 'ROLE_USER' | 'ROLE_AGENT'

export interface Message {
  role: Role
  messageId: string
  parts: Part[]
  taskId?: string
  contextId?: string
}

export interface Artifact {
  artifactId: string
  name?: string
  parts: Part[]
}

export interface TaskStatus {
  state: TaskStateValue
  message?: Message
}

export interface Task {
  id: string
  contextId: string
  status: TaskStatus
  history: Message[]
  artifacts?: Artifact[]
  /** Not A2A core — used to derive a session title (spec §10.4). */
  metadata?: { title?: string }
}

export interface TaskStatusUpdateEvent {
  taskId: string
  contextId: string
  status: TaskStatus
  final?: boolean
}

export interface TaskArtifactUpdateEvent {
  taskId: string
  contextId: string
  artifact: Artifact
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC reserved codes plus the A2A-flavoured ones this implementation raises. */
export const RpcErrors = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
  UNAUTHENTICATED: { code: -32001, message: 'Unauthenticated' },
  TASK_NOT_FOUND: { code: -32002, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32003, message: 'Task not cancelable' },
} as const
