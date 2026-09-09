// Voice router (adapter side, for REMOTE machines) — self-contained port of the the hosted runtime's
// Given a transcribed voice task and this machine's agents (name + a
// short summary of each agent's recent turn), pick the single best-fit agent. Uses the same key-free CLI
// one-shot path as the turn summarizer, using a small/fast model where the engine exposes one. Name
// is the strongest signal (users name agents by role/domain); recent activity disambiguates.
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'
import { runGrokOneShot, runRouterOneShot, configureRouterOneShot, setRouterOneShotDeviceConnected, shutdownRouterOneShot } from './oneshot.js'
import { openRouterComplete, resolveOpenRouterKey } from './openrouter.js'

export interface RouterAgent {
  id: string
  name: string
  /** The CLI this agent runs on. It is what decides which engine classifies the route — see
   *  chooseRouterEngine — so the decision is made from the very list being routed over. */
  engine?: string
  /** 'ori' when this agent's CLI is pointed at OpenRouter — see the direct-call path in routeVoiceTask. */
  gateway?: 'ori' | null
  /** Recaps of the agent's last few completed turns (up to 3), joined — a broader, less skewed picture
   *  of what it's working on than a single turn. */
  recentSummary?: string
  /** The machine it runs on. The candidate list spans every machine the owner has, so this is the only
   *  thing that separates two agents with the same name on two computers — and it is how a spoken "the
   *  one on the mac mini" can be answered at all. */
  machine?: string

}

export interface RouteDecision {
  agentId: string
  confidence: number
  reason: string
  needNewAgent: boolean
  /** How this was decided, as logDecision labels it: an engine name, 'openrouter', or something
   *  starting with 'heuristic'. Carried on the decision — not just printed — because a caller that SHOWS
   *  the answer has to say which it is. A model that was unsure and a router that could not run land on
   *  the same low confidence by design, and without this they are indistinguishable on screen. */
  via?: string
  /** The runners-up and how well each fits, most confident first, never including the winner.
   *
   *  Only ever DISPLAYED. Nothing dispatches on these: the winner is [agentId] and the number that
   *  gates auto-dispatch is [confidence]. They exist so a window that has to ask "which agent" can show
   *  whether it is a near-tie or a clear leader instead of three names in a row. */
  scores?: Array<{ agentId: string; confidence: number }>
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
  if (!existsSync(ROUTE_SCRATCH)) mkdirSync(ROUTE_SCRATCH, { recursive: true, mode: 0o700 })
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
/**
 * Words that carry no topic, in the two languages this router actually sees.
 *
 * Written after watching the fallback pick "Worldcup dc to chuc may lan roi" for "Chiến tranh thế giới
 * thứ nhất kết thúc vào năm nào?" — on this desk, with a real dial. Not one of the eight agents matched
 * by NAME, so the entire ranking came from words like `the` (thế), `gioi`, `nam` and `nao` appearing in
 * someone's recent activity. Function words are the most common tokens in any sentence, so without this
 * they dominate every comparison and the score measures sentence length rather than fit.
 *
 * Diacritics are already stripped when this is consulted, so the Vietnamese entries are written the way
 * routeTokens leaves them — and `the` covers both "thế" and the English article.
 */
const ROUTE_STOP_WORDS = new Set([
  // Vietnamese function words
  'la', 'co', 'cua', 'cho', 'den', 'tu', 'mot', 'nao', 'vao', 'nay', 'do', 'khi', 'thi', 'ma', 'ra',
  'len', 'xuong', 'nhung', 'hay', 'hoac', 'duoc', 'bi', 'se', 'da', 'dang', 'roi', 'chua', 'khong',
  'gi', 'sao', 'tai', 've', 'voi', 'boi', 'neu', 'vi', 'nen', 'cung', 'van', 'chi', 'moi', 'rat',
  'qua', 'cai', 'nhu', 'the', 'thu', 'con', 'de', 'trong', 'ngoai', 'tren', 'duoi', 'hon', 'nua',
  // English function words
  'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it',
  'this', 'that', 'what', 'how', 'when', 'why', 'who', 'an', 'as', 'by', 'from', 'me', 'my', 'you',
  'your', 'we', 'us', 'do', 'does', 'did', 'can', 'will', 'would', 'should', 'about',
])

function routeTokens(s: string): string[] {
  const norm = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase()
  return norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !ROUTE_STOP_WORDS.has(t))
}

