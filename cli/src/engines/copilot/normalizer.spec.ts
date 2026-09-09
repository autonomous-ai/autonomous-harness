import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CopilotNormalizer,
  copilotEvent,
  copilotHistoryTurnOpen,
  copilotMessagesToEvents,
  copilotSessionModel,
  copilotToolName,
  lastCopilotTurnText,
} from './normalizer.js'
import type { LiveEvent } from '../../lib/normalize.js'

const FIXTURE = fileURLToPath(new URL('../../lib/__fixtures__/copilot-session.jsonl', import.meta.url))
const LINES = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)

function live(): LiveEvent[] {
  const normalizer = new CopilotNormalizer()
  const events: LiveEvent[] = []
  for (const line of LINES) events.push(...normalizer.ingest(line))
  events.push(...normalizer.closeTurn())
  return events
}

describe('copilot normalizer, over real recorded sessions', () => {
  it('opens a turn per user message and closes the last one on the agentStop hook', () => {
    const events = live()
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(2)
    expect(events[events.length - 1].type).toBe('turn_ended')
  })

  it('does NOT read the lifecycle off assistant.turn_start/end', () => {
    // Those mark model round-trips: the fixture holds four of each across two user exchanges. Reading
    // them as turns would report four turns and close the first while tools were still running.
    const turnMarkers = LINES.filter((l) => /"assistant\.turn_(start|end)"/.test(l))
    expect(turnMarkers.length).toBeGreaterThan(4)
    expect(live().filter((e) => e.type === 'turn_started')).toHaveLength(2)
  })

  it('pairs tools by their real toolCallId, leaving no row open', () => {
    const events = live()
    const starts = events.filter((e) => e.type === 'tool_start') as Array<Extract<LiveEvent, { type: 'tool_start' }>>
    const ends = events.filter((e) => e.type === 'tool_end') as Array<Extract<LiveEvent, { type: 'tool_end' }>>
    expect(starts.length).toBeGreaterThan(1)
    expect(ends.map((e) => e.payload.id).sort()).toEqual(starts.map((e) => e.payload.id).sort())
    // Two tools were launched in one message and completed out of band — position would not pair them.
    expect(starts.map((e) => e.payload.id)).toEqual(expect.arrayContaining([starts[0].payload.id]))
  })

  it('maps the measured tool names onto the shared vocabulary', () => {
    const events = live()
    const tools = new Set(events.filter((e) => e.type === 'tool_start').map((e) => (e as Extract<LiveEvent, { type: 'tool_start' }>).payload.tool))
    expect(tools.has('Bash')).toBe(true)
    expect(tools.has('Write')).toBe(true)
  })

  it('shows the prompt the user typed, not the transformed one', () => {
    const events = live()
    const first = events.find((e) => e.type === 'user_message') as Extract<LiveEvent, { type: 'user_message' }>
    expect(first.payload.content).not.toContain('<current_datetime>')
    expect(first.payload.content).not.toContain('system_reminder')
  })

  it('renders no card for Copilot bookkeeping or for our own hooks', () => {
    const events = live()
    const text = JSON.stringify(events)
    expect(text).not.toContain('usage_checkpoint')
    expect(text).not.toContain('auto_mode_resolved')
    expect(text).not.toContain('hook.start')
  })

  it('replay emits no lifecycle frames and terminates with done', () => {
    const events: LiveEvent[] = copilotMessagesToEvents(LINES)
    expect(events.some((e) => e.type === 'turn_started')).toBe(false)
    expect(events.some((e) => e.type === 'turn_ended')).toBe(false)
    expect(events[0].type).toBe('user_message')
    expect(events[events.length - 1]).toEqual({ type: 'done', payload: { result: 'success' } })
  })

  it('lastCopilotTurnText returns the final exchange as the recap source', () => {
    const last = lastCopilotTurnText(LINES)
    expect(last).not.toBeNull()
    expect(last!.assistantText.length).toBeGreaterThan(0)
  })

  it('reads the resolved model, not the "auto" placeholder', () => {
    // `session.model_change` says `auto`; each assistant message names what auto actually chose.
    expect(copilotSessionModel(LINES)).not.toBe('auto')
    expect(copilotSessionModel(LINES)).toBeTruthy()
  })

  it('is inert on malformed input', () => {
    const normalizer = new CopilotNormalizer()
    expect(normalizer.ingest('not json')).toEqual([])
    expect(normalizer.ingest('{}')).toEqual([])
    expect(copilotEvent('{"data":{}}')).toBeNull()
  })
})

