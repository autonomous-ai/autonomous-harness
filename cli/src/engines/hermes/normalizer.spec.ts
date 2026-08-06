import { describe, expect, it } from 'vitest'
import {
  clarifyAsQuestions,
  hermesMessagesToEvents,
  hermesToolName,
  isTerminalFinish,
  lastHermesTurnText,
  messageToEvents,
  newHermesTurnState,
  parseToolCalls,
  toolResultText,
  windowHermesMessages,
  type HmMessage,
} from './normalizer.js'

function msg(partial: Partial<HmMessage> & { id: number; role: string }): HmMessage {
  return {
    content: '', toolCallId: null, toolCalls: null, toolName: null, finishReason: null, reasoning: null,
    ...partial,
  }
}

// Rows copied from a REAL local Hermes session (hermes 0.19.0, schema v23, provider vibe / minimax-m3).
const CALL_ID = 'call_ba1647ad979d0290'
const ROWS: HmMessage[] = [
  msg({ id: 21, role: 'user', content: 'Use your terminal tool to run exactly: ls. Then reply with just DONE.' }),
  msg({
    id: 22,
    role: 'assistant',
    finishReason: 'tool_calls',
    reasoning: 'The user wants a directory listing.',
    toolCalls: `[{"id":"${CALL_ID}","call_id":"${CALL_ID}","response_item_id":"fc_x","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"ls\\"}"}}]`,
  }),
  msg({
    id: 23,
    role: 'tool',
    toolName: 'terminal',
    toolCallId: CALL_ID,
    content: '{"output": "a.txt\\nb.txt", "exit_code": 0, "error": null}',
  }),
  msg({ id: 24, role: 'assistant', content: 'DONE', finishReason: 'stop' }),
]

function live(rows: HmMessage[]) {
  const state = newHermesTurnState()
  const events = rows.flatMap((row) => messageToEvents(row, state, 'live'))
  return { state, events }
}

describe('Hermes normalizer — live turn derivation', () => {
  it('derives the turn lifecycle from role + finish_reason (Hermes stores no turn markers)', () => {
    const { state, events } = live(ROWS)
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'thinking_delta',
      'tool_start',
      'tool_end',
      'text_delta',
      'turn_ended',
    ])
    expect(events[0]).toMatchObject({ payload: { userMessage: 'Use your terminal tool to run exactly: ls. Then reply with just DONE.' } })
    expect(state.open).toBe(false)
  })

  it('keeps the turn OPEN on finish_reason "tool_calls" (the model is still calling tools)', () => {
    const { state } = live(ROWS.slice(0, 2))
    expect(state.open).toBe(true)
    expect(isTerminalFinish('tool_calls')).toBe(false)
    expect(isTerminalFinish('stop')).toBe(true)
    expect(isTerminalFinish(null)).toBe(false)
  })

  it('maps the tool_calls blob + the paired role=tool row onto one tool card', () => {
    const { events } = live(ROWS)
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      payload: { id: CALL_ID, tool: 'Bash', input: { command: 'ls' } },
    })
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      payload: { id: CALL_ID, tool: 'Bash', output: 'a.txt\nb.txt', isError: false },
    })
  })

  it('flags a failed tool result from the JSON envelope', () => {
    const { events } = live([
      ROWS[0], ROWS[1],
      msg({ id: 23, role: 'tool', toolName: 'terminal', toolCallId: CALL_ID, content: '{"output": "boom", "exit_code": 2, "error": "nope"}' }),
    ])
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ payload: { isError: true } })
  })

  it('parseToolCalls / toolResultText handle malformed payloads without throwing', () => {
    expect(parseToolCalls(null)).toEqual([])
    expect(parseToolCalls('not json')).toEqual([])
    expect(parseToolCalls('{}')).toEqual([])
    expect(toolResultText('plain text')).toEqual({ output: 'plain text', isError: false })
  })

  it('maps Hermes tool names onto the shared vocabulary', () => {
    expect(hermesToolName('terminal')).toBe('Bash')
    expect(hermesToolName('read_file')).toBe('Read')
    expect(hermesToolName('write_file')).toBe('Write')
    expect(hermesToolName('search_files')).toBe('Grep')
    expect(hermesToolName('delegate_task')).toBe('Task')
    // `todo`, not `todo_write` — the fallback used to title-case it to `Todo`, which the todo-list path
    // does not recognise, so hermes silently had no checklist on the web or the device.
    expect(hermesToolName('todo')).toBe('TodoWrite')
    expect(hermesToolName('browser_click')).toBe('WebFetch')
    expect(hermesToolName('mystery')).toBe('Mystery')
  })

  it('presents `clarify` as AskUserQuestion, in the shape both UIs read', () => {
    // Hermes asks with ONE question and flat string choices; claude's shape (which the web's question box
    // and the device's question screen both parse) is a LIST whose options are objects. Renaming the tool
    // without this translation would put an empty question card on the web.
    expect(hermesToolName('clarify')).toBe('AskUserQuestion')
    expect(clarifyAsQuestions({ question: 'Bạn muốn chọn size nào?', choices: ['S', 'M'] })).toEqual({
      questions: [{
        question: 'Bạn muốn chọn size nào?',
        header: '',
        options: [{ label: 'S', description: '' }, { label: 'M', description: '' }],
        multiSelect: false,
      }],
    })
  })

  it('leaves an already-shaped or unusable clarify payload alone', () => {
    const shaped = { questions: [{ question: 'x', options: [] }] }
    expect(clarifyAsQuestions(shaped)).toBe(shaped)   // a replay/newer hermes must not be re-wrapped
    expect(clarifyAsQuestions({ choices: ['S'] })).toEqual({ choices: ['S'] })   // no question → untouched
  })

  it('ignores system/unknown roles', () => {
    const state = newHermesTurnState()
    expect(messageToEvents(msg({ id: 1, role: 'system', content: 'x' }), state, 'live')).toEqual([])
  })
})

describe('Hermes normalizer — replay, recap, window', () => {
  it('replays a session as user_message + assistant blocks, terminated by done', () => {
    const events = hermesMessagesToEvents(ROWS)
    expect(events.map((e) => e.type)).toEqual([
      'user_message', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'done',
    ])
  })

  it('lastHermesTurnText returns the last prompt + the assistant text that followed', () => {
    expect(lastHermesTurnText(ROWS)).toEqual({
      userMessage: 'Use your terminal tool to run exactly: ls. Then reply with just DONE.',
      assistantText: 'DONE',
    })
  })

  it('windowHermesMessages snaps the window start back to a user row', () => {
    const w = windowHermesMessages(ROWS, { limit: 2 })
    expect(w.window[0].role).toBe('user')
    expect(w.hasMore).toBe(false)
    expect(w.oldestCursor).toBe('hermes:0')
  })

  it('windowHermesMessages flags a malformed cursor as stale', () => {
    expect(windowHermesMessages(ROWS, { limit: 2, before: 'nope' }).staleCursor).toBe(true)
  })
})
