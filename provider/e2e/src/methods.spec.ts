/**
 * One block per method, against BOTH implementations.
 *
 * `flow.spec.ts` asserts properties of a turn. This file asserts that each of the eight methods does
 * what it says — and, more importantly, that it has the EFFECT it claims. A rename that returns the
 * new name and leaves `agent.list` untouched passes any test that only reads the response, and the
 * user sees the old name until they reload. So every mutation here is checked through a second call.
 *
 * Both implementations are driven, because a protocol only one author's server satisfies has not been
 * tested — it has been restated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootExample, bootReference, type Booted } from './providers.js'

const TERMINAL = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required']

interface Event { kind?: string; [field: string]: unknown }

let seq = 0
const turnId = (): string => `m-${Date.now()}-${++seq}`

async function rpc(p: Booted, method: string, params: unknown, key = p.key): Promise<Record<string, unknown>> {
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as Record<string, unknown>
}

const resultOf = <T>(body: Record<string, unknown>): T => body.result as T
const errorOf = (body: Record<string, unknown>): { code?: string; message?: string } | undefined =>
  body.error as { code?: string; message?: string } | undefined
const codeOf = (body: Record<string, unknown>): string | undefined => errorOf(body)?.code

const parseFrames = (raw: string): Event[] =>
  raw
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Event)

async function send(
  p: Booted,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ events: Event[]; turnId: string; status: number; contentType: string }> {
  const id = typeof extra.turnId === 'string' ? extra.turnId : turnId()
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'agent.send',
      params: { agentId: p.agentId, turnId: id, message: { text }, ...extra },
    }),
  })
  const contentType = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  return {
    events: contentType.includes('text/event-stream') ? parseFrames(raw) : [],
    turnId: id,
    status: res.status,
    contentType,
  }
}

/**
 * Send, and run `whileRunning` the moment the FIRST event lands.
 *
 * A `turn.cancel` fired before the provider has begun is a different code path (and already covered
 * elsewhere). To test the interruption of a running turn the turn has to be provably running, and
 * sleeping for an arbitrary number of milliseconds is how that test becomes flaky on a loaded CI box.
 * Waiting for real output is deterministic.
 */
async function sendAndInterrupt(
  p: Booted,
  text: string,
  whileRunning: (turnId: string) => Promise<void>,
  extra: Record<string, unknown> = {},
): Promise<{ events: Event[]; turnId: string }> {
  const id = typeof extra.turnId === 'string' ? extra.turnId : turnId()
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'agent.send',
      params: { agentId: p.agentId, turnId: id, message: { text }, ...extra },
    }),
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: Event[] = []
  let buffer = ''
  let fired = false
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
    if (!fired && events.length) {
      fired = true
      await whileRunning(id)
    }
  }
  return { events, turnId: id }
}

const terminals = (events: Event[]): Event[] => events.filter((e) => TERMINAL.includes(e.kind ?? ''))
const kinds = (events: Event[]): string[] => events.map((e) => e.kind ?? '(none)')
const historyOf = async (p: Booted, agentId: string, params: Record<string, unknown> = {}): Promise<Event[]> =>
  resultOf<{ events?: Event[] }>(await rpc(p, 'agent.history', { agentId, ...params })).events ?? []

// ── the matrix ───────────────────────────────────────────────────────────────────────────────────

const providers: Booted[] = []

beforeAll(async () => {
  providers.push(await bootReference(), await bootExample())
}, 30_000)
afterAll(async () => { for (const p of providers) await p.close() })

const each = <T>(fn: (p: Booted) => T): Array<[string, () => T]> =>
  [0, 1].map((i) => [['reference-provider', 'example-provider'][i]!, () => fn(providers[i]!)])

// ── agent.list ───────────────────────────────────────────────────────────────────────────────────

