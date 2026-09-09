import { describe, expect, it, vi } from 'vitest'
import { RemoteRelayPool } from './remoteRelay.js'

/** Minimal fake of the private `Entry` shape `noteTerminalResponse`/`demoteP2p` operate on — exercised
 *  directly (bypassing the class's `private` marker, the lightest way to unit-test this without a real
 *  WebRTC negotiation or a live relay socket) since the reporting logic under test is pure bookkeeping
 *  derived from `p2pStreams`/`p2pPendingOpens`, not anything that needs a real transport underneath it. */
function fakeEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ws: { send: vi.fn() },
    crypto: { wrapOutgoing: (frame: unknown) => frame },
    sink: { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) },
    onClosed: null,
    lingerTimer: null,
    alive: true,
    heartbeatTimer: null,
    p2p: null,
    p2pPolicy: null,
    p2pPendingOpens: new Set<string>(),
    p2pStreams: new Set<string>(),
    streams: new Set<string>(),
    p2pMigrating: new Map<string, number>(),
    p2pRetryCount: 0,
    p2pRetryLifetimeTotal: 0,
    p2pRetryTimer: null,
    ...overrides,
  }
}

describe('RemoteRelayPool reports terminal_link_mode to the local sink', () => {
  // Constructor args are never touched by the private methods under test — only entry-level state is.
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    noteTerminalResponse: (entry: ReturnType<typeof fakeEntry>, frame: Record<string, unknown>, transport: 'p2p' | 'relay') => void
    demoteP2p: (machineId: string, entry: ReturnType<typeof fakeEntry>, reason: string) => void
  }

  it('a terminal_ready confirmed on p2p reports mode:p2p, matching p2pStreams', () => {
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-1']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-1', streamId: 'stream-1' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-1')).toBe(true)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-1', mode: 'p2p' },
    })
  })

  it.each([
    ['relay', 'turn'],
    ['direct', 'p2p'],
    [null, 'p2p'],
  ])('a p2p terminal_ready whose ICE pair is %s reports mode:%s', (transport, expected) => {
    // The data channel is up either way; what differs is which candidate pair ICE nominated. A relay
    // pair means every byte is going through Cloudflare TURN, which is the state that costs money —
    // and the one the badge could not tell apart before. A null pair keeps the pre-TURN optimism.
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-turn']), p2p: { transport } })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-turn', streamId: 'stream-turn' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-turn')).toBe(true)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-turn', mode: expected },
    })
  })

  it('a stream with no data channel stays mode:relay however the ICE pair reads', () => {
    // Guards the additive rename: 'relay' must keep meaning "on the backend WebSocket" so an older
    // Desktop build can never read a TURN session as a WS one.
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-ws']), p2p: { transport: 'relay' } })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-ws', streamId: 'stream-ws' } }, 'relay')

    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-ws', mode: 'relay' },
    })
  })

  it('a terminal_ready delivered over relay reports mode:relay', () => {
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-2']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-2', streamId: 'stream-2' } }, 'relay')

    expect(entry.p2pStreams.has('stream-2')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-2', mode: 'relay' },
    })
  })

  it('a stale/unmatched requestId never reports p2p, even if the transport param says p2p', () => {
    const entry = fakeEntry() // no pending open for 'req-3' — delete() will return false
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-3', streamId: 'stream-3' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-3')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-3', mode: 'relay' },
    })
  })

  it('a non-ready frame for a p2p stream that arrives over relay quietly demotes just that stream, and reports it', () => {
    const entry = fakeEntry({ p2pStreams: new Set(['stream-4']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_alive', payload: { streamId: 'stream-4' } }, 'relay')

    expect(entry.p2pStreams.has('stream-4')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-4', mode: 'relay' },
    })
  })

  it('a frame for a stream not on p2p never spuriously reports anything', () => {
    const entry = fakeEntry()
    pool.noteTerminalResponse(entry, { type: 'terminal_output', payload: { streamId: 'stream-5' } }, 'relay')

    expect(entry.sink.sendFrame).not.toHaveBeenCalled()
  })

  it('demoteP2p reports mode:relay for every stream it drops', () => {
    const entry = fakeEntry({ p2pStreams: new Set(['stream-a', 'stream-b']) })
    pool.demoteP2p('machine-1', entry, 'send_failed')

    expect(entry.p2pStreams.size).toBe(0)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-a', mode: 'relay' },
    })
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-b', mode: 'relay' },
    })
  })

  it('demoteP2p on a connection with no active p2p streams reports nothing', () => {
    const entry = fakeEntry()
    pool.demoteP2p('machine-1', entry, 'send_failed')

    expect(entry.sink.sendFrame).not.toHaveBeenCalled()
  })
})