describe('a turn the user interrupted with Esc', () => {
  // Copied off a live session (Copilot CLI 1.0.83, 2026-09-09). This is the ONLY record Copilot
  // writes for a cancel: the `agentStop` hook — this engine's only other turn boundary — never
  // fires, so before `abort` was read the turn stayed open for the rest of the session. `cli.ts`
  // heartbeats every 5s while `turnOpen`, so every client watching turn state believed the agent
  // was still working, and the desktop's model picker (which disables itself mid-turn) stayed
  // disabled from the first cancel until the next prompt.
  const prompt = JSON.stringify({ type: 'user.message', data: { content: 'mcp grid web có chưa' }, id: 'u1', parentId: '' })
  const toolStart = JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'bash' }, id: 'e1', parentId: '' })
  const abort = JSON.stringify({ type: 'abort', data: { reason: 'user_abort' }, id: 'a1', parentId: '' })

  const ingestAll = (lines: readonly string[]) => {
    const normalizer = new CopilotNormalizer()
    const events: LiveEvent[] = []
    for (const line of lines) events.push(...normalizer.ingest(line))
    return { normalizer, events }
  }

  it('ends the turn, and says it was cut short', () => {
    const { events } = ingestAll([prompt, abort])
    const ended = events.filter((e) => e.type === 'turn_ended')
    expect(ended).toHaveLength(1)
    // Not a plain close: a turn the user stopped did not produce the answer a finished one did, and
    // this flag is what the log line and a device recap read.
    expect(ended[0].payload).toEqual({ aborted: true })
  })

  it('stops reporting the turn as open, which is what kept the heartbeat alive', () => {
    const { normalizer } = ingestAll([prompt])
    expect(normalizer.turnOpen).toBe(true)
    const after = new CopilotNormalizer()
    for (const line of [prompt, abort]) after.ingest(line)
    expect(after.turnOpen).toBe(false)
  })

  it('closes a running tool as interrupted rather than failed', () => {
    // Nothing went wrong with it — it was stopped. `isError` is what draws the card red, and a
    // cancel the user asked for is not an error to show them.
    const { events } = ingestAll([prompt, toolStart, abort])
    const end = events.find((e) => e.type === 'tool_end')
    expect(end?.payload).toMatchObject({ id: 't1', tool: 'Bash', isError: false })
    expect(end?.payload.output).toContain('interrupted')
  })

  it('is inert when no turn is open', () => {
    // A second Esc, or one pressed at an idle prompt. Emitting a turn_ended here would close a turn
    // that does not exist and leave every client one end ahead of its starts.
    expect(ingestAll([abort]).events).toEqual([])
    expect(ingestAll([prompt, abort, abort]).events.filter((e) => e.type === 'turn_ended')).toHaveLength(1)
  })

  it('emits no lifecycle frame in replay, like every other opener and closer here', () => {
    const replayed: LiveEvent[] = copilotMessagesToEvents([prompt, abort])
    expect(replayed.some((e) => e.type === 'turn_started')).toBe(false)
    expect(replayed.some((e) => e.type === 'turn_ended')).toBe(false)
  })

  it('does not resume a session that ended in a cancel as still running', () => {
    // Esc during a model round-trip leaves the last `assistant.turn_start` unmatched, so reading
    // ends off `assistant.turn_end` alone brings the session back mid-turn — and nothing is coming
    // to close it, because the process that would have is gone.
    const roundTrip = JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' }, id: 'r1', parentId: '' })
    expect(copilotHistoryTurnOpen([prompt, roundTrip])).toBe(true)
    expect(copilotHistoryTurnOpen([prompt, roundTrip, abort])).toBe(false)
  })
})

describe('copilot tool names', () => {
  it('maps what was measured and title-cases the rest', () => {
    expect(copilotToolName('bash')).toBe('Bash')
    expect(copilotToolName('create')).toBe('Write')
    expect(copilotToolName('view')).toBe('Read')
    // `sql` is Copilot's todo mechanism AND its general query tool; it must not become TodoWrite.
    expect(copilotToolName('sql')).toBe('Sql')
    expect(copilotToolName('some_future_tool')).toBe('Some Future Tool')
  })
})

