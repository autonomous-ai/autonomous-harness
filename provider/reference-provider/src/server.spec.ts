// The reference provider IS the executable reading of the spec, so these tests are written as clause
// checks: each name states the HP-xxx it pins. When the spec changes, these are the first thing that
// should go red.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Read at module load in server.ts — must be set before the import below.
process.env.STEP_DELAY_MS = '0'
const { start } = await import('./server.js')
const { resetIds } = await import('./store.js')
const { TaskState } = await import('./types.js')

let base: string
let stop: () => Promise<void>

beforeAll(async () => {
  const s = await start(0)
  base = s.url
  stop = s.close
})
afterAll(async () => { await stop() })
beforeEach(() => { resetIds() })

const KEY = 'test-key'

interface SseEvent { taskId: string; contextId: string; status: { state: string; message?: { parts: Array<{ text?: string; metadata?: Record<string, unknown> }> } }; final?: boolean }

async function rpc(method: string, params: unknown, key: string = KEY): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** `Response.json()` is typed `unknown` under strict mode; these are test fixtures, so assert once here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json()

/** Drains an SSE response into parsed events. Returns whatever arrived, even on an aborted stream. */
async function drain(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  if (!res.body) return events
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (line) events.push(JSON.parse(line.slice(6)) as SseEvent)
      }
    }
  } catch { /* an aborted stream is a valid outcome here — see the `die` test */ }
  return events
}

const userMessage = (text: string, extra: Record<string, unknown> = {}): unknown => ({
  message: { role: 'ROLE_USER', messageId: 'm-user', parts: [{ text }], ...extra },
})

const send = async (text: string, extra: Record<string, unknown> = {}): Promise<SseEvent[]> =>
  drain(await rpc('SendStreamingMessage', userMessage(text, extra)))

const kinds = (events: SseEvent[]): string[] =>
  events.flatMap((e) => e.status.message?.parts.map((p) => p.metadata?.['autonomous.ai/kind'] as string) ?? []).filter(Boolean)

