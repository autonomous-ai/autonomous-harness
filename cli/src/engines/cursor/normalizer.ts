import { createHash } from 'node:crypto'
import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

interface PendingTool {
  tool: string
  fromHook: boolean
}

interface CursorTodo {
  id: string
  content: string
  status: string
}

export interface CursorTaskHook {
  toolUseId: string
  input: unknown
}

export interface CursorTaskCompletion {
  output: string
  isError: boolean
  agentId?: string
  agentType?: string
  totalToolUseCount?: number
  totalDurationMs?: number
  events?: SessionEvent[]
}

export interface CursorReplayTaskLink extends CursorTaskCompletion {
  toolUseId: string
  prompt: string
  description?: string
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parse(line: string): JsonObject | null {
  try { return object(JSON.parse(line)) } catch { return null }
}

function clip(value: string): string {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n...[truncated]` : value
}

function contentBlocks(raw: JsonObject): JsonObject[] {
  const message = object(raw.message)
  return Array.isArray(message?.content)
    ? message.content.map(object).filter((item): item is JsonObject => item !== null)
    : []
}

function cursorAssistantText(rawText: string): string | null {
  const lines = rawText.split(/\r?\n/)
  while (lines.at(-1)?.trim() === '[REDACTED]') {
    lines.pop()
    while (lines.at(-1)?.trim() === '') lines.pop()
  }
  const text = lines.join('\n').trimEnd()
  return text.trim() ? text : null
}

export function cursorUserText(rawText: string): string | null {
  const wrapped = /^\s*<timestamp>[\s\S]*?<\/timestamp>\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/.exec(rawText)
  if (wrapped) return wrapped[1].trim()
  return rawText.trim() || null
}

function taskInput(value: unknown): JsonObject {
  return object(value) ?? {}
}

function cursorToolInput(tool: string, value: unknown): unknown {
  const input = object(value)
  if (tool === 'WebSearch' && input && !string(input.query) && string(input.search_term)) {
    return { ...input, query: input.search_term }
  }
  return value ?? {}
}

function taskKey(value: unknown): string {
  const input = taskInput(value)
  return JSON.stringify({
    description: string(input.description),
    prompt: string(input.prompt),
    model: string(input.model),
  })
}

export function cursorTaskId(sessionId: string, toolUseId: string): string {
  return `cursor-task:${createHash('sha256').update(sessionId).update('\0').update(toolUseId).digest('hex')}`
}

function taskSummary(output: string, isError: boolean): string {
  if (isError) return 'Subagent failed'
  return output.trim().split('\n')[0]?.slice(0, 120) || 'Subagent completed'
}

function applyTodoInput(
  todoById: Map<string, CursorTodo>,
  todoOrder: string[],
  value: unknown,
): boolean {
  const input = object(value)
  const merge = input?.merge
  const todos = Array.isArray(input?.todos) ? input.todos : null
  if (typeof merge !== 'boolean' || !todos) return false
  if (!merge) {
    todoById.clear()
    todoOrder.splice(0)
  }
  for (const rawTodo of todos) {
    const todo = object(rawTodo)
    const todoId = string(todo?.id)
    if (!todoId) continue
    if (todo?.status === 'deleted') {
      todoById.delete(todoId)
      const index = todoOrder.indexOf(todoId)
      if (index >= 0) todoOrder.splice(index, 1)
      continue
    }
    const previous = todoById.get(todoId)
    const content = string(todo?.content) || previous?.content || ''
    if (!content) continue
    const rawStatus = string(todo?.status)
    const status = TODO_STATUSES.has(rawStatus) ? rawStatus : previous?.status ?? 'pending'
    if (!previous) todoOrder.push(todoId)
    todoById.set(todoId, { id: todoId, content, status })
  }
  return true
}

function todoSnapshot(todoById: Map<string, CursorTodo>, todoOrder: string[]): CursorTodo[] {
  return todoOrder
    .map((todoId) => todoById.get(todoId))
    .filter((todo): todo is CursorTodo => todo !== undefined)
}

function cursorTodoState(rawLines: string[]): CursorTodo[] {
  const todoById = new Map<string, CursorTodo>()
  const todoOrder: string[] = []
  for (const line of rawLines) {
    const raw = parse(line)
    if (raw?.role !== 'assistant') continue
    for (const block of contentBlocks(raw)) {
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        applyTodoInput(todoById, todoOrder, block.input)
      }
    }
  }
  return todoSnapshot(todoById, todoOrder)
}

export class CursorNormalizer implements EngineNormalizer {
  private open = false
  private recordIndex: number
  private readonly pending = new Map<string, PendingTool>()
  private readonly hookQueue: Array<{ id: string; key: string; matched: boolean }> = []
  private readonly todoById = new Map<string, CursorTodo>()
  private readonly todoOrder: string[] = []
  private readonly replayLinks: CursorReplayTaskLink[]

  constructor(
    private readonly mode: 'live' | 'replay',
    private readonly sessionId: string,
    options: {
      startIndex?: number
      replayLinks?: CursorReplayTaskLink[]
      initialTodos?: CursorTodo[]
    } = {},
  ) {
    this.recordIndex = options.startIndex ?? 0
    this.replayLinks = [...(options.replayLinks ?? [])]
    for (const todo of options.initialTodos ?? []) {
      this.todoOrder.push(todo.id)
      this.todoById.set(todo.id, { ...todo })
    }
  }

  get turnOpen(): boolean { return this.open }

  ingest(line: string): LiveEvent[] {
    const index = this.recordIndex++
    const raw = parse(line)
    if (!raw) return []

    if (raw.type === 'turn_ended') {
      return this.finishTurn(string(raw.status).toLowerCase() === 'error')
    }

    if (raw.role === 'user') {
      const first = contentBlocks(raw).find((block) => block.type === 'text')
      const userText = cursorUserText(string(first?.text))
      if (!userText) return []
      if (this.mode === 'replay') {
        this.open = true
        return [{ type: 'user_message', payload: { content: userText } }]
      }
      const events: LiveEvent[] = []
      if (this.open) events.push(...this.finishTurn(false))
      this.open = true
      events.push({ type: 'turn_started', payload: { userMessage: userText } })
      return events
    }

    if (raw.role !== 'assistant') return []
    const events: LiveEvent[] = []
    const blocks = contentBlocks(raw)
    for (let contentIndex = 0; contentIndex < blocks.length; contentIndex++) {
      const block = blocks[contentIndex]
      if (block.type === 'text') {
        const text = cursorAssistantText(string(block.text))
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
        continue
      }
      if (block.type !== 'tool_use') continue
      const tool = string(block.name) || 'Tool'
      const input = cursorToolInput(tool, block.input)
      const id = `cursor:${this.sessionId}:${index}:${contentIndex}`
      if (tool === 'TodoWrite') {
        events.push(...this.todoEvents(id, input))
      } else if (tool === 'Task') {
        events.push(...this.taskEvents(id, input))
      } else {
        this.pending.set(id, { tool, fromHook: false })
        events.push({ type: 'tool_start', payload: { id, tool, input } })
      }
    }
    return events
  }

  ingestTaskHook(hook: CursorTaskHook): LiveEvent[] {
    if (!hook.toolUseId) return []
    const id = cursorTaskId(this.sessionId, hook.toolUseId)
    if (this.pending.has(id)) return []
    this.pending.set(id, { tool: 'Task', fromHook: true })
    this.hookQueue.push({ id, key: taskKey(hook.input), matched: false })
    return [{ type: 'tool_start', payload: { id, tool: 'Task', input: hook.input } }]
  }

  completeTask(id: string, completion: CursorTaskCompletion): LiveEvent[] {
    const pending = this.pending.get(id)
    if (!pending || pending.tool !== 'Task') return []
    this.pending.delete(id)
    const events: LiveEvent[] = []
    for (const event of completion.events ?? []) {
      if (event.type === 'tool_start') {
        events.push({ type: 'tool_start', payload: { ...event.payload, parentToolUseId: id } })
      } else if (event.type === 'tool_end') {
        events.push({ type: 'tool_end', payload: { ...event.payload, parentToolUseId: id } })
      }
    }
    const output = completion.output || (completion.isError ? 'Subagent failed' : 'Subagent completed')
    events.push({
      type: 'tool_end',
      payload: {
        id,
        tool: 'Task',
        output: clip(output),
        isError: completion.isError,
        summary: taskSummary(output, completion.isError),
        subagent: completion.agentId || completion.agentType || completion.totalToolUseCount != null
          ? {
              agentId: completion.agentId,
              agentType: completion.agentType,
              totalToolUseCount: completion.totalToolUseCount,
              totalDurationMs: completion.totalDurationMs,
            }
          : undefined,
      },
    })
    return events
  }

  closeOutstandingTasks(isError = false): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const [id, pending] of [...this.pending]) {
      if (pending.tool !== 'Task') continue
      this.pending.delete(id)
      const output = isError ? 'Subagent turn aborted' : 'Subagent completed'
      events.push({
        type: 'tool_end',
        payload: { id, tool: 'Task', output: '', isError, summary: output },
      })
    }
    return events
  }

  closeTurn(): LiveEvent[] {
    return this.finishTurn(false)
  }

  finishReplay(): LiveEvent[] {
    return this.closePending(false, true)
  }

  private todoEvents(id: string, value: unknown): LiveEvent[] {
    if (!applyTodoInput(this.todoById, this.todoOrder, value)) return []
    const snapshot = todoSnapshot(this.todoById, this.todoOrder)
    return [
      { type: 'tool_start', payload: { id, tool: 'TodoWrite', input: { todos: snapshot } } },
      {
        type: 'tool_end',
        payload: { id, tool: 'TodoWrite', output: 'Updated tasks', isError: false, summary: 'Updated tasks' },
      },
    ]
  }

  private taskEvents(fallbackId: string, input: unknown): LiveEvent[] {
    const key = taskKey(input)
    const hook = this.hookQueue.find((entry) => !entry.matched && entry.key === key)
    if (hook) {
      hook.matched = true
      return []
    }

    if (this.mode === 'replay') {
      const task = taskInput(input)
      const prompt = string(task.prompt)
      const description = string(task.description)
      const linkIndex = this.replayLinks.findIndex((candidate) =>
        candidate.prompt === prompt
        && (!candidate.description || !description || candidate.description === description))
      if (linkIndex >= 0) {
        const link = this.replayLinks.splice(linkIndex, 1)[0]
        const id = cursorTaskId(this.sessionId, link.toolUseId)
        this.pending.set(id, { tool: 'Task', fromHook: false })
        return [
          { type: 'tool_start', payload: { id, tool: 'Task', input } },
          ...this.completeTask(id, link),
        ]
      }
    }

    this.pending.set(fallbackId, { tool: 'Task', fromHook: false })
    return [{ type: 'tool_start', payload: { id: fallbackId, tool: 'Task', input } }]
  }

  private finishTurn(isError: boolean): LiveEvent[] {
    const events = this.closePending(isError, false)
    if (!this.open) return events
    events.push({ type: 'done', payload: { result: isError ? 'error' : 'success' } })
    if (this.mode === 'live') events.push({ type: 'turn_ended', payload: {} })
    this.open = false
    return events
  }

  private closePending(isError: boolean, includeHookTasks: boolean): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const [id, pending] of [...this.pending]) {
      if (pending.fromHook && !includeHookTasks) continue
      this.pending.delete(id)
      const output = isError ? 'Turn failed' : ''
      events.push({
        type: 'tool_end',
        payload: {
          id,
          tool: pending.tool,
          output,
          isError,
          summary: isError ? 'Turn failed' : 'Completed',
        },
      })
    }
    return events
  }
}

export function cursorMessagesToEvents(
  rawLines: string[],
  sessionId: string,
  replayLinks: CursorReplayTaskLink[] = [],
  startIndex = 0,
  initialTodos: CursorTodo[] = [],
): SessionEvent[] {
  const normalizer = new CursorNormalizer('replay', sessionId, { replayLinks, startIndex, initialTodos })
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

export function lastCursorTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw) continue
    if (raw.role === 'user') {
      const first = contentBlocks(raw).find((block) => block.type === 'text')
      const text = cursorUserText(string(first?.text))
      if (text) { userMessage = text; assistantText = '' }
    } else if (raw.role === 'assistant') {
      for (const block of contentBlocks(raw)) {
        if (block.type === 'text') {
          const text = cursorAssistantText(string(block.text))
          if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
        }
      }
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

export function windowCursorLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): {
  window: string[]
  startIndex: number
  initialTodos: CursorTodo[]
  hasMore: boolean
  oldestCursor: string | null
  staleCursor?: boolean
} {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^cursor:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], startIndex: 0, initialTodos: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], startIndex: 0, initialTodos: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }
  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0) {
    const raw = parse(rawLines[start])
    if (raw?.role === 'user') break
    start--
  }
  return {
    window: rawLines.slice(start, endIndex),
    startIndex: start,
    initialTodos: cursorTodoState(rawLines.slice(0, start)),
    hasMore: start > 0,
    oldestCursor: `cursor:${start}`,
  }
}
