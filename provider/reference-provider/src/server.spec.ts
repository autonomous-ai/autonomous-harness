// The reference provider IS the executable reading of the spec, so each test names the rule it pins.
// When the spec changes, these are the first thing that should go red.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Read at module load in server.ts — must be set before the import below.
process.env.STEP_DELAY_MS = '0'
const { start } = await import('./server.js')

let base: string
let stop: () => Promise<void>

beforeAll(async () => {
  const s = await start(0)
  base = s.url
  stop = s.close
})
afterAll(async () => { await stop() })

const KEY = 'test-key'
let seq = 0
const turnId = (): string => `t-${++seq}`

interface Event { kind?: string; [field: string]: unknown }

async function rpc(method: string, params: unknown, key: string = KEY): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** `Response.json()` is typed `unknown` under strict mode; these are test fixtures, so assert once here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json()

/** Drains an SSE response into parsed events. Returns whatever arrived, even on an aborted stream. */
async function drain(res: Response): Promise<Event[]> {
  const events: Event[] = []
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
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (line) events.push(JSON.parse(line.slice(5).trim()) as Event)
      }
    }
  } catch { /* an aborted stream is a valid outcome here — see the `die` test */ }
  return events
}

const send = async (text: string, extra: Record<string, unknown> = {}): Promise<Event[]> =>
  drain(await rpc('agent.send', { agentId: 'alpha', turnId: turnId(), message: { text }, ...extra }))

const kinds = (events: Event[]): string[] => events.map((e) => e.kind ?? '(none)')
const TERMINAL = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required']

describe('there is nothing to discover', () => {
  it('serves no descriptor — one URL, one credential header, eight methods', async () => {
    // The endpoint that used to exist is gone rather than deprecated: a client that still fetches it
    // must fail loudly at integration time, not read a stale document.
    expect((await fetch(`${base}/.well-known/autonomous-provider.json`)).status).toBe(404)
  })

  it('answers every method it defines, and refuses everything else', async () => {
    // Nothing is declared anywhere, so this list IS the surface. A method missing from it is a bug in
    // the provider, not an undeclared optional feature. Driven against a THROWAWAY agent, because the
    // loop really does rename and delete what it is pointed at.
    const scratch = (await json(await rpc('agent.create', { name: 'Surface Probe' }))).result.id
    const methods = ['agent.list', 'agent.send', 'agent.history', 'turn.cancel', 'agent.recap', 'agent.create', 'agent.rename', 'agent.delete']
    const unsupported: string[] = []
    for (const method of methods) {
      const name = method === 'agent.create' ? 'Surface Probe Two' : 'Surface Probe Renamed'
      const res = await rpc(method, { agentId: scratch, turnId: turnId(), name, message: { text: 'hi' } })
      if (res.headers.get('content-type')?.includes('text/event-stream')) { await drain(res); continue }
      if ((await json(res)).error?.code === 'unsupported') unsupported.push(method)
    }
    expect(unsupported).toEqual([])
    await rpc('agent.delete', { agentId: 'surface-probe-two' })
  })
})

describe('authentication', () => {
  it('rejects a missing credential with 401, not a generic failure', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.list', params: {} }),
    })
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthenticated')
  })

  it('rejects the known-bad credential distinguishably from an outage', async () => {
    const res = await rpc('agent.list', {}, 'bad-key')
    expect((await json(res)).error.code).toBe('unauthenticated')
  })
})

describe('agents', () => {
  it('lists agents on an authenticated call — two credentials may legitimately see two lists', async () => {
    const { result } = await json(await rpc('agent.list', {}))
    expect(result.agents.map((a: { id: string }) => a.id)).toEqual(['alpha', 'beta'])
  })

  it('refuses a send to an agent it does not have', async () => {
    const res = await rpc('agent.send', { agentId: 'ghost', turnId: turnId(), message: { text: 'hi' } })
    expect((await json(res)).error.code).toBe('not_found')
  })

  it('creates, renames and deletes — and a FRESHLY created agent can be sent to at once', async () => {
    // The trap this pins: an earlier version derived the set of valid ids once at module load, so an
    // agent created a moment ago was refused with `not_found` by its very next send.
    const created = (await json(await rpc('agent.create', { name: 'Fresh One', description: 'made in a test' }))).result
    expect(created.id).toBeTruthy()

    const events = await drain(await rpc('agent.send', { agentId: created.id, turnId: turnId(), message: { text: 'hello' } }))
    expect(events.at(-1)!.kind).toBe('turn_completed')

    const renamed = (await json(await rpc('agent.rename', { agentId: created.id, name: 'Renamed' }))).result
    expect(renamed).toMatchObject({ id: created.id, name: 'Renamed' })

    expect((await json(await rpc('agent.delete', { agentId: created.id }))).result.deleted).toBe(true)
    const after = (await json(await rpc('agent.list', {}))).result.agents.map((a: { id: string }) => a.id)
    expect(after).not.toContain(created.id)
  })

  it('refuses a mutation with a REASON rather than `unsupported`', async () => {
    // There is no capability to declare, so refusal has to carry the explanation itself — that message
    // is what the UI shows instead of a greyed-out button nobody can account for.
    const { error } = await json(await rpc('agent.rename', { agentId: 'ghost', name: 'x' }))
    expect(error.code).toBe('invalid_request')
    expect(error.message).toContain('ghost')
  })
})

