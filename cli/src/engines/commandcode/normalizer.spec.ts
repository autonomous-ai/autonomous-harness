import { describe, expect, it } from 'vitest'
import {
  CommandCodeNormalizer,
  commandCodeRunError,
  commandCodeRunErrorSummary,
  commandCodeSessionMeta,
  commandCodeToolName,
  commandcodeMessagesToEvents,
  lastCommandCodeTurnText,
  reshapeLine,
  windowCommandCodeLines,
} from './normalizer.js'

// Lines copied from a REAL captured Command Code session (commandcode 1.4.4): a plain turn, then a
// tool-calling turn (`shell_command`), then the closing text turn.
const CALL = 'call_00_U0MkyEAMP9Xu'
const HEADER = '{"type":"session","version":3,"id":"34e1385f-c18a-4f54-bf12-f8f57e151a3d","timestamp":"2026-07-28T04:16:39.000Z","cwd":"/tmp/cc-probe"}'
const LINES = [
  HEADER,
  '{"type":"message","id":"b9b74cd5","parentId":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"hi"}],"meta":{"source":"user","messageId":"m1"}}}',
  '{"type":"message","id":"be03e3d9","parentId":"b9b74cd5","timestamp":"t2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Simple greeting.","signature":""},{"type":"text","text":"Hi! What can I help you with today?"}],"meta":{"source":"model","messageId":"m2"}}}',
  '{"type":"message","id":"59ec89ec","parentId":"be03e3d9","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"list the files"}],"meta":{"source":"user","messageId":"m3"}}}',
  `{"type":"message","id":"6c05e6e5","parentId":"59ec89ec","timestamp":"t4","message":{"role":"assistant","content":[{"type":"thinking","thinking":"I should run ls.","signature":""},{"type":"tool_use","id":"${CALL}","name":"shell_command","input":{"command":"ls -1"}}],"meta":{"source":"model","messageId":"m4"}}}`,
  `{"type":"message","id":"72d9f290","parentId":"6c05e6e5","timestamp":"t5","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${CALL}","content":[{"type":"text","text":"a.txt\\nb.txt"}]}],"meta":{"source":"tool","messageId":"m5"}}}`,
  '{"type":"message","id":"4c3052c4","parentId":"72d9f290","timestamp":"t6","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Report them.","signature":""},{"type":"text","text":"a.txt and b.txt"}],"meta":{"source":"model","messageId":"m6"}}}',
]

function live(lines: string[]) {
  const normalizer = new CommandCodeNormalizer('live')
  return { normalizer, events: lines.flatMap((line) => normalizer.ingest(line)) }
}

describe('Command Code normalizer — reshape into the Claude shape', () => {
  it('drops the header and maps meta.source onto the claude record type', () => {
    expect(reshapeLine(HEADER)).toBeNull()
    expect(reshapeLine('not json')).toBeNull()

    const user = JSON.parse(reshapeLine(LINES[1])!) as Record<string, unknown>
    expect(user).toMatchObject({ type: 'user', uuid: 'b9b74cd5', parentUuid: null })

    // A `tool` row is a role:"user" message carrying tool_result — it must NOT look like a prompt.
    const tool = JSON.parse(reshapeLine(LINES[5])!) as { type: string; message: { content: Array<{ type: string }> } }
    expect(tool.type).toBe('user')
    expect(tool.message.content[0].type).toBe('tool_result')
  })

  it('synthesizes the stop_reason Command Code does not record', () => {
    const withTool = JSON.parse(reshapeLine(LINES[4])!) as { message: { stop_reason: string } }
    const withoutTool = JSON.parse(reshapeLine(LINES[2])!) as { message: { stop_reason: string } }
    expect(withTool.message.stop_reason).toBe('tool_use')   // turn continues into the tool
    expect(withoutTool.message.stop_reason).toBe('end_turn') // turn is done
  })

  it('maps tool ids onto the shared vocabulary inside the reshaped line', () => {
    const reshaped = JSON.parse(reshapeLine(LINES[4])!) as { message: { content: Array<{ type: string; name?: string }> } }
    expect(reshaped.message.content.find((p) => p.type === 'tool_use')?.name).toBe('Bash')
    expect(commandCodeToolName('shell_command')).toBe('Bash')
    expect(commandCodeToolName('read_file')).toBe('Read')
    expect(commandCodeToolName('web_search')).toBe('WebSearch')
    expect(commandCodeToolName('todo_write')).toBe('TodoWrite')
    expect(commandCodeToolName('activate_skill')).toBe('Task')
    expect(commandCodeToolName('some_new_tool')).toBe('SomeNewTool')
  })
})

describe('Command Code normalizer — live turn lifecycle', () => {
  it('derives turn_started/turn_ended for a plain turn and a tool-calling turn', () => {
    const { normalizer, events } = live(LINES)
    expect(events.map((e) => e.type)).toEqual([
      'turn_started', 'thinking_delta', 'thinking_title', 'text_delta', 'turn_ended', // "hi"
      'turn_started', 'thinking_delta', 'thinking_title', 'tool_start',               // "list the files"
      'tool_end',
      'thinking_delta', 'thinking_title', 'text_delta', 'turn_ended',
    ])
    expect(events[0]).toMatchObject({ type: 'turn_started', payload: { userMessage: 'hi' } })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('keeps the turn OPEN while a tool call is outstanding', () => {
    const { normalizer } = live(LINES.slice(0, 5)) // … up to the assistant that calls the tool
    expect(normalizer.turnOpen).toBe(true)
  })

  it('pairs tool_use with its tool_result on the shared card', () => {
    const { events } = live(LINES)
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      payload: { id: CALL, tool: 'Bash', input: { command: 'ls -1' } },
    })
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      payload: { id: CALL, tool: 'Bash', output: 'a.txt\nb.txt', isError: false },
    })
  })

  it('closeTurn() clears the open turn', () => {
    const { normalizer } = live(LINES.slice(0, 5))
    normalizer.closeTurn()
    expect(normalizer.turnOpen).toBe(false)
  })
})

