import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  isPermissionRejection,
  kiloMessagesToEvents,
  kiloToolName,
  lastKiloTurnText,
  windowKiloMessages,
  type KiloMessage,
} from './normalizer.js'

/**
 * A REAL kilo 7.4.20 session, exported from this machine's own `kilo.db` with the home directory
 * scrubbed. Two turns were driven by hand in a tmux pane: one that read a file and wrote a todo list,
 * and one whose file read was REFUSED at kilo's permission prompt. Nothing here is hand-written, which
 * is the point — every tool id and field name below is what kilo actually stored.
 */
function session(): KiloMessage[] {
  const p = fileURLToPath(new URL('../../lib/__fixtures__/kilo-session.json', import.meta.url))
  return JSON.parse(readFileSync(p, 'utf-8')) as KiloMessage[]
}

describe('kilo normalizer — replay', () => {
  it('renders the measured session as a conversation', () => {
    const events = kiloMessagesToEvents(session())
    expect(events.map((e) => e.type)).toEqual([
      'user_message',
      'thinking_delta', 'tool_start', 'tool_end',
      'thinking_delta', 'tool_start', 'tool_end',
      'thinking_delta', 'text_delta',
      'user_message',
      'thinking_delta', 'tool_start', 'tool_end',
      'done',
    ])
    expect(events[0]).toMatchObject({ payload: { content: expect.stringContaining('read notes.txt') } })
  })

  /**
   * ONE user message produced THREE assistant messages here. Replay must not invent a turn boundary
   * between them — the conversation is one exchange, and the reader (not this path) owns turn frames.
   */
  it('replays as a conversation, not as a turn lifecycle', () => {
    // ONE user message produced THREE assistant messages here, and replay must not invent boundaries
    // between them. The replay type has no turn frames at all — that asserting one does not even
    // typecheck is the real guarantee; this checks the count the surfaces actually render.
    const events = kiloMessagesToEvents(session())
    expect(events.filter((e) => e.type === 'user_message')).toHaveLength(2)
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
  })

  it('maps the measured tool ids onto the shared vocabulary', () => {
    const events = kiloMessagesToEvents(session())
    const tools = events.filter((e) => e.type === 'tool_start')
      .map((e) => (e as { payload: { tool: string } }).payload.tool)
    // `read` and `todowrite` are what kilo actually called — not names borrowed from another engine.
    expect(tools).toEqual(['Read', 'TodoWrite', 'Read'])
  })

  /**
   * The device checklist reads `input.todos[].content` literally. Kilo already speaks that shape, so the
   * assertion here is that nothing reshapes it away — a rename would empty the checklist with no error.
   */
  it("hands the checklist kilo's todos under the field the device reads", () => {
    const start = kiloMessagesToEvents(session())
      .find((e) => e.type === 'tool_start' && (e as { payload: { tool: string } }).payload.tool === 'TodoWrite')
    const input = (start as { payload: { input: { todos: Array<{ content: string; status: string }> } } }).payload.input
    expect(input.todos).toHaveLength(3)
    expect(input.todos[0].content).toBe('Review and organize files in /private/tmp/kilo-probe')
    expect(input.todos[0].status).toBe('pending')
  })

  it('marks the refused tool as an error rather than a silent success', () => {
    const ends = kiloMessagesToEvents(session()).filter((e) => e.type === 'tool_end')
    const last = ends[ends.length - 1] as { payload: { isError: boolean; output: string } }
    expect(last.payload.isError).toBe(true)
    expect(last.payload.output).toContain('rejected permission')
  })
})

/**
 * The refusal is a turn BOUNDARY, and it is the one kilo never writes a `step-finish reason:'stop'` for.
 * These two cases are what stop a refused turn from spinning the device tile forever.
 */
describe('kilo permission refusal', () => {
  it('recognises the refusal kilo actually wrote', () => {
    const refused = session()[5].parts.find((p) => p.type === 'tool')!
    expect(isPermissionRejection(refused)).toBe(true)
  })

  it('does NOT treat an ordinary tool failure as the end of a turn', () => {
    // A failing command is handed back to the model and it carries on; closing here would cut turns off
    // mid-flight. Only a refusal stops kilo.
    expect(isPermissionRejection({
      id: 'prt_x',
      type: 'tool',
      data: { type: 'tool', tool: 'bash', state: { status: 'error', error: 'command not found: frobnicate' } },
    })).toBe(false)
    expect(isPermissionRejection({
      id: 'prt_y', type: 'text', data: { type: 'text', text: 'rejected permission' },
    })).toBe(false)
  })
})

describe('kilo recap source', () => {
  it('reads the last prompt and the answer that followed it', () => {
    // Drop the refused exchange: this is the last turn that actually answered.
    const answered = session().slice(0, 4)
    const last = lastKiloTurnText(answered)
    expect(last?.userMessage).toContain('read notes.txt')
    expect(last?.assistantText).toContain('alpha')
  })

  /**
   * Measured, and deliberate: the refused turn produced no assistant text, and the recap reports NOTHING
   * rather than re-summarising the previous turn. A recap sourced from the wrong turn is the classic
   * symptom of a last-turn tracker resetting on the wrong record, so an empty answer is the honest one.
   */
  it('reports nothing when the last turn was refused and said nothing', () => {
    expect(lastKiloTurnText(session())).toBeNull()
  })

  it('reports nothing for a session with no assistant text at all', () => {
    expect(lastKiloTurnText([])).toBeNull()
  })
})

describe('kilo history window', () => {
  it('namespaces its cursor so another engine cannot index into it', () => {
    const w = windowKiloMessages(session(), { limit: 2 })
    expect(w.oldestCursor).toMatch(/^kilo:\d+$/)
    expect(w.hasMore).toBe(true)
    // An opencode cursor is not a kilo cursor, even though the two stores are shaped the same.
    expect(windowKiloMessages(session(), { limit: 2, before: 'opencode:3' }).staleCursor).toBe(true)
  })

  it('snaps the window back to a user message so a turn is never split', () => {
    const w = windowKiloMessages(session(), { limit: 2 })
    expect(w.window[0].role).toBe('user')
  })
})

describe('kilo tool names', () => {
  it('title-cases an id it has never seen instead of guessing at it', () => {
    // The measured ids are asserted above. An unmeasured one must render plainly rather than land on
    // some other engine's card by accident.
    expect(kiloToolName('frobnicate')).toBe('Frobnicate')
    expect(kiloToolName('')).toBe('tool')
  })
})
