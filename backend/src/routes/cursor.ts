/**
 * Everything the Cursor desktop app calls, and nothing else.
 *
 *   POST /api/cursor/stt         `api_key` header, multipart file field `file` → { transcript, lang }
 *   POST /api/cursor/summarize   `api_key` header, JSON { prompt } → { text, model }
 *
 * DELIBERATELY SELF-CONTAINED. The device's voice path (firmware streams raw PCM over /api/device-ws,
 * deviceWs.ts hands it to lib/stt.ts) is untouched and unshared: this file owns its own Deepgram call,
 * its own LLM call, its own auth and its own multipart scope, so nothing here can regress that path
 * and nothing there constrains this one. The only imports are leaf utilities (env, logger, response,
 * sha256hex).
 *
 * Both routes are in the auth middleware's skip-list — NOT unauthenticated, they simply validate their
 * own shared secret rather than an SSO token, the same arrangement /api/analytics/report has with
 * machineAuth. One credential (CURSOR_STT_API_KEY) gates both: the app holds a single key.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import multipart from '@fastify/multipart'
import { timingSafeEqual } from 'crypto'
import { env } from '../config/env.js'
import { sha256hex } from '../utils/crypto.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { VOICE_WAV_LANGS, transcribeWavWithDeepgram } from '../lib/deepgramWav.js'

export const CURSOR_STT_PATH = '/api/cursor/stt'
export const CURSOR_SUMMARIZE_PATH = '/api/cursor/summarize'
export const CURSOR_ROUTE_PATH = '/api/cursor/route'


/** Most conversations one routing request may weigh. The device sends the ones it is showing, newest
 *  first; past this the prompt grows without the pick getting better. */
const MAX_ROUTE_AGENTS = 8

/** Per-agent recent-activity text. Enough for three turns' worth of gist, bounded so one chatty agent
 *  cannot crowd the others out of the prompt. */
const MAX_RECENT_CHARS = 600

/** ~25 MB — far above any dictation clip this serves, while still bounding one request's buffer. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Far above any dictation-sized prompt, but a bound: a looping client must not burn LLM credit. */
const MAX_PROMPT_CHARS = 100_000

/**
 * Generation can legitimately think for a while; without a deadline a stalled upstream pins a socket.
 *
 * Kept UNDER the gateway's own limit, deliberately. ingress-nginx cuts a proxied response at 60s
 * (`proxy_read_timeout`), so a 120s budget here could never be honoured: a slow relay produced a bare 504
 * with no body, and the client saw a generic failure instead of this service's answer. Measured during a
 * relay degradation — "Say OK" took 49s and a real routing call 504'd at 60.3s. Finishing first is what
 * lets the fallback below run at all.
 */
const LLM_TIMEOUT_MS = 45_000


/**
 * The LLM behind /api/cursor/summarize: an OpenAI-compatible endpoint, called with plain `fetch`.
 *
 * No `openai` SDK dependency — with a `base_url` that already ends in `/v1`, the SDK's
 * `chat.completions.create` is exactly this one POST, so pulling in a package to make it would buy
 * nothing and cost this file its self-containment.
 *
 * Base URL, key and model all come from env: the relay URL embeds a network id and the key is a
 * long-lived JWT, neither of which belongs in the repo.
 */
async function callLlm(prompt: string): Promise<{ text: string; model: string }> {
  const model = env.CURSOR_LLM_MODEL
  const res = await fetch(`${env.CURSOR_LLM_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CURSOR_LLM_API_KEY}`, 'Content-Type': 'application/json' },
    // The prompt goes up verbatim as the single user message — no system prompt, no wrapping. What the
    // app asks for is what the model sees, so changing the wording is a client-side change, not a deploy.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    model?: string
    choices?: Array<{ message?: { content?: string } }>
  }
  return { text: (data.choices?.[0]?.message?.content ?? '').trim(), model: data.model || model }
}

/**
 * Both endpoints' only credential: a shared secret in the `api_key` header.
 *
 * Fails CLOSED when CURSOR_STT_API_KEY is unset — an absent secret must never read as "no auth needed"
 * on routes that spend Deepgram and LLM credit. Both sides are hashed before comparison so
 * timingSafeEqual receives equal-length buffers: it throws on a length mismatch, and the real key's
 * length is itself something better not leaked through a distinguishable error.
 */