describe('agent.list', () => {
  it.each(each((p) => p))('%s returns stable, well-formed, non-empty entries', async (_label, get) => {
    const p = get()
    const first = resultOf<{ agents: Array<{ id: string; name: string; description?: string }> }>(
      await rpc(p, 'agent.list', {}),
    )
    expect(first.agents.length).toBeGreaterThan(0)
    for (const agent of first.agents) {
      expect(typeof agent.id, JSON.stringify(agent)).toBe('string')
      expect(agent.id).toBeTruthy()
      expect(agent.name).toBeTruthy()
    }
    // Stable across calls: Autonomous refuses to send to an agent the LATEST list does not contain,
    // so an id that churns makes every agent unaddressable at random.
    const second = resultOf<{ agents: Array<{ id: string }> }>(await rpc(p, 'agent.list', {}))
    expect(second.agents.map((a) => a.id)).toEqual(first.agents.map((a) => a.id))
  }, 30_000)

  it.each(each((p) => p))('%s does not leak the whole list to an unauthenticated caller', async (_label, get) => {
    const p = get()
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.list', params: {} }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(codeOf(body)).toBe('unauthenticated')
    // 401 too, so a client that never parses the body can still tell this from an outage.
    expect(res.status).toBe(401)
    expect(body.result).toBeUndefined()
  }, 30_000)
})

// ── agent.send ───────────────────────────────────────────────────────────────────────────────────

describe('agent.send', () => {
  it.each(each((p) => p))('%s opens with turn_started carrying the turnId it was given', async (_label, get) => {
    const p = get()
    const { events, turnId: id } = await send(p, 'how is acme pacing?')
    expect(events[0]!.kind).toBe('turn_started')
    // Echoing the CLIENT's id back is what makes an out-of-band cancel addressable. A provider that
    // mints its own would still stream correctly and be uncancellable.
    expect(events[0]!.turnId).toBe(id)
  }, 30_000)

  it.each(each((p) => p))('%s refuses a send with no turnId rather than inventing one', async (_label, get) => {
    const p = get()
    const body = await rpc(p, 'agent.send', { agentId: p.agentId, message: { text: 'no id' } })
    expect(codeOf(body)).toBe('invalid_request')
  }, 30_000)

  it.each(each((p) => p))('%s rejects a bad credential BEFORE opening a stream', async (_label, get) => {
    const p = get()
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.badKey}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'agent.send',
        params: { agentId: p.agentId, turnId: turnId(), message: { text: 'hi' } },
      }),
    })
    // A stream that opens and then fails is far worse than a refusal: the client has already told the
    // user the turn is running, and has to take it back.
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream')
    expect(codeOf((await res.json()) as Record<string, unknown>)).toBe('unauthenticated')
  }, 30_000)

  it.each(each((p) => p))('%s appends to the transcript instead of replacing it', async (_label, get) => {
    const p = get()
    const before = (await historyOf(p, p.agentId)).length
    await send(p, 'first of two')
    const between = (await historyOf(p, p.agentId)).length
    await send(p, 'second of two')
    const after = (await historyOf(p, p.agentId)).length
    expect(between).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(between)
  }, 30_000)
})

// ── turn.cancel ──────────────────────────────────────────────────────────────────────────────────

