/**
 * The `provider` machine backer — the node role played over HTTP + SSE.
 *
 * Unlike every other backer there is **no persistent connection**. The protocol is request-per-turn,
 * so this module holds no socket, needs no owning worker, and does not appear in the
 * `down:{machineId}` subscription at all: the worker that receives a client frame calls the provider
 * itself (see `routeDown`). That is what removed the owner-election and multiplexing problems from
 * the WebSocket design this replaced.
 *
 * A provider machine is therefore **always online** — see `isAlwaysOnline`. Failure surfaces on the
 * turn that hit it, which is more precise than a status dot: "credential rejected" and "provider
 * unreachable" are different sentences, and a dot cannot say either.
 *
 * **A PROVIDER HAS NO SESSIONS — ONLY AGENTS.** One agent is one continuous transcript, and the
 * protocol keys everything on `agentId`. The web, however, keys its ENTIRE turn lifecycle on
 * `dbSessionId`: without one the user's own message is never revealed, the `__pending__` spinner
 * never migrates onto a real session, and the input sits on "sending…" forever while every event
 * arrives correctly. So the session is SYNTHESISED here — `sessionId === agentId`, one per agent —
 * and the clients keep the exact shape they already speak. Nothing above this file can tell the
 * difference; that is the point.
 */
import type { Machine } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { getMachineRecaps, publishUp, pushMachineRecap } from './bus.js'
import { decryptMachineCredential } from './machineCredential.js'
import { prisma } from './prisma.js'
import { logger } from '../utils/logger.js'
import { machineBillingAllowsDataPlane } from './billingState.js'
import type { DownBusMsg, Frame } from './tunnel.js'
import {
  ProviderError,
  cancelTurn,
  createAgent,
  deleteAgent,
  listAgents,
  renameAgent,
  sendMessage,
  type ProviderAgent,
  type ProviderCallOptions,
} from './provider/client.js'
import { MAX_CONSECUTIVE_INVALID, MAX_FIELD_CHARS, mapEvent, turnOutcome, type TurnEnd } from './provider/events.js'
import { clampHistoryLimit, fetchTranscript } from './provider/history.js'
import {
  BODY_MAX_CHARS,
  deriveRecap,
  fetchProviderRecap,
  toRecapEvent,
  type RecapEvent,
} from './provider/recap.js'

/** True for a machine whose backer has no liveness to measure — see the module header. */
export function isAlwaysOnline(binding: { authMode?: string | null }): boolean {
  return binding.authMode === 'provider'
}

/**
 * Node liveness for any machine, by id.
 *
 * A provider machine is ALWAYS ONLINE, and this is where that has to be asserted rather than
 * assumed. The presence key is the source of truth for every other mode, but a provider never writes
 * one — there is no socket to keep alive — so reading presence alone reports `false`, and the web
 * then refuses to load anything at all (`AgentTabs`: `if (nodeOnline === false) return`). The machine
 * renders dead and never fetches its projects. Asserting it here is the whole fix.
 */
export async function machineOnline(machineId: string, presenceOnline: boolean): Promise<boolean> {
  if (presenceOnline) return true
  return (await authModeOf(machineId)) === 'provider'
}

interface LinkContext {
  binding: Machine
  call: ProviderCallOptions
  agents: ProviderAgent[]
}

/**
 * The agent list, cached per machine; it changes rarely and would otherwise be fetched on every turn.
 *
 * There is nothing else to cache: a provider publishes no discovery document, so the list IS what the
 * client knows about it. It is an authenticated call, scoped to the tenant this machine's credential
 * selects, which is why two machines pointed at the same endpoint can legitimately see different
 * agents.
 */
interface CachedProfile { agents: ProviderAgent[]; at: number }
const profileCache = new Map<string, CachedProfile>()
const PROFILE_TTL_MS = 5 * 60_000

