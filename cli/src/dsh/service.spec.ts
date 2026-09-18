import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDsh, type DshInstallOptions, type DshInstallResult } from './install.js'
import { updateDsh } from './update.js'
import { mutateDsh } from './service.js'
import { refreshDshRegistry } from './catalog.js'
import type { DshRegistryEntry } from './registry.js'

const catalog = vi.hoisted(() => ({ entries: [] as DshRegistryEntry[] }))
vi.mock('./catalog.js', () => ({
  refreshDshRegistry: vi.fn(async () => catalog.entries),
  catalogEntry: (id: string) => catalog.entries.find(entry => entry.id === id),
}))
vi.mock('./install.js', async original => ({ ...await original<typeof import('./install.js')>(), installDsh: vi.fn() }))
vi.mock('./update.js', () => ({ updateDsh: vi.fn() }))

const success: DshInstallResult = { ok: true, installed: {
  id: 'acme/thing', dir: '/fixture', realDir: '/fixture', source: 'https://example.com/thing',
  ref: null, commit: null, linked: false, installedAt: 0,
  manifest: { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude' },
}, doctor: { ok: true, lines: [] }, setupLines: [] }

describe('daemon package mutations', () => {
  beforeEach(() => {
    catalog.entries = [{ id: 'acme/thing', name: 'Thing', engine: 'claude', repo: 'https://example.com/thing', ref: 'a'.repeat(40), path: 'packages/thing' }]
    vi.mocked(installDsh).mockReset().mockResolvedValue(success)
    vi.mocked(updateDsh).mockReset().mockResolvedValue(success)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('pins catalog installs, allows a URL install, and updates an unlisted installed source', async () => {
    expect(await mutateDsh({ id: 'acme/thing' }, () => {})).toEqual({ ok: true, id: 'acme/thing' })
    const options = vi.mocked(installDsh).mock.calls[0]![0]
    expect(options).toMatchObject({ source: catalog.entries[0]!.repo, ref: 'a'.repeat(40), path: 'packages/thing', expectedId: 'acme/thing' })
    expect(options.registry!('acme/thing')).toEqual(catalog.entries[0])
    expect(await mutateDsh({ url: 'https://example.com/private', ref: 'v2' }, () => {})).toMatchObject({ ok: true })
    expect(vi.mocked(installDsh).mock.calls.at(-1)![0]).toMatchObject({ source: 'https://example.com/private', ref: 'v2', path: undefined })
    vi.mocked(updateDsh).mockImplementation(async options => {
      options.onProgress!({ id: 'acme/unlisted', phase: 'doctor' })
      options.onLine!('ok updated')
      return success
    })
    expect(await mutateDsh({ id: 'acme/unlisted', update: true }, () => {})).toMatchObject({ ok: true })
    expect(updateDsh).toHaveBeenCalledWith(expect.objectContaining({ id: 'acme/unlisted' }))
    expect(refreshDshRegistry).toHaveBeenLastCalledWith(true)
  })

  it('rejects an unknown catalog id and an empty request before running code', async () => {
    expect(await mutateDsh({ id: 'acme/missing' }, () => {})).toMatchObject({ ok: false, error: 'INVALID_DSH' })
    expect(await mutateDsh({}, () => {})).toMatchObject({ ok: false, error: 'INVALID_DSH' })
    expect(installDsh).not.toHaveBeenCalled()
  })

  it('throttles output, immediately sends doctor lines, and discards lines after terminal phases', async () => {
    vi.useFakeTimers()
    const progress = vi.fn()
    vi.mocked(installDsh).mockImplementation(async (options: DshInstallOptions) => {
      const line = options.onLine!
      const phase = options.onProgress!
      line('before phase'); vi.advanceTimersByTime(300)
      phase({ id: null, phase: 'clone' })
      line('   \r')
      line('Receiving 10%\rReceiving 20%')
      vi.advanceTimersByTime(300)
      line('queued output')
      line('newer queued output')
      phase({ id: 'acme/thing', phase: 'doctor' })
      line('checking')
      line('ok ready')
      line('miss fonts')
      phase({ id: 'acme/thing', phase: 'done' })
      line('late output'); vi.advanceTimersByTime(300)
      phase({ id: 'acme/thing', phase: 'failed' })
      line('late failure output'); vi.advanceTimersByTime(300)
      line('pending at return')
      return success
    })
    await mutateDsh({ id: 'acme/thing' }, progress)
    expect(progress.mock.calls.flat().filter(p => p.line).map(p => p.line)).toEqual(['Receiving 20%', 'ok ready', 'miss fonts'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns errors and clears pending narration when an operation throws', async () => {
    const failure = { ok: false, error: 'DOCTOR_FAILED', detail: 'miss runtime' } as const
    vi.mocked(installDsh).mockResolvedValue(failure)
    vi.mocked(updateDsh).mockResolvedValue(failure)
    for (const input of [{ url: 'https://example.com/package' }, { id: 'acme/thing' }, { id: 'acme/thing', update: true }]) {
      expect(await mutateDsh(input, () => {})).toEqual(failure)
    }
    vi.useFakeTimers()
    vi.mocked(installDsh).mockImplementation(async options => {
      options.onProgress!({ id: null, phase: 'clone' })
      options.onLine!('working')
      throw new Error('connection lost')
    })
    await expect(mutateDsh({ id: 'acme/thing' }, () => {})).rejects.toThrow('connection lost')
    expect(vi.getTimerCount()).toBe(0)
  })
})