describe('turn.cancel', () => {
  it.each(each((p) => p))('%s stops a turn that is ALREADY RUNNING', async (_label, get) => {
    const p = get()
    // The early-cancel path is covered in flow.spec.ts. This is the other one: a turn that has begun
    // producing output and must actually be interrupted, not merely marked. A provider whose cancel
    // only sets a flag it never checks passes the early case and fails this one.
    const { events } = await sendAndInterrupt(p, p.slowPhrase, async (id) => {
      const body = await rpc(p, 'turn.cancel', { turnId: id })
      expect(resultOf<{ cancelled?: boolean }>(body).cancelled).toBe(true)
    })
    const ends = terminals(events)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.kind).toBe('turn_cancelled')
    // …and it is last, so the stream really closed rather than being abandoned mid-frame.
    expect(events.at(-1)!.kind).toBe('turn_cancelled')
  }, 60_000)

  it.each(each((p) => p))('%s accepts a cancel for a turn it has never heard of', async (_label, get) => {
    const p = get()
    // The client mints `turnId` before sending, so "unknown turn" is a legitimate, expected state —
    // not an error to report at the user.
    const body = await rpc(p, 'turn.cancel', { turnId: `never-existed-${turnId()}` })
    expect(codeOf(body)).toBeUndefined()
    expect(resultOf<{ cancelled?: boolean }>(body).cancelled).toBe(true)
  }, 30_000)

  it.each(each((p) => p))('%s refuses a cancel with no turnId rather than guessing', async (_label, get) => {
    const p = get()
    // Guessing here means stopping somebody else's turn.
    expect(codeOf(await rpc(p, 'turn.cancel', {}))).toBe('invalid_request')
  }, 30_000)
})

// ── agent.history ────────────────────────────────────────────────────────────────────────────────

describe('agent.history', () => {
  it.each(each((p) => p))('%s keeps each agent’s transcript to itself', async (_label, get) => {
    const p = get()
    const marker = `isolation probe ${turnId()}`
    await send(p, marker)
    const other = await historyOf(p, p.otherAgentId)
    // One tenant's agents are not one transcript. A shared store keyed by the wrong thing shows the
    // user another agent's conversation, which is a data-leak class of bug, not a cosmetic one.
    expect(other.some((e) => typeof e.text === 'string' && e.text.includes(marker))).toBe(false)
  }, 30_000)

  it.each(each((p) => p))('%s omits nextBefore when the whole transcript was asked for', async (_label, get) => {
    const p = get()
    await send(p, 'give me something to read back')
    const body = await rpc(p, 'agent.history', { agentId: p.agentId })
    const result = resultOf<Record<string, unknown>>(body)
    // Its ABSENCE is the client's only signal that it reached the start. Present-and-meaningless
    // makes an unwindowed read look like the first page of a longer one.
    expect('nextBefore' in result).toBe(false)
    expect(Array.isArray(result.events)).toBe(true)
  }, 30_000)

  it.each(each((p) => p))('%s windows from the NEWEST end', async (_label, get) => {
    const p = get()
    await send(p, 'older turn')
    await send(p, 'newest turn')
    const whole = await historyOf(p, p.agentId)
    expect(whole.length).toBeGreaterThan(1)
    const windowed = await historyOf(p, p.agentId, { limit: 1 })
    expect(windowed).toHaveLength(1)
    // The user is looking at the bottom of a conversation, so a window that starts at the TOP shows
    // them the beginning of a chat they have already read.
    expect(windowed[0]).toEqual(whole.at(-1))
  }, 30_000)

  it.each(each((p) => p))('%s never returns a terminal or lifecycle frame as transcript', async (_label, get) => {
    const p = get()
    await send(p, 'a turn with a full lifecycle')
    const stored = new Set(kinds(await historyOf(p, p.agentId)))
    // These are live-turn signals. A transcript that replays them makes a refreshed page re-run the
    // turn's UI: a spinner that opens, a "done" that fires again.
    for (const kind of [...TERMINAL, 'turn_started', 'recap_start', 'recap_end']) {
      expect(stored.has(kind), `${kind} leaked into history`).toBe(false)
    }
  }, 30_000)

  it.each(each((p) => p))('%s refuses an unknown agent instead of answering empty', async (_label, get) => {
    const p = get()
    // Empty and "no such agent" are different sentences: one says the conversation is new, the other
    // says the id is wrong.
    expect(codeOf(await rpc(p, 'agent.history', { agentId: `ghost-${turnId()}` }))).toBe('not_found')
  }, 30_000)
})

// ── agent.recap ──────────────────────────────────────────────────────────────────────────────────

