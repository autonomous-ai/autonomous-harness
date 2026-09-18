import { z } from 'zod'
import { ENGINES } from '../engines/types.js'

export const RunId = z.string().regex(/^[a-f0-9]{32}$/)
export const TaskId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const text = z.string().trim().min(1).max(24_000)
export const TaskSpec = z.object({
  id: TaskId,
  title: z.string().trim().min(1).max(100),
  harness: z.string().max(129),
  prompt: text,
  dependsOn: z.array(TaskId).max(32).default([]),
})
export const StartSpec = z.object({
  id: RunId,
  prompt: text,
  engine: z.enum(ENGINES),
  cwd: z.string().max(4096).optional(),
  bypassPermission: z.boolean().default(false),
  parallelism: z.number().int().min(1).max(6).default(3),
})
export const Artifact = z.object({ path: z.string(), size: z.number(), sha256: z.string() })
export const Task = TaskSpec.extend({
  state: z.enum(['queued', 'launching', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']),
  attempt: z.number().int().min(1),
  agentId: z.string().nullable(),
  cwd: z.string(),
  summary: z.string().default(''),
  error: z.string().nullable(),
  uncertain: z.boolean().default(false),
  artifacts: z.array(Artifact),
  // Pin the attempt of every upstream result at dispatch, never "latest".
  inputs: z.record(z.string(), z.number()),
})
export const Message = z.object({
  id: z.string(), role: z.enum(['user', 'assistant', 'system']), text: z.string(),
  at: z.number(),
  targetAgentId: z.string().optional(),
  delivery: z.enum(['pending', 'accepted', 'queued', 'delivered', 'started', 'failed', 'unknown']).optional(),
  deliveryReason: z.string().optional(),
})
export const Run = z.object({
  version: z.literal(1), id: RunId, fingerprint: z.string(), prompt: text,
  engine: z.enum(ENGINES), bypassPermission: z.boolean(), parallelism: z.number(),
  root: z.string(), directorId: z.string().nullable(), directorWorking: z.boolean(),
  state: z.enum(['starting', 'active', 'paused', 'completed', 'cancelled', 'failed']),
  error: z.string().nullable(), tasks: z.array(Task).max(64), messages: z.array(Message).max(200),
  revision: z.number(), createdAt: z.number(), updatedAt: z.number(),
})
export type Run = z.infer<typeof Run>
export type Task = z.infer<typeof Task>
export type TaskSpec = z.infer<typeof TaskSpec>
export type Artifact = z.infer<typeof Artifact>
export type StartSpec = z.infer<typeof StartSpec>

export class OrchestratorError extends Error {
  constructor(readonly code: string, detail: string) { super(detail) }
}
export function requireThat(condition: unknown, code: string, detail: string): asserts condition {
  if (!condition) throw new OrchestratorError(code, detail)
}

/** Validate the entire graph before launching any part of it. */
export function validatePlan(existing: Task[], additions: TaskSpec[]): void {
  const all = new Map(existing.map(t => [t.id, t]))
  for (const task of additions) {
    const prior = all.get(task.id)
    if (prior) {
      requireThat(JSON.stringify(TaskSpec.parse(prior)) === JSON.stringify(task), 'TASK_CONFLICT', `Task ${task.id} already has different instructions.`)
    } else all.set(task.id, task as Task)
  }
  requireThat(all.size <= 64, 'TASK_LIMIT', 'A project can contain up to 64 tasks.')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    requireThat(all.has(id), 'MISSING_DEPENDENCY', `Unknown dependency: ${id}`)
    requireThat(!visiting.has(id), 'DEPENDENCY_CYCLE', `Dependency cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of all.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of all.keys()) visit(id)
}