async function context(machineId: string): Promise<LinkContext | null> {
  const binding = await prisma.machine.findUnique({ where: { machineId } })
  if (!binding || binding.deletedAt || binding.authMode !== 'provider') return null
  if (!binding.providerUrl || !binding.providerCredentialEncrypted) return null
  // Billing is the ONLY enforcement point for this mode: there is no socket to close when a
  // subscription lapses, so the check has to happen before every dial.
  if (!machineBillingAllowsDataPlane(binding)) return null

  let credential: string
  try {
    credential = decryptMachineCredential(binding.providerCredentialEncrypted)
  } catch {
    logger.warn('provider credential could not be decrypted', { machineId })
    return null
  }

  const call: ProviderCallOptions = { url: binding.providerUrl, credential }

  const cached = profileCache.get(machineId)
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return { binding, agents: cached.agents, call }

  // The first and only call needed to know anything about this provider. It is authenticated, so it
  // also tells a wrong credential from an unreachable host without a separate probe.
  const { agents } = await listAgents(call)
  const list = (agents ?? []).filter((a): a is ProviderAgent & { id: string } => typeof a?.id === 'string' && !!a.id)
  profileCache.set(machineId, { agents: list, at: Date.now() })
  return { binding, agents: list, call }
}

export function invalidateProfile(machineId: string): void {
  profileCache.delete(machineId)
}

/**
 * Frames a single turn may push at the clients.
 *
 * The other backers are our own code, so nothing capped them. A provider is not: a misbehaving or
 * hostile endpoint can emit SSE events as fast as the socket allows, and every one of them fans out
 * through Redis to every web tab and to the device screen. This bounds the damage to one turn
 * instead of the instance.
 *
 * Sized for a long, tool-heavy turn with token-level deltas — a real turn against the example
 * provider produces a few hundred.
 */
export const MAX_FRAMES_PER_TURN = 20_000

/**
 * Publish a frame upward, TAGGED WITH THE SESSION.
 *
 * `dbSessionId` is not decoration: the web keys its entire turn lifecycle on it. Without it `sid` is
 * undefined, the user's own message is never revealed, the `__pending__` send-spinner is never
 * migrated onto a real session — and the input sits on "sending…" forever even though every event
 * arrived correctly. That is exactly what happened the first time this ran against the real UI.
 *
 * For a provider the session IS the agent (see the module header), so `agentId` is what we tag with.
 */
/**
 * Provider agent → the shape the client expects.
 *
 * `userId`, `status` and the timestamps are SYNTHESISED from the binding: the protocol does not carry
 * them, and inventing them on the provider side would be fabrication. `engine` is omitted — a
 * provider machine runs none of the CLIs, and the client treats absent as provider-backed.
 */
function toAgent(
  agent: { id?: string; name?: string; description?: string },
  ctx: LinkContext,
): Record<string, unknown> {
  return {
    id: agent.id ?? '',
    name: agent.name ?? agent.id ?? 'Agent',
    description: agent.description ?? '',
    userId: ctx.binding.userId,
    status: 'active',
    createdAt: ctx.binding.createdAt.toISOString(),
    updatedAt: ctx.binding.createdAt.toISOString(),
  }
}

const up = (machineId: string, frame: Frame, sessionId?: string): void => {
  void publishUp(machineId, {
    webEligible: true,
    commanderEligible: true,
    frame: sessionId ? { ...frame, dbSessionId: sessionId } : frame,
  })
}

/**
 * A device-facing card, the way the node emits them (`emitCommanderEvent`).
 *
 * The device speaks a DIFFERENT vocabulary from the web: it never sees `turn_heartbeat` or
 * `turn_summary`, only `commander_event` kinds, and it keys every tile by the top-level `agentId`.
 * So the turn lifecycle has to be said twice, once in each language — which is exactly what
 * `machine-node/api/src/routes/websocket.ts` does for a node-backed machine.
 *
 * Without an agentId there is no tile to address, so the frame is dropped rather than broadcast at
 * whatever the device happens to be showing. The web still gets its half.
 */
