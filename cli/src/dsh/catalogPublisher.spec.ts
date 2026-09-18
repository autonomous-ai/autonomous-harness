import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStoreCatalog } from './catalog.js'
// @ts-expect-error — dependency-free ESM also runs directly in GitHub Actions.
import { createStoreCatalog, publishStoreCatalog } from '../../../store/tools/catalog.mjs'

const ref = 'a'.repeat(40)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'catalog-publisher-')); roots.push(root)
  mkdirSync(join(root, 'agents', 'game'), { recursive: true })
  writeFileSync(join(root, 'agents', 'game', 'harness.json'), JSON.stringify({ spec: 1, id: 'autonomous/game', name: 'Game', engine: 'claude' }))
  writeFileSync(join(root, 'agents', 'game', 'store.json'), '{}')
  return root
}

describe('Store publication', () => {
  it('publishes package tree revisions, keeping the source commit separately', () => {
    const revisionFor = vi.fn(() => 'b'.repeat(40))
    const catalog = createStoreCatalog(fixture(), ref, { revisionFor })
    expect(revisionFor).toHaveBeenCalledWith('store/agents/game')
    expect(parseStoreCatalog(catalog).entries[0]).toMatchObject({ ref, revision: 'b'.repeat(40) })
    expect(() => createStoreCatalog(fixture(), ref, { revisionFor: () => 'not a revision' })).toThrow(/invalid package revision/)
  })
  it('generates a runtime-valid catalog from all real packages, pinning built-ins to the source commit', () => {
    const catalog = createStoreCatalog(fileURLToPath(new URL('../../../store', import.meta.url)), ref)
    const parsed = parseStoreCatalog(catalog)
    expect(parsed.entries).toHaveLength(catalog.entries.length)
    expect(parsed.entries.length).toBeGreaterThan(10)
    expect(parsed.entries.filter(entry => entry.verified).every(entry => entry.ref === ref)).toBe(true)
    const taglines = catalog.entries.filter((entry: { tagline?: string }) => entry.tagline !== undefined)
    expect(taglines.length).toBeGreaterThan(10)
    expect(parsed.entries.filter(entry => entry.tagline !== undefined).map(entry => [entry.id, entry.tagline]))
      .toEqual(taglines.map((entry: { id: string; tagline: string }) => [entry.id, entry.tagline]))
  })

  it('publishes a package\'s tagline as written, and refuses an empty, overlong, multi-line or non-text one', () => {
    const root = fixture()
    writeFileSync(join(root, 'agents', 'game', 'store.json'), JSON.stringify({ tagline: 'Open source HTML5 game framework' }))
    expect(createStoreCatalog(root, ref).entries[0].tagline).toBe('Open source HTML5 game framework')
    expect(parseStoreCatalog(createStoreCatalog(root, ref)).entries[0]!.tagline).toBe('Open source HTML5 game framework')
    writeFileSync(join(root, 'agents', 'game', 'store.json'), JSON.stringify({ tagline: 't'.repeat(80) }))
    expect(createStoreCatalog(root, ref).entries[0].tagline).toHaveLength(80)
    // An empty one too: the CLI refuses the whole catalog over one bad entry, so it must never be published.
    for (const bad of ['', '   ', 't'.repeat(81), 'Two\nlines', 'Tab\tseparated', 42]) {
      writeFileSync(join(root, 'agents', 'game', 'store.json'), JSON.stringify({ tagline: bad }))
      expect(() => createStoreCatalog(root, ref)).toThrow('autonomous/game: invalid tagline')
    }
  })

  it('rejects corrupt manifests instead of silently publishing a partial catalog', () => {
    const root = fixture()
    writeFileSync(join(root, 'agents', 'game', 'harness.json'), '{bad')
    expect(() => createStoreCatalog(root, ref)).toThrow()
  })

  it('publishes a package\'s examples as written, and refuses one without a prompt, with an http picture, an overlong caption or an unknown field', () => {
    const root = fixture()
    const examples = [{ prompt: 'A brick breaker.', image: 'https://example.com/game.jpg', caption: 'Brick breaker · playable' }]
    writeFileSync(join(root, 'agents', 'game', 'store.json'), JSON.stringify({ examples }))
    const [entry] = createStoreCatalog(root, ref).entries
    expect(entry.examples).toEqual(examples)
    expect(parseStoreCatalog(createStoreCatalog(root, ref)).entries[0]!.examples).toEqual(examples)
    for (const [bad, message] of [
      [[{ image: 'https://example.com/a.jpg' }], /needs a prompt/],
      [[{ prompt: 'x', image: 'http://example.com/a.jpg' }], /https URL/],
      [[{ prompt: 'x', caption: 'c'.repeat(121) }], /invalid example caption/],
      [[{ prompt: 'x', video: 'https://example.com/a.mp4' }], /unknown example field video/],
      [Array.from({ length: 9 }, () => ({ prompt: 'x' })), /invalid examples/],
    ] as const) {
      writeFileSync(join(root, 'agents', 'game', 'store.json'), JSON.stringify({ examples: bad }))
      expect(() => createStoreCatalog(root, ref)).toThrow(message)
    }
  })

  it('rejects a new harness whose shared viewer is not also published', () => {
    const root = fixture()
    const manifest = { spec: 1, id: 'autonomous/game', name: 'Game', engine: 'claude', viewer: { use: 'acme/not-listed' } }
    writeFileSync(join(root, 'agents', 'game', 'harness.json'), JSON.stringify(manifest))
    expect(() => createStoreCatalog(root, ref)).toThrow(/viewer acme\/not-listed/)
  })

  it('keeps community ownership and refs while preventing a verified flag from granting trust', () => {
    const root = fixture(); mkdirSync(join(root, 'registry', 'acme'), { recursive: true })
    writeFileSync(join(root, 'registry', 'acme', 'community.json'), JSON.stringify({ id: 'acme/community', name: 'Community', engine: 'codex', repo: 'https://github.com/acme/community', ref: 'v1', verified: true }))
    expect(createStoreCatalog(root, ref).entries.find((entry: { id: string }) => entry.id === 'acme/community')).toMatchObject({ verified: false, ref: 'v1' })
  })

  it('creates only catalog.json on the catalog branch, without modifying main or release tags', async () => {
    const requests: Array<{ path: string; method: string; data: Record<string, unknown> | null }> = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = String(url).replace('https://api.github.com/repos/autonomous-ai/openharness/', '')
      requests.push({ path, method: init?.method ?? 'GET', data: init?.body ? JSON.parse(String(init.body)) : null })
      if (path === 'git/ref/heads/store-catalog') return new Response('', { status: 404 })
      return Response.json({ sha: path === 'git/blobs' ? 'blob' : path === 'git/trees' ? 'tree' : 'commit' })
    })
    expect(await publishStoreCatalog(createStoreCatalog(fixture(), ref), { token: 'fixture-token', fetch: request })).toEqual({ changed: true, sha: 'commit' })
    expect(requests.map(item => item.path)).toEqual(['git/ref/heads/store-catalog', 'git/blobs', 'git/trees', 'git/commits', 'git/refs'])
    expect(requests.find(item => item.path === 'git/trees')?.data).toEqual({ tree: [{ path: 'catalog.json', mode: '100644', type: 'blob', sha: 'blob' }] })
    expect(requests.at(-1)?.data).toEqual({ ref: 'refs/heads/store-catalog', sha: 'commit' })
  })

  it('skips an unchanged publication', async () => {
    const catalog = createStoreCatalog(fixture(), ref)
    const body = JSON.stringify(catalog, null, 2) + '\n'
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex')
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: { sha: 'existing' } }))
      .mockResolvedValueOnce(Response.json({ tree: { sha: 'tree' } }))
      .mockResolvedValueOnce(Response.json({ tree: [{ path: 'catalog.json', sha }] }))
    expect(await publishStoreCatalog(catalog, { token: 'fixture-token', fetch: request })).toEqual({ changed: false, sha: 'existing' })
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it('updates by fast-forward and refuses a conflicting publication', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: { sha: 'existing' } }))
      .mockResolvedValueOnce(Response.json({ tree: { sha: 'tree' } }))
      .mockResolvedValueOnce(Response.json({ tree: [] }))
      .mockResolvedValueOnce(Response.json({ sha: 'blob' }))
      .mockResolvedValueOnce(Response.json({ sha: 'tree' }))
      .mockResolvedValueOnce(Response.json({ sha: 'commit' }))
      .mockResolvedValueOnce(new Response('', { status: 422 }))
    await expect(publishStoreCatalog(createStoreCatalog(fixture(), ref), { token: 'fixture-token', fetch: request })).rejects.toThrow(/422/)
    expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body))).toEqual({ sha: 'commit', force: false })
    expect(request).toHaveBeenCalledTimes(7)
  })
})
