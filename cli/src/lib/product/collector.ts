/**
 * Sends the dial's behaviour events, and does not lose them when the machine is
 * offline.
 *
 * SPOOLED TO DISK, unlike the desktop app's queue — which says of itself: "Not
 * persisted across launches: a machine quit while offline loses what was
 * queued." That is a reasonable trade for a window somebody is sitting in front
 * of, and the wrong one here. A dial is driven on a laptop that is shut, moved,
 * and opened somewhere else; the sessions that happen with no network are not an
 * edge case, they are the ones worth measuring.
 *
 * FAILS QUIET, ALWAYS. Nothing here throws into a caller and nothing is awaited
 * by the cable session. An analytics detail must never be able to cost somebody
 * a turn, and this code sits directly under the path that carries their words.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { env } from '../../config/env.js'
import {
  PRODUCT_CATEGORY,
  isValidProductEvent,
  type ProductEvent,
} from './events.js'

/** Autonomous Analytics. One event per request — the service has no batch route. */
const ENDPOINT = 'https://autonomous-analytics-qffztaoryq-uc.a.run.app/api/v1/event_tracking'

/**
 * The same write key the desktop app ships.
 *
 * Which is the same one GRID ships, and that is a known, deliberate state rather
 * than an oversight: both desktop apps append into one analytics project and are
 * separable only by `category`. It is recorded in the app's AnalyticsConfig with
 * the reasoning and a TODO; this file inherits both.
 */
const WRITE_KEY = 'tBCs0oLwgFgf1borYn54cjHz4fvWahyV'

/** How long one send may take. A wedged host must not hold a spool flush open. */
const SEND_TIMEOUT_MS = 8_000

/** Events kept on disk. Past this the oldest go — a backlog nobody will read. */
const MAX_SPOOLED = 500

/** How often the queue drains, when there is anything in it. */
const FLUSH_INTERVAL_MS = 30_000

export function productSpoolFile(): string {
  return join(env.ADAPTER_DATA_DIR, 'product', 'dial-events.json')
}

/**
 * The user's own switch, read from the DESKTOP APP's file.
 *
 * One switch for one person, not two. Somebody who turned tracking off in the
 * window has said what they want; asking them again in a CLI flag — or worse,
 * honouring it in one place and not the other — would make the setting a lie.
 */
export function trackingDisabled(): boolean {
  if (env.PRODUCT_ANALYTICS_DISABLED) return true
  try {
    const path = join(dirname(env.ADAPTER_DATA_DIR), 'desktop-app', 'analytics.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown }
    return parsed.enabled === false
  } catch {
    // Absent or unreadable is the normal state on a computer that has never run
    // the desktop app, and it means "not turned off" — not "refuse to send".
    return false
  }
}

export interface CollectorOptions {
  /**
   * The durable id for this computer — `~/.harness/computer-id`.
   *
   * Passed in rather than read here, and a callback rather than a value: the
   * daemon resolves it once and may do so after this is constructed. It is the
   * SAME file the desktop app uses for its `user_pseudo_id`, which is what makes
   * the dial's events and the window's events join without anything being
   * agreed between them.
   */
  computerId: () => string
  log?: (line: string) => void
  /** Test seam. Defaults to the real endpoint. */
  send?: (body: unknown) => Promise<boolean>
  now?: () => number
}

export class ProductCollector {
  private queue: ProductEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private flushing = false
  private started = false

  constructor(private readonly opts: CollectorOptions) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.queue = this.readSpool()
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    // Never the reason a daemon stays alive at shutdown.
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
    await this.flush()
    this.writeSpool()
  }

  /**
   * Queue one event. Never throws, never awaits.
   *
   * Dropped rather than corrected when malformed: an event with a bad name or a
   * non-scalar param is this daemon's own instrumentation being wrong, and
   * sending it would put a row nobody can query into a stream shared with two
   * other products.
   */
  track(event: ProductEvent): void {
    if (!this.started || trackingDisabled()) return
    if (!isValidProductEvent(event)) {
      this.opts.log?.(`[product] refusing a malformed event: ${event.name}`)
      return
    }
    this.queue.push(event)
    if (this.queue.length > MAX_SPOOLED) {
      // The OLDEST go. A backlog this deep means weeks offline, and the recent
      // events are the ones anybody will act on.
      this.queue.splice(0, this.queue.length - MAX_SPOOLED)
    }
    this.writeSpool()
  }

  /** For tests and for `stop`. */
  pending(): number {
    return this.queue.length
  }

  /**
   * Drain what is queued, oldest first, and stop at the first refusal.
   *
   * ORDER MATTERS AND SO DOES STOPPING. These are a person's session in
   * sequence; sending the newest because the oldest failed would leave the
   * stream out of order for as long as the failure lasts. One failure means the
   * network or the service, so the rest would fail too.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    if (trackingDisabled()) {
      this.queue = []
      this.writeSpool()
      return
    }
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const event = this.queue[0]
        const ok = await this.post(event)
        if (!ok) break
        this.queue.shift()
      }
      this.writeSpool()
    } finally {
      this.flushing = false
    }
  }

  private async post(event: ProductEvent): Promise<boolean> {
    const body = {
      event_name: event.name,
      event_timestamp: event.at,
      user_pseudo_id: this.opts.computerId(),
      category: PRODUCT_CATEGORY,
      params: event.params,
    }
    if (this.opts.send) {
      try {
        return await this.opts.send(body)
      } catch {
        return false
      }
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        // Verbatim, with no `Bearer` prefix — what the service reads and what
        // every other client sends.
        headers: { 'content-type': 'application/json', authorization: WRITE_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      // A 4xx that is not 408/429 means THIS event is wrong, and retrying it
      // forever would block every event behind it. Dropped and counted as sent.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        this.opts.log?.(`[product] ${event.name} refused (${res.status}) — dropping it`)
        return true
      }
      return res.ok
    } catch {
      return false
    }
  }

  private readSpool(): ProductEvent[] {
    try {
      const raw = JSON.parse(readFileSync(productSpoolFile(), 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter((e): e is ProductEvent => isValidProductEvent(e as ProductEvent))
    } catch {
      return []
    }
  }

  private writeSpool(): void {
    try {
      const path = productSpoolFile()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(this.queue))
    } catch {
      // A disk that will not take it is not worth a line every thirty seconds.
    }
  }
}
