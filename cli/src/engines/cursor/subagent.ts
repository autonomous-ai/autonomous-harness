import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { LiveEvent, SessionEvent } from '../../lib/normalize.js'
import {
  CursorNormalizer,
  cursorMessagesToEvents,
  cursorTaskId,
  cursorUserText,
  lastCursorTurnText,
  type CursorReplayTaskLink,
  type CursorTaskCompletion,
  type CursorTaskHook,
} from './normalizer.js'
import { findCursorTranscript } from './discovery.js'

type JsonObject = Record<string, unknown>

interface ChildMeta {
  agentId: string
  createdAt?: number
  subagentInfo: {
    parentAgentId: string
    rootParentAgentId?: string
    toolCallId: string
    typeName?: string
  }
}

interface PendingTask {
  parentId: string
  launcherId: string
  hook: CursorTaskHook
  normalizer: CursorNormalizer
  startedAt: number
  timer: NodeJS.Timeout | null
  attempts: number
}

interface Database {
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined }
  close(): void
}

type DatabaseConstructor = new(path: string, options: { readOnly: boolean }) => Database

const META_MAX_BYTES = 64 * 1024
const RESOLVE_MAX_ATTEMPTS = 600

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

async function databaseConstructor(): Promise<DatabaseConstructor | null> {
  try {
    const moduleName = 'node:sqlite'
    const mod = await import(moduleName) as { DatabaseSync?: DatabaseConstructor }
    return mod.DatabaseSync ?? null
  } catch {
    return null
  }
}

async function readChildMeta(chatsRoot: string, dbPath: string): Promise<ChildMeta | null> {
  let actualRoot: string
  let actual: string
  try {
    [actualRoot, actual] = await Promise.all([realpath(chatsRoot), realpath(dbPath)])
    const info = await stat(actual)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!info.isFile() || !isWithin(actualRoot, actual) || (uid !== null && info.uid !== uid)) return null
  } catch {
    return null
  }
  const DatabaseSync = await databaseConstructor()
  if (!DatabaseSync) return null
  let db: Database | null = null
  try {
    db = new DatabaseSync(actual, { readOnly: true })
    const row = db.prepare("SELECT value FROM meta WHERE key = '0' LIMIT 1").get()
    const encoded = string(row?.value)
    if (!encoded || encoded.length > META_MAX_BYTES * 2 || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) return null
    const decoded = Buffer.from(encoded, 'hex').toString('utf8')
    if (Buffer.byteLength(decoded) > META_MAX_BYTES) return null
    const raw = object(JSON.parse(decoded))
    const subagent = object(raw?.subagentInfo)
    const agentId = string(raw?.agentId)
    const parentAgentId = string(subagent?.parentAgentId)
    const toolCallId = string(subagent?.toolCallId)
    if (!agentId || basename(dirname(actual)) !== agentId || !parentAgentId || !toolCallId) return null
    return {
      agentId,
      createdAt: typeof raw?.createdAt === 'number' ? raw.createdAt : undefined,
      subagentInfo: {
        parentAgentId,
        rootParentAgentId: string(subagent?.rootParentAgentId) || undefined,
        toolCallId,
        typeName: string(subagent?.typeName) || undefined,
      },
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* read-only best effort */ }
  }
}

async function parentChatDir(cursorHome: string, parentId: string): Promise<string | null> {
  const chatsRoot = join(cursorHome, 'chats')
  let roots: string[]
  try { roots = await readdir(chatsRoot) } catch { return null }
  for (const root of roots) {
    const candidate = join(chatsRoot, root, parentId, 'store.db')
    try {
      if ((await stat(candidate)).isFile()) return dirname(dirname(candidate))
    } catch {
      // next workspace hash
    }
  }
  return null
}

async function childMetas(cursorHome: string, parentId: string): Promise<ChildMeta[]> {
  const dir = await parentChatDir(cursorHome, parentId)
  if (!dir) return []
  const chatsRoot = join(cursorHome, 'chats')
  let children: string[]
  try { children = await readdir(dir) } catch { return [] }
  const values = await Promise.all(children.map((child) => readChildMeta(chatsRoot, join(dir, child, 'store.db'))))
  return values.filter((value): value is ChildMeta => value?.subagentInfo.parentAgentId === parentId)
}

function firstUserPrompt(lines: string[]): string {
  for (const line of lines) {
    try {
      const raw = object(JSON.parse(line))
      const message = object(raw?.message)
      const content = Array.isArray(message?.content) ? message.content : []
      if (raw?.role !== 'user') continue
      for (const block of content) {
        const item = object(block)
        if (item?.type !== 'text') continue
        return cursorUserText(string(item.text)) ?? ''
      }
    } catch {
      // malformed child line
    }
  }
  return ''
}

