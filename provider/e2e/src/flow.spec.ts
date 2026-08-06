/**
 * The whole flow, against BOTH implementations.
 *
 * Everything here is a property of a TURN rather than of one request, which is why it lives outside
 * the conformance runner: a check that sees a single call cannot tell whether a stream ended exactly
 * once, or whether what a refresh shows matches what the user watched.
 *
 * Running the same suite against two independently written servers is the load-bearing part. A spec
 * that only its own author's implementation satisfies has not been tested — it has been restated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coalesceDeltas, runConformance } from '../../reference-provider/src/conformance.js'
import { bootExample, bootReference, type Booted } from './providers.js'

const TERMINAL = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required']

interface Event { kind?: string; [field: string]: unknown }

let seq = 0
const turnId = (): string => `e2e-${Date.now()}-${++seq}`

async function rpc(p: Booted, method: string, params: unknown, key = p.key): Promise<Record<string, unknown>> {
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as Record<string, unknown>
}

const resultOf = <T>(body: Record<string, unknown>): T => body.result as T
const codeOf = (body: Record<string, unknown>): string | undefined =>
  (body.error as { code?: string } | undefined)?.code

async function send(p: Booted, text: string, extra: Record<string, unknown> = {}): Promise<{ events: Event[]; turnId: string }> {
  const id = typeof extra.turnId === 'string' ? extra.turnId : turnId()
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'agent.send',
      params: { agentId: p.agentId, turnId: id, message: { text }, ...extra },
    }),
  })
  const raw = await res.text()
  const events = raw
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Event)
  return { events, turnId: id }
}

const terminals = (events: Event[]): Event[] => events.filter((e) => TERMINAL.includes(e.kind ?? ''))
/**
 * What the stream and `agent.history` are expected to agree on.
 *
 * Lifecycle and the recap bracket are live-turn signals. `done` is excluded too: it restates text
 * already streamed as deltas, so requiring it in a transcript would mean storing the same words twice.
 */
const NON_TRANSCRIPT = new Set(['turn_started', 'recap_start', 'recap_end', 'done'])
const content = (events: Event[]): Event[] =>
  events.filter((e) => !TERMINAL.includes(e.kind ?? '') && !NON_TRANSCRIPT.has(e.kind ?? ''))

// ── the matrix ───────────────────────────────────────────────────────────────────────────────────

const providers: Booted[] = []

beforeAll(async () => {
  providers.push(await bootReference(), await bootExample())
}, 30_000)
afterAll(async () => { for (const p of providers) await p.close() })

const each = <T>(fn: (p: Booted) => T): Array<[string, () => T]> =>
  [0, 1].map((i) => [['reference-provider', 'example-provider'][i]!, () => fn(providers[i]!)])

describe('both implementations pass the conformance suite', () => {
  it.each(each((p) => p))('%s reports zero failures', async (_label, get) => {
    const p = get()
    const summary = await runConformance({ url: p.url, key: p.key, badKey: p.badKey, askPhrase: p.askPhrase })
    // Named, not counted: a bare number tells whoever broke it nothing.
    expect(summary.results.filter((r) => r.outcome === 'FAIL').map((f) => `${f.id}: ${f.detail ?? ''}`)).toEqual([])
    expect(summary.pass).toBeGreaterThan(12)
  }, 60_000)
})

describe('exactly one terminal frame ends every stream', () => {
  it.each(each((p) => p))('%s', async (_label, get) => {
    const p = get()
    const { events } = await send(p, 'how is acme pacing?')
    const ends = terminals(events)
    expect(ends).toHaveLength(1)
    // …and it is LAST. A terminal frame with events after it is the same bug wearing a disguise.
    expect(events.at(-1)!.kind).toBe(ends[0]!.kind)
  }, 30_000)
})

describe('history returns the SAME objects the stream emitted', () => {
  it.each(each((p) => p))('%s', async (_label, get) => {
    const p = get()
    const { events } = await send(p, 'a distinctive e2e probe')
    const live = content(events)
    expect(live.length).toBeGreaterThan(0)

    const history = resultOf<{ events?: Event[] }>(await rpc(p, 'agent.history', { agentId: p.agentId }))
    // Deltas are a STREAMING detail — a live turn emits them in pieces, a transcript holds whole
    // messages — so both sides are coalesced first. Everything else is compared by DEEP
    // EQUALITY, not "looks similar": one shape and one mapper is what stops what-you-saw and
    // what-you-see-after-a-refresh from drifting.
    const wanted = coalesceDeltas(live)
    const got = coalesceDeltas(content(history.events ?? [])).slice(-wanted.length)
    expect(got).toEqual(wanted)
  }, 30_000)
})