// Fallback when the LLM router is unavailable (timed out / spawn failed): score each agent by how many
// transcript words appear in its NAME (strong signal) and recent activity (weak), and pick the best. Always
// returns a concrete in-machine agent with a low, capped confidence — the voice still dispatches, never errors.
export function pickAgentHeuristic(
  transcript: string,
  agents: RouterAgent[],
  continuity?: RouterContinuity,
): RouteDecision {
  const words = new Set(routeTokens(transcript))
  // Only while the conversation is plausibly still going. An id that is no longer on the list scores
  // nothing by construction — nobody is matched against it.
  const stillTalking = continuity && continuity.agoMs <= CONTINUITY_WINDOW_MS ? continuity.agentId : ''
  const ranked = agents
    .map((agent) => {
      const nameHits = routeTokens(agent.name).filter((t) => words.has(t)).length
      const recentHits = routeTokens(agent.recentSummary ?? '').filter((t) => words.has(t)).length
      const carried = agent.id === stillTalking ? CONTINUITY_SCORE : 0
      return { agent, score: nameHits * 3 + recentHits + carried }
    })
    // STABLE on a tie, and that matters more than it looks: with no match at all every score is 0, and
    // the winner has to stay "the first agent" — the same answer this function has always given — rather
    // than whatever a sort happened to bubble up.
    .sort((a, b) => b.score - a.score)
  const best = ranked[0]
  const matched = (best?.score ?? 0) > 0
  const winner = matched ? 0.4 : 0.2
  return {
    agentId: best?.agent.id ?? agents[0]?.id ?? '',
    // UNCHANGED, and deliberately so: the dial and the backend gate auto-dispatch on this number, and
    // the cap at 0.4 is what keeps a router that could not run from ever dispatching on its own.
    confidence: winner,
    reason: matched ? 'heuristic name/recent match' : 'closest agent (router unavailable)',
    needNewAgent: false,
    // Scaled UNDER the winner rather than invented: a name matcher can say "this one beat the others",
    // and that is all these say. They are for a picker to draw a bar with, never for a threshold.
    // The same handful the model is asked for, so a route that fell back to name matching draws the
    // same number of bars as one that did not — the picker must not look different depending on which
    // half of the router answered.
    scores: ranked.slice(1, ROUTE_SCORED_ROWS).map((entry) => ({
      agentId: entry.agent.id,
      confidence: best && best.score > 0
        ? Math.max(0.05, Math.min(winner - 0.05, (entry.score / best.score) * winner))
        : 0.1,
    })),
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
  decision = { ...decision, via }
  const chosen = agents.find((agent) => agent.id === decision.agentId)
  console.log(
    `[voice-route] → picked "${chosen?.name ?? '(unknown)'}" id=${decision.agentId || '(none)'}` +
    ` · confidence=${decision.confidence.toFixed(2)} · via=${via}` +
    `${decision.reason ? ` · "${decision.reason}"` : ''}`,
  )
  return decision
}

export function buildRouterPrompt(
  transcript: string,
  agents: RouterAgent[],
  continuity?: RouterContinuity,
): string {
  const lines = agents
    .map((a) => `- id=${a.id} | name="${a.name}"${a.machine ? ` | machine="${a.machine}"` : ''} | recently asked: ${a.recentSummary?.trim() || '(no activity yet)'}`)

    .join('\n')
  // Stated as a FACT with its age, not as an instruction to follow it. A follow-up usually belongs to
  // the same agent; a new subject spoken thirty seconds later does not, and only the model can tell
  // those apart. Omitted entirely once the window has passed, so a stale id never sits in the prompt
  // looking current.
  const carry = continuity && continuity.agoMs <= CONTINUITY_WINDOW_MS
    ? `Continuity: this person sent their previous task to agent id=${continuity.agentId} ` +
      `${Math.max(1, Math.round(continuity.agoMs / 1000))}s ago. A follow-up question — a pronoun, a ` +
      `comparison, or the same subject asked a second way — usually belongs to that same agent. A task ` +
      `about a plainly different subject does not.\n\n`
    : ''
  return (
    `You are a ROUTER. Assign ONE incoming voice task to the single best-fit agent from the fixed list ` +
    `below. You MUST always choose exactly one agent from the list — there is NO "none" option and you may ` +
    `NOT decline.\n\n` +
    `How to read an agent: its NAME is a strong signal, but it is not always a role. Some people name ` +
    `agents by domain ("Frontend", "Auth", "DevOps"); others leave the name as the FIRST THING THEY ASKED ` +
    `it, so a name like "Worldcup dc to chuc may lan roi" means that agent's conversation is about the ` +
    `World Cup. Read both kinds as the agent's subject. "recently asked" lists what this person asked ` +
    `that agent lately, newest first — the surest sign of what its conversation is about. If nothing ` +
    `matches well, still pick the CLOSEST agent and give it a low confidence.\n\n` +
    `Voice task (verbatim; may be Vietnamese — do NOT translate it): "${transcript}"\n\n` +
    carry +
    `Agents:\n${lines}\n\n` +
    `Always pick exactly one agent id from the list above. Set confidence 0..1 for how good the fit is:\n` +
    `- 0.85+ when the name and/or recent activity clearly match\n` +
    `- ~0.6 when it's a reasonable but not certain match\n` +
    `- ~0.3 when nothing fits well but this is the closest agent.\n\n` +
    `Also rank the next best fits in "alternates" (up to ${ROUTE_SCORED_ROWS - 1}, most fitting first, ` +
    `never repeating your pick). They are shown to the user when your confidence is low, so they can ` +
    `choose; they are never dispatched to on their own — and the agent a person actually wants is often ` +
    `the one you ranked fourth, so rank that far even when the first two look obvious. Omit the field ` +
    `when there is no other agent.\n\n` +
    `Respond with ONLY a single JSON object, no prose, no markdown fence:\n` +
    `{"agentId":"<one id from the list>","confidence":<0..1>,"reason":"<max 12 words>",` +
    `"alternates":[{"agentId":"<id>","confidence":<0..1>}]}`
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
  // Alternates are optional and unvalidated on the way in: an id that is not on the list, a repeat of the
  // winner, or a confidence that is not a number is DROPPED rather than corrected. A picker drawing a bar
  // for an agent the machine does not have is worse than a picker drawing no bar.
  const seen = new Set<string>()
  const scores: Array<{ agentId: string; confidence: number }> = []
  if (Array.isArray(obj.alternates)) {
    for (const raw of obj.alternates) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const id = typeof entry.agentId === 'string' ? entry.agentId : ''
      if (!id || !ids.has(id) || id === agentId || seen.has(id)) continue
      const value = typeof entry.confidence === 'number' ? entry.confidence : Number(entry.confidence)
      if (!Number.isFinite(value)) continue
      seen.add(id)
      scores.push({ agentId: id, confidence: Math.max(0, Math.min(1, value)) })
      // Bounded by the same constant the prompt asks with, so a model that over-answers cannot quietly
      // widen what the picker draws. `ids` and `seen` bound it to the candidate list, once each.
      if (scores.length >= ROUTE_SCORED_ROWS - 1) break
    }
  }
  // An empty or unknown id ⇒ fall back to the closest (first) agent with capped confidence; a valid
  // in-machine pick wins as-is. Either way we return a real agent and needNewAgent:false.
  if (!agentId || !ids.has(agentId)) return { agentId: fallbackId, confidence: Math.min(confidence, 0.3), reason: reason || 'closest agent', needNewAgent: false, scores }
  return { agentId, confidence, reason, needNewAgent: false, scores }
}

// Route a transcript to an agent. Skips the LLM for the trivial cases (0 / 1 agent).
/**
 * How long the classifier gets before the name matcher answers instead.
 *
 * 12s is what every caller had, and it was chosen to stay under a backend RPC deadline that no longer
 * carries this: the dial routes over the cable now, straight to this daemon. Callers that are not under
 * someone else's clock can therefore ask for more — and a caller that IS should not be given it, because
 * overshooting their deadline turns a fallback answer into no answer at all.
 */
/**
 * How many rows in the picker carry a number.
 *
 * The pick plus four. The picker lists EVERY agent that was weighed — that part is not capped — but the
 * router is only asked to rank the top handful, and the rest are simply drawn without a bar. Three was
 * too few to be useful (the right agent is often the fourth); every one of fifteen makes the classifier
 * write a long answer on a path that already times out often enough to matter. Five is the compromise,
 * and an unscored row is honest: it says the router did not rank this one, not that it rejected it.
 *
 * Read by all three places that used to cap independently — the prompt, the parse, and the name matcher
 * — because they drifted apart once already and the symptom (three bars over a list of eight) took a
 * person noticing it on screen to find.
 */
export const ROUTE_SCORED_ROWS = 5

/**
 * Who this person was last talking to, for a router deciding where a follow-up belongs.
 *
 * The single strongest signal there is for a second question, and the one nothing else could supply:
 * "Chiến tranh thế giới thứ nhất kết thúc vào năm nào?" names no agent, matches no name, and belongs
 * beyond reasonable doubt to whichever agent just answered the same question about the second world war
 * nineteen seconds earlier.
 */
export interface RouterContinuity {
  agentId: string
  /** Milliseconds since that turn was sent. */
  agoMs: number
}

/**
 * How recently counts as "still the same conversation".
 *
 * Five minutes. Long enough to cover thinking, reading the answer and asking the next thing; short
 * enough that the agent you used before lunch does not quietly win an unrelated afternoon question.
 */
export const CONTINUITY_WINDOW_MS = 5 * 60_000

/** What continuity is worth to the fallback matcher: one name hit. Enough to break a tie and to beat
 *  incidental word overlap, not enough to outrank an agent the words actually describe. */
const CONTINUITY_SCORE = 3

export const ROUTE_CLASSIFY_MS = 12_000

export async function routeVoiceTask(
  transcript: string,
  agents: RouterAgent[],
  signal?: AbortSignal,
  timeoutMs: number = ROUTE_CLASSIFY_MS,
  continuity?: RouterContinuity,
): Promise<RouteDecision> {
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

  const prompt = buildRouterPrompt(transcript, agents, continuity)

  // ONE DIRECT API CALL WHENEVER THERE IS A KEY TO MAKE IT WITH — not only on machines running gateway
  // agents, which is all this used to cover.
  //
  // The engine path below classifies by spawning the vendor CLI. Measured on this desk:
  // `claude --print --model haiku "Reply with only the word OK"` took 75 seconds; the router's own
  // stripped, pre-warmed spawn still takes about 15 against a 20-second ceiling, and a third of them
  // time out. That is not a prompt problem and no wording fixes it — it is a whole agent runtime
  // starting up to answer a twenty-word classification. A direct call answers in about one.
  //
  // Still a fallthrough, not a replacement: no key, no model, or no usable answer and the engine path
  // runs exactly as before. Machines without a credential are unaffected.
  if (env.ORI_VOICE_ROUTE_MODEL) {
    const apiKey = await resolveOpenRouterKey()
    if (apiKey) {
      console.log(`[voice-route] classifying with openrouter · model=${env.ORI_VOICE_ROUTE_MODEL}`)
      const text = await openRouterComplete({
        prompt, model: env.ORI_VOICE_ROUTE_MODEL, apiKey, signal, timeoutMs, maxTokens: 256,
      })
      if (text) return logDecision('openrouter', agents, parseRouteOutput(text, agents))
      console.log('[voice-route] openrouter classification unavailable → engine one-shot')
    }
  }

  // Decide from the agents in hand, falling back to whatever the registry sync last warmed (a caller that
  // does not label its agents). No usable engine → the heuristic, without burning a doomed spawn on every
  // voice.
  const engine = chooseRouterEngine(agents.filter((agent) => agent.engine).map((agent) => ({ engine: agent.engine as string }))) ?? routerEngine
  if (!engine) {
    console.log('[voice-route] no agent this router can run on → name matching')
    return logDecision('heuristic (no engine)', agents, pickAgentHeuristic(transcript, agents, continuity))
  }
  const model = routerModelFor(engine)
  ensureRouterConfigured(engine)   // so runRouterOneShot matches the pool config and uses the warm worker
  // BEFORE the call: on a timeout this is the only record of which CLI was asked.
  console.log(`[voice-route] classifying with ${engine} · model=${model || '(engine default)'} · budget=${timeoutMs}ms · prompt=${prompt.length}c`)
  try {
    // Served from the warm router worker (no cold spawn). The budget is the CALLER's — see
    // ROUTE_CLASSIFY_MS for why it is no longer one number for everyone.
    const options = { prompt, model, effort: 'low' as const, cwd: ensureRouteScratch(), signal, timeoutMs }
    const { text } = engine === 'grok'
      ? await runGrokOneShot(options)
      : await runRouterOneShot(engine, options)
    return logDecision(engine, agents, parseRouteOutput(text || '', agents))
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err   // caller cancelled — don't paper over it
    // The classifier timed out / spawn failed → NEVER fail the RPC. Fall back to a heuristic pick so the
    // voice still dispatches to a plausible agent instead of erroring out on the device.
    console.log(`[voice-route] ${engine} one-shot failed (${err instanceof Error ? err.message : String(err)}) → name matching`)
    return logDecision(`heuristic (${engine} failed)`, agents, pickAgentHeuristic(transcript, agents, continuity))
  }
}
