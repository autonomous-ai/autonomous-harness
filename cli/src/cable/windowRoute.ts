/**
 * Hand a spoken task to the desktop window and wait for what it decided.
 *
 * WHY THIS EXISTS AT ALL. The dial used to pick the agent itself, with a copy of the router that never
 * got the fixes the window's ⌘B palette did: it weighed the whole agent list instead of the first
 * fifteen, spent every recap at full length instead of sixty characters, ran on a 12-second budget
 * instead of twenty — and, worst of the four, it always sent. An unsure route on the dial was still a
 * route, delivered to whichever agent scored highest, with nothing on the screen to say the machine had
 * guessed. The window can hold the same answer up and ask. So it decides now, and the dial is a
 * microphone with a screen.
 *
 * TWO FRAMES BACK, NOT ONE, and that is the whole design here. A single answer cannot separate "no
 * window is listening" from "the window is listening and a person is still reading the options" — and
 * those need opposite handling: the first must fall back to routing here, the second must NOT, because
 * falling back sends the turn to one agent while the person is about to send it to another. So the
 * window acks `taken` the moment its palette owns the words, and answers `sent`/`cancelled` when it is
 * done. No ack inside [TAKEN_MS] means nobody is there — including an older window build that has never
 * heard of any of this, which is exactly the rollout case that has to keep working.
 */

/** What the window did with the words. */
export type WindowRoute =
  /** It delivered them. The turn is ALREADY on its way — do not send it again here. */
  | { t: 'sent'; agentId: string }
  /** A person closed the palette without choosing. Nothing was sent, and nothing should be. */
  | { t: 'cancelled' }
  /** Nobody took it: no window, or one too old to understand. Route here instead. */
  | { t: 'unavailable' }
  /** It took the words and never came back. Say so; do NOT route here, or the pick still coming lands second. */
  | { t: 'abandoned' }

/** What the window says back, in the order it says it. */
export type WindowVoiceReply =
  | { t: 'taken' }
  | { t: 'sent'; agentId: string }
  | { t: 'cancelled' }

/**
 * How long a window has to say it took the task.
 *
 * Short on purpose: this is the delay a person waits through, holding a dial they just spoke into, ONLY
 * when the answer is going to be "nobody is home" — the palette acks as soon as it is built. Long enough
 * to survive a busy frame on the window's isolate, short enough that the fallback still feels immediate.
 */
export const TAKEN_MS = 2_000

/**
 * How long the window then has to decide.
 *
 * SIXTY SECONDS BECAUSE THAT IS THE DIAL'S OWN NUMBER — `VOICE_ROUTE_WAIT_MS` in the firmware, after
 * which it drops the sending overlay on its own. Waiting past it would leave this side hoping for an
 * answer the dial has already given up on, and the person looking at a screen that moved on. It is also
 * far past the 20s the classifier can spend, so everything but a human reading the options fits inside.
 */
export const ANSWER_MS = 60_000

export interface WindowRouterWiring {
  /** True while a desktop window on this computer is attached over loopback. */
  hasWindow: () => boolean
  /** Push the request to every attached window. */
  send: (voiceId: string, text: string, cmd: string) => void
  log: (line: string) => void
  /** Injected so tests do not spend real seconds. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface WindowRouter {
  /** Ask the window to route (and send) these words. Never rejects — a failure is one of the outcomes. */
  ask: (text: string, cmd?: string) => Promise<WindowRoute>
  /** A window answered. Unknown ids are ignored: a late reply to a request already settled is not an error. */
  reply: (voiceId: string, reply: WindowVoiceReply) => void
  /** Open requests, for tests and for the shutdown path. */
  pending: () => number
}

interface Waiter {
  taken: boolean
  settle: (route: WindowRoute) => void
  timer: { cancel: () => void }
}

function defaultTimer(fn: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(fn, ms)
  // Never hold the process open for a window that is not going to answer.
  handle.unref?.()
  return { cancel: () => clearTimeout(handle) }
}

let seq = 0

export function createWindowRouter(wiring: WindowRouterWiring): WindowRouter {
  const setTimer = wiring.setTimer ?? defaultTimer
  const waiters = new Map<string, Waiter>()

  const finish = (voiceId: string, route: WindowRoute): void => {
    const waiter = waiters.get(voiceId)
    if (!waiter) return
    waiters.delete(voiceId)
    waiter.timer.cancel()
    waiter.settle(route)
  }

  return {
    ask: (text, cmd) => {
      // Asked BEFORE anything is allocated: with no window there is nothing to wait for, and the caller
      // routes it itself in the same tick the dial finished uploading.
      if (!wiring.hasWindow()) {
        wiring.log('cable: no window attached — routing the spoken task here')
        return Promise.resolve<WindowRoute>({ t: 'unavailable' })
      }
      const voiceId = `v${Date.now().toString(36)}${(seq++).toString(36)}`
      return new Promise<WindowRoute>((resolve) => {
        const waiter: Waiter = {
          taken: false,
          settle: resolve,
          // ONE timer, re-armed on the ack rather than two running at once: the deadline that matters
          // changes when the window speaks up, and a stale second timer is how a settled request gets
          // settled again.
          timer: setTimer(() => {
            const held = waiters.get(voiceId)
            if (!held) return
            waiters.delete(voiceId)
            if (held.taken) {
              wiring.log(`cable: the window took the spoken task and never answered (${ANSWER_MS / 1000}s)`)
              held.settle({ t: 'abandoned' })
            } else {
              wiring.log('cable: no window answered in time — routing the spoken task here')
              held.settle({ t: 'unavailable' })
            }
          }, TAKEN_MS),
        }
        waiters.set(voiceId, waiter)
        wiring.send(voiceId, text, cmd ?? '')
      })
    },

    reply: (voiceId, reply) => {
      const waiter = waiters.get(voiceId)
      if (!waiter) return
      if (reply.t === 'taken') {
        // FIRST ONE WINS. Every attached window opens a palette, and only the one the person actually
        // used will answer; the rest are told to stand down when this one does. Re-acking here would
        // keep pushing the deadline out for as long as windows keep arriving.
        if (waiter.taken) return
        waiter.taken = true
        waiter.timer.cancel()
        waiter.timer = setTimer(() => {
          const held = waiters.get(voiceId)
          if (!held) return
          waiters.delete(voiceId)
          wiring.log(`cable: the window took the spoken task and never answered (${ANSWER_MS / 1000}s)`)
          held.settle({ t: 'abandoned' })
        }, ANSWER_MS)
        wiring.log('cable: the window took the spoken task')
        return
      }
      if (reply.t === 'sent') {
        if (!reply.agentId) { finish(voiceId, { t: 'cancelled' }); return }
        finish(voiceId, { t: 'sent', agentId: reply.agentId })
        return
      }
      finish(voiceId, { t: 'cancelled' })
    },

    pending: () => waiters.size,
  }
}
