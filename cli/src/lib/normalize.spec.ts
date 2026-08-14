import { describe, expect, it } from 'vitest'
import { foldTranscript, lineToEvents, newTurnState, type LiveEvent } from './normalize.js'

const userPrompt = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

const assistantText = (text: string, stopReason?: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason ?? null },
  })

/**
 * A first attach folds the whole transcript through `lineToEvents` and drops the events, so old turns
 * do not replay live. That is only safe while the history is complete. When a prompt lands during the
 * attach, the history ends mid-turn and the live turn's `turn_started` is in the part being dropped —
 * the commander mirror then never opens the turn and its close yields no recap. `cli.ts` recovers by
 * replaying the last `turn_started` when the folded state says a turn is still open, which needs both
 * halves of that contract to hold.
 */
describe('folding a transcript that ends mid-turn', () => {
  it('leaves the turn open and the last turn_started recoverable', () => {
    const state = newTurnState()
    const events: LiveEvent[] = []
    for (const line of [
      userPrompt('first question'),
      assistantText('first answer', 'end_turn'),
      userPrompt('second question'), // still running when the attach folded the file
      assistantText('partial answer'), // no terminal stop reason yet
    ]) {
      events.push(...lineToEvents(line, state))
    }

    expect(state.turnOpen).toBe(true)
    const opened = events.findLast((event) => event.type === 'turn_started')
    expect(opened).toEqual({ type: 'turn_started', payload: { userMessage: 'second question' } })
  })

  it('leaves no open turn when the history is complete', () => {
    const state = newTurnState()
    const events: LiveEvent[] = []
    for (const line of [userPrompt('a question'), assistantText('an answer', 'end_turn')]) {
      events.push(...lineToEvents(line, state))
    }

    // Nothing to recover: replaying here would resurrect a finished turn as a live one.
    expect(state.turnOpen).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['turn_started', 'text_delta', 'turn_ended'])
  })

  it('keeps the turn open while a tool call is unresolved', () => {
    // A turn parked in a tool has no terminal stop reason either, and it is just as live.
    const state = newTurnState()
    for (const line of [
      userPrompt('run something'),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
          stop_reason: 'tool_use',
        },
      }),
    ]) {
      lineToEvents(line, state)
    }

    expect(state.turnOpen).toBe(true)
    expect(state.pendingTools.size).toBe(1)
  })
})

/**
 * Cancelling a turn (device Stop, web C-c, or ESC in the terminal) leaves a synthetic user line in the
 * transcript. It carries no flag, so only its text tells it apart from a typed prompt — and reading it as
 * one opened a fresh turn the moment a turn was killed. The device then showed "Working" and counted
 * seconds forever, because no assistant would ever answer that turn and no recap would ever close it.
 */
describe('an interrupted turn', () => {
  const INTERRUPTS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]']

  for (const marker of INTERRUPTS) {
    it(`closes the turn instead of opening one: ${marker}`, () => {
      const state = newTurnState()
      const events: LiveEvent[] = []
      for (const line of [userPrompt('do a long thing'), assistantText('starting'), userPrompt(marker)]) {
        events.push(...lineToEvents(line, state))
      }

      expect(state.turnOpen).toBe(false)
      expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1)
      // `aborted` is what tells the mirror to clear the tile WITHOUT a recap or a done beep.
      expect(events.at(-1)).toEqual({ type: 'turn_ended', payload: { aborted: true } })
    })
  }

  it('emits nothing when no turn is open', () => {
    // Folding history on attach replays interrupts from turns that ended long ago; none of them may
    // close a turn that a later line opened, nor synthesize an event out of nothing.
    const state = newTurnState()
    expect(lineToEvents(userPrompt(INTERRUPTS[0]), state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })

  it('still treats a real prompt that only mentions an interrupt as a prompt', () => {
    const state = newTurnState()
    const events = lineToEvents(userPrompt('why do I keep seeing [Request interrupted by user]?'), state)
    expect(events[0]).toMatchObject({ type: 'turn_started' })
    expect(state.turnOpen).toBe(true)
  })
})

