import { describe, expect, it } from 'vitest'
import type { LiveEvent, SessionEvent } from '../../lib/normalize.js'
import {
  CursorNormalizer,
  cursorMessagesToEvents,
  cursorTaskId,
  type CursorTaskHook,
} from './normalizer.js'
import { CursorTaskHookQueue } from './taskHookQueue.js'

const line = (value: unknown): string => JSON.stringify(value)
const user = (text: string): string => line({
  role: 'user',
  message: { content: [{ type: 'text', text: `<timestamp>now</timestamp>\n<user_query>\n${text}\n</user_query>` }] },
})
const assistant = (...content: unknown[]): string => line({ role: 'assistant', message: { content } })

function renderOrder(events: Array<LiveEvent | SessionEvent>): string[] {
  return events.flatMap((event) => {
    if (event.type === 'turn_started') return [`user:${event.payload.userMessage}`]
    if (event.type === 'user_message') return [`user:${event.payload.content}`]
    if (event.type === 'text_delta') return [`text:${event.payload.content}`]
    if (event.type === 'tool_start' && event.payload.tool === 'Task' && !event.payload.parentToolUseId) {
      const input = event.payload.input as { description?: string }
      return [`task:${input.description ?? ''}`]
    }
    return []
  })
}

describe('CursorTaskHookQueue', () => {
  it('makes live watcher order match transcript replay for parallel Task launches', async () => {
    const sessionId = 'session'
    const prompt = 'Run three reports in parallel'
    const inputs = ['BTC', 'ETH', 'BNB'].map((coin) => ({
      description: `Report ${coin}`,
      prompt: `Report price for ${coin}`,
      model: 'inherit',
    }))
    const transcript = [
      user(prompt),
      assistant({ type: 'text', text: 'Launching three agents.' }),
      ...inputs.map((input) => assistant({ type: 'tool_use', name: 'Task', input })),
    ]
    const normalizer = new CursorNormalizer('live', sessionId)
    const liveEvents: LiveEvent[] = []
    let transcriptDrained = false
    const registered: CursorTaskHook[] = []
    const queue = new CursorTaskHookQueue({
      drainTranscript: async () => {
        if (transcriptDrained) return
        transcriptDrained = true
        for (const raw of transcript) liveEvents.push(...normalizer.ingest(raw))
      },
      emit: (_id, events) => liveEvents.push(...events),
      register: (_id, hook) => registered.push(hook),
      isActive: () => true,
    })

    inputs.forEach((input, index) => {
      queue.enqueue(sessionId, { toolUseId: `call-${index + 1}`, input }, normalizer)
    })
    await queue.wait(sessionId)

    const replayEvents = cursorMessagesToEvents(
      transcript,
      sessionId,
      inputs.map((input, index) => ({
        toolUseId: `call-${index + 1}`,
        prompt: input.prompt,
        description: input.description,
        output: `${input.description} done`,
        isError: false,
      })),
    )

    expect(renderOrder(liveEvents)).toEqual(renderOrder(replayEvents))
    expect(renderOrder(liveEvents)).toEqual([
      `user:${prompt}`,
      'text:Launching three agents.',
      'task:Report BTC',
      'task:Report ETH',
      'task:Report BNB',
    ])
    expect(registered.map((hook) => cursorTaskId(sessionId, hook.toolUseId))).toEqual(
      [1, 2, 3].map((index) => cursorTaskId(sessionId, `call-${index}`)),
    )
  })
})
