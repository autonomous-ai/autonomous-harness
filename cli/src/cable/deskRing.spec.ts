import { describe, expect, it } from 'vitest'
import { deskRing } from './deskRing.js'

/** Every agent the daemon knows, in the order the dial reads them. */
const FLAT = ['a1', 'a2', 'a3', 'a4', 'a5']

describe('deskRing', () => {
  it('walks the window\'s tiles, in tile order', () => {
    const ring = deskRing(FLAT, ['a3', 'a1'])
    // TILE ORDER, not list order. The point of the ring is that a thumb walks the same grid the eyes
    // are looking at, so the window's arrangement wins over the daemon's.
    expect(ring.order).toEqual(['a3', 'a1'])
  })

  it('leaves every other agent off the walk, but does not drop it', () => {
    const ring = deskRing(FLAT, ['a2'])
    expect(ring.order).toEqual(['a2'])
    // Still sent, still counted on the overview, still in the pull-down switcher. Leaving them out of
    // the LIST is what once made a dial announce "5 agents" to someone who had eleven.
    expect(ring.offRing).toEqual(['a1', 'a3', 'a4', 'a5'])
  })

  it('walks everything when there are no tiles at all', () => {
    // A window that is shut, or a daemon nobody has opened one against. A ring built strictly from an
    // empty desk would be empty — eight agents on the machine and a carousel showing none of them,
    // which reads as a broken dial rather than as a closed window.
    const ring = deskRing(FLAT, [])
    expect(ring.order).toEqual(FLAT)
    expect(ring.offRing).toEqual([])
  })

  it('ignores tiles this daemon has never heard of', () => {
    // A tile can name an agent on a machine that has gone quiet. The ring is no place to learn that,
    // and a walk that stepped onto an id nothing can be looked up by lands on a blank tile.
    const ring = deskRing(FLAT, ['a2', 'ghost', 'a4'])
    expect(ring.order).toEqual(['a2', 'a4'])
    expect(ring.offRing).toEqual(['a1', 'a3', 'a5'])
  })

  it('falls back to the whole list when the desk names nothing real', () => {
    // Same as an empty desk, and it has to be: a window whose tiles are all on a machine that stopped
    // answering is a window with no usable desk.
    const ring = deskRing(FLAT, ['ghost', 'phantom'])
    expect(ring.order).toEqual(FLAT)
    expect(ring.offRing).toEqual([])
  })

  it('puts every agent in exactly one of the two groups', () => {
    // The session sends the count of the first group and the dial splits the pushed list on it, so an
    // id in both — or in neither — is a tile the dial either walks twice or cannot see.
    const ring = deskRing(FLAT, ['a4', 'a2'])
    expect([...ring.order, ...ring.offRing].sort()).toEqual([...FLAT].sort())
    expect(new Set(ring.order).size + new Set(ring.offRing).size).toBe(FLAT.length)
  })

  it('walks the whole list when every agent has a tile', () => {
    const ring = deskRing(FLAT, ['a5', 'a4', 'a3', 'a2', 'a1'])
    expect(ring.order).toEqual(['a5', 'a4', 'a3', 'a2', 'a1'])
    expect(ring.offRing).toEqual([])
  })
})