// Regression: a `/loop` fires every N minutes and each iteration is written as an isMeta user line.
// Blanket-suppressing isMeta made every iteration after the first invisible on the device — the loop ran
// fine in the terminal, produced no turn_started, and so produced no recap. Shapes taken verbatim from a
// real ~/.claude JSONL.
describe('a /loop iteration', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o)

  it('opens a turn: it is a real prompt the system submitted on the user behalf', () => {
    const st = newTurnState()
    const ev = lineToEvents(line({
      type: 'user', isMeta: true, promptSource: 'system', queuePriority: 'later',
      message: { role: 'user', content: 'Báo giá Bitcoin' },
    }), st)
    expect(ev.map((e) => e.type)).toContain('turn_started')
    expect(st.turnOpen).toBe(true)
  })

  it('still suppresses real bookkeeping meta — a slash command expansion has no promptSource', () => {
    const st = newTurnState()
    const ev = lineToEvents(line({
      type: 'user', isMeta: true, userType: 'external', entrypoint: 'cli',
      message: { role: 'user', content: [{ type: 'text', text: '# /loop — schedule a recurring prompt' }] },
    }), st)
    expect(ev).toEqual([])
    expect(st.turnOpen).toBe(false)
  })

  it('still suppresses the compact summary', () => {
    const st = newTurnState()
    expect(lineToEvents(line({
      type: 'user', isCompactSummary: true, promptSource: 'system',
      message: { role: 'user', content: 'This session is being continued…' },
    }), st)).toEqual([])
    expect(st.turnOpen).toBe(false)
  })
})

/**
 * Folding a transcript that already exists on disk.
 *
 * The default is silent: attaching to a session means catching up on turns the user has already seen, so
 * the events are swallowed and only a half-open turn is replayed. That is wrong for a transcript BORN
 * AFTER its agent — the file is then the live first turn, and swallowing it loses the question, the tool
 * cards and the answer with no trace at all, because no `turn_started` means no `turn_ended` and no recap
 * either. Measured on a real daemon: a codex attach logging `lines=8` over a completed first turn
 * produced not one line of output.
 */
describe('foldTranscript', () => {
  it('withholds the events as history by default, and reports the open turn', () => {
    const state = newTurnState()
    const out = foldTranscript((l) => lineToEvents(l, state), [userPrompt('hi')], () => state.turnOpen, { live: false })
    expect(out.live).toEqual([])
    expect(out.history.map((e) => e.type)).toContain('turn_started')
    expect(out.turnOpen).toBe(true)
  })

  it('hands the same events over for emission when the file is the live first turn', () => {
    const state = newTurnState()
    const out = foldTranscript((l) => lineToEvents(l, state), [userPrompt('hi')], () => state.turnOpen, { live: true })
    expect(out.history).toEqual([])
    expect(out.live.map((e) => e.type)).toContain('turn_started')
  })

  it('forces turnOpen false when live, so the caller does not replay turn_started twice', () => {
    // The caller's mid-turn rescue re-emits the last `turn_started` whenever turnOpen is true. Combined
    // with a live fold that already carries that event, the turn would open, close and open again —
    // exactly the 44ms double-start seen on a real claude pane.
    const state = newTurnState()
    const out = foldTranscript((l) => lineToEvents(l, state), [userPrompt('hi')], () => state.turnOpen, { live: true })
    expect(state.turnOpen).toBe(true)
    expect(out.turnOpen).toBe(false)
  })

  it('leaves the normalizer hydrated either way — the fold is what warms it up', () => {
    const history = newTurnState()
    const live = newTurnState()
    const lines = [userPrompt('hi')]
    foldTranscript((l) => lineToEvents(l, history), lines, () => history.turnOpen, { live: false })
    foldTranscript((l) => lineToEvents(l, live), lines, () => live.turnOpen, { live: true })
    expect(history.turnOpen).toBe(true)
    expect(live.turnOpen).toBe(true)
  })

  it('is a no-op on an empty transcript', () => {
    const state = newTurnState()
    const out = foldTranscript((l) => lineToEvents(l, state), [], () => state.turnOpen, { live: true })
    expect(out).toEqual({ history: [], live: [], turnOpen: false })
  })
})