describe('agent.recap', () => {
  it.each(each((p) => p))('%s answers with an object, never `unsupported`', async (_label, get) => {
    const p = get()
    const body = await rpc(p, 'agent.recap', { agentId: p.agentId })
    // A provider that summarises nothing says so by answering with no `recap`, and Autonomous derives
    // one from the turn's own text. `unsupported` would leave the device with a blank tile and no
    // reason for it.
    expect(codeOf(body)).toBeUndefined()
    expect(resultOf<{ agentId?: string }>(body).agentId).toBe(p.agentId)
  }, 30_000)

  it.each(each((p) => p))('%s hands back a headline it can render, tagged with its turn', async (_label, get) => {
    const p = get()
    // Produce something to summarise first: `recap` is the reference provider's scripted recap turn,
    // and any completed turn gives the Claude-backed one an excerpt to store.
    await send(p, 'recap')
    const out = resultOf<{ recap?: unknown; text?: unknown; turnId?: unknown }>(
      await rpc(p, 'agent.recap', { agentId: p.agentId }),
    )
    // The device renders this on a round 466px screen; a recap with no headline is a blank tile.
    expect(typeof out.recap).toBe('string')
    expect(String(out.recap).trim()).toBeTruthy()
    if (out.text !== undefined) expect(typeof out.text).toBe('string')
    // Tagged with its turn, so a client asking the instant a turn ends can tell THIS turn's summary
    // from the previous one's — the pull is scoped to an agent and cannot be scoped to a turn.
    expect(typeof out.turnId).toBe('string')
  }, 30_000)

  it.each(each((p) => p))('%s returns the LAST recap, not an older one', async (_label, get) => {
    const p = get()
    // The whole point of the method after `n` went away. Two summarised turns in a row must leave the
    // second one on the tile — a provider returning its oldest, or its first-stored, passes every
    // other assertion here and shows the user yesterday's work.
    await send(p, 'recap')
    const first = resultOf<{ turnId?: string }>(await rpc(p, 'agent.recap', { agentId: p.agentId }))
    const second = await send(p, 'recap')
    const after = resultOf<{ turnId?: string }>(await rpc(p, 'agent.recap', { agentId: p.agentId }))

    expect(after.turnId).not.toBe(first.turnId)
    expect(after.turnId).toBe(second.turnId)
  }, 30_000)

  it.each(each((p) => p))('%s says nothing rather than something stale for a fresh agent', async (_label, get) => {
    const p = get()
    const created = resultOf<{ id: string }>(await rpc(p, 'agent.create', { name: `Recap Probe ${Date.now()}${++seq}` }))
    const out = resultOf<Record<string, unknown>>(await rpc(p, 'agent.recap', { agentId: created.id }))
    // ABSENT, not empty-string: the device shows no tile at all rather than a blank one.
    expect(out.recap).toBeUndefined()
    await rpc(p, 'agent.delete', { agentId: created.id })
  }, 30_000)
})

// ── agent.create / rename / delete ───────────────────────────────────────────────────────────────

