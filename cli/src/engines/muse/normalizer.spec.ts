import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  MuseNormalizer, lastMuseTurnText, museEvent, museMessagesToEvents, museToolName, museWorkspaceRoot,
} from './normalizer.js'
import { parseMuseSettings } from './runtimeProfile.js'

/**
 * A REAL muse session (0.1.0-R708.1), reduced to the records that carry an `event.kind` we act on and
 * with the home directory scrubbed. Everything asserted here was measured, not assumed — including the
 * fact that muse's own bundled docs name the turn-opening event `user_prompt_display`, which never
 * appears on disk. It is `started`.
 */
function lines(): string[] {
  const p = fileURLToPath(new URL('../../lib/__fixtures__/muse-session.jsonl', import.meta.url))
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim())
}

describe('muse normalizer', () => {
  it('derives the turn lifecycle from started → terminal', () => {
    const n = new MuseNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const starts = events.filter((e) => e.type === 'turn_started')
    const ends = events.filter((e) => e.type === 'turn_ended')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends).toHaveLength(starts.length)   // every turn that opened also closed
    expect(n.turnOpen).toBe(false)
    expect(String((starts[0].payload as { userMessage: string }).userMessage)).toBeTruthy()
  })

  it('pairs a tool call with its result by call_id', () => {
    // `assistant_tool_calls_committed.tool_calls[].call_id` ↔ `tool_result_batch_committed.results[].tool_call_id`
    // is the only link between the two records; nothing else ties them together.
    const n = new MuseNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')
    expect(start).toBeTruthy()
    expect(end).toBeTruthy()
    expect((end!.payload as { id: string }).id).toBe((start!.payload as { id: string }).id)
    // the result is reported under the name that opened the call, not a generic one
    expect((end!.payload as { tool: string }).tool).toBe((start!.payload as { tool: string }).tool)
  })

  it('parses the tool arguments instead of passing the raw JSON string', () => {
    // muse ships `args` as a STRING; leaving it that way shows a quoted blob on the card.
    const n = new MuseNormalizer()
    const start = lines().flatMap((l) => n.ingest(l)).find((e) => e.type === 'tool_start')
    expect(typeof (start!.payload as { input: unknown }).input).toBe('object')
  })

  it('marks a provider failure as an aborted turn', () => {
    // muse puts the provider error straight in `terminal.reason`, so a failed turn is visible without
    // tailing any log — but it must NOT be recapped as if it had finished normally.
    const n = new MuseNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const aborted = events.filter((e) => e.type === 'turn_ended' && (e.payload as { aborted?: true }).aborted)
    expect(aborted.length).toBeGreaterThan(0)
  })

  it('reads workspace_root from the first record — the only link to a project', () => {
    // The path is date-sharded (`sessions/YYYY/MM/DD/<uuid>/`), so nothing in it names the directory the
    // session belongs to. Discovery depends entirely on this field.
    expect(museWorkspaceRoot(lines()[0])).toContain('/Users/example')
    expect(museWorkspaceRoot('not json')).toBeNull()
  })

  it('ignores envelopes that carry no event, and never throws on junk', () => {
    expect(museEvent('')).toBeNull()
    expect(museEvent('{"payload":{}}')).toBeNull()
    expect(new MuseNormalizer().ingest('}{ broken')).toEqual([])
  })

  it('maps the planning tool onto the exact name the device checklist matches', () => {
    // A near-miss here shows no checklist at all, and reports no error — the failure hermes hit.
    // These names were READ OFF real sessions. Every one of them differs from what the other engines
    // call the same tool, so guessing by analogy produced three silent failures: no checklist, no
    // sub-agent row, and a question card in the tool feed instead of on the question screen.
    expect(museToolName('write_todos')).toBe('TodoWrite')
    expect(museToolName('subagent_spawn')).toBe('Task')
    expect(museToolName('request_user_input')).toBe('AskUserQuestion')
    expect(museToolName('web_search')).toBe('WebSearch')
    expect(museToolName('something_new')).toBe('Something_new')
  })

  it('replays as user_message + done, without deriving turns', () => {
    const events = museMessagesToEvents(lines())
    expect(events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(events.some((e) => e.type === 'user_message')).toBe(true)
    // SessionEvent has no turn_* member at all — replay is history, not a live lifecycle.
    expect(events.map((e) => e.type)).not.toContain('turn_started')
  })

  it('takes the recap from the last prompt and the text after it', () => {
    const turn = lastMuseTurnText(lines())
    expect(turn?.userMessage).toBeTruthy()
    expect(turn?.assistantText.length).toBeGreaterThan(0)
  })
})

