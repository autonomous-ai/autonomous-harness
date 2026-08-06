import { describe, expect, it } from 'vitest'
import {
  opencodeMessagesToEvents,
  lastOpencodeTurnText,
  windowOpencodeMessages,
  taskStartEvent,
  taskEndEvent,
  extractTaskResult,
  isTaskPart,
  type OcMessage,
  type OcPart,
} from './normalizer.js'

function part(type: string, data: Record<string, unknown>, id = `prt_${type}_${Math.round(Math.random() * 1e6)}`): OcPart {
  return { id, type, data: { type, ...data } }
}
function msg(role: string, parts: OcPart[], id = `msg_${role}`, timeCreated = 1): OcMessage {
  return { id, role, timeCreated, data: { role }, parts }
}

describe('opencode normalizer — replay', () => {
  it('maps a user + assistant (text, reasoning) turn to the shared event shapes', () => {
    const events = opencodeMessagesToEvents([
      msg('user', [part('text', { text: 'what is the BTC price?' })], 'msg_u', 1),
      msg('assistant', [
        part('step-start', {}),
        part('reasoning', { text: 'The user wants the BTC price.' }),
        part('text', { text: '65,374 USD' }),
        part('step-finish', { reason: 'stop' }),
      ], 'msg_a', 2),
    ])
    expect(events.map((e) => e.type)).toEqual(['user_message', 'thinking_delta', 'text_delta', 'done'])
    expect(events[0]).toMatchObject({ type: 'user_message', payload: { content: 'what is the BTC price?' } })
    expect(events[2]).toMatchObject({ type: 'text_delta', payload: { content: '65,374 USD' } })
  })

  it('maps a completed tool part to a Claude-vocabulary tool_start + tool_end', () => {
    const events = opencodeMessagesToEvents([
      msg('assistant', [
        part('tool', { tool: 'webfetch', state: { status: 'completed', input: { url: 'https://x' }, output: 'ok' } }, 'prt_t'),
      ]),
    ])
    const tool = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end')
    expect(tool[0]).toMatchObject({ type: 'tool_start', payload: { id: 'prt_t', tool: 'WebFetch', input: { url: 'https://x' } } })
    expect(tool[1]).toMatchObject({ type: 'tool_end', payload: { id: 'prt_t', tool: 'WebFetch', output: 'ok', isError: false } })
  })

  it('maps a todowrite tool part to TodoWrite with the todo list intact', () => {
    const todos = [
      { content: 'Fetch BTC price', status: 'completed', priority: 'high' },
      { content: 'Report all prices', status: 'pending', priority: 'high' },
    ]
    const events = opencodeMessagesToEvents([
      msg('assistant', [part('tool', { tool: 'todowrite', state: { status: 'completed', input: { todos }, output: '[]' } }, 'prt_todo')]),
    ])
    const start = events.find((e) => e.type === 'tool_start')
    expect(start).toMatchObject({ type: 'tool_start', payload: { tool: 'TodoWrite', input: { todos } } })
  })

  it('renders a task tool part as a Task card with a sub-agent summary', () => {
    const taskPart = part('tool', {
      tool: 'task',
      state: {
        status: 'completed',
        input: { description: 'Fetch BNB price', prompt: 'fetch BNB', subagent_type: 'general' },
        output: '<task id="ses_child" state="completed">\n<task_result>\n573.92\n</task_result>\n</task>',
        metadata: { sessionId: 'ses_child', parentSessionId: 'ses_parent' },
        time: { start: 1000, end: 3000 },
      },
    }, 'prt_task')
    expect(isTaskPart(taskPart)).toBe(true)

    const start = taskStartEvent(taskPart)
    expect(start).toMatchObject({ type: 'tool_start', payload: { id: 'prt_task', tool: 'Task', input: { subagent_type: 'general', description: 'Fetch BNB price' } } })

    const end = taskEndEvent(taskPart, { totalToolUseCount: 1, totalTokens: 42 })
    expect(end).toMatchObject({
      type: 'tool_end',
      payload: {
        id: 'prt_task',
        tool: 'Task',
        output: '573.92',
        isError: false,
        subagent: { agentId: 'ses_child', agentType: 'general', totalToolUseCount: 1, totalTokens: 42, totalDurationMs: 2000 },
      },
    })
  })

  it('extractTaskResult pulls the <task_result> body, else the raw text', () => {
    expect(extractTaskResult('<task_result>\n42\n</task_result>')).toBe('42')
    expect(extractTaskResult('plain output')).toBe('plain output')
  })

  it('an in-flight tool part emits only tool_start', () => {
    const events = opencodeMessagesToEvents([
      msg('assistant', [part('tool', { tool: 'bash', state: { status: 'running', input: { command: 'ls' } } }, 'prt_r')]),
    ])
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(0)
  })
})

describe('opencode normalizer — recap + window', () => {
  it('lastOpencodeTurnText returns the last user prompt + following assistant text', () => {
    const turn = lastOpencodeTurnText([
      msg('user', [part('text', { text: 'first' })], 'm1', 1),
      msg('assistant', [part('text', { text: 'ignored' })], 'm2', 2),
      msg('user', [part('text', { text: 'who won?' })], 'm3', 3),
      msg('assistant', [part('text', { text: 'Spain won.' })], 'm4', 4),
    ])
    expect(turn).toEqual({ userMessage: 'who won?', assistantText: 'Spain won.' })
  })

  it('windowOpencodeMessages snaps the window start back to a user message', () => {
    const messages = [
      msg('user', [part('text', { text: 'u1' })], 'm1', 1),
      msg('assistant', [part('text', { text: 'a1' })], 'm2', 2),
      msg('user', [part('text', { text: 'u2' })], 'm3', 3),
      msg('assistant', [part('text', { text: 'a2' })], 'm4', 4),
    ]
    const w = windowOpencodeMessages(messages, { limit: 2 })
    expect(w.window[0].role).toBe('user') // snapped back to m3
    expect(w.hasMore).toBe(true)
    expect(w.oldestCursor).toBe('opencode:2')
  })

  it('windowOpencodeMessages flags a malformed cursor as stale', () => {
    const w = windowOpencodeMessages([], { limit: 2, before: 'not-a-cursor' })
    expect(w.staleCursor).toBe(true)
  })
})
