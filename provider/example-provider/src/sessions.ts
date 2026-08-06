/**
 * The identity bridge, persisted to `sessions.json`.
 *
 * The client mints `contextId` (HP-101); Claude assigns its own session id on the first turn. One
 * map bridges them so `--resume` works across turns and across restarts of this process.
 *
 * Task records exist because A2A's `taskId` is one TURN while Claude's transcript is a whole
 * SESSION. The timestamp window is what lets `GetTask` slice one turn back out of the JSONL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TaskStateValue } from './types.js'

export interface TaskRecord {
  taskId: string
  contextId: string
  agentId: string
  state: TaskStateValue
  startedAt: number
  endedAt?: number
  /** First user text of the turn — the session title projection (spec §10.4). */
  title: string
  /**
   * Headline of what this turn ACCOMPLISHED (HP-302). Absent until the turn has been summarised, and
   * absent forever on a turn that failed — deliberately NOT the same thing as `title`, which is what
   * the user asked.
   */
  recap?: string
  /** The fuller summary behind the headline; `recapEntry.body` on the wire. */
  body?: string
}

export interface ContextRecord {
  contextId: string
  agentId: string
  /** Absent until Claude reports one on the first turn. */
  claudeSessionId?: string
}

interface StateFile {
  contexts: Record<string, ContextRecord>
  tasks: Record<string, TaskRecord>
}

export class SessionStore {
  private state: StateFile = { contexts: {}, tasks: {} }
  private seq = 0

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>
      this.state = { contexts: parsed.contexts ?? {}, tasks: parsed.tasks ?? {} }
      // Continue the id sequence past anything already on disk, so a restart cannot reuse an id.
      for (const id of Object.keys(this.state.tasks)) {
        const n = Number(id.replace(/^task-/, ''))
        if (Number.isFinite(n)) this.seq = Math.max(this.seq, n)
      }
    } catch {
      // A corrupt state file must not stop the provider from serving new turns; history for the
      // affected contexts is lost, which is visible, whereas refusing to boot is not.
      this.state = { contexts: {}, tasks: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // Write-then-rename: a crash mid-write must not leave a truncated state file behind.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }

  nextTaskId(): string {
    return `task-${++this.seq}`
  }

  context(contextId: string): ContextRecord | undefined {
    return this.state.contexts[contextId]
  }

  ensureContext(contextId: string, agentId: string): ContextRecord {
    const existing = this.state.contexts[contextId]
    if (existing) return existing
    const created: ContextRecord = { contextId, agentId }
    this.state.contexts[contextId] = created
    this.save()
    return created
  }

  setClaudeSession(contextId: string, claudeSessionId: string): void {
    const ctx = this.state.contexts[contextId]
    if (!ctx || ctx.claudeSessionId === claudeSessionId) return
    ctx.claudeSessionId = claudeSessionId
    this.save()
  }

  createTask(task: TaskRecord): void {
    this.state.tasks[task.taskId] = task
    this.save()
  }

  finishTask(taskId: string, state: TaskStateValue): void {
    const task = this.state.tasks[taskId]
    if (!task) return
    task.state = state
    task.endedAt = Date.now()
    this.save()
  }

  task(taskId: string): TaskRecord | undefined {
    return this.state.tasks[taskId]
  }

  /** Newest first. Filtered by context when given one. */
  tasks(contextId?: string): TaskRecord[] {
    return Object.values(this.state.tasks)
      .filter((t) => !contextId || t.contextId === contextId)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Contexts belonging to one agent, used to answer ListTasks scoped to an agent. */
  contextsForAgent(agentId: string): ContextRecord[] {
    return Object.values(this.state.contexts).filter((c) => c.agentId === agentId)
  }

  /** Attach a summary to a finished turn. Persisted, because HP-302 says "persisted". */
  setRecap(taskId: string, recap: string, body: string): void {
    const task = this.state.tasks[taskId]
    if (!task || !recap) return
    task.recap = recap
    task.body = body
    this.save()
  }

  /**
   * The most recent SUMMARISED turns for one agent, newest first.
   *
   * Per TURN, not per session: HP-302 is "short persisted per-turn summaries", and a session can
   * hold dozens of turns. Turns still running, and turns that failed, carry no recap and are simply
   * not here — an empty array before anything has been summarised is the correct answer.
   */
  recentRecaps(agentId: string, n: number): TaskRecord[] {
    return Object.values(this.state.tasks)
      .filter((t) => t.agentId === agentId && !!t.recap)
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .slice(0, n)
  }
}
