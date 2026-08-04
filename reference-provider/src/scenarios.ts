/**
 * Deterministic scenarios, selected by what the user says.
 *
 * The point of this file is the HOSTILE cases, not the happy one. A reference implementation that only
 * demonstrates success teaches a partner nothing about the failure modes their integration will
 * actually hit, and gives the backend client (phase 5) nothing to harden against.
 */
import { TaskState, type Part, type TaskStateValue } from './types.js'

export type Step =
  | { kind: 'parts'; parts: Part[] }
  /** Terminal or intermediate state transition. */
  | { kind: 'state'; state: TaskStateValue; text?: string }
  /** Abort the HTTP response mid-frame, without a terminal state. Violates HP-102 on purpose. */
  | { kind: 'die' }

export interface Scenario {
  id: string
  /** Matched against the lowercased user text; first match wins. `null` = the default. */
  trigger: string | null
  description: string
  steps: Step[]
}

const meta = (kind: NonNullable<Part['metadata']>['autonomous.ai/kind'], extra: Part['metadata'] = {}): Part['metadata'] => ({
  'autonomous.ai/kind': kind,
  ...extra,
})

/** The full-fidelity turn: thinking, a tool call, assistant text, completion. */
const RICH: Step[] = [
  { kind: 'parts', parts: [{ text: 'Checking pacing…', metadata: meta('thinking_delta', { 'autonomous.ai/thinkingId': 't1' }) }] },
  { kind: 'parts', parts: [{ text: '', metadata: meta('thinking_title', { 'autonomous.ai/thinkingId': 't1', 'autonomous.ai/title': 'Checking the budget data' }) }] },
  {
    kind: 'parts',
    parts: [
      {
        text: '',
        metadata: meta('tool_start', {
          'autonomous.ai/toolCallId': 'c7',
          'autonomous.ai/tool': 'query_spend',
          'autonomous.ai/toolInput': { account: 'acme', window: '7d' },
        }),
      },
    ],
  },
  {
    kind: 'parts',
    parts: [
      {
        text: '7 rows',
        metadata: meta('tool_end', {
          'autonomous.ai/toolCallId': 'c7',
          'autonomous.ai/tool': 'query_spend',
          'autonomous.ai/isError': false,
          'autonomous.ai/summary': 'Returned 7 rows',
          'autonomous.ai/durationSeconds': 1.4,
        }),
      },
    ],
  },
  { kind: 'parts', parts: [{ text: 'Acme is at 118% of pacing this week.', metadata: meta('text_delta') }] },
  { kind: 'state', state: TaskState.COMPLETED },
]

export const SCENARIOS: Scenario[] = [
  {
    id: 'plain',
    trigger: 'plain',
    description: 'HP-211 — a provider that emits NO autonomous.ai/* metadata is conformant. Renders as plain text.',
    steps: [
      { kind: 'parts', parts: [{ text: 'Plain text reply, no metadata at all.' }] },
      { kind: 'state', state: TaskState.COMPLETED },
    ],
  },
  {
    id: 'ask',
    trigger: 'ask me',
    description: 'HP-104 — the agent needs an answer. Enters INPUT_REQUIRED and waits for a message on the same taskId.',
    steps: [
      { kind: 'parts', parts: [{ text: 'Which account did you mean?', metadata: meta('text_delta') }] },
      { kind: 'state', state: TaskState.INPUT_REQUIRED, text: 'Which account did you mean?' },
    ],
  },
  {
    id: 'fail',
    trigger: 'fail',
    description: 'A turn that fails partway through, after already emitting output.',
    steps: [
      { kind: 'parts', parts: [{ text: 'Starting the query…', metadata: meta('text_delta') }] },
      { kind: 'state', state: TaskState.FAILED, text: 'Upstream data warehouse refused the connection.' },
    ],
  },
  {
    id: 'die',
    trigger: 'die',
    description: 'The stream is cut without a terminal state — an HP-102 violation, present so the client can be hardened against it.',
    steps: [
      { kind: 'parts', parts: [{ text: 'Working on it…', metadata: meta('text_delta') }] },
      { kind: 'die' },
    ],
  },
  {
    id: 'compact',
    trigger: 'compact',
    description: 'The provider compacted its own context and reports it. Autonomous never asks for this (spec §9).',
    steps: [
      {
        kind: 'parts',
        parts: [
          {
            text: 'Compacted earlier turns to stay within context.',
            metadata: meta('context_compact', { 'autonomous.ai/compacted': { userMessages: 12, assistantMessages: 12, toolUses: 41 } }),
          },
        ],
      },
      { kind: 'parts', parts: [{ text: 'Where were we?', metadata: meta('text_delta') }] },
      { kind: 'state', state: TaskState.COMPLETED },
    ],
  },
  {
    id: 'rich',
    trigger: null,
    description: 'Default: thinking, a tool call, assistant text, completion.',
    steps: RICH,
  },
]

export function pickScenario(userText: string): Scenario {
  const t = userText.toLowerCase()
  return SCENARIOS.find((s) => s.trigger !== null && t.includes(s.trigger)) ?? SCENARIOS[SCENARIOS.length - 1]!
}

/** Credential that makes every call fail authentication, for exercising HP-013. */
export const REJECTED_CREDENTIAL = 'bad-key'

/** Any other non-empty credential is accepted — this provider has no real user database. */
export function credentialAccepted(key: string | undefined): boolean {
  return !!key && key !== REJECTED_CREDENTIAL
}
