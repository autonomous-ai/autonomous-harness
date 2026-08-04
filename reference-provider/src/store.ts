/**
 * In-memory task store.
 *
 * A real provider would persist this; the shape is what matters. Note that HISTORY LIVES HERE — the
 * Autonomous backend keeps no transcript for a provider harness, which is why `GetTask` and `ListTasks`
 * are Tier 0 rather than optional (HP-200, HP-201).
 */
import { isTerminal, TaskState, type Message, type Task, type TaskStateValue } from './types.js'

/** Deterministic ids: tests must not depend on a clock or a random source. */
let seq = 0
export const nextId = (prefix: string): string => `${prefix}-${++seq}`
export const resetIds = (): void => { seq = 0 }

export class TaskStore {
  private tasks = new Map<string, Task>()
  /** taskId → abort for an in-flight stream, so CancelTask can actually stop one (HP-103). */
  private inFlight = new Map<string, AbortController>()

  create(contextId: string, first: Message): Task {
    const task: Task = {
      id: nextId('task'),
      contextId,
      status: { state: TaskState.SUBMITTED },
      history: [first],
      metadata: { title: titleFrom(first) },
    }
    this.tasks.set(task.id, task)
    return task
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  /** Newest first. `contextId` filters to one session (HP-200). */
  list(contextId?: string): Task[] {
    const all = [...this.tasks.values()]
    const filtered = contextId ? all.filter((t) => t.contextId === contextId) : all
    return filtered.reverse()
  }

  append(taskId: string, message: Message): void {
    this.tasks.get(taskId)?.history.push(message)
  }

  setState(taskId: string, state: TaskStateValue, message?: Message): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.status = { state, ...(message ? { message } : {}) }
  }

  register(taskId: string, controller: AbortController): void {
    this.inFlight.set(taskId, controller)
  }

  release(taskId: string): void {
    this.inFlight.delete(taskId)
  }

  /**
   * Returns false when the task cannot be cancelled — already terminal, or unknown. The caller maps
   * that onto TASK_NOT_CANCELABLE / TASK_NOT_FOUND rather than pretending it worked.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || isTerminal(task.status.state)) return false
    this.inFlight.get(taskId)?.abort()
    this.inFlight.delete(taskId)
    task.status = { state: TaskState.CANCELED }
    return true
  }

  clear(): void {
    for (const c of this.inFlight.values()) c.abort()
    this.inFlight.clear()
    this.tasks.clear()
  }
}

/** Session title = the first user message, truncated (spec §10.4). */
function titleFrom(message: Message): string {
  const text = message.parts.map((p) => p.text ?? '').join(' ').trim()
  if (!text) return 'Untitled'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}
