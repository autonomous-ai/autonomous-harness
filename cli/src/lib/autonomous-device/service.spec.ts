import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from './service.js'

function fixture(now?: () => number, fullAnswer?: string) {
  const submit = vi.fn(), stop = vi.fn(async () => true), answer = vi.fn(async () => true)
  const events: AutonomousDeviceFrame[] = []
  const service = new AutonomousDeviceService({ now, machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Project', engine: 'claude', state: 'idle' }],
    submit, stop, answer, cancelDelivery: vi.fn(() => true), recent: () => [], fullText: () => fullAnswer, emit: f => events.push(f) })
  const send = (fields: Record<string, unknown> = {}) => ({ type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', text: 'hello', idempotencyKey: 'intent1', ...fields })
  return { service, submit, stop, answer, events, send }
}

describe('Autonomous device local-agent service', () => {
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
