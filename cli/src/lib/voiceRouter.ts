// Voice router (adapter side, for REMOTE machines) — self-contained port of the the hosted runtime's
// Given a transcribed voice task and this machine's agents (name + a
// short summary of each agent's recent turn), pick the single best-fit agent. Uses the same key-free CLI
// one-shot path as the turn summarizer, using a small/fast model where the engine exposes one. Name
// is the strongest signal (users name agents by role/domain); recent activity disambiguates.
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'
import { runGrokOneShot, runRouterOneShot, configureRouterOneShot, setRouterOneShotDeviceConnected, shutdownRouterOneShot } from './oneshot.js'

export interface RouterAgent {
  id: string
  name: string
  /** The CLI this agent runs on. It is what decides which engine classifies the route — see
   *  chooseRouterEngine — so the decision is made from the very list being routed over. */
  engine?: string
  /** Recaps of the agent's last few completed turns (up to 3), joined — a broader, less skewed picture
   *  of what it's working on than a single turn. */
  recentSummary?: string
}

export interface RouteDecision {
  agentId: string
  confidence: number
  reason: string
  needNewAgent: boolean
}

const ROUTE_SCRATCH = join(env.ADAPTER_DATA_DIR, 'voice-route-scratch')

/** Engines that can serve the router, best first. Grok takes the prompt as argv and cannot be warmed, but
 * its isolated direct one-shot is still bounded enough to route a Grok-only machine. */
const ROUTER_ENGINE_PRIORITY = ['claude', 'codex', 'commandcode', 'cursor', 'pi', 'opencode', 'kilo', 'grok'] as const
export type RouterEngine = (typeof ROUTER_ENGINE_PRIORITY)[number]

/**
 * Pick the engine to classify with, from the agents the machine is ACTUALLY running.
 *
 * A live agent is proof that its CLI exists and is logged in; nothing else here is. The router used to be
 * pinned to Claude, so a machine without it never routed at all — the warm spawn failed on a loop and every
 * voice silently fell through to name-matching, whose capped confidence can never reach the backend's
 * auto-dispatch threshold. Claude is still preferred, but only when the user has a Claude agent.
 *
 * null = no agent this can run on. The caller goes straight to the heuristic instead of spending a doomed
 * spawn out of the 12s route budget on every voice.
 */
export function chooseRouterEngine(sessions: Array<{ engine: string }>): RouterEngine | null {
  const present = new Set(sessions.map((session) => session.engine))
  return ROUTER_ENGINE_PRIORITY.find((engine) => present.has(engine)) ?? null
}

/**
 * Which model classifies the route.
 *
 * Claude gets an explicit one (Haiku by default): it is the cheapest, fastest model on every Claude plan,
 * and routing has a 12s budget for what is a 20-word classification. Set VOICE_ROUTE_MODEL='' to make it
 * follow the selected model like the others.
 *
 * Every other engine gets NOTHING, which makes its CLI use the model the user already has selected. Naming
 * a model per engine looked tidy and was wrong twice over: it pointed Codex at a frontier model (gpt-5.5)
 * for a classification, and a model id the user's account or CLI version does not accept fails the one-shot
 * — dropping back to name matching, silently, which is the very bug this router path exists to fix. The
 * selected model is the one model guaranteed to run.
 */
export function routerModelFor(engine: RouterEngine): string {
  return engine === 'claude' ? env.VOICE_ROUTE_MODEL : ''
}

/** The engine the pool is currently warmed for; null until the registry has been synced at least once. */
let routerEngine: RouterEngine | null = null

// With --no-session-persistence the one-shot writes nothing here; the dir just has to exist as the cwd.
function ensureRouteScratch(): string {
  if (!existsSync(ROUTE_SCRATCH)) mkdirSync(ROUTE_SCRATCH, { recursive: true })
  return ROUTE_SCRATCH
}

// Point the warm router worker at the chosen engine's small model @ the route scratch. Lazy (not at import)
// so importing this module for the pure helpers has no filesystem/pool side effects.
function ensureRouterConfigured(engine: RouterEngine): void {
  if (engine === 'grok') return
  configureRouterOneShot({ engine, cwd: ensureRouteScratch(), model: routerModelFor(engine), effort: 'low' })
}

/**
 * Tell the router which agents exist. Called from the same place the recap pool is synced, so the warm
 * worker always belongs to an engine the machine really runs.
 */
