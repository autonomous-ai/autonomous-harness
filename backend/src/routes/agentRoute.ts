/**
 * Which agent a task belongs to — ranked, scored, and decided HERE rather than on the machine.
 *
 *   POST /api/route/agents   SSO access token → { ranking: [{ agentId, score, reason }] }
 *
 * WHY THIS LIVES IN THE BACKEND. The router used to build its prompt inside the `harness` CLI, which
 * means every wording change is a release, a GCS upload, and a wait for every machine to self-update.
 * A prompt that is still being corrected cannot converge on that loop. Here it changes with a deploy.
 *
 * WHY NOT /api/cursor/route. That endpoint belongs to the Cursor desktop app and says so in its first
 * line; it is deliberately self-contained, caps at eight conversations, carries one blob of "recent"
 * text per agent, and authenticates with a single shared secret. This one weighs fifteen agents, takes
 * the person's own last three questions per agent, returns a RANKING rather than a winner, and bills
 * each machine for its own call. Two products, two files — the fifteen lines of duplicated `fetch` are
 * cheaper than one prompt serving both.
 *
 * THE CALLER OWNS THE CLOCK. `budgetMs` is not decoration: the CLI gives a spoken task 12s and a typed
 * one 20s, and an endpoint that waits longer than that produces answers nobody is still listening for.
 * See BUDGET_MS_RANGE.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { validateBody } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const AGENT_ROUTE_PATH = '/api/route/agents'

/** Agents weighed in one request. The CLI's own cap (ROUTE_MAX_CANDIDATES) is the same number. */
const MAX_AGENTS = 15

/** Questions kept per agent — what `commander.ts` records (RECENT_TURNS). */
const MAX_PROMPTS_PER_AGENT = 3

/**
 * One question, bounded.
 *
 * NOT a trim of ordinary speech: the CLI stores asks at 1000 characters and sends them whole, because
 * cutting a Vietnamese sentence takes the object with it and the object is the topic. This exists for
 * the other case — somebody pasting a stack trace at an agent — which must not walk into the prompt.
 */
const MAX_PROMPT_CHARS = 4_000

/** Rows the model is asked to rank, and the most it may return. Mirrors ROUTE_SCORED_ROWS in the CLI. */
const MAX_RANKED = 5

/** What a caller may ask to wait. Clamped, never trusted — see the header. */
const BUDGET_MS_RANGE = { min: 3_000, max: 20_000, fallback: 10_000 } as const

/** Per-account budget. Routing is a keypress, not a loop. */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

const rateBuckets = new Map<string, { count: number; resetAt: number }>()

export function routeRateLimitAllows(userId: string, now = Date.now()): boolean {
  const bucket = rateBuckets.get(userId)
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false
  bucket.count++
  return true
}

/** Test seam: process-local by design, like the analytics limiter it copies. */
export function resetRouteRateLimits(): void {
  rateBuckets.clear()
}

const agentSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(200).default(''),
  /** The person's own last questions to this agent, newest first. Absent for a fresh agent. */
  prompts: z.array(z.string()).max(MAX_PROMPTS_PER_AGENT).default([]),
})

const routeBodySchema = z.object({
  task: z.string().min(1).max(MAX_PROMPT_CHARS),
  agents: z.array(agentSchema).min(1).max(MAX_AGENTS),
  budgetMs: z.number().int().optional(),
  /** Who the previous task went to, and how long ago. Optional: a first task has no predecessor. */
  continuity: z.object({ agentId: z.string().min(1), agoMs: z.number().min(0) }).optional(),
})

export type RouteBody = z.infer<typeof routeBodySchema>

/** A caller's budget, or this endpoint's own when it did not say. Clamped either way. */
export function resolveBudgetMs(asked: number | undefined): number {
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return BUDGET_MS_RANGE.fallback
  return Math.max(BUDGET_MS_RANGE.min, Math.min(BUDGET_MS_RANGE.max, Math.round(asked)))
}

/**
 * The prompt.
 *
 * Rewritten from the CLI's `buildRouterPrompt`, which had four faults worth naming here so they are not
 * reintroduced by a later edit:
 *
 *  1. IT MISLABELLED ITS OWN DATA. It announced "recently asked: …" over text that was, for any agent
 *     with no recorded question, a summary of what the MACHINE replied. Measured in that repo: "which
 *     year did the second world war end" summarised to "1945." — an answer, presented as the person's
 *     question, to a model asked to recognise a topic. An agent with nothing on record now says so.
 *  2. IT SCORED ONLY THE WINNER. The 0.85/0.6/0.3 scale described one agent's fit and said nothing
 *     about the rest, so the runners-up carried numbers that meant nothing next to each other or next
 *     to the threshold the app dispatches on.
 *  3. IT TOLD THE MODEL THE RUNNERS-UP DID NOT MATTER — "never dispatched to on their own" — while the
 *     app shows them on every unsure route.
 *  4. IT REPEATED "you MUST pick exactly one" three times, pushing for a decisive answer in the same
 *     breath as asking for an honest low score.
 *
 * The ranking IS the answer here; the pick is simply its first row.
 */
