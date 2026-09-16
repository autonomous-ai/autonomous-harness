// The Harness Store's backend half: ratings and reviews of harnesses.
//
// The catalogue itself is NOT here — it is the registry bundled into the CLI (`dsh/registry`), and
// installing is a per-machine act the daemon performs. What a store needs from a server is the part
// that has to be shared between people and signed: who rated what, and what they wrote. One review
// per person per harness; writing again replaces it.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'

export const STORE_RATINGS_PATH = '/api/store/ratings'
export const STORE_REVIEWS_PATH = '/api/store/harnesses/:owner/:name/reviews'
export const STORE_REVIEW_PATH = '/api/store/harnesses/:owner/:name/review'

/** `owner/name` — the same shape the CLI's DSH_ID_RE accepts. */
const segment = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i)
const harnessParams = z.object({ owner: segment, name: segment })
const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(80).optional(),
  body: z.string().trim().max(2000).optional(),
})
export type ReviewBody = z.infer<typeof reviewBody>

export interface RatingSummary {
  harnessId: string
  average: number
  count: number
  /** How many gave 1, 2, 3, 4, 5 stars — index 0 is one star. */
  histogram: [number, number, number, number, number]
}

export interface ReviewRow {
  id: string
  harnessId: string
  rating: number
  title: string | null
  body: string | null
  authorName: string
  mine: boolean
  createdAt: string
  updatedAt: string
}

const MAX_REVIEWS = 200

function summarize(harnessId: string, ratings: number[]): RatingSummary {
  const histogram: RatingSummary['histogram'] = [0, 0, 0, 0, 0]
  let total = 0
  for (const r of ratings) {
    if (r >= 1 && r <= 5) { histogram[r - 1] += 1; total += r }
  }
  const count = ratings.length
  return { harnessId, average: count ? Math.round((total / count) * 100) / 100 : 0, count, histogram }
}

/** Ratings, one summary per harness that has any — computed from the rows, so a histogram and its average cannot disagree. */
export async function ratingSummaries(): Promise<RatingSummary[]> {
  const rows = await prisma.harnessReview.findMany({ select: { harnessId: true, rating: true } })
  const byId = new Map<string, number[]>()
  for (const row of rows) {
    const list = byId.get(row.harnessId) ?? []
    list.push(row.rating)
    byId.set(row.harnessId, list)
  }
  return [...byId.entries()].map(([id, ratings]) => summarize(id, ratings)).sort((a, b) => a.harnessId.localeCompare(b.harnessId))
}

function row(review: { id: string; harnessId: string; rating: number; title: string | null; body: string | null; authorName: string; userId: string; createdAt: Date; updatedAt: Date }, userId: string): ReviewRow {
  return {
    id: review.id,
    harnessId: review.harnessId,
    rating: review.rating,
    title: review.title,
    body: review.body,
    authorName: review.authorName,
    mine: review.userId === userId,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  }
}

/** What the store prints beside a review. The person's name when they have one; never their email. */
async function authorNameOf(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  const name = user?.name?.trim()
  return name && name.length > 0 ? name.slice(0, 80) : 'Harness user'
}

type HarnessReq = FastifyRequest<{ Params: z.infer<typeof harnessParams> }>

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  app.get(STORE_RATINGS_PATH, async (_req, reply) => {
    sendSuccess(reply, { ratings: await ratingSummaries() })
  })

  app.get<{ Params: z.infer<typeof harnessParams> }>(
    STORE_REVIEWS_PATH,
    { preHandler: [validateParams(harnessParams)] },
    async (req: HarnessReq, reply) => {
      const harnessId = `${req.params.owner}/${req.params.name}`
      const userId = req.user!.sub
      const reviews = await prisma.harnessReview.findMany({
        where: { harnessId },
        orderBy: { updatedAt: 'desc' },
        take: MAX_REVIEWS,
      })
      const rows = reviews.map((r) => row(r, userId))
      // Mine first: the one review a person can edit is the one they look for.
      rows.sort((a, b) => Number(b.mine) - Number(a.mine))
      sendSuccess(reply, {
        rating: summarize(harnessId, reviews.map((r) => r.rating)),
        reviews: rows,
        mine: rows.find((r) => r.mine) ?? null,
      })
    },
  )

  app.put<{ Params: z.infer<typeof harnessParams>; Body: ReviewBody }>(
    STORE_REVIEW_PATH,
    { preHandler: [validateParams(harnessParams), validateBody(reviewBody)] },
    async (req, reply) => {
      const harnessId = `${req.params.owner}/${req.params.name}`
      const userId = req.user!.sub
      const { rating, title, body } = req.body
      const authorName = await authorNameOf(userId)
      const data = { rating, title: title || null, body: body || null, authorName }
      const review = await prisma.harnessReview.upsert({
        where: { harnessId_userId: { harnessId, userId } },
        create: { harnessId, userId, ...data },
        update: data,
      })
      sendSuccess(reply, { review: row(review, userId) })
    },
  )

  app.delete<{ Params: z.infer<typeof harnessParams> }>(
    STORE_REVIEW_PATH,
    { preHandler: [validateParams(harnessParams)] },
    async (req: HarnessReq, reply) => {
      const harnessId = `${req.params.owner}/${req.params.name}`
      const userId = req.user!.sub
      const { count } = await prisma.harnessReview.deleteMany({ where: { harnessId, userId } })
      if (count === 0) return sendError(reply, 'You have not reviewed this harness', 'NO_REVIEW', 404)
      sendSuccess(reply, { deleted: true })
    },
  )
}