export function setVoiceRouterSessions(sessions: Array<{ engine: string }>): void {
  const next = chooseRouterEngine(sessions)
  if (next === routerEngine) return
  routerEngine = next
  if (!next) {
    console.log('[voice-route] no agent this router can run on — voice will route by name matching')
    return
  }
  if (next === 'grok') setRouterOneShotDeviceConnected(false)
  console.log(`[voice-route] router engine=${next} model=${routerModelFor(next) || '(engine default)'}`)
  ensureRouterConfigured(next)
}

/** Warm (device connected) / unwarm the router worker — wired to commander presence in cli.ts. */
export function setVoiceRouterDeviceConnected(connected: boolean): void {
  // Config must be set before the pool spawns a warm worker. With no usable engine there is nothing to
  // warm — the heuristic needs no process.
  if (connected && routerEngine) ensureRouterConfigured(routerEngine)
  setRouterOneShotDeviceConnected(connected && routerEngine !== 'grok')
}
export function shutdownVoiceRouter(): void {
  shutdownRouterOneShot()
}

// Diacritic/case-insensitive tokens (Vietnamese-aware) for the heuristic fallback matcher.
function routeTokens(s: string): string[] {
  const norm = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase()
  return norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
}

// Fallback when the LLM router is unavailable (timed out / spawn failed): score each agent by how many
// transcript words appear in its NAME (strong signal) and recent activity (weak), and pick the best. Always
// returns a concrete in-machine agent with a low, capped confidence — the voice still dispatches, never errors.
export function pickAgentHeuristic(transcript: string, agents: RouterAgent[]): RouteDecision {
  const words = new Set(routeTokens(transcript))
  let best = agents[0]
  let bestScore = -1
  for (const a of agents) {
    const nameHits = routeTokens(a.name).filter((t) => words.has(t)).length
    const recentHits = routeTokens(a.recentSummary ?? '').filter((t) => words.has(t)).length
    const score = nameHits * 3 + recentHits
    if (score > bestScore) { bestScore = score; best = a }
  }
  const matched = bestScore > 0
  return {
    agentId: best?.id ?? agents[0]?.id ?? '',
    confidence: matched ? 0.4 : 0.2,
    reason: matched ? 'heuristic name/recent match' : 'closest agent (router unavailable)',
    needNewAgent: false,
  }
}

/** One line of the voice task, bounded — the adapter log already carries injected messages this way. */
function taskPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** Name the winner. Without this the log said an engine ran and never which agent it picked, so a wrong
 *  route looked identical to a right one. `via` separates a real classification from a fallback. */
function logDecision(via: string, agents: RouterAgent[], decision: RouteDecision): RouteDecision {
  const chosen = agents.find((agent) => agent.id === decision.agentId)
  console.log(
    `[voice-route] → picked "${chosen?.name ?? '(unknown)'}" id=${decision.agentId || '(none)'}` +
    ` · confidence=${decision.confidence.toFixed(2)} · via=${via}` +
    `${decision.reason ? ` · "${decision.reason}"` : ''}`,
  )
  return decision
}

export function buildRouterPrompt(transcript: string, agents: RouterAgent[]): string {
  const lines = agents
    .map((a) => `- id=${a.id} | name="${a.name}" | recent: ${a.recentSummary?.trim() || '(no activity yet)'}`)
    .join('\n')
  return (
    `You are a ROUTER. Assign ONE incoming voice task to the single best-fit agent from the fixed list ` +
    `below. You MUST always choose exactly one agent from the list — there is NO "none" option and you may ` +
    `NOT decline. The agent NAME is a strong signal — the user names agents by role/domain ("Frontend", ` +
    `"Auth", "DevOps"). Each agent's RECENT activity disambiguates when names alone are ambiguous. If nothing ` +
    `matches well, still pick the CLOSEST agent and give it a low confidence.\n\n` +
    `Voice task (verbatim; may be Vietnamese — do NOT translate it): "${transcript}"\n\n` +
    `Agents:\n${lines}\n\n` +
    `Always pick exactly one agent id from the list above. Set confidence 0..1 for how good the fit is:\n` +
    `- 0.85+ when the name and/or recent activity clearly match\n` +
    `- ~0.6 when it's a reasonable but not certain match\n` +
    `- ~0.3 when nothing fits well but this is the closest agent.\n\n` +
    `Respond with ONLY a single JSON object, no prose, no markdown fence:\n` +
    `{"agentId":"<one id from the list>","confidence":<0..1>,"reason":"<max 12 words>"}`
  )
}