describe('a cancel that lands BEFORE the turn starts still stops it', () => {
  it.each(each((p) => p))('%s', async (_label, get) => {
    const p = get()
    // The entire reason the client mints the id: a user pressing stop in the first 200ms has
    // something to name. A provider minting its own cannot satisfy this.
    const id = turnId()
    await rpc(p, 'turn.cancel', { turnId: id })
    const { events } = await send(p, 'this must not run', { turnId: id })
    expect(terminals(events).map((e) => e.kind)).toEqual(['turn_cancelled'])
  }, 30_000)
})

describe('a bad credential fails EVERY method the same way', () => {
  it.each(each((p) => p))('%s', async (_label, get) => {
    const p = get()
    for (const [method, params] of [
      ['agent.list', {}],
      ['agent.history', { agentId: p.agentId }],
      ['turn.cancel', { turnId: 'x' }],
      ['agent.recap', { agentId: p.agentId }],
      ['agent.create', { name: 'nope' }],
      ['agent.rename', { agentId: p.agentId, name: 'nope' }],
      ['agent.delete', { agentId: p.agentId }],
    ] as Array<[string, unknown]>) {
      const body = await rpc(p, method, params, p.badKey)
      // Not just "an error" — the SAME error, so the UI can say "re-enter your credential" every time
      // rather than "something went wrong" on whichever call happened to be first.
      expect(codeOf(body), method).toBe('unauthenticated')
    }
  }, 30_000)
})

describe('windowing terminates', () => {
  it.each(each((p) => p))('%s pages to the start and then stops offering a cursor', async (_label, get) => {
    const p = get()
    await send(p, 'first')
    await send(p, 'second')

    let cursor: string | undefined
    let pages = 0
    const seen: Event[] = []
    for (;;) {
      const out = resultOf<{ events?: Event[]; nextBefore?: string }>(
        await rpc(p, 'agent.history', { agentId: p.agentId, limit: 2, ...(cursor ? { before: cursor } : {}) }),
      )
      seen.unshift(...(out.events ?? []))
      if (!out.nextBefore) break
      // A cursor that never runs out is the failure this loop exists to catch; the bound turns an
      // infinite page-walk into a test failure instead of a hung suite.
      expect(++pages, 'paging did not terminate').toBeLessThan(50)
      cursor = out.nextBefore
    }
    const whole = resultOf<{ events?: Event[] }>(await rpc(p, 'agent.history', { agentId: p.agentId }))
    expect(seen).toEqual(whole.events)
  }, 30_000)
})

describe('an unknown agent is refused rather than answered empty', () => {
  it.each(each((p) => p))('%s', async (_label, get) => {
    const p = get()
    expect(codeOf(await rpc(p, 'agent.history', { agentId: 'no-such-agent' }))).toBe('not_found')
  }, 30_000)
})

describe('a question to the user resumes on the same turnId', () => {
  it('reference-provider completes the round trip', async () => {
    // Only the scripted implementation can be made to ask on demand. The other is driven by a real
    // model, so faking an "ask" there would test the fake, not the provider — the conformance runner
    // marks it SKIP with that reason rather than pretending.
    const p = providers[0]!
    const first = await send(p, p.askPhrase!)
    const paused = terminals(first.events)[0]!
    expect(paused.kind).toBe('turn_input_required')
    expect(paused.prompt).toBeTruthy()

    const resumed = await send(p, 'the answer', { turnId: first.turnId, resume: true })
    expect(terminals(resumed.events).map((e) => e.kind)).toEqual(['turn_completed'])
  }, 30_000)
})

// ── the event vocabulary ─────────────────────────────────────────────────────────────────────────

