import { describe, expect, it } from 'vitest'
import { ANSWER_MS, TAKEN_MS, createWindowRouter } from './windowRoute.js'

/** A hand-wound clock: every armed timer is kept so a test can fire exactly the one it means. */
function harness(opts: { hasWindow?: boolean } = {}) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const sent: Array<{ voiceId: string; text: string; cmd: string }> = []
  const logs: string[] = []
  const router = createWindowRouter({
    hasWindow: () => opts.hasWindow !== false,
    send: (voiceId, text, cmd) => sent.push({ voiceId, text, cmd }),
    log: (line) => logs.push(line),
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
  })
  /** Fire the newest timer still armed — the only one the module ever intends to be live. */
  const fireLive = () => {
    const live = [...timers].reverse().find((t) => !t.cancelled)
    if (!live) throw new Error('no live timer')
    live.fn()
  }
  const liveMs = () => [...timers].reverse().find((t) => !t.cancelled)?.ms
  return { router, sent, logs, timers, fireLive, liveMs }
}

describe('createWindowRouter', () => {
  it('does not even ask when no window is attached', async () => {
    const h = harness({ hasWindow: false })
    await expect(h.router.ask('fix the webhook')).resolves.toEqual({ t: 'unavailable' })
    expect(h.sent).toEqual([])
    expect(h.router.pending()).toBe(0)
  })

  it('sends the task, with the command word alongside it', async () => {
    const h = harness()
    void h.router.ask('tidy the tests', 'goal')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toBe('tidy the tests')
    expect(h.sent[0].cmd).toBe('goal')
    expect(h.sent[0].voiceId).not.toBe('')
  })

  it('falls back when nobody acks — an old window build must behave like no window at all', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    expect(h.liveMs()).toBe(TAKEN_MS)
    h.fireLive()
    await expect(answer).resolves.toEqual({ t: 'unavailable' })
    expect(h.router.pending()).toBe(0)
  })

  it('gives a window that acked the LONG deadline, not the short one', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    const voiceId = h.sent[0].voiceId
    h.router.reply(voiceId, { t: 'taken' })
    // The short timer is gone and the live deadline is now the human-sized one.
    expect(h.liveMs()).toBe(ANSWER_MS)
    h.fireLive()
    // ABANDONED, never `unavailable`: routing here now would race the pick the person is still making.
    await expect(answer).resolves.toEqual({ t: 'abandoned' })
  })

  it('carries back the agent the window sent to', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    h.router.reply(h.sent[0].voiceId, { t: 'taken' })
    h.router.reply(h.sent[0].voiceId, { t: 'sent', agentId: 'agent-7' })
    await expect(answer).resolves.toEqual({ t: 'sent', agentId: 'agent-7' })
    expect(h.router.pending()).toBe(0)
  })

  it('treats a closed palette as cancelled, and sends nothing', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    h.router.reply(h.sent[0].voiceId, { t: 'taken' })
    h.router.reply(h.sent[0].voiceId, { t: 'cancelled' })
    await expect(answer).resolves.toEqual({ t: 'cancelled' })
  })

  it('reads a `sent` with no agent as a cancel rather than delivering to nobody', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    h.router.reply(h.sent[0].voiceId, { t: 'sent', agentId: '' })
    await expect(answer).resolves.toEqual({ t: 'cancelled' })
  })

  it('can answer without acking first — the ack is a deadline, not a gate', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    h.router.reply(h.sent[0].voiceId, { t: 'sent', agentId: 'agent-2' })
    await expect(answer).resolves.toEqual({ t: 'sent', agentId: 'agent-2' })
  })

  it('ignores a reply that arrives after the request is settled', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    const voiceId = h.sent[0].voiceId
    h.router.reply(voiceId, { t: 'sent', agentId: 'agent-2' })
    await answer
    expect(() => h.router.reply(voiceId, { t: 'sent', agentId: 'agent-9' })).not.toThrow()
    expect(h.router.pending()).toBe(0)
  })

  it('ignores a reply for an id it never issued', () => {
    const h = harness()
    expect(() => h.router.reply('nope', { t: 'taken' })).not.toThrow()
  })

  it('lets the second window ack without pushing the deadline out again', async () => {
    const h = harness()
    const answer = h.router.ask('fix the webhook')
    const voiceId = h.sent[0].voiceId
    h.router.reply(voiceId, { t: 'taken' })
    const armed = h.timers.filter((t) => !t.cancelled).length
    h.router.reply(voiceId, { t: 'taken' })   // a second window, opening its own palette
    expect(h.timers.filter((t) => !t.cancelled).length).toBe(armed)
    // …and the first real answer still settles it exactly once.
    h.router.reply(voiceId, { t: 'sent', agentId: 'agent-1' })
    h.router.reply(voiceId, { t: 'cancelled' })
    await expect(answer).resolves.toEqual({ t: 'sent', agentId: 'agent-1' })
  })

  it('keeps two spoken tasks apart', async () => {
    const h = harness()
    const first = h.router.ask('one')
    const second = h.router.ask('two')
    expect(h.router.pending()).toBe(2)
    h.router.reply(h.sent[1].voiceId, { t: 'sent', agentId: 'b' })
    h.router.reply(h.sent[0].voiceId, { t: 'sent', agentId: 'a' })
    await expect(first).resolves.toEqual({ t: 'sent', agentId: 'a' })
    await expect(second).resolves.toEqual({ t: 'sent', agentId: 'b' })
  })
})
