import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  online: false,
  provision: vi.fn(),
  publishUp: vi.fn(),
}))

vi.mock('./bus.js', () => ({
  getAgentPresence: vi.fn(async () => state.online ? 'manager-1' : null),
  publishUp: state.publishUp,
}))
vi.mock('./provision.js', () => ({
  provisionViaManager: state.provision,
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    $runCommandRaw: vi.fn(async () => ({ cursor: { firstBatch: [{ status: 'stopped', stopReason: 'manual_stop' }] } })),
  },
}))

import { ensureMachineReady, getMachineLifecycleState } from './machineLifecycle.js'

describe('machine wake gate', () => {
  beforeEach(() => {
    state.online = false
    state.provision.mockReset()
    state.publishUp.mockReset()
    state.provision.mockImplementation(async () => { state.online = true; return { status: 'running' } })
  })

  it('preserves the manager stop reason for lifecycle broadcasts', async () => {
    await expect(getMachineLifecycleState('machine-stopped')).resolves.toEqual({
      status: 'stopped',
      stopReason: 'manual_stop',
    })
  })

  it('coalesces concurrent cold-starts and caches readiness for 30 seconds', async () => {
    const binding = { machineId: `machine-${Date.now()}`, managerId: 'manager-1', authMode: 'managed' }
    await Promise.all([ensureMachineReady(binding), ensureMachineReady(binding), ensureMachineReady(binding)])
    expect(state.provision).toHaveBeenCalledTimes(1)
    await ensureMachineReady(binding)
    expect(state.provision).toHaveBeenCalledTimes(1)
    expect(state.publishUp).toHaveBeenCalledWith(binding.machineId, expect.objectContaining({
      frame: { type: 'node_status', payload: { online: true, status: 'running' } },
    }))
  })

  it('uses a separate readiness key for a public app port', async () => {
    const binding = { machineId: `machine-app-${Date.now()}`, managerId: 'manager-1', authMode: 'self' }
    state.online = true
    await ensureMachineReady(binding)
    await ensureMachineReady(binding, { subdomain: 'demo' })
    expect(state.provision).toHaveBeenCalledTimes(2)
    expect(state.provision).toHaveBeenLastCalledWith('manager-1', 'start', { machineId: binding.machineId, subdomain: 'demo' })
  })
})