const commander = (machineId: string, agentId: string, sessionId: string, payload: Record<string, unknown>): void => {
  if (!agentId) return
  up(machineId, { type: 'commander_event', agentId, payload }, sessionId)
}

/** Reply to an RPC the way a node would: `<type>_result` carrying the caller's requestId. */
const reply = (machineId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void => {
  up(machineId, { type: `${type}_result`, payload: { ...payload, ...(requestId ? { requestId } : {}) } })
}

/**
 * Handle one client frame for a provider machine.
 *
 * Never throws: a failure here is reported to the client as a failed turn or an RPC error, because
 * the alternative is a spinner that never resolves.
 */
export async function dispatch(machineId: string, msg: DownBusMsg): Promise<void> {
  const frame = msg.frame as { type?: string; payload?: Record<string, unknown> }
  const type = frame?.type
  if (!type) return
  const payload = frame.payload ?? {}
  const requestId = payload.requestId

  let ctx: LinkContext | null
  try {
    ctx = await context(machineId)
  } catch (err) {
    failTurn(machineId, type, requestId, describe(err))
    return
  }
  if (!ctx) {
    failTurn(machineId, type, requestId, 'This machine is not available')
    return
  }

  try {
    switch (type) {
      case 'message':
        await runTurn(machineId, ctx, payload)
        return
      case 'cancel': {
        const turnId = typeof payload.taskId === 'string' ? payload.taskId : activeTurns.get(machineId)
        if (turnId) await cancelTurn(ctx.call, turnId)
        return
      }
      case 'agents_list':
        reply(machineId, type, requestId, { agents: ctx.agents.map((a) => toAgent(a, ctx!)) })
        return
      case 'sessions_list': {
        // ONE session per agent, synthesised. The provider has no session concept to ask about, so
        // there is nothing to fetch here and nothing to fold — which is also why the old bug class
        // ("a chat answered twice appeared twice") cannot come back.
        //
        // The client's list is always scoped to ONE agent (the node path refuses the call without an
        // id), so an unknown agent gets an empty list rather than somebody else's row.
        const wanted = typeof payload.agentId === 'string' ? payload.agentId : ''
        const scoped = wanted ? ctx.agents.filter((a) => a.id === wanted) : ctx.agents
        const now = new Date().toISOString()
        reply(machineId, type, requestId, {
          sessions: scoped.map((a) => ({
            id: a.id ?? '',
            title: a.name ?? a.id ?? 'Untitled',
            // The provider publishes no clock for a transcript that has no beginning. "Now" keeps the
            // field the client sorts on populated; with one row per agent nothing depends on the order.
            timestamp: now,
            lastActivity: now,
            // messageCount and participants are deliberately omitted: fabricating statistics is
            // forbidden, and the client hides a count it did not receive.
          })),
        })
        return
      }
      case 'session_get': {
        // The session IS the agent. `sessions_list` hands out `id: agentId`, so what comes back here
        // is an agentId and is used directly as one.
        const agentId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
        const limit = clampHistoryLimit(payload.limit)
        const before = typeof payload.before === 'string' && payload.before ? payload.before : undefined
        const agent = ctx.agents.find((a) => a.id === agentId)

        const transcript = await fetchTranscript(ctx.call, agentId, { limit, before })

        reply(machineId, type, requestId, {
          id: agentId,
          title: agent?.name ?? agent?.id ?? 'Untitled',
          timestamp: new Date().toISOString(),
          events: transcript.events,
          // Deliberately NOT the raw provider events. The client's `messages` fallback parses Claude's
          // JSONL shape (`message.content[]`), which a provider never produces, so handing it provider
          // events means every message is silently dropped and the chat renders empty. Everything
          // renderable is in `events` above; leaving this empty keeps that dead branch from running.
          messages: [],
          ...(typeof transcript.hasMore === 'boolean'
            ? { hasMore: transcript.hasMore, oldestCursor: transcript.oldestCursor ?? null }
            : {}),
        })
        return
      }
      case 'agent_recent': {
        // The device's tile restore. Asked of the provider every time (a PULL by design, never
        // replayed from cache); a provider that summarises nothing answers with an empty list, and we
        // fall back to what the last turns left behind.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          reply(machineId, type, requestId, { error: 'MISSING_AGENT_ID' })
          return
        }
        // `payload.n` is deliberately ignored: the device sends `n: 1` and the provider method has no
        // `n` to forward it to. The REPLY still carries an `events` array — the device iterates it and
        // `deviceWs.trimRecentEvents` expects a list, so the frame is unchanged and no firmware moves.
        const live = await fetchProviderRecap(ctx.call, agentId)
        const events = live ? [live] : await getMachineRecaps<RecapEvent>(machineId, agentId, 1)
        // An empty array is the CORRECT answer before anything has been summarised — the device then
        // shows nothing, rather than resurrecting stale text.
        reply(machineId, type, requestId, { agentId, events })
        return
      }
      // The three mutations are forwarded WITHOUT a local gate. A provider whose agents are managed in
      // its own product answers `invalid_request` with a message, and `failTurn` below hands that
      // message to the user — "agents are managed in Example Co" tells them what to do, where a
      // silently-hidden control tells them nothing.
      case 'agent_create': {
        // Validated, not cast. `String({})` puts "[object Object]" on somebody else's wire, and a
        // non-string `description` forwarded as-is makes US the one sending a malformed request.
        const description = typeof payload.description === 'string' ? payload.description : undefined
        const created = await createAgent(ctx.call, name(payload.name), description)
        invalidateProfile(machineId) // the provider's agent list just changed
        reply(machineId, type, requestId, { agent: toAgent(created, ctx) })
        return
      }
      case 'agent_delete': {
        await deleteAgent(ctx.call, String(payload.agentId ?? ''))
        invalidateProfile(machineId)
        reply(machineId, type, requestId, { message: 'deleted' })
        return
      }
      case 'agent_update': {
        // Only the rename half. Model selection is out of scope for this mode entirely, so a payload
        // carrying `selectedModel` and no name is refused rather than half-applied.
        if (typeof payload.name !== 'string') {
          if (requestId) reply(machineId, type, requestId, { error: 'UNSUPPORTED' })
          return
        }
        const renamed = await renameAgent(ctx.call, String(payload.agentId ?? ''), name(payload.name))
        invalidateProfile(machineId)
        reply(machineId, type, requestId, { agent: toAgent(renamed, ctx) })
        return
      }
      default:
        // Everything else — model switching, logins, session writes — is out of scope for this mode
        // (spec §9). Answer at once: an unanswered RPC is a 20-second spinner in the web.
        if (requestId) reply(machineId, type, requestId, { error: 'UNSUPPORTED' })
        return
    }
  } catch (err) {
    failTurn(machineId, type, requestId, describe(err))
  }
}

