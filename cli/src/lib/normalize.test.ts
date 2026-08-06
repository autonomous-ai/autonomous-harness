import { describe, it, expect } from 'vitest'
import {
  lastTurnTextFromRawLines,
  lineToEvents,
  messagesToEvents,
  newTurnState,
  windowRawLines,
} from './normalize.js'

// Build a synthetic transcript: 3 turns, each = [user prompt, assistant tool_use, user tool_result].
// uuids: u1 a1 r1 | u2 a2 r2 | u3 a3 r3  (turn starts at line indices 0, 3, 6).
const line = (o: Record<string, unknown>) => JSON.stringify(o)
const userPrompt = (uuid: string, text: string) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
const asstToolUse = (uuid: string, id: string, name: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
const asstText = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const userToolResult = (uuid: string, toolUseId: string) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } })

const LINES = [
  userPrompt('u1', 'hello 1'), asstToolUse('a1', 't1', 'Bash'), userToolResult('r1', 't1'),
  userPrompt('u2', 'hello 2'), asstToolUse('a2', 't2', 'Read'), userToolResult('r2', 't2'),
  userPrompt('u3', 'hello 3'), asstToolUse('a3', 't3', 'Grep'), userToolResult('r3', 't3'),
]

describe('windowRawLines', () => {
  it('newest window is turn-snapped, reports hasMore + a real oldestCursor', () => {
    const w = windowRawLines(LINES, { limit: 2 })
    // limit=2 lands mid-turn (index 7); snaps back to the turn start u3 (index 6).
    expect(w.window).toEqual(LINES.slice(6, 9))
    expect(w.hasMore).toBe(true)
    expect(w.oldestCursor).toBe('u3')
    expect(w.staleCursor).toBeUndefined()

    // The window is self-contained: the tool_use precedes its tool_result, so messagesToEvents'
    // stateful tool-name map resolves — the tool card renders with its real name.
    const events = messagesToEvents(w.window)
    expect(events.some((e) => e.type === 'user_message' && (e.payload as { content: string }).content === 'hello 3')).toBe(true)
    expect(events.some((e) => e.type === 'tool_start' && (e.payload as { tool: string }).tool === 'Grep')).toBe(true)
  })

  it('pages backward with before=oldestCursor until hasMore=false', () => {
    const p1 = windowRawLines(LINES, { limit: 2, before: 'u3' })
    expect(p1.window).toEqual(LINES.slice(3, 6)) // turn 2
    expect(p1.hasMore).toBe(true)
    expect(p1.oldestCursor).toBe('u2')

    const p2 = windowRawLines(LINES, { limit: 2, before: 'u2' })
    expect(p2.window).toEqual(LINES.slice(0, 3)) // turn 1 — oldest
    expect(p2.hasMore).toBe(false)
    expect(p2.oldestCursor).toBe('u1')
  })

  it('flags a stale cursor (empty window) when before is not in the file', () => {
    const w = windowRawLines(LINES, { limit: 2, before: 'does-not-exist' })
    expect(w.staleCursor).toBe(true)
    expect(w.window).toEqual([])
    expect(w.hasMore).toBe(false)
  })

  it('returns everything when the window is larger than the transcript', () => {
    const w = windowRawLines(LINES, { limit: 100 })
    expect(w.window).toEqual(LINES)
    expect(w.hasMore).toBe(false)
    expect(w.oldestCursor).toBe('u1')
  })
})

describe('lastTurnTextFromRawLines', () => {
  it('extracts the last real user ask and assistant text from session JSONL', () => {
    const lines = [
      userPrompt('u1', 'old ask'),
      asstText('a1', 'old answer'),
      userPrompt('u2', 'current ask'),
      asstToolUse('a2', 't2', 'Bash'),
      userToolResult('r2', 't2'),
      asstText('a3', 'first answer part'),
      asstText('a4', 'second answer part'),
    ]

    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'current ask',
      assistantText: 'first answer part\n\nsecond answer part',
    })
  })

  it('skips compact metadata, platform prompts, and tool_result user echoes', () => {
    const lines = [
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }),
      line({ type: 'user', uuid: 'meta', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }),
      userPrompt('u1', '<!-- CONTEXT SUMMARY -->\nplatform prompt'),
      userPrompt('u2', 'real ask'),
      userToolResult('r2', 'tool'),
      asstText('a2', 'real answer'),
    ]

    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'real ask',
      assistantText: 'real answer',
    })
  })
})

