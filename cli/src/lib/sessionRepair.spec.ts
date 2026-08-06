import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Repair binds a live launcher back to a session the daemon lost track of. The danger is not failing to
 * find one — that only costs a tile until the next turn — it is finding the WRONG one and pointing an
 * agent at another agent's transcript. So these tests are mostly about when it must refuse.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repair-'))
  dirs.push(dir)
  return dir
}

/** A claude-shaped transcript: `<id>.jsonl` under a project dir, first line carrying its cwd. */
function writeTranscript(root: string, project: string, id: string, cwd: string, mtimeMs: number): void {
  const dir = join(root, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', cwd, id })}\n`)
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}

async function load(claudeProjectsDir: string) {
  vi.resetModules()
  process.env.CLAUDE_PROJECTS_DIR = claudeProjectsDir
  return import('./sessionRepair.js')
}

const STARTED_AT = Date.parse('2026-08-03T09:00:00Z')
const CWD = '/Users/demo/work/project'

describe('session repair', () => {
  it('finds the session the running engine started in this directory', async () => {
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-live', CWD, STARTED_AT + 5_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'sess-live' })
  })

  it('finds the cwd even when the transcript opens with bookkeeping lines', async () => {
    // Claude's first records are `leafUuid` / `mode` with no cwd anywhere in them. A first-line-only read
    // therefore matched NO claude session on a real machine — the repair returned null for a pane whose
    // transcript was sitting right there.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-meta-first.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'summary', leafUuid: 'x', sessionId: 'sess-meta-first' }),
      JSON.stringify({ type: 'x-mode', mode: 'default', sessionId: 'sess-meta-first' }),
      JSON.stringify({ type: 'user', cwd: CWD, sessionId: 'sess-meta-first' }),
      '',
    ].join('\n'))
    utimesSync(file, new Date(STARTED_AT + 5_000), new Date(STARTED_AT + 5_000))
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'sess-meta-first' })
  })

  it('ignores a session that predates the process now running the pane', async () => {
    // A transcript older than the engine cannot be what it is running — that would be a resume, and
    // resumes name their id on the command line (discoverTmuxResumes handles those).
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-yesterday', CWD, STARTED_AT - 24 * 3_600_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('ignores a session belonging to a different directory', async () => {
    const root = tempRoot()
    writeTranscript(root, 'other', 'sess-elsewhere', '/Users/demo/other', STARTED_AT + 5_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('does not hand a just-exited session to the engine that replaced it', async () => {
    // Real sequence: `/exit`, then relaunch in the same pane seconds later. The dead transcript's last
    // write is still fresh, so a mtime-only rule with a generous slack bound the NEW agent to the OLD
    // session id (measured on a live pane). Its file was created before this process and has not been
    // written to since it started — neither tier may accept it.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-just-exited.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: CWD })}\n`)
    const born = Date.now()                    // the temp file's real birthtime
    const lastWrite = born + 20_000            // it wrote, then the user exited…
    utimesSync(file, new Date(lastWrite), new Date(lastWrite))
    const { findLiveSession } = await load(root)

    // …and the replacement process started AFTER that last write.
    await expect(findLiveSession('claude', CWD, born + 40_000)).resolves.toBeNull()
  })

  it('still finds a RESUMED session, whose file is old but freshly written', async () => {
    // The other side of the same coin: `claude --resume` writes to a transcript created earlier. A write
    // that lands after the process started is what marks it as the one being run right now.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sess-resumed.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: CWD })}\n`)
    const born = Date.now()
    const startedAt = born + 30_000            // the engine started well after the file was created…
    utimesSync(file, new Date(startedAt + 10_000), new Date(startedAt + 10_000)) // …and wrote after that
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, startedAt))
      .resolves.toMatchObject({ sessionId: 'sess-resumed' })
  })

  it('refuses to choose when two agents are running in the same directory', async () => {
    // The whole point: a wrong guess wires one agent's tile to the other's transcript, and nothing
    // downstream could tell. Staying invisible for one more turn is the cheaper failure.
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-a', CWD, STARTED_AT + 5_000)
    writeTranscript(root, 'proj', 'sess-b', CWD, STARTED_AT + 9_000)
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('picks the transcript path along with the id, so the session can actually be tailed', async () => {
    const root = tempRoot()
    writeTranscript(root, 'proj', 'sess-live', CWD, STARTED_AT + 1_000)
    const { findLiveSession } = await load(root)

    const found = await findLiveSession('claude', CWD, STARTED_AT)
    expect(found?.transcriptPath).toBe(join(root, 'proj', 'sess-live.jsonl'))
  })

  it('skips sidecar files that are not transcripts', async () => {
    // Command Code writes `<id>.checkpoints.jsonl` next to the real transcript; adopting one would
    // register a session id that no reader can follow.
    const root = tempRoot()
    const dir = join(root, 'proj')
    mkdirSync(dir, { recursive: true })
    const sidecar = join(dir, 'sess-live.checkpoints.jsonl')
    writeFileSync(sidecar, `${JSON.stringify({ cwd: CWD })}\n`)
    utimesSync(sidecar, new Date(STARTED_AT + 5_000), new Date(STARTED_AT + 5_000))
    const { findLiveSession } = await load(root)

    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('says nothing rather than throwing when the engine store is missing', async () => {
    const { findLiveSession } = await load(join(tempRoot(), 'does-not-exist'))
    await expect(findLiveSession('claude', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('has no answer for cursor, and says so instead of guessing', async () => {
    // Cursor transcripts are located by id, not listed by directory; its resumes have their own path.
    const { findLiveSession } = await load(tempRoot())
    await expect(findLiveSession('cursor', CWD, STARTED_AT)).resolves.toBeNull()
  })
})
