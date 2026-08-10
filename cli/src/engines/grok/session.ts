import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

/** Resolve Grok's `updates.jsonl`, including its hashed-directory fallback for very long cwd names. */
export async function findGrokTranscript(grokHome: string, cwd: string, sessionId: string): Promise<string | null> {
  if (!cwd || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null
  const root = join(grokHome, 'sessions')
  const direct = join(root, encodeURIComponent(cwd), sessionId, 'updates.jsonl')
  if (await isFile(direct)) return direct
  const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const dir = join(root, group.name)
    const recorded = await readFile(join(dir, '.cwd'), 'utf8').catch(() => '')
    if (recorded.trim() !== cwd) continue
    const candidate = join(dir, sessionId, 'updates.jsonl')
    if (await isFile(candidate)) return candidate
  }
  return null
}
