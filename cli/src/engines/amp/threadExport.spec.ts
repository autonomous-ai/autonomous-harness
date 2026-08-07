import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { ampThreadToEvents } from './threadExport.js'

/**
 * A REAL `amp threads export` payload — one web-search turn, home directory scrubbed and the scraped
 * page text trimmed. This is the shape history is served from, so the fixture is Amp's own export rather
 * than anything this adapter writes.
 */
function messages(): Record<string, unknown>[] {
  const p = fileURLToPath(new URL('../../lib/__fixtures__/amp-thread-export.json', import.meta.url))
  return (JSON.parse(readFileSync(p, 'utf-8')) as { messages: Record<string, unknown>[] }).messages
}

describe('amp thread export → history', () => {
  it('renders the turn as a conversation', () => {
    const events = ampThreadToEvents(messages())
    // The measured order. Note thinking lands AFTER the tool, not before it: the first assistant message
    // carries an empty `thinking` (withheld by the provider, dropped here) and the second carries the
    // real one alongside the answer.
    expect(events.map((e) => e.type)).toEqual([
      'user_message', 'tool_start', 'tool_end', 'thinking_delta', 'text_delta', 'done',
    ])
    expect(events[0]).toMatchObject({ payload: { content: 'gia BTC di' } })
  })

  /**
   * The point of reading Amp's store instead of the local transcript: `web_search` runs on Amp's server,
   * fires no client event, and so never reached the JSONL written by an older plugin. It is in the export.
   */
  it('carries the server-run tool the local transcript never saw', () => {
    const events = ampThreadToEvents(messages())
    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')
    expect(start).toMatchObject({ payload: { tool: 'WebSearch' } })
    expect(end).toMatchObject({ payload: { tool: 'WebSearch', isError: false } })
    expect((start as { payload: { id: string } }).payload.id)
      .toBe((end as { payload: { id: string } }).payload.id)
  })

  it('reduces the search result to its sources, from the export\'s nested shape', () => {
    const end = ampThreadToEvents(messages()).find((e) => e.type === 'tool_end')
    const output = (end as { payload: { output: string } }).payload.output
    // `{run:{result:[{title,url,excerpts}]}}` — one level deeper than the live event's shape.
    expect(output).toContain('https://')
    expect(output).not.toContain('excerpts')
  })

  it('drops reasoning the provider withheld instead of drawing an empty bubble', () => {
    // Amp exports reasoning under `thinking`, not `text`. It is often WITHHELD — an OpenAI-backed turn
    // carries `thinking: ""` and an opaque id — and an empty bubble is worse than none.
    const withheld = [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] }]
    expect(ampThreadToEvents(withheld).map((e) => e.type)).toEqual(['done'])
    // When it IS present it renders, which the fixture turn proves.
    expect(ampThreadToEvents(messages()).some((e) => e.type === 'thinking_delta')).toBe(true)
  })

  it('pairs a result by toolUseID, which is not the key other engines use', () => {
    const withSnakeCase = [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'TU-1', name: 'shell_command', input: { command: 'ls' } }],
    }, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'TU-1', run: { result: 'ok' } }],
    }]
    const events = ampThreadToEvents(withSnakeCase)
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ payload: { tool: 'Bash' } })
  })

  it('survives a thread with nothing in it', () => {
    expect(ampThreadToEvents([])).toEqual([{ type: 'done', payload: { result: 'success' } }])
  })
})
