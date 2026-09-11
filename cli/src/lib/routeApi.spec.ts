// The backend router client.
//
// Two things are pinned hard here. First, that EVERY failure comes back as null rather than throwing:
// this sits in front of a fallback ladder, and a router that can throw turns a backend hiccup into a
// lost turn. Second, that a 404 is one of those failures — the CLI self-updates from GCS while the
// backend ships on its own tags, so a machine will hold this build before the endpoint exists, and
// that machine must route exactly as it did yesterday.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const readAuthSession = vi.hoisted(() => vi.fn())
const accessToken = vi.hoisted(() => vi.fn())
vi.mock('./authSession.js', () => ({
  readAuthSession,
  AuthSessionManager: class {
    accessToken = accessToken
  },
}))

import { rankAgents, routeApiBase, ROUTE_API_PATH } from './routeApi.js'

const agents = [
  { id: 'a1', name: 'Phones', prompts: ['iphone 17 gia bao nhieu'] },
  { id: 'a2', name: 'Frontend', prompts: [] },
]

const ask = (over: Partial<Parameters<typeof rankAgents>[0]> = {}) =>
  rankAgents({ task: 'so sanh iphone vs samsung', agents, budgetMs: 12_000, ...over })

/** One backend reply in the `{success, data}` envelope every route uses. */
const replies = (ranking: unknown, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ success: status === 200, data: { ranking } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }))

/** The RequestInit of the nth fetch this test made. */
const sent = (spy: ReturnType<typeof replies>, at = 0): RequestInit => spy.mock.calls[at][1] as RequestInit

describe('rankAgents', () => {
  beforeEach(() => {
    readAuthSession.mockReturnValue({ accessToken: 'raw', autonomousEnv: 'prod', computerId: 'c1' })
    accessToken.mockResolvedValue('fresh-token')
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns the ranking', async () => {
    vi.stubGlobal('fetch', replies([
      { agentId: 'a1', score: 0.91, reason: 'phones' },
      { agentId: 'a2', score: 0.12, reason: 'no' },
    ]))
    expect(await ask()).toEqual([
      { agentId: 'a1', score: 0.91, reason: 'phones' },
      { agentId: 'a2', score: 0.12, reason: 'no' },
    ])
  })

  it('sends the REFRESHED token, not the one on disk', async () => {
    // A daemon that has been up for a week is holding an expired access token in its session file.
    const spy = replies([{ agentId: 'a1', score: 1 }])
    vi.stubGlobal('fetch', spy)
    await ask()
    const headers = sent(spy).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer fresh-token')
    expect(headers['x-autonomous-env']).toBe('prod')
  })

  it('sends the prompts as sent, empty list included', async () => {
    const spy = replies([{ agentId: 'a1', score: 1 }])
    vi.stubGlobal('fetch', spy)
    await ask()
    const body = JSON.parse(sent(spy).body as string)
    expect(body.agents).toEqual(agents)
    expect(body.task).toBe('so sanh iphone vs samsung')
  })

  it('asks the backend for LESS time than the caller has', async () => {
    // Equal deadlines make it a coin toss which fires first, and if the caller's wins the fallback
    // ladder never runs at all.
    const spy = replies([{ agentId: 'a1', score: 1 }])
    vi.stubGlobal('fetch', spy)
    await ask({ budgetMs: 12_000 })
    const body = JSON.parse(sent(spy).body as string)
    expect(body.budgetMs).toBeLessThan(12_000)
  })

  it('passes continuity only when it was given', async () => {
    const spy = replies([{ agentId: 'a1', score: 1 }])
    vi.stubGlobal('fetch', spy)
    await ask({ continuity: { agentId: 'a2', agoMs: 4_000 } })
    expect(JSON.parse(sent(spy).body as string).continuity)
      .toEqual({ agentId: 'a2', agoMs: 4_000 })
    vi.stubGlobal('fetch', spy)
    await ask()
    expect(JSON.parse(sent(spy, 1).body as string).continuity).toBeUndefined()
  })

  it('is null on 404 — the endpoint may simply not be deployed yet', async () => {
    vi.stubGlobal('fetch', replies(null, 404))
    expect(await ask()).toBeNull()
  })

  it('is null on 500', async () => {
    vi.stubGlobal('fetch', replies(null, 500))
    expect(await ask()).toBeNull()
  })

  it('is null when the machine is offline, and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND') }))
    await expect(ask()).resolves.toBeNull()
  })

  it('is null when nobody is signed in', async () => {
    readAuthSession.mockReturnValue(null)
    const spy = replies([{ agentId: 'a1', score: 1 }])
    vi.stubGlobal('fetch', spy)
    expect(await ask()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('is null when the token cannot be refreshed', async () => {
    accessToken.mockRejectedValue(new Error('refresh refused'))
    vi.stubGlobal('fetch', replies([{ agentId: 'a1', score: 1 }]))
    await expect(ask()).resolves.toBeNull()
  })

  it('drops a row naming an agent this daemon does not have', async () => {
    // The endpoint filters too, but THIS process is the one that will dispatch on the answer.
    vi.stubGlobal('fetch', replies([
      { agentId: 'ghost', score: 0.99 },
      { agentId: 'a2', score: 0.4 },
    ]))
    expect(await ask()).toEqual([{ agentId: 'a2', score: 0.4, reason: '' }])
  })

  it('is null when every row was dropped', async () => {
    vi.stubGlobal('fetch', replies([{ agentId: 'ghost', score: 0.99 }]))
    expect(await ask()).toBeNull()
  })

  it('is null when the body is not a ranking at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    expect(await ask()).toBeNull()
  })

  it('clamps a score outside 0..1 rather than trusting it', async () => {
    vi.stubGlobal('fetch', replies([{ agentId: 'a1', score: 7 }]))
    expect((await ask())?.[0].score).toBe(1)
  })
})

describe('routeApiBase', () => {
  it('is the websocket host over https', () => {
    expect(routeApiBase()).toMatch(/^https?:\/\//)
    expect(routeApiBase()).not.toMatch(/\/$/)
  })
  it('names the agreed path', () => expect(ROUTE_API_PATH).toBe('/api/route/agents'))
})
