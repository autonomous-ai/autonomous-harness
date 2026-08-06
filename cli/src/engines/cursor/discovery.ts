import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { validTranscriptPath } from '../../lib/registry.js'

const SESSION_RE = /^[0-9a-f-]{16,}$/i

export class CursorTranscriptDiscovery {
  private watcher: FSWatcher | null = null
  private readonly pending = new Set<string>()

  constructor(
    private readonly cursorHome: string,
    private readonly onFound: (sessionId: string, transcriptPath: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.watcher) return
    const root = join(this.cursorHome, 'projects')
    await mkdir(root, { recursive: true })
    this.watcher = chokidar.watch(root, {
      ignoreInitial: false,
      depth: 5,
      // Cursor also places Unix sockets below project roots. Watching those can fail on macOS and
      // is unnecessary: discovery consumes only transcript JSONL files.
      ignored: (path, info) => Boolean(info && !info.isDirectory() && !path.endsWith('.jsonl')),
    })
    this.watcher
      .on('add', (path: string) => this.inspect(path))
      .on('change', (path: string) => this.inspect(path))
      .on('error', (err: unknown) => console.error('[cursor-discovery] watcher error:', err))
  }

  async add(sessionId: string): Promise<void> {
    if (!SESSION_RE.test(sessionId)) return
    const found = await findCursorTranscript(this.cursorHome, sessionId)
    if (found) {
      this.onFound(sessionId, found)
      return
    }
    this.pending.add(sessionId)
  }

  remove(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  async stop(): Promise<void> {
    this.pending.clear()
    await this.watcher?.close()
    this.watcher = null
  }

  private inspect(path: string): void {
    const normalized = path.replace(/\\/g, '/')
    const match = /\/agent-transcripts\/([^/]+)\/\1\.jsonl$/.exec(normalized)
    const sessionId = match?.[1]
    if (!sessionId || !this.pending.has(sessionId) || !validTranscriptPath('cursor', path)) return
    this.pending.delete(sessionId)
    this.onFound(sessionId, path)
  }
}

export async function findCursorTranscript(cursorHome: string, sessionId: string): Promise<string | null> {
  if (!SESSION_RE.test(sessionId)) return null
  const root = join(cursorHome, 'projects')
  let projects: string[]
  try { projects = await readdir(root) } catch { return null }
  for (const project of projects) {
    const candidate = join(root, project, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    if (validTranscriptPath('cursor', candidate)) return candidate
  }
  return null
}