export function buildRankPrompt(body: RouteBody): string {
  // Named in the prompt, not left to be inferred. A model asked for "the five best" when nothing fits
  // well answers with one row and considers itself honest — and the picker then shows a single number
  // over a list of eight, which is the one shape it cannot be read in.
  const rows = Math.min(MAX_RANKED, body.agents.length)
  const list = body.agents
    .map((agent, index) => {
      const head = `[${index + 1}] id=${agent.id} | name="${agent.name}"`
      const prompts = agent.prompts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
      if (prompts.length === 0) return `${head}\n    (no questions on record)`
      const asked = prompts.map((p, at) => `      ${at + 1}. "${p}"`).join('\n')
      return `${head}\n    asked, newest first:\n${asked}`
    })
    .join('\n')

  // Stated as a fact with its age, not as an order to obey: a follow-up usually belongs to the same
  // agent, a new subject spoken thirty seconds later does not, and only the model can tell them apart.
  // Placed directly under the task because it is a fact ABOUT the task.
  const carry = body.continuity
    ? `\nThis person sent their previous task to id=${body.continuity.agentId}, ` +
      `${Math.max(1, Math.round(body.continuity.agoMs / 1000))}s ago. A follow-up — a pronoun, a ` +
      `comparison, or the same subject asked a second way — usually belongs there. A task about a ` +
      `plainly different subject does not.\n`
    : ''

  return (
    `You rank conversations by how well each one fits an incoming task.\n\n` +
    `TASK (verbatim; may be Vietnamese — do NOT translate it):\n"${body.task.trim()}"\n` +
    carry +
    `\nCONVERSATIONS:\n${list}\n\n` +
    `HOW TO READ ONE\n` +
    `- The NAME is written by the person. Sometimes it is a role ("Frontend", "Auth"), and sometimes it\n` +
    `  is simply THE FIRST THING THEY ASKED — a name like "Worldcup dc to chuc may lan roi" means that\n` +
    `  conversation is about the World Cup. Read both kinds as its subject.\n` +
    `- The lines under it are THE PERSON'S OWN QUESTIONS to that conversation, newest first. Nothing\n` +
    `  there is the machine's answer.\n` +
    `- "(no questions on record)" means a new conversation: it has a name and nothing else. That is not\n` +
    `  a reason to rank it last, nor a reason to rank it first.\n\n` +
    `HOW TO SCORE — score each conversation 0..1 against the TASK, on this one scale:\n` +
    `  0.85-1.0  the task plainly belongs here: it names this conversation, or it continues one of the\n` +
    `            questions listed under it.\n` +
    `  0.5-0.84  the same subject area, but nothing pins the task to this one.\n` +
    `  0.2-0.49  a weak link — one shared word, or a guess from the name alone.\n` +
    `  0.0-0.19  unrelated.\n\n` +
    `Score each one on its own merits, NOT relative to the others. Two conversations that both fit well\n` +
    `both score high. A task that fits nowhere is said by scoring EVERYTHING low — never by giving the\n` +
    `least-bad one a high score.\n\n` +
    `ALWAYS return ${MAX_RANKED} rows — or one row per conversation if there are fewer than ` +
    `${MAX_RANKED}. Highest score first.\n\n` +
    `A low score is an answer, not a reason to leave a row out. When the task fits nowhere, the right\n` +
    `reply is still ${MAX_RANKED} rows that are all scored low — a person reading this needs the list\n` +
    `in order to pick the one you could not find, and a single row gives them nothing to choose from.\n\n` +
    `Respond with ONLY this JSON, no prose, no markdown fence. The array has ${rows} entries:\n` +
    `{"ranking":[{"agentId":"<id from the list>","score":<0..1>,"reason":"<max 10 words>"}]}`
  )
}

/**
 * The LLM, over an OpenAI-compatible endpoint with plain `fetch`.
 *
 * A second copy of what `routes/cursor.ts` does, and knowingly so: that file documents its own
 * self-containment as a decision, and importing across two products' routing to save a `fetch` would
 * couple a Harness deploy to the Cursor app's behaviour.
 */
