import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OpencodeReader, readOpencodeMessages } from './reader.js'
import type { LiveEvent } from '../../lib/normalize.js'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const SID = 'ses_testABC123'

function run(db: string, sql: string): void {
  execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'ignore', 'inherit'] })
}
function esc(v: unknown): string {
  return JSON.stringify(v).replace(/'/g, "''")
}
function schema(db: string): void {
  run(db,
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);' +
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);')
}
function insertMessage(
  db: string, mid: string, tc: number, data: Record<string, unknown>,
  parts: Array<{ id: string; tc: number; data: Record<string, unknown> }>,
): void {
  let sql = `INSERT INTO message VALUES ('${mid}','${SID}',${tc},'${esc(data)}');`
  for (const p of parts) sql += `INSERT INTO part VALUES ('${p.id}','${mid}','${SID}',${p.tc},'${esc(p.data)}');`
  run(db, sql)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

d('OpencodeReader (sqlite3 CLI)', () => {
  let dir = ''
  let db = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-reader-')); db = join(dir, 'opencode.db'); schema(db) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads messages grouped with their parts, ordered', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'hi' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'hello' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const messages = await readOpencodeMessages(db, SID)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
    expect(messages[0].parts[0].data.text).toBe('hi')
  })

  it('rejects a non-id session (no injection surface)', async () => {
    expect(await readOpencodeMessages(db, "x'; DROP TABLE message;--")).toEqual([])
  })

  it('hydrates silently, then streams a new turn incrementally', async () => {
    // A pre-existing, completed turn: the reader must NOT replay it on attach.
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'old' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'done' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    expect(events).toHaveLength(0) // hydrate = no replay

    // A fresh turn arrives — a new user prompt, an assistant text, a tool, then a terminal step-finish.
    insertMessage(db, 'm3', 10, { role: 'user' }, [{ id: 'p4', tc: 10, data: { type: 'text', text: 'who won?' } }])
    insertMessage(db, 'm4', 11, { role: 'assistant' }, [
      { id: 'p5', tc: 11, data: { type: 'text', text: 'Spain' } },
      { id: 'p6', tc: 12, data: { type: 'tool', tool: 'webfetch', state: { status: 'completed', input: { url: 'u' }, output: 'ok' } } },
      { id: 'p7', tc: 13, data: { type: 'step-finish', reason: 'stop' } },
    ])
    await wait(200)
    reader.stop()

    const types = events.map((e) => e.type)
    expect(types).toContain('turn_started')
    expect(types).toContain('text_delta')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('turn_ended')
    const started = events.find((e) => e.type === 'turn_started')
    expect(started).toMatchObject({ payload: { userMessage: 'who won?' } })
    expect(reader.turnOpen).toBe(false) // closed by step-finish reason:stop
  })

  it('waits for a task part\'s input before announcing the sub-agent', async () => {
    // opencode creates the `task` part when the call STARTS streaming, with `state.input` still empty, and
    // fills the arguments in a moment later. Announcing on first sight gave every sub-agent the same
    // `Delegated task` placeholder — measured live, two parallel sub-agents produced two identical rows.
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'old' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [{ id: 'p2', tc: 2, data: { type: 'step-finish', reason: 'stop' } }])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()

    insertMessage(db, 'm3', 10, { role: 'user' }, [{ id: 'p3', tc: 10, data: { type: 'text', text: 'spawn two' } }])
    insertMessage(db, 'm4', 11, { role: 'assistant' }, [
      { id: 'p4', tc: 11, data: { type: 'tool', tool: 'task', state: { status: 'running', input: {} } } },
    ])
    await wait(120)
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(0)   // nothing worth showing yet

    run(db, `UPDATE part SET data='${esc({ type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Count .md files', subagent_type: 'general' } } })}' WHERE id='p4';`)
    await wait(120)
    reader.stop()

    const start = events.find((e) => e.type === 'tool_start')
    expect(start).toMatchObject({ payload: { tool: 'Task', input: { description: 'Count .md files' } } })
  })

  it('emits text deltas incrementally as an assistant message grows', async () => {
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    insertMessage(db, 'm1', 5, { role: 'user' }, [{ id: 'p1', tc: 5, data: { type: 'text', text: 'go' } }])
    insertMessage(db, 'm2', 6, { role: 'assistant' }, [{ id: 'p2', tc: 6, data: { type: 'text', text: 'Hel' } }])
    await wait(120)
    // The same part grows (streaming) — only the NEW suffix should be emitted.
    run(db, `UPDATE part SET data='${esc({ type: 'text', text: 'Hello world' })}' WHERE id='p2';`)
    await wait(120)
    reader.stop()
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { payload: { content: string } }).payload.content)
    expect(deltas.join('')).toBe('Hello world')
    expect(deltas).toContain('Hel')
    expect(deltas).toContain('lo world')
  })
})