// ── The routing seam ─────────────────────────────────────────────────────────────────────────────

/**
 * `authMode` per machine. Immutable once the binding is created (see the schema comment), so this
 * can be cached for the process lifetime without a staleness problem — the only way it changes is a
 * new machine, which is a new key.
 */
const modeCache = new Map<string, string>()

async function authModeOf(machineId: string): Promise<string> {
  const cached = modeCache.get(machineId)
  if (cached) return cached
  const row = await prisma.machine.findUnique({ where: { machineId }, select: { authMode: true } })
  const mode = row?.authMode ?? 'self'
  modeCache.set(machineId, mode)
  return mode
}

export function forgetMachineMode(machineId: string): void {
  modeCache.delete(machineId)
  profileCache.delete(machineId)
}

/**
 * Send a client frame toward whatever backs this machine.
 *
 * **The one branch.** A `provider` machine has no `down:{machineId}` consumer — there is no socket at
 * the other end — so its frames are handled in-process by calling the provider over HTTP. Every other
 * mode keeps the existing publish. Three call sites carry user traffic and route through here:
 * `hub.ts` (client frames), `nodeRpc.ts` (RPCs) and `machineMessage.ts` (the device/voice path);
 * node-only control frames deliberately do not.
 */
export const HANDLED_IN_PROCESS = Symbol('provider-handled')

