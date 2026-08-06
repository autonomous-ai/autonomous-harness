import type { LiveEvent } from '../../lib/normalize.js'
import {
  CursorNormalizer,
  type CursorTaskHook,
} from './normalizer.js'

interface CursorTaskHookQueueOptions {
  drainTranscript: (sessionId: string) => Promise<void>
  emit: (sessionId: string, events: LiveEvent[]) => void
  register: (sessionId: string, hook: CursorTaskHook, normalizer: CursorNormalizer) => void
  isActive: (sessionId: string) => boolean
  onError?: (sessionId: string, error: unknown) => void
}

/**
 * Cursor's preToolUse hook can beat the transcript watcher by one debounce window. Ingest the hook
 * immediately for stable-id dedupe, but serialize its visible start behind a transcript drain so the
 * parent user/text records always reach clients before Task cards.
 */
export class CursorTaskHookQueue {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly options: CursorTaskHookQueueOptions) {}

  enqueue(sessionId: string, hook: CursorTaskHook, normalizer: CursorNormalizer): void {
    const startEvents = normalizer.ingestTaskHook(hook)
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let current: Promise<void>
    current = previous
      .then(async () => {
        try {
          await this.options.drainTranscript(sessionId)
        } catch (error) {
          this.options.onError?.(sessionId, error)
        }
        if (!this.options.isActive(sessionId)) return
        this.options.emit(sessionId, startEvents)
        this.options.register(sessionId, hook, normalizer)
      })
      .catch((error) => this.options.onError?.(sessionId, error))
      .finally(() => {
        if (this.tails.get(sessionId) === current) this.tails.delete(sessionId)
      })
    this.tails.set(sessionId, current)
  }

  async wait(sessionId: string): Promise<void> {
    while (true) {
      const current = this.tails.get(sessionId)
      if (!current) return
      await current
      if (this.tails.get(sessionId) === current) return
    }
  }
}
