import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TerminalCreateResult, TmuxRuntimeRef } from './terminalTypes.js'
import { createAndRegisterPane } from './createAgentPane.js'

let dataDir = ''

// Mirrors lib/registry.spec.ts's loadRegistryModule(): a fresh registry module per test, backed by
// its own temp state dir, so pre-seeded runtimeIndex collisions never leak between tests.
async function loadRegistryModule() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  return import('./registry.js')
}

const succeeded = (paneId: string): TerminalCreateResult<TmuxRuntimeRef> =>
  ({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId } })

/** `results[N]` is what `create()` answers on its (N+1)th call; the last entry repeats past that. */
function fakeTmux(results: Array<TerminalCreateResult<TmuxRuntimeRef>>) {
  let call = 0
  return {
    create: vi.fn(async () => results[Math.min(call++, results.length - 1)]!),
    kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })),
  }
}

describe('createAndRegisterPane', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  it('registers on the first attempt when the pane is unclaimed', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const tmuxBackend = fakeTmux([succeeded('%1')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'],
    })

    expect(result.ok).toBe(true)
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.create).toHaveBeenCalledWith(expect.objectContaining({ label: 'harness-claude-1' }))
    expect(tmuxBackend.kill).not.toHaveBeenCalled()
  })

  it('retries past a stale registration collision and succeeds on the next pane', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    // Simulates a stale entry from a previous tmux-server generation already holding %1.
    registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/other' })
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spawned.runtime.paneId).toBe('%2')
    expect(tmuxBackend.create).toHaveBeenCalledTimes(2)
    expect(tmuxBackend.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ label: 'harness-claude-1-r2' }))
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' })
  })

  it('gives up with REGISTRATION_FAILED after 3 attempts when every pane collides', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    for (const paneId of ['%1', '%2', '%3']) {
      registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId }], cwd: '/tmp/other' })
    }
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2'), succeeded('%3')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('REGISTRATION_FAILED')
      expect(result.detail).toContain('3 attempts')
    }
    expect(tmuxBackend.create).toHaveBeenCalledTimes(3)
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(3)
  })

  it('does not retry a tmux spawn failure', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const openPendingAgent = vi.spyOn(registry, 'openPendingAgent')
    const tmuxBackend = fakeTmux([{ state: 'failed', dispatch: 'not_started', reason: 'tmux is unavailable' }])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('TMUX_UNAVAILABLE')
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).not.toHaveBeenCalled()
    expect(openPendingAgent).not.toHaveBeenCalled()
  })
})