describe('Claude local command records', () => {
  const modelOutput = userPrompt(
    'local-model',
    '<local-command-stdout>Set model to \u001b[1mOpus 4.8\u001b[22m and saved as your default for new sessions</local-command-stdout>',
  )
  const effortOutput = userPrompt(
    'local-effort',
    '<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>',
  )

  it('does not render local command stdout during replay', () => {
    expect(messagesToEvents([modelOutput, effortOutput])).toEqual([
      { type: 'done', payload: { result: 'success' } },
    ])
  })

  it('does not open a live turn for local command stdout', () => {
    const state = newTurnState()

    expect(lineToEvents(modelOutput, state)).toEqual([])
    expect(lineToEvents(effortOutput, state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })
})

describe('turn close on terminal stop reasons', () => {
  const asstStop = (uuid: string, text: string, stopReason: string) =>
    line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason } })

  const openTurn = () => {
    const state = newTurnState()
    lineToEvents(userPrompt('u1', 'hello'), state)
    expect(state.turnOpen).toBe(true)
    return state
  }

  it('closes the turn on max_tokens and refusal (not just end_turn/stop_sequence)', () => {
    for (const reason of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']) {
      const state = openTurn()
      const events = lineToEvents(asstStop('a1', 'partial', reason), state)
      expect(events).toContainEqual({ type: 'turn_ended', payload: {} })
      expect(state.turnOpen).toBe(false)
    }
  })

  it('does NOT close on tool_use or pause_turn (turn continues)', () => {
    for (const reason of ['tool_use', 'pause_turn']) {
      const state = openTurn()
      const events = lineToEvents(asstStop('a1', 'thinking', reason), state)
      expect(events).not.toContainEqual({ type: 'turn_ended', payload: {} })
      expect(state.turnOpen).toBe(true)
    }
  })

  it('does NOT close on a terminal stop reason while a tool is still pending', () => {
    const state = openTurn()
    lineToEvents(asstToolUse('a1', 't1', 'Bash'), state) // adds t1 to pendingTools
    const events = lineToEvents(asstStop('a2', 'done', 'end_turn'), state)
    expect(events).not.toContainEqual({ type: 'turn_ended', payload: {} })
    expect(state.turnOpen).toBe(true)
  })
})

describe('slash-command prompts', () => {
  // Claude Code records a typed command ONLY as these tags; the expansion it sends to the model is a
  // separate `isMeta` line we suppress. Before the fix both normalized to "" and NO turn ever opened,
  // so the device's `/goal <text>` (deviceWs sends exactly this) tripped the submit-verify retries and
  // surfaced "The agent did not accept the message" even though claude had run the command fine.
  const goalCmd = userPrompt(
    'c1',
    '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>ship the release</command-args>',
  )
  const goalStdout = userPrompt('c2', '<local-command-stdout>Goal set: ship the release</local-command-stdout>')
  const modelCmd = userPrompt(
    'c3',
    '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>',
  )

  it('opens a live turn with the command text verbatim (matches the injected fingerprint)', () => {
    const state = newTurnState()

    expect(lineToEvents(goalCmd, state)).toEqual([
      { type: 'turn_started', payload: { userMessage: '/goal ship the release' } },
    ])
    expect(state.turnOpen).toBe(true)
    expect(lineToEvents(goalStdout, state)).toEqual([]) // the echo must not re-open a turn
  })

  it('keeps local-only TUI commands silent', () => {
    const state = newTurnState()

    expect(lineToEvents(modelCmd, state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })

  it('leads the recap with the command text', () => {
    expect(lastTurnTextFromRawLines([goalCmd, goalStdout, asstText('a1', 'done')])).toEqual({
      userMessage: '/goal ship the release',
      assistantText: 'done',
    })
  })
})
