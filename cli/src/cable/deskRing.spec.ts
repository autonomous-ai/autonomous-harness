import { describe, expect, it } from 'vitest'
import { deskRing } from './deskRing.js'

// The fixture from the design review, so a case here reads the same as the case
// that was approved:
//
//   machine mac : a1 a2 a3 a4 a5      machine vm : b1 b2 b3 b4
//   tiles       : [1]=a2 [2]=b1 [3]=a5 [4]=b2
const FLAT = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4']
const DESK = ['a2', 'b1', 'a5', 'b2']

describe('desk ring', () => {
  it('puts the tiles in the middle, in tile order', () => {
    // Tile order, NOT flat order: the dial walks the grid the eyes are on, and
    // a5 sits between b1 and b2 here because that is where its tile sits.
    const { order } = deskRing(FLAT, DESK)
    const desk = order.slice(order.indexOf('a2'), order.indexOf('a2') + 4)
    expect(desk).toEqual(DESK)
  })

  it('the step past the last tile is the next agent on that tile\'s machine', () => {
    // C2: off the tail from b2 (machine vm) lands on b3, not on some agent of
    // whichever machine happens to be first in the list.
    const { order, edgeOf } = deskRing(FLAT, DESK)
    expect(order[order.indexOf('b2') + 1]).toBe('b3')
    expect(edgeOf.get('b3')).toBe('tail')
  })

  it('the step before the first tile is the agent before it on ITS machine', () => {
    // C5: off the head from a2 (machine mac) lands on a1.
    const { order, edgeOf } = deskRing(FLAT, DESK)
    expect(order[order.indexOf('a2') - 1]).toBe('a1')
    expect(edgeOf.get('a1')).toBe('head')
  })

  it('holds each agent it carries once, and says which it does not carry', () => {
    // The ring is the desk plus the two directions off it. a3 and a4 sit BETWEEN
    // the first and last tile in list order, so they are in neither direction —
    // see the note in deskRing.ts for why neither end of the ring can hold them.
    const { order } = deskRing(FLAT, DESK)
    expect(order).toEqual(['a1', 'a2', 'b1', 'a5', 'b2', 'b3', 'b4'])
    expect(new Set(order).size).toBe(order.length)
    expect(order).not.toContain('a3')
    expect(order).not.toContain('a4')
  })

  it('hands back what it left off the walk, rather than losing it', () => {
    // The dial is still TOLD about these. It counts its agents on the overview
    // and lists them in the pull-down switcher, so dropping them outright made
    // it say "5 agents" to someone who has eleven.
    const { order, offRing } = deskRing(FLAT, DESK)
    expect(offRing).toEqual(['a3', 'a4'])
    expect([...order, ...offRing].sort()).toEqual([...FLAT].sort())
  })

  it('an agent belongs to the end of the desk it is reached from', () => {
    const { edgeOf } = deskRing(FLAT, DESK)
    // Past b2, the last tile: the rest of the list forward.
    expect(edgeOf.get('b3')).toBe('tail')
    expect(edgeOf.get('b4')).toBe('tail')
    // Before a2, the first tile: the list running back.
    expect(edgeOf.get('a1')).toBe('head')
    // Off the ring, so no end claims them and there is nothing to replace.
    expect(edgeOf.has('a3')).toBe(false)
    expect(edgeOf.has('a4')).toBe(false)
  })

  it('walks on into the next machine when a machine runs out', () => {
    // C4/D3: b2 is on `vm`, so the step off that tile is the rest of vm — and
    // when a machine runs out the list carries on into the next one, because it
    // is one list. It stops at the list's end, where Settings is.
    const { order } = deskRing(FLAT, DESK)
    expect(order.slice(order.indexOf('b2') + 1)).toEqual(['b3', 'b4'])
  })

  it('the walk ENDS instead of circling, which is what reaches Settings', () => {
    // The bug this rule exists for, found on the real dial: the arcs used to
    // wrap. Every step onto an off-desk agent puts it on the desk and re-forms
    // the ring, so a wrapping walk never reached an end — the thumb went round
    // eleven agents forever, and the Settings and Machines tiles, which the
    // carousel keeps AFTER the agents, could not be reached at all.
    const { order } = deskRing(FLAT, DESK)
    expect(new Set(order).size).toBe(order.length)
    // Both ends of the ring are the list's own ends in that direction, so one
    // more step off either is the overview on the left, Settings on the right.
    expect(order[0]).toBe('a1')
    expect(order[order.length - 1]).toBe('b4')
  })

  it('with nothing past the last tile, the leftovers tuck into the other arc', () => {
    // Mirror of the case above: b4 is the list's last agent AND a tile, so the
    // forward arc is empty and there is no "inside" on the right to tuck into.
    // The left arc takes them — one step in, so its first element is still the
    // list's first agent and the overview stays one step off the ring's end.
    const { order } = deskRing(FLAT, ['a3', 'b4'])
    expect(order[0]).toBe('a1')
    expect(order[order.length - 1]).toBe('b4')
    // The step left off a3 is still the agent before it in the list.
    expect(order[order.indexOf('a3') - 1]).toBe('a2')
  })

  it('a desk holding BOTH ends of the list is the whole ring', () => {
    // Reported twice from the dial, once from each side: tile 1 was the first
    // agent in the list and tile 4 the last, so there is nothing to the left of
    // the first tile and nothing to the right of the last one. The swipe then
    // walks the open tiles and nothing else — one step off either end is the
    // overview or Settings, which is what the end of the list means.
    const desk = ['a1', 'a3', 'b1', 'b4']
    const { order, edgeOf } = deskRing(FLAT, desk)
    expect(order).toEqual(desk)
    // No end is left to claim, so nothing off the ring can claim one.
    expect(edgeOf.size).toBe(0)
  })

  it('one agent past the desk is that step, and the ring end', () => {
    const desk = ['a1', 'a3', 'b1', 'b3']
    const { order, edgeOf } = deskRing(FLAT, desk)
    expect(order).toEqual([...desk, 'b4'])
    expect(edgeOf.get('b4')).toBe('tail')
  })

  it('a walk off the last tile reaches the other machine before Settings', () => {
    // The exact shape on the dial when this was reported, ids and all: nine
    // agents on this computer and two on `machine-remote-3`, four tiles open,
    // the last of them `fa69` on that remote machine.
    const flat = [
      '5899', '37c1', 'dbae', 'acf6', 'f9aa', 'b884', '562d', 'a9e2', '9e01', // this computer
      'fa69', 'f3c3', // machine-remote-3
    ]
    const { order } = deskRing(flat, ['5899', 'acf6', 'b884', 'fa69'])
    // One step right off the last tile is that machine's remaining agent, and
    // the ring ends there — so the step after it is Settings.
    expect(order[order.indexOf('fa69') + 1]).toBe('f3c3')
    expect(order[order.length - 1]).toBe('f3c3')
    // And one step LEFT off the first tile is the overview, because `5899` is
    // the first agent in the list: exactly the report this rule came from.
    expect(order[0]).toBe('5899')
  })

  it('the left end is CLEAR when the first tile is the first agent', () => {
    // Straight from the dial: pane 1 held the first agent in the list, and a
    // swipe left landed on some other machine's agent instead of the overview.
    // Leftovers used to be parked at the far left, which put one of them
    // between the first tile and the overview the carousel keeps before the
    // agents.
    const { order } = deskRing(FLAT, ['a1', 'b2']);
    expect(order[0]).toBe('a1')
  })

  it('the walk back ENDS at the start of the list, before the overview', () => {
    const { order } = deskRing(FLAT, ['a3'])
    // Left off the only tile: a2, then a1, then the carousel's own overview.
    const at = order.indexOf('a3')
    expect(order.slice(0, at)).toEqual(['a1', 'a2'])
  })

  it('a single tile makes the dial a plain browser of the list', () => {
    // C6: one tile means both edges are the same tile, so both directions
    // replace it. Everything belongs to the forward arc; nothing is listed
    // twice.
    const { order, edgeOf } = deskRing(FLAT, ['a3'])
    expect([...order].sort()).toEqual([...FLAT].sort())
    expect(new Set(order).size).toBe(order.length)
    // One step each way off the only tile is one step each way in the list.
    const at = order.indexOf('a3')
    expect(order[at + 1]).toBe('a4')
    expect(order[at - 1]).toBe('a2')
    // Both edges are the same tile, so whichever way the thumb goes the window
    // replaces that tile — the dial is a plain browser of the list.
    expect(edgeOf.get('a4')).toBe('tail')
    expect(edgeOf.get('a2')).toBe('head')
  })

  it('with no tiles the flat list stands, and no agent claims an edge', () => {
    // C7/D4: there is no desk to walk off, so there is no edge tile to replace
    // — the window opens a new tile instead, and that is its call to make.
    const { order, edgeOf } = deskRing(FLAT, [])
    expect(order).toEqual(FLAT)
    expect(edgeOf.size).toBe(0)
  })

  it('ignores a tile naming an agent the list has never heard of', () => {
    // A tile can name an agent on a machine that has gone quiet. That is a
    // reason to leave it out of the ring, not to drop the ring.
    const { order } = deskRing(FLAT, ['a2', 'ghost', 'b1'])
    expect(order).toContain('a2')
    expect(order).toContain('b1')
    expect(order).not.toContain('ghost')
  })

  it('every tile open means a ring of exactly the tiles', () => {
    const { order, edgeOf } = deskRing(['a1', 'a2'], ['a2', 'a1'])
    expect(order).toEqual(['a2', 'a1'])
    expect(edgeOf.size).toBe(0)
  })
})
