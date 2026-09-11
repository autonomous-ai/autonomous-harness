/**
 * Ask the backend which agent a task belongs to.
 *
 * WHY THE BACKEND. The router's prompt used to be built here, which made every wording change a
 * release: bump, build, upload to GCS, then wait for each machine to self-update. A prompt that is
 * still being corrected cannot converge on that loop, and this one is still being corrected — the
 * owner's complaint that started this work was that it suggests the wrong agent too often. On the
 * backend it changes with a deploy.
 *
 * WHAT IS SENT. The task, and for each agent its NAME and the person's own last three questions to
 * it. Nothing else: no recap of what the agent replied, no machine name, no engine. The old prompt
 * carried a summary of the AGENT'S ANSWERS under a heading claiming they were the person's questions,
 * which is the single most likely reason it misrouted with confidence.
 *
 * WHAT COMES BACK. A RANKING — up to five agents, each with a score on one absolute scale — not a
 * winner plus some runners-up. The pick is simply its first row.
 *
 * NULL, NEVER A THROW. Every failure here (no session, no network, a 5xx, an unusable body) means the
 * same thing to the caller: this route did not answer, use the ladder below it. A router that can
 * throw would turn a backend hiccup into a lost turn.
 */
import { env } from '../config/env.js'
import { readAuthSession, AuthSessionManager } from './authSession.js'

/** One row of the answer. */
export interface RankedAgent {
  agentId: string
  /** 0..1 on the endpoint's absolute scale — comparable across rows and against the app's threshold. */
  score: number
  reason: string
}

/** What the endpoint is told about one agent. */
export interface RouteApiAgent {
  id: string
  name: string
  /** The person's own last questions to this agent, newest first. EMPTY for a fresh agent. */
  prompts: string[]
}

export interface RouteApiOptions {
  task: string
  agents: RouteApiAgent[]
  /**
   * How long the CALLER can wait. Passed through so the endpoint never outlives the person watching:
   * a spoken task has 12s and a typed one 20s, and an answer that arrives after the caller gave up is
   * the same as no answer while still costing a model call.
   */
  budgetMs: number
  /** Who the previous task went to, and how long ago. Omitted when there was none, or it is stale. */
  continuity?: { agentId: string; agoMs: number }
  signal?: AbortSignal
}

export const ROUTE_API_PATH = '/api/route/agents'

/** Same derivation `backendHttpBase()` uses in cli.ts — the WS host over https. */
export function routeApiBase(): string {
  return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

/**
 * A small margin so the HTTP call gives up before the caller's own clock does.
 *
 * Without it the two deadlines are equal and which one fires first is a coin toss — and if the
 * caller's wins, the fallback ladder never runs at all.
 */
const ROUND_TRIP_MARGIN_MS = 1_500

/**
 * The ranking, or null when this route could not produce one.
 *
 * The daemon signs in as a PERSON — `~/.harness/auth/session.json` holds an SSO access token, and it
 * holds no machine api key at all — so this presents the same Bearer credential the control-plane
 * calls in cli.ts do, refreshed through AuthSessionManager rather than read raw: a daemon that has
 * been up for a week is holding an expired token otherwise.
 */
export async function rankAgents(options: RouteApiOptions): Promise<RankedAgent[] | null> {
  const session = readAuthSession()
  if (!session) return null

  let accessToken: string
  try {
    accessToken = await new AuthSessionManager(routeApiBase()).accessToken()
  } catch {
    // Signed out, or the refresh was refused. Not this router's problem to report.
    return null
  }

  const budget = Math.max(1_000, options.budgetMs - ROUND_TRIP_MARGIN_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.budgetMs)
  const onCallerAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const res = await fetch(`${routeApiBase()}${ROUTE_API_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-autonomous-env': session.autonomousEnv,
      },
      body: JSON.stringify({
        task: options.task,
        agents: options.agents,
        budgetMs: budget,
        ...(options.continuity ? { continuity: options.continuity } : {}),
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // 404 is the ROLLOUT case and must stay quiet-ish: the CLI self-updates from GCS while the
      // backend ships on its own tags, so a machine can hold this build for days before the endpoint
      // exists. It falls through to the ladder exactly like any other failure.
      console.log(`[voice-route] backend said ${res.status} → falling through`)
      return null
    }
    const payload = (await res.json()) as { data?: { ranking?: unknown } } | null
    const rows = payload?.data?.ranking
    if (!Array.isArray(rows)) return null

    // Validated again on the way in. The endpoint already filters against the ids it was offered, but
    // this process is the one that will DISPATCH on the answer, and a row naming an agent this daemon
    // does not have would send a person's words nowhere.
    const known = new Set(options.agents.map((agent) => agent.id))
    const seen = new Set<string>()
    const ranking: RankedAgent[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const entry = row as Record<string, unknown>
      const agentId = typeof entry.agentId === 'string' ? entry.agentId : ''
      if (!agentId || !known.has(agentId) || seen.has(agentId)) continue
      const score = typeof entry.score === 'number' ? entry.score : Number(entry.score)
      if (!Number.isFinite(score)) continue
      seen.add(agentId)
      ranking.push({
        agentId,
        score: Math.max(0, Math.min(1, score)),
        reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 120) : '',
      })
    }
    return ranking.length > 0 ? ranking : null
  } catch {
    // A timeout, an offline machine, a body that is not JSON. All the same answer.
    return null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
