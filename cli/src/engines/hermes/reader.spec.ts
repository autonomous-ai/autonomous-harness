import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HermesReader, readHermesMessages } from './reader.js'
import type { LiveEvent } from '../../lib/normalize.js'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const SID = '20260727_162325_e25264' // the real Hermes id shape: YYYYMMDD_HHMMSS_<hex>
const CALL = 'call_ba1647ad979d0290'

function run(db: string, sql: string): void {
  execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'ignore', 'inherit'] })
}
function q(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`
}
function insert(
  db: string,
  row: { id: number; role: string; content?: string; toolCallId?: string; toolCalls?: string; toolName?: string; finishReason?: string; reasoning?: string },
): void {
  run(db,
    `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, timestamp) VALUES (` +
    `${row.id}, '${SID}', '${row.role}', ${q(row.content ?? '')}, ${q(row.toolCallId ?? null)}, ${q(row.toolCalls ?? null)}, ` +
    `${q(row.toolName ?? null)}, ${q(row.finishReason ?? null)}, ${q(row.reasoning ?? null)}, ${row.id});`)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

d('HermesReader (sqlite3 CLI)', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-reader-'))
    db = join(dir, 'state.db')
    run(db,
      'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,' +
      ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT, timestamp REAL);')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads rows in id order with the columns the normalizer needs', async () => {
    insert(db, { id: 1, role: 'user', content: 'hi' })
    insert(db, { id: 2, role: 'assistant', content: 'hello', finishReason: 'stop' })
    const rows = await readHermesMessages(db, SID)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1]).toMatchObject({ id: 2, content: 'hello', finishReason: 'stop' })
  })

  it('rejects a session id that is not the Hermes shape (no injection surface)', async () => {
    expect(await readHermesMessages(db, "x'; DROP TABLE messages;--")).toEqual([])
  })

  it('hydrates silently, then streams a new turn incrementally', async () => {
    insert(db, { id: 1, role: 'user', content: 'old' })
    insert(db, { id: 2, role: 'assistant', content: 'done', finishReason: 'stop' })

    const events: LiveEvent[] = []
    const reader = new HermesReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    expect(events).toHaveLength(0)      // hydrate = no replay
    expect(reader.turnOpen).toBe(false) // last row was a terminal assistant

    insert(db, { id: 3, role: 'user', content: 'who won?' })
    insert(db, { id: 4, role: 'assistant', finishReason: 'tool_calls', toolCalls: `[{"id":"${CALL}","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"ls\\"}"}}]` })
    await wait(120)
    expect(reader.turnOpen).toBe(true)  // still calling a tool

    insert(db, { id: 5, role: 'tool', toolName: 'terminal', toolCallId: CALL, content: '{"output": "a.txt", "exit_code": 0, "error": null}' })
    insert(db, { id: 6, role: 'assistant', content: 'Spain', finishReason: 'stop' })
    await wait(150)
    reader.stop()

    const types = events.map((e) => e.type)
    expect(types).toEqual(['turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended'])
    expect(events[0]).toMatchObject({ payload: { userMessage: 'who won?' } })
    expect(events[2]).toMatchObject({ payload: { tool: 'Bash', output: 'a.txt', isError: false } })
    expect(reader.turnOpen).toBe(false)
  })

  it('reports a mid-turn attach as an open turn', async () => {
    insert(db, { id: 1, role: 'user', content: 'working on it' })
    const reader = new HermesReader({ dbPath: db, sessionId: SID, onEvents: () => {}, pollMs: 1_000 })
    await reader.start()
    expect(reader.turnOpen).toBe(true)
    reader.stop()
  })
})
