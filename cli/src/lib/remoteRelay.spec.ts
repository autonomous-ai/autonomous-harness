import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRelayPool } from './remoteRelay.js'

/** Minimal fake of the private `Entry` shape `noteTerminalResponse`/`demoteP2p` operate on — exercised
 *  directly (bypassing the class's `private` marker, the lightest way to unit-test this without a real
 *  WebRTC negotiation or a live relay socket) since the reporting logic under test is pure bookkeeping
 *  derived from `p2pStreams`/`p2pPendingOpens`, not anything that needs a real transport underneath it. */
function fakeEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ws: { send: vi.fn() },
    crypto: { wrapOutgoing: (frame: unknown) => frame, encryptTerminal: () => new Uint8Array([1, 2, 3]) },
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
    upgradeAttempts: 0,
    upgradeTimer: null,
    upgradeShadow: null,
    upgradeDraining: new Map<string, number>(),
    upgradeWaitResolve: null as (() => void) | null,
    upgradeOrphan: null,
    upgradeDone: false,
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

/** Minimal fake of the TerminalP2pInitiator surface promoteToDirect()/scheduleUpgradeAttempt() touch —
 *  a real one requires a live WebRTC negotiation, exactly why startP2p() itself has no dedicated test at
 *  this level either; this mirrors that existing limit rather than trying to route around it. */