export async function routeDown(
  machineId: string,
  msg: DownBusMsg,
  fallback: () => Promise<number>,
): Promise<number | typeof HANDLED_IN_PROCESS> {
  let mode: string
  try {
    mode = await authModeOf(machineId)
  } catch {
    return fallback()
  }
  if (mode !== 'provider') return fallback()

  // Never let a provider failure reject into the caller: these call sites are fire-and-forget, and
  // an unhandled rejection there would take down more than one machine's turn.
  await dispatch(machineId, msg).catch((err) => {
    logger.warn('provider dispatch failed', { machineId, error: describe(err) })
  })
  // NOT `0`. Callers read the publish count as "how many backends hold this machine's socket", and
  // zero means offline. A provider machine has no socket and never will, so returning 0 here would
  // flip the client to "unreachable" on every single message. This sentinel says "delivered, and the
  // count does not apply" — the always-online property, expressed where it actually matters.
  return HANDLED_IN_PROCESS
}

/** turnId of the turn currently running per machine, so a `cancel` without one still works. */
const activeTurns = new Map<string, string>()

/**
 * How often a running turn says it is still running.
 *
 * The brain's own `TURN_HEARTBEAT_MS`. It has to stay under BOTH watchdogs, which were sized against
 * it: the web gives up after 10s (`messagesSlice/eventHandlers.ts`) and the device clears its busy
 * tile after 25s (`ui_screens.c` `BUSY_TIMEOUT_US`). At 5s each tolerates a dropped beat.
 */
const TURN_HEARTBEAT_MS = 5_000

/** Enough of the turn's own output to excerpt a recap from, without holding a whole turn in memory. */
const ASSISTANT_TEXT_BUDGET = BODY_MAX_CHARS * 4