// Defensive parse: Haiku is told to emit bare JSON, but tolerate a stray code fence or surrounding prose by
// extracting the first {...} block. Validates the id against the machine and clamps confidence.
export function parseRouteOutput(raw: string, agents: RouterAgent[]): RouteDecision {
  const ids = new Set(agents.map((a) => a.id))
  // The router ALWAYS picks — there is no "no agent" outcome. If the model misbehaves (bad JSON, empty or
  // unknown id) we still resolve to the closest available agent (the first in the list) with a low, capped
  // confidence, so the backend always has a concrete agent to dispatch to. `needNewAgent` is retired
  // (always false); the field is kept only for wire-contract compatibility with the device/backend.
  const fallbackId = agents[0]?.id ?? ''
  const fallback: RouteDecision = { agentId: fallbackId, confidence: 0, reason: 'closest agent (parse failed)', needNewAgent: false }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return fallback
  }
  const agentId = typeof obj.agentId === 'string' ? obj.agentId : ''
  let confidence = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence)
  if (!Number.isFinite(confidence)) confidence = 0
  confidence = Math.max(0, Math.min(1, confidence))
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : ''
  // An empty or unknown id ⇒ fall back to the closest (first) agent with capped confidence; a valid
  // in-machine pick wins as-is. Either way we return a real agent and needNewAgent:false.
  if (!agentId || !ids.has(agentId)) return { agentId: fallbackId, confidence: Math.min(confidence, 0.3), reason: reason || 'closest agent', needNewAgent: false }
  return { agentId, confidence, reason, needNewAgent: false }
}

// Route a transcript to an agent. Skips the LLM for the trivial cases (0 / 1 agent).
export async function routeVoiceTask(transcript: string, agents: RouterAgent[], signal?: AbortSignal): Promise<RouteDecision> {
  // What the backend handed down, and what it may choose between. Logged before anything can fail, so a
  // route that times out still shows the task and the candidates it was weighing.
  console.log(
    `[voice-route] task "${taskPreview(transcript)}" · candidates=${agents.length}` +
    `${agents.length ? ` [${agents.map((agent) => `${agent.name}/${agent.engine ?? '?'}`).join(', ')}]` : ''}`,
  )
  if (agents.length === 0) {
    return logDecision('empty-machine', agents, { agentId: '', confidence: 0, reason: 'no agents in machine', needNewAgent: true })
  }
  if (agents.length === 1) {
    return logDecision('only-agent', agents, { agentId: agents[0].id, confidence: 1, reason: 'only agent in machine', needNewAgent: false })
  }

  // Decide from the agents in hand, falling back to whatever the registry sync last warmed (a caller that
  // does not label its agents). No usable engine → the heuristic, without burning a doomed spawn on every
  // voice.
  const engine = chooseRouterEngine(agents.filter((agent) => agent.engine).map((agent) => ({ engine: agent.engine as string }))) ?? routerEngine
  if (!engine) {
    console.log('[voice-route] no agent this router can run on → name matching')
    return logDecision('heuristic (no engine)', agents, pickAgentHeuristic(transcript, agents))
  }
  const model = routerModelFor(engine)
  const prompt = buildRouterPrompt(transcript, agents)
  ensureRouterConfigured(engine)   // so runRouterOneShot matches the pool config and uses the warm worker
  // BEFORE the call: on a timeout this is the only record of which CLI was asked.
  console.log(`[voice-route] classifying with ${engine} · model=${model || '(engine default)'}`)
  try {
    // Served from the warm router worker (no cold spawn). Cap under the backend's 15s nodeRequest budget so
    // a slow route surfaces before the RPC deadline.
    const options = { prompt, model, effort: 'low' as const, cwd: ensureRouteScratch(), signal, timeoutMs: 12_000 }
    const { text } = engine === 'grok'
      ? await runGrokOneShot(options)
      : await runRouterOneShot(engine, options)
    return logDecision(engine, agents, parseRouteOutput(text || '', agents))
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err   // caller cancelled — don't paper over it
    // The classifier timed out / spawn failed → NEVER fail the RPC. Fall back to a heuristic pick so the
    // voice still dispatches to a plausible agent instead of erroring out on the device.
    console.log(`[voice-route] ${engine} one-shot failed (${err instanceof Error ? err.message : String(err)}) → name matching`)
    return logDecision(`heuristic (${engine} failed)`, agents, pickAgentHeuristic(transcript, agents))
  }
}