async function cursorAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = env.CURSOR_STT_API_KEY
  if (!expected) {
    logger.error('cursor: CURSOR_STT_API_KEY is not configured — refusing the request')
    sendError(reply, 'This endpoint is not configured', 'CURSOR_NOT_CONFIGURED', 503)
    return
  }
  // BOTH spellings, and the dashed one is the reason this works in production at all: ingress-nginx
  // defaults to `underscores_in_headers off`, which DROPS any header containing `_`. So `api_key` — the
  // name this endpoint was specified with — arrives when you call the service directly and silently
  // vanishes behind the ingress, surfacing as "Missing api key" for a request that did send it.
  // Measured, not guessed: on prod a dashed `x-api-key` reaches another route fine while `api_key` does
  // not, and locally (no proxy) `api_key` works. Keep both — `api_key` for direct/local callers,
  // `api-key` for anything crossing the ingress.
  const raw = req.headers['api_key'] ?? req.headers['api-key']
  const provided = Array.isArray(raw) ? raw[0] : raw
  if (typeof provided !== 'string' || !provided) {
    sendError(reply, 'Missing api key', 'UNAUTHORIZED', 401)
    return
  }
  const a = Buffer.from(sha256hex(provided), 'hex')
  const b = Buffer.from(sha256hex(expected), 'hex')
  if (!timingSafeEqual(a, b)) {
    sendError(reply, 'Invalid api key', 'UNAUTHORIZED', 401)
    return
  }
}

/**
 * Pin the language rather than auto-detect: on a short clip detection is worse than being told.
 *
 * Anything unrecognised falls back to 'vi' — this endpoint's callers are Vietnamese-first, and that was
 * the behaviour before the other five languages were accepted.
 */
function pickLang(value: unknown): string {
  const v = typeof value === 'string' ? value.toLowerCase() : ''
  return VOICE_WAV_LANGS.has(v) ? v : 'vi'
}


/**
 * One routing decision, parsed defensively.
 *
 * The model behind this endpoint is NOT the one the prompt was written for — the brain's router runs Haiku
 * through the Claude CLI, this runs whatever CURSOR_LLM_MODEL names (DeepSeek at the time of writing). So
 * "respond with only JSON" is a request, not a guarantee: a fenced block or a sentence of preamble is a
 * normal thing to get back, and the caller cannot act on either.
 */
function parseDecision(text: string, ids: Set<string>): { agentId: string; confidence: number; reason: string } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : text).trim()
  const brace = body.indexOf('{')
  const close = body.lastIndexOf('}')
  if (brace < 0 || close <= brace) return null
  let obj: unknown
  try {
    obj = JSON.parse(body.slice(brace, close + 1))
  } catch {
    return null
  }
  const o = obj as { agentId?: unknown; confidence?: unknown; reason?: unknown }
  const agentId = typeof o.agentId === 'string' ? o.agentId : ''
  // The id MUST be one we offered. A model that invents an id is not a low-confidence pick, it is a failed
  // request: routing to an id the caller does not have would put the words nowhere and report success.
  if (!ids.has(agentId)) return null
  const raw = typeof o.confidence === 'number' ? o.confidence : 0
  return {
    agentId,
    confidence: Math.max(0, Math.min(1, raw)),
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 120) : '',
  }
}

/**
 * Ported from machine-node/brain's prefrontal/voiceRouter.ts, which routes voice for BACKEND machines and
 * cannot serve this one: it runs inside a machine-node, and a cabled Cursor machine has no node. Same job,
 * same shape of answer, so the wording is kept close enough that the two can be compared — including the
 * instruction not to translate, which is what stops a Vietnamese task coming back as an English summary.
 */
