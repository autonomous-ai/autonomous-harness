import { describe, expect, it } from 'vitest'
import { ENGINES as CONTRACT_ENGINES, MODES, ORIGINS, TURN_OUTCOMES, utcDayKey } from './contract.js'
import { ENGINES } from '../../engines/types.js'
import { ENCRYPTED_UP_TYPES } from '../e2ee/core.js'

/**
 * Drift guards.
 *
 * `contract.ts` is a hand-kept mirror of `autonomous-code`'s copy — the two repositories share no
 * package — so nothing but a test stops the copies from diverging. A thirteenth engine that reaches
 * the CLI without reaching the analytics contract would silently report nothing, which the design
 * names as the most damaging failure this product can have.
 */
describe('engine parity', () => {
  it('counts exactly the engines this CLI integrates', () => {
    expect([...CONTRACT_ENGINES].sort()).toEqual([...ENGINES].sort())
  })
})

describe('lifecycle classification', () => {
  it('still counts at the layer that can see plaintext', () => {
    // If these frames stopped being encrypted the collector could in principle move; while they ARE
    // encrypted, the relay cannot count them and this collector is the only layer that can.
    expect(ENCRYPTED_UP_TYPES.has('turn_started')).toBe(true)
    expect(ENCRYPTED_UP_TYPES.has('turn_ended')).toBe(true)
  })
})

describe('vocabulary', () => {
  it('pins the dimensions the backend indexes on', () => {
    expect([...MODES]).toEqual(['self', 'managed', 'remote', 'provider'])
    expect([...ORIGINS]).toEqual(['human', 'scheduled', 'system', 'api'])
    expect([...TURN_OUTCOMES]).toEqual(['completed', 'failed', 'cancelled', 'input_required'])
  })

  it('agrees with the backend on what a day is', () => {
    // Both sides key records by UTC midnight; a local-time day would move a machine's records the
    // moment it travelled.
    expect(utcDayKey('2026-08-11T23:59:59Z')).toBe('2026-08-11')
    expect(utcDayKey('2026-08-12T00:00:00Z')).toBe('2026-08-12')
  })
})
