import { describe, it, expect, vi, afterEach } from 'vitest'
import { startDeviceAuth, awaitApproval } from './deviceAuth.js'

const BASE = 'http://backend.test'

/** A fetch stub that answers the backend's `{ success, data }` envelope from a queue of payloads. */
function stubFetch(...payloads: Array<unknown | Error>): ReturnType<typeof vi.fn> {
  const queue = [...payloads]
  const fn = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return { ok: true, status: 200, json: async () => ({ success: true, data: next }) } as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Time is injected, so a ten-minute deadline costs no wall-clock. */
function fakeClock(stepMs = 0) {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += stepMs || ms },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('startDeviceAuth', () => {
  it('returns the code pair and posts the computer id', async () => {
    const fetchMock = stubFetch({ userCode: 'ABC123', deviceCode: 'f'.repeat(64), expiresIn: 600, interval: 2 })
    const out = await startDeviceAuth(BASE, 'my-computer-id', 'MacBook-Pro')

    expect(out).toEqual({ userCode: 'ABC123', deviceCode: 'f'.repeat(64), expiresIn: 600, interval: 2 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/device-auth/start`)
    expect(JSON.parse(String(init.body))).toEqual({ computerId: 'my-computer-id', label: 'MacBook-Pro' })
  })

  it('falls back to safe floors when the backend omits the timings', async () => {
    // A zero interval would otherwise become a tight spin loop against the backend.
    stubFetch({ userCode: 'ABC123', deviceCode: 'a'.repeat(64) })
    const out = await startDeviceAuth(BASE, 'id', 'box')
    expect(out.expiresIn).toBe(600)
    expect(out.interval).toBe(2)
  })

  it('rejects a response with no code rather than polling for something that cannot arrive', async () => {
    stubFetch({ expiresIn: 600 })
    await expect(startDeviceAuth(BASE, 'id', 'box')).rejects.toThrow(/pairing code/)
  })

  it('surfaces the backend error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: { message: 'computerId must be a hex computer fingerprint' } }),
    } as Response)))
    await expect(startDeviceAuth(BASE, 'nope', 'box')).rejects.toThrow(/hex computer fingerprint/)
  })
})

describe('awaitApproval', () => {
  it('polls through pending and returns the machine key on approval', async () => {
    const fetchMock = stubFetch(
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved', apiKey: 'k'.repeat(64), machineId: 'm'.repeat(32) },
    )
    const clock = fakeClock()

    const out = await awaitApproval(BASE, 'd'.repeat(64), {
      intervalSec: 2, expiresInSec: 600, ...clock,
    })

    expect(out).toEqual({ status: 'approved', apiKey: 'k'.repeat(64), machineId: 'm'.repeat(32) })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns denied with the reason', async () => {
    stubFetch({ status: 'denied', error: 'declined on the web' })
    const out = await awaitApproval(BASE, 'd'.repeat(64), { intervalSec: 2, expiresInSec: 600, ...fakeClock() })
    expect(out).toEqual({ status: 'denied', error: 'declined on the web' })
  })

  it('treats expired as terminal — it is also how an already-consumed code answers', async () => {
    const fetchMock = stubFetch({ status: 'expired' })
    const out = await awaitApproval(BASE, 'd'.repeat(64), { intervalSec: 2, expiresInSec: 600, ...fakeClock() })
    expect(out).toEqual({ status: 'expired' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps polling through a network blip', async () => {
    // A laptop that sleeps or changes wifi mid-approval must not lose the grant.
    const fetchMock = stubFetch(
      new Error('ECONNREFUSED'),
      new Error('ENOTFOUND'),
      { status: 'approved', apiKey: 'k'.repeat(64), machineId: 'm'.repeat(32) },
    )
    const out = await awaitApproval(BASE, 'd'.repeat(64), { intervalSec: 2, expiresInSec: 600, ...fakeClock() })
    expect(out.status).toBe('approved')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up at the deadline instead of polling forever', async () => {
    const fetchMock = stubFetch({ status: 'pending' })
    // 10s of budget at a 2s interval = 5 polls, then the deadline ends it.
    const out = await awaitApproval(BASE, 'd'.repeat(64), { intervalSec: 2, expiresInSec: 10, ...fakeClock() })
    expect(out).toEqual({ status: 'expired' })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('never polls faster than the 2s floor, whatever the backend advertises', async () => {
    const slept: number[] = []
    stubFetch({ status: 'pending' })
    let t = 0
    await awaitApproval(BASE, 'd'.repeat(64), {
      intervalSec: 0,
      expiresInSec: 10,
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms },
    })
    expect(slept.every((ms) => ms === 2000)).toBe(true)
  })

  it('honours an interval longer than the floor', async () => {
    const slept: number[] = []
    stubFetch({ status: 'pending' })
    let t = 0
    await awaitApproval(BASE, 'd'.repeat(64), {
      intervalSec: 5,
      expiresInSec: 10,
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms },
    })
    expect(slept).toEqual([5000, 5000])
  })
})
