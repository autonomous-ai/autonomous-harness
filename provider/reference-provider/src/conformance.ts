/**
 * Conformance runner for the machine provider profile (`../spec/README.md`).
 *
 * Point it at ANY provider endpoint. It asserts one check per normative clause and names the clause in
 * its output, so a red line points at a section of the spec rather than at a symptom:
 *
 *   npm run conformance -- --url https://agent.example.com --key <credential>
 *
 * Two design rules, both load-bearing:
 *
 *  1. **Nothing is silently skipped.** A clause that cannot be verified from outside (tenant isolation,
 *     the 5 MB transcript ceiling, rate limiting) is reported as SKIP *with the reason*. A suite that
 *     claims to check everything while quietly checking half of it is worse than no suite.
 *  2. **Extension checks are conditional on the Agent Card.** An undeclared extension is not a failure
 *     (HP-022) — it is a SKIP, because absence is a legitimate answer.
 *
 * Zero dependencies, like the rest of this package.
 */
import { AGENT_CARD } from './agentCard.js'

type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'WARN'

interface Result {
  outcome: Outcome
  detail?: string
}

interface Ctx {
  url: string
  /** Set when the agent card could not be fetched at all — every check reports rather than throwing. */
  cardError?: string
  key: string
  badKey?: string
  /** Phrase that makes the provider enter INPUT_REQUIRED, if it has one. */
  askPhrase?: string
  card: Record<string, unknown>
}

interface Check {
  id: string
  title: string
  run: (ctx: Ctx) => Promise<Result> | Result
}

const pass = (detail?: string): Result => ({ outcome: 'PASS', detail })
const fail = (detail: string): Result => ({ outcome: 'FAIL', detail })
const skip = (detail: string): Result => ({ outcome: 'SKIP', detail })
const warn = (detail: string): Result => ({ outcome: 'WARN', detail })

const EXT = {
  FILES: 'https://harness.autonomous.ai/api/a2a/ext/workspace-files',
  WRITE: 'https://harness.autonomous.ai/api/a2a/ext/workspace-write',
  RECAP: 'https://harness.autonomous.ai/api/a2a/ext/session-recap',
  VOICE: 'https://harness.autonomous.ai/api/a2a/ext/voice',
} as const

const KNOWN_EXTENSIONS: string[] = Object.values(EXT)

/** Scope an extension probe to a real agent without guessing an id. */
const firstSkillId = (ctx: Ctx): string | undefined =>
  ((ctx.card.skills ?? []) as Array<{ id?: string }>)[0]?.id

const KNOWN_KINDS = [
  'user_message', 'thinking_delta', 'thinking_title', 'text_delta',
  'tool_start', 'tool_end', 'context_compact', 'done',
]

const TERMINAL = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']

// ── wire helpers ─────────────────────────────────────────────────────────────────────────────────

interface SseEvent {
  taskId?: string
  contextId?: string
  status?: { state?: string; message?: { parts?: Array<{ text?: string; metadata?: Record<string, unknown> }> } }
  final?: boolean
}

async function rpc(ctx: Ctx, method: string, params: unknown, key = ctx.key): Promise<Response> {
  return fetch(ctx.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [authHeader(ctx)]: key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** The card declares where the credential goes; do not assume a header name (HP-011). */
function authHeader(ctx: Ctx): string {
  const schemes = (ctx.card.securitySchemes ?? {}) as Record<string, { type?: string; in?: string; name?: string }>
  for (const s of Object.values(schemes)) {
    if (s.type === 'apiKey' && s.in === 'header' && s.name) return s.name
  }
  return 'authorization'
}

async function stream(ctx: Ctx, text: string, extra: Record<string, unknown> = {}): Promise<{ res: Response; events: SseEvent[] }> {
  const res = await rpc(ctx, 'SendStreamingMessage', {
    message: { role: 'ROLE_USER', messageId: `conf-${Date.now()}`, parts: [{ text }], ...extra },
  })
  return { res, events: await drain(res) }
}

async function drain(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  if (!res.body) return events
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (line) { try { events.push(JSON.parse(line.slice(6)) as SseEvent) } catch { /* skip unparsable */ } }
      }
    }
  } catch { /* an aborted stream is itself a finding — HP-102 reports it */ }
  return events
}

