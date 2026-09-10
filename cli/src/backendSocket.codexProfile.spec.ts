import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'

let directory: string
let socket: BackendSocket
let frames: Array<Record<string, any>>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codex-profile-rpc-'))
  frames = []
  socket = new BackendSocket('unused-test-token')
  socket.registerLocalClient('local:profiles', {
    sendFrame: (frame) => { frames.push(frame); return true },
    sendBinary: () => true,
  })
})
afterEach(async () => {
  await socket.unregisterLocalClient('local:profiles')
  await socket.stop()
  rmSync(directory, { recursive: true, force: true })
})

describe('Codex profile launch contract', () => {
  it('advertises explicit support and hands the canonical path to the launcher', async () => {
    socket.engineProbeProvider = async () => [{ engine: 'codex', installed: true, command: 'codex', installable: false }]
    socket.handleLocalFrame('local:profiles', { type: 'engines_probe', payload: { requestId: 'probe', engines: ['codex'] } })
    await vi.waitFor(() => expect(frames.find((f) => f.type === 'engines_probe_result')?.payload.engines[0].supportsCodexHome).toBe(true))
    const create = vi.fn(async () => ({ ok: false as const, error: 'TEST_LAUNCH_STOPPED' }))
    socket.onCreateAgent = create
    socket.handleLocalFrame('local:profiles', {
      type: 'agent_create', payload: { requestId: 'create', engine: 'codex', cwd: directory, codexHome: directory },
    })
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ engine: 'codex', cwd: directory, codexHome: realpathSync(directory), bypassPermission: false, grid: null }))
  })

  it.each([
    { engine: 'claude' },
    { engine: 'codex', codexHome: 'codex2' },
    { engine: 'codex', codexHome: null },
    { engine: 'codex', codexHome: '/does-not-exist/profile' },
    { engine: 'codex', grid: { networkId: 'test-grid', networkName: 'Test grid', baseUrl: 'https://grid.example.test/relay', apiKey: 'test-relay-key' } },
  ])('rejects an invalid profile before launching: %j', async (override) => {
    const create = vi.fn(async () => ({ ok: false as const, error: 'SHOULD_NOT_LAUNCH' }))
    socket.onCreateAgent = create
    socket.handleLocalFrame('local:profiles', {
      type: 'agent_create', payload: { requestId: 'refused', cwd: directory, codexHome: directory, ...override },
    })
    await vi.waitFor(() => expect(frames.find((f) => f.type === 'agent_create_result')?.payload.error).toBe('INVALID_CODEX_PROFILE'))
    expect(create).not.toHaveBeenCalled()
  })
})