describe('agent.create', () => {
  it.each(each((p) => p))('%s puts the new agent in agent.list', async (_label, get) => {
    const p = get()
    const name = `Created ${Date.now()}${++seq}`
    const created = resultOf<{ id: string; name: string }>(await rpc(p, 'agent.create', { name }))
    expect(created.name).toBe(name)

    // The response is not the point — the LIST is what the user sees. A create that returns an agent
    // and does not persist it looks like it worked until the next reload.
    const listed = resultOf<{ agents: Array<{ id: string; name: string }> }>(await rpc(p, 'agent.list', {})).agents
    expect(listed.find((a) => a.id === created.id)?.name).toBe(name)

    await rpc(p, 'agent.delete', { agentId: created.id })
  }, 30_000)

  it.each(each((p) => p))('%s refuses an empty name with a reason, not `unsupported`', async (_label, get) => {
    const p = get()
    const err = errorOf(await rpc(p, 'agent.create', { name: '   ' }))
    expect(err?.code).toBe('invalid_request')
    // Nothing is declared in advance, so the message IS the explanation the UI shows.
    expect(err?.message).toBeTruthy()
  }, 30_000)

  it.each(each((p) => p))('%s never hands out a duplicate id for a duplicate name', async (_label, get) => {
    const p = get()
    // The two implementations resolve this differently — one derives a fresh id, the other refuses —
    // and both are conformant. What neither may do is return an id that already belongs to another
    // agent, which would silently alias two workspaces onto one.
    const name = `Twice ${Date.now()}${++seq}`
    const first = resultOf<{ id: string }>(await rpc(p, 'agent.create', { name }))
    const second = await rpc(p, 'agent.create', { name })
    const created: string[] = [first.id]
    if (second.result) {
      const id = resultOf<{ id: string }>(second).id
      expect(id).not.toBe(first.id)
      created.push(id)
    } else {
      expect(codeOf(second)).toBe('invalid_request')
      expect(errorOf(second)?.message).toBeTruthy()
    }
    for (const id of created) await rpc(p, 'agent.delete', { agentId: id })
  }, 30_000)
})

describe('agent.rename', () => {
  it.each(each((p) => p))('%s changes the name in agent.list and keeps the id', async (_label, get) => {
    const p = get()
    const created = resultOf<{ id: string }>(await rpc(p, 'agent.create', { name: `Before ${Date.now()}${++seq}` }))
    const after = `After ${Date.now()}${++seq}`
    const renamed = resultOf<{ id: string; name: string }>(await rpc(p, 'agent.rename', { agentId: created.id, name: after }))

    // The id is the addressing key. Renaming it would silently orphan the transcript and every
    // reference the client already holds.
    expect(renamed.id).toBe(created.id)
    const listed = resultOf<{ agents: Array<{ id: string; name: string }> }>(await rpc(p, 'agent.list', {})).agents
    expect(listed.find((a) => a.id === created.id)?.name).toBe(after)

    await rpc(p, 'agent.delete', { agentId: created.id })
  }, 30_000)

  it.each(each((p) => p))('%s refuses an unknown agent with a reason', async (_label, get) => {
    const p = get()
    const err = errorOf(await rpc(p, 'agent.rename', { agentId: `ghost-${turnId()}`, name: 'x' }))
    expect(err?.code).toBe('invalid_request')
    expect(err?.message).toBeTruthy()
  }, 30_000)
})

describe('agent.delete', () => {
  it.each(each((p) => p))('%s removes it from the list AND makes it unaddressable', async (_label, get) => {
    const p = get()
    const created = resultOf<{ id: string }>(await rpc(p, 'agent.create', { name: `Doomed ${Date.now()}${++seq}` }))
    expect(resultOf<{ deleted?: boolean }>(await rpc(p, 'agent.delete', { agentId: created.id })).deleted).toBe(true)

    const listed = resultOf<{ agents: Array<{ id: string }> }>(await rpc(p, 'agent.list', {})).agents
    expect(listed.map((a) => a.id)).not.toContain(created.id)

    // Gone from the list but still answering is the worse half of this bug: the agent is invisible in
    // the UI and still reachable by anyone holding the id.
    expect(codeOf(await rpc(p, 'agent.history', { agentId: created.id }))).toBe('not_found')
    const after = await send(p, 'anyone there?', { agentId: created.id })
    expect(after.contentType).not.toContain('text/event-stream')
  }, 30_000)

  it.each(each((p) => p))('%s refuses to delete an agent it does not have', async (_label, get) => {
    const p = get()
    // Answering `{deleted:true}` for an id that never existed makes a failed delete indistinguishable
    // from a successful one.
    expect(codeOf(await rpc(p, 'agent.delete', { agentId: `ghost-${turnId()}` }))).toBe('invalid_request')
  }, 30_000)
})
