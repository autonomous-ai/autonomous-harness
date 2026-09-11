// End-to-end for the provider path, against a REAL provider server over a real socket.
//
// Everything below the seam is genuine: HTTP, SSE framing, the SSRF-guarded client, the event
// mapper. Only the machine's surroundings (Mongo, Redis, billing) are stubbed, because the thing
// under test is the wire path, not the database.
//
// This exists because every unit test in this feature passed while the flow was still broken end to
// end — the web never even fetched a project list, since a provider machine reported itself offline.
// A test that speaks the actual protocol is the only kind that would have caught that.
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const published = vi.hoisted(() => [] as Array<{ machineId: string; frame: { type?: string; payload?: Record<string, unknown> } }>)
const binding = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../config/env.js', () => ({ env: { PROVIDER_ALLOW_INSECURE_URLS: true } }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: vi.fn(async () => binding.current) } },
}))
// The recap cache is Redis in production (four cluster workers share it); an in-memory stand-in is
// enough here, and keeping it real rather than a no-op is what lets the `agent_recent` fallback be
// tested at all.
const recapCache = vi.hoisted(() => new Map<string, unknown[]>())
vi.mock('./bus.js', () => ({
  publishUp: vi.fn(async (machineId: string, msg: { frame: unknown }) => {
    published.push({ machineId, frame: msg.frame as { type?: string } })
    return 1
  }),
  pushMachineRecap: vi.fn(async (machineId: string, agentId: string, entry: unknown) => {
    if (!agentId) return
    const key = `${machineId}:${agentId}`
    recapCache.set(key, [entry, ...(recapCache.get(key) ?? [])].slice(0, 5))
  }),
  getMachineRecaps: vi.fn(async (machineId: string, agentId: string, n: number) =>
    (recapCache.get(`${machineId}:${agentId}`) ?? []).slice(0, n)),
}))
vi.mock('./machineCredential.js', () => ({ decryptMachineCredential: (v: string) => v.replace('enc:', '') }))
vi.mock('./billingState.js', () => ({ machineBillingAllowsDataPlane: () => true }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { dispatch, forgetMachineMode, machineOnline } = await import('./providerLink.js')

// ── A minimal but genuine provider ───────────────────────────────────────────────────────────────

interface ServerBehaviour {
  streaming: boolean
  /** Emitted in order; `null` cuts the stream with NO terminal frame — a protocol violation. */
  script: Array<Record<string, unknown> | null>
  rejectCredential: boolean
  /** This fake has recaps to hand back; false means it answers with an empty list. */
  declareRecap: boolean
  /**
   * The provider manages its agents in its own product and declines to mutate them.
   *
   * There is nothing to declare in advance, so this is the ONLY way a client can learn that — by
   * calling and reading the reason. That makes the message load-bearing, not decoration.
   */
  refuseMutations: string | null
  /** What `agent.recap` hands back — ONE recap, or nothing. */
  recapEntry: Record<string, unknown> | null
  /** Unused: history is required of every provider. Kept so scenarios read unchanged. */
  declareHistory: boolean
  /** What `agent.history` answers. */
  historyResult: Record<string, unknown>
  /** Unused: with one transcript per agent there is no per-turn tag to drop. */
  untaggedTasks: boolean
  /** Unused: a session cannot be mis-attributed when it IS the agent. */
  strayTask: boolean
  /** Holds the stream open before the terminal frame, so a turn can outlive a heartbeat interval. */
  holdMs: number
}

const behaviour: ServerBehaviour = {
  streaming: true, script: [], rejectCredential: false, declareRecap: false, recapEntry: null,
  refuseMutations: null,
  declareHistory: false, historyResult: { agentId: 'alpha', events: [] }, untaggedTasks: false,
  strayTask: false, holdMs: 0,
}
/** The params the last turn was sent with — proves the agent selector goes out. */
let lastTurnMessage: Record<string, unknown> | undefined
/** The params `agent.history` was last called with — proves paging is forwarded. */
let lastHistoryParams: Record<string, unknown> | undefined
/** How many times the recap was PULLED — a recap pushed on the stream must make that zero. */
let recapCalls = 0
/** The credential this fake was handed, so the header convention itself is under test. */
let lastAuthHeader: string | undefined
let server: Server
let baseUrl = ''

/**
 * The agent list is AUTHENTICATED, which is exactly why it is a method and not a public document —
 * two credentials may legitimately see two different lists.
 */
const AGENTS = () => [
  { id: 'alpha', name: 'Alpha', description: 'first' },
  { id: 'beta', name: 'Beta' },
]

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization
    if (behaviour.rejectCredential) return json(res, 401, { jsonrpc: '2.0', id: 1, error: { code: 'unauthenticated', message: 'nope' } })

    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { method?: string; params?: Record<string, unknown> }
      const method = parsed.method
      if (method === 'agent.list') {
        return json(res, 200, { jsonrpc: '2.0', id: 1, result: { agents: AGENTS() } })
      }
      if (method === 'agent.history') {
        lastHistoryParams = parsed.params
        return json(res, 200, { jsonrpc: '2.0', id: 1, result: behaviour.historyResult })
      }
      if (method === 'turn.cancel') {
        return json(res, 200, { jsonrpc: '2.0', id: 1, result: { cancelled: true } })
      }
      if (method === 'agent.recap') {
        recapCalls += 1
        // ALWAYS answered. A provider that does not summarise answers with NO `recap` — there is no
        // capability to declare and nothing to refuse, so `declareRecap` now only decides whether this
        // fake HAS anything to give back.
        const entry = behaviour.declareRecap ? behaviour.recapEntry : null
        return json(res, 200, { jsonrpc: '2.0', id: 1, result: { agentId: 'alpha', ...(entry ?? {}) } })
      }
      if (method === 'agent.create' || method === 'agent.rename' || method === 'agent.delete') {
        if (behaviour.refuseMutations) {
          // `invalid_request`, NOT `unsupported`: the difference is that this one carries a sentence
          // the product can put in front of the user.
          return json(res, 200, { jsonrpc: '2.0', id: 1, error: { code: 'invalid_request', message: behaviour.refuseMutations } })
        }
        if (method === 'agent.delete') return json(res, 200, { jsonrpc: '2.0', id: 1, result: { deleted: true } })
        const params = (parsed.params ?? {}) as { agentId?: string; name?: string; description?: string }
        const id = method === 'agent.create' ? String(params.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-') : String(params.agentId ?? '')
        return json(res, 200, {
          jsonrpc: '2.0', id: 1,
          result: { id, name: params.name, ...(params.description ? { description: params.description } : {}) },
        })
      }
      if (method !== 'agent.send') return json(res, 200, { jsonrpc: '2.0', id: 1, error: { code: 'unsupported', message: 'no' } })
      lastTurnMessage = parsed.params as Record<string, unknown> | undefined

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const script = [...behaviour.script]
      const drain = (): void => {
        while (script.length) {
          const event = script.shift()
          if (event === null) { res.destroy(); return }
          // Hold the stream open just before the terminal event, so a turn can outlive a heartbeat.
          if (behaviour.holdMs && script.length === 0) {
            setTimeout(() => { res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`); res.end() }, behaviour.holdMs)
            return
          }
          res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
        }
        res.end()
      }
      drain()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

beforeEach(() => {
  published.length = 0
  recapCache.clear()
  behaviour.streaming = true
  behaviour.rejectCredential = false
  behaviour.script = []
  behaviour.declareRecap = false
  behaviour.recapEntry = null
  behaviour.refuseMutations = null
  behaviour.declareHistory = false
  behaviour.historyResult = { agentId: 'alpha', events: [] }
  lastHistoryParams = undefined
  lastTurnMessage = undefined
  behaviour.untaggedTasks = false
  behaviour.strayTask = false
  recapCalls = 0
  behaviour.holdMs = 0
  binding.current = {
    machineId: 'h1',
    userId: 'u1',
    authMode: 'provider',
    deletedAt: null,
    providerUrl: baseUrl,
    providerCredentialEncrypted: 'enc:secret',
    createdAt: new Date('2026-08-04T00:00:00Z'),
  }
  forgetMachineMode('h1')
})

/** Turn lifecycle, as first-class events. */
const started = (): Record<string, unknown> => ({ kind: 'turn_started', turnId: 'task-1', agentId: 'alpha' })
const completed = (): Record<string, unknown> => ({ kind: 'turn_completed' })
const cancelled = (): Record<string, unknown> => ({ kind: 'turn_cancelled' })
const failed = (message: string): Record<string, unknown> =>
  ({ kind: 'turn_failed', error: { code: 'internal', message } })

/** One event, flat — no `Part`, no metadata namespace. */
const part = (kind: string, text: string, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ kind, ...(text ? { text } : {}), ...fields })

const types = (): string[] => published.map((p) => p.frame.type ?? '')

describe('a full turn over a real socket', () => {
  it('streams a Claude-shaped turn through to client frames', async () => {
    behaviour.script = [
      started(),
      part('thinking_delta', 'weighing it up'),
      part('tool_start', '', { toolId: 'c7', tool: 'Read' }),
      part('tool_end', 'ok', { toolId: 'c7', tool: 'Read' }),
      part('text_delta', 'Here is the answer.'),
      completed(),
    ]

    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'what is in note.txt?' } } })

    // The whole contract in one list: the turn opens, immediately says it is alive, streams, closes,
    // then settles a recap. `turn_heartbeat` sits right behind `turn_started` on purpose — waiting a
    // full interval would leave the device blank for the first 5s of every turn.
    // `commander_event` is the DEVICE's half, interleaved with the web's. It appears here and not
    // before because the provider is addressed by agent now: with no agentId in the payload we fall
    // back to the machine's sole/first agent, so the device gets its tile instead of nothing.
    expect(types().filter((t) => t !== 'commander_event')).toEqual([
      'session_created', 'turn_started', 'turn_heartbeat',
      'thinking_delta', 'tool_start', 'tool_end', 'text_delta',
      'turn_ended', 'turn_summary_pending', 'turn_summary',
    ])
    const text = published.find((p) => p.frame.type === 'text_delta')!.frame.payload!.content
    expect(text).toBe('Here is the answer.')
  })

  it('announces the session and tags EVERY frame with it', async () => {
    // The web keys its whole turn lifecycle on `dbSessionId`. Without it the user's own message is
    // never revealed and the send spinner never clears — the input reads "sending…" forever even
    // though every event arrived. Found by using the real UI, not by any unit test.
    behaviour.script = [
      started(),
      part('text_delta', 'hi'),
      completed(),
    ]
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hello' } } })

    const created = published.find((p) => p.frame.type === 'session_created')
    expect(created, 'a new chat must announce its session').toBeTruthy()
    const sessionId = created!.frame.payload!.sessionId as string
    expect(sessionId).toBeTruthy()

    for (const p of published) {
      if (p.frame.type === 'session_created') continue
      expect(
        (p.frame as { dbSessionId?: string }).dbSessionId,
        `${p.frame.type} is untagged — the web cannot bind it to a session`,
      ).toBe(sessionId)
    }
  })

  it('reuses the session the client supplied when it names a real agent', async () => {
    // `sessions_list` hands out `id: agentId`, so this is what the web sends back — and re-announcing
    // a session it already knows would make its spinner migrate twice.
    behaviour.script = [started(), completed()]
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi', sessionId: 'beta' } } })
    expect(published.some((p) => p.frame.type === 'session_created')).toBe(false)
    expect((published.at(-1)!.frame as { dbSessionId?: string }).dbSessionId).toBe('beta')
  })

  it('opens with turn_started and always closes with turn_ended', async () => {
    behaviour.script = [started(), completed()]
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    // session_created leads for a brand-new chat; the turn itself still brackets the events.
    expect(types().filter((t) => t !== 'session_created')[0]).toBe('turn_started')
    // `turn_ended` closes the TURN. The recap settles after it — deliberately, since the turn is
    // over by then and the web must not be held on a spinner while a summary is fetched.
    const closed = types().indexOf('turn_ended')
    expect(closed).toBeGreaterThan(-1)
    expect(types().slice(closed + 1).filter((t) => t !== 'commander_event')
      .every((t) => t.startsWith('turn_summary'))).toBe(true)
  })

  it('closes the turn even when the provider cuts the stream with no terminal state', async () => {
    // The one-terminal rule broken on their side. The client must not be left with a spinner forever.
    behaviour.script = [started(), part('text_delta', 'half a'), null]
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    expect(types()).toContain('error')
    expect(types().filter((t) => t !== 'commander_event').at(-1)).toBe('turn_ended')
  })

  it('marks an aborted turn as aborted, not merely finished', async () => {
    behaviour.script = [started(), cancelled()]
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    // `reason` is required on the client's turn_ended union; this path used to omit it, which only
    // typechecked because the frame is opaque at the transport layer.
    expect(published.filter((p) => p.frame.type !== 'commander_event').at(-1)!.frame)
      .toMatchObject({ type: 'turn_ended', payload: { reason: 'interrupt', aborted: true } })
  })

  it('emits exactly ONE error for a failed turn, not two', async () => {
    // Running it for real produced two: the transport failure, and then "ended the stream without
    // finishing" on top — which is redundant and wrong, since there was never a stream.
    binding.current = { ...binding.current!, providerUrl: 'http://127.0.0.1:1' }
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    expect(types().filter((t) => t === 'error')).toHaveLength(1)
    expect(types().at(-1)).toBe('turn_ended')
  })

  it('never leaks the host and port we dialled into the UI', async () => {
    // A raw ECONNREFUSED carries our infrastructure's view of the world. The owner gets a sentence;
    // the address stays in the logs.
    binding.current = { ...binding.current!, providerUrl: 'http://127.0.0.1:1' }
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    const message = String(published.find((p) => p.frame.type === 'error')?.frame.payload?.message)
    expect(message).not.toMatch(/127\.0\.0\.1|:1\b|ECONNREFUSED/)
    expect(message).toMatch(/could not reach/i)
  })

  it('reports a rejected credential in words the owner can act on', async () => {
    behaviour.rejectCredential = true
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    const error = published.find((p) => p.frame.type === 'error')
    expect(String(error?.frame.payload?.message)).toMatch(/re-enter/i)
  })
})

// ── Liveness and recap ───────────────────────────────────────────────────────────────────────────

/** The device-facing cards for one agent, in order. The web and the device speak different frames. */
const cards = (agentId = 'alpha'): Array<Record<string, unknown>> =>
  published
    .filter((p) => p.frame.type === 'commander_event' && (p.frame as { agentId?: string }).agentId === agentId)
    .map((p) => p.frame.payload as Record<string, unknown>)

const turn = (payload: Record<string, unknown>): Promise<void> =>
  dispatch('h1', { connId: '', frame: { type: 'message', payload } })

describe('a running turn says it is still running', () => {
  it('beats for BOTH clients, and keeps beating past the watchdogs', async () => {
    // THE bug this feature fixes. A provider turn used to emit turn_started and then nothing until it
    // finished, so the web's 10s watchdog killed the indicator and the device's 25s BUSY_TIMEOUT
    // cleared the tile — mid-turn, on every turn longer than a few seconds.
    //
    // Deliberately a slow test: the beat is 5s, so nothing shorter than that can prove the interval
    // actually fires, and an immediate-beat-only assertion would have passed against the broken code.
    behaviour.script = [started(), completed()]
    behaviour.holdMs = 5_200

    await turn({ text: 'take your time', agentId: 'alpha' })

    const beats = types().filter((t) => t === 'turn_heartbeat')
    expect(beats.length, 'the web indicator dies without these').toBeGreaterThanOrEqual(2)
    const processing = cards().filter((c) => c.kind === 'processing' && !c.text)
    expect(processing.length, 'the device tile clears without these').toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('stops beating once the turn is over — no leaked interval', async () => {
    behaviour.script = [started(), completed()]
    await turn({ text: 'hi', agentId: 'alpha' })
    const settled = types().filter((t) => t === 'turn_heartbeat').length
    await new Promise((r) => setTimeout(r, 5_500))
    expect(types().filter((t) => t === 'turn_heartbeat')).toHaveLength(settled)
  }, 20_000)
})

describe('the recap', () => {
  const script = (answer: string): void => {
    behaviour.script = [
      started(),
      part('text_delta', answer),
      completed(),
    ]
  }

  it('prefers the provider’s own when it has one', async () => {
    behaviour.declareRecap = true
    behaviour.recapEntry = { recap: 'Flagged Acme overspend at 118% of pacing', text: 'The weekly query returned 7 rows.' }
    script('Acme is at 118% of pacing this week.')

    await turn({ text: 'how is acme pacing?', agentId: 'alpha' })

    const summary = cards().find((c) => c.kind === 'summary')!
    expect(summary.recap).toBe('Flagged Acme overspend at 118% of pacing')
    expect(summary.text).toBe('The weekly query returned 7 rows.')
  })

  it('derives one from the turn’s own output when the provider declares nothing', async () => {
    // Most providers summarise nothing and answer with an empty list. An empty tile for all of them is worse
    // than an honest excerpt of what the agent actually said.
    script('Acme is at 118% of pacing. I also rebuilt the weekly alert query and scheduled it.')

    await turn({ text: 'how is acme pacing?', agentId: 'alpha' })

    const summary = cards().find((c) => c.kind === 'summary')!
    expect(summary.recap, 'the headline is the opening sentence, nothing appended').toBe('Acme is at 118% of pacing.')
    expect(summary.text).toBe('Acme is at 118% of pacing. I also rebuilt the weekly alert query and scheduled it.')
  })

  it('clears the busy tile BEFORE painting the card', async () => {
    // Get this backwards and the card is immediately wiped by the clear. The node path emits
    // done-then-summary for exactly this reason.
    script('All done.')
    await turn({ text: 'hi', agentId: 'alpha' })
    const kinds = cards().map((c) => c.kind)
    expect(kinds.indexOf('done')).toBeLessThan(kinds.indexOf('summary'))
  })

  it('holds the device busy while the recap is being fetched', async () => {
    script('All done.')
    await turn({ text: 'hi', agentId: 'alpha' })
    expect(cards().some((c) => c.kind === 'processing' && c.text === 'Summarizing…')).toBe(true)
    expect(types()).toContain('turn_summary_pending')
  })

  it('gives a FAILED turn no recap at all', async () => {
    // Summarising a failure produces a tile that reads like an accomplishment.
    behaviour.script = [started(), failed('boom')]
    await turn({ text: 'hi', agentId: 'alpha' })
    expect(cards().some((c) => c.kind === 'summary')).toBe(false)
    expect(types()).not.toContain('turn_summary')
    expect(cards().at(-1)!.kind, 'the tile must still be released').toBe('done')
  })

  it('says nothing rather than inventing a tile for a silent turn', async () => {
    behaviour.script = [started(), completed()]
    await turn({ text: 'hi', agentId: 'alpha' })
    expect(cards().some((c) => c.kind === 'summary')).toBe(false)
    const pending = published.filter((p) => p.frame.type === 'turn_summary_pending')
    expect(pending.at(-1)!.frame.payload, 'the web row must close, not hang').toMatchObject({ done: true })
  })

  it('ignores a pulled recap that belongs to a DIFFERENT turn', async () => {
    // The bug this closes: `agent.recap` is scoped to an agent and takes no turn id, so the newest
    // entry a provider holds the instant a turn ends is very often the PREVIOUS turn's — and it was
    // being shown as this turn's summary. An entry that names another turn is now no answer.
    behaviour.declareRecap = true
    behaviour.recapEntry = { recap: 'The previous turn’s headline', text: 'Stale body.', turnId: 't-other' }
    script('This turn said something else entirely.')

    await turn({ text: 'hi', agentId: 'alpha' })

    const summary = cards().find((c) => c.kind === 'summary')!
    expect(summary.recap).toBe('This turn said something else entirely.')
  })
})

describe('the recap, pushed on the turn’s own stream', () => {
  const withRecap = (answer: string, recapParts: Array<Record<string, unknown>>): void => {
    behaviour.script = [
      started(),
      part('text_delta', answer),
      part('recap_start', ''),
      ...recapParts,
      completed(),
    ]
  }

  it('uses the pushed recap and never asks for one', async () => {
    behaviour.declareRecap = true
    behaviour.recapEntry = { recap: 'A stale headline from another turn', text: 'Stale.' }
    withRecap('Acme is at 118% of pacing.', [
      part('recap_end', 'The weekly query returned 7 rows.', { recap: 'Flagged Acme overspend at 118% of pacing' }),
    ])

    await turn({ text: 'how is acme pacing?', agentId: 'alpha' })

    const summary = cards().find((c) => c.kind === 'summary')!
    expect(summary.recap).toBe('Flagged Acme overspend at 118% of pacing')
    expect(summary.text).toBe('The weekly query returned 7 rows.')
    // The stream wins outright: asking again could only reintroduce the wrong-turn guess.
    expect(recapCalls, 'a pushed recap must make the pull unnecessary').toBe(0)
  })

  it('never leaks the recap_* frames to a client that cannot read them', async () => {
    withRecap('All done.', [part('recap_end', 'Body.', { recap: 'Did the thing' })])
    await turn({ text: 'hi', agentId: 'alpha' })
    expect(types()).not.toContain('recap_start')
    expect(types()).not.toContain('recap_end')
  })

  it('opens the "Summarizing…" indicator when the wait STARTS, not after it', async () => {
    // The whole reason the phase is bracketed: summarising is seconds of real time during which the
    // turn has stopped speaking. Announced at the end it explains nothing, and the web shows a stall.
    withRecap('All done.', [part('recap_end', 'Body.', { recap: 'Did the thing' })])
    await turn({ text: 'hi', agentId: 'alpha' })

    const order = types()
    const pendingAt = order.indexOf('turn_summary_pending')
    expect(pendingAt).toBeGreaterThan(-1)
    expect(pendingAt, 'the indicator must precede the end of the turn').toBeLessThan(order.indexOf('turn_ended'))
    expect(cards().some((c) => c.kind === 'processing' && c.text === 'Summarizing…')).toBe(true)
    // Still done-before-summary: reversed, the clear wipes the card the moment it is painted.
    const kinds = cards().map((c) => c.kind)
    expect(kinds.indexOf('done')).toBeLessThan(kinds.indexOf('summary'))
  })

  it('closes the indicator when the provider ends the phase with nothing to show', async () => {
    // `recap_end` without a headline means "no recap". A start with no end would spin forever.
    behaviour.script = [
      started(),
      part('recap_start', ''),
      part('recap_end', ''),
      completed(),
    ]
    await turn({ text: 'hi', agentId: 'alpha' })

    expect(cards().some((c) => c.kind === 'summary')).toBe(false)
    const pending = published.filter((p) => p.frame.type === 'turn_summary_pending')
    expect(pending.at(-1)!.frame.payload, 'the web row must close, not hang').toMatchObject({ done: true })
    expect(cards().at(-1)!.kind, 'the tile must still be released').toBe('done')
  })

  it('falls back to the turn’s own words when the summariser came back empty', async () => {
    behaviour.script = [
      started(),
      part('text_delta', 'Acme is at 118% of pacing. More detail here.'),
      part('recap_start', ''),
      part('recap_end', ''),
      completed(),
    ]
    await turn({ text: 'hi', agentId: 'alpha' })
    // The same excerpt any other provider gets — an excerpt of what was actually said, never invented.
    expect(cards().find((c) => c.kind === 'summary')!.recap).toBe('Acme is at 118% of pacing.')
  })
})

describe('agent_recent — the device restoring its tiles', () => {
  it('answers live from the provider when it has one', async () => {
    behaviour.declareRecap = true
    behaviour.recapEntry = { recap: 'Shipped the pacing alert', text: 'Full body.' }
    await dispatch('h1', { connId: '', frame: { type: 'agent_recent', payload: { requestId: 'r9', agentId: 'alpha', n: 1 } } })

    const reply = published.at(-1)!.frame
    expect(reply.type).toBe('agent_recent_result')
    expect(reply.payload).toMatchObject({ requestId: 'r9', agentId: 'alpha' })
    expect(reply.payload!.events).toEqual([{ kind: 'summary', recap: 'Shipped the pacing alert', text: 'Full body.' }])
  })

  it('falls back to the last turn’s recap when the provider summarises nothing', async () => {
    // Without this a provider machine's tiles are blank after every device reboot — which is what
    // `agent_recent` answering UNSUPPORTED used to guarantee.
    behaviour.script = [
      started(),
      part('text_delta', 'Rebuilt the weekly report.'),
      completed(),
    ]
    await turn({ text: 'rebuild it', agentId: 'alpha' })
    published.length = 0

    await dispatch('h1', { connId: '', frame: { type: 'agent_recent', payload: { requestId: 'r10', agentId: 'alpha', n: 2 } } })
    expect(published.at(-1)!.frame.payload!.events).toEqual([
      { kind: 'summary', recap: 'Rebuilt the weekly report.', text: 'Rebuilt the weekly report.' },
    ])
  })

  it('returns an empty list before anything has been summarised', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'agent_recent', payload: { requestId: 'r11', agentId: 'beta' } } })
    // Correct, not a failure: the device then shows nothing rather than stale text.
    expect(published.at(-1)!.frame.payload!.events).toEqual([])
  })

  it('refuses without an agent instead of guessing one', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'agent_recent', payload: { requestId: 'r12' } } })
    expect(published.at(-1)!.frame.payload).toMatchObject({ error: 'MISSING_AGENT_ID' })
  })
})

describe('the RPCs the web needs to render anything', () => {
  it('agents_list returns the provider skills as projects', async () => {
    // This is what fills the project tabs. An empty answer here is the difference between a usable
    // machine and a blank screen.
    await dispatch('h1', { connId: '', frame: { type: 'agents_list', payload: { requestId: 'r1' } } })
    const reply = published.at(-1)!.frame
    expect(reply.type).toBe('agents_list_result')
    expect(reply.payload!.requestId).toBe('r1')
    const agents = reply.payload!.agents as Array<{ id: string; name: string; userId: string }>
    expect(agents.map((a) => a.id)).toEqual(['alpha', 'beta'])
    // Fields the protocol does not carry are synthesised by us, never invented by the provider.
    expect(agents[0]!.userId).toBe('u1')
  })

  it('sessions_list synthesises ONE session per agent', async () => {
    // A provider has no sessions to fold, so there is nothing to ask it and nothing to get wrong.
    // The whole "a chat answered twice appeared twice" bug class is structurally impossible now.
    await dispatch('h1', { connId: '', frame: { type: 'sessions_list', payload: { requestId: 'r2', agentId: 'alpha' } } })
    const sessions = published.at(-1)!.frame.payload!.sessions as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'alpha', title: 'Alpha' })
    // Omitted, not zero — the client hides a count it did not receive, and fabricating one is banned.
    expect('messageCount' in sessions[0]!).toBe(false)
  })

  it('tells the provider WHICH agent the turn belongs to', async () => {
    // The provider is ADDRESSED by agent now, so this is a required parameter rather than a metadata
    // hint a provider was free to ignore.
    behaviour.script = [started(), completed()]
    await turn({ text: 'hi', agentId: 'beta' })
    expect(lastTurnMessage).toMatchObject({ agentId: 'beta' })
  })

  it('mints the turnId itself, so an instant cancel has something to name', async () => {
    // A provider-minted id would arrive only with the first event — too late for a user who has
    // already pressed stop.
    behaviour.script = [started(), completed()]
    await turn({ text: 'hi', agentId: 'alpha' })
    expect(typeof lastTurnMessage?.turnId).toBe('string')
    expect(lastTurnMessage!.turnId as string).toBeTruthy()
  })

  it('sessions_list shows only the SELECTED agent', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'sessions_list', payload: { requestId: 'r2', agentId: 'beta' } } })
    const sessions = published.at(-1)!.frame.payload!.sessions as Array<Record<string, unknown>>
    expect(sessions.map((s) => s.id)).toEqual(['beta'])
  })

  it('sessions_list answers empty for an agent this machine does not have', async () => {
    // Better an empty list than somebody else's row: the id came from the client, not from us.
    await dispatch('h1', { connId: '', frame: { type: 'sessions_list', payload: { requestId: 'r2', agentId: 'ghost' } } })
    expect(published.at(-1)!.frame.payload!.sessions).toEqual([])
  })

  it('sessions_list unscoped lists every agent', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'sessions_list', payload: { requestId: 'r2' } } })
    const sessions = published.at(-1)!.frame.payload!.sessions as Array<Record<string, unknown>>
    expect(sessions.map((s) => s.id)).toEqual(['alpha', 'beta'])
  })

  it('session_get reads the agent’s whole transcript', async () => {
    behaviour.historyResult = {
      agentId: 'alpha',
      events: [part('user_message', 'how is acme pacing?'), part('text_delta', 'Acme is at 118%.')],
    }
    // `sessionId` is the id `sessions_list` handed out — which IS the agentId.
    await dispatch('h1', { connId: '', frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha' } } })
    const reply = published.at(-1)!.frame.payload!
    expect(reply).toMatchObject({ id: 'alpha', title: 'Alpha' })
    expect(reply.events).toHaveLength(2)
    expect(lastHistoryParams).toMatchObject({ agentId: 'alpha' })
  })

  it('session_get hands back EVENTS, the only transcript shape the web can render', async () => {
    // The bug this closes: raw provider entries were passed through as `messages`, and the client's
    // fallback for that field parses Claude's JSONL shape (`message.content[]`). Every entry failed
    // `!msg.message?.content` and was dropped, so the chat rendered empty however much came back.
    behaviour.historyResult = {
      agentId: 'alpha',
      events: [
        part('user_message', 'run it'),
        part('tool_start', '', { toolId: 'c7', tool: 'Bash' }),
        part('text_delta', 'Done.'),
      ],
    }
    await dispatch('h1', { connId: '', frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha' } } })
    const reply = published.at(-1)!.frame.payload!
    const events = reply.events as Array<{ type: string; payload: Record<string, unknown> }>

    // Exactly the vocabulary `eventsToMessages` switches on, with the payload field names it reads.
    expect(events.map((e) => e.type)).toEqual(['user_message', 'tool_start', 'text_delta'])
    expect(events[0]!.payload).toMatchObject({ content: 'run it' })
    expect(events[1]!.payload).toMatchObject({ id: 'c7', tool: 'Bash' })
    // The dead branch must stay dead: anything left here would be dropped silently by the client.
    expect(reply.messages).toEqual([])
  })

  it('the SAME event objects render live and in history', async () => {
    // One shape, one mapper. This is what makes "what you saw live" and "what you see after a
    // refresh" incapable of disagreeing — and what let `historyToEvents` stop being a translation.
    const stream = [part('text_delta', 'Done.'), part('tool_start', '', { toolId: 'c7', tool: 'Bash' })]
    behaviour.script = [started(), ...stream.map((e) => e as Record<string, unknown>), completed()]
    await turn({ text: 'hi', agentId: 'alpha' })
    const live = published.filter((p) => p.frame.type === 'text_delta' || p.frame.type === 'tool_start')
      .map((p) => ({ type: p.frame.type, payload: p.frame.payload }))

    published.length = 0
    behaviour.historyResult = { agentId: 'alpha', events: stream }
    await dispatch('h1', { connId: '', frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha' } } })
    const replayed = published.at(-1)!.frame.payload!.events

    expect(replayed).toEqual(live)
  })

  it('session_get forwards the window and hands the cursor back', async () => {
    behaviour.historyResult = { agentId: 'alpha', events: [part('text_delta', 'x')], nextBefore: 'u4' }
    await dispatch('h1', {
      connId: '',
      frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha', limit: 60, before: 'u9' } },
    })
    // The names going OUT are the node path's, deliberately: a provider machine must be
    // indistinguishable from a node one by the time the frame reaches the web. `nextBefore` is the
    // provider's word and never reaches a client.
    expect(lastHistoryParams).toMatchObject({ agentId: 'alpha', limit: 60, before: 'u9' })
    expect(published.at(-1)!.frame.payload).toMatchObject({ hasMore: true, oldestCursor: 'u4' })
  })

  it('session_get clamps an absurd window rather than passing it on', async () => {
    await dispatch('h1', {
      connId: '',
      frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha', limit: 10_000 } },
    })
    expect(lastHistoryParams).toMatchObject({ limit: 500 })
  })

  it('session_get reports the end of the transcript as hasMore false', async () => {
    behaviour.historyResult = { agentId: 'alpha', events: [] }
    await dispatch('h1', {
      connId: '',
      frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha', limit: 60, before: 'gone' } },
    })
    expect(published.at(-1)!.frame.payload).toMatchObject({ hasMore: false, oldestCursor: null })
  })

  it('session_get omits the paging fields entirely when no window was asked for', async () => {
    behaviour.historyResult = { agentId: 'alpha', events: [part('text_delta', 'x')] }
    await dispatch('h1', { connId: '', frame: { type: 'session_get', payload: { requestId: 'r3', sessionId: 'alpha' } } })
    const reply = published.at(-1)!.frame.payload!
    // Absent, not `false` — their absence is how the client tells a complete answer from a windowed one.
    expect('hasMore' in reply).toBe(false)
    expect('oldestCursor' in reply).toBe(false)
    expect('limit' in (lastHistoryParams ?? {})).toBe(false)
  })

  it('answers an out-of-scope RPC AT ONCE instead of leaving a spinner', async () => {
    // The web times out at 20s. Silence is the worst possible answer.
    await dispatch('h1', { connId: '', frame: { type: 'models_list', payload: { requestId: 'r4' } } })
    expect(published.at(-1)!.frame).toMatchObject({ type: 'models_list_result', payload: { error: 'UNSUPPORTED', requestId: 'r4' } })
  })

  it('cancel reaches the provider', async () => {
    await expect(dispatch('h1', { connId: '', frame: { type: 'cancel', payload: { taskId: 't1' } } })).resolves.toBeUndefined()
  })

  it('sends the credential as `Authorization: Bearer`, the one header there is', async () => {
    // Fixed by convention rather than by declaration. A provider cannot choose a different one, so
    // this is the only place the whole scheme is pinned.
    await dispatch('h1', { connId: '', frame: { type: 'agents_list', payload: { requestId: 'auth-1' } } })
    expect(lastAuthHeader).toBe('Bearer secret')
  })
})

describe('creating, renaming and deleting agents', () => {
  it('forwards all three to the provider', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'agent_create', payload: { requestId: 'c1', name: 'New Skill' } } })
    expect(published.at(-1)!.frame).toMatchObject({
      type: 'agent_create_result',
      payload: { requestId: 'c1', agent: { id: 'new-skill', name: 'New Skill' } },
    })

    await dispatch('h1', { connId: '', frame: { type: 'agent_update', payload: { requestId: 'u1', agentId: 'alpha', name: 'Renamed' } } })
    expect(published.at(-1)!.frame).toMatchObject({
      type: 'agent_update_result',
      payload: { requestId: 'u1', agent: { id: 'alpha', name: 'Renamed' } },
    })

    await dispatch('h1', { connId: '', frame: { type: 'agent_delete', payload: { requestId: 'd1', agentId: 'beta' } } })
    expect(published.at(-1)!.frame).toMatchObject({ type: 'agent_delete_result', payload: { requestId: 'd1' } })
  })

  it('hands the provider’s OWN refusal to the user, word for word', async () => {
    // The mitigation for having nothing declared in advance. The web cannot hide a control it never
    // asked about, so the answer has to explain itself — and a generic "could not reach the provider"
    // wrapped around this sentence would turn an explanation into a lie.
    behaviour.refuseMutations = 'Agents are managed in Example Co — create one there and it appears here'
    await dispatch('h1', { connId: '', frame: { type: 'agent_create', payload: { requestId: 'c2', name: 'Nope' } } })
    expect(published.at(-1)!.frame.payload).toEqual({
      requestId: 'c2',
      error: 'Agents are managed in Example Co — create one there and it appears here',
    })
  })

  it('refuses a model switch rather than half-applying it', async () => {
    // `agent_update` carries either a rename or a model choice. Model selection belongs to whatever
    // runs the agent, which for a provider machine is not us.
    await dispatch('h1', { connId: '', frame: { type: 'agent_update', payload: { requestId: 'u2', agentId: 'alpha', selectedModel: 'opus' } } })
    expect(published.at(-1)!.frame.payload).toMatchObject({ requestId: 'u2', error: 'UNSUPPORTED' })
  })
})

describe('always online', () => {
  it('reports a provider machine online even with no presence key', async () => {
    // THE bug that made the whole feature look broken: presence is the source of truth for every
    // other mode, but a provider never writes one, so reading presence alone said `false` — and the
    // web then refuses to fetch anything at all (`AgentTabs`: if (nodeOnline === false) return).
    // The machine rendered dead and never loaded its projects.
    expect(await machineOnline('h1', false)).toBe(true)
  })

  it('does not claim any OTHER mode is online when presence says otherwise', async () => {
    binding.current = { ...binding.current!, authMode: 'remote' }
    forgetMachineMode('h1')
    expect(await machineOnline('h1', false)).toBe(false)
  })

  it('still reports online when presence does say so', async () => {
    binding.current = { ...binding.current!, authMode: 'managed' }
    forgetMachineMode('h1')
    expect(await machineOnline('h1', true)).toBe(true)
  })
})

describe('refusals', () => {
  it('says so when the machine is not a provider machine', async () => {
    binding.current = { ...binding.current!, authMode: 'remote' }
    forgetMachineMode('h1')
    await dispatch('h1', { connId: '', frame: { type: 'agents_list', payload: { requestId: 'r5' } } })
    expect(published.at(-1)!.frame.payload!.error).toBeTruthy()
  })

  it('says so when the provider details are missing', async () => {
    binding.current = { ...binding.current!, providerUrl: null }
    await dispatch('h1', { connId: '', frame: { type: 'message', payload: { text: 'hi' } } })
    expect(types()).toContain('error')
    expect(types().filter((t) => t !== 'commander_event').at(-1)).toBe('turn_ended')
  })
})
