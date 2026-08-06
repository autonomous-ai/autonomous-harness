import { describe, expect, it } from 'vitest'
import { shouldReplayCommander } from './commanderReplay.js'

describe('shouldReplayCommander', () => {
  it('detects a new attach even when the aggregate count is unchanged', () => {
    expect(shouldReplayCommander(1, 1, 10, 11, false)).toBe(true)
    expect(shouldReplayCommander(1, 1, 11, 11, false)).toBe(false)
  })

  it('keeps count-rise compatibility when generation is absent', () => {
    expect(shouldReplayCommander(0, 1, undefined, undefined, false)).toBe(true)
  })

  it('forces one replay after transport reconnect but only with a commander present', () => {
    expect(shouldReplayCommander(1, 0, 10, 10, true)).toBe(false)
    expect(shouldReplayCommander(0, 1, 10, 10, true)).toBe(true)
  })
})
