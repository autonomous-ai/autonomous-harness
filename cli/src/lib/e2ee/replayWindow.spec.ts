import { describe, expect, it } from 'vitest'
import { E2EE_REPLAY_WINDOW_SIZE, ReplayWindow } from './replayWindow.js'

describe('E2EE replay window', () => {
  it('accepts authentic counters arriving out of order once, then rejects replays', () => {
    const window = new ReplayWindow()
    expect(window.allows(2)).toBe(true)
    window.commit(2)
    expect(window.allows(0)).toBe(true)
    window.commit(0)
    expect(window.allows(1)).toBe(true)
    window.commit(1)
    expect(window.allows(0)).toBe(false)
    expect(window.allows(2)).toBe(false)
  })

  it('rejects counters older than the bounded transport-reordering window', () => {
    const window = new ReplayWindow()
    window.commit(E2EE_REPLAY_WINDOW_SIZE + 7)
    expect(window.allows(7)).toBe(false)
    expect(window.allows(8)).toBe(true)
  })
})
