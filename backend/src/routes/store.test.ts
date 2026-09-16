// The Harness Store's ratings and reviews. Pinned: one review per person per harness (a second
// write replaces, never stacks), the summary is computed from the rows, a review is `mine` only to
// its author, deleting what you never wrote is a 404, and the whole group sits behind the SSO gate.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

interface Row { id: string; harnessId: string; userId: string; authorName: string; rating: number; title: string | null; body: string | null; createdAt: Date; updatedAt: Date }
const db = vi.hoisted(() => ({ rows: [] as Row[], users: new Map<string, { name: string | null }>(), seq: 0 }))
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => db.users.get(where.id) ?? null },
    harnessReview: {
      findMany: async ({ where, select }: { where?: { harnessId?: string }; select?: unknown; orderBy?: unknown; take?: number } = {}) => {
        const rows = db.rows.filter((r) => !where?.harnessId || r.harnessId === where.harnessId)
        return select ? rows.map((r) => ({ harnessId: r.harnessId, rating: r.rating })) : rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      },
      upsert: async ({ where, create, update }: { where: { harnessId_userId: { harnessId: string; userId: string } }; create: Omit<Row, 'id' | 'createdAt' | 'updatedAt'>; update: Partial<Row> }) => {
        const { harnessId, userId } = where.harnessId_userId
        const existing = db.rows.find((r) => r.harnessId === harnessId && r.userId === userId)
        if (existing) { Object.assign(existing, update, { updatedAt: new Date(existing.updatedAt.getTime() + 1000) }); return existing }
        const now = new Date(2026, 8, 16, 0, 0, db.seq++)
        const row: Row = { id: `r${db.seq}`, ...create, createdAt: now, updatedAt: now }
        db.rows.push(row); return row
      },
      deleteMany: async ({ where }: { where: { harnessId: string; userId: string } }) => {
        const before = db.rows.length
        db.rows = db.rows.filter((r) => !(r.harnessId === where.harnessId && r.userId === where.userId))
        return { count: before - db.rows.length }
      },
    },
  },
}))

import { storeRoutes, STORE_RATINGS_PATH } from './store.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(storeRoutes)
  await app.ready()
  return app
}

/** Two people: the token names who. */
const people: Record<string, { sub: string; email: string; role: string; autonomousEnv: 'prod' }> = {
  'tok-ann': { sub: 'u-ann', email: 'ann@example.com', role: 'user', autonomousEnv: 'prod' },
  'tok-bo': { sub: 'u-bo', email: 'bo@example.com', role: 'user', autonomousEnv: 'prod' },
}

function call(app: FastifyInstance, method: InjectOptions['method'], url: string, token: string | null, payload?: unknown) {
  return app.inject({ method, url, payload: payload as InjectOptions['payload'], headers: token ? { authorization: `Bearer ${token}` } : {} })
}

describe('the Harness Store', () => {
  beforeEach(() => {
    db.rows = []; db.seq = 0
    db.users = new Map([['u-ann', { name: 'Ann Lee' }], ['u-bo', { name: null }]])
    authenticateAccessToken.mockImplementation(async (token: string) => {
      const who = people[token]
      if (!who) throw new Error('bad token')
      return who
    })
  })

  it('is behind the SSO gate', async () => {
    const app = await build()
    expect((await call(app, 'GET', STORE_RATINGS_PATH, null)).statusCode).toBe(401)
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', null, { rating: 5 })).statusCode).toBe(401)
  })

  it('one review per person, replaced on a second write, summarized from the rows', async () => {
    const app = await build()
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-ann', { rating: 5, title: 'Keynote in a minute', body: 'The pane is the deck.' })).statusCode).toBe(200)
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-bo', { rating: 3 })).statusCode).toBe(200)
    // Ann changes her mind: still one row of hers.
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-ann', { rating: 4, body: 'Art generation is slow.' })).statusCode).toBe(200)

    const ratings = (await call(app, 'GET', STORE_RATINGS_PATH, 'tok-bo')).json()
    expect(ratings.data.ratings).toEqual([{ harnessId: 'autonomous/marp', average: 3.5, count: 2, histogram: [0, 0, 1, 1, 0] }])

    const listed = (await call(app, 'GET', '/api/store/harnesses/autonomous/marp/reviews', 'tok-bo')).json().data
    expect(listed.rating.count).toBe(2)
    expect(listed.reviews.map((r: { authorName: string; mine: boolean; rating: number; title: string | null }) => [r.authorName, r.mine, r.rating, r.title]))
      .toEqual([['Harness user', true, 3, null], ['Ann Lee', false, 4, null]])
    expect(listed.mine.rating).toBe(3)
    // Nobody's email leaves the server.
    expect(JSON.stringify(listed)).not.toContain('@example.com')
  })

  it('refuses a rating outside 1..5 and a malformed id', async () => {
    const app = await build()
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-ann', { rating: 6 })).statusCode).toBe(400)
    expect((await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-ann', { rating: 0 })).statusCode).toBe(400)
    expect((await call(app, 'GET', '/api/store/harnesses/auto%20nomous/marp/reviews', 'tok-ann')).statusCode).toBe(400)
  })

  it('deletes only your own review, and says so when there is none', async () => {
    const app = await build()
    await call(app, 'PUT', '/api/store/harnesses/autonomous/marp/review', 'tok-ann', { rating: 5 })
    expect((await call(app, 'DELETE', '/api/store/harnesses/autonomous/marp/review', 'tok-bo')).statusCode).toBe(404)
    expect((await call(app, 'DELETE', '/api/store/harnesses/autonomous/marp/review', 'tok-ann')).statusCode).toBe(200)
    expect((await call(app, 'GET', STORE_RATINGS_PATH, 'tok-ann')).json().data.ratings).toEqual([])
  })
})
