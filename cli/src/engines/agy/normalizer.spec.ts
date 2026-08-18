import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AgyNormalizer,
  agyMessagesToEvents,
  agyStep,
  agyToolInput,
  agyToolName,
  agyUserText,
  lastAgyTurnText,
} from './normalizer.js'
import type { LiveEvent } from '../../lib/normalize.js'

const FIXTURE = fileURLToPath(new URL('../../lib/__fixtures__/agy-session.jsonl', import.meta.url))
const LINES = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)

function live(): LiveEvent[] {
  const normalizer = new AgyNormalizer()
  const events: LiveEvent[] = []
  for (const line of LINES) events.push(...normalizer.ingest(line))
  events.push(...normalizer.closeTurn())
  return events
}

describe('agy normalizer, over a real recorded session', () => {
  it('opens a turn on every user input and closes the last one on the Stop hook', () => {
    const events = live()
    const started = events.filter((e) => e.type === 'turn_started')
    const ended = events.filter((e) => e.type === 'turn_ended')
    // Four USER_INPUT steps: three of them close the turn before them, the Stop hook closes the last.
    expect(started).toHaveLength(4)
    expect(ended).toHaveLength(4)
    expect(events[events.length - 1].type).toBe('turn_ended')
  })

  it('leaves no tool row open — every start has exactly one matching end', () => {
    const events = live()
    const starts = events.filter((e) => e.type === 'tool_start') as Array<Extract<LiveEvent, { type: 'tool_start' }>>
    const ends = events.filter((e) => e.type === 'tool_end') as Array<Extract<LiveEvent, { type: 'tool_end' }>>
    expect(starts.length).toBeGreaterThan(0)
    expect(ends).toHaveLength(starts.length)
    expect(ends.map((e) => e.payload.id).sort()).toEqual(starts.map((e) => e.payload.id).sort())
  })

  it('pairs results positionally, not by name — list_dir answers as LIST_DIRECTORY', () => {
    const events = live()
    const listStart = events.find((e) => e.type === 'tool_start' && e.payload.tool === 'ListDir')
    expect(listStart).toBeDefined()
    const id = (listStart as Extract<LiveEvent, { type: 'tool_start' }>).payload.id
    const listEnd = events.find((e) => e.type === 'tool_end' && e.payload.id === id)
    expect(listEnd).toBeDefined()
    expect((listEnd as Extract<LiveEvent, { type: 'tool_end' }>).payload.isError).toBe(false)
  })

  it('marks an ERROR_MESSAGE result as a failed tool', () => {
    const events = live()
    const failed = events.filter((e) => e.type === 'tool_end' && e.payload.isError)
    expect(failed.length).toBeGreaterThan(0)
  })

  it('a backgrounded RUNNING result still closes its row and never holds the turn open', () => {
    const normalizer = new AgyNormalizer()
    for (const line of LINES) {
      const step = agyStep(line)
      normalizer.ingest(line)
      // The RUNNING background-task step is a result, so it must not leave the turn un-closable.
      if (step?.status === 'RUNNING') expect(normalizer.turnOpen).toBe(true)
    }
    expect(normalizer.closeTurn().some((e) => e.type === 'turn_ended')).toBe(true)
    expect(normalizer.turnOpen).toBe(false)
  })

  it('renders NOTHING for the routine checkpoint every conversation carries', () => {
    const normalizer = new AgyNormalizer()
    const checkpoint = LINES.find((line) => agyStep(line)?.type === 'CHECKPOINT')!
    // Its body claims the conversation was truncated; it is a fixed template, and `{{ CHECKPOINT 0 }}`
    // appears in every agy conversation — including four-step ones. Rendering it put a
    // "Context compacted" banner under the first reply of every new agent.
    expect(agyStep(checkpoint)!.content).toContain('CHECKPOINT 0')
    expect(agyStep(checkpoint)!.content).toContain('have been truncated')
    normalizer.ingest(LINES[0])
    expect(normalizer.turnOpen).toBe(true)
    expect(normalizer.ingest(checkpoint)).toEqual([])
    expect(normalizer.turnOpen).toBe(true)
  })

  it('treats a higher checkpoint counter as a compaction, without touching turn state', () => {
    const normalizer = new AgyNormalizer()
    normalizer.ingest(LINES[0])
    const later = JSON.stringify({
      step_index: 99, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE',
      content: '{{ CHECKPOINT 1 }}\n **The earlier parts of this conversation have been truncated…',
    })
    const events = normalizer.ingest(later)
    expect(events).toEqual([{ type: 'context_compact', payload: { message: '', trigger: 'auto' } }])
    expect(normalizer.turnOpen).toBe(true)
  })

  it('closes a sub-agent row when the child reports back', () => {
    const events = live()
    const finished = events.filter((e) => e.type === 'subagent_finished')
    expect(finished).toHaveLength(1)
    const taskStart = events.find((e) => e.type === 'tool_start' && e.payload.tool === 'Task')
    expect((finished[0] as Extract<LiveEvent, { type: 'subagent_finished' }>).payload.id)
      .toBe((taskStart as Extract<LiveEvent, { type: 'tool_start' }>).payload.id)
  })

  it('summarises the sub-agent launch instead of dumping its JSON', () => {
    const events = live()
    const taskStart = events.find((e) => e.type === 'tool_start' && e.payload.tool === 'Task')!
    const id = (taskStart as Extract<LiveEvent, { type: 'tool_start' }>).payload.id
    const end = events.find((e) => e.type === 'tool_end' && e.payload.id === id) as Extract<LiveEvent, { type: 'tool_end' }>
    // The raw result is a wall of conversationIds, file:// transcript URIs and workspace lists.
    expect(end.payload.output).toMatch(/^Launched \d+ sub-agents?/)
    expect(end.payload.output).not.toContain('logAbsoluteUri')
    expect(end.payload.output).not.toContain('file://')
  })

  it('reports ONE finish for a call that spawned several children', () => {
    // agy launches N sub-agents from a single `invoke_subagent`, so N report-backs share one row.
    // Measured on a real three-agent run: firing per child produced three `subagent_finished` for the
    // same id, on a row `tool_end` had already closed.
    const normalizer = new AgyNormalizer()
    const children = ['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444']
    const step = (o: Record<string, unknown>) => JSON.stringify({ step_index: 1, source: 'MODEL', status: 'DONE', ...o })
    normalizer.ingest(step({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'go' }))
    normalizer.ingest(step({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'invoke_subagent', args: {} }] }))
    normalizer.ingest(step({
      type: 'INVOKE_SUBAGENT',
      content: `Created the following subagents:\n${children.map((c) => `{ "conversationId": "${c}" }`).join('\n')}`,
    }))
    const first = normalizer.ingest(step({ type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: `[Message] sender=${children[0]} content=btc done` }))
    expect(first.filter((e) => e.type === 'subagent_finished')).toHaveLength(0)   // one still running
    const second = normalizer.ingest(step({ type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: `[Message] sender=${children[1]} content=eth done` }))
    expect(second.filter((e) => e.type === 'subagent_finished')).toHaveLength(1)  // now the row is done
  })

  it('maps ask_question to the shared AskUserQuestion name with its structured options', () => {
    const events = live()
    const ask = events.find((e) => e.type === 'tool_start' && e.payload.tool === 'AskUserQuestion')
    expect(ask).toBeDefined()
    const input = (ask as Extract<LiveEvent, { type: 'tool_start' }>).payload.input as Record<string, unknown>
    const questions = input.questions as Array<{ question: string; options: string[] }>
    expect(questions[0].options.length).toBeGreaterThan(1)
  })

  it('strips the <USER_REQUEST> wrapper and the metadata block', () => {
    const events = live()
    const first = events.find((e) => e.type === 'user_message') as Extract<LiveEvent, { type: 'user_message' }>
    expect(first.payload.content).not.toContain('<USER_REQUEST>')
    expect(first.payload.content).not.toContain('ADDITIONAL_METADATA')
  })

  it('replay emits no lifecycle frames and terminates with done', () => {
    const events: LiveEvent[] = agyMessagesToEvents(LINES)
    expect(events.some((e) => e.type === 'turn_started')).toBe(false)
    expect(events.some((e) => e.type === 'turn_ended')).toBe(false)
    expect(events[0].type).toBe('user_message')
    expect(events[events.length - 1]).toEqual({ type: 'done', payload: { result: 'success' } })
  })

  it('lastAgyTurnText returns the final exchange as the recap source', () => {
    const last = lastAgyTurnText(LINES)
    expect(last).not.toBeNull()
    expect(last!.assistantText.length).toBeGreaterThan(0)
  })

  it('is inert on malformed input', () => {
    const normalizer = new AgyNormalizer()
    expect(normalizer.ingest('not json')).toEqual([])
    expect(normalizer.ingest('{}')).toEqual([])
    expect(normalizer.ingest('[]')).toEqual([])
    expect(agyStep('{"step_index":1}')).toBeNull()
  })
})

describe('agy pure mappings', () => {
  it('maps measured tool names and title-cases the rest', () => {
    expect(agyToolName('run_command')).toBe('Bash')
    expect(agyToolName('ask_question')).toBe('AskUserQuestion')
    expect(agyToolName('invoke_subagent')).toBe('Task')
    expect(agyToolName('some_future_tool')).toBe('Some Future Tool')
  })

  it('reshapes arguments onto the keys the shared cards read, keeping the originals', () => {
    const bash = agyToolInput('Bash', { CommandLine: 'pwd', Cwd: '/tmp' })
    expect(bash.command).toBe('pwd')
    expect(bash.CommandLine).toBe('pwd')
    expect(agyToolInput('Grep', { Query: 'test' }).pattern).toBe('test')
  })

  it('unwraps the user request', () => {
    expect(agyUserText('<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>')).toBe('hello')
    expect(agyUserText('bare text')).toBe('bare text')
  })
})