describe('streaming a turn', () => {
  it('opens with turn_started and closes with exactly one terminal event', async () => {
    const events = await send('hello')
    expect(events[0]!.kind).toBe('turn_started')
    expect(events.filter((e) => TERMINAL.includes(e.kind ?? ''))).toHaveLength(1)
    expect(events.at(-1)!.kind).toBe('turn_completed')
  })

  it('carries thinking, tool and text kinds as first-class fields', async () => {
    const events = await send('hello')
    expect(kinds(events)).toEqual(expect.arrayContaining(['thinking_delta', 'thinking_title', 'tool_start', 'tool_end', 'text_delta', 'done']))
  })

  it('correlates tool_start and tool_end by the same toolId', async () => {
    const events = await send('hello')
    const startId = events.find((e) => e.kind === 'tool_start')!.toolId
    const endId = events.find((e) => e.kind === 'tool_end')!.toolId
    expect(startId).toBeTruthy()
    expect(endId).toBe(startId)
  })

  it('a provider emitting NO kind is still conformant', async () => {
    const events = await send('plain')
    const bare = events.find((e) => e.kind === undefined)
    expect(bare?.text).toBe('Plain text reply, no kind at all.')
  })

  it('reports turn_failed after already emitting output, rather than going silent', async () => {
    const events = await send('fail')
    expect(kinds(events)).toContain('text_delta')
    expect(events.at(-1)!.kind).toBe('turn_failed')
    expect((events.at(-1)!.error as { code: string }).code).toBe('internal')
  })

  it('brackets a pushed recap and persists it for the pull', async () => {
    const events = await send('recap')
    expect(kinds(events)).toEqual(expect.arrayContaining(['recap_start', 'recap_end']))
    const { result } = await json(await rpc('agent.recap', { agentId: 'alpha' }))
    // The SAME object the stream just pushed — one shape for a recap, however it is fetched.
    expect(result).toMatchObject({ agentId: 'alpha', recap: 'Rebuilt the index' })
    // The turnId is what lets a client tell THIS turn's recap from the previous one's.
    expect(typeof result.turnId).toBe('string')
  })
})

describe('the full event vocabulary', () => {
  it('emits every content kind in one turn', async () => {
    // From outside a provider, a kind nobody emitted is indistinguishable from a kind nobody supports.
    // This scenario exists so the vocabulary can be proven REACHABLE somewhere.
    const events = await send('everything')
    const seen = new Set(kinds(events))
    const streamed = ['turn_started', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end',
      'context_compact', 'text_delta', 'done', 'recap_start', 'recap_end', 'turn_completed']
    expect(streamed.filter((k) => !seen.has(k))).toEqual([])
  })

  it('carries user_message through history — the one kind that is never streamed', async () => {
    // The client already has the text it just sent, so echoing it back mid-stream would be noise. It
    // still belongs in the transcript, or a refresh shows one side of a conversation.
    await send('everything, twice over')
    const { result } = await json(await rpc('agent.history', { agentId: 'alpha' }))
    expect(result.events.some((e: Event) => e.kind === 'user_message' && e.text === 'everything, twice over')).toBe(true)
  })

  it('reaches the three terminal kinds a completed turn cannot', async () => {
    expect((await send('fail')).at(-1)!.kind).toBe('turn_failed')
    expect((await send('ask me')).at(-1)!.kind).toBe('turn_input_required')
    const id = turnId()
    await rpc('turn.cancel', { turnId: id })
    const cancelled = await drain(await rpc('agent.send', { agentId: 'alpha', turnId: id, message: { text: 'hello' } }))
    expect(cancelled.at(-1)!.kind).toBe('turn_cancelled')
  })
})

describe('input required', () => {
  it('ends the stream with turn_input_required and resumes on the same turnId', async () => {
    const id = turnId()
    const first = await drain(await rpc('agent.send', { agentId: 'alpha', turnId: id, message: { text: 'ask me' } }))
    const paused = first.at(-1)!
    expect(paused.kind).toBe('turn_input_required')
    expect(paused.prompt).toBeTruthy()

    const resumed = await drain(await rpc('agent.send', { agentId: 'alpha', turnId: id, resume: true, message: { text: 'Acme' } }))
    expect(resumed.at(-1)!.kind).toBe('turn_completed')
    expect(kinds(resumed)).toContain('text_delta')
  })
})

