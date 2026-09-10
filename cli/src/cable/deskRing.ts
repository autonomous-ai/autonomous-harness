/**
 * The order the dial's carousel walks, given what the window has on screen.
 *
 * ONE RULE: the carousel walks the window's tiles, in tile order, and nothing else. Swipe is "the next
 * pane", which is what a person watching four terminals already thinks it is.
 *
 * It used to be three: an arc of off-desk agents, then the desk, then another arc — a non-wrapping
 * shape that let a thumb walk past the end of the desk and pull an unopened agent onto it, with the arc
 * an agent sat in encoding WHICH tile it replaced so the dial never had to report which way the thumb
 * went. It worked, and it cost a concept (`DeskEdge`) that had to be understood in three repositories
 * to change anything here. Discovery by swiping is gone with it; the pull-down switcher still lists
 * every agent, and picking one there tells the window, which opens it — putting it on the desk, and so
 * on the ring, by the ordinary route.
 *
 * Agents with no tile are still SENT to the dial. They are counted on the overview and listed in that
 * switcher; leaving them out is what once made a dial announce "5 agents" to someone who had eleven.
 * What they are left out of is the walk.
 */
export interface DeskRing {
  /** Ids in carousel order: the desk, as the window has it. */
  order: string[]
  /** Agents the carousel does not walk. Still sent, still counted, simply not stepped onto. */
  offRing: string[]
}

/**
 * @param flat  every agent id, in the order the dial reads them today (this
 *              computer first, then each machine in wheel order).
 * @param desk  the window's tiles, in tile order. Ids the flat list does not
 *              know are ignored: a tile can name an agent on a machine that has
 *              gone quiet, and a ring is no place to learn that.
 */
export function deskRing(flat: string[], desk: string[]): DeskRing {
  const known = new Set(flat)
  const onDesk = desk.filter((id) => known.has(id))

  // NO TILES, NO RESTRICTION — and this fallback is not a nicety.
  //
  // A dial plugged into a computer whose window is shut has an empty desk, and a ring built strictly
  // from that desk would be empty: eight agents on the machine and a carousel showing none of them,
  // which reads as a broken dial rather than as a closed window. So with nothing to narrow to, the
  // walk is the whole list, exactly as it was before any of this existed.
  if (onDesk.length === 0) return { order: [...flat], offRing: [] }

  const deskSet = new Set(onDesk)
  return { order: onDesk, offRing: flat.filter((id) => !deskSet.has(id)) }
}