function fakeP2p(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: 'shadow-session',
    isReady: true,
    transport: 'direct',
    send: vi.fn(() => true),
    sendWithBackpressureRetry: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('RemoteRelayPool TURN-to-direct upgrade', () => {
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    scheduleUpgradeAttempt: (machineId: string, entry: ReturnType<typeof fakeEntry>) => void
    finishUpgradeAttempt: (machineId: string, entry: ReturnType<typeof fakeEntry>) => void
    promoteToDirect: (machineId: string, entry: ReturnType<typeof fakeEntry>, shadow: ReturnType<typeof fakeP2p>) => Promise<void>
    demoteP2p: (machineId: string, entry: ReturnType<typeof fakeEntry>, reason: string) => void
    // promoteToDirect() re-checks `this.entries.get(machineId) === entry` after every await (the same
    // liveness guard scheduleP2pRetry's timer callback uses) — these tests register the fake entry here
    // directly rather than going through a real dial(), the same shortcut fakeEntry() already takes.
    entries: Map<string, ReturnType<typeof fakeEntry>>
  }

  it('schedules up to 3 upgrade attempts, then gives up for good', () => {
    vi.useFakeTimers()
    const UPGRADE_MAX = 3 // mirrors the unexported P2P_UPGRADE_MAX_ATTEMPTS constant
    try {
      const entry = fakeEntry()
      for (let i = 1; i <= UPGRADE_MAX; i++) {
        pool.scheduleUpgradeAttempt('machine-1', entry)
        expect(entry.upgradeTimer, `attempt #${i} should have been scheduled`).not.toBeNull()
        vi.advanceTimersByTime(60_000)
        entry.upgradeTimer = null // the real callback nulls this before calling attemptUpgrade
        // attemptUpgrade() itself needs a real TerminalP2pInitiator to run — simulate what it does on a
        // failed trial (finishUpgradeAttempt is what decides whether to reschedule or give up).
        entry.upgradeAttempts = i
        pool.finishUpgradeAttempt('machine-1', entry)
      }
      expect(entry.upgradeDone).toBe(true)
      pool.scheduleUpgradeAttempt('machine-1', entry) // refused — done for good
      expect(entry.upgradeTimer).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule once upgradeDone, even with attempts left', () => {
    const entry = fakeEntry({ upgradeDone: true, upgradeAttempts: 1 })
    pool.scheduleUpgradeAttempt('machine-1', entry)
    expect(entry.upgradeTimer).toBeNull()
  })

  it('cuts over immediately when there are no open streams to drain', async () => {
    const old = fakeP2p({ sessionId: 'old-session' })
    const shadow = fakeP2p({ sessionId: 'shadow-session' })
    const entry = fakeEntry({ p2p: old, upgradeShadow: shadow })
    pool.entries.set('machine-1', entry)

    const promoted = pool.promoteToDirect('machine-1', entry, shadow)
    // No streams means no drain wait — only the promote-ack wait is outstanding.
    expect(entry.upgradeWaitResolve).not.toBeNull()
    expect(entry.p2p).toBe(shadow) // cutover already happened, ack notwithstanding
    entry.upgradeWaitResolve!()
    await promoted

    expect(old.stop).toHaveBeenCalledWith('upgraded', false)
    expect(entry.upgradeDone).toBe(true)
    expect(entry.upgradeOrphan).toBeNull()
  })

  it('drains open streams over the OLD connection before cutting over', async () => {
    const old = fakeP2p({ sessionId: 'old-session' })
    const shadow = fakeP2p({ sessionId: 'shadow-session' })
    const entry = fakeEntry({ p2p: old, upgradeShadow: shadow, p2pStreams: new Set(['s1']) })
    pool.entries.set('machine-1', entry)

    const promoted = pool.promoteToDirect('machine-1', entry, shadow)
    // Drain resync went out over the OLD connection — cutover has NOT happened yet.
    expect(old.send).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal_resync', payload: { streamId: 's1' } }))
    expect(entry.p2p).toBe(old)
    expect(entry.upgradeDraining.has('s1')).toBe(true)

    entry.upgradeWaitResolve!() // simulate the drain-confirmation keyframe arriving
    await Promise.resolve() // let promoteToDirect's await settle onto phase 2
    await Promise.resolve()

    expect(entry.p2p).toBe(shadow) // NOW cut over
    // Phase 2's resync for 's1' rides sessionFor() again — which now routes through entry.p2p (=shadow),
    // since p2pStreams still names 's1' and was never touched by the cutover.
    expect(shadow.send).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal_resync', payload: { streamId: 's1' } }))
    entry.upgradeWaitResolve!() // simulate the promote ack
    await promoted

    expect(old.stop).toHaveBeenCalledWith('upgraded', false)
  })

  it('a drain timeout leaves the old connection completely untouched', async () => {
    vi.useFakeTimers()
    try {
      const old = fakeP2p({ sessionId: 'old-session' })
      const shadow = fakeP2p({ sessionId: 'shadow-session' })
      const entry = fakeEntry({ p2p: old, upgradeShadow: shadow, p2pStreams: new Set(['s1']) })
      pool.entries.set('machine-1', entry)

      const promoted = pool.promoteToDirect('machine-1', entry, shadow)
      await vi.advanceTimersByTimeAsync(5_000)
      await promoted

      expect(entry.p2p).toBe(old) // never cut over
      expect(old.stop).not.toHaveBeenCalled()
      expect(shadow.stop).toHaveBeenCalledWith('upgrade_drain_timeout', true)
      expect(entry.upgradeShadow).toBeNull()
      expect(entry.upgradeDraining.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a promote-ack timeout keeps the old connection alive as an orphan rather than guessing it is safe to close', async () => {
    vi.useFakeTimers()
    try {
      const old = fakeP2p({ sessionId: 'old-session' })
      const shadow = fakeP2p({ sessionId: 'shadow-session' })
      const entry = fakeEntry({ p2p: old, upgradeShadow: shadow })
      pool.entries.set('machine-1', entry)

      const promoted = pool.promoteToDirect('machine-1', entry, shadow)
      await vi.advanceTimersByTimeAsync(5_000)
      await promoted

      expect(entry.p2p).toBe(shadow) // already cut over — no reason to roll back a proven-direct pair
      expect(old.stop).not.toHaveBeenCalled() // NOT guessed closed
      expect(entry.upgradeOrphan).toBe(old) // left for entry-teardown cleanup instead
      expect(entry.upgradeDone).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('demoteP2p cancels an in-flight upgrade trial without touching the primary retry policy', () => {
    const shadow = fakeP2p({ sessionId: 'shadow-session' })
    const entry = fakeEntry({ upgradeShadow: shadow, upgradeTimer: setTimeout(() => {}, 60_000) })

    pool.demoteP2p('machine-1', entry, 'send_failed')

    expect(shadow.stop).toHaveBeenCalledWith('primary_demoted', true)
    expect(entry.upgradeShadow).toBeNull()
    expect(entry.upgradeTimer).toBeNull()
  })
})

// Regression: a burst of large frames (a chunked upload's chunks, fired back-to-back) used to cross
// TERMINAL_P2P_MAX_BUFFERED_BYTES well before the real network drained the backlog, and a single
// resulting `send()` failure was misread as the whole p2p connection being dead — tearing it down for
// every stream, not just the one that hit backpressure. sendBinary must go through
// sendWithBackpressureRetry (which gives the channel one bounded chance to drain) rather than calling
// `send` directly, and must only fall back to relay + demote once that retry itself fails.
describe('RemoteRelayPool sendBinary backpressure handling', () => {
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    sessionFor: (machineId: string, entry: ReturnType<typeof fakeEntry>) => { sendBinary: (clear: { streamId: string }) => Promise<void> }
    demoteP2p: (machineId: string, entry: ReturnType<typeof fakeEntry>, reason: string) => void
  }

  // demoteP2p's own real behavior (resync-per-stream over ws, scheduleP2pRetry's real setTimeout) is
  // covered by the dedicated describe blocks above/below — stubbed out here to a no-op so these tests
  // observe only sendBinary's own routing decision, not demoteP2p's side effects or timers leaking
  // between tests.
  afterEach(() => { vi.restoreAllMocks() })

  it('sends over p2p via sendWithBackpressureRetry, not send, and never touches ws or demotes on success', async () => {
    const p2p = fakeP2p()
    const entry = fakeEntry({ p2p, p2pStreams: new Set(['stream-1']) })
    vi.spyOn(pool, 'demoteP2p').mockImplementation(() => {})
    await pool.sessionFor('machine-1', entry).sendBinary({ streamId: 'stream-1' })

    expect(p2p.sendWithBackpressureRetry).toHaveBeenCalledTimes(1)
    expect(p2p.send).not.toHaveBeenCalled()
    expect(entry.ws.send).not.toHaveBeenCalled()
    expect(pool.demoteP2p).not.toHaveBeenCalled()
  })

  it('falls back to ws and demotes only once sendWithBackpressureRetry itself fails', async () => {
    const p2p = fakeP2p({ sendWithBackpressureRetry: vi.fn(async () => false) })
    const entry = fakeEntry({ p2p, p2pStreams: new Set(['stream-1']) })
    const demoteP2p = vi.spyOn(pool, 'demoteP2p').mockImplementation(() => {})
    await pool.sessionFor('machine-1', entry).sendBinary({ streamId: 'stream-1' })

    expect(p2p.sendWithBackpressureRetry).toHaveBeenCalledTimes(1)
    expect(entry.ws.send).toHaveBeenCalledTimes(1) // the chunk still gets there, just over ws
    expect(demoteP2p).toHaveBeenCalledWith('machine-1', entry, 'send_failed')
  })

  it('goes straight to ws with no demotion for a stream that was never on p2p', async () => {
    const p2p = fakeP2p()
    const entry = fakeEntry({ p2p, p2pStreams: new Set() }) // this stream never made it onto p2pStreams
    const demoteP2p = vi.spyOn(pool, 'demoteP2p').mockImplementation(() => {})
    await pool.sessionFor('machine-1', entry).sendBinary({ streamId: 'stream-1' })

    expect(p2p.sendWithBackpressureRetry).not.toHaveBeenCalled()
    expect(entry.ws.send).toHaveBeenCalledTimes(1)
    expect(demoteP2p).not.toHaveBeenCalled()
  })
})