describe('cancellation', () => {
  it('is always accepted, even for a turn that does not exist yet', async () => {
    const { result } = await json(await rpc('turn.cancel', { turnId: 'never-started' }))
    expect(result.cancelled).toBe(true)
  })

  it('a cancel BEFORE the turn starts stops it — the point of a client-minted turnId', async () => {
    // Without this the client's whole reason for minting the id (being able to stop in the first
    // 200ms) is honoured by the API and ignored by the engine.
    const id = turnId()
    await rpc('turn.cancel', { turnId: id })
    const events = await drain(await rpc('agent.send', { agentId: 'alpha', turnId: id, message: { text: 'hello' } }))
    expect(events.filter((e) => TERMINAL.includes(e.kind ?? ''))).toHaveLength(1)
    expect(events.at(-1)!.kind).toBe('turn_cancelled')
  })

  it('refuses a cancel with no turnId rather than guessing which turn was meant', async () => {
    expect((await json(await rpc('turn.cancel', {}))).error.code).toBe('invalid_request')
  })
})

describe('history', () => {
  it('returns the SAME event objects the stream emitted', async () => {
    const live = (await send('plain')).filter((e) => !TERMINAL.includes(e.kind ?? '') && e.kind !== 'turn_started')
    const { result } = await json(await rpc('agent.history', { agentId: 'alpha' }))
    const tail = result.events.slice(-live.length)
    expect(tail).toEqual(live)
  })

  it('stores the user’s own message, so a refresh shows both sides', async () => {
    await send('a distinctive probe')
    const { result } = await json(await rpc('agent.history', { agentId: 'alpha' }))
    expect(result.events.some((e: Event) => e.kind === 'user_message' && e.text === 'a distinctive probe')).toBe(true)
  })

  it('never stores lifecycle or recap events — they are live-turn signals, not transcript', async () => {
    await send('recap')
    const { result } = await json(await rpc('agent.history', { agentId: 'alpha' }))
    const stored = new Set(result.events.map((e: Event) => e.kind))
    for (const k of [...TERMINAL, 'turn_started', 'recap_start', 'recap_end']) expect(stored.has(k)).toBe(false)
  })

  it('windows with limit and pages backwards with the returned cursor', async () => {
    await send('hello')
    const first = (await json(await rpc('agent.history', { agentId: 'alpha', limit: 1 }))).result
    expect(first.events).toHaveLength(1)
    expect(typeof first.nextBefore).toBe('string')

    const older = (await json(await rpc('agent.history', { agentId: 'alpha', limit: 1, before: first.nextBefore }))).result
    expect(older.events).toHaveLength(1)
    expect(older.events[0]).not.toEqual(first.events[0])
  })

  it('omits nextBefore once the start of the transcript is reached', async () => {
    // Its ABSENCE is how a client knows to stop paging; a cursor that always comes back never ends.
    const all = (await json(await rpc('agent.history', { agentId: 'beta' }))).result
    expect(all.nextBefore).toBeUndefined()
  })

  it('keeps each agent’s transcript separate', async () => {
    await drain(await rpc('agent.send', { agentId: 'beta', turnId: turnId(), message: { text: 'beta only' } }))
    const alpha = (await json(await rpc('agent.history', { agentId: 'alpha' }))).result
    expect(alpha.events.some((e: Event) => e.text === 'beta only')).toBe(false)
  })

  it('refuses an unknown agent rather than answering empty', async () => {
    expect((await json(await rpc('agent.history', { agentId: 'ghost' }))).error.code).toBe('not_found')
  })
})

describe('hostile: a stream that dies without a terminal event', () => {
  it('breaks the one-terminal rule on purpose, so the client can be hardened against it', async () => {
    const events = await send('die')
    expect(kinds(events)).toContain('text_delta')
    expect(events.filter((e) => TERMINAL.includes(e.kind ?? ''))).toHaveLength(0)
  })
})

describe('protocol errors', () => {
  it('rejects an unknown method', async () => {
    expect((await json(await rpc('nonsense.method', {}))).error.code).toBe('unsupported')
  })

  it('rejects a malformed body', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: '{not json',
    })
    expect((await json(res)).error.code).toBe('invalid_request')
  })

  it('ignores unknown request fields rather than failing', async () => {
    const { result } = await json(await rpc('agent.list', { fromALaterRevision: true }))
    expect(result.agents).toBeTruthy()
  })
})