async function runTurn(machineId: string, ctx: LinkContext, payload: Record<string, unknown>): Promise<void> {
  const text = typeof payload.text === 'string' ? payload.text : typeof payload.content === 'string' ? payload.content : ''
  if (!text.trim()) return

  // Which agent the turn belongs to. The device keys its tiles by it, the provider is addressed by
  // it, and — since a provider has no sessions — it IS the session id the clients are given.
  //
  // The client's own `sessionId` is accepted as the agent when it names one we know, because that is
  // exactly what `sessions_list` handed it. Falling back to the sole agent covers a single-agent
  // provider whose client sent nothing to disambiguate.
  const claimed = typeof payload.agentId === 'string' && payload.agentId ? payload.agentId : ''
  const fromSession = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : ''
  const agentId = ctx.agents.some((a) => a.id === claimed) ? claimed
    : ctx.agents.some((a) => a.id === fromSession) ? fromSession
      : claimed || ctx.agents[0]?.id || ''
  if (!agentId) {
    up(machineId, { type: 'error', payload: { message: 'This machine has no agents to send to' } })
    up(machineId, { type: 'turn_ended', payload: { reason: 'error' } })
    return
  }

  // The session the CLIENTS see. One per agent — see the module header for why it cannot simply be
  // omitted. The web cannot bind a turn to a session it has not been told about, and will not reveal
  // the user's own message without one.
  const sessionId = agentId
  const isNewSession = fromSession !== sessionId

  // Announce the session BEFORE the turn, so the web can migrate its '__pending__' spinner onto a
  // real id — the same contract the node satisfies with `session_created`.
  if (isNewSession) {
    up(machineId, {
      type: 'session_created',
      payload: { sessionId, title: text.slice(0, 80), createdAt: new Date().toISOString() },
    })
  }

  up(machineId, { type: 'turn_started', payload: { userMessage: text } }, sessionId)

  // Say it in both languages at once: `turn_heartbeat` for the web, a `processing` card for the
  // device. Immediately, then on the interval — otherwise the device shows nothing for the first 5s
  // of every turn.
  const beat = (): void => {
    up(machineId, { type: 'turn_heartbeat', payload: {} }, sessionId)
    commander(machineId, agentId, sessionId, { kind: 'processing' })
  }
  beat()
  // UNCONDITIONAL, deliberately: it is not gated on the provider sending anything. A conformant
  // provider may emit nothing at all until its final answer, so "no SSE event for 30s" is not
  // evidence of a stall and must not be allowed to end a live turn. The 10-minute per-request budget
  // in `provider/client.ts` stays the only backstop.
  const heartbeat = setInterval(beat, TURN_HEARTBEAT_MS)

  // OURS, minted before the request leaves — so a cancel in the first 200ms has something to name.
  // A provider-minted id would arrive only with the first event, by which time the user has already
  // pressed stop and there is nothing to send.
  const turnId = `t-${randomUUID()}`
  activeTurns.set(machineId, turnId)

  let invalid = 0
  let frames = 0
  let end: TurnEnd | undefined
  let reported = false
  // The recap, when the provider pushes it on this turn's own stream.
  // `handled`: either recap kind arrived, so the provider owns this phase and the pull must not run.
  // `pending`: the "Summarizing…" indicator is up and something must eventually close it.
  let recapHandled = false
  let recapPending = false
  let streamedRecap: RecapEvent | null = null
  // The turn's own assistant output, kept only to excerpt a recap from when the provider declares no
  // `agent.recap`. `done` carries the final result text and supersedes the deltas.
  let deltas = ''
  let finalResult = ''
  const collect = (f: Frame): void => {
    const body = (f.payload ?? {}) as { content?: unknown; result?: unknown }
    if (f.type === 'text_delta' && typeof body.content === 'string' && deltas.length < ASSISTANT_TEXT_BUDGET) {
      deltas += body.content
    } else if (f.type === 'done' && typeof body.result === 'string') {
      finalResult = body.result.slice(0, ASSISTANT_TEXT_BUDGET)
    }
  }
  try {
    const resume = typeof payload.resume === 'boolean' ? payload.resume : false
    for await (const event of sendMessage(ctx.call, { agentId, turnId, text, ...(resume ? { resume } : {}) })) {
      const mapped = mapEvent(event)
      if (mapped.kind === 'invalid') {
        // A provider that keeps sending shapes we do not recognise is disconnected rather than
        // allowed to keep pushing at the UI indefinitely.
        if (++invalid >= MAX_CONSECUTIVE_INVALID) {
          logger.warn('provider stream dropped after repeated invalid events', { machineId, reason: mapped.reason })
          break
        }
        continue
      }
      invalid = 0
      if (mapped.kind === 'ignore') continue
      for (const f of mapped.frames) {
        if (++frames > MAX_FRAMES_PER_TURN) break
        // The recap phase is CONSUMED here, never forwarded: clients speak `turn_summary_pending` and
        // `commander_event`, not `recap_*`. Announcing the wait the moment it starts is the whole
        // reason the provider brackets it — the summary takes seconds during which the turn has
        // stopped speaking, and without this the UI shows a stall.
        if (f.type === 'recap_start') {
          recapHandled = true
          if (!recapPending) {
            recapPending = true
            up(machineId, { type: 'turn_summary_pending', payload: { sessionId } }, sessionId)
            commander(machineId, agentId, sessionId, { kind: 'processing', text: 'Summarizing…' })
          }
          continue
        }
        if (f.type === 'recap_end') {
          recapHandled = true
          streamedRecap = toRecapEvent(f.payload as { recap?: unknown; text?: unknown })
          continue
        }
        collect(f)
        up(machineId, f, sessionId)
      }
      if (frames > MAX_FRAMES_PER_TURN) {
        logger.warn('provider exceeded the per-turn frame budget; turn cut short', { machineId, frames })
        up(machineId, { type: 'error', payload: { message: 'The provider sent more output than a single turn allows' } }, sessionId)
        break
      }
      if (mapped.kind === 'terminal') { end = mapped.end; break }
    }
  } catch (err) {
    up(machineId, { type: 'error', payload: { message: describe(err) } }, sessionId)
    reported = true
  } finally {
    clearInterval(heartbeat)
    activeTurns.delete(machineId)
  }

  // A stream that ended without a terminal frame is a protocol violation on their side, and the turn
  // must still be closed here or the client waits forever.
  const outcome = end ? turnOutcome(end) : { aborted: false, failed: true }
  // `input_required` is NOT a failure: the turn is paused for a human answer, which arrives as a
  // resumed `agent.send`. The clients have no vocabulary for a paused turn, so it is surfaced the way
  // the node surfaces a question — as the turn's final text — and the turn is closed normally.
  if (end?.outcome === 'input_required' && end.prompt) {
    up(machineId, { type: 'done', payload: { result: end.prompt } }, sessionId)
  }
  // A failed turn carries a REASON, and it has to reach the user. `turn_ended{reason:'error'}` only
  // says that something went wrong; without this the provider's own explanation — "upstream refused
  // the connection" — is parsed, stored on the terminal frame, and then dropped on the floor.
  if (end?.outcome === 'failed' && end.message) {
    up(machineId, { type: 'error', payload: { message: end.message } }, sessionId)
    reported = true
  }
  // Only when the stream actually started and then stopped short. If the call itself failed we have
  // already said why, and adding "ended the stream without finishing" on top is both redundant and
  // wrong — there was never a stream to end.
  if (!end && !reported) {
    up(machineId, { type: 'error', payload: { message: 'The provider ended the turn without finishing it' } }, sessionId)
  }
  // `reason` is REQUIRED on the client's `turn_ended` (`web/src/lib/types/events.ts`); this path used
  // to omit it entirely, which typechecked only because the frame is opaque at the transport layer.
  const reason = outcome.aborted ? 'interrupt' : outcome.failed ? 'error' : 'result'
  up(machineId, { type: 'turn_ended', payload: { reason, ...(outcome.aborted ? { aborted: true } : {}) } }, sessionId)

  await settleRecap(machineId, ctx, agentId, sessionId, {
    failed: outcome.aborted || outcome.failed,
    assistantText: finalResult || deltas,
    turnId,
  }, { handled: recapHandled, pending: recapPending, recap: streamedRecap })
}

