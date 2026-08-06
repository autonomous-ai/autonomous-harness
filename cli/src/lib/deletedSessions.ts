/**
 * Sessions deleted moments ago — a short tombstone so a dying agent cannot re-register itself.
 *
 * Deleting an agent used to kill its tmux pane, which killed the engine almost instantly; nothing could
 * announce itself afterwards. Now the engine is asked to exit and keeps running for a second or two, and
 * in that window its hooks still fire. The catch hook (`UserPromptSubmit`) POSTs on every turn boundary
 * and is gated only on the LAUNCHER being alive — which it is — so without this the tile the user just
 * deleted comes straight back, and the resumed-session adoption loop would re-adopt it for good measure.
 *
 * Deliberately time-based and tiny: this is a race window, not a state machine. The entry is dropped as
 * soon as the process is confirmed gone, and expires on its own if that confirmation never comes.
 */

/** Long enough to outlast the whole delete sequence (ask, verify, SIGTERM, grace, SIGKILL) with margin. */
export const DELETED_TTL_MS = 15_000

const tombstones = new Map<string, number>()

function sweep(now: number): void {
  for (const [sessionId, expiresAt] of tombstones) if (expiresAt <= now) tombstones.delete(sessionId)
}

export function markDeleted(sessionId: string, ttlMs = DELETED_TTL_MS): void {
  const now = Date.now()
  sweep(now)
  tombstones.set(sessionId, now + ttlMs)
}

/** True while re-registering this session would resurrect something the user just deleted. */
export function isRecentlyDeleted(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  const expiresAt = tombstones.get(sessionId)
  if (expiresAt === undefined) return false
  if (expiresAt > Date.now()) return true
  tombstones.delete(sessionId)
  return false
}

/** The agent is provably gone — nothing left to resurrect, so stop blocking the id. */
export function clearDeleted(sessionId: string): void {
  tombstones.delete(sessionId)
}

/** Test seam. */
export function resetDeleted(): void {
  tombstones.clear()
}