function buildRoutePrompt(transcript: string, agents: Array<{ id: string; name: string; recent: string }>): string {
  const lines = agents
    .map((a) => `- id=${a.id} | name="${a.name}" | recent: ${a.recent.trim() || '(no activity yet)'}`)
    .join('\n')
  return (
    `You are a ROUTER. Assign ONE incoming voice task to the single best-fit conversation from the fixed ` +
    `list below. You MUST always choose exactly one id from the list — there is NO "none" option and you ` +
    `may NOT decline. The NAME is a strong signal. Each conversation's RECENT activity disambiguates when ` +
    `names alone are ambiguous. If nothing matches well, still pick the CLOSEST one and give it a low ` +
    `confidence.\n\n` +
    `Voice task (verbatim; may be Vietnamese — do NOT translate it): "${transcript}"\n\n` +
    `Conversations:\n${lines}\n\n` +
    `Set confidence 0..1 for how good the fit is:\n` +
    `- 0.85+ when the name and/or recent activity clearly match\n` +
    `- ~0.6 when it is a reasonable but not certain match\n` +
    `- ~0.3 when nothing fits well but this is the closest.\n\n` +
    `Respond with ONLY a single JSON object, no prose, no markdown fence:\n` +
    `{"agentId":"<one id from the list>","confidence":<0..1>,"reason":"<max 12 words>"}`
  )
}

export async function cursorRoutes(app: FastifyInstance): Promise<void> {
  // Registered inside this plugin's scope, not in server.ts: multipart parsing exists for the STT route
  // and nothing else, so no other endpoint's body handling changes by adding it. The JSON route below
  // is unaffected — Fastify still parses application/json normally.
  await app.register(multipart, { limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } })

  app.post(CURSOR_STT_PATH, { preHandler: [cursorAuth] }, async (req, reply) => {
    let file
    try {
      file = await req.file()
    } catch {
      sendError(reply, 'Expected a multipart/form-data upload', 'BAD_REQUEST', 400)
      return
    }
    if (!file) {
      sendError(reply, 'Missing audio file (multipart field "file")', 'NO_FILE', 400)
      return
    }

    // Oversize is NOT checked here. @fastify/multipart throws FST_REQ_FILE_TOO_LARGE past the limit and
    // the shared errorHandler already renders that as a 413 in the usual envelope. An explicit
    // `file.file.truncated` branch would be dead code — do not add one.
    const audio = await file.toBuffer()
    if (audio.length === 0) {
      sendError(reply, 'Audio file is empty', 'EMPTY_FILE', 400)
      return
    }

    // Language may ride the query string or the form; the query wins so a caller can override without
    // rebuilding the body. Form fields arrive as objects carrying `.value`, not bare strings.
    const formLang = file.fields?.lang
    const formLangValue = formLang && !Array.isArray(formLang) && 'value' in formLang ? formLang.value : undefined
    const lang = pickLang((req.query as { lang?: unknown } | undefined)?.lang ?? formLangValue)

    try {
      const transcript = await transcribeWavWithDeepgram(audio, file.mimetype || 'audio/wav', lang)
      logger.info('cursor-stt transcribe', { bytes: audio.length, mimetype: file.mimetype, lang, chars: transcript.length })
      sendSuccess(reply, { transcript, lang })
    } catch (err) {
      // Deepgram's message can name the upstream project/key, so it stays in the log and the caller gets
      // a plain 502 — this endpoint's one client cannot act on the detail anyway.
      logger.error('cursor-stt transcribe failed', { error: err instanceof Error ? err.message : String(err) })
      sendError(reply, 'Transcription failed', 'STT_FAILED', 502)
    }
  })

  app.post(CURSOR_SUMMARIZE_PATH, { preHandler: [cursorAuth] }, async (req, reply) => {
    // Same fail-closed rule as the shared secret: an unconfigured LLM is a 503, never a silent fallback.
    if (!env.CURSOR_LLM_BASE_URL || !env.CURSOR_LLM_API_KEY) {
      logger.error('cursor-summarize: CURSOR_LLM_BASE_URL/CURSOR_LLM_API_KEY not configured — refusing')
      sendError(reply, 'Summarization is not configured', 'LLM_NOT_CONFIGURED', 503)
      return
    }

    const prompt = (req.body as { prompt?: unknown } | undefined)?.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      sendError(reply, 'Missing prompt', 'BAD_REQUEST', 400)
      return
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      sendError(reply, `Prompt exceeds ${MAX_PROMPT_CHARS} characters`, 'PROMPT_TOO_LARGE', 400)
      return
    }

    try {
      const { text, model } = await callLlm(prompt)
      logger.info('cursor-summarize', { chars: prompt.length, outChars: text.length, model })
      sendSuccess(reply, { text, model })
    } catch (err) {
      // Same reasoning as the STT branch: the upstream message can name the relay network or the key,
      // so it stays in the log and the caller gets a plain 502.
      logger.error('cursor-summarize failed', { error: err instanceof Error ? err.message : String(err) })
      sendError(reply, 'Summarization failed', 'LLM_FAILED', 502)
    }
  })

  /**
   * Pick which Cursor conversation a spoken task belongs to.
   *
   * The cabled machine's Overview voice: the dial records, the Mac ships the audio to /stt above, then asks
   * here which of its open conversations should receive the words. The decision is a pure function of what
   * the caller sends — this endpoint holds no state and knows nothing about any machine.
   */