/**
 * The recap phase, after the turn has closed.
 *
 * Ordering mirrors the node path exactly (`machine-node/api/src/routes/websocket.ts`): the device
 * gets `done` BEFORE `summary`, so it clears the busy tile and then repaints it with the card. Get
 * that backwards and the card is immediately wiped by the clear.
 *
 * A broken turn gets no recap — the same gate the brain applies (`if (!isErr …)` in `finalizeTurn`).
 * Summarising a failure produces a tile that reads like an accomplishment.
 */
async function settleRecap(
  machineId: string,
  ctx: LinkContext,
  agentId: string,
  sessionId: string,
  turn: { failed: boolean; assistantText: string; turnId?: string },
  streamed: { handled: boolean; pending: boolean; recap: RecapEvent | null },
): Promise<void> {
  if (turn.failed) {
    // A provider that opened the indicator and then failed still has to have it closed, or the web
    // sits on "Preparing a recap" for a turn that is already over.
    if (streamed.pending) {
      up(machineId, { type: 'turn_summary_pending', payload: { sessionId, done: true } }, sessionId)
    }
    commander(machineId, agentId, sessionId, { kind: 'done' })
    return
  }

  let event: RecapEvent | null = null
  if (streamed.handled) {
    // The provider summarised on the turn's own stream, and the wait was already shown as it
    // happened. Nothing to ask for: this recap is unambiguously THIS turn's, which is exactly what
    // the pull below cannot promise. A `recap_end` that carried no headline still falls through to
    // the excerpt, the same gap-fill any other provider gets.
    event = streamed.recap ?? deriveRecap(turn.assistantText)
  } else {
    // Tell both clients a recap is coming BEFORE fetching it: the web shows "Preparing a recap", and
    // the `processing` card holds the device's busy tile open across the round trip. No repeating beat
    // is needed the way the node needs one — the node is waiting on a model, this is one HTTP call
    // inside a 15s budget, comfortably under the device's 25s timeout.
    up(machineId, { type: 'turn_summary_pending', payload: { sessionId } }, sessionId)
    commander(machineId, agentId, sessionId, { kind: 'processing', text: 'Summarizing…' })

    try {
      // The provider's own recap is authoritative when it has one; ours is only a gap-fill. Skipped
      // without an agent to scope it to — `agent.recap` requires one, so asking anyway would just
      // trade a working fallback for a logged invalid_request.
      const live = agentId ? await fetchProviderRecap(ctx.call, agentId, { turnId: turn.turnId }) : null
      event = live ?? deriveRecap(turn.assistantText)
    } catch (err) {
      // A recap is a nicety. Losing one must not retroactively fail a turn that succeeded, so this is
      // logged and swallowed — and the fallback still runs, since the turn's own text is right here.
      logger.warn('provider recap failed', { machineId, agentId, error: describe(err) })
      event = deriveRecap(turn.assistantText)
    }
  }

  if (!event) {
    // `done: true` closes the web's "Preparing a recap" row without claiming one arrived.
    up(machineId, { type: 'turn_summary_pending', payload: { sessionId, done: true } }, sessionId)
    commander(machineId, agentId, sessionId, { kind: 'done' })
    return
  }

  commander(machineId, agentId, sessionId, { kind: 'done' })
  commander(machineId, agentId, sessionId, { kind: 'summary', text: event.text, recap: event.recap })
  // The web reads only the flag off this frame, never the text — but the shape is the node's
  // ("<recap>\n\n<body>"), so the two paths stay interchangeable.
  up(machineId, { type: 'turn_summary', payload: { sessionId, summary: `${event.recap}\n\n${event.text}` } }, sessionId)

  await pushMachineRecap(machineId, agentId, event)
}

