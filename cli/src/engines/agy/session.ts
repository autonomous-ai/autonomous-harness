import { execFile } from 'child_process'
import { readdir, readlink, stat } from 'fs/promises'
import { basename, join, sep } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<AGY_HOME>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`. */
export function agyTranscriptPath(agyHome: string, conversationId: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null
  return join(agyHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

/**
 * Resolve a live agy transcript.
 *
 * The hook payload names this exact path, so this is the fallback for a session discovered without
 * one. The `_full` file is the one to tail — see the normalizer header for why.
 */
export async function findAgyTranscript(agyHome: string, conversationId: string): Promise<string | null> {
  const path = agyTranscriptPath(agyHome, conversationId)
  return path && await isFile(path) ? path : null
}

export interface AgyConversation {
  conversationId: string
  transcriptPath: string
  /** Last write to the transcript — the only ordering signal agy leaves for the CLI. */
  mtimeMs: number
  birthMs: number
}

/**
 * Every conversation with a transcript on disk, newest write first.
 *
 * agy's `conversation_summaries.db` looks like the index for this and is NOT one: measured on 1.1.14
 * it holds only IDE (`app_data_dir='antigravity'`) rows, and CLI conversations never appear in it.
 * The brain directory is the authority.
 */
export async function listAgyConversations(agyHome: string): Promise<AgyConversation[]> {
  const root = join(agyHome, 'brain')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found: AgyConversation[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONVERSATION_ID.test(entry.name)) continue
    const transcriptPath = join(root, entry.name, '.system_generated', 'logs', 'transcript_full.jsonl')
    const info = await stat(transcriptPath).catch(() => null)
    if (!info?.isFile()) continue
    found.push({
      conversationId: entry.name,
      transcriptPath,
      mtimeMs: info.mtimeMs,
      birthMs: info.birthtimeMs || info.ctimeMs,
    })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * The conversation a live `agy` process is holding, read from the lock it keeps open.
 *
 * agy flocks `<AGY_HOME>/presence/<conversationId>.lock` for the life of a conversation and holds the
 * descriptor open (measured: pid 91701 ↔ `ae51057a…`). That makes it the one pid→conversation map the
 * CLI leaves behind, and it doubles as a liveness test — a stale lock file has no holder.
 *
 * It is the only route available to process-repair: agy's transcript records no cwd, its directory is
 * named by the conversation id, and `ANTIGRAVITY_CONVERSATION_ID` is exported to hook children but not
 * into agy's own environment, so neither the file nor `/proc/<pid>/environ` can answer this.
 */
export async function agyConversationForPid(agyHome: string, pid: number): Promise<string | null> {
  const marker = join(agyHome, 'presence') + sep
  const paths = process.platform === 'linux' ? await linuxFdTargets(pid) : await lsofTargets(pid)
  for (const path of paths) {
    if (!path.startsWith(marker) || !path.endsWith('.lock')) continue
    const id = basename(path, '.lock')
    if (CONVERSATION_ID.test(id)) return id
  }
  return null
}

async function linuxFdTargets(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const entries = await readdir(dir).catch(() => [])
  const targets: string[] = []
  for (const entry of entries) {
    const target = await readlink(join(dir, entry)).catch(() => '')
    if (target) targets.push(target)
  }
  return targets
}

async function lsofTargets(pid: number): Promise<string[]> {
  // -Fn prints one `n<path>` record per descriptor and nothing else; -w silences the warnings lsof
  // emits for file systems it cannot stat, which would otherwise land on stderr on every poll.
  const out = await execFileAsync('lsof', ['-w', '-p', String(pid), '-Fn'], { timeout: 4_000 })
    .then((r) => r.stdout)
    .catch((err: { stdout?: string }) => err.stdout ?? '')
  return out.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1))
}
