import { describe, expect, it } from 'vitest'
import {
  PiNormalizer,
  piMessagesToEvents,
  lastPiTurnText,
  piSessionMeta,
  piToolName,
  windowPiLines,
} from './normalizer.js'

// Fixtures copied from a REAL local Pi session (pi 0.82.1, provider vibe / minimax-m3):
// header → model_change → thinking_level_change → user → assistant(toolUse) → toolResult → assistant(stop).
const CALL_ID = 'chatcmpl-tool-873e31c30f939d10'
const LINES = [
  '{"type":"session","version":3,"id":"019fa2a5-a26d-700c-bf8c-97af19ae3d5f","timestamp":"2026-07-27T08:16:31.854Z","cwd":"/tmp/pi-probe"}',
  '{"type":"model_change","id":"45215278","parentId":null,"model":"minimax/minimax-m3"}',
  '{"type":"thinking_level_change","id":"1da16955","parentId":"45215278","level":"medium"}',
  '{"type":"message","id":"b0ecca48","parentId":"1da16955","message":{"role":"user","content":[{"type":"text","text":"list the files here"}]}}',
  `{"type":"message","id":"0fc9ca48","parentId":"b0ecca48","message":{"role":"assistant","content":[{"type":"thinking","thinking":"I should run ls."},{"type":"toolCall","id":"${CALL_ID}","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse","model":"minimax/minimax-m3","provider":"vibe"}}`,
  `{"type":"message","id":"1a2b3c4d","parentId":"0fc9ca48","message":{"role":"toolResult","toolCallId":"${CALL_ID}","toolName":"bash","content":[{"type":"text","text":"a.txt\\nb.txt\\n"}],"isError":false}}`,
  '{"type":"message","id":"9f8e7d6c","parentId":"1a2b3c4d","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Files listed."},{"type":"text","text":"DONE"}],"stopReason":"stop","model":"minimax/minimax-m3"}}',
]

function live(lines: string[]) {
  const normalizer = new PiNormalizer('live')
  return { normalizer, events: lines.flatMap((line) => normalizer.ingest(line)) }
}

describe('PiNormalizer — live turn derivation', () => {
  it('derives the turn lifecycle from message roles + stopReason (no turn markers on disk)', () => {
    const { normalizer, events } = live(LINES)
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',   // user message
      'thinking_delta',
      'tool_start',
      'tool_end',       // toolResult
      'thinking_delta',
      'text_delta',
      'turn_ended',     // assistant stopReason 'stop' with no pending tools
    ])
    expect(events[0]).toMatchObject({ type: 'turn_started', payload: { userMessage: 'list the files here' } })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('keeps the turn OPEN while the assistant is calling a tool (stopReason "toolUse")', () => {
    const { normalizer } = live(LINES.slice(0, 5)) // header … assistant(toolUse)
    expect(normalizer.turnOpen).toBe(true)
  })

  it('maps a toolCall/toolResult pair onto the shared tool vocabulary, joined by toolCallId', () => {
    const { events } = live(LINES)
    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')
    expect(start).toMatchObject({ type: 'tool_start', payload: { id: CALL_ID, tool: 'Bash', input: { command: 'ls' } } })
    expect(end).toMatchObject({ type: 'tool_end', payload: { id: CALL_ID, tool: 'Bash', output: 'a.txt\nb.txt\n', isError: false } })
  })

  it('ignores the header and non-message entries, and never throws on a malformed line', () => {
    const normalizer = new PiNormalizer('live')
    expect(normalizer.ingest(LINES[0])).toEqual([]) // session header
    expect(normalizer.ingest(LINES[1])).toEqual([]) // model_change
    expect(normalizer.ingest(LINES[2])).toEqual([]) // thinking_level_change
    expect(normalizer.ingest('not json')).toEqual([])
    expect(normalizer.ingest('null')).toEqual([])
    expect(normalizer.ingest('')).toEqual([])
  })

  it('emits a context_compact indicator for a compaction entry', () => {
    const normalizer = new PiNormalizer('live')
    expect(normalizer.ingest('{"type":"compaction","id":"x"}').map((e) => e.type)).toEqual(['context_compact'])
  })

  it('closeTurn() clears the open turn and any pending tools', () => {
    const { normalizer } = live(LINES.slice(0, 5))
    normalizer.closeTurn()
    expect(normalizer.turnOpen).toBe(false)
  })

  it('renders a `!cmd` bashExecution entry as a Bash card', () => {
    const normalizer = new PiNormalizer('live')
    const events = normalizer.ingest('{"type":"message","id":"be1","message":{"role":"bashExecution","command":"git status","output":"clean","exitCode":0}}')
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[0]).toMatchObject({ payload: { tool: 'Bash', input: { command: 'git status' } } })
  })
})

describe('PiNormalizer — replay, recap, window', () => {
  it('replays a session as user_message + assistant blocks, terminated by done', () => {
    const events = piMessagesToEvents(LINES)
    expect(events.map((e) => e.type)).toEqual([
      'user_message', 'thinking_delta', 'tool_start', 'tool_end', 'thinking_delta', 'text_delta', 'done',
    ])
    expect(events[0]).toMatchObject({ type: 'user_message', payload: { content: 'list the files here' } })
  })

  it('lastPiTurnText returns the last user prompt + the assistant text that followed', () => {
    expect(lastPiTurnText(LINES)).toEqual({ userMessage: 'list the files here', assistantText: 'DONE' })
  })

  it('piSessionMeta reads the id + cwd from the header line', () => {
    expect(piSessionMeta(LINES)).toEqual({ id: '019fa2a5-a26d-700c-bf8c-97af19ae3d5f', cwd: '/tmp/pi-probe' })
  })

  it('maps Pi lowercase tool names onto the shared vocabulary', () => {
    expect(piToolName('bash')).toBe('Bash')
    expect(piToolName('read')).toBe('Read')
    expect(piToolName('find')).toBe('Glob')
    expect(piToolName('ls')).toBe('LS')
    expect(piToolName('somethingElse')).toBe('SomethingElse')
  })

  it('windowPiLines snaps the window start back to a user message', () => {
    const w = windowPiLines(LINES, { limit: 2 })
    expect(w.window[0]).toContain('"role":"user"')
    expect(w.hasMore).toBe(true)
    expect(w.oldestCursor).toBe('pi:3')
  })

  it('windowPiLines flags a malformed cursor as stale', () => {
    expect(windowPiLines(LINES, { limit: 2, before: 'nope' }).staleCursor).toBe(true)
  })
})
