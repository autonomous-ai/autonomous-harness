/**
 * Find the session a live discovered engine process is running, when no hook has bound one yet.
 *
 * Process discovery can see an engine immediately, including after a daemon restart, but a session id is
 * owned by the engine and may not be present in argv. Ask the engine's own store which session belongs to
 * that pane's directory and process start time.
 *
 * Two rules keep it honest:
 *   - **Started after the engine process did.** A session older than the process cannot be the one it is
 *     running now. (Resumed agents name their id on the command line and are adopted from argv instead —
 *     see tmuxAgentDiscovery.)
 *   - **Unique or nothing.** Two candidate sessions in one directory means two agents there, and guessing
 *     would hand one agent's transcript to the other's tile. Ambiguity returns null; the agent stays
 *     unbound until its next turn, which is recoverable — mis-binding is not.
 */

import { execFile } from 'child_process'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import { promisify } from 'util'
import { env } from '../config/env.js'
import { museEvent, museWorkspaceRoot } from '../engines/muse/normalizer.js'
import type { AgentEngine } from '../engines/types.js'
import { readCodexRolloutMeta } from '../engines/codex/rollout.js'
import { agyConversationForPid, findAgyTranscript } from '../engines/agy/session.js'
import { copilotSessionCwd, copilotSessionForPid, findCopilotTranscript } from '../engines/copilot/session.js'

const execFileAsync = promisify(execFile)

/**
 * Clock granularity only. `ps` reports start time to the second, so a file created in the same second
 * must still count as "after".
 *
 * Deliberately small. It was 60s, and that let a session the user had JUST exited be handed to the engine
 * they started seconds later in the same pane: the old transcript's last write fell inside the window, so
 * the new agent came up wearing the dead session's id (measured — `/exit`, relaunch, and repair re-bound
 * `6899ff76`). Whatever is picked here must belong to the process running NOW.
 */
const START_SLACK_MS = 5_000
/** Directories to walk per engine root. Deep enough for codex's <year>/<month>/<day> layout. */
const MAX_DEPTH = 4
const MAX_FILES = 400

export interface RepairedSession {
  sessionId: string
  /** File-backed engines only; the DB-backed ones are read by session id. */
  transcriptPath?: string
}

interface TranscriptFile { path: string; mtimeMs: number; birthMs: number }

/** Every `.jsonl` under `root`, newest first, capped. Checkpoint/sidecar files are not transcripts. */
async function transcripts(root: string, depth = 0): Promise<TranscriptFile[]> {
  if (depth > MAX_DEPTH) return []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const out: TranscriptFile[] = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) { out.push(...await transcripts(full, depth + 1)); continue }
    if (!entry.name.endsWith('.jsonl') || entry.name.includes('.checkpoints.')) continue
    try {
      const info = await stat(full)
      out.push({ path: full, mtimeMs: info.mtimeMs, birthMs: info.birthtimeMs || info.mtimeMs })
    } catch { /* vanished mid-scan */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES)
}

/**
 * The `cwd` a transcript declares, from its opening lines.
 *
 * Not just line one: claude opens with bookkeeping records (`leafUuid`, `mode`) that carry no cwd, so a
 * first-line-only read found nothing for every claude session on the computer — caught when a live repair
 * returned null for a pane whose transcript was sitting right there. pi and Command Code do put it on
 * line one; scanning a few lines covers all three without knowing which is which.
 */
const CWD_SCAN_LINES = 20

async function readTranscriptMeta(path: string): Promise<TranscriptMeta | null> {
  try {
    const head = (await readFile(path, 'utf-8')).slice(0, 256 * 1024)
    for (const line of head.split('\n', CWD_SCAN_LINES)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (typeof obj.cwd === 'string' && obj.cwd) return { cwd: obj.cwd }
    }
    return null
  } catch { return null }
}

/** Session id from `<id>.jsonl`, or from pi's `<timestamp>_<id>.jsonl`. */
function idFromFile(path: string): string {
  const base = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
  const underscore = base.lastIndexOf('_')
  return underscore === -1 ? base : base.slice(underscore + 1)
}

/**
 * Compare two directories as the filesystem sees them, not as strings.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, so discovery reporting one and an engine recording the
 * other describe the SAME directory and would never match textually — measured: a repair that resolved
 * correctly for `/private/tmp/synctest` returned null for `/tmp/synctest`.
 */
