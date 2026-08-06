import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { lastHermesTurnText, messageToEvents, newHermesTurnState, type HmMessage } from './normalizer.js'
import { hermesSessionSource, isHermesSubagentSession } from './reader.js'
import type { LiveEvent } from '../../lib/normalize.js'

/**
 * The six real `messages` rows of one hermes async fan-out (state.db, session 20260731_161017_999143,
 * ids 284–306): prompt → `delegate_task` with TWO tasks → dispatch ack → "đã launch" → the machine-written
 * `[ASYNC DELEGATION BATCH COMPLETE — deleg_3c9f8264]` row → the consolidated answer.
 */
function rows(): HmMessage[] {
  const p = fileURLToPath(new URL('../../lib/__fixtures__/hermes-async-delegation.json', import.meta.url))
  return JSON.parse(readFileSync(p, 'utf-8')) as HmMessage[]
}

function live(): LiveEvent[] {
  const state = newHermesTurnState()
  return rows().flatMap((m) => messageToEvents(m, state, 'live'))
}

describe('hermes async delegation', () => {
  it('fans ONE delegate_task call out to one row per task, each with its goal', () => {
    // Before this, two parallel sub-agents arrived as a single card whose only string was the tool name,
    // so the device list showed one row labelled "sub-agent" for the pair.
    const starts = live().filter((e): e is Extract<LiveEvent, { type: 'tool_start' }> =>
      e.type === 'tool_start' && e.payload.tool === 'Task')
    expect(starts).toHaveLength(2)
    const descs = starts.map((e) => String((e.payload.input as { description: string }).description))
    expect(descs[0]).toContain('.md')
    expect(descs[1]).toContain('.ts')
    // Distinct ids, or the second row would collapse onto the first.
    expect(new Set(starts.map((e) => (e.payload as { id: string }).id)).size).toBe(2)
  })

  it('does not tick the rows off on the dispatch ack', () => {
    // The ack is {"status":"dispatched","mode":"background",…} — the same trap as claude's launch ack.
    const events = live()
    const ackIndex = events.findIndex((e) => e.type === 'tool_end')
    expect(ackIndex).toBeGreaterThan(-1)
    expect(events.slice(0, ackIndex + 1).some((e) => e.type === 'subagent_finished')).toBe(false)
    // …and the ack's own id is not one of the rows, so nothing downstream can match it either.
    const rowIds = new Set(events.filter((e) => e.type === 'tool_start').map((e) => (e.payload as { id: string }).id))
    expect(rowIds.has((events[ackIndex].payload as { id: string }).id)).toBe(false)
  })

  it('finishes both rows off the batch-complete row, which starts no turn', () => {
    const events = live()
    const finished = events.filter((e) => e.type === 'subagent_finished')
    expect(finished).toHaveLength(2)
    expect(finished.every((e) => (e.payload as { status: string }).status === 'completed')).toBe(true)
    const rowIds = events.filter((e) => e.type === 'tool_start').map((e) => (e.payload as { id: string }).id)
    expect(finished.map((e) => (e.payload as { id: string }).id)).toEqual(rowIds)
    // ONE turn — the user's. The batch-complete row used to open a second one.
    const starts = events.filter((e) => e.type === 'turn_started')
    expect(starts).toHaveLength(1)
    expect(String((starts[0].payload as { userMessage: string }).userMessage)).not.toContain('ASYNC DELEGATION')
  })

  it('recaps the answer to what was ASKED, not the batch-complete boilerplate', () => {
    // Measured before the fix: `[recap] 20260731 summarizing · ask="[ASYNC DELEGATION BATCH COMPLETE …"`.
    const turn = lastHermesTurnText(rows())
    expect(turn?.userMessage).toContain('sub-agent SONG SONG')
    expect(turn?.userMessage).not.toContain('ASYNC DELEGATION')
    expect(turn?.assistantText).toContain('Tổng hợp kết quả từ 2 sub-agent')
  })

  it('closes the rows immediately when the dispatch is foreground or fails', () => {
    const state = newHermesTurnState()
    const events = [
      { id: 1, role: 'user', content: 'go', toolCallId: null, toolCalls: null, toolName: null, finishReason: null, reasoning: null },
      {
        id: 2, role: 'assistant', content: '', toolCallId: null, toolName: null, finishReason: 'tool_calls', reasoning: null,
        toolCalls: JSON.stringify([{ id: 'call_x', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ tasks: [{ goal: 'A' }, { goal: 'B' }] }) } }]),
      },
      { id: 3, role: 'tool', content: '{"status":"completed","mode":"foreground","count":2}', toolCallId: 'call_x', toolCalls: null, toolName: 'delegate_task', finishReason: null, reasoning: null },
    ].flatMap((m) => messageToEvents(m as HmMessage, state, 'live'))
    // No batch-complete row is coming for a foreground run, so nothing else could ever close these rows —
    // left open they would hold the turn's recap until the 10-minute backstop.
    expect(events.filter((e) => e.type === 'subagent_finished')).toHaveLength(2)
  })

  it('keeps the batch-complete row out of history replay too', () => {
    const state = newHermesTurnState()
    const replay = rows().flatMap((m) => messageToEvents(m, state, 'replay'))
    const prompts = replay.filter((e) => e.type === 'user_message').map((e) => String((e.payload as { content: string }).content))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('ASYNC DELEGATION')
  })
})

describe('hermes sub-agent sessions are not agents of their own', () => {
  const has = (() => { try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
  const t = has ? it : it.skip

  t('tells a delegation child (source=subagent) from the CLI session the user sees', async () => {
    // Measured: dispatching 2 sub-agents created sessions with source='subagent' whose hooks fired from
    // the PARENT's pane, so the pane re-bound to them and the parent was `forgotten` mid-turn.
    const dir = mkdtempSync(join(tmpdir(), 'hm-src-'))
    const db = join(dir, 'state.db')
    execFileSync('sqlite3', [db,
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL);' +
      "INSERT INTO sessions VALUES ('20260805_111618_8e3027','subagent');" +
      "INSERT INTO sessions VALUES ('20260805_110520_3e0e44','tool');" +
      "INSERT INTO sessions VALUES ('20260731_161017_999143','cli');"])
    expect(await isHermesSubagentSession(db, '20260805_111618_8e3027')).toBe(true)
    expect(await isHermesSubagentSession(db, '20260805_110520_3e0e44')).toBe(true)
    expect(await isHermesSubagentSession(db, '20260731_161017_999143')).toBe(false)
    expect(await isHermesSubagentSession(db, '20260101_000000_abcdef')).toBe(false) // unknown id → not a child
    // …but the caller can tell "no row YET" from "row says cli" — that distinction is what closes the
    // 110ms window in which a child's hook arrives before hermes has written its own sessions row.
    expect(await hermesSessionSource(db, '20260101_000000_abcdef')).toBeNull()
    expect(await hermesSessionSource(db, '20260731_161017_999143')).toBe('cli')
    expect(await isHermesSubagentSession(join(dir, 'nope.db'), '20260805_111618_8e3027')).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
