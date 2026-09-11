// POST /api/route/agents — the agent router's backend half.
//
// What is pinned here is the part that is easy to break quietly: that a model's answer is filtered
// against the ids we actually offered, that the caller's clock wins over this endpoint's, and that an
// agent with no questions on record is described honestly in the prompt rather than being given
// somebody else's text.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
// Only the SSO network call is faked. bearerToken, resolveSsoAuth and the middleware's own 401 mapping
// stay REAL, so this route's gating is genuinely exercised rather than assumed.
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import {
  agentRouteRoutes,
  buildRankPrompt,
  parseRanking,
  resolveBudgetMs,
  resetRouteRateLimits,
  AGENT_ROUTE_PATH,
  type RouteBody,
} from './agentRoute.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'
import { SsoAuthError } from '../lib/ssoAuth.js'
import { env } from '../config/env.js'

const body = (over: Partial<RouteBody> = {}): RouteBody => ({
  task: 'so sanh iphone vs samsung',
  agents: [
    { id: 'a1', name: 'Phones', prompts: ['iphone 17 gia bao nhieu'] },
    { id: 'a2', name: 'Frontend', prompts: [] },
  ],
  ...over,
})

/** The app as the server builds it: the global SSO gate in front, then the route. */
async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(agentRouteRoutes)
  await app.ready()
  return app
}

function post(app: FastifyInstance, payload: unknown, opts: { noAuth?: boolean } = {}) {
  const options: InjectOptions = {
    method: 'POST',
    url: AGENT_ROUTE_PATH,
    payload: payload as InjectOptions['payload'],
    headers: opts.noAuth ? {} : { authorization: 'Bearer sso-token' },
  }
  return app.inject(options)
}

/** One OpenAI-compatible reply, as `fetch` would hand it back. */
const llmSays = (content: string) =>
  vi.fn(async () => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))

describe('POST /api/route/agents', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetRouteRateLimits()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockResolvedValue({ sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' })
    env.CURSOR_LLM_BASE_URL = 'https://llm.example/v1'
    env.CURSOR_LLM_API_KEY = 'llm-key'
  })

  it('is gated by the ordinary SSO middleware — the daemon signs in as a person', () => {
    // NOT in the skip-list, unlike /api/analytics/report. The `harness` daemon holds an SSO access
    // token and no machine api key, so a machine-key gate would refuse every real caller.
    expect(shouldSkipAuth(AGENT_ROUTE_PATH)).toBe(false)
  })

  it('refuses without a token', async () => {
    const app = await build()
    expect((await post(app, body(), { noAuth: true })).statusCode).toBe(401)
  })

  it('refuses a token the SSO service rejects', async () => {
    authenticateAccessToken.mockRejectedValue(new SsoAuthError('nope', 'INVALID_TOKEN'))
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(401)
  })

  it('answers the single-agent case without spending a call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const app = await build()
    const res = await post(app, body({ agents: [{ id: 'only', name: 'One', prompts: [] }] }))
    expect(res.statusCode).toBe(200)
    expect(res.json().data.ranking).toEqual([{ agentId: 'only', score: 1, reason: 'only conversation' }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ranks from the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"a1","score":0.9,"reason":"phones"},{"agentId":"a2","score":0.1,"reason":"no"}]}') as never,
    )
    const app = await build()
    const res = await post(app, body())
    expect(res.statusCode).toBe(200)
    const ranking = res.json().data.ranking
    expect(ranking[0]).toMatchObject({ agentId: 'a1', score: 0.9 })
    expect(ranking).toHaveLength(2)
  })

  it('passes the caller\'s budget to the model call, not its own', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"a1","score":0.9}]}') as never,
    )
    const app = await build()
    await post(app, body({ budgetMs: 12_000 }))
    const init = spy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('is a 502 when the model names nothing we offered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      llmSays('{"ranking":[{"agentId":"invented","score":0.9}]}') as never,
    )
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(502)
  })

  it('is a 502 when the call itself fails — no scored fallback here', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream down') as never)
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(502)
  })

  it('refuses when no model is configured, rather than answering another way', async () => {
    env.CURSOR_LLM_API_KEY = undefined
    const app = await build()
    expect((await post(app, body())).statusCode).toBe(503)
  })

  it('rejects a body with no agents', async () => {
    const app = await build()
    expect((await post(app, { task: 'hi', agents: [] })).statusCode).toBe(400)
  })

  it('rejects more than fifteen agents rather than silently weighing some', async () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ id: `a${i}`, name: `n${i}`, prompts: [] }))
    const app = await build()
    expect((await post(app, { task: 'hi', agents: many })).statusCode).toBe(400)
  })
})

describe('resolveBudgetMs', () => {
  // The caller owns the clock: the CLI gives a spoken task 12s, and an endpoint that waits longer
  // produces answers nobody is still listening for.
  it('takes the caller\'s budget', () => expect(resolveBudgetMs(12_000)).toBe(12_000))
  it('clamps an absurdly long one', () => expect(resolveBudgetMs(600_000)).toBe(20_000))
  it('clamps an impossibly short one', () => expect(resolveBudgetMs(1)).toBe(3_000))
  it('falls back when not asked', () => expect(resolveBudgetMs(undefined)).toBe(10_000))
  it('falls back on a non-number', () => expect(resolveBudgetMs(NaN)).toBe(10_000))
})

