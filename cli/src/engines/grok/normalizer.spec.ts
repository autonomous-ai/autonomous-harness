import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  GrokNormalizer,
  grokMessagesToEvents,
  grokRecord,
  grokToolInput,
  grokToolName,
  lastGrokTurnText,
} from './normalizer.js'

/** Real Grok 1.0.0 session; only the scratch cwd was scrubbed. */
function lines(): string[] {
  const path = fileURLToPath(new URL('../../lib/__fixtures__/grok-session.jsonl', import.meta.url))
  return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim())
}

function liveEvents() {
  const normalizer = new GrokNormalizer()
  return lines().flatMap((line) => normalizer.ingest(line))
}

describe('grok normalizer', () => {
  it('derives exactly one complete turn from the real session', () => {
    const normalizer = new GrokNormalizer()
    const events = lines().flatMap((line) => normalizer.ingest(line))
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn_ended')).toHaveLength(1)
    expect(normalizer.turnOpen).toBe(false)
    expect(events.find((event) => event.type === 'turn_started')).toMatchObject({
      payload: { userMessage: expect.stringContaining('spawn exactly one explore subagent') },
    })
  })

  it('maps the measured todo shape to the exact shared name and fields', () => {
    const events = liveEvents()
    const todo = events.find((event) => event.type === 'tool_start' && event.payload.tool === 'TodoWrite')
    expect(todo).toMatchObject({
      payload: {
        input: {
          todos: [
            { content: 'inspect colors', status: 'in_progress' },
            { content: 'report result', status: 'pending' },
          ],
        },
      },
    })
  })

  it('keeps the Task row open until the measured subagent_finished record', () => {
    const normalizer = new GrokNormalizer()
    const events = lines().flatMap((line) => normalizer.ingest(line))
    const taskStart = events.find((event) => event.type === 'tool_start' && event.payload.tool === 'Task')
    const finished = events.find((event) => event.type === 'subagent_finished')
    expect(taskStart).toMatchObject({ payload: { input: { description: 'Count colors.txt lines' } } })
    expect(finished).toMatchObject({
      payload: { id: taskStart && 'id' in taskStart.payload ? taskStart.payload.id : '', status: 'completed' },
    })
    expect(events.indexOf(finished!)).toBeLessThan(events.findIndex((event) => event.type === 'turn_ended'))
  })

  it('pairs every measured tool card and maps the wait tool independently', () => {
    const events = liveEvents()
    const starts = events.filter((event) => event.type === 'tool_start')
    const ends = events.filter((event) => event.type === 'tool_end')
    expect(starts).toHaveLength(4)
    expect(ends).toHaveLength(4)
    expect(starts.some((event) => event.payload.tool === 'TaskWait')).toBe(true)
    for (const start of starts) {
      expect(ends.some((end) => end.payload.id === start.payload.id)).toBe(true)
    }
  })

  it('emits reasoning and the final assistant answer', () => {
    const events = liveEvents()
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(true)
    const text = events.filter((event) => event.type === 'text_delta')
      .map((event) => event.payload.content).join('\n')
    expect(text).toContain('Line count:')
    expect(text).toContain('get_command_or_subagent_output')
  })

  it('replays history without live lifecycle frames', () => {
    const events = grokMessagesToEvents(lines())
    expect(events[0]).toMatchObject({ type: 'user_message' })
    expect(events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(events.map((event) => event.type)).not.toContain('turn_started')
    expect(events.map((event) => event.type)).not.toContain('turn_ended')
  })

  it('reads the real last turn for recap', () => {
    const last = lastGrokTurnText(lines())
    expect(last?.userMessage).toContain('todo tool')
    expect(last?.assistantText).toContain('Line count:')
  })

  it('ignores malformed and non-update records', () => {
    expect(grokRecord('bad json')).toBeNull()
    expect(grokRecord('{"method":"session/update"}')).toBeNull()
    expect(new GrokNormalizer().ingest('{}')).toEqual([])
  })
})

describe('grok measured mappings', () => {
  it('uses the shared names needed by product surfaces', () => {
    expect(grokToolName('read_file')).toBe('Read')
    expect(grokToolName('todo_write')).toBe('TodoWrite')
    expect(grokToolName('spawn_subagent')).toBe('Task')
    expect(grokToolName('get_command_or_subagent_output')).toBe('TaskWait')
    expect(grokToolName('ask_user_question')).toBe('AskUserQuestion')
    expect(grokToolName('unmeasured_tool')).toBe('Unmeasured Tool')
  })

  it('gives Read the file_path field shared cards consume', () => {
    expect(grokToolInput('Read', { target_file: '/workspace/colors.txt' })).toEqual({
      target_file: '/workspace/colors.txt',
      file_path: '/workspace/colors.txt',
    })
  })
})
