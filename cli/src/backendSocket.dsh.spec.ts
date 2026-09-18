// dsh_list, dsh_install and dsh_remove through the socket a local client (the desktop app) talks to:
// the replies it gets, the status it is pushed, and what it gets when this daemon cannot do it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendSocket } from './backendSocket.js'
import { env } from './config/env.js'
import { dshInstallDir, invalidateInstalledDsh, upsertInstalledRecord } from './dsh/installed.js'
import { resetBundledDshRegistry } from './dsh/registry.js'

describe('the DSH requests on the local socket', () => {
  let socket: BackendSocket
  let frames: Array<{ type: string; payload: Record<string, unknown> }>
  let root: string
  let savedDshDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-socket-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'dsh')
    invalidateInstalledDsh()
    socket = new BackendSocket('token')
    frames = []
    socket.registerLocalClient('local:store', { sendFrame: (frame) => { frames.push(frame as (typeof frames)[number]); return true }, sendBinary: () => true })
  })
  afterEach(async () => {
    await socket.unregisterLocalClient('local:store')
    await socket.stop()
    vi.unstubAllGlobals()
    resetBundledDshRegistry()
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  const ask = (type: string, payload: Record<string, unknown>): void => socket.handleLocalFrame('local:store', { type, payload })
  const replies = (type: string): Array<Record<string, unknown>> => frames.filter((frame) => frame.type === `${type}_result`).map((frame) => frame.payload)

  it('dsh_list: what is installed here, then what the registry offers', async () => {
    vi.stubGlobal('__DSH_REGISTRY__', JSON.stringify([
      { id: 'acme/thing', name: 'Thing', repo: 'https://example.com/thing.git', engine: 'claude', verified: true },
      { id: 'acme/other', name: 'Other', repo: 'https://example.com/other.git', engine: 'codex', tier: 1 },
    ]))
    resetBundledDshRegistry()
    mkdirSync(dshInstallDir('acme/thing'), { recursive: true })
    writeFileSync(join(dshInstallDir('acme/thing'), 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing here', engine: 'claude' }))
    upsertInstalledRecord({ id: 'acme/thing', dir: dshInstallDir('acme/thing'), source: 'https://example.com/thing.git', ref: null, commit: null, linked: false, installedAt: 1 })
    ask('dsh_list', { requestId: 'list-1' })
    await vi.waitFor(() => expect(replies('dsh_list')).toHaveLength(1))
    const [reply] = replies('dsh_list')
    expect(reply.requestId).toBe('list-1')
    expect((reply.dsh as Array<Record<string, unknown>>).map((row) => [row.id, row.name, row.installed, row.verified, row.tier]))
      .toEqual([['acme/thing', 'Thing here', true, true, 0], ['acme/other', 'Other', false, false, 1]])
  })

  it('dsh_remove and dsh_install are refused on a daemon that cannot do them', async () => {
    ask('dsh_remove', { requestId: 'rm-1', id: 'acme/thing' })
    ask('dsh_install', { requestId: 'in-1', id: 'acme/thing' })
    ask('dsh_update', { requestId: 'up-1', id: 'acme/thing' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    expect(replies('dsh_remove')).toEqual([expect.objectContaining({ requestId: 'rm-1', error: 'UNSUPPORTED_ON_REMOTE' })])
    expect(replies('dsh_install')).toEqual([expect.objectContaining({ requestId: 'in-1', error: 'UNSUPPORTED_ON_REMOTE' })])
    expect(replies('dsh_update')).toEqual([expect.objectContaining({ requestId: 'up-1', error: 'UNSUPPORTED_ON_REMOTE' })])
  })

  it('dsh_update validates identity, streams progress, and returns update failures', async () => {
    const update = vi.fn<NonNullable<BackendSocket['onDshUpdate']>>(async (id, progress) => {
      progress({ id: null, phase: 'clone' })
      progress({ id, phase: 'done' })
      return { ok: true, id }
    })
    socket.onDshUpdate = update
    ask('dsh_update', { requestId: 'invalid', id: '../../etc' })
    ask('dsh_update', { requestId: 'update', id: 'acme/thing', url: 'ignored', ref: 'ignored' })
    await vi.waitFor(() => expect(replies('dsh_update')).toHaveLength(2))
    expect(update).toHaveBeenCalledTimes(1)
    expect(replies('dsh_update')).toEqual([
      expect.objectContaining({ requestId: 'invalid', error: 'INVALID_DSH' }),
      expect.objectContaining({ requestId: 'update', ok: true, id: 'acme/thing' }),
    ])
    expect(frames.filter(frame => frame.type === 'dsh_install_status').map(frame => frame.payload))
      .toEqual([{ id: 'acme/thing', phase: 'clone' }, { id: 'acme/thing', phase: 'done' }])
    update.mockResolvedValueOnce({ ok: false, error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    ask('dsh_update', { requestId: 'linked', id: 'acme/thing' })
    await vi.waitFor(() => expect(replies('dsh_update')).toHaveLength(3))
    expect(replies('dsh_update')[2]).toMatchObject({ error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    for (const error of [new Error('disk full'), 'closed']) {
      update.mockRejectedValueOnce(error)
      ask('dsh_update', { requestId: 'throws', id: 'acme/thing' })
      await vi.waitFor(() => expect(replies('dsh_update').at(-1)).toMatchObject({ error: 'INTERNAL', detail: String(error instanceof Error ? error.message : error) }))
    }
  })

  it('dsh_install: refuses a request with no usable id or url, before the daemon hears of it', async () => {
    const asked: unknown[] = []
    socket.onDshInstall = async (input) => { asked.push(input); return { ok: true, id: 'acme/thing' } }
    ask('dsh_install', { requestId: 'in-1', id: '../../etc', url: 'https://example.com/\n' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    expect(replies('dsh_install')[0]).toMatchObject({ requestId: 'in-1', error: 'INVALID_DSH', detail: 'dsh_install needs an id or a url' })
    expect(asked).toEqual([])
  })

  it('dsh_install: pushes each phase under the id asked for, then replies with what was installed', async () => {
    const asked: unknown[] = []
    socket.onDshInstall = async (input, progress) => {
      asked.push(input)
      progress({ id: null, phase: 'clone', detail: 'cloning' })
      progress({ id: 'acme/thing', phase: 'doctor' })
      return { ok: true, id: 'acme/thing' }
    }
    ask('dsh_install', { requestId: 'in-2', id: 'acme/thing', ref: 'store-e2e' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    expect(asked).toEqual([{ id: 'acme/thing', url: undefined, ref: 'store-e2e' }])
    expect(frames.filter((frame) => frame.type === 'dsh_install_status').map((frame) => frame.payload)).toEqual([
      { id: 'acme/thing', phase: 'clone', detail: 'cloning' },
      { id: 'acme/thing', phase: 'doctor' },
    ])
    expect(replies('dsh_install')[0]).toMatchObject({ requestId: 'in-2', ok: true, id: 'acme/thing' })
  })

  it('dsh_install: a failed install is its error and detail; one that throws is INTERNAL with what was thrown', async () => {
    socket.onDshInstall = async () => ({ ok: false, error: 'SETUP_FAILED', detail: 'setup exited 1' })
    ask('dsh_install', { requestId: 'in-3', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    socket.onDshInstall = async () => { throw new Error('disk full') }
    ask('dsh_install', { requestId: 'in-4', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(2))
    socket.onDshInstall = () => Promise.reject('not an Error')
    ask('dsh_install', { requestId: 'in-5', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(3))
    expect(replies('dsh_install')).toEqual([
      expect.objectContaining({ requestId: 'in-3', error: 'SETUP_FAILED', detail: 'setup exited 1' }),
      expect.objectContaining({ requestId: 'in-4', error: 'INTERNAL', detail: 'disk full' }),
      expect.objectContaining({ requestId: 'in-5', error: 'INTERNAL', detail: 'not an Error' }),
    ])
  })
})