describe('agent card (HP-020 … HP-023)', () => {
  it('is served unauthenticated at the well-known path', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`)
    expect(res.status).toBe(200)
    const card = await json(res)
    expect(card.name).toBeTruthy()
    expect(card.securitySchemes.apiKey).toBeTruthy()
  })

  it('declares streaming, which HP-021 makes mandatory', async () => {
    const card = await json(await fetch(`${base}/.well-known/agent-card.json`))
    expect(card.capabilities.streaming).toBe(true)
  })

  it('exposes skills as the agent list and declares its extensions by exact URI', async () => {
    const card = await json(await fetch(`${base}/.well-known/agent-card.json`))
    expect(card.skills.length).toBeGreaterThan(0)
    expect(card.extensions.map((e: { uri: string }) => e.uri)).toContain('https://harness.autonomous.ai/api/a2a/ext/session-recap')
    // Undeclared extensions must read as absent — the reference provider leaves these out on purpose.
    expect(card.extensions.map((e: { uri: string }) => e.uri)).not.toContain('https://harness.autonomous.ai/api/a2a/ext/workspace-files')
  })
})

describe('authentication (HP-011 … HP-013)', () => {
  it('rejects a missing credential with 401, not a generic failure', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
    })
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe(-32001)
  })

  it('rejects the known-bad credential distinguishably from an outage', async () => {
    const res = await rpc('ListTasks', {}, 'bad-key')
    expect(res.status).toBe(401)
  })
})

describe('streaming a turn (HP-100 … HP-105)', () => {
  it('opens with WORKING and closes with a terminal state marked final', async () => {
    const events = await send('did acme blow through budget?')
    expect(events[0]!.status.state).toBe(TaskState.WORKING)
    const last = events[events.length - 1]!
    expect(last.status.state).toBe(TaskState.COMPLETED)
    expect(last.final).toBe(true)
  })

  it('carries thinking, tool and text kinds in Part.metadata', async () => {
    const seen = kinds(await send('check pacing'))
    expect(seen).toContain('thinking_delta')
    expect(seen).toContain('thinking_title')
    expect(seen).toContain('tool_start')
    expect(seen).toContain('tool_end')
    expect(seen).toContain('text_delta')
  })

  it('correlates tool_start and tool_end by the same toolCallId', async () => {
    const events = await send('check pacing')
    const ids = events
      .flatMap((e) => e.status.message?.parts ?? [])
      .filter((p) => ['tool_start', 'tool_end'].includes(p.metadata?.['autonomous.ai/kind'] as string))
      .map((p) => p.metadata?.['autonomous.ai/toolCallId'])
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('a provider emitting NO metadata is still conformant (HP-211)', async () => {
    const events = await send('plain please')
    expect(kinds(events)).toHaveLength(0)
    expect(events[events.length - 1]!.status.state).toBe(TaskState.COMPLETED)
    const text = events.flatMap((e) => e.status.message?.parts.map((p) => p.text) ?? []).join('')
    expect(text).toContain('Plain text')
  })

  it('reports FAILED after already emitting output, rather than going silent', async () => {
    const events = await send('make this fail')
    expect(kinds(events)).toContain('text_delta')
    expect(events[events.length - 1]!.status.state).toBe(TaskState.FAILED)
  })

  it('refuses image attachments loudly instead of discarding them (HP-106)', async () => {
    const events = await send('look at this', {
      parts: [{ text: 'look at this' }, { raw: 'aGk=', mediaType: 'image/png' }],
    })
    const last = events[events.length - 1]!
    expect(last.status.state).toBe(TaskState.FAILED)
    expect(last.status.message?.parts[0]?.text).toMatch(/image/i)
  })
})

describe('input required (HP-104)', () => {
  it('pauses in INPUT_REQUIRED and resumes when answered on the same taskId', async () => {
    const first = await send('ask me something')
    const pause = first[first.length - 1]!
    expect(pause.status.state).toBe(TaskState.INPUT_REQUIRED)
    expect(pause.final).toBeFalsy() // INPUT_REQUIRED is not terminal

    const resumed = await drain(
      await rpc('SendStreamingMessage', {
        message: { role: 'ROLE_USER', messageId: 'm-answer', taskId: pause.taskId, parts: [{ text: 'the acme one' }] },
      }),
    )
    expect(resumed[resumed.length - 1]!.status.state).toBe(TaskState.COMPLETED)
    expect(resumed[0]!.taskId).toBe(pause.taskId)
  })

  it('refuses a message aimed at an already-terminal task', async () => {
    const done = await send('plain')
    const res = await rpc('SendStreamingMessage', {
      message: { role: 'ROLE_USER', messageId: 'm-late', taskId: done[0]!.taskId, parts: [{ text: 'more' }] },
    })
    expect((await json(res)).error.message).toMatch(/terminal/i)
  })
})

describe('cancellation (HP-103)', () => {
  it('cancels an in-flight task and reports CANCELED', async () => {
    const started = await send('ask me something') // parks in INPUT_REQUIRED, so still cancelable
    const taskId = started[0]!.taskId
    const res = await rpc('CancelTask', { taskId })
    expect((await json(res)).result.status.state).toBe(TaskState.CANCELED)
  })

  it('refuses to cancel a task that already finished', async () => {
    const done = await send('plain')
    const res = await rpc('CancelTask', { taskId: done[0]!.taskId })
    expect((await json(res)).error.code).toBe(-32003)
  })

  it('reports an unknown task as not found, not as not-cancelable', async () => {
    const res = await rpc('CancelTask', { taskId: 'task-does-not-exist' })
    expect((await json(res)).error.code).toBe(-32002)
  })
})

describe('history (HP-200 … HP-202)', () => {
  it('GetTask returns the whole transcript in one response', async () => {
    const events = await send('check pacing')
    const res = await rpc('GetTask', { taskId: events[0]!.taskId })
    const task = (await json(res)).result
    expect(task.history.length).toBeGreaterThan(1)
    expect(task.status.state).toBe(TaskState.COMPLETED)
  })

  it('derives a session title from the first user message', async () => {
    const events = await send('did acme blow through budget?')
    const task = (await json(await rpc('GetTask', { taskId: events[0]!.taskId }))).result
    expect(task.metadata.title).toContain('acme')
  })

  it('ListTasks groups several turns under one contextId', async () => {
    const a = await send('first question', { contextId: 'ctx-shared' })
    await send('second question', { contextId: 'ctx-shared' })
    await send('unrelated', { contextId: 'ctx-other' })

    const listed = (await json(await rpc('ListTasks', { contextId: 'ctx-shared' }))).result.tasks
    expect(listed).toHaveLength(2)
    expect(listed.every((t: { contextId: string }) => t.contextId === 'ctx-shared')).toBe(true)
    expect(listed.map((t: { id: string }) => t.id)).toContain(a[0]!.taskId)
  })

  it('reports an unknown task rather than an empty one', async () => {
    const res = await rpc('GetTask', { taskId: 'nope' })
    expect((await json(res)).error.code).toBe(-32002)
  })
})

describe('hostile: a stream that dies without a terminal state', () => {
  it('violates HP-102 on purpose, so the client can be hardened against it', async () => {
    const events = await send('die now')
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]!
    expect(last.final).toBeFalsy()
    expect([TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED]).not.toContain(last.status.state)
  })
})

describe('protocol errors', () => {
  it('rejects an unknown method', async () => {
    const res = await rpc('NoSuchMethod', {})
    expect((await json(res)).error.code).toBe(-32601)
  })

  it('rejects a malformed body', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: '{ not json',
    })
    expect((await json(res)).error.code).toBe(-32700)
  })
})