function terminalStatus(lines: string[]): { complete: boolean; isError: boolean } {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const raw = object(JSON.parse(lines[i]))
      if (raw?.type === 'turn_ended') return { complete: true, isError: string(raw.status) === 'error' }
    } catch {
      // keep searching
    }
  }
  return { complete: false, isError: false }
}

async function childCompletion(
  cursorHome: string,
  meta: ChildMeta,
  observedDurationMs?: number,
): Promise<(CursorTaskCompletion & { prompt: string }) | null> {
  const transcript = await findCursorTranscript(cursorHome, meta.agentId)
  if (!transcript) return null
  let raw: string
  try { raw = await readFile(transcript, 'utf8') } catch { return null }
  const lines = raw.split('\n').filter((line) => line.trim())
  const terminal = terminalStatus(lines)
  if (!terminal.complete) return null
  const events = cursorMessagesToEvents(lines, meta.agentId)
    .filter((event): event is SessionEvent => event.type === 'tool_start' || event.type === 'tool_end')
  const last = lastCursorTurnText(lines)
  return {
    prompt: firstUserPrompt(lines),
    output: last?.assistantText ?? (terminal.isError ? 'Subagent failed' : 'Subagent completed'),
    isError: terminal.isError,
    agentId: meta.agentId,
    agentType: meta.subagentInfo.typeName,
    totalToolUseCount: events.filter((event) => event.type === 'tool_start').length,
    totalDurationMs: observedDurationMs,
    events,
  }
}

export async function loadCursorReplayTaskLinks(
  cursorHome: string,
  parentId: string,
): Promise<CursorReplayTaskLink[]> {
  const links: CursorReplayTaskLink[] = []
  for (const meta of await childMetas(cursorHome, parentId)) {
    const completion = await childCompletion(cursorHome, meta)
    if (!completion) continue
    links.push({
      ...completion,
      toolUseId: meta.subagentInfo.toolCallId,
      prompt: completion.prompt,
    })
  }
  return links
}

export class CursorSubagentManager {
  private readonly pending = new Map<string, PendingTask>()

  constructor(
    private readonly cursorHome: string,
    private readonly emit: (parentId: string, events: LiveEvent[]) => void,
  ) {}

  register(parentId: string, hook: CursorTaskHook, normalizer: CursorNormalizer): void {
    const launcherId = cursorTaskId(parentId, hook.toolUseId)
    if (this.pending.has(hook.toolUseId)) return
    const task: PendingTask = {
      parentId,
      launcherId,
      hook,
      normalizer,
      startedAt: Date.now(),
      timer: null,
      attempts: 0,
    }
    this.pending.set(hook.toolUseId, task)
    this.schedule(task, 50)
  }

  closeParent(parentId: string, isError = false): void {
    setTimeout(() => {
      const tasks = [...this.pending.values()].filter((task) => task.parentId === parentId)
      if (tasks.length === 0) return
      for (const task of tasks) this.clear(task)
      const normalizer = tasks[0].normalizer
      this.emit(parentId, normalizer.closeOutstandingTasks(isError))
    }, 2_000)
  }

  forget(parentId: string): void {
    for (const task of [...this.pending.values()]) if (task.parentId === parentId) this.clear(task)
  }

  stop(): void {
    for (const task of [...this.pending.values()]) this.clear(task)
  }

  private schedule(task: PendingTask, delay: number): void {
    task.timer = setTimeout(() => void this.resolve(task), delay)
  }

  private async resolve(task: PendingTask): Promise<void> {
    if (this.pending.get(task.hook.toolUseId) !== task) return
    task.attempts++
    try {
      const meta = (await childMetas(this.cursorHome, task.parentId))
        .find((candidate) => candidate.subagentInfo.toolCallId === task.hook.toolUseId)
      if (meta) {
        const completion = await childCompletion(this.cursorHome, meta, Date.now() - task.startedAt)
        if (completion) {
          this.clear(task)
          this.emit(task.parentId, task.normalizer.completeTask(task.launcherId, completion))
          return
        }
      }
    } catch {
      // retry while the parent turn is alive
    }
    if (task.attempts >= RESOLVE_MAX_ATTEMPTS) {
      this.clear(task)
      this.emit(task.parentId, task.normalizer.completeTask(task.launcherId, {
        output: '',
        isError: false,
      }))
      return
    }
    this.schedule(task, task.attempts < 20 ? 250 : 1_000)
  }

  private clear(task: PendingTask): void {
    if (task.timer) clearTimeout(task.timer)
    this.pending.delete(task.hook.toolUseId)
  }
}
