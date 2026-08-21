import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KiloReader } from './reader.js'
import type { LiveEvent } from '../../lib/normalize.js'

/**
 * A first message through `harness kilo` produced no turn frames and no recap, every time:
 *
 *   [agent] c5c6227b re-attached · engine=kilo · pane=%10 · session=ses_014f
 *   [turn]  ses_014f ended
 *   [recap] DROPPED (no turn_started was ever seen for this session)
 *
 * Kilo creates its session only when the FIRST message is submitted, and the discovery plugin fires on
 * `session.created` — so the daemon ALWAYS attaches with a turn already in flight. A silent hydrate then
 * left that turn with a close and no open, and the recap was dropped for want of the opening frame.
 *
 * These run against a real SQLite file through the same `sqlite3` path the daemon uses, because the bug
 * lived in what hydrate did with the rows, not in the parsing.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SESSION = 'ses_test01'

/** message.data / part.data are JSON TEXT columns, exactly as kilo writes them. */
function db(rows: Array<{ role: string; parts: Array<Record<string, unknown>> }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-reader-'))
  dirs.push(dir)
  const path = join(dir, 'kilo.db')
  const sql: string[] = [
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);',
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
  ]
  const q = (v: unknown): string => `'${JSON.stringify(v).replace(/'/g, "''")}'`
  rows.forEach((row, m) => {
    sql.push(`INSERT INTO message VALUES ('msg_${m}','${SESSION}',${1000 + m},${q({ role: row.role })});`)
    row.parts.forEach((part, p) => {
      sql.push(`INSERT INTO part VALUES ('prt_${m}_${p}','msg_${m}','${SESSION}',${1000 + m * 10 + p},${q(part)});`)
    })
  })
  execFileSync('sqlite3', [path, sql.join('\n')])
  return path
}

async function attach(dbPath: string): Promise<LiveEvent[]> {
  const seen: LiveEvent[] = []
  // A very long poll interval: these assertions are about what ATTACHING emits, not about polling.
  const reader = new KiloReader({ dbPath, sessionId: SESSION, onEvents: (e) => seen.push(...e), pollMs: 600_000 })
  await reader.start()
  reader.stop()
  return seen
}

const userMsg = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
const working = { role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'thinking…' }] }
const finished = {
  role: 'assistant',
  parts: [{ type: 'text', text: 'done' }, { type: 'step-finish', reason: 'stop' }],
}

// macOS ships the sqlite3 CLI in the base system; Ubuntu (and most slim images) do not. These cases
// drive a REAL database on purpose, so skip rather than fail where the binary is genuinely absent —
// the same guard opencode/reader.spec.ts and hermes/reader.spec.ts already use.
const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

d('KiloReader attaching mid-turn', () => {
  /**
   * The shape that broke a first message. The plugin posts the moment the user row lands, which is
   * BEFORE kilo has written any assistant row — so the old check ("is the tail an unfinished
   * assistant") said no turn was open, and the user id was already in `seenUser`, meaning the poll
   * could never emit the opening frame for it either. Two ways to lose the same turn.
   */
  it('opens the turn when only the user row exists yet', async () => {
    const events = await attach(db([userMsg('gia eth di')]))

    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'gia eth di' } }])
  })

  it('opens the turn when the assistant is already working', async () => {
    const events = await attach(db([userMsg('price eth now'), working]))

    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'price eth now' } }])
  })

  /** Re-attaching to an idle session must stay silent, or every daemon restart invents a turn. */
  it('says nothing when the last turn already finished', async () => {
    expect(await attach(db([userMsg('hi'), finished]))).toEqual([])
  })

  it('says nothing for a session with no rows at all', async () => {
    expect(await attach(db([]))).toEqual([])
  })

  /**
   * The backstop must not double-fire. Every user row present at attach is seeded into `seenUser`, so
   * the first poll that re-reads the same rows has nothing new to open.
   */
  it('does not open the same turn twice when the poll re-reads it', async () => {
    const path = db([userMsg('once'), working])
    const seen: LiveEvent[] = []
    const reader = new KiloReader({ dbPath: path, sessionId: SESSION, onEvents: (e) => seen.push(...e), pollMs: 10 })
    await reader.start()
    await new Promise((r) => setTimeout(r, 120))
    reader.stop()

    expect(seen.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })
})