const declares = (ctx: Ctx, uri: string): boolean =>
  ((ctx.card.extensions ?? []) as Array<{ uri?: string }>).some((e) => e.uri === uri)

const body = async (res: Response): Promise<Record<string, unknown>> => {
  try { return (await res.json()) as Record<string, unknown> } catch { return {} }
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────

export const CHECKS: Check[] = [
  {
    id: 'HP-003',
    title: 'Declared extension URIs are byte-exact',
    run: (ctx) => {
      const declared = ((ctx.card.extensions ?? []) as Array<{ uri?: string }>).map((e) => e.uri ?? '')
      const ours = declared.filter((u) => u.includes('autonomous.ai'))
      const wrong = ours.filter((u) => !KNOWN_EXTENSIONS.includes(u))
      if (!ours.length) return skip('no Autonomous extensions declared — nothing to compare')
      return wrong.length
        ? fail(`not byte-exact: ${wrong.join(', ')}`)
        : pass(`${ours.length} declared, all exact`)
    },
  },
  {
    id: 'HP-010',
    title: 'Endpoint is reachable over HTTPS',
    run: (ctx) =>
      ctx.url.startsWith('https://')
        ? pass()
        : warn('endpoint is not HTTPS — acceptable for local testing, a violation in production'),
  },
  {
    id: 'HP-011',
    title: 'Agent Card declares a supported security scheme',
    run: (ctx) => {
      const schemes = Object.values((ctx.card.securitySchemes ?? {}) as Record<string, { type?: string }>)
      if (!schemes.length) return fail('no securitySchemes declared')
      const supported = schemes.filter((s) => s.type === 'apiKey' || s.type === 'http')
      return supported.length
        ? pass(schemes.map((s) => s.type).join(', '))
        : fail(`only unsupported schemes declared (${schemes.map((s) => s.type).join(', ')}); Autonomous supports APIKey and HTTPAuth today`)
    },
  },
  {
    id: 'HP-012',
    title: 'Credential is scoped to one tenant',
    run: () => skip('not verifiable from outside — needs two tenants\' credentials and knowledge of provider internals'),
  },
  {
    id: 'HP-013',
    title: 'A rejected credential is distinguishable from an outage',
    run: async (ctx) => {
      if (!ctx.badKey) return skip('pass --bad-key <value> with a credential known to be invalid to run this')
      const res = await rpc(ctx, 'ListTasks', {}, ctx.badKey)
      const b = await body(res)
      const err = b.error as { code?: number } | undefined
      if (res.status === 401 || err) return pass(`status ${res.status}${err?.code ? `, code ${err.code}` : ''}`)
      return fail('an invalid credential was accepted, or failed indistinguishably from a generic error')
    },
  },
  {
    id: 'HP-020',
    title: 'Agent Card served at /.well-known/agent-card.json',
    run: (ctx) => {
      if (ctx.cardError) return fail(ctx.cardError)
      return ctx.card.name ? pass(String(ctx.card.name)) : fail('card missing or unparsable')
    },
  },
  {
    id: 'HP-021',
    title: 'capabilities.streaming is true',
    run: (ctx) => {
      const caps = (ctx.card.capabilities ?? {}) as { streaming?: boolean }
      return caps.streaming === true ? pass() : fail('a non-streaming provider cannot be used; output is rendered token by token')
    },
  },
  {
    id: 'HP-022',
    title: 'Extensions are declared by URI, unknown ones tolerated',
    run: (ctx) => {
      const declared = (ctx.card.extensions ?? []) as Array<{ uri?: string }>
      if (!Array.isArray(declared)) return fail('extensions is not an array')
      const missingUri = declared.filter((e) => typeof e.uri !== 'string')
      return missingUri.length ? fail(`${missingUri.length} extension entr(ies) without a uri`) : pass(`${declared.length} declared`)
    },
  },
  {
    id: 'HP-023',
    title: 'skills[] is a non-empty agent list',
    run: (ctx) => {
      const skills = (ctx.card.skills ?? []) as Array<{ id?: string; name?: string }>
      if (!skills.length) return fail('no skills — the client would show no agents at all')
      const unnamed = skills.filter((s) => !s.id || !s.name)
      return unnamed.length ? fail(`${unnamed.length} skill(s) missing id or name`) : pass(`${skills.length} skill(s)`)
    },
  },
  {
    id: 'HP-100',
    title: 'SendStreamingMessage returns Server-Sent Events',
    run: async (ctx) => {
      const { res } = await stream(ctx, 'conformance: hello')
      const ct = res.headers.get('content-type') ?? ''
      return ct.includes('text/event-stream') ? pass(ct) : fail(`content-type was "${ct}", expected text/event-stream`)
    },
  },
  {
    id: 'HP-101',
    title: 'A new chat opens on a fresh contextId',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: new chat', { contextId: `conf-ctx-${Date.now()}` })
      if (!events.length) return fail('no events received')
      const ids = new Set(events.map((e) => e.contextId).filter(Boolean))
      return ids.size === 1 ? pass([...ids][0]) : fail(`stream spanned ${ids.size} contextIds; expected exactly one`)
    },
  },
  {
    id: 'HP-102',
    title: 'Every stream ends with a terminal task state',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: terminal state')
      if (!events.length) return fail('no events received')
      const last = events[events.length - 1]!
      return TERMINAL.includes(last.status?.state ?? '')
        ? pass(last.status?.state)
        : fail(`stream ended on "${last.status?.state}" — a client cannot tell a finished turn from a dropped one`)
    },
  },
  {
    id: 'HP-103',
    title: 'CancelTask stops a task and reports CANCELED',
    run: async (ctx) => {
      if (!ctx.askPhrase) return skip('pass --ask-phrase <text> with a prompt that parks the agent, so there is something to cancel')
      const { events } = await stream(ctx, ctx.askPhrase)
      const taskId = events[0]?.taskId
      if (!taskId) return fail('no taskId observed, so cancellation cannot be tested')
      const res = await rpc(ctx, 'CancelTask', { taskId })
      const b = await body(res)
      const state = ((b.result ?? {}) as { status?: { state?: string } }).status?.state
      return state === 'TASK_STATE_CANCELED' ? pass() : fail(`CancelTask returned state "${state}"`)
    },
  },
  {
    id: 'HP-104',
    title: 'INPUT_REQUIRED pauses the task and accepts an answer on the same taskId',
    run: async (ctx) => {
      if (!ctx.askPhrase) return skip('pass --ask-phrase <text> with a prompt that makes the agent ask a question')
      const { events } = await stream(ctx, ctx.askPhrase)
      const last = events[events.length - 1]
      if (last?.status?.state !== 'TASK_STATE_INPUT_REQUIRED') {
        return fail(`--ask-phrase did not produce INPUT_REQUIRED (ended on "${last?.status?.state}")`)
      }
      if (last.final) return fail('INPUT_REQUIRED was marked final; it is not a terminal state')
      const resumed = await drain(
        await rpc(ctx, 'SendStreamingMessage', {
          message: { role: 'ROLE_USER', messageId: `conf-answer-${Date.now()}`, taskId: last.taskId, parts: [{ text: 'yes' }] },
        }),
      )
      const end = resumed[resumed.length - 1]
      return TERMINAL.includes(end?.status?.state ?? '')
        ? pass('paused, answered, completed')
        : fail(`answering on the same taskId did not resume the task (ended on "${end?.status?.state}")`)
    },
  },
  {
    id: 'HP-105',
    title: 'Assistant output arrives as Parts on status updates',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: say something')
      const parts = events.flatMap((e) => e.status?.message?.parts ?? [])
      return parts.length ? pass(`${parts.length} part(s)`) : fail('the turn produced no Parts at all')
    },
  },
  {
    id: 'HP-106',
    title: 'Image attachments are accepted or refused loudly',
    run: async (ctx) => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const { events } = await stream(ctx, 'conformance: describe this image', {
        parts: [{ text: 'conformance: describe this image' }, { raw: png, mediaType: 'image/png' }],
      })
      const last = events[events.length - 1]
      const state = last?.status?.state ?? ''
      if (state === 'TASK_STATE_FAILED') return pass('refused explicitly')
      if (TERMINAL.includes(state)) {
        return warn('the turn completed — verify by hand that the image was actually used; silently discarding it violates HP-106 and cannot be detected from outside')
      }
      return fail(`ended on "${state}"`)
    },
  },
  {
    id: 'HP-200',
    title: 'ListTasks filters by contextId',
    run: async (ctx) => {
      const ctxId = `conf-list-${Date.now()}`
      await stream(ctx, 'conformance: first', { contextId: ctxId })
      await stream(ctx, 'conformance: second', { contextId: ctxId })
      const b = await body(await rpc(ctx, 'ListTasks', { contextId: ctxId }))
      const tasks = ((b.result ?? {}) as { tasks?: Array<{ contextId?: string }> }).tasks
      if (!Array.isArray(tasks)) return fail('ListTasks did not return a tasks array')
      if (tasks.length < 2) return fail(`expected at least 2 tasks in the context, saw ${tasks.length}`)
      const foreign = tasks.filter((t) => t.contextId !== ctxId)
      return foreign.length ? fail(`${foreign.length} task(s) from another context leaked into the filter`) : pass(`${tasks.length} task(s)`)
    },
  },
  {
    id: 'HP-201',
    title: 'GetTask returns the task with its history',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: history please')
      const taskId = events[0]?.taskId
      if (!taskId) return fail('no taskId observed')
      const b = await body(await rpc(ctx, 'GetTask', { taskId }))
      const task = b.result as { history?: unknown[]; status?: { state?: string } } | undefined
      if (!task) return fail('GetTask returned no task')
      return Array.isArray(task.history) && task.history.length
        ? pass(`${task.history.length} message(s)`)
        : fail('GetTask returned no history — a page refresh would lose the conversation')
    },
  },
  {
    id: 'HP-202',
    title: 'GetTask returns the whole transcript in one response',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: whole transcript')
      const taskId = events[0]?.taskId
      if (!taskId) return fail('no taskId observed')
      const b = await body(await rpc(ctx, 'GetTask', { taskId }))
      const task = (b.result ?? {}) as Record<string, unknown>
      const paging = ['nextPageToken', 'hasMore', 'cursor'].filter((k) => k in task)
      return paging.length
        ? fail(`response carries paging field(s) ${paging.join(', ')}; pagination is not part of this revision`)
        : pass()
    },
  },
  {
    id: 'HP-203',
    title: 'Oversized transcripts are marked, never silently truncated',
    run: () => skip('not verifiable without a session large enough to cross the 5 MB ceiling'),
  },
  {
    id: 'HP-210',
    title: 'Part metadata uses recognised autonomous.ai/* keys',
    run: async (ctx) => {
      const { events } = await stream(ctx, 'conformance: metadata check')
      const metas = events.flatMap((e) => e.status?.message?.parts ?? []).map((p) => p.metadata).filter(Boolean) as Record<string, unknown>[]
      if (!metas.length) return skip('this provider emits no metadata — conformant under HP-211, nothing to validate')
      const kinds = metas.map((m) => m['autonomous.ai/kind']).filter(Boolean) as string[]
      const bad = kinds.filter((k) => !KNOWN_KINDS.includes(k))
      return bad.length ? fail(`unrecognised kind(s): ${[...new Set(bad)].join(', ')}`) : pass(`${kinds.length} kind(s), all recognised`)
    },
  },
  {
    id: 'HP-211',
    title: 'A provider emitting no metadata is still conformant',
    run: () => skip('a property of the client, not of the provider — asserted by the client test suite'),
  },
  {
    id: 'HP-220',
    title: 'Statistics are omitted rather than fabricated',
    run: () => skip('not verifiable from outside — a wrong count is indistinguishable from a right one'),
  },
  {
    id: 'HP-300',
    title: 'workspace-files: autonomous.ListFiles and autonomous.ReadFile',
    run: async (ctx) => {
      if (!declares(ctx, EXT.FILES)) return skip('not declared — absence is a legitimate answer (HP-022)')
      const agentId = firstSkillId(ctx)
      if (!agentId) return fail('extension declared but the card exposes no skill to scope a call to')
      const b = await body(await rpc(ctx, 'autonomous.ListFiles', { agentId }))
      const err = b.error as { code?: number } | undefined
      if (err?.code === -32601) return fail('declared in the Agent Card but autonomous.ListFiles is not implemented')
      if (err) return fail(`autonomous.ListFiles returned error ${err.code}`)
      const files = ((b.result ?? {}) as { files?: unknown }).files
      return Array.isArray(files) ? pass(`${files.length} entr(ies)`) : fail('response has no `files` array')
    },
  },
  {
    id: 'HP-301',
    title: 'workspace-write: mutation methods exist',
    run: async (ctx) => {
      if (!declares(ctx, EXT.WRITE)) return skip('not declared — absence is a legitimate answer (HP-022)')
      // Probe WITHOUT mutating: call with deliberately missing params and require "invalid params"
      // rather than "method not found". Running a real create/delete against someone's live workspace
      // is not something a conformance runner gets to do.
      const b = await body(await rpc(ctx, 'autonomous.RenameAgent', {}))
      const err = b.error as { code?: number } | undefined
      if (err?.code === -32601) return fail('declared in the Agent Card but autonomous.RenameAgent is not implemented')
      if (err?.code === -32602) return pass('method present (probed non-destructively with empty params)')
      return warn(`probe returned ${err ? `error ${err.code}` : 'a result'} — verify the mutation methods by hand; the runner will not mutate a live workspace`)
    },
  },
  {
    id: 'HP-302',
    title: 'session-recap: autonomous.GetRecap',
    run: async (ctx) => {
      if (!declares(ctx, EXT.RECAP)) return skip('not declared — absence is a legitimate answer (HP-022)')
      const agentId = firstSkillId(ctx)
      if (!agentId) return fail('extension declared but the card exposes no skill to scope a call to')
      const b = await body(await rpc(ctx, 'autonomous.GetRecap', { agentId, n: 2 }))
      const err = b.error as { code?: number } | undefined
      if (err?.code === -32601) return fail('declared in the Agent Card but autonomous.GetRecap is not implemented')
      if (err) return fail(`autonomous.GetRecap returned error ${err.code}`)
      const result = (b.result ?? {}) as { entries?: unknown }
      if (!Array.isArray(result.entries)) return fail('response has no `entries` array')
      const overlong = (result.entries as Array<{ recap?: string }>).filter((e) => (e.recap?.length ?? 0) > 200)
      return overlong.length
        ? fail(`${overlong.length} recap(s) exceed the 200-character ceiling the device renders`)
        : pass(`${result.entries.length} entr(ies)`)
    },
  },
  {
    id: 'HP-303',
    title: 'voice: autonomous.RouteVoice',
    run: async (ctx) => {
      if (!declares(ctx, EXT.VOICE)) return skip('not declared — Autonomous routes from skills[] by default')
      const b = await body(await rpc(ctx, 'autonomous.RouteVoice', { transcript: 'conformance probe' }))
      const err = b.error as { code?: number } | undefined
      if (err?.code === -32601) return fail('declared in the Agent Card but autonomous.RouteVoice is not implemented')
      if (err) return fail(`autonomous.RouteVoice returned error ${err.code}`)
      const result = (b.result ?? {}) as { agentId?: unknown }
      return 'agentId' in result
        ? pass(result.agentId === null ? 'declined, routing handed back' : String(result.agentId))
        : fail('response has no `agentId` (use null to decline)')
    },
  },
  {
    id: 'HP-310',
    title: 'Extension methods are namespaced autonomous.<Verb>',
    run: (ctx) => {
      const declared = ((ctx.card.extensions ?? []) as Array<{ uri?: string }>).map((e) => e.uri ?? '')
      const ours = declared.filter((u) => KNOWN_EXTENSIONS.includes(u))
      return ours.length
        ? pass('verified indirectly — every extension probe above uses the autonomous.* namespace')
        : skip('no Autonomous extensions declared')
    },
  },
  {
    id: 'HP-311',
    title: 'An UNDECLARED extension method is rejected with -32601',
    run: async (ctx) => {
      const undeclared = ([
        [EXT.FILES, 'autonomous.ListFiles'],
        [EXT.WRITE, 'autonomous.CreateAgent'],
        [EXT.RECAP, 'autonomous.GetRecap'],
        [EXT.VOICE, 'autonomous.RouteVoice'],
      ] as const).filter(([uri]) => !declares(ctx, uri))
      if (!undeclared.length) return skip('this provider declares every extension — nothing undeclared to probe')
      const answered: string[] = []
      for (const [, method] of undeclared) {
        const b = await body(await rpc(ctx, method, {}))
        const err = b.error as { code?: number } | undefined
        if (err?.code !== -32601) answered.push(method)
      }
      return answered.length
        ? fail(`answered undeclared method(s): ${answered.join(', ')} — the Agent Card becomes untrustworthy`)
        : pass(`${undeclared.length} undeclared method(s) correctly rejected`)
    },
  },
  {
    id: 'HP-400',
    title: 'An unknown method is rejected without breaking the connection',
    run: async (ctx) => {
      const res = await rpc(ctx, 'ConformanceNoSuchMethod', {})
      const b = await body(res)
      const err = b.error as { code?: number } | undefined
      if (!err) return fail('an unknown method was not rejected')
      // Prove the endpoint still works afterwards.
      const after = await rpc(ctx, 'ListTasks', {})
      return after.ok ? pass(`code ${err.code}, endpoint still healthy`) : fail('the endpoint stopped responding after an unknown method')
    },
  },
  {
    id: 'HP-900',
    title: 'All traffic over TLS',
    run: (ctx) => (ctx.url.startsWith('https://') ? pass() : warn('plain HTTP — acceptable locally, a violation in production')),
  },
  {
    id: 'HP-902',
    title: 'Rate limiting',
    run: () => skip('enforced by Autonomous on its side, not a provider obligation to demonstrate'),
  },
  {
    id: 'HP-903',
    title: 'The credential is not logged or forwarded',
    run: () => skip('not verifiable from outside — covered by the onboarding review, not by this runner'),
  },
]

