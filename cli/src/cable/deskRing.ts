/**
 * The order the dial's carousel walks, given what the window has on screen.
 *
 * The dial holds every agent on every machine in one flat ring. This turns that
 * flat list into a ring built around THE DESK — the agents the window has a tile
 * for, in tile order — so a thumb walking the dial walks the same grid the eyes
 * are looking at.
 *
 * Past either edge of the desk the ring continues into the agents that have no
 * tile, and WHICH ones depends on the edge you left from: forward from the last
 * tile picks up the flat list after that agent, backward from the first tile
 * picks it up before. Two boundary positions cut the flat list into two arcs,
 * one for each edge, so every agent is reachable from exactly one direction and
 * none is reachable twice.
 *
 * Landing on one of those agents is what puts it ON the desk — the window
 * replaces the tile at the edge it belongs to. Which is why the arcs matter
 * beyond ordering: the arc an agent sits in IS the answer to "which tile does
 * this replace", and it is an answer the daemon can give without the dial ever
 * reporting which way the thumb moved.
 */
export type DeskEdge = 'head' | 'tail'

export interface DeskRing {
  /** Ids in carousel order: head arc, then the desk, then the tail arc. */
  order: string[]
  /**
   * Agents the carousel does not walk: the ones between the desk's outermost
   * tiles in list order, which are in neither direction off an edge.
   *
   * They are still SENT to the dial — it keeps a tile's worth of knowledge for
   * every agent, and the overview's count and the pull-down switcher both read
   * that, so leaving them out made the dial say "5 agents" to someone who has
   * eleven. What they are left out of is the walk.
   */
  offRing: string[]
  /** Which edge an off-desk agent belongs to. Desk members are absent. */
  edgeOf: Map<string, DeskEdge>
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
  const edgeOf = new Map<string, DeskEdge>()

  // No tiles: nothing to build a ring around, and the flat list is already the
  // answer. Everything is off-desk, and landing on any of it opens a new tile
  // rather than replacing one — so neither edge applies.
  if (onDesk.length === 0) return { order: [...flat], offRing: [], edgeOf }

  const deskSet = new Set(onDesk)
  const rest = flat.filter((id) => !deskSet.has(id))
  const first = flat.indexOf(onDesk[0])
  const last = flat.indexOf(onDesk[onDesk.length - 1])

  // The arcs do NOT wrap, and that is the whole point of them.
  //
  // The dial's carousel is `overview → agents… → Settings → Machines`, so the
  // way back to those screens is off the END of the agents. A wrapping arc
  // never has an end: every step onto an off-desk agent puts it ON the desk,
  // the ring re-forms around it, and the walk begins again — measured on the
  // real dial, that is a thumb going round eleven agents forever with Settings
  // and Machines unreachable. So forward stops at the last agent in the list,
  // and the carousel's own wrap takes it from there.
  const pos = new Map(flat.map((id, at) => [id, at]));
  const firstPos = pos.get(onDesk[0])!
  const lastPos = pos.get(onDesk[onDesk.length - 1])!

  // Past the last tile: the list carrying on from THAT agent — the rest of its
  // machine, then the machines after it.
  const tail = rest.filter((id) => pos.get(id)! > lastPos)
  const claimed = new Set(tail)
  // Before the first tile: the list running back from it. Placed before the
  // desk, so one step left off the desk is one step back in the list.
  const head = rest.filter((id) => pos.get(id)! < firstPos && !claimed.has(id))
  for (const id of head) claimed.add(id)
  // Agents that lie BETWEEN the desk's outermost tiles in list order are not on
  // the ring at all.
  //
  // Stepping off a tile means "carry on through the list in that direction", so
  // an agent inside the desk's own span is in neither direction — it is not the
  // next thing left of the first tile, nor the next thing right of the last
  // one. Every attempt to give it a place put it at an END of the ring, and
  // both ends are spoken for: the carousel keeps the overview before the agents
  // and Settings after them, so an agent parked at either one stands between
  // the desk and the way back to those screens. Measured on the real dial,
  // twice, once from each side.
  //
  // They are returned as `offRing` rather than dropped: the dial is still told
  // about them, so the overview's count and the pull-down switcher stay honest.
  // They are simply not walked to — reach one from the window, or from that
  // switcher, and opening it puts it on the desk and back on the ring.
  // Which end an off-desk agent was reached from IS which tile it replaces. The
  // dial never reports the direction of the thumb and does not have to: its side
  // of the ring already says it.
  for (const id of tail) edgeOf.set(id, 'tail')
  for (const id of head) edgeOf.set(id, 'head')

  const order = [...head, ...onDesk, ...tail]
  const placed = new Set(order)
  return { order, offRing: rest.filter((id) => !placed.has(id)), edgeOf }
}
