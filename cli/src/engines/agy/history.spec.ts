import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agyHistoryPage } from '../../backendSocket.js'

const LINES = readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/agy-session.jsonl', import.meta.url)), 'utf8')
  .split('\n').filter(Boolean)

describe('agy session_get', () => {
  // The web client always sends a `limit`, so it takes the PAGINATED branch. Handling only the full
  // branch opens an empty pane — the failure this test exists to prevent.
  it('answers both shapes with the same replay', () => {
    const full = agyHistoryPage(LINES, false)
    const page = agyHistoryPage(LINES, true)
    expect(full.events.length).toBeGreaterThan(10)
    expect(page.events).toEqual(full.events)
    expect(page.hasMore).toBe(false)
    expect(page.oldestCursor).toBeNull()
  })

  it('replays the conversation, not a lifecycle stream', () => {
    const { events } = agyHistoryPage(LINES, true)
    expect(events[0].type).toBe('user_message')
    expect(events[events.length - 1]).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(events.some((e) => e.type === 'tool_start')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
  })
})
