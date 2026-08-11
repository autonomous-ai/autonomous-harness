import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dataDir = mkdtempSync(join(tmpdir(), 'harness-analytics-'))
process.env.ADAPTER_DATA_DIR = dataDir
process.env.ANALYTICS_BACKEND_URL = 'https://backend.test'
process.env.ANALYTICS_ENABLED = 'true'

const { AnalyticsCollector, analyticsBaseUrl, extractEpoch } = await import('./collector.js')
const { disableLocally, enableLocally, renderPreview, UPLOADED_FIELDS } = await import('./command.js')
const { ENGINES } = await import('../../engines/types.js')

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function sent(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, { body: string }]
  return JSON.parse(init.body)
}

let clock = Date.parse('2026-08-11T10:00:00Z')

function collector(token: string | null = 'a'.repeat(64)): InstanceType<typeof AnalyticsCollector> {
  const c = new AnalyticsCollector({
    token: () => token,
    enginesPresent: () => ['claude', 'kilo'],
    collectorVersion: '1.2.3',
    now: () => clock,
  })
  c.start()
  return c
}

beforeEach(() => {
  fetchMock.mockReset()
  clock = Date.parse('2026-08-11T10:00:00Z')
  // Consent is persisted on purpose — a restart must not re-upload what the owner turned off — so
  // each test starts from a clean data dir.
  rmSync(join(dataDir, 'analytics'), { recursive: true, force: true })
})

afterEach(() => {
  rmSync(join(dataDir, 'analytics'), { recursive: true, force: true })
})

describe('the funnel hook', () => {
  it('counts a completed turn from the per-session lifecycle events', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    clock += 20 * 60_000
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const day = (sent().days as { buckets: Record<string, number>[]; machineDay: Record<string, number> }[])[0]
    expect(day.buckets[0].turnsCompleted).toBe(1)
    expect(day.buckets[0].instructions).toBe(1)
    expect(day.machineDay.wallClockActiveMs).toBe(20 * 60_000)
    c.stop()
  })

  it('records an interrupted turn as cancelled, not completed', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'codex', 'agent-1')
    clock += 60_000
    c.sessionTurnEnded('s1', true)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const day = (sent().days as { buckets: Record<string, number>[] }[])[0]
    expect(day.buckets[0].turnsCancelled).toBe(1)
    expect(day.buckets[0].turnsCompleted).toBe(0)
    c.stop()
  })

  it('closes a leaked turn when the same session starts another one', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    clock += 60_000
    c.sessionTurnStarted('s1', 'claude', 'agent-1') // no turn_ended ever arrived
    clock += 60_000
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const day = (sent().days as { buckets: Record<string, number>[] }[])[0]
    expect(day.buckets[0].turnsFailed).toBe(1)
    expect(day.buckets[0].turnsCompleted).toBe(1)
    c.stop()
  })

  it('counts one active agent when two sessions belong to it', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)
    c.sessionTurnStarted('s2', 'codex', 'agent-1')
    c.sessionTurnEnded('s2', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const day = (sent().days as { machineDay: { activeAgents: number } }[])[0]
    expect(day.machineDay.activeAgents).toBe(1)
    c.stop()
  })
})

describe('payload', () => {
  it('claims coverage of every engine this CLI integrates', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const body = sent() as { collector: { engineCoverage: string[]; enginesPresent: string[]; version: string } }
    expect(body.collector.engineCoverage).toEqual([...ENGINES])
    expect(body.collector.enginesPresent).toEqual(['claude', 'kilo'])
    expect(body.collector.version).toBe('1.2.3')
    c.stop()
  })

  it('reports mode remote and never puts an agent id on the wire', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'a-very-identifying-agent-name')
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    const raw = JSON.stringify(sent())
    expect(raw).not.toContain('a-very-identifying-agent-name')
    expect(raw).not.toContain('s1')
    const day = (sent().days as { buckets: { mode: string }[] }[])[0]
    expect(day.buckets[0].mode).toBe('remote')
    c.stop()
  })

  it('derives the ingest endpoint from the backend socket host, not the socket itself', () => {
    expect(analyticsBaseUrl()).toBe('https://backend.test')
  })
})

describe('consent', () => {
  it('uploads from the first flush, with no opt-in step', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()

    expect((sent().days as unknown[]).length).toBe(1)
    c.stop()
  })

  it('stops collecting when the owner turns it off', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    respond({ data: { consent: 'off', epoch: 0, serverTime: '', accepted: 0, quarantined: 0 } })
    await c.flush()

    c.sessionTurnStarted('s2', 'claude', 'agent-1')
    c.sessionTurnEnded('s2', false)
    fetchMock.mockReset()
    await c.flush()

    expect(fetchMock).not.toHaveBeenCalled()
    c.stop()
  })

  it('obeys `harness analytics off` on this computer whatever the account says', async () => {
    const c = collector()
    disableLocally()

    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)
    await c.flush()
    expect(fetchMock).not.toHaveBeenCalled()

    enableLocally()
    c.sessionTurnStarted('s2', 'claude', 'agent-1')
    c.sessionTurnEnded('s2', false)
    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    c.stop()
  })

  it('drops its records when the account history was deleted', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    respond({ error: { message: 'Analytics history was reset; current epoch is 9' } }, 409)
    await c.flush()

    fetchMock.mockReset()
    await c.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    c.stop()
  })

  it('keeps the snapshot when the network is down', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'))
    await expect(c.flush()).resolves.toBeUndefined()

    respond({ data: { consent: 'on', epoch: 0, serverTime: '', accepted: 1, quarantined: 0 } })
    await c.flush()
    const day = (sent().days as { buckets: Record<string, number>[] }[])[0]
    expect(day.buckets[0].turnsCompleted).toBe(1)
    c.stop()
  })

  it('does not upload before this computer has joined', async () => {
    const c = collector(null)
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)

    await c.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    c.stop()
  })
})

describe('harness analytics preview', () => {
  it('shows every uploaded field and the never-sent list without contacting the backend', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    clock += 5 * 60_000
    c.sessionTurnEnded('s1', false)
    c.stop() // persists the snapshot the command reads

    const text = renderPreview()

    for (const field of UPLOADED_FIELDS) expect(text).toContain(field)
    expect(text).toContain('what you typed, and what any engine replied')
    expect(text).toContain('uploading')
    expect(text).toContain('2026-08-11')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so plainly when nothing has been recorded', () => {
    expect(renderPreview()).toContain('Nothing recorded yet')
  })

  it('deletes the local records when switched off', async () => {
    const c = collector()
    c.sessionTurnStarted('s1', 'claude', 'agent-1')
    c.sessionTurnEnded('s1', false)
    c.stop()

    expect(renderPreview()).not.toContain('Nothing recorded yet')
    disableLocally()
    expect(renderPreview()).toContain('Nothing recorded yet')
    enableLocally()
  })
})

describe('extractEpoch', () => {
  it('reads the epoch out of the 409 message', () => {
    expect(extractEpoch('Analytics history was reset; current epoch is 9')).toBe(9)
    expect(extractEpoch('nope')).toBeNull()
  })
})
