import { z } from 'zod'
import { OrchestratorError, RunId, TaskId } from './model.js'
import type { OrchestratorService } from './service.js'

export async function orchestratorRequest(service: OrchestratorService, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const action = z.enum(['list', 'catalog', 'start', 'status', 'plan', 'finish', 'fail', 'retry', 'cancel', 'resume', 'complete', 'message', 'steer']).parse(payload.action)
    if (action === 'list') return { projects: service.list() }
    if (action === 'catalog') return { harnesses: service.catalog() }
    if (action === 'start') return { project: await service.start(payload) }
    const id = RunId.parse(payload.id)
    switch (action) {
      case 'plan': service.plan(id, payload.tasks); break
      case 'finish':
      case 'fail':
        await service.finish(id, TaskId.parse(payload.taskId), z.number().int().min(1).parse(payload.attempt),
          z.string().parse(payload.summary), z.array(z.string()).parse(payload.artifacts ?? []), action === 'fail')
        break
      case 'retry': service.retry(id, TaskId.parse(payload.taskId)); break
      case 'cancel': service.cancel(id, payload.taskId === undefined ? undefined : TaskId.parse(payload.taskId)); break
      case 'resume': service.resume(id); break
      case 'complete': service.complete(id, z.string().parse(payload.summary)); break
      case 'message': service.chat(id, RunId.parse(payload.messageId), z.string().parse(payload.text)); break
      case 'steer': service.steer(id, TaskId.parse(payload.taskId), z.number().int().min(1).parse(payload.attempt), RunId.parse(payload.messageId), z.string().parse(payload.text)); break
    }
    return { project: service.snapshot(id) }
  } catch (error) {
    return {
      error: error instanceof OrchestratorError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'ORCHESTRATOR_FAILED',
      detail: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ')
        : error instanceof Error ? error.message : 'Orchestration request failed.',
    }
  }
}
