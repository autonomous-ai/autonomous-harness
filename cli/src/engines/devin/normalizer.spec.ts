import { describe, expect, it } from 'vitest'
import { newTurnState } from '../../lib/normalize.js'
import {
  devinMessageToEvents,
  devinMessagesToEvents,
  devinToolName,
  isDevinTurnEnd,
  lastDevinTurnText,
  reshapeMessage,
  windowDevinMessages,
  type DvMessage,
} from './normalizer.js'

/**
 * Fixtures are the real rows captured from `devin 3000.2.17` session `classy-tourmaline`
 * (`~/.local/share/devin/cli/sessions.db`, `message_nodes`) — two turns, the second calling `exec`.
 */
function msg(over: Partial<DvMessage> & Pick<DvMessage, 'rowId' | 'messageId' | 'role'>): DvMessage {
  return {
    content: '',
    thinking: null,
    toolCalls: null,
    toolCallId: null,
    finishReason: null,
    ...over,
  }
}

const USER_1 = msg({
  rowId: 37,
  messageId: '634a2f5b-42af-4102-8986-6bb16e99a381',
  role: 'user',
  content: 'Reply with exactly DEVIN-PROBE-OK and nothing else.',
})
const ASSISTANT_1 = msg({
  rowId: 58,
  messageId: 'a1a1a1a1-0000-4000-8000-000000000001',
  role: 'assistant',
  content: 'DEVIN-PROBE-OK',
  thinking: 'The user is asking me to reply with exactly "DEVIN-PROBE-OK" and nothing else.',
  finishReason: 'stop',
})
const USER_2 = msg({
  rowId: 60,
  messageId: 'b2b2b2b2-0000-4000-8000-000000000002',
  role: 'user',
  content: 'Run the shell command: echo hello-devin. Then say DEVIN-TOOL-OK.',
})
const ASSISTANT_TOOL = msg({
  rowId: 61,
  messageId: 'c3c3c3c3-0000-4000-8000-000000000003',
  role: 'assistant',
  content: '',
  thinking: 'The user wants me to run a simple shell command `echo hello-devin`.',
  toolCalls: JSON.stringify([
    { id: 'call_d022d4a199c04d298861d6c7', name: 'exec', arguments: { command: 'echo hello-devin' }, index: 0, kind: 'function' },
  ]),
  finishReason: 'tool_calls',
})
const TOOL_RESULT = msg({
  rowId: 63,
  messageId: 'd4d4d4d4-0000-4000-8000-000000000004',
  role: 'tool',
  content: 'Output from command in shell f8215f:\nhello-devin\n\n\nExit code: 0',
  toolCallId: 'call_d022d4a199c04d298861d6c7',
})
const ASSISTANT_2 = msg({
  rowId: 64,
  messageId: 'e5e5e5e5-0000-4000-8000-000000000005',
  role: 'assistant',
  content: 'DEVIN-TOOL-OK',
  thinking: 'The command executed successfully and output "hello-devin".',
  finishReason: 'stop',
})
const SESSION = [USER_1, ASSISTANT_1, USER_2, ASSISTANT_TOOL, TOOL_RESULT, ASSISTANT_2]

function liveTypes(messages: DvMessage[]): string[] {
  const state = newTurnState()
  return messages.flatMap((m) => devinMessageToEvents(m, state)).map((e) => e.type)
}

describe('devin normalizer', () => {
  it('emits a full turn lifecycle for a tool-calling turn', () => {
    const types = liveTypes([USER_2, ASSISTANT_TOOL, TOOL_RESULT, ASSISTANT_2])

    expect(types[0]).toBe('turn_started')
    expect(types).toContain('thinking_delta')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('text_delta')
    expect(types[types.length - 1]).toBe('turn_ended')
  })

  it('keeps the turn open while the assistant is still calling tools', () => {
    const state = newTurnState()
    devinMessageToEvents(USER_2, state)
    devinMessageToEvents(ASSISTANT_TOOL, state)

    expect(state.turnOpen).toBe(true)
    expect(isDevinTurnEnd(ASSISTANT_TOOL)).toBe(false)

    devinMessageToEvents(TOOL_RESULT, state)
    devinMessageToEvents(ASSISTANT_2, state)
    expect(state.turnOpen).toBe(false)
    expect(isDevinTurnEnd(ASSISTANT_2)).toBe(true)
  })

  it('maps Devin tool ids onto the shared card vocabulary', () => {
    expect(devinToolName('exec')).toBe('Bash')
    expect(devinToolName('find_file_by_name')).toBe('Glob')
    expect(devinToolName('notebook_edit')).toBe('Edit')
    expect(devinToolName('run_subagent')).toBe('Task')
    expect(devinToolName('webfetch')).toBe('WebFetch')
    // Unmapped tools still read well on a card.
    expect(devinToolName('mcp_call_tool')).toBe('McpCallTool')
    expect(devinToolName('')).toBe('tool')
  })

  it('renders the tool card with the mapped name and its real output', () => {
    const events = devinMessagesToEvents(SESSION)
    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')

    expect((start?.payload as { tool?: string })?.tool).toBe('Bash')
    expect((start?.payload as { input?: { command?: string } })?.input?.command).toBe('echo hello-devin')
    expect((end?.payload as { tool?: string })?.tool).toBe('Bash')
    expect(String((end?.payload as { output?: unknown })?.output)).toContain('hello-devin')
    expect((end?.payload as { isError?: boolean })?.isError).toBe(false)
  })

  it('drops the system prefix and a tool row with no tool_call_id', () => {
    expect(reshapeMessage(msg({ rowId: 1, messageId: 's', role: 'system', content: 'You are Devin' }))).toBeNull()
    expect(reshapeMessage(msg({ rowId: 2, messageId: 't', role: 'tool', content: 'orphan' }))).toBeNull()
  })

  it('takes the last user prompt and the assistant text that followed it as the recap source', () => {
    expect(lastDevinTurnText(SESSION)).toEqual({
      userMessage: 'Run the shell command: echo hello-devin. Then say DEVIN-TOOL-OK.',
      assistantText: 'DEVIN-TOOL-OK',
    })
  })

  it('snaps a pagination window back to a user prompt so a turn is never split', () => {
    // limit=3 would start mid-turn (at ASSISTANT_TOOL); the window must back up to USER_2.
    const w = windowDevinMessages(SESSION, { limit: 3 })

    expect(w.window[0]).toBe(USER_2)
    expect(w.oldestCursor).toBe('devin:2')
    expect(w.hasMore).toBe(true)
  })

  it('rejects a malformed or out-of-range window cursor', () => {
    expect(windowDevinMessages(SESSION, { limit: 2, before: 'hermes:1' }).staleCursor).toBe(true)
    expect(windowDevinMessages(SESSION, { limit: 2, before: 'devin:999' }).staleCursor).toBe(true)
  })

  it('survives malformed tool_calls JSON without dropping the message', () => {
    const broken = msg({
      rowId: 70, messageId: 'f6', role: 'assistant', content: 'still here',
      toolCalls: '{not json', finishReason: 'stop',
    })
    const events = devinMessagesToEvents([USER_1, broken])

    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.some((e) => e.type === 'tool_start')).toBe(false)
  })
})