describe('parseRanking', () => {
  const offered = new Set(['a1', 'a2', 'a3'])

  it('reads a bare object', () => {
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":0.7,"reason":"r"}]}', offered))
      .toEqual([{ agentId: 'a1', score: 0.7, reason: 'r' }])
  })

  it('survives a code fence and a sentence of preamble', () => {
    const raw = 'Sure, here you go:\n```json\n{"ranking":[{"agentId":"a2","score":0.5}]}\n```'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a2', score: 0.5, reason: '' }])
  })

  it('drops an id that was never offered instead of correcting it', () => {
    const raw = '{"ranking":[{"agentId":"ghost","score":0.9},{"agentId":"a1","score":0.4}]}'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a1', score: 0.4, reason: '' }])
  })

  it('drops a repeat', () => {
    const raw = '{"ranking":[{"agentId":"a1","score":0.9},{"agentId":"a1","score":0.2}]}'
    expect(parseRanking(raw, offered)).toHaveLength(1)
  })

  it('drops a row whose score is not a number', () => {
    const raw = '{"ranking":[{"agentId":"a1","score":"high"},{"agentId":"a2","score":0.3}]}'
    expect(parseRanking(raw, offered)).toEqual([{ agentId: 'a2', score: 0.3, reason: '' }])
  })

  it('clamps a score outside 0..1', () => {
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":4}]}', offered)?.[0].score).toBe(1)
    expect(parseRanking('{"ranking":[{"agentId":"a1","score":-2}]}', offered)?.[0].score).toBe(0)
  })

  it('caps at five rows', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
    const wide = new Set(ids)
    const raw = `{"ranking":[${ids.map((id) => `{"agentId":"${id}","score":0.5}`).join(',')}]}`
    expect(parseRanking(raw, wide)).toHaveLength(5)
  })

  it('is null on unparseable text — a failed call, not an empty ranking', () => {
    expect(parseRanking('I could not decide.', offered)).toBeNull()
    expect(parseRanking('{"ranking":', offered)).toBeNull()
    expect(parseRanking('{"winner":"a1"}', offered)).toBeNull()
  })

  it('is null when every row was dropped — answering in shape but naming nobody is a failure', () => {
    expect(parseRanking('{"ranking":[{"agentId":"ghost","score":1}]}', offered)).toBeNull()
  })
})

describe('buildRankPrompt', () => {
  it('lists a person\'s questions as theirs, numbered and newest first', () => {
    const prompt = buildRankPrompt(body({
      agents: [{ id: 'a1', name: 'Phones', prompts: ['newest one', 'older one'] }, { id: 'a2', name: 'X', prompts: [] }],
    }))
    expect(prompt).toContain('asked, newest first:')
    expect(prompt.indexOf('1. "newest one"')).toBeLessThan(prompt.indexOf('2. "older one"'))
    expect(prompt).toContain("THE PERSON'S OWN QUESTIONS")
  })

  it('says an agent has nothing on record rather than filling it with the machine\'s replies', () => {
    // The fault this whole endpoint was written to fix: the old prompt announced "recently asked" over
    // text that was a summary of what the AGENT said back.
    const prompt = buildRankPrompt(body({ agents: [{ id: 'a1', name: 'Fresh', prompts: [] }, { id: 'a2', name: 'B', prompts: ['x'] }] }))
    expect(prompt).toContain('(no questions on record)')
  })

  it('names how many rows it wants, and says a low score is still an answer', () => {
    // A model asked for "the five best" when nothing fits answers with ONE row and thinks itself
    // honest — and the picker then draws a single number over a list of eight.
    const prompt = buildRankPrompt(body({
      agents: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `n${i}`, prompts: [] })),
    }))
    expect(prompt).toContain('ALWAYS return 5 rows')
    expect(prompt).toContain('A low score is an answer')
    expect(prompt).toContain('The array has 5 entries')
  })

  it('asks for one row per conversation when there are fewer than five', () => {
    const prompt = buildRankPrompt(body({
      agents: [{ id: 'a1', name: 'A', prompts: [] }, { id: 'a2', name: 'B', prompts: [] }],
    }))
    expect(prompt).toContain('The array has 2 entries')
  })

  it('scores on an absolute scale, not against each other', () => {
    const prompt = buildRankPrompt(body())
    expect(prompt).toContain('NOT relative to the others')
  })

  it('carries the task verbatim and forbids translating it', () => {
    const prompt = buildRankPrompt(body({ task: 'so sánh iphone với samsung' }))
    expect(prompt).toContain('so sánh iphone với samsung')
    expect(prompt).toContain('do NOT translate')
  })

  it('states continuity as a fact with its age, and omits it entirely when absent', () => {
    const withCarry = buildRankPrompt(body({ continuity: { agentId: 'a2', agoMs: 30_000 } }))
    expect(withCarry).toContain('previous task to id=a2, 30s ago')
    expect(buildRankPrompt(body())).not.toContain('previous task')
  })

  it('does not mention a machine — the old prompt printed one and never explained it', () => {
    expect(buildRankPrompt(body())).not.toContain('machine=')
  })
})
