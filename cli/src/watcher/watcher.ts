/** Registration-driven JSONL tailer. It watches only transcript files already admitted by the
 * tmux-backed registry, so inactive Claude/Codex history is never discovered or exposed. */

import { EventEmitter } from 'events'
import chokidar, { type FSWatcher } from 'chokidar'
import { open, readFile, stat } from 'fs/promises'
import { basename, dirname } from 'path'
import type { AgentEngine } from '../engines/types.js'

export interface WatchedSession {
  sessionId: string
  engine: AgentEngine
  transcriptPath: string
}

export interface LineEvent {
  sessionId: string
  engine: AgentEngine
  projectDir: string
  text: string
  seq: number
  ts: number
}

interface FileState extends WatchedSession {
  offset: number
  partial: string
  seq: number
  debounce: NodeJS.Timeout | null
  reading: boolean
  pending: boolean
  cursorLines: string[]
}

const DEBOUNCE_MS = 40

export class Watcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private files = new Map<string, FileState>()
  private bySession = new Map<string, string>()

  start(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch([], { ignoreInitial: false, alwaysStat: true })
    this.watcher
      .on('add', (filePath: string) => this.schedule(filePath))
      .on('change', (filePath: string) => { this.noteChange(filePath); this.schedule(filePath) })
      .on('unlink', (filePath: string) => {
        const state = this.files.get(filePath)
        if (state) state.pending = true // keep registration; a rotate/recreate may follow
      })
      .on('error', (err: unknown) => console.error('[watcher] error:', err))
    if (this.files.size) this.watcher.add([...this.files.keys()])
  }

  /** Attach one trusted transcript. Runtime hydration is handled by cli.ts; the tail starts at EOF. */
  async addSession(session: WatchedSession, opts: { fromStart?: boolean } = {}): Promise<void> {
    const oldPath = this.bySession.get(session.sessionId)
    if (oldPath && oldPath !== session.transcriptPath) await this.removeSession(session.sessionId)

    let offset = 0
    let cursorLines: string[] = []
    if (!opts.fromStart) {
      try { offset = (await stat(session.transcriptPath)).size } catch { offset = 0 }
      if (session.engine === 'cursor') {
        try { cursorLines = completeLines(await readFile(session.transcriptPath, 'utf8')) } catch { cursorLines = [] }
      }
    }
    const existing = this.files.get(session.transcriptPath)
    if (existing) {
      existing.engine = session.engine
      existing.sessionId = session.sessionId
      this.bySession.set(session.sessionId, session.transcriptPath)
      return
    }
    // Two rounds of "the CLI accepted it but the adapter never saw the line" were spent guessing whether
    // this registration had happened at all. Say it once per file, with the offset it starts from.
    console.log(`[watcher] tail ${session.engine} ${session.sessionId.slice(0, 8)} @${offset} · ${session.transcriptPath}`)
    this.files.set(session.transcriptPath, {
      ...session,
      offset,
      partial: '',
      seq: 0,
      debounce: null,
      reading: false,
      pending: false,
      cursorLines,
    })
    this.bySession.set(session.sessionId, session.transcriptPath)
    this.watcher?.add(session.transcriptPath)
    if (opts.fromStart) this.schedule(session.transcriptPath)
  }

  async removeSession(sessionId: string): Promise<void> {
    const filePath = this.bySession.get(sessionId)
    if (!filePath) return
    this.bySession.delete(sessionId)
    const state = this.files.get(filePath)
    if (state?.debounce) clearTimeout(state.debounce)
    this.files.delete(filePath)
    await this.watcher?.unwatch(filePath)
  }

  async stop(): Promise<void> {
    for (const state of this.files.values()) if (state.debounce) clearTimeout(state.debounce)
    this.files.clear()
    this.bySession.clear()
    if (this.watcher) await this.watcher.close()
    this.watcher = null
  }

  /** Re-read every registered file to EOF. Used by the low-frequency full reconciliation pass. */
  async pollAll(): Promise<void> {
    await Promise.all([...this.files.keys()].map(async (filePath) => {
      await this.readNew(filePath)
      // A chokidar read may already own this file. readNew() marks it pending in that case;
      // wait for the owner to finish its pending pass so reconciliation really reaches EOF.
      while (this.files.get(filePath)?.reading) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }))
  }

  async pollSession(sessionId: string): Promise<void> {
    const filePath = this.bySession.get(sessionId)
    if (!filePath) return
    await this.readNew(filePath)
    while (this.files.get(filePath)?.reading) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  /** Chokidar told us the file moved. Logged for commandcode/devin only, whose whole turn lifecycle rides
   *  on these reads — for claude the hooks say the same thing and this would just be noise. */
  private noteChange(filePath: string): void {
    const state = this.files.get(filePath)
    if (state && (state.engine === 'commandcode' || state.engine === 'devin')) {
      console.log(`[watcher] change ${state.engine} ${state.sessionId.slice(0, 8)} @${state.offset}`)
    }
  }

  private schedule(filePath: string): void {
    const state = this.files.get(filePath)
    if (!state) return
    if (state.debounce) clearTimeout(state.debounce)
    state.debounce = setTimeout(() => {
      state.debounce = null
      void this.readNew(filePath)
    }, DEBOUNCE_MS)
  }

  private async readNew(filePath: string): Promise<void> {
    const state = this.files.get(filePath)
    if (!state) return
    if (state.reading) { state.pending = true; return }
    state.reading = true
    try {
      do {
        state.pending = false
        await this.readOnce(filePath, state)
      } while (state.pending && this.files.get(filePath) === state)
    } finally {
      state.reading = false
    }
  }

  private async readOnce(filePath: string, state: FileState): Promise<void> {
    if (state.engine === 'cursor') {
      await this.readCursor(filePath, state)
      return
    }
    let size: number
    try { size = (await stat(filePath)).size } catch { return }
    if (size < state.offset) {
      state.offset = 0
      state.partial = ''
    }
    if (size <= state.offset) return

    const start = state.offset
    let chunk = ''
    try {
      const fh = await open(filePath, 'r')
      try {
        const buf = Buffer.alloc(size - start)
        const { bytesRead } = await fh.read(buf, 0, buf.length, start)
        chunk = buf.subarray(0, bytesRead).toString('utf8')
        state.offset = start + bytesRead
      } finally {
        await fh.close()
      }
    } catch (err) {
      console.error(`[watcher] read failed (${basename(filePath)}):`, err)
      return
    }

    const combined = state.partial + chunk
    const lines = combined.split('\n')
    state.partial = combined.endsWith('\n') ? '' : (lines.pop() ?? '')
    for (const raw of lines) {
      const text = raw.replace(/\r$/, '')
      if (!text.trim()) continue
      this.emit('line', {
        sessionId: state.sessionId,
        engine: state.engine,
        projectDir: basename(dirname(filePath)),
        text,
        seq: state.seq++,
        ts: Date.now(),
      } satisfies LineEvent)
    }
  }

  private async readCursor(filePath: string, state: FileState): Promise<void> {
    let next: string[]
    try { next = completeLines(await readFile(filePath, 'utf8')) } catch { return }
    let common = 0
    while (common < state.cursorLines.length && common < next.length && state.cursorLines[common] === next[common]) common++
    state.cursorLines = next
    state.offset = 0
    state.partial = ''
    for (const text of next.slice(common)) {
      if (!text.trim()) continue
      this.emit('line', {
        sessionId: state.sessionId,
        engine: state.engine,
        projectDir: basename(dirname(filePath)),
        text,
        seq: state.seq++,
        ts: Date.now(),
      } satisfies LineEvent)
    }
  }
}

function completeLines(content: string): string[] {
  const lines = content.split('\n')
  if (!content.endsWith('\n')) lines.pop()
  return lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim())
}
