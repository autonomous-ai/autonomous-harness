import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { CATALOG_REFRESH_MS, LiveStoreCatalog, parseStoreCatalog, refreshDshRegistry, resetLiveDshRegistry } from './catalog.js'
import { env } from '../config/env.js'
import { dshCommand } from './command.js'
import { resolveInstallSource } from './install.js'
import { installedDsh, invalidateInstalledDsh } from './installed.js'
import type { DshRegistryEntry } from './registry.js'

const first: DshRegistryEntry = { id: 'acme/new-game', name: 'New Game', engine: 'claude', repo: 'https://example.test/game', viewerUse: 'acme/new-viewer' }
const viewer: DshRegistryEntry = { id: 'acme/new-viewer', kind: 'viewer', name: 'New Viewer', repo: 'https://example.test/viewer' }
const fallback: DshRegistryEntry[] = [{ id: 'acme/bundled', name: 'Bundled', engine: 'codex', repo: 'https://example.test/bundled' }]
const document = (entries = [first, viewer]) => ({ spec: 1, entries })
const response = (entries = [first, viewer]) => new Response(JSON.stringify(document(entries)), { headers: { etag: '"v1"' } })

describe('live Store catalog', () => {
  let root: string
  let now: number
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-catalog-')); now = 1000; fetcher = vi.fn<typeof fetch>() })
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
  const make = () => new LiveStoreCatalog({ url: 'https://catalog.example.test/catalog.json', cacheFile: join(root, 'catalog.json'), fallback: () => fallback, fetch: fetcher, now: () => now })

  it('discovers new entries without rebuilding; removals do not reappear from the bundle', async () => {
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([viewer]))
    const catalog = make()
    expect(catalog.current()).toEqual(fallback)
    expect((await catalog.refresh()).map(e => e.id)).toEqual([first.id, viewer.id])
    now += CATALOG_REFRESH_MS
    expect((await catalog.refresh()).map(e => e.id)).toEqual([viewer.id])
  })

  it('coalesces concurrent readers and uses the ETag after the refresh interval', async () => {
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(null, { status: 304 }))
    const catalog = make()
    await Promise.all(Array.from({ length: 25 }, () => catalog.refresh()))
    await catalog.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += CATALOG_REFRESH_MS
    await catalog.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ 'if-none-match': '"v1"' })
    expect(catalog.current()).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).checkedAt).toBe(now)
  })

  it('restores a valid disk cache without a fetch and keeps it during an outage', async () => {
    fetcher.mockResolvedValueOnce(response())
    await make().refresh()
    const restarted = make()
    expect((await restarted.refresh()).map(e => e.id)).toContain(first.id)
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += CATALOG_REFRESH_MS
    fetcher.mockRejectedValue(new Error('offline'))
    expect((await restarted.refresh()).map(e => e.id)).toContain(first.id)
    await restarted.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['invalid JSON', () => new Response('{broken')],
    ['future envelope', () => new Response(JSON.stringify({ spec: 2, entries: [first] }))],
    ['damaged entry', () => new Response(JSON.stringify(document([{ ...first, repo: '' }])))],
    ['duplicate identity', () => response([first, first])],
    ['HTTP failure', () => new Response('', { status: 503 })],
    ['oversized body', () => new Response('ignored', { headers: { 'content-length': String(17 * 1024 * 1024) } })],
  ])('keeps the last good catalog after %s', async (_name, bad) => {
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(bad())
    const catalog = make()
    await catalog.refresh()
    const before = readFileSync(join(root, 'catalog.json'), 'utf8')
    now += CATALOG_REFRESH_MS
    expect((await catalog.refresh()).map(e => e.id)).toContain(first.id)
    expect(readFileSync(join(root, 'catalog.json'), 'utf8')).toBe(before)
  })

  it('keeps the catalog on disk as published, so a newer CLI reads the fields this one drops', async () => {
    const published = { ...first, tagline: 'Arcade games', futureField: 'kept for the next CLI' }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(document([published as DshRegistryEntry, viewer])), { headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const catalog = make()
    await catalog.refresh()
    expect(catalog.current().find(e => e.id === first.id)).not.toHaveProperty('futureField')
    const file = join(root, 'catalog.json')
    const onDisk = () => JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk()).toMatchObject({ whole: true, etag: '"v1"', catalog: { spec: 1, entries: [published, viewer] } })
    // Restarted, it trusts that copy: the ETag is sent, a 304 keeps it, and it is still whole on disk.
    const restarted = make()
    expect(restarted.current().find(e => e.id === first.id)?.tagline).toBe('Arcade games')
    now += CATALOG_REFRESH_MS
    await restarted.refresh()
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ 'if-none-match': '"v1"' })
    expect(onDisk()).toMatchObject({ whole: true, checkedAt: now, catalog: { entries: [published, viewer] } })
  })

  it('a catalog served without an ETag is saved without one and downloaded in full each time', async () => {
    fetcher.mockImplementation(async () => new Response(JSON.stringify(document())))
    await make().refresh()
    const saved = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
    expect(saved).toMatchObject({ whole: true, catalog: document() })
    expect(saved).not.toHaveProperty('etag')
    const restarted = make()
    now += CATALOG_REFRESH_MS
    await restarted.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty('if-none-match')
  })

  it('downloads the whole catalog again, not revalidating, over a cache an older CLI cut down', async () => {
    // What a CLI before `whole` wrote: its own parse of the catalog, fields it did not know already gone.
    const file = join(root, 'catalog.json')
    const cutDown = { url: 'https://catalog.example.test/catalog.json', checkedAt: now, etag: '"v1"', catalog: document() }
    writeFileSync(file, JSON.stringify(cutDown))
    const catalog = make()
    expect(catalog.current().map(e => e.id)).toEqual([first.id, viewer.id])
    expect(catalog.current()[0].tagline).toBeUndefined()

    // A 304 it did not ask for changes nothing, and the next refresh tries again.
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }))
    await catalog.refresh()
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('if-none-match')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(cutDown)

    now += 30_000
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(document([{ ...first, tagline: 'Arcade games' }, viewer])), { headers: { etag: '"v1"' } }))
    expect((await catalog.refresh()).find(e => e.id === first.id)?.tagline).toBe('Arcade games')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty('if-none-match')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ whole: true, etag: '"v1"' })
  })

  it('falls back on first offline launch or a corrupt cache', async () => {
    writeFileSync(join(root, 'catalog.json'), '{bad')
    fetcher.mockRejectedValue(new Error('offline'))
    expect(await make().refresh()).toEqual(fallback)
  })

  it('never loads a cache belonging to a different source', async () => {
    fetcher.mockResolvedValueOnce(response())
    await make().refresh()
    const file = join(root, 'catalog.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...saved, url: 'https://different.test/catalog.json' }))
    expect(make().current()).toEqual(fallback)
  })

  it('bounds a network stall and returns the bundled catalog', async () => {
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')))))
    const catalog = new LiveStoreCatalog({ url: 'https://catalog.test', cacheFile: join(root, 'cache'), fallback: () => fallback, fetch: fetcher, timeoutMs: 15 })
    expect(await catalog.refresh()).toEqual(fallback)
  })

  it('accepts future optional fields and skips unsupported engines without losing supported ones', () => {
    const parsed = parseStoreCatalog(document([{ ...first, futureField: true }, { ...first, id: 'acme/future', engine: 'future-engine' }, viewer] as DshRegistryEntry[]))
    expect(parsed.entries.map(e => e.id)).toEqual([first.id, viewer.id])
  })

  it('does not trust a community package claiming to be first-party', () => {
    expect(parseStoreCatalog(document([{ ...first, verified: true }])).entries[0].verified).toBe(false)
    expect(() => parseStoreCatalog(document([{ ...first, repo: '/private/project' }]))).toThrow()
    expect(() => parseStoreCatalog(document([{ ...first, repo: 'https://secret:token@example.test/repo' }]))).toThrow()
  })

  it('handles thousands of packages in one response', async () => {
    const entries = Array.from({ length: 5000 }, (_, i) => ({ ...first, id: `acme/game-${i}` }))
    fetcher.mockResolvedValueOnce(response(entries))
    expect(await make().refresh()).toHaveLength(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('catalog → CLI list → install → shared viewer', () => {
  let root: string
  const saved = { dsh: env.DSH_DIR, url: env.HARNESS_STORE_CATALOG_URL }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-live-install-'))
    env.DSH_DIR = join(root, 'installed'); env.HARNESS_STORE_CATALOG_URL = 'https://catalog.example.test/live.json'
    invalidateInstalledDsh(); resetLiveDshRegistry()
  })
  afterEach(() => {
    env.DSH_DIR = saved.dsh; env.HARNESS_STORE_CATALOG_URL = saved.url
    resetLiveDshRegistry(); invalidateInstalledDsh(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('installs a newly published harness and viewer from one pinned commit, without a new CLI', async () => {
    const repo = join(root, 'source'); mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim()
    for (const [folder, manifest] of [
      ['game', { spec: 1, id: first.id, name: first.name, engine: 'claude', viewer: { use: viewer.id } }],
      ['viewer', { spec: 1, id: viewer.id, name: viewer.name, kind: 'viewer', viewer: { command: 'node viewer.mjs', url: 'http://127.0.0.1:${port}/' } }],
    ] as const) { mkdirSync(join(repo, folder)); writeFileSync(join(repo, folder, 'harness.json'), JSON.stringify(manifest)) }
    writeFileSync(join(repo, 'viewer', 'viewer.mjs'), '// fixture viewer\n')
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'published packages')
    const ref = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'game', 'unpublished.txt'), 'This later commit is not in the catalog')
    git('add', '.'); git('commit', '-qm', 'unpublished change')
    // All Git traffic stays in the fixture repository. No global Git configuration is changed.
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${repo}.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://example.test/packages')
    const entries = [{ ...first, repo: 'https://example.test/packages', path: 'game', ref }, { ...viewer, repo: 'https://example.test/packages', path: 'viewer', ref }]
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(entries)))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await dshCommand('list', [])).toBe(0)
    expect(output.mock.calls.flat().join('\n')).toContain('acme/new-game')
    expect(installedDsh(first.id)).toBeUndefined()
    expect(installedDsh(viewer.id)).toBeUndefined()
    expect(resolveInstallSource(first.id)).toMatchObject({ source: entries[0].repo, path: 'game', ref })
    expect(await dshCommand('install', [first.id])).toBe(0)
    expect(installedDsh(first.id)?.commit).toBe(ref)
    expect(installedDsh(viewer.id)?.commit).toBe(ref)
    const installedAt = installedDsh(viewer.id)?.installedAt
    expect(await dshCommand('install', [first.id])).toBe(0)
    expect(installedDsh(viewer.id)?.installedAt).toBe(installedAt)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await refreshDshRegistry()).map(e => e.id)).toContain(first.id)
  })
})
