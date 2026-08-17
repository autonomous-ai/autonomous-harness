import { describe, expect, it, vi } from 'vitest'
import { HerdrBackend } from './herdrBackend.js'
import type { HerdrApiClient, HerdrEndpoint } from './herdrApiClient.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { HerdrRuntimeRef } from './terminalTypes.js'

const endpoint: HerdrEndpoint = {
  sessionName: 'default',
  endpointId: 'endpoint-a',
  socketPath: '/configured/herdr.sock',
  generation: { device: 1, inode: 2 },
}
const runtime: HerdrRuntimeRef = {
  backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
}

function backendWith(request: unknown, ping: unknown = vi.fn(async () => ({
  ok: true as const,
  result: { type: 'pong' as const, version: '0.8.0', protocol: 19 },
}))): HerdrBackend {
  return new HerdrBackend(endpoint, { request, ping, endpoint } as HerdrApiClient)
}

describe('HerdrBackend', () => {
  it('reads endpoint-scoped pane labels and terminal titles from the API snapshot', async () => {
    const backend = backendWith(vi.fn(async () => ({
      ok: true as const,
      result: {
        type: 'session_snapshot',
        snapshot: {
          version: '0.8.0', protocol: 19, panes: [
            { pane_id: 'w1:p1', terminal_id: 'terminal-a', label: 'manual label', terminal_title_stripped: 'shell title' },
            { pane_id: 'w1:p2', terminal_id: 'terminal-b', terminal_title_stripped: 'terminal title' },
          ],
        },
      },
    })))
    const result = await backend.titles()
    expect(result.state).toBe('succeeded')
    if (result.state !== 'succeeded') return
    expect([...result.value.values()]).toEqual(['manual label', 'terminal title'])
    expect([...result.value.keys()]).toEqual([
      terminalRouteKey(runtime),
      terminalRouteKey({ ...runtime, terminalId: 'terminal-b', paneId: 'w1:p2' }),
    ])
  })

  it('distinguishes a successful empty snapshot from unavailable transport', async () => {
    const empty = backendWith(vi.fn(async () => ({
      ok: true as const,
      result: { type: 'session_snapshot', snapshot: { version: '0.8.0', protocol: 19, panes: [] } },
    })))
    expect(await empty.inventory()).toEqual({ state: 'available', roots: [] })

    const unavailable = backendWith(vi.fn(), vi.fn(async () => ({
      ok: false as const, dispatch: 'not_started' as const, reason: 'Herdr API unavailable',
    })))
    expect(await unavailable.inventory()).toEqual({ state: 'unavailable', reason: 'Herdr API unavailable' })
  })

  it('builds endpoint-scoped roots from snapshot and pane process info', async () => {
    const request = vi.fn(async (method: string) => method === 'session.snapshot'
      ? { ok: true as const, result: { type: 'session_snapshot', snapshot: { version: '0.8.0', protocol: 19, panes: [{ pane_id: 'w1:p1', terminal_id: 'terminal-a', cwd: '/work' }] } } }
      : { ok: true as const, result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p1', shell_pid: 42 } } })
    expect(await backendWith(request).inventory()).toEqual({
      state: 'available',
      roots: [{ runtime, rootPid: 42, cwd: '/work' }],
    })
  })

  it('submits stripped multiline text once and preserves ambiguous dispatch evidence', async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      dispatch: 'possibly_executed' as const,
      reason: 'Herdr API response ended early',
    }))
    const result = await backendWith(request).submitText(runtime, 'one\ntwo\n\n')
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('pane.send_input', {
      pane_id: 'w1:p1', text: 'one\ntwo', keys: ['Enter'],
    }, { mutation: 'single_enqueue' })
    expect(result).toEqual({
      state: 'unknown', dispatch: 'possibly_executed', reason: 'Herdr API response ended early',
    })
  })

  it('uses explicit pane routes for capture and logical keys', async () => {
    const request = vi.fn(async (method: string) => method === 'pane.read'
      ? { ok: true as const, result: { type: 'pane_read', read: { text: '\u001b[31mred\u001b[0m' } } }
      : { ok: true as const, result: { type: 'ok' } })
    const backend = backendWith(request)
    await expect(backend.capture(runtime, { historyLines: 60 })).resolves.toEqual({ state: 'succeeded', value: '\u001b[31mred\u001b[0m' })
    await expect(backend.sendKey(runtime, 'ctrl-c')).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request).toHaveBeenLastCalledWith('pane.send_keys', { pane_id: 'w1:p1', keys: ['Ctrl+C'] }, { mutation: 'single_key' })
  })

  it('creates a workspace and closes the workspace resolved from its root pane', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.create') {
        return {
          ok: true as const,
          result: {
            type: 'workspace_created',
            root_pane: { pane_id: 'w2:p1', terminal_id: 'terminal-created', workspace_id: 'workspace-created' },
          },
        }
      }
      if (method === 'pane.get') {
        return {
          ok: true as const,
          result: {
            type: 'pane_info',
            pane: { pane_id: 'w2:p1', terminal_id: 'terminal-created', workspace_id: 'workspace-created' },
          },
        }
      }
      return { ok: true as const, result: { type: 'ok' } }
    })
    const backend = backendWith(request)

    const created = await backend.create({ cwd: '/tmp/work', label: 'Harness test' })
    expect(created).toEqual({
      state: 'succeeded',
      dispatch: 'executed',
      runtime: {
        backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default',
        terminalId: 'terminal-created', paneId: 'w2:p1',
      },
    })
    if (created.state !== 'succeeded') return
    await expect(backend.kill(created.runtime)).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request.mock.calls).toEqual([
      ['workspace.create', { cwd: '/tmp/work', focus: false, label: 'Harness test', env: {} }, { mutation: 'other' }],
      ['pane.get', { pane_id: 'w2:p1' }],
      ['workspace.close', { workspace_id: 'workspace-created' }, { mutation: 'other' }],
    ])
  })
})