/**
 * Function words only. A preposition matching a name is noise wearing a signal's clothes — verbs and nouns
 * stay, because "research", "deploy" and "parser" are exactly what routing runs on. The last row is the
 * Vietnamese equivalents, which arrive unaccented from the tokenizer below.
 */
const ROUTE_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at',
  'about', 'with', 'from', 'into', 'over', 'under', 'up', 'down', 'out',
  'my', 'our', 'your', 'his', 'her', 'its', 'their', 'me', 'you', 'we',
  'it', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were',
  'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had', 'will',
  'would', 'can', 'could', 'should', 'please', 'what', 'when', 'where',
  'which', 'who', 'how', 'why',
  'agent', 'task', 'chat', 'new', 'cua', 'va', 'cho', 'voi',
])

/**
 * Fold to the alphabet the matcher works in: lowercase, unaccented, split on anything that is not a letter
 * or digit.
 *
 * Unaccented because a spoken "sửa parser" transcribed by an English recogniser arrives as "sua parser",
 * and a conversation named "Sửa parser" would otherwise never match itself. `đ` needs its own rule — NFD
 * does not decompose it, so stripping combining marks alone leaves "đăng" as "đang" and never as "dang".
 */
function routeTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !ROUTE_STOP.has(t))
}

/**
 * The name is worth far more than the history, and deliberately so: people name conversations by what they
 * are for, and say what they want done. Recent activity is a tie-breaker for names that do not settle it.
 * Normalised by the NAME's length, not the sentence's — matching both words of a two-word name is a strong
 * signal, and dividing by a long sentence would bury it.
 */
function scoreAgent(a: { name: string; recent: string }, said: Set<string>) {
  const name = new Set(routeTokens(a.name))
  const recent = new Set(routeTokens(a.recent))
  if (said.size === 0) return { score: 0, named: 0 }
  const hits = (set: Set<string>) => [...set].filter((t) => said.has(t)).length
  const nameHits = hits(name)
  const nameScore = name.size === 0 ? 0 : nameHits / name.size
  const recentScore = recent.size === 0 ? 0 : Math.min(hits(recent) / 3, 1)
  return { score: nameScore * 3 + recentScore, named: nameHits }
}

/**
 * Decide by counting words, and say when counting is not enough.
 *
 * A PORT of QuickDialKit/VoiceRouter.swift in autonomous-macroz, thresholds included — it was measured
 * against real misroutes there, and this endpoint answers the same question for the same device. The
 * reason it exists here rather than only in the model: an LLM call is a network dependency on every spoken
 * turn, and when the relay degrades (49s for "Say OK", measured) an unambiguous name match should not be
 * waiting on it at all.
 *
 * THE NAME OUTRANKS THE TOPIC. Saying words from exactly one conversation's name IS the decision, however
 * much another one's recent activity overlaps the subject: a name is chosen by the user, a topic history
 * accretes — and accretes fastest on whichever conversation earlier misroutes fed.
 */