function failTurn(machineId: string, type: string, requestId: unknown, message: string): void {
  if (requestId) {
    reply(machineId, type, requestId, { error: message })
    return
  }
  if (type === 'message') {
    up(machineId, { type: 'error', payload: { message } })
    up(machineId, { type: 'turn_ended', payload: {} })
  }
}

/** A client-supplied agent name, as a string or not at all — never `"[object Object]"`. */
const name = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Turns an error into something worth showing the owner — the auth/transport split is the point. */
export function describe(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.kind === 'unauthenticated') return 'The provider rejected the stored credential — re-enter it'
    if (err.kind === 'not_streaming') return 'The provider did not stream its reply'
    // A refusal is the provider's OWN sentence, and it goes through untouched. This is the whole
    // mitigation for having nothing declared in advance: the web cannot hide a control it has not
    // asked about, so the answer it gets has to explain itself ("agents are managed in Example Co").
    // Prefixing "Could not reach the provider" onto that would turn an explanation into a lie.
    // Capped: this is third-party text on its way to a toast, and `readBodyCapped` bounds the whole
    // JSON-RPC body, not this one field within it.
    if (err.kind === 'refused') return err.message.slice(0, MAX_FIELD_CHARS)
    return `Could not reach the provider: ${err.message}`
  }
  // Raw socket errors carry the host and port we dialled. That is our infrastructure's view of the
  // world, not the owner's — and it should not be echoed into their UI at all. Say what happened and
  // leave the address in the logs.
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return 'Could not reach the provider'
  }
  return err instanceof Error ? err.message : String(err)
}
