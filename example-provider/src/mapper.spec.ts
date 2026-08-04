// These run against a REAL recorded Claude turn (`__fixtures__/real-turn.jsonl`), not hand-written
// JSON. That matters: two genuine bugs in this mapper were invisible to invented fixtures and
// obvious the moment a real turn was replayed —
//
//   1. nearly EVERY stdout line carries `session_id`, so an early `if (line.session_id) return …`
//      swallowed every event and the turn produced nothing at all;
//   2. `tool_use` is announced twice (once by `content_block_start` with empty input, once by the
//      complete `assistant` message), so every tool rendered twice.
//
// Both are pinned below. Do not replace these fixtures with synthetic ones.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { messageToParts, pairToolNames, sessionIdOf, streamLineToOutcome, toolResultText, type StreamLine } from './mapper.js'
import type { Part } from './types.js'

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'real-turn.jsonl')

function replay(): { parts: Part[]; sessionId?: string; done?: { failed: boolean; detail?: string } } {
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamLine)
  const parts: Part[] = []
  let sessionId: string | undefined
  let done: { failed: boolean; detail?: string } | undefined
  for (const line of lines) {
    sessionId ??= sessionIdOf(line)
    const outcome = streamLineToOutcome(line)
    if (outcome.kind === 'parts') parts.push(...outcome.parts)
    if (outcome.kind === 'done') done = { failed: outcome.failed, detail: outcome.detail }
  }
  return { parts: pairToolNames(parts), sessionId, done }
}

const kindsOf = (parts: Part[]): Record<string, number> =>
  parts.reduce<Record<string, number>>((acc, p) => {
    const k = p.metadata?.['autonomous.ai/kind'] ?? '(none)'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})

describe('replaying a real recorded turn', () => {
  it('captures the Claude session id, which every later turn resumes from', () => {
    expect(replay().sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('produces a terminal outcome, so HP-102 can be satisfied', () => {
    const { done } = replay()
    expect(done).toBeDefined()
    expect(done!.failed).toBe(false)
  })

  it('emits assistant text', () => {
    const text = replay().parts.filter((p) => p.metadata?.['autonomous.ai/kind'] === 'text_delta').map((p) => p.text).join('')
    expect(text).toContain('note.txt')
  })

  it('does NOT swallow every event — regression on the session_id early-return', () => {
    // The bug produced exactly zero parts. Any non-trivial count proves the line is still reachable.
    expect(replay().parts.length).toBeGreaterThan(3)
  })

  it('emits each tool exactly once — regression on the double tool_use', () => {
    const kinds = kindsOf(replay().parts)
    expect(kinds.tool_start).toBe(1)
    expect(kinds.tool_end).toBe(1)
  })

  it('carries the tool arguments, not the empty ones from content_block_start', () => {
    const start = replay().parts.find((p) => p.metadata?.['autonomous.ai/kind'] === 'tool_start')
    expect(start?.metadata?.['autonomous.ai/tool']).toBe('Read')
    expect(JSON.stringify(start?.metadata?.['autonomous.ai/toolInput'])).toContain('note.txt')
  })

  it('pairs a tool_end back to its tool name, which the result block does not carry', () => {
    const end = replay().parts.find((p) => p.metadata?.['autonomous.ai/kind'] === 'tool_end')
    expect(end?.metadata?.['autonomous.ai/tool']).toBe('Read')
    expect(end?.metadata?.['autonomous.ai/toolCallId']).toBeTruthy()
  })

  it('ignores the line types that carry no conversation', () => {
    // system, rate_limit_event, message_start/stop, content_block_stop … all present in the fixture.
    const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamLine)
    const ignored = lines.filter((l) => streamLineToOutcome(l).kind === 'ignore')
    expect(ignored.length).toBeGreaterThan(lines.length / 2)
  })
})

describe('messageToParts — the shape shared by stdout and JSONL', () => {
  it('maps thinking, text, tool_use and tool_result', () => {
    const parts = messageToParts({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'weighing it up' },
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      ],
    })
    expect(kindsOf(parts)).toEqual({ thinking_delta: 1, text_delta: 1, tool_start: 1 })
  })

  it('marks a failed tool result and keeps its id', () => {
    const parts = messageToParts({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'boom' }],
    })
    expect(parts[0]!.metadata?.['autonomous.ai/isError']).toBe(true)
    expect(parts[0]!.metadata?.['autonomous.ai/toolCallId']).toBe('c1')
  })

  it('skips unknown block types instead of throwing', () => {
    // Claude's format is internal and can gain block types; a new one must degrade to "not
    // rendered", never to a broken turn.
    expect(() => messageToParts({ role: 'assistant', content: [{ type: 'something_new_in_2027' }] })).not.toThrow()
    expect(messageToParts({ role: 'assistant', content: [{ type: 'something_new_in_2027' }] })).toEqual([])
  })

  it('tolerates a missing or non-array content', () => {
    expect(messageToParts(undefined)).toEqual([])
    expect(messageToParts({ role: 'assistant' })).toEqual([])
  })

  it('normalises tool result content given as blocks or as a string', () => {
    expect(toolResultText('plain')).toBe('plain')
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(toolResultText(null)).toBe('')
  })
})

describe('sessionIdOf', () => {
  it('reads the id off any line that carries it', () => {
    expect(sessionIdOf({ type: 'system', session_id: 'abc' })).toBe('abc')
  })
  it('returns undefined rather than an empty string', () => {
    expect(sessionIdOf({ type: 'system', session_id: '' })).toBeUndefined()
    expect(sessionIdOf({ type: 'system' })).toBeUndefined()
  })
})
