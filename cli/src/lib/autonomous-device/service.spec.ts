import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AUTONOMOUS_DEVICE_CAPABILITIES, AutonomousDeviceService, type AutonomousDeviceFrame } from './service.js'

function fixture(now?: () => number, fullAnswer?: string) {
  const submit = vi.fn(), stop = vi.fn(async () => true), answer = vi.fn(async () => true)
  const events: AutonomousDeviceFrame[] = []
  const service = new AutonomousDeviceService({ now, machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Project', engine: 'claude', state: 'idle' }],
    submit, stop, answer, cancelDelivery: vi.fn(() => true), recent: () => [], fullText: () => fullAnswer, emit: f => events.push(f) })
  const send = (fields: Record<string, unknown> = {}) => ({ type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', text: 'hello', idempotencyKey: 'intent1', ...fields })
  return { service, submit, stop, answer, events, send }
}

describe('Autonomous device local-agent service', () => {
  it('ensures focus through the desktop once for concurrent enables', async () => {
    const requestAppFocus = vi.fn(() => true)
    const submit = vi.fn()
    const service = new AutonomousDeviceService({ machineId: 'machine',
      agents: () => [{ agentId: 'first', name: 'First', engine: 'claude', state: 'idle' }],
      requestAppFocus, submit, stop: async () => true, answer: async () => true,
      cancelDelivery: () => true, recent: () => [] })
    const request = () => service.request('device', { type: 'focus.ensure', requestId: randomUUID() })
    const first = request(), second = request()
    expect(requestAppFocus).toHaveBeenCalledTimes(1)
    expect(requestAppFocus.mock.calls[0]).toEqual(['first', expect.any(Number), expect.any(String)])
    expect(service.focusSnapshot().focus).toBeNull()
    // A user selection wins over the suggested first agent, even on another machine.
    service.appFocus('remote', 'chosen', 'window')
    expect((await first).focus).toEqual({ machineId: 'remote', agentId: 'chosen' })
    expect((await second).focus).toEqual({ machineId: 'remote', agentId: 'chosen' })
    await request()
    expect(requestAppFocus).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })

  it('requires an app acknowledgment and never invents headless focus', async () => {
    const f = fixture()
    const request = { type: 'focus.ensure', requestId: randomUUID() }
    expect((await f.service.request('device', request)).error).toMatchObject({ code: 'FOCUS_UNAVAILABLE' })
    expect(f.service.focusSnapshot().focus).toBeNull()
    const empty = new AutonomousDeviceService({ machineId: 'machine', agents: () => [],
      submit: vi.fn(), stop: async () => true, answer: async () => true,
      cancelDelivery: () => true, recent: () => [] })
    expect((await empty.request('device', request)).error).toMatchObject({ code: 'NO_AGENTS' })
  })

  it('expires unacknowledged focus requests without retrying', async () => {
    vi.useFakeTimers()
    try {
      const requestAppFocus = vi.fn(() => true)
      const service = new AutonomousDeviceService({ machineId: 'machine',
        agents: () => [{ agentId: 'first', name: 'First', engine: 'claude', state: 'idle' }],
        requestAppFocus, submit: vi.fn(), stop: async () => true, answer: async () => true,
        cancelDelivery: () => true, recent: () => [] })
      const pending = service.request('device', { type: 'focus.ensure', requestId: randomUUID() })
      await vi.advanceTimersByTimeAsync(2001)
      expect((await pending).error).toMatchObject({ code: 'FOCUS_UNAVAILABLE' })
      expect(requestAppFocus).toHaveBeenCalledTimes(1)
      expect(service.focusSnapshot().focus).toBeNull()
    } finally { vi.useRealTimers() }
  })

  describe('scroll', () => {
    function scrollFixture(hasApp = true) {
      const scroll = vi.fn((_phase: 'down' | 'move' | 'up', _dy: number, _velocity: number) => hasApp)
      const service = new AutonomousDeviceService({ machineId: 'machine', scroll,
        agents: () => [], submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent: () => [] })
      const send = (over: Record<string, unknown>) => service.request('device', { type: 'scroll', requestId: randomUUID(), ...over })
      return { service, scroll, send }
    }

    it('advertises the capability', () => {
      expect(AUTONOMOUS_DEVICE_CAPABILITIES).toContain('scroll')
    })

    it('forwards each phase of a stroke to the window, dy and velocity defaulting to 0', async () => {
      const f = scrollFixture()
      expect(await f.send({ phase: 'down' })).toMatchObject({ type: 'scroll_result' })
      expect(await f.send({ phase: 'move', dy: -24 })).not.toHaveProperty('error')
      expect(await f.send({ phase: 'up', dy: -3, velocity: -900 })).not.toHaveProperty('error')
      expect(f.scroll.mock.calls).toEqual([['down', 0, 0], ['move', -24, 0], ['up', -3, -900]])
    })

    it('rejects a bad phase, a non-integer or oversized travel, and unknown fields', async () => {
      const f = scrollFixture()
      for (const over of [{ phase: 'flick' }, { phase: 'move', dy: 1.5 }, { phase: 'move', dy: 5000 }, { phase: 'up', velocity: 1e6 }, { phase: 'move', dy: 1, agentId: 'a' }]) {
        expect(await f.send(over)).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
      }
      expect(f.scroll).not.toHaveBeenCalled()
    })

    it('is FOCUS_UNAVAILABLE without a Desktop window, and when the machine has no scroll wiring', async () => {
      expect(await scrollFixture(false).send({ phase: 'down' })).toMatchObject({ error: { code: 'FOCUS_UNAVAILABLE' } })
      const bare = new AutonomousDeviceService({ machineId: 'm', agents: () => [], submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent: () => [] })
      expect(await bare.request('device', { type: 'scroll', requestId: randomUUID(), phase: 'down' })).toMatchObject({ error: { code: 'FOCUS_UNAVAILABLE' } })
    })
  })

  describe('focus.step', () => {
    const DESK = ['a', 'b', 'c']
    function stepFixture(desk = DESK, acknowledge = true) {
      const stepFocus = vi.fn(async (direction: 'next' | 'previous', current: string | undefined) => {
        if (!desk.length) return 'no_agents' as const
        const at = current ? desk.indexOf(current) : -1
        const agentId = at < 0 ? desk[direction === 'next' ? 0 : desk.length - 1] : desk[(at + (direction === 'next' ? 1 : desk.length - 1)) % desk.length]
        // The app acknowledges on its own tick, the way `dial_focus` → `app_focus` does.
        if (acknowledge) setTimeout(() => service.appFocus('machine', agentId, 'window'), 0)
        return { machineId: 'machine', agentId }
      })
      const events: AutonomousDeviceFrame[] = []
      const service = new AutonomousDeviceService({ machineId: 'machine', stepFocus,
        agents: () => desk.map(agentId => ({ agentId, name: agentId.toUpperCase(), engine: 'claude', state: 'idle' })),
        submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent: () => [], emit: f => events.push(f) })
      const step = (direction: 'next' | 'previous', over: Record<string, unknown> = {}) => service.request('device',
        { type: 'focus.step', requestId: randomUUID(), idempotencyKey: randomUUID(), direction, focusRevision: service.focusSnapshot().focusRevision, ...over })
      return { service, stepFocus, events, step }
    }

    it('advertises the capability', () => {
      expect(new AutonomousDeviceService({ machineId: 'm', agents: () => [], submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent: () => [] }))
        .toBeDefined()
      expect(AUTONOMOUS_DEVICE_CAPABILITIES).toContain('focus.step')
    })

    it('walks next and previous through the desk and wraps at both ends', async () => {
      const f = stepFixture()
      f.service.appFocus('machine', 'b', 'window')
      expect((await f.step('next')).focus).toEqual({ machineId: 'machine', agentId: 'c', name: 'C' })
      expect((await f.step('next')).focus).toMatchObject({ agentId: 'a' })
      expect((await f.step('previous')).focus).toMatchObject({ agentId: 'c' })
      expect((await f.step('previous')).focus).toMatchObject({ agentId: 'b' })
      expect(f.stepFocus.mock.calls.map(c => c[1])).toEqual(['b', 'c', 'a', 'c'])
      expect(f.events.filter(e => e.kind === 'focus.changed')).toHaveLength(5)
    })

    it('starts from the first or last tile when nothing is focused', async () => {
      const f = stepFixture()
      expect((await f.step('previous')).focus).toMatchObject({ agentId: 'c' })
      const g = stepFixture()
      expect((await g.step('next')).focus).toMatchObject({ agentId: 'a' })
    })

    it('answers a single-agent desk with the same focus and no wait', async () => {
      const f = stepFixture(['only'])
      f.service.appFocus('machine', 'only', 'window')
      const before = f.service.focusSnapshot()
      const result = await f.step('next')
      expect(result.focus).toMatchObject({ agentId: 'only' })
      expect(result.focusRevision).toBe(before.focusRevision)
      expect(f.events.filter(e => e.kind === 'focus.changed')).toHaveLength(1)
    })

    it('refuses a stale revision without moving', async () => {
      const f = stepFixture()
      f.service.appFocus('machine', 'a', 'window')
      const stale = f.service.focusSnapshot().focusRevision
      f.service.appFocus('machine', 'b', 'window')
      expect((await f.step('next', { focusRevision: stale })).error).toMatchObject({ code: 'FOCUS_CHANGED' })
      expect(f.stepFocus).not.toHaveBeenCalled()
      expect(f.service.focusSnapshot().focus).toMatchObject({ agentId: 'b' })
    })

    it('replays a retried gesture instead of stepping twice, even once the revision is stale', async () => {
      const f = stepFixture()
      f.service.appFocus('machine', 'a', 'window')
      const req = { type: 'focus.step', requestId: randomUUID(), idempotencyKey: 'gesture1', direction: 'next', focusRevision: f.service.focusSnapshot().focusRevision }
      const first = await f.service.request('device', req)
      expect(first.focus).toMatchObject({ agentId: 'b' })
      // The first tick already moved focus, so the key's revision is stale now — the retry still gets its result.
      const retry = await f.service.request('device', { ...req, requestId: randomUUID() })
      expect(retry).toEqual({ ...first, requestId: retry.requestId })
      expect(f.stepFocus).toHaveBeenCalledTimes(1)
      expect((await f.service.request('device', { ...req, requestId: randomUUID(), direction: 'previous' })).error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      // Revoke forgets the gesture with the device: the same key from a re-paired device is a new tick.
      f.service.revoke('device')
      expect((await f.service.request('device', { ...req, requestId: randomUUID(), focusRevision: f.service.focusSnapshot().focusRevision })).focus).toMatchObject({ agentId: 'c' })
      // Another device's identical key is its own gesture.
      expect((await f.service.request('other', { ...req, requestId: randomUUID(), focusRevision: f.service.focusSnapshot().focusRevision })).focus).toMatchObject({ agentId: 'a' })
      expect(f.stepFocus).toHaveBeenCalledTimes(3)
    })

    it('fails clearly when the app never acknowledges, and the retry repeats that answer', async () => {
      vi.useFakeTimers()
      try {
        const f = stepFixture(DESK, false)
        f.service.appFocus('machine', 'a', 'window')
        const req = { type: 'focus.step', requestId: randomUUID(), idempotencyKey: 'gesture1', direction: 'next', focusRevision: f.service.focusSnapshot().focusRevision }
        const pending = f.service.request('device', req)
        await vi.advanceTimersByTimeAsync(2001)
        expect((await pending).error).toMatchObject({ code: 'FOCUS_UNAVAILABLE' })
        expect((await f.service.request('device', { ...req, requestId: randomUUID() })).error).toMatchObject({ code: 'FOCUS_UNAVAILABLE' })
        expect(f.stepFocus).toHaveBeenCalledTimes(1)
        expect(f.service.focusSnapshot().focus).toMatchObject({ agentId: 'a' })
      } finally { vi.useRealTimers() }
    })

    it('reports no agents, no app, and bad requests without pretending to move', async () => {
      expect((await stepFixture([]).step('next')).error).toMatchObject({ code: 'NO_AGENTS' })
      const noApp = new AutonomousDeviceService({ machineId: 'machine', stepFocus: async () => 'no_app',
        agents: () => [{ agentId: 'a', name: 'A', engine: 'claude', state: 'idle' }],
        submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent: () => [] })
      const base = { type: 'focus.step', idempotencyKey: 'k', direction: 'next', focusRevision: noApp.focusSnapshot().focusRevision }
      expect((await noApp.request('device', { ...base, requestId: randomUUID() })).error).toMatchObject({ code: 'FOCUS_UNAVAILABLE' })
      const f = stepFixture()
      expect((await f.step('next', { direction: 'sideways' })).error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect((await f.step('next', { focusRevision: undefined })).error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect((await f.step('next', { machineId: 'machine' })).error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(f.stepFocus).not.toHaveBeenCalled()
    })
  })

  it('reserves before dispatch and deduplicates concurrent sends without selecting another agent', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.service.request('device', f.send()), f.service.request('device', f.send())])
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(a.status).toBe('accepted'); expect(b.status).toBe('duplicate')
    expect(a.receipt).toEqual(b.receipt)
    expect(f.submit.mock.calls[0].slice(0, 2)).toEqual(['agent', 'hello'])
  })
  it('rejects reuse for a different operation, target or payload', async () => {
    const f = fixture()
    await f.service.request('device', f.send())
    for (const changes of [{ text: 'different' }, { agentId: 'other' }, { type: 'turn.stop', text: undefined }]) {
      const req: Record<string, unknown> = f.send(changes); if (req.text === undefined) delete req.text
      const result = await f.service.request('device', req)
      expect(result.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    }
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('never dispatches outside the paired machine or to an unavailable agent', async () => {
    const f = fixture()
    expect((await f.service.request('device', f.send({ machineId: 'other' }))).error).toMatchObject({ code: 'MACHINE_MISMATCH' })
    expect((await f.service.request('device', f.send({ agentId: 'missing' }))).error).toMatchObject({ code: 'AGENT_NOT_FOUND' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('preserves uncertain delivery and exposes the latest receipt on duplicate', async () => {
    const f = fixture(); await f.service.request('device', f.send())
    const deliveryId = f.submit.mock.calls[0][2]
    f.service.delivery({ deliveryId, sessionId: 'agent', state: 'unknown', reason: 'NOT_CONFIRMED' })
    expect(f.service.receipt('device', 'intent1')?.state).toBe('unknown')
    expect(f.service.receipt('another-device', 'intent1')).toBeNull()
    expect((await f.service.request('device', f.send())).receipt).toMatchObject({ state: 'unknown' })
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('correlates completion only to the delivery whose start was observed', async () => {
    const f = fixture(); await f.service.request('device', f.send())
    f.service.turnEnded('agent')
    expect(f.service.receipt('device', 'intent1')?.state).toBe('queued')
    f.service.delivery({ deliveryId: f.submit.mock.calls[0][2], sessionId: 'agent', state: 'started' })
    f.service.turnEnded('agent')
    expect(f.service.receipt('device', 'intent1')).toMatchObject({ state: 'completed', turnId: expect.any(String) })
  })
  it('resyncs an old instance and replays only newer events for the current one', () => {
    const f = fixture(); f.service.event('agents.changed', undefined, {})
    const send = vi.fn()
    f.service.replay({ serverInstanceId: 'old', cursor: 500 }, send)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resync', reason: 'instance_changed' }))
    send.mockClear(); f.service.replay({ serverInstanceId: f.service.serverInstanceId, cursor: 0 }, send)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'event', eventId: 1 }))
  })
  it('rejects stale questions and validates all answer fields', async () => {
    const f = fixture()
    const req = { type: 'question.answer', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'q1', questionRequestId: 'question1', answers: { branch: 'main' } }
    expect((await f.service.request('device', req)).error).toMatchObject({ code: 'QUESTION_STALE' })
    f.service.commander({ type: 'commander_question', agentId: 'agent', payload: { requestId: 'question1', questions: [] } })
    expect((await f.service.request('device', { ...req, requestId: randomUUID() })).receipt).toMatchObject({ state: 'completed' })
    expect((await f.service.request('device', { ...req, requestId: randomUUID(), answers: { branch: 'other' } })).error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(f.answer).toHaveBeenCalledTimes(1)
  })
})


describe('Autonomous device receipt result contract and bounded cache', () => {
  it('reports reserved delivery rejection inside an accepted receipt', async () => {
    const f = fixture()
    f.submit.mockImplementation((_agent: string, _text: string, deliveryId: string) => {
      f.service.delivery({ deliveryId, sessionId: 'agent', state: 'rejected', reason: 'AGENT_NOT_FOUND' })
    })
    expect(await f.service.request('device', f.send())).toMatchObject({ status: 'accepted', receipt: { state: 'rejected', error: { code: 'AGENT_NOT_FOUND' } } })
  })
  it('retains a receipt if authorization is revoked while an async mutation completes', async () => {
    const f = fixture()
    let complete!: (ok: boolean) => void
    f.stop.mockImplementation(() => new Promise<boolean>(resolve => { complete = resolve }))
    const response = f.service.request('device', { type: 'turn.stop', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'stop' })
    f.service.revoke('device'); complete(true)
    expect(await response).toMatchObject({ status: 'accepted', receipt: { state: 'unknown', error: { code: 'REVOKED' } } })
    expect(f.service.receipt('device', 'stop')).toBeNull()
  })
  it('evicts the oldest settled receipt under capacity pressure and retains unresolved ones', async () => {
    let now = 1
    const f = fixture(() => now++)
    for (let i = 0; i < 512; i++) {
      await f.service.request('device', f.send({ idempotencyKey: `key${i}` }))
      if (i > 0) f.service.delivery({ deliveryId: f.submit.mock.calls[i][2], sessionId: 'agent', state: 'rejected' })
    }
    expect((await f.service.request('device', f.send({ idempotencyKey: 'new' }))).status).toBe('accepted')
    expect(f.service.receipt('device', 'key0')?.state).toBe('queued')
    expect(f.service.receipt('device', 'key1')).toBeNull()
    expect((await f.service.request('device', f.send({ idempotencyKey: 'key0' }))).status).toBe('duplicate')
  })
  it('refuses new work if all 512 reservations remain ambiguous or live', async () => {
    const f = fixture()
    for (let i = 0; i < 512; i++) await f.service.request('device', f.send({ idempotencyKey: `key${i}` }))
    expect((await f.service.request('device', f.send({ idempotencyKey: 'overflow' }))).error).toMatchObject({ code: 'BACKPRESSURE' })
    expect(f.submit).toHaveBeenCalledTimes(512)
  })
})

describe('Autonomous device turn.summary carries the complete answer', () => {
  const card = { type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'clipped preview…', recap: 'Five US events' } }

  it('adds fullText to the summary event without touching the card the dial reads', () => {
    const f = fixture(undefined, 'Full answer listing all five events.')
    f.service.commander(card)
    const summary = f.events.find(e => e.kind === 'turn.summary')!
    const payload = summary.payload as Record<string, unknown>
    expect(payload.fullText).toBe('Full answer listing all five events.')
    // The originals travel unchanged — Desktop and the dial read these two and nothing else.
    expect(payload.text).toBe('clipped preview…')
    expect(payload.recap).toBe('Five US events')
    // The incoming card was NOT widened; only the event this service emits carries the new field.
    expect(card.payload).not.toHaveProperty('fullText')
  })

  it('omits the field entirely when no answer was recorded', () => {
    const f = fixture(undefined, undefined)
    f.service.commander(card)
    expect(f.events.find(e => e.kind === 'turn.summary')!.payload).not.toHaveProperty('fullText')
  })
})

describe('Autonomous device agents.list carries the newest recap headline', () => {
  const build = (recent: (agentId: string, n: number) => unknown[]) => new AutonomousDeviceService({ machineId: 'machine',
    agents: () => [{ agentId: 'a', name: 'Alpha', engine: 'claude', state: 'idle' }, { agentId: 'b', name: 'Beta', engine: 'codex', state: 'running' }],
    submit: vi.fn(), stop: async () => true, answer: async () => true, cancelDelivery: () => true, recent })
  const list = (service: AutonomousDeviceService) => service.request('device', { type: 'agents.list', requestId: randomUUID() })

  it('inlines each agent\'s latest recap, and only the headline', async () => {
    const recent = vi.fn((agentId: string) => agentId === 'a'
      ? [{ kind: 'summary', recap: 'Fixed the retry path', text: 'Fixed the retry path in client.ts and server.ts.', fullText: 'Fixed the retry path…\n\n- client.ts\n- server.ts' }]
      : [])
    const result = await list(build(recent))
    expect(result.agents).toEqual([
      { machineId: 'machine', agentId: 'a', name: 'Alpha', engine: 'claude', state: 'idle', recap: 'Fixed the retry path' },
      // No summarised turn yet → no field at all, not an empty string.
      { machineId: 'machine', agentId: 'b', name: 'Beta', engine: 'codex', state: 'running' },
    ])
    // One turn per agent is all the list needs; the fuller views stay behind `recap`, where n ≤ 5 bounds them.
    expect(recent).toHaveBeenCalledWith('a', 1)
    expect(recent).toHaveBeenCalledWith('b', 1)
  })

  it('flattens and caps the headline so the list stays inside the socket\'s frame budget', async () => {
    const long = 'word '.repeat(80).trim()
    const result = await list(build(() => [{ kind: 'summary', recap: `two\n lines  ${long}`, text: '' }]))
    const rows = result.agents as Array<{ recap?: string }>
    expect(rows[0].recap!.startsWith('two lines word')).toBe(true)
    expect(rows[0].recap!.length).toBe(200)
  })

  it('treats a malformed recent row as no recap', async () => {
    const result = await list(build(() => ['not an object', { kind: 'summary', recap: 42 }]))
    expect((result.agents as Array<Record<string, unknown>>)[0]).not.toHaveProperty('recap')
  })
})

describe('Autonomous device app focus', () => {
  it('exposes revisions, remote focus, owner-aware clear and server identity', async () => {
    const f = fixture()
    const read = () => f.service.request('device', { type: 'focus.get', requestId: randomUUID() })
    const empty = await read()
    expect(empty.focus).toBeNull()
    f.service.appFocus('machine', 'agent', 'window-a')
    const first = await read()
    expect(first.focus).toEqual({ machineId: 'machine', agentId: 'agent', name: 'Project' })
    expect(first.focusRevision).not.toBe(empty.focusRevision)
    f.service.appFocus('remote', 'remote-agent', 'window-b')
    f.service.appFocus('machine', null, 'window-a')
    expect((await read()).focus).toEqual({ machineId: 'remote', agentId: 'remote-agent' })
    f.service.appFocus('remote', null, 'window-b')
    expect((await read()).focus).toBeNull()
    expect(f.events.filter(e => e.kind === 'focus.changed')).toHaveLength(3)
    expect(fixture().service.focusSnapshot().focusRevision).not.toBe(empty.focusRevision)
  })
  it('keeps the revision stable for reannounced focus while transferring ownership', () => {
    const f = fixture()
    f.service.appFocus('machine', 'agent', 'old-window')
    const before = f.service.focusSnapshot()
    f.service.appFocus('machine', 'agent', 'old-window')
    f.service.appFocus('machine', 'agent', 'new-window')
    f.service.appFocus('machine', null, 'old-window')
    expect(f.service.focusSnapshot()).toEqual(before)
    expect(f.events.filter(e => e.kind === 'focus.changed')).toHaveLength(1)
    f.service.appFocus('machine', null, 'new-window')
    expect(f.service.focusSnapshot().focus).toBeNull()
    expect(f.service.focusSnapshot().focusRevision).not.toBe(before.focusRevision)
  })
  it('guards sends before reservation, preserves duplicates, and rejects focus ABA', async () => {
    const f = fixture()
    f.service.appFocus('machine', 'agent', 'window')
    const { focusRevision } = f.service.focusSnapshot()
    expect((await f.service.request('device', f.send({ focusRevision }))).status).toBe('accepted')
    f.service.appFocus('machine', null, 'window')
    f.service.appFocus('machine', 'agent', 'window')
    expect((await f.service.request('device', f.send({ focusRevision }))).status).toBe('duplicate')
    expect((await f.service.request('device', f.send({ focusRevision, idempotencyKey: 'new' }))).error).toMatchObject({ code: 'FOCUS_CHANGED' })
    expect(f.service.receipt('device', 'new')).toBeNull()
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect((await f.service.request('device', f.send({ idempotencyKey: 'legacy' }))).status).toBe('accepted')
  })
  it('checks the target as well as the revision and guards question answers', async () => {
    const f = fixture()
    f.service.appFocus('remote', 'other', 'window')
    const { focusRevision } = f.service.focusSnapshot()
    expect((await f.service.request('device', f.send({ focusRevision }))).error).toMatchObject({ code: 'FOCUS_CHANGED' })
    f.service.commander({ type: 'commander_question', agentId: 'agent', payload: { requestId: 'q', questions: [] } })
    expect((await f.service.request('device', { type: 'question.answer', requestId: randomUUID(), machineId: 'machine', agentId: 'agent',
      idempotencyKey: 'answer', questionRequestId: 'q', answers: { choice: 'yes' }, focusRevision })).error).toMatchObject({ code: 'FOCUS_CHANGED' })
    expect(f.answer).not.toHaveBeenCalled()
    expect(f.service.receipt('device', 'answer')).toBeNull()
  })
  it('invalidates a deleted agent before dispatch', async () => {
    let agents = [{ agentId: 'agent', name: 'Project', engine: 'claude', state: 'idle' }]
    const submit = vi.fn()
    const service = new AutonomousDeviceService({ machineId: 'machine', agents: () => agents, submit,
      cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [] })
    service.appFocus('machine', 'agent', 'window')
    const { focusRevision } = service.focusSnapshot()
    agents = []
    expect((await service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent',
      text: 'hello', idempotencyKey: 'deleted', focusRevision })).error).toMatchObject({ code: 'FOCUS_CHANGED' })
    expect(service.focusSnapshot()).toMatchObject({ focus: null })
    expect(service.focusSnapshot().focusRevision).not.toBe(focusRevision)
    expect(submit).not.toHaveBeenCalled()
  })
})