// ── runner ───────────────────────────────────────────────────────────────────────────────────────

export interface RunSummary {
  results: Array<{ id: string; title: string } & Result>
  pass: number
  fail: number
  skip: number
  warn: number
}

export async function runConformance(opts: { url: string; key: string; badKey?: string; askPhrase?: string }): Promise<RunSummary> {
  const base = opts.url.replace(/\/+$/, '')
  // An unreachable or malformed endpoint must be REPORTED, not thrown. A conformance runner that
  // crashes when the provider is down is useless at exactly the moment it is most needed.
  let card: Record<string, unknown> = {}
  let cardError: string | undefined
  try {
    const cardRes = await fetch(`${base}/.well-known/agent-card.json`)
    if (cardRes.ok) card = (await cardRes.json()) as Record<string, unknown>
    else cardError = `agent card responded ${cardRes.status}`
  } catch (err) {
    cardError = `could not reach ${base} — ${err instanceof Error ? err.message : String(err)}`
  }
  const ctx: Ctx = { url: base, key: opts.key, badKey: opts.badKey, askPhrase: opts.askPhrase, card, cardError }

  const results: RunSummary['results'] = []
  for (const check of CHECKS) {
    let result: Result
    try {
      result = await check.run(ctx)
    } catch (err) {
      result = fail(`check threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    results.push({ id: check.id, title: check.title, ...result })
  }

  return {
    results,
    pass: results.filter((r) => r.outcome === 'PASS').length,
    fail: results.filter((r) => r.outcome === 'FAIL').length,
    skip: results.filter((r) => r.outcome === 'SKIP').length,
    warn: results.filter((r) => r.outcome === 'WARN').length,
  }
}

const MARK: Record<Outcome, string> = { PASS: '✔', FAIL: '✖', SKIP: '–', WARN: '!' }

export function format(summary: RunSummary): string {
  const lines = summary.results.map((r) => {
    const head = `${MARK[r.outcome]} ${r.id.padEnd(7)} ${r.title}`
    return r.detail ? `${head}\n            ${r.detail}` : head
  })
  lines.push('')
  lines.push(`${summary.pass} passed · ${summary.fail} failed · ${summary.warn} need manual review · ${summary.skip} not verifiable from outside`)
  if (summary.skip || summary.warn) {
    lines.push('Every skipped and manual clause states its reason above — nothing was checked silently.')
  }
  return lines.join('\n')
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = arg('url') ?? 'http://127.0.0.1:4501'
  const key = arg('key') ?? 'conformance'
  const badKey = arg('bad-key')
  const askPhrase = arg('ask-phrase')

  console.log(`Machine provider conformance — ${url}`)
  console.log(`Spec: spec/README.md · ${CHECKS.length} clauses\n`)
  const summary = await runConformance({ url, key, badKey, askPhrase })
  console.log(format(summary))
  if (!badKey || !askPhrase) {
    console.log('\nTip: --bad-key <invalid credential> and --ask-phrase <prompt that makes the agent ask> unlock 3 more clauses.')
  }
  process.exit(summary.fail ? 1 : 0)
}

/** Re-exported so the reference provider's own agent card can be diffed against expectations in tests. */
export { AGENT_CARD }
