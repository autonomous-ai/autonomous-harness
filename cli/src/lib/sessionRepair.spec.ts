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

/**
 * Muse opens sessions of its OWN under the user's workspace — memory reminders are the ones seen live.
 * They share the workspace_root, sit at the same depth, and are BORN LATER, so they beat the real session
 * on every signal repair used to look at. Measured on a live machine: the daemon tailed an 11-line
 * reminder session while the conversation ran on in another file, and web and device received nothing.
 */
describe('session repair — muse', () => {
  /** `<MUSE_HOME>/sessions/YYYY/MM/DD/<uuid>/session.jsonl`, with the workspace on line one. */
  function writeMuseSession(
    home: string,
    id: string,
    workspace: string,
    events: ReadonlyArray<{ scope: string; event: Record<string, unknown> }>,
    mtimeMs: number,
  ): void {
    const dir = join(home, 'sessions', '2026', '08', '06', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    const lines = [JSON.stringify({ payload: { record: { workspace_root: workspace } } })]
    for (const { scope, event } of events) lines.push(JSON.stringify({ payload: { kind: scope, event } }))
    writeFileSync(file, `${lines.join('\n')}\n`)
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  }

  // `payload.kind` is the discriminator: a RUN is a conversation turn, a TASK is scheduler bookkeeping.
  // Note the run is asserted WITHOUT a prompt — a scheduled run is a real turn nobody typed.
  const runTurn = { scope: 'run', event: { kind: 'started', prompt: 'xin chao' } }
  const scheduledRun = { scope: 'run', event: { kind: 'started', prompt: '' } }
  const taskOnly = [
    { scope: 'task', event: { kind: 'started', task_id: 't-1' } },
    { scope: 'task', event: { kind: 'status', message: 'opening' } },
  ]

  async function loadMuse(museHome: string) {
    vi.resetModules()
    process.env.MUSE_HOME = museHome
    return import('./sessionRepair.js')
  }

  it('ignores a session nobody typed into, and binds the one they did', async () => {
    const home = tempRoot()
    writeMuseSession(home, 'real-session', CWD, [runTurn], STARTED_AT + 5_000)
    writeMuseSession(home, 'reminder-session', CWD, taskOnly, STARTED_AT + 9_000) // younger: used to win
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'real-session' })
  })

  it('scans the AGENT\'s own data root, so two providers can run side by side', async () => {
    // muse follows XDG_DATA_HOME, which is how a second provider (a local router in front of another
    // model) gets its own catalog cache and session tree. The daemon used to scan one global root, so an
    // agent launched with a different one wrote transcripts nowhere anybody looked: it bound to nothing
    // and web and device stayed blank. Same cwd on purpose — the ROOT is the only thing telling them apart.
    const dflt = tempRoot()
    const other = tempRoot()
    writeMuseSession(dflt, 'default-session', CWD, [runTurn], STARTED_AT + 5_000)
    writeMuseSession(other, 'router-session', CWD, [runTurn], STARTED_AT + 5_000)
    const { findLiveSession } = await loadMuse(dflt)

    await expect(findLiveSession('muse', CWD, STARTED_AT, { bornOnly: true }))
      .resolves.toMatchObject({ sessionId: 'default-session' })
    await expect(findLiveSession('muse', CWD, STARTED_AT, { bornOnly: true, dataHome: other }))
      .resolves.toMatchObject({ sessionId: 'router-session' })
  })

  it('binds a SCHEDULED run, whose prompt is empty because nobody typed it', async () => {
    // The filter must key on the run lifecycle, not on the presence of a prompt: a scheduled run is a
    // real turn the scheduler triggered. Requiring a prompt would leave those sessions unbindable.
    const home = tempRoot()
    writeMuseSession(home, 'scheduled-session', CWD, [scheduledRun], STARTED_AT + 5_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT))
      .resolves.toMatchObject({ sessionId: 'scheduled-session' })
  })

  it('binds nothing at all when the only candidate has no user turn', async () => {
    const home = tempRoot()
    writeMuseSession(home, 'reminder-session', CWD, taskOnly, STARTED_AT + 5_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT)).resolves.toBeNull()
  })

  it('still refuses when two real sessions share a directory', async () => {
    // The filter narrows the field; it must not resolve a genuine tie. Two sessions someone typed into
    // is the case the "one muse agent per directory" rule prevents upstream — repair stays fail-closed,
    // because guessing here wires one agent's tile to the other's transcript.
    const home = tempRoot()
    writeMuseSession(home, 'session-a', CWD, [runTurn], STARTED_AT + 5_000)
    writeMuseSession(home, 'session-b', CWD, [runTurn], STARTED_AT + 6_000)
    const { findLiveSession } = await loadMuse(home)

    await expect(findLiveSession('muse', CWD, STARTED_AT)).resolves.toBeNull()
  })
})
