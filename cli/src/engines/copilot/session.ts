import { readdir, stat } from 'fs/promises'
import { join } from 'path'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`.
 *
 * Deterministic from the session id alone, and confirmed by Copilot itself: the `agentStop` hook
 * reports this exact path in `transcriptPath`.
 */
export function copilotTranscriptPath(copilotHome: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  return join(copilotHome, 'session-state', sessionId, 'events.jsonl')
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

export async function findCopilotTranscript(copilotHome: string, sessionId: string): Promise<string | null> {
  const path = copilotTranscriptPath(copilotHome, sessionId)
  return path && await isFile(path) ? path : null
}

export interface CopilotSessionFile {
  sessionId: string
  transcriptPath: string
  mtimeMs: number
  birthMs: number
}

/** Every session with an event stream on disk, newest write first. */
export async function listCopilotSessions(copilotHome: string): Promise<CopilotSessionFile[]> {
  const root = join(copilotHome, 'session-state')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: CopilotSessionFile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
    const transcriptPath = join(root, entry.name, 'events.jsonl')
    const info = await stat(transcriptPath).catch(() => null)
    if (!info?.isFile()) continue
    found.push({
      sessionId: entry.name,
      transcriptPath,
      mtimeMs: info.mtimeMs,
      birthMs: info.birthtimeMs || info.ctimeMs,
    })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * The cwd a Copilot session was started in, read from its first record.
 *
 * `session.start` carries `data.context.cwd`. Sessions are named by uuid, not by directory, so this is
 * the only link between a session file and the pane that owns it.
 */
export function copilotSessionCwd(firstLines: string[]): string | null {
  for (const line of firstLines) {
    try {
      const record = JSON.parse(line) as { type?: unknown; data?: { context?: { cwd?: unknown } } }
      if (record?.type !== 'session.start') continue
      const cwd = record.data?.context?.cwd
      return typeof cwd === 'string' && cwd ? cwd : null
    } catch { /* a partial write mid-flush; the next poll sees the whole line */ }
  }
  return null
}

/**
 * The session a live Copilot process is CURRENTLY in, read from the lock it takes on the directory.
 *
 * Copilot writes `session-state/<sessionId>/inuse.<pid>.lock` when a process opens a session, and
 * `/resume` inside the CLI opens another one — measured: pid 63310 held two locks at once, the session
 * it started with and the one it switched to. So the lock is not one-per-process, and the NEWEST is
 * the answer.
 *
 * This is the only trace a resume leaves. It writes nothing to the transcript (measured: pick a
 * session and not one byte of `events.jsonl` changes) and fires no hook until the first prompt, which
 * is why a directory scan cannot find it and why the agent used to sit unbound after `/resume`.
 */
export async function copilotSessionForPid(copilotHome: string, pid: number): Promise<string | null> {
  const root = join(copilotHome, 'session-state')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  let best: { sessionId: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
    const info = await stat(join(root, entry.name, `inuse.${pid}.lock`)).catch(() => null)
    if (!info) continue
    if (!best || info.mtimeMs > best.mtimeMs) best = { sessionId: entry.name, mtimeMs: info.mtimeMs }
  }
  return best?.sessionId ?? null
}
