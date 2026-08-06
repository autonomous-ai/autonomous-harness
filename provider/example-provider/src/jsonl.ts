/**
 * Reading Claude Code's own session transcripts.
 *
 * Layout written by the local `claude` CLI:
 *
 *   {CLAUDE_PROJECTS_DIR}/<mangled-cwd>/<sessionId>.jsonl
 *
 * `<mangled-cwd>` is the absolute working directory with every non-alphanumeric character replaced
 * by `-`. **It is lossy and not reversible** — never try to un-mangle it; the real working directory
 * is carried on the `cwd` field of the lines themselves.
 *
 * This is why `agent.history` is required and costs this provider nothing to store: the
 * history already exists on disk. A turn typed straight into a terminal lands here too, so it shows
 * up in the session list — it just does not stream live (this app implements no SubscribeToTask).
 *
 * A real transcript carries TWELVE line types; only `user` and `assistant` hold conversation.
 * Ignoring the rest is the common case, not defensive padding.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Every non-alphanumeric character becomes `-`. Lossy by design. */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** `agent-*.jsonl` are subagent mirrors, not sessions. */
export function isSessionFile(fileName: string): boolean {
  return fileName.endsWith('.jsonl') && !fileName.startsWith('agent-')
}

export function sessionIdFromFile(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, '')
}

export interface TranscriptLine {
  type?: string
  message?: { role?: string; content?: unknown; stop_reason?: string | null }
  toolUseResult?: unknown
  timestamp?: string
  cwd?: string
  sessionId?: string
  uuid?: string
  isSidechain?: boolean
}

export interface SessionSummary {
  sessionId: string
  /** Epoch ms of the newest line, for ordering the session list. */
  updatedAt: number
  /** First user text, for a title — the profile's §10.4 projection. */
  title: string
  messageCount: number
}

export function projectDir(projectsDir: string, cwd: string): string {
  return join(projectsDir, mangleCwd(cwd))
}

/** Conversation lines only, in file order, with sidechain (subagent) lines dropped. */
export function readTranscript(projectsDir: string, cwd: string, sessionId: string): TranscriptLine[] {
  const file = join(projectDir(projectsDir, cwd), `${sessionId}.jsonl`)
  if (!existsSync(file)) return []
  const lines: TranscriptLine[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(raw) as TranscriptLine
    } catch {
      continue // a partially-written trailing line while claude is mid-turn
    }
    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue
    if (parsed.isSidechain) continue
    lines.push(parsed)
  }
  return lines
}

/** Sessions for one agent, newest first. */
export function listSessions(projectsDir: string, cwd: string): SessionSummary[] {
  const dir = projectDir(projectsDir, cwd)
  if (!existsSync(dir)) return []
  const out: SessionSummary[] = []
  for (const name of readdirSync(dir)) {
    if (!isSessionFile(name)) continue
    const sessionId = sessionIdFromFile(name)
    const lines = readTranscript(projectsDir, cwd, sessionId)
    if (!lines.length) continue
    out.push({
      sessionId,
      updatedAt: epoch(lines[lines.length - 1]?.timestamp) || fileMtime(join(dir, name)),
      title: titleOf(lines),
      messageCount: lines.length,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Lines whose timestamp falls inside `[from, to]`. Used to slice one turn out of a session. */
export function sliceByTime(lines: TranscriptLine[], from?: number, to?: number): TranscriptLine[] {
  if (from == null && to == null) return lines
  return lines.filter((l) => {
    const t = epoch(l.timestamp)
    if (!t) return false
    if (from != null && t < from) return false
    if (to != null && t > to) return false
    return true
  })
}

export function epoch(timestamp?: string): number {
  if (!timestamp) return 0
  const t = Date.parse(timestamp)
  return Number.isNaN(t) ? 0 : t
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** First user text in the session, truncated. Profile §10.4. */
function titleOf(lines: TranscriptLine[]): string {
  for (const line of lines) {
    if (line.type !== 'user') continue
    const text = textOf(line.message?.content)
    if (text) return text.length > 80 ? `${text.slice(0, 77)}…` : text
  }
  return 'Untitled'
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim()
}