describe('RemoteRelayPool p2p retry policy', () => {
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    scheduleP2pRetry: (machineId: string, entry: ReturnType<typeof fakeEntry>) => void
    demoteP2p: (machineId: string, entry: ReturnType<typeof fakeEntry>, reason: string) => void
  }

  it('schedules up to 3 retries (i.e. 4 attempts total: 1 initial + 3 retries), then refuses a 4th', () => {
    vi.useFakeTimers()
    const RETRY_MAX = 3 // mirrors the unexported P2P_RETRY_MAX constant in remoteRelay.ts
    try {
      const entry = fakeEntry()
      // The initial attempt itself is NOT scheduled through scheduleP2pRetry (it fires unconditionally
      // at e2e_welcome) — this exercises only the retries that follow each subsequent failure.
      for (let i = 1; i <= RETRY_MAX; i++) {
        pool.scheduleP2pRetry('machine-1', entry)
        expect(entry.p2pRetryTimer, `retry #${i} should have been scheduled`).not.toBeNull()
        expect(entry.p2pRetryCount).toBe(i)
        vi.advanceTimersByTime(60_000)
        entry.p2pRetryTimer = null // the real timer callback nulls this before re-dialing; simulate that
      }
      pool.scheduleP2pRetry('machine-1', entry) // one retry past the cap — refused, quota spent
      expect(entry.p2pRetryTimer).toBeNull()
      expect(entry.p2pRetryCount).toBe(RETRY_MAX)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-schedule while a retry timer is already pending', () => {
    vi.useFakeTimers()
    try {
      const entry = fakeEntry()
      pool.scheduleP2pRetry('machine-1', entry)
      const firstTimer = entry.p2pRetryTimer
      pool.scheduleP2pRetry('machine-1', entry) // a second failure before the first retry even fires
      expect(entry.p2pRetryTimer).toBe(firstTimer)
      expect(entry.p2pRetryCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a success resets the short-term counter so a later demote gets a fresh budget', () => {
    const entry = fakeEntry({ p2pRetryCount: 3 }) // quota exhausted from a prior run of failures
    entry.p2pRetryCount = 0 // what startP2p's onState does on 'direct' — exercised here directly
    pool.scheduleP2pRetry('machine-1', entry)
    expect(entry.p2pRetryTimer).not.toBeNull()
    expect(entry.p2pRetryCount).toBe(1)
  })

  it('the lifetime cap stops scheduling even with a fresh short-term counter', () => {
    const entry = fakeEntry({ p2pRetryLifetimeTotal: 10 })
    pool.scheduleP2pRetry('machine-1', entry)
    expect(entry.p2pRetryTimer).toBeNull()
    expect(entry.p2pRetryCount).toBe(0)
  })

  it('demoteP2p (case B: was direct, then demoted) schedules a retry through the same policy', () => {
    const entry = fakeEntry({ p2pStreams: new Set(['stream-a']) })
    pool.demoteP2p('machine-1', entry, 'send_failed')
    expect(entry.p2pRetryTimer).not.toBeNull()
    expect(entry.p2pRetryCount).toBe(1)
  })
})

describe('RemoteRelayPool live-migration of already-open streams onto p2p', () => {
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    promoteOpenStreams: (machineId: string, entry: ReturnType<typeof fakeEntry>) => void
    commitMigration: (machineId: string, entry: ReturnType<typeof fakeEntry>, streamId: string) => void
    noteTerminalResponse: (entry: ReturnType<typeof fakeEntry>, frame: Record<string, unknown>, transport: 'p2p' | 'relay') => void
  }

  it('phase 1 sends terminal_resync over the CURRENT transport (relay) for every open, not-yet-p2p stream', () => {
    const entry = fakeEntry({ streams: new Set(['s1', 's2']), p2pStreams: new Set(['s2']) })
    pool.promoteOpenStreams('machine-1', entry)

    // s2 is already p2p — skipped. Only s1 (open, on relay) becomes a migration candidate.
    expect(entry.p2pMigrating.has('s1')).toBe(true)
    expect(entry.p2pMigrating.has('s2')).toBe(false)
    expect(entry.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal_resync', payload: { streamId: 's1' } }))
  })

  it('a stream already migrating or already p2p is not re-queued', () => {
    const entry = fakeEntry({ streams: new Set(['s1']), p2pMigrating: new Map([['s1', Date.now()]]) })
    pool.promoteOpenStreams('machine-1', entry)
    expect(entry.ws.send).not.toHaveBeenCalled()
  })

  it('phase 2 (commitMigration) sends a second resync over p2p and flips p2pStreams, but keeps p2pMigrating until confirmed', () => {
    const p2pSend = vi.fn(() => true)
    const entry = fakeEntry({
      streams: new Set(['s1']),
      p2pMigrating: new Map([['s1', Date.now()]]),
      p2p: { isReady: true, send: p2pSend },
    })
    pool.commitMigration('machine-1', entry, 's1')

    expect(entry.p2pStreams.has('s1')).toBe(true)
    expect(p2pSend).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal_resync', payload: { streamId: 's1' } }))
    expect(entry.p2pMigrating.has('s1')).toBe(true) // not confirmed yet — see next test
  })

  it('confirmation (a p2p-delivered frame for the stream) clears p2pMigrating and re-arms the demote-safety net', () => {
    const entry = fakeEntry({
      p2pStreams: new Set(['s1']),
      p2pMigrating: new Map([['s1', Date.now()]]),
    })
    pool.noteTerminalResponse(entry, { type: 'terminal_alive', payload: { streamId: 's1' } }, 'p2p')
    expect(entry.p2pMigrating.has('s1')).toBe(false)
  })

  it('commitMigration abandons just this stream if p2p is not ready, without touching other state', () => {
    const entry = fakeEntry({ streams: new Set(['s1']), p2pMigrating: new Map([['s1', Date.now()]]), p2p: null })
    pool.commitMigration('machine-1', entry, 's1')

    expect(entry.p2pStreams.has('s1')).toBe(false)
    expect(entry.p2pMigrating.has('s1')).toBe(false)
  })

  it('a relay frame for a stream mid-migration does NOT trigger the demote-on-mismatch rule', () => {
    const entry = fakeEntry({
      p2pStreams: new Set(['s1']),
      p2pMigrating: new Map([['s1', Date.now()]]),
    })
    pool.noteTerminalResponse(entry, { type: 'terminal_alive', payload: { streamId: 's1' } }, 'relay')

    // Without the p2pMigrating guard this would have deleted s1 from p2pStreams and reported 'relay'.
    expect(entry.p2pStreams.has('s1')).toBe(true)
    expect(entry.sink.sendFrame).not.toHaveBeenCalled()
  })
})