describe('muse settings', () => {
  it('reads both axes, and reports muse\'s documented default when effort is absent', () => {
    // Verified shape: {"schema_version":1,"provider":"meta","model":"muse-spark-1.2-contributor"}
    expect(parseMuseSettings('{"schema_version":1,"provider":"meta","model":"muse-spark-1.2-contributor"}'))
      .toEqual({ model: 'muse-spark-1.2-contributor', effort: 'high' })
    expect(parseMuseSettings('{"model":"m","reasoning_effort":"XHIGH"}')).toEqual({ model: 'm', effort: 'xhigh' })
    expect(parseMuseSettings('{"model":"m","reasoning_effort":"bogus"}')).toEqual({ model: 'm', effort: 'high' })
    expect(parseMuseSettings('not json')).toEqual({ model: null, effort: null })
    expect(parseMuseSettings(null)).toEqual({ model: null, effort: null })
  })
})

describe('muse device rendering — the three lists the device draws', () => {
  it('reshapes todos onto the field the device reads', () => {
    // Muse names it `text`; the device reads `content`/`subject` and nothing else. Measured shape:
    // {"todos":[{"text":"Lập kế hoạch…","status":"in_progress"}]} — matching only the TOOL NAME leaves
    // the checklist empty with no error anywhere.
    const n = new MuseNormalizer()
    const todo = lines().flatMap((l) => n.ingest(l))
      .find((e) => e.type === 'tool_start' && (e.payload as { tool: string }).tool === 'TodoWrite')
    expect(todo).toBeTruthy()
    const todos = (todo!.payload as { input: { todos: Array<{ content: string; status: string }> } }).input.todos
    expect(todos.length).toBeGreaterThan(0)
    expect(todos.every((t) => t.content.length > 0)).toBe(true)
    expect(todos[0].status).toBeTruthy()
  })

  it('opens a sub-agent row per spawn, named by task_name', () => {
    const n = new MuseNormalizer()
    const rows = lines().flatMap((l) => n.ingest(l))
      .filter((e) => e.type === 'tool_start' && (e.payload as { tool: string }).tool === 'Task')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(String((r.payload as { input: { description: string } }).input.description)).not.toBe('')
    }
  })

  it('closes a sub-agent row only when its result is READ, joining the chain through the wait', () => {
    // spawn carries `command_id`, wait carries BOTH `command_id` and `subagent_id`, read carries only
    // `subagent_id`. Keying the close on the read alone finds nothing — the wait is where they join.
    const n = new MuseNormalizer()
    const events = lines().flatMap((l) => n.ingest(l))
    const rowIds = new Set(events
      .filter((e) => e.type === 'tool_start' && (e.payload as { tool: string }).tool === 'Task')
      .map((e) => (e.payload as { id: string }).id))
    const done = events.filter((e) => e.type === 'subagent_finished')
    expect(done.length).toBeGreaterThan(0)
    for (const d of done) expect(rowIds.has((d.payload as { id: string }).id)).toBe(true)
  })
})

/**
 * Sub-agent bookkeeping, from the wire shapes MEASURED in a live session — every one of these differs from
 * what the tool names suggest, and each wrong guess costs the same way: an unclosed row HOLDS `turn_ended`,
 * so the device tile spins "Processing" forever and no recap is ever produced.
 */
