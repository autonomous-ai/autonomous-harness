/** Decide whether an absolute `__clients` snapshot represents a commander that needs live-state replay. */
export function shouldReplayCommander(
  previousCount: number,
  nextCount: number,
  replayedGeneration: number | undefined,
  incomingGeneration: number | undefined,
  replayOnNextSnapshot: boolean,
): boolean {
  if (nextCount <= 0) return false
  if (replayOnNextSnapshot || nextCount > previousCount) return true
  return incomingGeneration != null && incomingGeneration !== replayedGeneration
}