function pickByScore(transcript: string, agents: Array<{ id: string; name: string; recent: string }>) {
  const said = new Set(routeTokens(transcript))
  const scored = agents.map((a) => ({ a, ...scoreAgent(a, said) }))

  // Several names said: they compete among THEMSELVES — a conversation matched only by topic does not
  // referee a contest between named ones.
  const named = scored.filter((s) => s.named > 0)
  if (named.length === 1) {
    const only = named[0]
    return { agentId: only.a.id, confidence: Math.max(0.8, Math.min(1, 0.6 + only.score / 6)),
             reason: 'only name said', ambiguous: false }
  }
  const pool = named.length > 1 ? named : scored
  const ranked = [...pool].sort((x, y) => y.score - x.score)
  const top = ranked[0]
  const gap = top.score - (ranked[1]?.score ?? 0)

  // Nothing scored at all: the words matched no name and no history, so there is nothing to be confident
  // about and the model gets it.
  if (top.score <= 0) return { agentId: top.a.id, confidence: 0, reason: 'nothing matched', ambiguous: true }
  // A clear winner both scores something AND leads the runner-up by half a name-word. Below that the two
  // are not distinguishable by counting words, which is the definition of a question for a model.
  if (gap >= 1.5) return { agentId: top.a.id, confidence: Math.min(1, 0.6 + gap / 6),
                           reason: 'name matched', ambiguous: false }
  return { agentId: top.a.id, confidence: 0.3 + gap / 5, reason: 'closest of several', ambiguous: true }
}

  app.post(CURSOR_ROUTE_PATH, { preHandler: [cursorAuth] }, async (req, reply) => {
    if (!env.CURSOR_LLM_BASE_URL || !env.CURSOR_LLM_API_KEY) {
      logger.error('cursor-route: CURSOR_LLM_BASE_URL/CURSOR_LLM_API_KEY not configured — refusing')
      sendError(reply, 'Routing is not configured', 'LLM_NOT_CONFIGURED', 503)
      return
    }

    const body = req.body as { transcript?: unknown; agents?: unknown } | undefined
    const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : ''
    if (!transcript) {
      sendError(reply, 'Missing transcript', 'BAD_REQUEST', 400)
      return
    }
    if (!Array.isArray(body?.agents) || body.agents.length === 0) {
      sendError(reply, 'Missing agents', 'BAD_REQUEST', 400)
      return
    }

    const agents = (body.agents as Array<Record<string, unknown>>)
      .map((a) => ({
        id: typeof a.id === 'string' ? a.id : '',
        name: typeof a.name === 'string' ? a.name : '',
        recent: typeof a.recent === 'string' ? a.recent.slice(0, MAX_RECENT_CHARS) : '',
      }))
      .filter((a) => a.id && a.name)
      .slice(0, MAX_ROUTE_AGENTS)
    if (agents.length === 0) {
      sendError(reply, 'No usable agents', 'BAD_REQUEST', 400)
      return
    }

    // One conversation is not a decision. Answering it locally saves a call, and more importantly it means
    // the single-agent case cannot fail for a reason that has nothing to do with the user.
    if (agents.length === 1) {
      sendSuccess(reply, { agentId: agents[0].id, confidence: 1, reason: 'only conversation' })
      return
    }

    // Count words first. Most spoken turns name the conversation they are about, and for those the model
    // adds latency and a failure mode without adding an answer.
    const scored = pickByScore(transcript, agents)
    if (!scored.ambiguous) {
      logger.info('cursor-route: by score', { agents: agents.length, chars: transcript.length, reason: scored.reason })
      sendSuccess(reply, { agentId: scored.agentId, confidence: scored.confidence, reason: scored.reason })
      return
    }

    try {
      const { text, model } = await callLlm(buildRoutePrompt(transcript, agents))
      const decision = parseDecision(text, new Set(agents.map((a) => a.id)))
      if (!decision) {
        logger.error('cursor-route: unusable answer', { model, sample: text.slice(0, 200) })
        sendError(reply, 'Routing failed', 'ROUTE_FAILED', 502)
        return
      }
      logger.info('cursor-route', { agents: agents.length, chars: transcript.length, model, confidence: decision.confidence })
      sendSuccess(reply, decision)
    } catch (err) {
      // The model was the TIE-BREAKER, not the router. When it cannot answer, the scored pick is still the
      // best information available, and returning it beats throwing away words the user has already spoken
      // — the device's alternative is an apology and a lost turn.
      //
      // Only when something actually matched, though: `nothing matched` means the words hit no name and no
      // history, and delivering that to an arbitrary conversation is worse than saying so.
      logger.error('cursor-route failed', { error: err instanceof Error ? err.message : String(err) })
      if (scored.confidence > 0) {
        logger.warn('cursor-route: falling back to the scored pick', { reason: scored.reason })
        sendSuccess(reply, { agentId: scored.agentId, confidence: scored.confidence,
                             reason: `${scored.reason} (model unavailable)` })
        return
      }
      sendError(reply, 'Routing failed', 'ROUTE_FAILED', 502)
    }
  })
}
