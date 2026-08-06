/**
 * Conformance runner for the Autonomous machine provider protocol (`../../spec/README.md`).
 *
 * Point it at ANY provider endpoint:
 *
 *   npm run conformance -- --url https://agent.example.com --key <credential>
 *
 * Two design rules, both load-bearing:
 *
 *  1. **Nothing is silently skipped.** A rule that cannot be verified from outside (tenant isolation,
 *     truncation, rate limiting) is reported as SKIP *with the reason*. A suite that claims to check
 *     everything while quietly checking half of it is worse than no suite.
 *  2. **Every check has a stable `id` slug** — `terminal-frame`, `credential-rejected`,
 *     `history-matches-stream`. The slug is what the tests match on; the title is what a partner
 *     reads. Rewording a title must never break the suite that proves the suite works.
 *
 * Zero dependencies, like the rest of this package.
 */
type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'WARN'

interface Result {
  outcome: Outcome
  detail?: string
}

interface Ctx {
  url: string
  key: string
  badKey?: string
  /** Phrase that makes the provider ask the user something, if it has one. */
  askPhrase?: string
  /** Resolved once, so every check addresses a real agent instead of guessing an id. */
  agentId?: string
  /** Set when the endpoint could not be reached at all — every check reports rather than throwing. */
  unreachable?: string
  /** Every event kind seen anywhere in this run, for the vocabulary check at the end. */
  seenKinds: Set<string>
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

/** The published vocabulary. A kind outside it is ignored by clients, never fatal. */
const CONTENT_KINDS = [
  'user_message', 'thinking_delta', 'thinking_title', 'text_delta', 'tool_start', 'tool_end',
  'context_compact', 'done', 'recap_start', 'recap_end',
]
const TERMINAL_KINDS = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required']
const ALL_KINDS = ['turn_started', ...CONTENT_KINDS, ...TERMINAL_KINDS]

// ── wire helpers ─────────────────────────────────────────────────────────────────────────────────

interface Event { kind?: string; [field: string]: unknown }

let turnSeq = 0
/** The CLIENT mints these, which is what makes an early cancel possible at all. */
const mintTurnId = (): string => `conf-${Date.now()}-${++turnSeq}`

/**
 * One header, fixed by convention. There is no discovery document to ask where the credential goes —
 * `Authorization: Bearer` is near-universal, and the alternative was a whole unauthenticated round
 * trip whose only job was to say "use this header".
 */
const authHeaders = (key: string): Record<string, string> =>
  ({ 'content-type': 'application/json', authorization: `Bearer ${key}` })

async function rpc(ctx: Ctx, method: string, params: unknown, key = ctx.key): Promise<Response> {
  return fetch(ctx.url, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

const body = async (res: Response): Promise<Record<string, unknown>> => {
  try { return (await res.json()) as Record<string, unknown> } catch { return {} }
}

const errorCode = async (res: Response): Promise<string | undefined> => {
  const b = await body(res)
  const err = b.error as { code?: unknown } | undefined
  return typeof err?.code === 'string' ? err.code : undefined
}

async function send(
  ctx: Ctx,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ res: Response; events: Event[]; turnId: string }> {
  const turnId = typeof extra.turnId === 'string' ? extra.turnId : mintTurnId()
  const res = await rpc(ctx, 'agent.send', {
    agentId: ctx.agentId, turnId, message: { text }, ...extra,
  })
  return { res, events: await drain(ctx, res), turnId }
}

async function drain(ctx: Ctx, res: Response): Promise<Event[]> {
  const events: Event[] = []
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
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(5).trim()) as Event
          if (typeof event.kind === 'string') ctx.seenKinds.add(event.kind)
          events.push(event)
        } catch { /* skip unparsable */ }
      }
    }
  } catch { /* an aborted stream is itself a finding — `terminal-frame` reports it */ }
  return events
}

const terminals = (events: Event[]): Event[] => events.filter((e) => TERMINAL_KINDS.includes(e.kind ?? ''))

/** Content events only — what both the stream and `agent.history` are expected to agree on. */
const NON_TRANSCRIPT = new Set(['turn_started', 'recap_start', 'recap_end', 'done'])
const content = (events: Event[]): Event[] =>
  events.filter((e) => !TERMINAL_KINDS.includes(e.kind ?? '') && !NON_TRANSCRIPT.has(e.kind ?? ''))