describe('resuming a finished conversation', () => {
  it('does not report the last turn as still running', () => {
    // `copilot --resume` folds this whole file at attach. The fold opens a turn on the last
    // `user.message` and nothing closes it — the agentStop hook only fires for a NEW turn — so the
    // device sat on "busy loading" for a conversation that had already finished.
    const normalizer = new CopilotNormalizer()
    for (const line of LINES) normalizer.ingest(line)
    expect(normalizer.turnOpen).toBe(true)                 // what the fold alone believes
    expect(copilotHistoryTurnOpen(LINES)).toBe(false)      // what the records actually say
  })

  it('still reports a genuinely unfinished exchange as open', () => {
    const upToFirstPrompt: string[] = []
    for (const line of LINES) {
      upToFirstPrompt.push(line)
      if (copilotEvent(line)?.type === 'user.message') break
    }
    expect(copilotHistoryTurnOpen(upToFirstPrompt)).toBe(true)
  })

  it('treats a session that shut down as closed', () => {
    expect(copilotHistoryTurnOpen([...LINES, JSON.stringify({ type: 'session.shutdown', data: {} })])).toBe(false)
  })
})

describe('the session a Copilot process is in', () => {
  it('picks the NEWEST lock: /resume adds one without releasing the old', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { copilotSessionForPid } = await import('./session.js')

    const home = mkdtempSync(join(tmpdir(), 'copilot-home-'))
    const started = '11111111-1111-4111-8111-111111111111'
    const resumed = '22222222-2222-4222-8222-222222222222'
    for (const id of [started, resumed]) {
      mkdirSync(join(home, 'session-state', id), { recursive: true })
      writeFileSync(join(home, 'session-state', id, 'inuse.4242.lock'), '')
    }
    // measured on a real pid: both locks survive, so recency is what distinguishes them
    utimesSync(join(home, 'session-state', started, 'inuse.4242.lock'), new Date(1000), new Date(1000))
    utimesSync(join(home, 'session-state', resumed, 'inuse.4242.lock'), new Date(9000), new Date(9000))

    expect(await copilotSessionForPid(home, 4242)).toBe(resumed)
    expect(await copilotSessionForPid(home, 9999)).toBeNull()   // another process holds nothing here
  })
})

describe('the ask-user dialog', () => {
  it('maps the tool to the exact shared name', () => {
    // Anything else and it renders in the tool feed instead of as a question the device can answer.
    expect(copilotToolName('ask_user')).toBe('AskUserQuestion')
  })

  it('is read off a real pane once the box is peeled', async () => {
    const { parseEngineQuestionPane, parseQuestionPane } = await import('../../lib/askQuestion.js')
    const capture = readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/question-copilot.txt', import.meta.url)), 'utf8')
    expect(parseQuestionPane(capture)).toBeNull()          // the frame defeats the shared parser
    const view = parseEngineQuestionPane('copilot', capture)
    expect(view).not.toBeNull()
    const question = view as Extract<typeof view, { kind: 'question' }>
    expect(question.question).toBe('Which colour do you prefer?')
    expect(question.rows.map((r) => r.label)).toEqual(['Red', 'Green', 'Blue'])
    // "Other (type your answer)" is a free-text row: the device has no text input, so it must not be
    // offered as a choice.
    expect(question.typeRow?.label).toContain('Other')
  })
})

describe('the permission prompt', () => {
  const capture = () => readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/permission-copilot.txt', import.meta.url)), 'utf8')

  it('names what is being approved, not just "allow this access?"', async () => {
    const { parseEngineQuestionPane } = await import('../../lib/askQuestion.js')
    const view = parseEngineQuestionPane('copilot', capture())
    const question = view as Extract<typeof view, { kind: 'question' }>
    expect(question.question).toContain('Do you want to allow this access?')
    // Row 1 is a bare "Yes": without the subject the device offers a choice nobody can judge.
    expect(question.question).toContain('https://example.com')
  })

  it('keeps a way to say NO', async () => {
    const { parseEngineQuestionPane } = await import('../../lib/askQuestion.js')
    const view = parseEngineQuestionPane('copilot', capture())
    const question = view as Extract<typeof view, { kind: 'question' }>
    // Three ways to approve and none to refuse means the prompt cannot be answered at all.
    expect(question.rows.some((r) => /^No\b/i.test(r.label))).toBe(true)
    expect(question.rows).toHaveLength(4)
  })
})
