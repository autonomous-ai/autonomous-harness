// The trust boundary. Everything here arrives from a third party at a URL the machine owner typed,
// and lands on the web UI and the physical device screen — so the assertions that matter are about
// what gets REFUSED, not what gets through.
import { describe, expect, it } from 'vitest'
import { ALLOWED_KINDS, MAX_CONSECUTIVE_INVALID, TERMINAL_KINDS, eventToFrame, mapEvent, turnOutcome } from './events.js'

const frames = (raw: unknown): Array<{ type: string; payload: Record<string, unknown> }> => {
  const m = mapEvent(raw)
  return m.kind === 'frames' || m.kind === 'terminal' ? m.frames as never : []
}
const one = (raw: unknown): { type: string; payload: Record<string, unknown> } | undefined => frames(raw)[0]

describe('the vocabulary and the switch cannot drift', () => {
  it('every allowed kind maps to a frame', () => {
    // The rule that keeps ALLOWED_KINDS honest: it is documentation unless something proves the
    // switch agrees with it. A kind added to the set but not the switch fails here.
    const carrier: Record<string, Record<string, unknown>> = {
      user_message: { text: 'hi' },
      thinking_delta: { text: 'mm' },
      thinking_title: { text: 'Considering' },
      text_delta: { text: 'out' },
      tool_start: { toolId: 'c1', tool: 'Read' },
      tool_end: { toolId: 'c1', ok: true },
      context_compact: {},
      done: { text: 'done' },
      recap_start: {},
      recap_end: { recap: 'r' },
    }
    for (const kind of ALLOWED_KINDS) {
      expect(eventToFrame({ kind, ...carrier[kind] }, kind), `${kind} maps to nothing`).toBeTruthy()
    }
  })

  it('an unrecognised kind is dropped, not forwarded', () => {
    expect(mapEvent({ kind: 'exec_shell', text: 'rm -rf /' }).kind).toBe('ignore')
  })

  it('a kind that is not a string is not a kind', () => {
    expect(mapEvent({ kind: 42, text: 'hi' }).kind).toBe('frames') // falls back to plain text
    expect(mapEvent({ kind: {}, text: '' }).kind).toBe('invalid')
  })

  it('a non-object is invalid rather than throwing', () => {
    for (const raw of [null, undefined, 'a string', 7, true]) {
      expect(mapEvent(raw).kind, String(raw)).toBe('invalid')
    }
  })

  it('bounds how much malformed input a provider may send', () => {
    expect(MAX_CONSECUTIVE_INVALID).toBeGreaterThan(0)
  })
})

describe('richness is opt-in', () => {
  it('a bare {text} renders as assistant output — the simplest correct implementation', () => {
    expect(one({ text: 'just words' })).toEqual({ type: 'text_delta', payload: { content: 'just words' } })
  })

  it('but an event carrying neither kind nor text is invalid', () => {
    expect(mapEvent({}).kind).toBe('invalid')
  })
})

describe('turn lifecycle is first-class, not derived', () => {
  it('each terminal kind ends the stream', () => {
    for (const kind of TERMINAL_KINDS) {
      expect(mapEvent({ kind }).kind, kind).toBe('terminal')
    }
  })

  it('turn_started renders nothing — it carries ids we already know', () => {
    expect(mapEvent({ kind: 'turn_started', turnId: 't', agentId: 'a' }).kind).toBe('ignore')
  })

  it('separates cancelled from failed, because the UI says different words', () => {
    const cancelled = mapEvent({ kind: 'turn_cancelled' })
    const failed = mapEvent({ kind: 'turn_failed', error: { message: 'boom' } })
    expect(cancelled.kind === 'terminal' && turnOutcome(cancelled.end)).toEqual({ aborted: true, failed: false })
    expect(failed.kind === 'terminal' && turnOutcome(failed.end)).toEqual({ aborted: false, failed: true })
  })

  it('input_required is NOT a failure — the turn is paused, not broken', () => {
    const m = mapEvent({ kind: 'turn_input_required', prompt: 'Delete 3 files?' })
    expect(m.kind).toBe('terminal')
    if (m.kind !== 'terminal') return
    expect(m.end).toEqual({ outcome: 'input_required', prompt: 'Delete 3 files?' })
    expect(turnOutcome(m.end)).toEqual({ aborted: false, failed: false })
  })
})

describe('tool calls', () => {
  it('drops a tool_start with no id — an unpaired call renders as a row that never resolves', () => {
    expect(one({ kind: 'tool_start', tool: 'Read' })).toBeUndefined()
  })

  it('drops a tool_end with no id for the same reason', () => {
    expect(one({ kind: 'tool_end', ok: true })).toBeUndefined()
  })

  it('carries the id through so start and end pair up even when tools overlap', () => {
    expect(one({ kind: 'tool_start', toolId: 'c7', tool: 'Bash' })!.payload)
      .toMatchObject({ id: 'c7', tool: 'Bash' })
  })

  it('treats ok:false as the error flag, and a MISSING ok as not-an-error', () => {
    // "The provider did not say" is not the same as "the provider said it failed".
    expect(one({ kind: 'tool_end', toolId: 'c7', ok: false })!.payload.isError).toBe(true)
    expect(one({ kind: 'tool_end', toolId: 'c7' })!.payload.isError).toBe(false)
  })

  it('names an unnamed tool rather than rendering a blank row', () => {
    expect(one({ kind: 'tool_end', toolId: 'c7' })!.payload.tool).toBe('tool')
  })
})

describe('the recap phase', () => {
  it('recap_end with no headline still produces a frame', () => {
    // An absent recap is the provider saying "nothing to show". Swallowing it would leave the
    // client's "preparing a recap" indicator open forever.
    expect(one({ kind: 'recap_end' })).toEqual({ type: 'recap_end', payload: {} })
  })

  it('carries the headline and the body separately, under the names agent.recap uses', () => {
    // `{recap, text}` — the identical object `agent.recap` hands back, so one mapper serves the
    // pushed recap and the pulled one.
    expect(one({ kind: 'recap_end', recap: 'Fixed it', text: 'The longer story.' })!.payload)
      .toEqual({ recap: 'Fixed it', text: 'The longer story.' })
  })
})

describe('empty payloads', () => {
  it('a delta with no text is dropped rather than emitted as an empty bubble', () => {
    expect(one({ kind: 'text_delta', text: '' })).toBeUndefined()
    expect(one({ kind: 'thinking_delta' })).toBeUndefined()
  })

  it('context_compact always says something, since it has no text of its own', () => {
    expect(one({ kind: 'context_compact' })!.payload.message).toBe('Context compacted')
  })
})
