import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  AmpNormalizer, ampMessagesToEvents, ampRecord, ampToolName, ampToolOutput, ampWorkspaceRoot,
  lastAmpTurnText,
} from './normalizer.js'
import { parseAmpSession } from './runtimeProfile.js'

/**
 * Both fixtures are REAL transcripts, written by the adapter's own Amp plugin during a live tmux session
 * (amp 0.0.1786064749) with the home directory scrubbed. Nothing here is hand-written: Amp keeps no
 * conversation on disk, so these files are the only transcript that exists.
 */
function lines(name = 'amp-session'): string[] {
  const p = fileURLToPath(new URL(`../../lib/__fixtures__/${name}.jsonl`, import.meta.url))
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim())
}

describe('amp normalizer', () => {
  it('derives one turn from turn_start → turn_end', () => {
    const n = new AmpNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(1)
    expect(n.turnOpen).toBe(false)
    // The prompt reaches the turn, so web and device show what was asked.
    const started = events.find((e) => e.type === 'turn_started')
    expect(started).toMatchObject({ payload: { userMessage: 'cat a.txt' } })
  })

  it('pairs a tool call with its result under the SHARED tool name', () => {
    const n = new AmpNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')
    expect(start).toMatchObject({ payload: { tool: 'Bash' } })
    expect(end).toMatchObject({ payload: { tool: 'Bash', isError: false } })
    // Same id on both halves — the card can only close if these match.
    expect((start as { payload: { id: string } }).payload.id)
      .toBe((end as { payload: { id: string } }).payload.id)
  })

  it("renders shell output as text, not as the JSON envelope Amp wraps it in", () => {
    const n = new AmpNormalizer()
    const end = n.ingest(lines().find((l) => l.includes('"t":"tool_result"')) as string)
    // Before this was unwrapped the card showed {"output":"hello\n","exitCode":0}.
    expect(end[0]).toMatchObject({ payload: { output: 'hello\n' } })
  })

  it('emits the assistant text', () => {
    const n = new AmpNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const text = events.filter((e) => e.type === 'text_delta')
      .map((e) => (e as { payload: { content: string } }).payload.content).join('')
    expect(text).toContain('hello')
  })

  /**
   * The case that made the backstop necessary. Measured: a prompt typed while Amp is still connecting is
   * queued, and the queued message is dispatched with NO `agent.start` — so the transcript opens straight
   * into `thinking`. Without an implicit open, this whole turn renders as nothing at all.
   */
  it('opens a turn for a queued prompt that never announced itself', () => {
    const n = new AmpNormalizer()
    const raw = lines('amp-session-queued')
    expect(raw.some((l) => l.includes('"t":"turn_start"'))).toBe(false)
    const events = raw.flatMap((l) => n.ingest(l))
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_ended')).toHaveLength(1)
    expect(n.turnOpen).toBe(false)
  })

  it('replays a transcript as a conversation, not as a turn lifecycle', () => {
    const events = ampMessagesToEvents(lines())
    // The replay type has no turn frames at all — that it does not even typecheck is the point.
    expect(events.map((e) => e.type)).not.toContain('turn_started')
    expect(events[0]).toMatchObject({ type: 'user_message', payload: { content: 'cat a.txt' } })
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
  })

  it('reads the last turn for the recap', () => {
    const last = lastAmpTurnText(lines())
    expect(last?.userMessage).toBe('cat a.txt')
    expect(last?.assistantText).toContain('hello')
  })

  it('links a thread to its directory through the session record', () => {
    expect(ampWorkspaceRoot(lines()[0])).toBe('/home/user/demo')
    // Only the session record carries it; any other line must not be mistaken for one.
    expect(ampWorkspaceRoot(lines()[1])).toBeNull()
    expect(ampWorkspaceRoot('not json')).toBeNull()
  })

  it('ignores lines that are not records', () => {
    expect(ampRecord('')).toBeNull()
    expect(ampRecord('{"no":"type"}')).toBeNull()
    expect(new AmpNormalizer().ingest('garbage')).toEqual([])
  })
})

describe('amp tool names', () => {
  it('maps the measured tools onto the shared vocabulary', () => {
    expect(ampToolName('shell_command')).toBe('Bash')
    // The thread log spells the same tool differently from the wire; both must land on one card.
    expect(ampToolName('async_shell_command')).toBe('Bash')
    expect(ampToolName('apply_patch')).toBe('Edit')
    expect(ampToolName('Task')).toBe('Task')
  })

  it('leaves an unmeasured tool title-cased rather than guessing at it', () => {
    // `oracle` and `finder` are real Amp tools whose behaviour was never observed here. A wrong shared
    // name would draw a confidently wrong card; a title-cased one is merely plain.
    expect(ampToolName('oracle')).toBe('Oracle')
    expect(ampToolName('finder')).toBe('Finder')
    expect(ampToolName('')).toBe('Tool')
  })
})

describe('amp tool output', () => {
  it('unwraps the shapes Amp returns', () => {
    expect(ampToolOutput({ output: 'hello\n', exitCode: 0 })).toBe('hello\n')
    expect(ampToolOutput({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(ampToolOutput('plain')).toBe('plain')
    expect(ampToolOutput(undefined)).toBe('')
  })

  /**
   * A web search arrives in TWO different shapes depending on which path carried it — the `tool.result`
   * event hands over a JSON *string*, the message block hands over `{result:[…]}` — and both hold whole
   * scraped pages under `excerpts`. Rendered raw, one search filled the card with site chrome.
   */
  it('reduces a web search to its sources, from either shape', () => {
    const hits = [
      { title: 'Bitcoin price today', url: 'https://coinmarketcap.com/currencies/bitcoin/', excerpts: ['…pages of scraped text…'] },
      { title: 'Bitcoin | CoinGecko', url: 'https://www.coingecko.com/en/coins/bitcoin', excerpts: ['…more…'] },
    ]
    const expected = 'Bitcoin price today — https://coinmarketcap.com/currencies/bitcoin/\n'
      + 'Bitcoin | CoinGecko — https://www.coingecko.com/en/coins/bitcoin'
    expect(ampToolOutput(JSON.stringify(hits))).toBe(expected)          // the event path
    expect(ampToolOutput({ result: hits, status: 'done' })).toBe(expected) // the message-block path
  })

  it('leaves a string that merely looks like JSON alone', () => {
    expect(ampToolOutput('[1,2,3]')).toBe('[1,2,3]')
    expect(ampToolOutput('{"not":"a search"}')).toBe('{"not":"a search"}')
  })
})

describe('amp runtime profile', () => {
  it('reports the agent mode, which is all Amp exposes', () => {
    expect(parseAmpSession('{"agentMode":"medium","lastThreadId":"T-1"}')).toEqual({ mode: 'medium' })
    expect(parseAmpSession('{"agentMode":"ultra"}')).toEqual({ mode: 'ultra' })
  })

  it('reports nothing rather than a value it cannot vouch for', () => {
    expect(parseAmpSession('{"agentMode":"turbo"}')).toEqual({ mode: null })
    expect(parseAmpSession('not json')).toEqual({ mode: null })
    expect(parseAmpSession(null)).toEqual({ mode: null })
  })
})