describe('Command Code normalizer — replay, recap, window', () => {
  it('replays as user_message + assistant blocks, terminated by done', () => {
    const types = commandcodeMessagesToEvents(LINES).map((e) => e.type)
    expect(types.filter((t) => t === 'user_message')).toHaveLength(2)
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types.at(-1)).toBe('done')
  })

  it('lastCommandCodeTurnText returns the last prompt + the assistant text that followed', () => {
    expect(lastCommandCodeTurnText(LINES)).toEqual({
      userMessage: 'list the files',
      assistantText: 'a.txt and b.txt',
    })
  })

  it('commandCodeSessionMeta reads the id + cwd from the header', () => {
    expect(commandCodeSessionMeta(LINES)).toEqual({ id: '34e1385f-c18a-4f54-bf12-f8f57e151a3d', cwd: '/tmp/cc-probe' })
  })

  it('windowCommandCodeLines snaps back to a real user prompt (never a tool_result row)', () => {
    const w = windowCommandCodeLines(LINES, { limit: 2 })
    expect(JSON.parse(w.window[0]).message.meta.source).toBe('user')
    expect(w.hasMore).toBe(true)
    expect(w.oldestCursor).toBe('commandcode:3')
  })

  it('windowCommandCodeLines flags a malformed cursor as stale', () => {
    expect(windowCommandCodeLines(LINES, { limit: 2, before: 'nope' }).staleCursor).toBe(true)
  })
})

// Both records are copied verbatim from real failed sessions on this computer — the only two source-less
// rows across 96 captured message records. Command Code writes them when a turn dies (`run_error`) and
// fires no Stop hook for it, so they are the sole end-of-turn signal.
const RUN_ERROR = '{"type":"message","id":"9a87ff6f","parentId":"6e6c9931","timestamp":"t7","message":'
  + '{"role":"user","content":[{"type":"text","text":"Error: 500 [object Object]\\n\\nType \\"continue\\" to try again.'
  + ' If the issue persists, contact support: https://commandcode.ai/discord\\nTrace ID: 932a62f1e3c8102bf09baf00c08d81a7"}],'
  + '"meta":{"messageId":"4b13beb7-bcac-4fcf-8261-61ac32a45441"}}}'
const OUT_OF_CREDITS = '{"type":"message","id":"1c0dd0a1","parentId":null,"timestamp":"t2","message":'
  + '{"role":"user","content":[{"type":"text","text":"Insufficient credits"}],"meta":{"messageId":"5dafb0e0"}}}'

describe('Command Code normalizer — run-error records', () => {
  it('detects a source-less user row and leaves genuine records alone', () => {
    expect(commandCodeRunError(RUN_ERROR)).toMatch(/^Error: 500 \[object Object]/)
    expect(commandCodeRunError(OUT_OF_CREDITS)).toBe('Insufficient credits')
    expect(commandCodeRunError(LINES[1])).toBeNull() // a real prompt (meta.source === 'user')
    expect(commandCodeRunError(LINES[5])).toBeNull() // a tool_result carrier (meta.source === 'tool')
    expect(commandCodeRunError(HEADER)).toBeNull()
  })

  it('closes the running turn instead of opening a phantom one', () => {
    // The exact shape that hung the web: a prompt, then tool work, then the run error and nothing else.
    const { normalizer, events } = live([...LINES.slice(0, 6), RUN_ERROR])
    const lifecycle = events.filter((e) => e.type === 'turn_started' || e.type === 'turn_ended')

    expect(lifecycle.map((e) => e.type)).toEqual(['turn_started', 'turn_ended', 'turn_started', 'turn_ended'])
    // Reshaped as a prompt it would have been a THIRD turn_started, with its text as the user message.
    expect(lifecycle.filter((e) => e.type === 'turn_started')
      .map((e) => (e as { payload: { userMessage: string } }).payload.userMessage))
      .toEqual(['hi', 'list the files'])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('is inert when no turn is open', () => {
    const { normalizer, events } = live([HEADER, RUN_ERROR])
    expect(events).toEqual([])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('stays out of the replay and recap paths', () => {
    const lines = [...LINES, RUN_ERROR]
    expect(reshapeLine(RUN_ERROR)).toBeNull()
    // No extra user bubble on replay…
    expect(commandcodeMessagesToEvents(lines).filter((e) => e.type === 'user_message')).toHaveLength(2)
    // …and the recap still summarizes the real turn rather than the error text.
    expect(lastCommandCodeTurnText(lines)).toEqual({
      userMessage: 'list the files',
      assistantText: 'a.txt and b.txt',
    })
  })

  it('summarizes to the first line for the device, dropping the support URL and trace id', () => {
    expect(commandCodeRunErrorSummary(commandCodeRunError(RUN_ERROR)!)).toBe('Error: 500 [object Object]')
    expect(commandCodeRunErrorSummary('Insufficient credits')).toBe('Insufficient credits')
  })
})
