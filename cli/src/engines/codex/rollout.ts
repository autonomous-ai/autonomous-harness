import { closeSync, existsSync, openSync, readSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type JsonObject = Record<string, unknown>

const MAX_WALK_ENTRIES = 5_000
const MAX_META_BYTES = 128 * 1024
const THREAD_ID_RE = /^[a-zA-Z0-9-]{8,128}$/
const CODEX_SESSIONS_DIR = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')

export interface CodexRolloutMeta {
  id: string
  isSubagent: boolean
  parentThreadId: string | null
  /** The directory the session was started in — the only field that identifies WHERE a rollout belongs. */
  cwd: string | null
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

/** Read only the first rollout record, which is Codex's session_meta line. */
export function readCodexRolloutMeta(file: string): CodexRolloutMeta | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(MAX_META_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n').find((line) => line.trim())
    if (!firstLine) return null
    const record = object(JSON.parse(firstLine))
    const payload = object(record?.payload)
    if (record?.type !== 'session_meta' || !payload) return null
    const source = object(payload.source)
    const subagent = source?.subagent
    const spawn = object(object(subagent)?.thread_spawn)
    const parentThreadId = typeof spawn?.parent_thread_id === 'string' && spawn.parent_thread_id
      ? spawn.parent_thread_id
      : null
    return {
      id: typeof payload.id === 'string' ? payload.id : '',
      isSubagent: subagent !== undefined && subagent !== null,
      parentThreadId,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

/** Find one rollout by thread id without scanning unbounded user history. */
export function resolveCodexRollout(threadId: string, root = CODEX_SESSIONS_DIR): string | null {
  if (!THREAD_ID_RE.test(threadId) || !existsSync(root)) return null
  const stack = [root]
  let visited = 0
  while (stack.length && visited < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (++visited > MAX_WALK_ENTRIES) break
      const full = join(dir, name)
      if (name.endsWith('.jsonl')) {
        if (name.includes(threadId)) return full
      } else if (!name.includes('.')) {
        stack.push(full)
      }
    }
  }
  return null
}