export async function sameDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [ra, rb] = await Promise.all([
    realpath(a).catch(() => a),
    realpath(b).catch(() => b),
  ])
  return ra === rb
}

/**
 * Two tiers, because two different things look alike from here.
 *
 *   born  — the transcript was CREATED after the process started: a session this engine opened itself.
 *   wrote — created earlier but written to after the process started: a session it RESUMED.
 *
 * Preferring `born` is what stops a just-exited session from being handed to its replacement: the dead
 * transcript was created before the new process, and its final write lands before the new process starts,
 * so it qualifies for neither tier and the pane stays unbound until the real session appears.
 */
interface TranscriptMeta { cwd: string | null; sessionId?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * True once a muse session has opened a RUN — the lifecycle a conversation is made of.
 *
 * Not "has a prompt": a scheduled run is a real turn whose prompt is empty, because the scheduler
 * triggered it rather than a person. `payload.kind` is what separates the two lifecycles that share the
 * name `started`; a `task` one is scheduler bookkeeping and several fire inside a single run.
 */
function hasRun(lines: string[]): boolean {
  for (const line of lines) {
    const record = museEvent(line)
    if (record?.scope === 'run' && str(record.event.kind) === 'started') return true
  }
  return false
}

async function fileEngineSession(
  root: string,
  cwd: string,
  startedAtMs: number,
  readMeta: (path: string) => Promise<TranscriptMeta | null>,
  opts?: { bornOnly?: boolean },
): Promise<RepairedSession | null> {
  const since = startedAtMs - START_SLACK_MS
  const born: RepairedSession[] = []
  const wrote: RepairedSession[] = []
  for (const file of await transcripts(root)) {
    if (file.mtimeMs < since) break // sorted newest-first: everything after is older still
    const meta = await readMeta(file.path)
    if (!meta?.cwd || !await sameDir(meta.cwd, cwd)) continue
    const found = { sessionId: meta.sessionId || idFromFile(file.path), transcriptPath: file.path }
    ;(file.birthMs >= since ? born : wrote).push(found)
  }
  // "Unique or nothing" at each tier: two candidates means two agents in one directory, and a wrong guess
  // wires one agent's tile to the other's transcript.
  if (born.length === 1) return born[0]
  if (born.length > 1) return null
  // `bornOnly`: the caller is binding an agent that has NEVER had a session. Accepting the `wrote` tier
  // there hands it whatever session was last touched in this directory — measured: exit the engine,
  // run `claude` again in the same pane, and the new agent adopted the PREVIOUS conversation,
  // so the web opened a fresh tab already full of old messages. A resume the user asked for by name is
  // matched from argv by the discovery path instead, which needs no guessing.
  if (opts?.bornOnly) return null
  return wrote.length === 1 ? wrote[0] : null
}

async function dbEngineSession(dbPath: string, sql: string): Promise<RepairedSession | null> {
  let stdout: string
  try {
    // Same invocation the readers use: `.timeout` as a dot-command (the PRAGMA form prints a row under
    // -json and corrupts the parse), and query_only so a repair can never write to the user's store.
    ({ stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', dbPath, sql],
      { maxBuffer: 1024 * 1024 },
    ))
  } catch { return null }
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let rows: Array<Record<string, unknown>>
  try { rows = JSON.parse(trimmed) as Array<Record<string, unknown>> } catch { return null }
  if (rows.length !== 1) return null // 0 = nothing to adopt, >1 = ambiguous
  const id = rows[0].id
  return typeof id === 'string' && id ? { sessionId: id } : null
}

/** SQL-escape a directory for a literal comparison (the readers build literals the same way). */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The session a discovered engine process is running in `cwd`, or null when it cannot be said for certain.
 *
 * `startedAtMs` is when the engine process started (`ps` lstart). Cursor is absent on purpose: its
 * transcripts are located by id rather than listed by directory, and its resumes already have a
 * dedicated discovery path.
 */

/**
 * Copilot names its session directory by uuid, so the cwd lives inside the file — on the first record,
 * `session.start.data.context.cwd`. `readTranscriptMeta` scans the first lines for a bare `cwd`, but
 * Copilot nests it, so this reads it out itself.
 */
async function copilotDirectoryScan(
  cwd: string,
  startedAtMs: number,
  opts?: { bornOnly?: boolean },
): Promise<RepairedSession | null> {
  return fileEngineSession(join(env.COPILOT_HOME, 'session-state'), cwd, startedAtMs, async (path) => {
    if (basename(path) !== 'events.jsonl') return null
    const head = (await readFile(path, 'utf8').catch(() => '')).split('\n', 5)
    const root = copilotSessionCwd(head)
    return root ? { cwd: root, sessionId: basename(dirname(path)) } : null
  }, opts)
}

export async function findLiveSession(
  engine: AgentEngine,
  cwd: string,
  startedAtMs: number,
  opts?: { bornOnly?: boolean; pid?: number },
): Promise<RepairedSession | null> {
  const sinceMs = startedAtMs - START_SLACK_MS
  // The DB engines match on a directory STRING, so ask for both spellings of it (see sameDir).
  const real = await realpath(cwd).catch(() => cwd)
  const dirs = real === cwd ? [cwd] : [cwd, real]
  const dirList = dirs.map(quote).join(', ')
  switch (engine) {
    case 'claude':
      return fileEngineSession(env.CLAUDE_PROJECTS_DIR, cwd, startedAtMs, readTranscriptMeta, opts)
    case 'codex':
      // Codex writes no `cwd` on line one; its rollout meta carries it — and says whether the rollout
      // belongs to a subagent, which must never become an agent of its own.
      // Its session id lives INSIDE the file: the name is `rollout-<timestamp>-<id>.jsonl`, so deriving
      // the id from the filename produced the literal string "rollout-…" (seen on a live pane).
      return fileEngineSession(join(env.CODEX_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        const meta = readCodexRolloutMeta(path)
        return meta && !meta.isSubagent ? { cwd: meta.cwd, sessionId: meta.id || undefined } : null
      }, opts)
    case 'pi':
      return fileEngineSession(join(env.PI_HOME, 'agent', 'sessions'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'commandcode':
      return fileEngineSession(join(env.COMMANDCODE_HOME, 'projects'), cwd, startedAtMs, readTranscriptMeta, opts)
    case 'muse':
      // Muse's hooks never fire, so this scan is the ONLY way a muse pane is ever bound. The tree is
      // `sessions/YYYY/MM/DD/<session-uuid>/session.jsonl` (4 levels — exactly MAX_DEPTH) and nothing in
      // the path names the project: `workspace_root` in the first record is the only link. Sub-agent
      // files live one level deeper under `subagent/`, and must never be adopted as agents of their own.
      return fileEngineSession(join(env.MUSE_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        if (path.includes(`${sep}subagent${sep}`)) return null
        const lines = (await readFile(path, 'utf-8').catch(() => '')).split('\n')
        const root = museWorkspaceRoot(lines[0] ?? '')
        if (!root) return null
        // Muse opens sessions of its OWN under the same workspace_root — memory reminders
        // (`memory_reminder_child_session_linked`) are the ones seen live. They are indistinguishable from
        // the user's session by path, workspace or birth time, and being younger they WIN the `born` tier:
        // measured, the daemon tailed an 11-line reminder session while the real conversation ran on in
        // another file, so web and device received nothing at all. What separates them is that a session
        // being conversed in has opened a RUN.
        if (!hasRun(lines)) return null
        return { cwd: root, sessionId: basename(dirname(path)) }
      }, opts)
    case 'amp':
      // The transcripts scanned here are the adapter's own — Amp keeps no conversation on disk, so its
      // plugin writes one per thread as `<AMP_SESSIONS_DIR>/<threadId>.jsonl` with `cwd` on the first
      // line. That makes the ordinary file scan work unchanged, and the file name IS the session id.
      //
      // Amp also offers a second, exact answer that this deliberately does not use: `session.json` maps
      // `tmux:<pane>@<server-pid>,<session>` to the thread started in that pane. It is a better key than a
      // directory — but `findLiveSession` is asked about a cwd, not a pane, and a repair that silently
      // needed a different question would be the kind of split path this file exists to avoid.
      return fileEngineSession(env.AMP_SESSIONS_DIR, cwd, startedAtMs, readTranscriptMeta, opts)
    case 'grok':
      // `updates.jsonl` lives under `<encoded-cwd>/<uuid>/`; long cwd values use a hashed group with a
      // `.cwd` sidecar. The file itself is ACP updates and carries no cwd, so derive it from that group.
      return fileEngineSession(join(env.GROK_HOME, 'sessions'), cwd, startedAtMs, async (path) => {
        if (basename(path) !== 'updates.jsonl') return null
        const sessionDir = dirname(path)
        const group = dirname(sessionDir)
        let root = ''
        try { root = decodeURIComponent(basename(group)) } catch { /* hashed layout below */ }
        if (!root.startsWith('/')) root = (await readFile(join(group, '.cwd'), 'utf8').catch(() => '')).trim()
        return root ? { cwd: root, sessionId: basename(sessionDir) } : null
      }, opts)
    case 'opencode':
      // time_created is epoch MILLISECONDS here.
      return dbEngineSession(
        join(env.OPENCODE_DATA_DIR, 'opencode.db'),
        `SELECT id FROM session WHERE directory IN (${dirList}) AND parent_id IS NULL`
          + ` AND (time_created >= ${Math.trunc(sinceMs)} OR time_updated >= ${Math.trunc(sinceMs)})`
          + ` ORDER BY time_updated DESC LIMIT 2;`,
      )
    case 'kilo':
      // Same store shape as opencode (measured: `session` is byte-identical between the two DBs), and
      // time_created is epoch MILLISECONDS here too — the real row on this machine reads 1786091927554.
      return dbEngineSession(
        join(env.KILO_DATA_DIR, 'kilo.db'),
        `SELECT id FROM session WHERE directory IN (${dirList}) AND parent_id IS NULL`
          + ` AND (time_created >= ${Math.trunc(sinceMs)} OR time_updated >= ${Math.trunc(sinceMs)})`
          + ` ORDER BY time_updated DESC LIMIT 2;`,
      )
    case 'hermes':
      // started_at is epoch SECONDS (fractional).
      return dbEngineSession(
        join(env.HERMES_HOME, 'state.db'),
        `SELECT id FROM sessions WHERE cwd IN (${dirList}) AND started_at >= ${Math.trunc(sinceMs / 1000)}`
          + ` ORDER BY started_at DESC LIMIT 2;`,
      )
    case 'devin':
      // created_at is epoch SECONDS (integer).
      return dbEngineSession(
        join(env.DEVIN_HOME, 'sessions.db'),
        // created_at is when the session began; last_activity_at moves when devin resumes into it, which
        // is the only marker a continued session leaves behind.
        `SELECT id FROM sessions WHERE working_directory IN (${dirList})`
          + ` AND (created_at >= ${Math.trunc(sinceMs / 1000)} OR last_activity_at >= ${Math.trunc(sinceMs / 1000)})`
          + ` ORDER BY last_activity_at DESC LIMIT 2;`,
      )
    case 'copilot': {
      // The lock the process holds is the only thing a `/resume` leaves behind, and it is exact.
      // Fall through to the directory scan when there is no pid or no lock yet (a brand-new session
      // takes its lock only once Copilot creates it).
      const locked = opts?.pid ? await copilotSessionForPid(env.COPILOT_HOME, opts.pid) : null
      if (locked) {
        const transcriptPath = await findCopilotTranscript(env.COPILOT_HOME, locked)
        return { sessionId: locked, transcriptPath: transcriptPath ?? undefined }
      }
      return copilotDirectoryScan(cwd, startedAtMs, opts)
    }

    case 'agy':
      // The one engine here that cannot be found by directory. agy's transcript records no cwd, its
      // brain directory is named by the conversation id, and `conversation_summaries.db` — which looks
      // like the index for exactly this — holds only IDE rows, never CLI ones (measured on 1.1.14).
      //
      // What it does leave is `presence/<conversationId>.lock`, held open by the live process for the
      // life of the conversation. That is a pid→conversation map and a liveness test in one, so repair
      // asks the process rather than the directory. Without a pid there is nothing to ask.
      return opts?.pid ? agySession(opts.pid) : null
    default:
      return null
  }
}

/** The conversation the given `agy` pid is holding, if its transcript exists yet. */
async function agySession(pid: number): Promise<RepairedSession | null> {
  const conversationId = await agyConversationForPid(env.AGY_HOME, pid)
  if (!conversationId) return null
  const transcriptPath = await findAgyTranscript(env.AGY_HOME, conversationId)
  // A conversation with no transcript is one agy has opened but not written to; registry derives the
  // path anyway, so bind it and let the watcher pick the file up when it appears.
  return { sessionId: conversationId, transcriptPath: transcriptPath ?? undefined }
}
