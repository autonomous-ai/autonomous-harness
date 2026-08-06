import { describe, expect, it } from 'vitest'
import {
  CursorNormalizer,
  cursorMessagesToEvents,
  cursorTaskId,
  cursorUserText,
  lastCursorTurnText,
  windowCursorLines,
} from './normalizer.js'

const line = (value: unknown): string => JSON.stringify(value)
const user = (text: string): string => line({
  role: 'user',
  message: { content: [{ type: 'text', text: `<timestamp>now</timestamp>\n<user_query>\n${text}\n</user_query>` }] },
})
const assistant = (...content: unknown[]): string => line({ role: 'assistant', message: { content } })

describe('CursorNormalizer', () => {
  it('strips only the outer Cursor user wrapper', () => {
    expect(cursorUserText('<timestamp>x</timestamp><user_query>hello <tag>x</tag></user_query>'))
      .toBe('hello <tag>x</tag>')
  })

  it('folds TodoWrite deltas into full snapshots', () => {
    const events = cursorMessagesToEvents([
      user('todo'),
      assistant({ type: 'tool_use', name: 'TodoWrite', input: {
        merge: false,
        todos: [
          { id: 'a', content: 'A', status: 'in_progress' },
          { id: 'b', content: 'B', status: 'pending' },
        ],
      } }),
      assistant({ type: 'tool_use', name: 'TodoWrite', input: {
        merge: true,
        todos: [
          { id: 'a', status: 'completed' },
          { id: 'b', status: 'deleted' },
        ],
      } }),
      line({ type: 'turn_ended', status: 'success' }),
    ], 'session')
    const starts = events.filter((event) => event.type === 'tool_start')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({
      payload: {
        tool: 'TodoWrite',
        input: {
          todos: [
            { id: 'a', content: 'A', status: 'completed' },
          ],
        },
      },
    })
  })

  it('normalizes Cursor WebSearch search_term to the client query field', () => {
    const events = cursorMessagesToEvents([
      user('search'),
      assistant({ type: 'tool_use', name: 'WebSearch', input: {
        search_term: 'Bitcoin BTC Ethereum ETH price USD today live',
        explanation: 'Get current prices.',
      } }),
      line({ type: 'turn_ended', status: 'success' }),
    ], 'session')

    expect(events).toContainEqual({
      type: 'tool_start',
      payload: {
        id: 'cursor:session:1:0',
        tool: 'WebSearch',
        input: {
          query: 'Bitcoin BTC Ethereum ETH price USD today live',
          search_term: 'Bitcoin BTC Ethereum ETH price USD today live',
          explanation: 'Get current prices.',
        },
      },
    })
  })

  it('hides Cursor redaction placeholders from live and replay text', () => {
    const response = assistant(
      { type: 'text', text: 'Hi - can gi tiep khong?\n\n[REDACTED]' },
      { type: 'text', text: '[REDACTED]' },
    )
    const live = new CursorNormalizer('live', 'session')
    live.ingest(user('hi'))

    expect(live.ingest(response)).toEqual([{
      type: 'text_delta',
      payload: { content: 'Hi - can gi tiep khong?' },
    }])
    expect(cursorMessagesToEvents([user('hi'), response], 'session')).toContainEqual({
      type: 'text_delta',
      payload: { content: 'Hi - can gi tiep khong?' },
    })
    expect(cursorMessagesToEvents([user('hi'), response], 'session'))
      .not.toContainEqual(expect.objectContaining({
        type: 'text_delta',
        payload: expect.objectContaining({ content: '[REDACTED]' }),
      }))
  })

  it('hides Cursor redaction placeholders from recap text', () => {
    expect(lastCursorTurnText([
      user('hi'),
      assistant({ type: 'text', text: 'Hi - can gi tiep khong?\n\n[REDACTED]' }),
      assistant({ type: 'text', text: '[REDACTED]' }),
    ])).toEqual({
      userMessage: 'hi',
      assistantText: 'Hi - can gi tiep khong?',
    })
  })

  it('deduplicates Task preToolUse from the later transcript block', () => {
    const normalizer = new CursorNormalizer('live', 'session')
    const input = { description: 'Inspect', prompt: 'Inspect it', model: 'inherit' }
    const hook = normalizer.ingestTaskHook({ toolUseId: 'call-1', input })
    const transcript = normalizer.ingest(assistant({ type: 'tool_use', name: 'Task', input }))
    expect(hook).toEqual([{
      type: 'tool_start',
      payload: { id: cursorTaskId('session', 'call-1'), tool: 'Task', input },
    }])
    expect(transcript).toEqual([])
  })

  it('maps replay child tools and result under the Task launcher', () => {
    const events = cursorMessagesToEvents([
      user('delegate'),
      assistant({ type: 'tool_use', name: 'Task', input: { description: 'Inspect', prompt: 'Inspect it' } }),
    ], 'session', [{
      toolUseId: 'call-1',
      prompt: 'Inspect it',
      output: 'Done',
      isError: false,
      agentId: 'child',
      totalToolUseCount: 1,
      events: [
        { type: 'tool_start', payload: { id: 'child-tool', tool: 'Read', input: { path: 'a' } } },
        { type: 'tool_end', payload: { id: 'child-tool', tool: 'Read', output: '', isError: false, summary: 'Completed' } },
      ],
    }])
    const launcherId = cursorTaskId('session', 'call-1')
    expect(events).toContainEqual({
      type: 'tool_start',
      payload: { id: 'child-tool', tool: 'Read', input: { path: 'a' }, parentToolUseId: launcherId },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_end',
      payload: expect.objectContaining({ id: launcherId, output: 'Done' }),
    }))
  })

  it('hydrates Todo state before a paginated window that starts with a delta', () => {
    const lines = [
      user('first'),
      assistant({ type: 'tool_use', name: 'TodoWrite', input: {
        merge: false,
        todos: [{ id: 'a', content: 'A', status: 'pending' }],
      } }),
      line({ type: 'turn_ended', status: 'success' }),
      user('second'),
      assistant({ type: 'tool_use', name: 'TodoWrite', input: {
        merge: true,
        todos: [{ id: 'a', status: 'completed' }],
      } }),
      line({ type: 'turn_ended', status: 'success' }),
    ]
    const window = windowCursorLines(lines, { limit: 2 })
    const events = cursorMessagesToEvents(
      window.window,
      'session',
      [],
      window.startIndex,
      window.initialTodos,
    )
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_start',
      payload: expect.objectContaining({
        tool: 'TodoWrite',
        input: { todos: [{ id: 'a', content: 'A', status: 'completed' }] },
      }),
    }))
  })

  it('emits the existing done marker before the live turn boundary', () => {
    const normalizer = new CursorNormalizer('live', 'session')
    const events = [
      ...normalizer.ingest(user('hello')),
      ...normalizer.ingest(line({ type: 'turn_ended', status: 'success' })),
    ]
    expect(events.slice(-2)).toEqual([
      { type: 'done', payload: { result: 'success' } },
      { type: 'turn_ended', payload: {} },
    ])
  })
})
