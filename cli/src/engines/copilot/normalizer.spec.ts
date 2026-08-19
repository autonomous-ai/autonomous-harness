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
