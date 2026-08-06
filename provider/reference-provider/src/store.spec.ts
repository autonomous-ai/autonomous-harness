// The early-cancel bookkeeping, which is the one piece of state here that a client can grow without
// ever completing a turn: `turn.cancel` is deliberately accepted for a turnId nobody has sent, and
// that entry is otherwise only removed by a matching `agent.send`.
import { describe, expect, it, vi } from 'vitest'

const { EARLY_CANCEL_TTL_MS, Store } = await import('./store.js')

describe('a cancel that arrives before the send', () => {
  it('still stops the turn when the send follows', () => {
    const store = new Store()
    store.cancel('t-1')
    expect(store.takeEarlyCancel('t-1')).toBe(true)
    // Taken, not merely read: a second send with the same id is a new turn.
    expect(store.takeEarlyCancel('t-1')).toBe(false)
  })

  it('is forgotten once the send it belongs to is clearly never coming', () => {
    // Without this the map is a slow leak — a client cancelling turns it never sends grows it for the
    // lifetime of the process, and nothing in the protocol stops it doing so.
    vi.useFakeTimers()
    try {
      const store = new Store()
      store.cancel('t-old')

      vi.advanceTimersByTime(EARLY_CANCEL_TTL_MS + 1)
      // The sweep runs on write, which is the only moment the map can grow.
      store.cancel('t-new')

      expect(store.takeEarlyCancel('t-old')).toBe(false)
      // …and the sweep is not indiscriminate: the cancel that just arrived still works.
      expect(store.takeEarlyCancel('t-new')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an entry that is merely old, not expired', () => {
    vi.useFakeTimers()
    try {
      const store = new Store()
      store.cancel('t-1')
      vi.advanceTimersByTime(EARLY_CANCEL_TTL_MS - 1_000)
      store.cancel('t-2')
      expect(store.takeEarlyCancel('t-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