async function callLlm(prompt: string, timeoutMs: number): Promise<{ text: string; model: string }> {
  const model = env.CURSOR_LLM_MODEL
  const res = await fetch(`${env.CURSOR_LLM_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CURSOR_LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
  return { text: (data.choices?.[0]?.message?.content ?? '').trim(), model: data.model || model }
}

export interface RankedRow { agentId: string; score: number; reason: string }

/**
 * The ranking, parsed defensively.
 *
 * "Respond with only JSON" is a request, not a guarantee — a fence or a sentence of preamble is normal
 * from the model this runs on. Rows are DROPPED rather than corrected: an id that was never offered, a
 * repeat, or a score that is not a number would each draw a bar in the app for something that is not
 * there, and a picker showing an agent the machine does not have is worse than one showing nothing.
 *
 * Returns null when nothing usable came back at all, which the caller treats as a failed call rather
 * than as an empty ranking — the two need opposite handling on the machine.
 */
export function parseRanking(raw: string, offered: Set<string>): RankedRow[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  const rows = (parsed as { ranking?: unknown })?.ranking
  if (!Array.isArray(rows)) return null

  const seen = new Set<string>()
  const out: RankedRow[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const entry = row as Record<string, unknown>
    const agentId = typeof entry.agentId === 'string' ? entry.agentId : ''
    if (!agentId || !offered.has(agentId) || seen.has(agentId)) continue
    const value = typeof entry.score === 'number' ? entry.score : Number(entry.score)
    if (!Number.isFinite(value)) continue
    seen.add(agentId)
    out.push({
      agentId,
      score: Math.max(0, Math.min(1, value)),
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 120) : '',
    })
    if (out.length >= MAX_RANKED) break
  }
  // A model that answered in the right shape but named nothing we offered has failed, not abstained.
  return out.length > 0 ? out : null
}

/**
 * ORDINARY SSO GATING — this route is NOT in the auth middleware's skip-list, and that is the whole
 * point of how it authenticates.
 *
 * The `harness` daemon signs in as a person: `~/.harness/auth/session.json` holds an SSO access token
 * and an Autonomous environment, and that is what it already presents to `/api/device-ws`. It holds no
 * machine api key at all, so gating this on one — the arrangement `/api/analytics/report` uses — would
 * have refused every real caller with "Unknown machine".
 *
 * The middleware puts the resolved account on `request.user`, which is what the limiter below counts.
 */
export async function agentRouteRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RouteBody }>(
    AGENT_ROUTE_PATH,
    { preHandler: [validateBody(routeBodySchema)] },
    async (req, reply) => {
      // Fail CLOSED on an unconfigured model, like the Cursor routes: an absent credential must never
      // read as "answer some other way" on a path that spends credit.
      if (!env.CURSOR_LLM_BASE_URL || !env.CURSOR_LLM_API_KEY) {
        logger.error('agent-route: CURSOR_LLM_BASE_URL/CURSOR_LLM_API_KEY not configured — refusing')
        sendError(reply, 'Routing is not configured', 'LLM_NOT_CONFIGURED', 503)
        return
      }

      const body = req.body
      const userId = req.user?.sub ?? ''
      if (!routeRateLimitAllows(userId)) {
        sendError(reply, 'Too many routing requests', 'RATE_LIMITED', 429)
        return
      }

      // One conversation is not a decision. Answered here so the single-agent case cannot fail for a
      // reason that has nothing to do with the person — and so it costs no call.
      if (body.agents.length === 1) {
        sendSuccess(reply, { ranking: [{ agentId: body.agents[0].id, score: 1, reason: 'only conversation' }] })
        return
      }

      const budgetMs = resolveBudgetMs(body.budgetMs)
      const offered = new Set(body.agents.map((a) => a.id))
      const started = Date.now()

      try {
        const { text, model } = await callLlm(buildRankPrompt(body), budgetMs)
        const ranking = parseRanking(text, offered)
        if (!ranking) {
          logger.error('agent-route: unusable answer', { model, userId, sample: text.slice(0, 200) })
          sendError(reply, 'Routing failed', 'ROUTE_FAILED', 502)
          return
        }
        logger.info('agent-route', {
          userId,
          agents: body.agents.length,
          // With no questions on record an agent is ranked on its name alone. How many are in that
          // state is the first thing to look at when a route reads wrong.
          bare: body.agents.filter((a) => a.prompts.length === 0).length,
          chars: body.task.length,
          model,
          ms: Date.now() - started,
          top: ranking[0].score,
          rows: ranking.length,
        })
        sendSuccess(reply, { ranking })
      } catch (err) {
        // No scored fallback here, deliberately. The machine already has one (pickAgentHeuristic) and it
        // sees things this endpoint cannot — which agents are open in the window, what the person just
        // routed to. Two different word-matchers racing to answer one question is how a product ends up
        // with two behaviours nobody can account for.
        logger.error('agent-route failed', {
          userId,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        })
        sendError(reply, 'Routing failed', 'ROUTE_FAILED', 502)
      }
    },
  )
}
