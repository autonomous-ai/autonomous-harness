/**
 * Deterministic scenarios, selected by what the user says.
 *
 * The point of this file is the HOSTILE cases, not the happy one. A reference implementation that only
 * demonstrates success teaches a partner nothing about the failure modes their integration will
 * actually hit, and gives the backend client nothing to harden against.
 */
import type { ProviderEvent } from './types.js'

export type Step =
  /** One event on the stream. */
  | { kind: 'event'; event: ProviderEvent }
  /** Abort the HTTP response mid-frame, with NO terminal event. Breaks the one-terminal rule on purpose. */
  | { kind: 'die' }

export interface Scenario {
  id: string
  /** Matched against the lowercased user text; first match wins. `null` = the default. */
  trigger: string | null
  description: string
  steps: Step[]
}

const ev = (event: ProviderEvent): Step => ({ kind: 'event', event })

/** The full-fidelity turn: thinking, a tool call, assistant text, a recap, completion. */
const RICH: Step[] = [
  ev({ kind: 'thinking_delta', text: 'Checking pacing…', thinkingId: 't1' }),
  ev({ kind: 'thinking_title', title: 'Checking the budget data', thinkingId: 't1' }),
  ev({ kind: 'tool_start', toolId: 'c7', tool: 'query_spend', input: { account: 'acme', window: '7d' } }),
  ev({ kind: 'tool_end', toolId: 'c7', tool: 'query_spend', ok: true, output: '7 rows', summary: 'Returned 7 rows', durationSeconds: 1.4 }),
  ev({ kind: 'text_delta', text: 'Acme is at 118% of pacing this week.' }),
  ev({ kind: 'done', text: 'Acme is at 118% of pacing this week.' }),
  ev({ kind: 'turn_completed' }),
]

export const SCENARIOS: Scenario[] = [
  {
    id: 'plain',
    trigger: 'plain',
    description: 'An event with no `kind` at all is conformant. Renders as plain assistant text.',
    steps: [
      { kind: 'event', event: { text: 'Plain text reply, no kind at all.' } },
      ev({ kind: 'turn_completed' }),
    ],
  },
  {
    id: 'ask',
    trigger: 'ask me',
    description: 'The agent needs an answer. Ends the stream with turn_input_required and waits for a resumed send on the same turnId.',
    steps: [
      ev({ kind: 'text_delta', text: 'Which account did you mean?' }),
      ev({ kind: 'turn_input_required', prompt: 'Which account did you mean?' }),
    ],
  },
  {
    id: 'fail',
    trigger: 'fail',
    description: 'A turn that fails partway through, after already emitting output.',
    steps: [
      ev({ kind: 'text_delta', text: 'Starting the query…' }),
      ev({ kind: 'turn_failed', error: { code: 'internal', message: 'Upstream data warehouse refused the connection.' } }),
    ],
  },
  {
    id: 'die',
    trigger: 'die',
    description: 'The stream is cut with NO terminal event — present so the client can be hardened against it and so the conformance runner can be shown catching it.',
    steps: [
      ev({ kind: 'text_delta', text: 'Working on it…' }),
      { kind: 'die' },
    ],
  },
  {
    id: 'compact',
    trigger: 'compact',
    description: 'The provider compacted its own context and reports it. Autonomous never asks for this.',
    steps: [
      ev({ kind: 'context_compact', text: 'Compacted earlier turns to stay within context.' }),
      ev({ kind: 'text_delta', text: 'Where were we?' }),
      ev({ kind: 'turn_completed' }),
    ],
  },
  {
    id: 'recap',
    trigger: 'recap',
    description: 'The recap pushed on the turn’s own stream, bracketed so the client can show the wait.',
    steps: [
      ev({ kind: 'text_delta', text: 'Rebuilt the index.' }),
      ev({ kind: 'done', text: 'Rebuilt the index.' }),
      ev({ kind: 'recap_start' }),
      ev({ kind: 'recap_end', recap: 'Rebuilt the index', text: 'Rebuilt the search index across 4 shards.' }),
      ev({ kind: 'turn_completed' }),
    ],
  },
  {
    id: 'full',
    trigger: 'everything',
    description: 'Every content kind this protocol defines, in one turn. Exists so the e2e suite can assert the vocabulary is REACHABLE — from outside, a kind nobody emitted is indistinguishable from a kind nobody supports.',
    steps: [
      ev({ kind: 'thinking_delta', text: 'Working out what to check…', thinkingId: 'f1' }),
      ev({ kind: 'thinking_title', title: 'Planning the checks', thinkingId: 'f1' }),
      ev({ kind: 'tool_start', toolId: 'f7', tool: 'query_spend', input: { account: 'acme', window: '7d' } }),
      ev({ kind: 'tool_end', toolId: 'f7', tool: 'query_spend', ok: true, output: '7 rows', summary: 'Returned 7 rows', durationSeconds: 1.4 }),
      ev({ kind: 'context_compact', text: 'Compacted earlier turns to stay within context.' }),
      ev({ kind: 'text_delta', text: 'Acme is at 118% of pacing this week.' }),
      ev({ kind: 'done', text: 'Acme is at 118% of pacing this week.' }),
      ev({ kind: 'recap_start' }),
      ev({ kind: 'recap_end', recap: 'Acme is over pace', text: 'Acme is at 118% of pacing this week.' }),
      ev({ kind: 'turn_completed' }),
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

/** The answer to `ask`, once the client resumes the same turn. */
export const RESUMED: Step[] = [
  { kind: 'event', event: { kind: 'text_delta', text: 'Acme, then. It is at 118% of pacing.' } },
  { kind: 'event', event: { kind: 'done', text: 'Acme is at 118% of pacing.' } },
  { kind: 'event', event: { kind: 'turn_completed' } },
]

/** Credential that makes every call fail authentication, for exercising the `credential-rejected` check. */
export const REJECTED_CREDENTIAL = 'bad-key'

/** Any other non-empty credential is accepted — this provider has no real user database. */
export function credentialAccepted(key: string | undefined): boolean {
  return !!key && key !== REJECTED_CREDENTIAL
}
