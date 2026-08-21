import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DevinReader, readDevinMessages } from './reader.js'

/**
 * Integration test for the turn-close path, driven through a real `sqlite3` DB and a real log file —
 * because the failure mode being guarded is precisely the one where NO new row and NO Stop hook arrive.
 */
const AGENT_ERROR = "2026-07-28T06:38:22.096212Z  WARN chisel_core::translator: ACP: agent error (Internal):"
  + " Permission denied: Permission denied: We're currently facing high demand for this model."
  + " Please try again later. (trace ID: acb60788b786ddfb16a00ddb3d83b053)"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function sql(db: string, statement: string): void {
  execFileSync('sqlite3', [db, statement])
}

interface Fixture { db: string; home: string; log: string; sessionId: string }

function fixture(sessionId = 'tested-crabapple'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-devin-reader-'))
  dirs.push(dir)
  const db = join(dir, 'sessions.db')
  sql(db, `CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);`)

  const home = join(dir, 'devin')
  mkdirSync(join(home, 'session_locks'), { recursive: true })
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(join(home, 'session_locks', `${sessionId}.lock`), '39022')
  const log = join(home, 'logs', 'devin_20260728-133808_39022.log')
  writeFileSync(log, '')
  return { db, home, log, sessionId }
}

let node = 0
function insert(f: Fixture, message: Record<string, unknown>): void {
  const json = JSON.stringify(message).replace(/'/g, "''")
  sql(f.db, `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
    VALUES ('${f.sessionId}', ${node++}, '${json}', 0);`)
}

const userRow = (id: string, text: string, at = '2026-07-28T06:38:21.000000Z') =>
  ({ message_id: id, role: 'user', content: text, metadata: { created_at: at } })

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// macOS ships the sqlite3 CLI in the base system; Ubuntu (and most slim images) do not. These cases
// drive a REAL database on purpose, so skip rather than fail where the binary is genuinely absent —
// the same guard opencode/reader.spec.ts and hermes/reader.spec.ts already use.
const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

d('DevinReader turn close', () => {
  it('deduplicates the repeated rows Devin writes per inference', async () => {
    const f = fixture()
    const user = userRow('m-user', 'hi')
    insert(f, user)
    insert(f, user) // Devin re-persists the whole chain on the next inference
    insert(f, { message_id: 'm-asst', role: 'assistant', content: 'hello', metadata: { finish_reason: 'stop' } })
    insert(f, { message_id: 'm-sys', role: 'system', content: 'You are Devin' })

    const messages = await readDevinMessages(f.db, f.sessionId)
    expect(messages.map((m) => m.messageId)).toEqual(['m-user', 'm-asst'])
  })

  it('closes a turn that dies mid-flight, with no new row and no Stop hook', async () => {
    const f = fixture()
    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()

    insert(f, userRow('m-1', 'gia btc moi nhat di'))
    await wait(150)
    expect(reader.turnOpen).toBe(true) // the user row opened the turn

    appendFileSync(f.log, AGENT_ERROR + '\n') // provider failure — Devin writes nothing else, ever
    await wait(150)
    reader.stop()

    expect(aborted).toEqual([
      "Permission denied: We're currently facing high demand for this model. Please try again later.",
    ])
    expect(reader.turnOpen).toBe(false)
  })

  it('heals a turn that was already stuck when it attached', async () => {
    const f = fixture()
    insert(f, userRow('m-1', 'gia btc moi nhat di'))
    appendFileSync(f.log, AGENT_ERROR + '\n') // failed before the daemon (re)started

    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()
    reader.stop()

    expect(aborted).toHaveLength(1)
    expect(reader.turnOpen).toBe(false)
  })

  it('leaves a healthy in-flight turn alone when the log only holds an older failure', async () => {
    const f = fixture()
    appendFileSync(f.log, AGENT_ERROR + '\n') // 06:38:22 — BEFORE this turn's prompt
    insert(f, userRow('m-1', 'a fresh prompt', '2026-07-28T07:00:00.000000Z'))

    const aborted: string[] = []
    const reader = new DevinReader({
      dbPath: f.db, devinHome: f.home, sessionId: f.sessionId, pollMs: 30,
      onEvents: () => {},
      onTurnAborted: (message) => aborted.push(message),
    })
    await reader.start()
    await wait(120)
    reader.stop()

    expect(aborted).toEqual([])
    expect(reader.turnOpen).toBe(true) // still running — must not be force-closed
  })
})