describe('muse sub-agent lifecycle', () => {
  // Every real record carries `payload.kind` — the scope the event belongs to. This fixture used to omit
  // it, which is why a `started` that is NOT a turn (scope `task`) looked identical here to one that is.
  const rec = (event: unknown, scope = 'run') => JSON.stringify({ payload: { kind: scope, event } })
  const call = (callId: string, name: string, args: unknown) =>
    rec({ kind: 'assistant_tool_calls_committed', tool_calls: [{ call_id: callId, name, args: JSON.stringify(args) }] })
  const result = (callId: string, body: unknown) =>
    rec({ kind: 'tool_result_batch_committed', results: [{ tool_call_id: callId, text: JSON.stringify(body) }] })
  const feed = (n: MuseNormalizer, ls: string[]) => ls.flatMap((l) => n.ingest(l))

  it('learns the child id from the SPAWN RESULT, then closes on wait → ready', () => {
    // The id is NOT in the spawn's arguments — it comes back in its result. `subagent_read_result`, which
    // the tool list implies is the completion signal, is never called at all in real sessions.
    const n = new MuseNormalizer()
    const events = feed(n, [
      rec({ kind: 'started', prompt: 'go' }),
      call('c1', 'subagent_spawn', { command_id: 'cmd-1', task_name: 'Report BTC price' }),
      result('c1', { status: 'accepted', subagent_id: 'sub-1' }),
      call('c2', 'subagent_wait', { command_id: 'cmd-1', subagent_id: 'sub-1' }),
      result('c2', { status: 'ready', subagent_id: 'sub-1', summary: 'BTC is up' }),
    ])
    const done = events.filter((e) => e.type === 'subagent_finished')
    expect(done).toHaveLength(1)
    expect(done[0].payload).toEqual({ id: 'c1', status: 'completed' })
    // the wait's own card still renders — closing a row must not swallow its tool_end
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2)
  })

  it('closes a REJECTED spawn immediately — that child never runs', () => {
    // Real result: {"status":"rejected","reason":"command_id_reused"}. Left open, it waits on nothing.
    const n = new MuseNormalizer()
    const events = feed(n, [
      rec({ kind: 'started', prompt: 'go' }),
      call('c1', 'subagent_spawn', { command_id: 'dup', task_name: 'Report ETH price' }),
      result('c1', { status: 'rejected', reason: 'command_id_reused' }),
    ])
    expect(events.filter((e) => e.type === 'subagent_finished')[0].payload)
      .toEqual({ id: 'c1', status: 'failed' })
  })

  it('opens a turn for a SCHEDULED run, whose prompt is empty because nobody typed one', () => {
    // A reminder fires with `payload.kind:'run'`, `started`, `prompt:''`. Requiring a non-empty prompt
    // meant no turn opened, so the answer belonged to nothing and never reached the device — measured on
    // a five-minute BTC reminder that ran four times and reported none of them.
    const n = new MuseNormalizer()
    const events = feed(n, [
      rec({ kind: 'started', prompt: '' }),
      rec({ kind: 'assistant_message_committed', text: 'Báo giá Bitcoin — 14:02' }),
      rec({ kind: 'terminal', terminal: 'completed', turn_duration_ms: 14000 }),
    ])
    const types = events.map((e) => e.type)
    expect(types).toContain('turn_started')
    expect(types).toContain('turn_ended')
    expect(n.turnOpen).toBe(false)
  })

  it('does NOT take a task lifecycle start for a turn', () => {
    // `task.started` fires several times inside ONE run (measured: 30 of them across four reminder runs).
    // Treating them as turns would open and re-open a turn per task and shred the real one.
    const n = new MuseNormalizer()
    const events = feed(n, [rec({ kind: 'started', task_id: 't-1' }, 'task')])
    expect(events).toEqual([])
    expect(n.turnOpen).toBe(false)
  })

  it('releases the turn when muse ends it with children nobody waited on', () => {
    // THE BUG: measured 7 spawns / 4 waits in one session. muse ends the main turn regardless, so a row
    // nobody closed pinned the tile busy forever with no recap. `terminal` is the backstop.
    const n = new MuseNormalizer()
    const events = feed(n, [
      rec({ kind: 'started', prompt: 'xin chao' }),
      call('c1', 'subagent_spawn', { command_id: 'a', task_name: 'never awaited' }),
      result('c1', { status: 'accepted', subagent_id: 'sub-1' }),
      rec({ kind: 'assistant_message_committed', text: 'Xin chào!' }),
      rec({ kind: 'terminal', terminal: 'completed', turn_duration_ms: 5586 }),
    ])
    const types = events.map((e) => e.type)
    expect(types).toContain('subagent_finished')
    // the row must close BEFORE the turn ends, or the held turn_ended never releases
    expect(types.indexOf('subagent_finished')).toBeLessThan(types.indexOf('turn_ended'))
    expect(n.turnOpen).toBe(false)
  })
})
