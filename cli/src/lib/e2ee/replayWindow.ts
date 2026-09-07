// P2P terminal frames and WebSocket RPC/control frames intentionally share one E2EE key/counter
// domain. They can arrive out of order across the two reliable transports, so a strict "highest
// counter wins" guard would discard authentic frames. This bounded window still rejects duplicates
// and stale counters without requiring transport-specific keys or counter resets during fallback.
export const E2EE_REPLAY_WINDOW_SIZE = 4_096

export class ReplayWindow {
  private highest = -1
  private prunedThrough = -1
  private readonly seen = new Set<number>()

  allows(counter: number): boolean {
    return Number.isSafeInteger(counter)
      && counter >= 0
      && !this.seen.has(counter)
      && (this.highest < 0 || counter > this.highest - E2EE_REPLAY_WINDOW_SIZE)
  }

  commit(counter: number): void {
    this.seen.add(counter)
    if (counter <= this.highest) return
    this.highest = counter
    const oldest = this.highest - E2EE_REPLAY_WINDOW_SIZE
    if (oldest <= this.prunedThrough) return
    // Sequential traffic deletes one integer per commit. A valid counter jumping far ahead makes the
    // entire old set stale; clear it instead of looping across a hostile-sized numeric gap.
    if (oldest - this.prunedThrough > E2EE_REPLAY_WINDOW_SIZE) {
      this.seen.clear()
      this.seen.add(counter)
    } else {
      for (let value = this.prunedThrough + 1; value <= oldest; value++) this.seen.delete(value)
    }
    this.prunedThrough = oldest
  }
}