/**
 * Merge adjacent same-kind deltas, concatenating their text.
 *
 * `history-matches-stream` compares a stream against a transcript, and deltas are a STREAMING detail:
 * a live turn emits `text_delta "Acme is at "` then `text_delta "118% of pace."`, while a provider
 * reading its own stored transcript legitimately has one complete message. Comparing raw would fail
 * every delta-streaming provider for doing exactly what streaming means. Coalescing first compares
 * what the user actually ends up seeing.
 */
export function coalesceDeltas(events: Event[]): Event[] {
  const out: Event[] = []
  for (const event of events) {
    const prev = out.at(-1)
    const mergeable = event.kind === 'text_delta' || event.kind === 'thinking_delta'
    if (prev && mergeable && prev.kind === event.kind) {
      out[out.length - 1] = { ...prev, text: `${prev.text ?? ''}${event.text ?? ''}` }
      continue
    }
    out.push(event)
  }
  return out
}

const down = (ctx: Ctx): Result | null => (ctx.unreachable ? fail(ctx.unreachable) : null)
const noAgent = (ctx: Ctx): Result | null =>
  (ctx.agentId ? null : fail('no agent to address — `agent-list` must pass first'))

// ── checks ───────────────────────────────────────────────────────────────────────────────────────

export const CHECKS: Check[] = [
  // ── Transport and authentication ───────────────────────────────────────────────────────────────
  {
    id: 'reachable',
    title: 'The endpoint answers JSON-RPC at a single URL',
    run: (ctx) => down(ctx) ?? pass(ctx.url),
  },
  {
    id: 'https',
    title: 'The endpoint is HTTPS at a stable, publicly resolvable URL',
    run: (ctx) => {
      if (ctx.url.startsWith('https://')) return pass()
      if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(ctx.url)) {
        return warn('plain HTTP on loopback — fine for this run, but production MUST be HTTPS')
      }
      return fail(`not HTTPS: ${ctx.url}`)
    },
  },
  {
    id: 'credential-rejected',
    title: 'A rejected credential answers `unauthenticated`, never a generic failure',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      if (!ctx.badKey) return skip('pass --bad-key <deliberately invalid credential> to check this')
      const res = await rpc(ctx, 'agent.list', {}, ctx.badKey)
      const code = await errorCode(res)
      if (code === 'unauthenticated') return pass()
      if (res.ok && !code) return fail('a bad credential was ACCEPTED')
      return fail(`answered ${code ?? `HTTP ${res.status}`} — the product cannot then tell "wrong credential" from "provider down"`)
    },
  },
  {
    id: 'tenant-isolation',
    title: 'The credential is scoped to exactly one tenant',
    run: () => skip('not verifiable from outside — needs a second tenant\'s credential and a manual check that neither can see the other'),
  },

  // ── Agents ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'agent-list',
    title: 'agent.list returns at least one well-formed agent',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.list', {})
      const result = (await body(res)).result as { agents?: unknown } | undefined
      const agents = result?.agents
      if (!Array.isArray(agents)) return fail('no `agents` array in the result')
      if (!agents.length) return fail('empty list — a provider with no agent concept MUST return exactly one entry for the whole workspace; an empty list reads to the user as a broken machine')
      const bad = agents.filter((a) => {
        const agent = a as { id?: unknown; name?: unknown }
        return typeof agent?.id !== 'string' || !agent.id || typeof agent?.name !== 'string' || !agent.name
      })
      return bad.length ? fail(`${bad.length} agent(s) missing a string id or name`) : pass(`${agents.length} agent(s)`)
    },
  },
  {
    id: 'agent-list-authenticated',
    title: 'agent.list REJECTS a bad credential rather than returning an empty list',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      if (!ctx.badKey) return skip('pass --bad-key to check this')
      const res = await rpc(ctx, 'agent.list', {}, ctx.badKey)
      const code = await errorCode(res)
      if (code === 'unauthenticated') return pass()
      const agents = ((await body(res)).result as { agents?: unknown } | undefined)?.agents
      if (Array.isArray(agents)) {
        return fail('an invalid credential got a list back — an empty one reads to the user as "you have no agents" instead of "your credential is wrong"')
      }
      return fail(`answered ${code ?? `HTTP ${res.status}`}, expected \`unauthenticated\``)
    },
  },
  {
    id: 'agent-mutations',
    title: 'agent.create / rename / delete either work or refuse with a reason',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      // There is no capability to declare, so a provider whose agents live in its own product is
      // conformant — it answers `invalid_request` with a message the UI shows the user, which beats a
      // greyed-out button with no explanation. What is NOT conformant is silence or `unsupported`.
      //
      // An EMPTY name is the probe on purpose: a conformant provider refuses it, so the usual outcome
      // is that nothing is created. This runner is pointed at LIVE endpoints with real credentials,
      // and must not leave anything behind in somebody's tenant.
      const res = await rpc(ctx, 'agent.create', { name: '' })
      const b = await body(res)
      const err = b.error as { code?: string; message?: string } | undefined
      if (err?.code === 'unsupported') {
        return fail('agent.create answered `unsupported` — refuse with `invalid_request` and a message the user can act on instead')
      }
      if (err?.code === 'invalid_request') {
        return err.message
          ? pass(`refuses with a reason: "${err.message}"`)
          : warn('refuses, but carries no message — the UI then shows a failure with nothing to explain it')
      }
      if (b.result === undefined) return fail(`answered ${err?.code ?? `HTTP ${res.status}`}`)

      // It accepted the empty name, so an agent now exists that nobody asked for. Remove it before
      // reporting: a conformance run that quietly adds rows to a partner's product is not a test, it
      // is a side effect.
      const created = (b.result as { id?: unknown }).id
      if (typeof created !== 'string' || !created) {
        return warn('an EMPTY name was accepted and the response carried no id, so the agent it created CANNOT be cleaned up — delete it by hand')
      }
      const cleanup = await errorCode(await rpc(ctx, 'agent.delete', { agentId: created }))
      return cleanup
        ? fail(`an empty name was accepted as agent "${created}", and deleting it answered ${cleanup} — that agent is now orphaned in this tenant`)
        : warn(`an EMPTY name was accepted; the agent it created ("${created}") was deleted again. Mutations are reachable but the validation is loose`)
    },
  },
  {
    id: 'unknown-method',
    title: 'An unknown method is refused with `unsupported`',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.nonexistentMethod', {})
      const code = await errorCode(res)
      return code === 'unsupported'
        ? pass()
        : fail(`an invented method answered ${code ?? `HTTP ${res.status}`}, expected \`unsupported\``)
    },
  },

  // ── Sending a turn ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'streams-sse',
    title: 'agent.send streams Server-Sent Events',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.send', { agentId: ctx.agentId, turnId: mintTurnId(), message: { text: 'hello' } })
      const type = res.headers.get('content-type') ?? ''
      if (!type.includes('text/event-stream')) {
        void res.body?.cancel()
        return fail(`content-type is "${type}" — a non-streaming provider is unusable, the product renders output as it arrives`)
      }
      const events = await drain(ctx, res)
      return events.length ? pass(`${events.length} event(s)`) : fail('stream carried no events')
    },
  },
  {
    id: 'terminal-frame',
    title: 'Every stream ends with EXACTLY ONE terminal event',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const { events } = await send(ctx, 'hello')
      const ends = terminals(events)
      if (ends.length === 1) {
        return events.at(-1)?.kind === ends[0]!.kind
          ? pass(ends[0]!.kind)
          : fail(`terminal event ${ends[0]!.kind} was not last — ${events.at(-1)?.kind} followed it`)
      }
      return ends.length === 0
        ? fail('stream ended with NO terminal event — clients must treat the turn as failed and the user sees a spinner that never resolves')
        : fail(`${ends.length} terminal events: ${ends.map((e) => e.kind).join(', ')}`)
    },
  },
  {
    id: 'cancel-supported',
    title: 'turn.cancel is implemented',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      const res = await rpc(ctx, 'turn.cancel', { turnId: mintTurnId() })
      const b = await body(res)
      const code = (b.error as { code?: unknown } | undefined)?.code
      if (code === 'unsupported') return fail('turn.cancel is required — a user with no way to stop a runaway turn is the failure this exists for')
      return b.result !== undefined ? pass() : fail(`answered ${typeof code === 'string' ? code : `HTTP ${res.status}`}`)
    },
  },
  {
    id: 'early-cancel',
    title: 'A client-minted turnId is honoured — cancel BEFORE the turn starts stops it',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      // The whole reason the client mints the id: a user who presses stop in the first 200ms has
      // something to name. A provider that mints its own cannot satisfy this.
      const turnId = mintTurnId()
      await rpc(ctx, 'turn.cancel', { turnId })
      const { events } = await send(ctx, 'hello', { turnId })
      const ends = terminals(events)
      if (ends.length === 1 && ends[0]!.kind === 'turn_cancelled') return pass()
      return fail(`a turn cancelled before it began ended as ${ends[0]?.kind ?? 'nothing'} — the API accepted the cancel and the engine ignored it`)
    },
  },
  {
    id: 'input-required',
    title: 'A question to the user pauses the turn and resumes on the same turnId',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      if (!ctx.askPhrase) return skip('pass --ask-phrase "<prompt that makes the agent ask>" to check this')
      const missing = noAgent(ctx); if (missing) return missing
      const first = await send(ctx, ctx.askPhrase)
      const paused = terminals(first.events)[0]
      if (paused?.kind !== 'turn_input_required') {
        return fail(`expected turn_input_required, got ${paused?.kind ?? 'no terminal event'}`)
      }
      if (typeof paused.prompt !== 'string' || !paused.prompt) return fail('turn_input_required carried no prompt to show the user')
      const resumed = await send(ctx, 'the answer', { turnId: first.turnId, resume: true })
      const end = terminals(resumed.events)[0]
      return end && end.kind !== 'turn_input_required'
        ? pass(`resumed and ended as ${end.kind}`)
        : fail('resuming the same turnId did not continue the turn')
    },
  },
  {
    id: 'attachments',
    title: 'Image attachments are accepted, or the turn fails loudly',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const res = await rpc(ctx, 'agent.send', {
        agentId: ctx.agentId,
        turnId: mintTurnId(),
        message: { text: 'what is this?', attachments: [{ mediaType: 'image/png', data: png }] },
      })
      if (!res.headers.get('content-type')?.includes('text/event-stream')) {
        void res.body?.cancel()
        return fail('an attachment made the provider refuse to stream at all')
      }
      const ends = terminals(await drain(ctx, res))
      if (!ends.length) return fail('no terminal event')
      return warn(`turn ended as ${ends[0]!.kind}. Whether the image was READ or silently discarded cannot be seen from outside — confirm by hand that a provider which cannot accept images fails the turn instead of ignoring them`)
    },
  },

  // ── History ────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'history',
    title: 'agent.history returns the agent transcript',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.history', { agentId: ctx.agentId })
      const events = ((await body(res)).result as { events?: unknown } | undefined)?.events
      return Array.isArray(events)
        ? pass(`${events.length} event(s)`)
        : fail('no `events` array — Autonomous stores no transcript for a provider machine, so a page refresh loses the conversation without this')
    },
  },
  {
    id: 'history-matches-stream',
    title: 'History returns the SAME event objects the stream emitted',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const { events } = await send(ctx, 'a distinctive conformance probe')
      const live = content(events)
      if (!live.length) return skip('the turn emitted no content events to compare')

      const res = await rpc(ctx, 'agent.history', { agentId: ctx.agentId })
      const stored = ((await body(res)).result as { events?: Event[] } | undefined)?.events ?? []
      // Deltas are coalesced on BOTH sides first — see `coalesceDeltas`.
      const wanted = coalesceDeltas(live)
      const got = coalesceDeltas(content(stored)).slice(-wanted.length)
      return JSON.stringify(got) === JSON.stringify(wanted)
        ? pass(`${wanted.length} event(s) match`)
        : fail(`history and the live stream disagree — one shape and one mapper is what stops "what you saw" and "what you see after a refresh" from drifting.\n             live:    ${JSON.stringify(wanted)}\n             history: ${JSON.stringify(got)}`)
    },
  },
  {
    id: 'history-paging',
    title: 'History windows with limit/before and hands back a cursor',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const all = ((await body(await rpc(ctx, 'agent.history', { agentId: ctx.agentId }))).result as { events?: Event[] })?.events ?? []
      if (all.length < 2) return skip(`only ${all.length} event(s) in the transcript — send a few turns first`)

      const first = (await body(await rpc(ctx, 'agent.history', { agentId: ctx.agentId, limit: 1 }))).result as
        { events?: Event[]; nextBefore?: unknown } | undefined
      if ((first?.events ?? []).length !== 1) return fail(`limit: 1 returned ${(first?.events ?? []).length} events`)
      if (typeof first?.nextBefore !== 'string') {
        return fail('no `nextBefore` although older events exist — the client cannot page and simply stops')
      }
      const older = (await body(await rpc(ctx, 'agent.history', { agentId: ctx.agentId, limit: 1, before: first.nextBefore }))).result as
        { events?: Event[] } | undefined
      const olderEvents = older?.events ?? []
      if (!olderEvents.length) return fail('paging with the returned cursor came back empty')
      return JSON.stringify(olderEvents[0]) === JSON.stringify(first.events?.[0])
        ? fail('the cursor returned the SAME event again — paging would never terminate')
        : pass()
    },
  },
  {
    id: 'transcript-truncation',
    title: 'An oversized transcript is marked, not silently truncated',
    run: () => skip('not verifiable from outside — needs a transcript past the ceiling; confirm by hand that `truncated: true` appears rather than the tail simply going missing'),
  },

  // ── The event vocabulary ───────────────────────────────────────────────────────────────────────
  {
    id: 'event-kinds',
    title: 'Every event kind emitted is one this protocol defines',
    run: (ctx) => {
      const found = down(ctx); if (found) return found
      if (!ctx.seenKinds.size) return fail('no kinds seen at all across the whole run')
      const unknown = [...ctx.seenKinds].filter((k) => !ALL_KINDS.includes(k))
      const covered = ALL_KINDS.filter((k) => ctx.seenKinds.has(k))
      // Emitting only SOME kinds is correct — a provider that never uses tools never emits tool events.
      // Whether all fourteen are reachable at all is asserted in the e2e suite, which can drive a
      // provider it controls; from outside, an un-emitted kind is indistinguishable from an unused one.
      if (unknown.length) {
        return warn(`unrecognised, and therefore ignored by clients: ${unknown.join(', ')}. Covered ${covered.length}/${ALL_KINDS.length}`)
      }
      return pass(`${covered.length}/${ALL_KINDS.length} kinds exercised: ${covered.join(', ')}`)
    },
  },
  {
    id: 'bare-text',
    title: 'An event with no `kind` is conformant and renders as plain text',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const { events } = await send(ctx, 'plain')
      const bare = events.find((e) => e.kind === undefined && typeof e.text === 'string')
      return bare
        ? pass('provider emitted a bare {text} event')
        : skip('this provider always sets `kind`, which is allowed — a bare {text} event is a permission, not an obligation. Autonomous accepts either')
    },
  },
  {
    id: 'tool-pairing',
    title: 'tool_start and tool_end carry a toolId and pair up',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const { events } = await send(ctx, 'hello')
      const tools = events.filter((e) => e.kind === 'tool_start' || e.kind === 'tool_end')
      if (!tools.length) return skip('this turn used no tools')
      const missing = tools.filter((e) => typeof e.toolId !== 'string' || !e.toolId)
      if (missing.length) return fail(`${missing.length} tool event(s) without a toolId — an unpaired call renders as a row that never resolves`)
      const starts = tools.filter((e) => e.kind === 'tool_start').map((e) => e.toolId)
      const unique = new Set(starts)
      return unique.size === starts.length
        ? pass(`${starts.length} tool call(s)`)
        : fail('a toolId was reused within one turn — tools can overlap, so ids must be unique')
    },
  },
  {
    id: 'recap',
    title: 'agent.recap returns the agent’s last recap, or nothing',
    run: async (ctx) => {
      const found = down(ctx) ?? noAgent(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.recap', { agentId: ctx.agentId })
      const b = await body(res)
      const code = (b.error as { code?: unknown } | undefined)?.code
      if (code === 'unsupported') {
        return fail('agent.recap answered `unsupported` — a provider that summarises nothing answers with no `recap`, and Autonomous then excerpts the turn itself')
      }
      const result = b.result as { recap?: unknown; text?: unknown; turnId?: unknown } | undefined
      if (!result || typeof result !== 'object') return fail('no result object')
      // ABSENT is a legitimate answer, not a failure — the same convention `recap_end` uses.
      if (result.recap === undefined) return pass('nothing summarised yet — Autonomous derives a recap from the turn text instead')
      if (typeof result.recap !== 'string' || !result.recap.trim()) {
        return fail('`recap` is present but not a usable headline — the device renders it on a tile, and a blank one is worse than none')
      }
      if (result.text !== undefined && typeof result.text !== 'string') return fail('`text` is present but not a string')
      return typeof result.turnId === 'string'
        ? pass(`"${result.recap}"`)
        : warn('carries no turnId — a client asking the instant a turn ends can then receive the PREVIOUS turn\'s summary with no way to tell')
    },
  },
  {
    id: 'no-fabricated-stats',
    title: 'Statistics are omitted rather than fabricated',
    run: () => skip('not verifiable from outside — a plausible number and a true one look identical. Confirm by hand that counts and timestamps nobody recorded are absent rather than guessed'),
  },

  // ── Forward compatibility and operations ───────────────────────────────────────────────────────
  {
    id: 'unknown-fields',
    title: 'Unrecognised request fields are ignored, not fatal',
    run: async (ctx) => {
      const found = down(ctx); if (found) return found
      const res = await rpc(ctx, 'agent.list', { somethingFromALaterRevision: true, nested: { x: 1 } })
      const b = await body(res)
      return b.result !== undefined
        ? pass()
        : fail('an unknown field broke the call — a client on a newer revision would then fail against you entirely')
    },
  },
  {
    id: 'rate-limiting',
    title: 'Rate limiting per machine',
    run: () => skip('not verifiable without flooding a real endpoint, which a conformance run must not do'),
  },
  {
    id: 'credential-not-logged',
    title: 'The credential is not logged or forwarded',
    run: () => skip('not verifiable from outside — needs a code and log review at the provider'),
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
  const ctx: Ctx = {
    url: opts.url.replace(/\/+$/, ''),
    key: opts.key,
    badKey: opts.badKey,
    askPhrase: opts.askPhrase,
    seenKinds: new Set(),
  }

  // Resolve one real agent up front, so no check has to guess an id. An unreachable or malformed
  // endpoint must be REPORTED, not thrown: a runner that crashes when the provider is down is useless
  // at exactly the moment it is most needed.
  try {
    const b = await body(await rpc(ctx, 'agent.list', {}))
    const id = (b.result as { agents?: Array<{ id?: unknown }> } | undefined)?.agents?.[0]?.id
    if (typeof id === 'string') ctx.agentId = id
  } catch (err) {
    ctx.unreachable = `could not reach ${ctx.url} — ${err instanceof Error ? err.message : String(err)}`
  }

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
  const width = Math.max(...summary.results.map((r) => r.id.length))
  const lines = summary.results.map((r) => {
    const head = `${MARK[r.outcome]} ${r.id.padEnd(width)}  ${r.title}`
    return r.detail ? `${head}\n             ${r.detail}` : head
  })
  lines.push('')
  lines.push(`${summary.pass} passed · ${summary.fail} failed · ${summary.warn} need manual review · ${summary.skip} not verifiable from outside`)
  if (summary.skip || summary.warn) {
    lines.push('Every skipped and manual check states its reason above — nothing was checked silently.')
  }
  return lines.join('\n')
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = arg('url') ?? 'http://127.0.0.1:4319'
  const key = arg('key') ?? 'conformance'
  const badKey = arg('bad-key')
  const askPhrase = arg('ask-phrase')

  console.log(`Machine provider conformance — ${url}`)
  console.log(`Spec: spec/README.md · ${CHECKS.length} checks\n`)
  const summary = await runConformance({ url, key, badKey, askPhrase })
  console.log(format(summary))
  if (!badKey || !askPhrase) {
    console.log('\nTip: --bad-key <invalid credential> and --ask-phrase <prompt that makes the agent ask> unlock 4 more checks.')
  }
  process.exit(summary.fail ? 1 : 0)
}
