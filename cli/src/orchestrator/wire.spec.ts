import { describe, expect, it, vi } from 'vitest'
import { orchestratorRequest } from './wire.js'
import { OrchestratorError } from './model.js'
import type { OrchestratorService } from './service.js'

const id = 'a'.repeat(32), messageId = 'b'.repeat(32)
const makeService = () => Object.fromEntries(['list', 'catalog', 'start', 'snapshot', 'plan', 'finish', 'retry', 'cancel', 'resume', 'complete', 'chat', 'steer'].map(key => [key, vi.fn(() => ({ id }))]))
describe('orchestrator RPC boundary', () => {
  it.each(['list', 'catalog', 'start'])('returns %s data under the stable wire key', async action => {
    const service = makeService()
    expect(await orchestratorRequest(service as unknown as OrchestratorService, { action, id })).toEqual({ [action === 'list' ? 'projects' : action === 'catalog' ? 'harnesses' : 'project']: { id } })
    expect(service[action]).toHaveBeenCalledTimes(1)
    expect(service.snapshot).not.toHaveBeenCalled()
  })
  it.each([
    ['status', 'snapshot', [id]],
    ['plan', 'plan', [id, []]],
    ['finish', 'finish', [id, 'task', 1, 'verified', ['file.step'], false]],
    ['fail', 'finish', [id, 'task', 1, 'verified', [], true]],
    ['retry', 'retry', [id, 'task']], ['cancel', 'cancel', [id, 'task']],
    ['resume', 'resume', [id]], ['complete', 'complete', [id, 'verified']],
    ['message', 'chat', [id, messageId, 'hello']],
    ['steer', 'steer', [id, 'task', 1, messageId, 'hello']],
  ])('validates and dispatches %s', async (action, method, args) => {
    const service = makeService()
    const reply = await orchestratorRequest(service as unknown as OrchestratorService, { action, id, tasks: [], taskId: 'task', attempt: 1, summary: 'verified', ...(action === 'finish' ? { artifacts: ['file.step'] } : {}), messageId, text: 'hello' })
    expect(reply).toEqual({ project: { id } })
    expect(service[method as string]).toHaveBeenCalledWith(...args as unknown[])
  })
  it('supports whole-project cancellation and reports validation errors without dispatch', async () => {
    const service = makeService(), wire = (payload: Record<string, unknown>) => orchestratorRequest(service as unknown as OrchestratorService, payload)
    await wire({ action: 'cancel', id }); expect(service.cancel).toHaveBeenCalledWith(id, undefined)
    for (const payload of [{ action: 'start' }, { action: 'finish', attempt: 0 }, { action: 'steer', attempt: 1, messageId: 'bad' }]) {
      if (payload.action === 'start') continue // the service validates the creation spec
      expect(await wire({ id, taskId: 'task', summary: 'verified', ...payload })).toMatchObject({ error: 'INVALID_REQUEST' })
    }
    expect(service.finish).not.toHaveBeenCalled(); expect(service.steer).not.toHaveBeenCalled()
  })
  it.each([
    [new OrchestratorError('KNOWN_ERROR', 'Actionable detail'), 'KNOWN_ERROR', 'Actionable detail'],
    [new Error('Disk full'), 'ORCHESTRATOR_FAILED', 'Disk full'],
    ['untyped failure', 'ORCHESTRATOR_FAILED', 'Orchestration request failed.'],
  ])('normalizes failures without losing known codes', async (failure, code, detail) => {
    const service = makeService(); service.list.mockImplementation(() => { throw failure })
    expect(await orchestratorRequest(service as unknown as OrchestratorService, { action: 'list' })).toEqual({ error: code, detail })
  })
})