/**
 * Every kind the protocol defines, and where it can be observed.
 *
 * `stream` kinds are asserted on the wire. `user_message` is the ONE kind that is never streamed —
 * the client already has the text it just sent, so echoing it back would be noise — and it is asserted
 * through `agent.history` instead. The four terminals cannot share a turn, so each names the phrase
 * that produces it.
 *
 * This table is the reason the reference provider has an `everything` scenario at all: from outside,
 * a kind nobody emitted is indistinguishable from a kind nobody supports, so the vocabulary has to be
 * proven REACHABLE somewhere or the spec is describing something unverified.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  turn_started: ['turnId'],
  user_message: ['text'],
  thinking_delta: ['text'],
  thinking_title: ['title'],
  text_delta: ['text'],
  tool_start: ['toolId', 'tool'],
  tool_end: ['toolId'],
  context_compact: [],
  done: ['text'],
  recap_start: [],
  recap_end: ['recap'],
  turn_completed: [],
  turn_failed: ['error'],
  turn_cancelled: [],
  turn_input_required: ['prompt'],
}

describe('the event vocabulary is reachable and carries its fields', () => {
  const STREAMED = [
    'turn_started', 'thinking_delta', 'thinking_title', 'text_delta', 'tool_start', 'tool_end',
    'context_compact', 'done', 'recap_start', 'recap_end', 'turn_completed',
  ]

  it('reference-provider emits every content kind in ONE turn', async () => {
    const p = providers[0]!
    const { events } = await send(p, 'everything')
    const byKind = new Map(events.map((e) => [e.kind ?? '', e]))
    expect(STREAMED.filter((k) => !byKind.has(k))).toEqual([])

    // Present is not enough — an event whose fields are missing renders as a blank row.
    for (const kind of STREAMED) {
      const event = byKind.get(kind)!
      const missing = REQUIRED_FIELDS[kind]!.filter((f) => event[f] === undefined || event[f] === '')
      expect(missing, `${kind} is missing fields`).toEqual([])
    }
  }, 30_000)

  it('reference-provider reaches the three terminals a completed turn cannot', async () => {
    const p = providers[0]!
    const failed = terminals((await send(p, 'fail')).events)[0]!
    expect(failed.kind).toBe('turn_failed')
    expect(failed.error).toBeTruthy()

    const asked = terminals((await send(p, p.askPhrase!)).events)[0]!
    expect(asked.kind).toBe('turn_input_required')
    expect(asked.prompt).toBeTruthy()

    const id = turnId()
    await rpc(p, 'turn.cancel', { turnId: id })
    const cancelled = terminals((await send(p, 'stopped', { turnId: id })).events)[0]!
    expect(cancelled.kind).toBe('turn_cancelled')
  }, 30_000)

  it.each(each((p) => p))('%s puts user_message in history and never on the wire', async (_label, get) => {
    const p = get()
    const { events } = await send(p, `a probe ${turnId()}`)
    // Never streamed: the client already has the text it just sent, so echoing it back is noise.
    expect(events.some((e) => e.kind === 'user_message')).toBe(false)

    // Still in the transcript, or a refresh shows one side of a conversation.
    const history = resultOf<{ events?: Event[] }>(await rpc(p, 'agent.history', { agentId: p.agentId }))
    const stored = (history.events ?? []).filter((e) => e.kind === 'user_message')
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every((e) => typeof e.text === 'string' && e.text)).toBe(true)
  }, 30_000)

  it('reference-provider stores the text of the turn just sent', async () => {
    // Asserted only where the transcript is written by the thing under test. `example-provider` reads
    // Claude's own JSONL, which a fake `claude` does not write — so demanding it there would be
    // testing the fixture rather than the provider.
    const p = providers[0]!
    const text = `only in history ${turnId()}`
    await send(p, text)
    const history = resultOf<{ events?: Event[] }>(await rpc(p, 'agent.history', { agentId: p.agentId }))
    expect((history.events ?? []).some((e) => e.kind === 'user_message' && e.text === text)).toBe(true)
  }, 30_000)
})

describe('agent mutations either work or refuse with a reason', () => {
  it.each(each((p) => p))('%s never answers `unsupported`', async (_label, get) => {
    const p = get()
    // Nothing is declared in advance, so a client discovers refusal by calling. `unsupported` would
    // leave the product with a control it can neither use nor explain; `invalid_request` with a
    // message is what it shows the user instead.
    for (const [method, params] of [
      ['agent.create', { name: '' }],
      ['agent.rename', { agentId: 'no-such-agent', name: 'x' }],
      ['agent.delete', { agentId: 'no-such-agent' }],
    ] as Array<[string, unknown]>) {
      const body = await rpc(p, method, params)
      expect(codeOf(body), method).not.toBe('unsupported')
      const err = body.error as { code?: string; message?: string } | undefined
      if (err) expect(err.message, `${method} refused with no reason to show`).toBeTruthy()
    }
  }, 30_000)

  it.each(each((p) => p))('%s makes a NEW agent addressable at once', async (_label, get) => {
    const p = get()
    // The trap: deriving the set of valid ids once at startup. An agent created a moment ago is then
    // refused with `not_found` by its very next call, and the failure looks like the create silently
    // did nothing.
    const name = `Fresh ${Math.random().toString(36).slice(2, 8)}`
    const created = resultOf<{ id?: string }>(await rpc(p, 'agent.create', { name }))
    expect(created.id).toBeTruthy()
    expect(codeOf(await rpc(p, 'agent.history', { agentId: created.id! }))).toBeUndefined()
    expect(resultOf<{ deleted?: boolean }>(await rpc(p, 'agent.delete', { agentId: created.id! })).deleted).toBe(true)
  }, 30_000)
})
