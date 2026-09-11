/**
 * What the dial is used for — behaviour, not agent work.
 *
 * TWO ANALYTICS SYSTEMS LIVE IN THIS CLI AND THEY MEASURE DIFFERENT THINGS. The
 * one in `lib/analytics/` counts agent WORK: turns, runtimes, active agents,
 * aggregated per day and uploaded to this product's own backend. This one counts
 * what a PERSON did with the hardware, as individual events, and sends them to
 * Autonomous Analytics — the same stream the desktop app and the website report
 * into.
 *
 * They are separate directories on purpose. Six months from now the difference
 * between them is not going to be obvious from a function name, and the cost of
 * getting it wrong is a metric that silently means something else.
 *
 * COLLECTED HERE, NOT IN THE APP. `harness start` runs this daemon on its own and
 * the dial keeps working with the window closed — which is the most interesting
 * way the thing gets used, since a dial you can drive without opening an app is
 * most of its reason to exist. Relaying through the app would lose exactly that.
 *
 * THE IDENTITY JOINS FOR FREE. The id below is read from `~/.harness/computer-id`,
 * which is the same file the desktop app uses for its own `user_pseudo_id`. The
 * dial's events and the window's events land in one stream already keyed the
 * same way; nothing had to be agreed between them.
 *
 * WHAT NEVER LEAVES THIS PROCESS: a transcript, a recap, an agent's name, a
 * machine's name, the text of a card. Counts, durations, short codes and ids.
 * The rule is the desktop app's, written down once there and honoured here.
 */

/** Tells this stream apart from the app's (`harness-desktop`) and Grid's. */
export const PRODUCT_CATEGORY = 'harness-dial'

/** `snake_case`, 3–64 chars — the desktop app's rule, so one stream reads one way. */
export const PRODUCT_EVENT_NAME = /^[a-z][a-z0-9_]{2,63}$/

export interface ProductEvent {
  name: string
  params: Record<string, string | number | boolean>
  /** Client stamp, ms. The server clamps it; a spooled event keeps its own. */
  at: number
}

/**
 * The events this daemon sends, one function each.
 *
 * A closed list rather than free-form `track()` calls at the sites, for the
 * reason the app's `AnalyticsEvents` extension exists: two call sites that name
 * the same action differently is a stream nobody can query, and the only place
 * that can prevent it is the one place the names are written down.
 */
export const dialEvents = {
  /** A dial came up on the cable. */
  attached: (fw: string, proto: number): ProductEvent => ({
    name: 'dial_attached',
    params: { fw, proto },
    at: Date.now(),
  }),

  /**
   * It went away, and how long it had been there.
   *
   * `reason` is a short code — `unplugged`, `rebooting`, `error`, `shutdown` —
   * never a message, which can carry a device path.
   */
  detached: (reason: string, minutesAttached: number): ProductEvent => ({
    name: 'dial_detached',
    params: { reason, minutes_attached: Math.round(minutesAttached) },
    at: Date.now(),
  }),

  /**
   * Still here, and this much happened.
   *
   * The only way to answer "how long is it used for" without a timer per
   * gesture. `frames` separates a dial being driven from one sitting powered on
   * at the back of the desk — the two look identical in attach/detach alone.
   */
  heartbeat: (minutes: number, frames: number): ProductEvent => ({
    name: 'dial_heartbeat',
    params: { minutes: Math.round(minutes), frames },
    at: Date.now(),
  }),

  /** A turn sent from the dial. `via` is `voice` or `type`. */
  turnSent: (engine: string, via: string): ProductEvent => ({
    name: 'dial_turn_sent',
    params: { engine, via },
    at: Date.now(),
  }),

  /**
   * One voice capture, end to end.
   *
   * `routed` is `window` when the desktop palette decided and `host` when this
   * daemon fell back to deciding itself — which is the measurement the whole
   * window-route change was made blind. No transcript, and not its length.
   */
  voice: (outcome: string, seconds: number, routed: string): ProductEvent => ({
    name: 'dial_voice',
    params: { outcome, seconds: Math.round(seconds), routed },
    at: Date.now(),
  }),

  /**
   * The carousel was walked. `kind` is `scroll`, `swipe` or `focus`.
   *
   * `ring_depth` is how far from the overview tile the dial ended up, which is
   * the question behind the whole carousel: does anybody go past the first two
   * agents, or is the ring a feature built for a walk nobody takes.
   */
  navigated: (kind: string, ringDepth: number): ProductEvent => ({
    name: 'dial_navigated',
    params: { kind, ring_depth: ringDepth },
    at: Date.now(),
  }),

  /** The machine wheel was used at all. */
  machineSelected: (): ProductEvent => ({
    name: 'dial_machine_selected',
    params: {},
    at: Date.now(),
  }),

  /**
   * An agent was opened on the dial. `source` is `dial` or `app_follow`.
   *
   * WHICH SCREEN LEADS. Two surfaces show the same agent and either can move the
   * other; whether people drive from the dial or merely watch it follow the
   * window is the question that decides what the dial is for.
   */
  agentOpened: (source: string): ProductEvent => ({
    name: 'dial_agent_opened',
    params: { source },
    at: Date.now(),
  }),

  /** A question answered on the device rather than in the window. */
  answer: (outcome: string): ProductEvent => ({
    name: 'dial_answer',
    params: { outcome },
    at: Date.now(),
  }),

  /** A setting changed on the device — `brightness`, `scroll`, `language`. */
  settingChanged: (setting: string): ProductEvent => ({
    name: 'dial_setting_changed',
    params: { setting },
    at: Date.now(),
  }),

  /** An over-the-air update, and whether it landed. */
  firmwareUpdate: (from: string, to: string, outcome: string): ProductEvent => ({
    name: 'dial_fw_update',
    params: { from, to, outcome },
    at: Date.now(),
  }),

  /**
   * Something went wrong on the device, as a short code.
   *
   * WORTH ITS OWN EVENT because of one open bug: the dial freezes — screen dead,
   * touch dead, beeps still arriving — and after days of tracing there is still
   * no cause, largely because there is no DATA. Every report is an anecdote. A
   * code here, plus `detached`'s reason, turns it into a rate: how many dials,
   * how often, at what firmware, after how long attached.
   *
   * It does not fix the bug. It makes it measurable, which is the step that has
   * been missing.
   */
  fault: (code: string): ProductEvent => ({
    name: 'dial_fault',
    params: { code },
    at: Date.now(),
  }),
}

/** Names must be well-formed before anything is queued — see PRODUCT_EVENT_NAME. */
export function isValidProductEvent(event: ProductEvent): boolean {
  if (!PRODUCT_EVENT_NAME.test(event.name)) return false
  if (!Number.isFinite(event.at) || event.at <= 0) return false
  for (const value of Object.values(event.params)) {
    const t = typeof value
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return false
    if (t === 'number' && !Number.isFinite(value as number)) return false
  }
  return true
}
