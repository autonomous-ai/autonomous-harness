/**
 * A real provider backed by the local `claude` CLI.
 *
 * Conforms to `../../spec/README.md`. The shape deliberately mirrors
 * `reference-provider/src/server.ts` so the two can be read side by side — that one is scripted, this
 * one is real.
 *
 * One agent is one continuous transcript, so one agent maps to one Claude session, resumed on every
 * turn. There is no session or context here to bridge.
 *
 * ⚠ Runs Claude with `--dangerously-skip-permissions`. See README.md before pointing it anywhere.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { agentsOf, CREDENTIAL_HEADER } from './agents.js'
import { runTurn } from './claude.js'
import { loadConfig, type AgentEntry, type Config } from './config.js'
import { createAgent, deleteAgent, renameAgent, WorkspaceError } from './workspace.js'
import { readTranscript, type TranscriptLine } from './jsonl.js'
import { summariseTurn } from './recap.js'
import { messageToEvents, pairToolNames, sessionIdOf, streamLineToOutcome } from './mapper.js'
import { SessionStore } from './sessions.js'
import type { ErrorCode, ProviderEvent, RpcRequest } from './types.js'

/** How long a cancel waits for the send it belongs to. Generous: the client sends within a tick. */
export const EARLY_CANCEL_TTL_MS = 10 * 60_000

interface Deps {
  config: Config
  store: SessionStore
  /** turnId → abort, so `turn.cancel` can stop a running claude. */
  running: Map<string, AbortController>
  /**
   * Turns cancelled BEFORE they started → when the cancel arrived.
   *
   * A cancel for a not-yet-started turn must be honoured, which is what makes a client-minted
   * `turnId` worth anything: a user who presses stop in the first 200 ms would otherwise be
   * acknowledged by the API and ignored by the engine.
   *
   * Timed, because an entry is otherwise only removed by a matching `agent.send` that may never
   * arrive — a client cancelling turns it never sends would grow this forever.
   */
  cancelledEarly: Map<string, number>
}

export function createProviderServer(config: Config): { server: Server; deps: Deps } {
  const deps: Deps = {
    config,
    store: new SessionStore(config.stateFile),
    running: new Map(),
    cancelledEarly: new Map(),
  }
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((err) => {
      console.error('[example-provider] unhandled', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  })
  return { server, deps }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method !== 'POST' || url.pathname !== '/') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  let rpc: RpcRequest
  try {
    rpc = JSON.parse(await readBody(req)) as RpcRequest
  } catch {
    sendError(res, null, 'invalid_request', 'body is not JSON')
    return
  }
  if (!rpc || typeof rpc.method !== 'string') {
    sendError(res, rpc?.id ?? null, 'invalid_request', 'no method')
    return
  }

  // This example has no user database: any non-empty key is a tenant, except the literal `bad-key`,
  // which exists so the conformance runner's --bad-key probe has something to hit.
  const credential = bearer(header(req, CREDENTIAL_HEADER))
  if (!credential || credential === 'bad-key') {
    sendError(res, rpc.id ?? null, 'unauthenticated', 'credential rejected')
    return
  }

  const params = rpc.params ?? {}
  const id = rpc.id ?? null

  switch (rpc.method) {
    case 'agent.list':    return sendResult(res, id, { agents: agentsOf(deps.config) })
    case 'agent.send':    return agentSend(res, deps, params)
    case 'agent.history': return agentHistory(res, deps, params, id)
    case 'turn.cancel':   return turnCancel(res, deps, params, id)
    case 'agent.recap':   return getRecap(res, deps, params, id)
    case 'agent.create':
    case 'agent.rename':
    case 'agent.delete':
      return mutateAgent(res, deps, rpc.method, params, id)

    default:
      sendError(res, id, 'unsupported', `unknown method ${rpc.method}`)
  }
}

const agentById = (deps: Deps, id: string): AgentEntry | undefined => deps.config.agents.find((a) => a.id === id)

// ── agent.send ───────────────────────────────────────────────────────────────────────────────────

async function agentSend(res: ServerResponse, deps: Deps, params: Record<string, unknown>): Promise<void> {
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  const message = (params.message ?? {}) as { text?: unknown; attachments?: unknown }
  const text = typeof message.text === 'string' ? message.text.trim() : ''

  if (!turnId) { sendError(res, null, 'invalid_request', 'turnId is required'); return }
  const agent = agentById(deps, agentId)
  if (!agent) { sendError(res, null, 'not_found', `no agent ${agentId}`); return }
  if (!text) { sendError(res, null, 'invalid_request', 'message.text is required'); return }

  const record = deps.store.ensureAgent(agent.id)

  const emit = (event: ProviderEvent): void => writeSse(res, event)

  openSse(res)

  // A cancel that arrived before this turn started still has to stop it.
  if (deps.cancelledEarly.delete(turnId)) {
    emit({ kind: 'turn_cancelled' })
    res.end()
    return
  }

  // Images travel as attachments. Claude Code's stream-json input does accept image blocks, but wiring
  // that is beyond this example, so refuse LOUDLY rather than drop them silently: silent loss reads to
  // the user as the agent ignoring what they sent.
  if (Array.isArray(message.attachments) && message.attachments.length) {
    emit({ kind: 'turn_started', turnId, agentId: agent.id, at: new Date().toISOString() })
    emit({
      kind: 'turn_failed',
      error: { code: 'unsupported', message: 'This example provider cannot process image attachments.' },
    })
    res.end()
    return
  }

  const startedAt = Date.now()
  deps.store.createTurn({
    turnId,
    agentId: agent.id,
    startedAt,
    title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
  })

  const controller = new AbortController()
  deps.running.set(turnId, controller)

  emit({ kind: 'turn_started', turnId, agentId: agent.id, at: new Date(startedAt).toISOString() })

  const collected: ProviderEvent[] = []
  let sawResult = false
  let failed = false
  let failDetail: string | undefined
  let stderr = ''

  const handle = runTurn(
    {
      claudeBin: deps.config.claudeBin,
      cwd: agent.cwd,
      text,
      resumeSessionId: record.claudeSessionId,
      model: deps.config.model,
      anthropic: deps.config.anthropic,
      signal: controller.signal,
    },
    (line) => {
      const sid = sessionIdOf(line)
      if (sid) deps.store.setClaudeSession(agent.id, sid)
      const outcome = streamLineToOutcome(line)
      if (outcome.kind === 'events') {
        // Pair tool names across everything seen so far, so a tool_end is not left anonymous.
        const paired = pairToolNames([...collected, ...outcome.events]).slice(collected.length)
        collected.push(...outcome.events)
        for (const event of paired) emit(event)
        return
      }
      if (outcome.kind === 'done') {
        sawResult = true
        failed = outcome.failed
        failDetail = outcome.detail
      }
    },
    (chunk) => { stderr += chunk },
  )

  const { killed } = await handle.done
  deps.running.delete(turnId)

  // Exactly one terminal frame on EVERY stream. A process that dies without emitting
  // `result` is still a finished turn from the client's point of view, and must be reported as failed
  // rather than leaving the stream hanging.
  let terminal: ProviderEvent = { kind: 'turn_completed' }
  if (killed) {
    terminal = { kind: 'turn_cancelled' }
  } else if (failed) {
    terminal = { kind: 'turn_failed', error: { code: 'internal', message: failDetail ?? 'claude reported an error' } }
  } else if (!sawResult) {
    terminal = {
      kind: 'turn_failed',
      error: { code: 'internal', message: `claude exited without a result${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}` },
    }
  }

  deps.store.finishTurn(turnId, terminal.kind !== 'turn_completed')

  // Summarise BEFORE the terminal frame, on the stream that is still open, so the recap is
  // unambiguously THIS turn's. The turn therefore stays open for as long as the one-shot takes. That
  // cost buys correctness the pull cannot give: `agent.recap` is scoped to an AGENT and takes no turn
  // id, so a client asking the instant a turn ends either gets nothing (this turn is not summarised
  // yet) or the PREVIOUS turn's headline. Only a turn that actually completed gets one — summarising
  // a failure produces a headline that reads like an accomplishment.
  if (terminal.kind === 'turn_completed') await recapTurn(deps, res, turnId, agent, collected)

  // The final assistant text, so a client has one authoritative result to render.
  const finalText = collected.filter((e) => e.kind === 'text_delta').map((e) => e.text ?? '').join('')
  if (terminal.kind === 'turn_completed' && finalText) emit({ kind: 'done', text: finalText })

  emit(terminal)
  if (!res.destroyed) res.end()
}

/**
 * Summarise one finished turn: push it on the still-open stream AND persist it.
 *
 * Both, not either. The stream serves the client watching this turn; the persisted copy serves a
 * device restoring its tiles after a reboot, which has no stream to read.
 */
async function recapTurn(
  deps: Deps,
  res: ServerResponse,
  turnId: string,
  agent: AgentEntry,
  events: ProviderEvent[],
): Promise<void> {
  // The assistant's own words only — thinking and tool output are not what the turn accomplished.
  const turnText = events.filter((e) => e.kind === 'text_delta').map((e) => e.text ?? '').join('')

  // Announced BEFORE the wait, not after it: summarising is seconds of real time during which the
  // turn has stopped speaking, and without this the client has nothing to show for it.
  writeSse(res, { kind: 'recap_start' })

  let recap: Awaited<ReturnType<typeof summariseTurn>> = null
  try {
    recap = await summariseTurn({
      claudeBin: deps.config.claudeBin,
      cwd: agent.cwd,
      turnText,
      model: deps.config.recapModel,
      anthropic: deps.config.anthropic,
      disabled: deps.config.recapDisabled,
    })
    if (recap) deps.store.setRecap(turnId, recap.recap, recap.body)
  } catch (err) {
    // A recap is a nicety. It must never be able to retroactively fail a turn that succeeded, so the
    // terminal frame goes out either way — the caller emits it after this returns.
    console.warn(`[example-provider] recap failed for ${turnId}:`, err instanceof Error ? err.message : String(err))
  }

  // ALWAYS, even with nothing to say. A `recap_start` with no `recap_end` leaves the client
  // spinning on an indicator that will never close — worse than never having opened one.
  writeSse(res, recap ? { kind: 'recap_end', recap: recap.recap, text: recap.body } : { kind: 'recap_end' })
}

// ── agent.history ────────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY_LIMIT = 500

/**
 * The agent's transcript, read back out of Claude's own JSONL and mapped by the SAME mapper the live
 * path uses. Writing a second parser is the reliable way to make the live view and the post-refresh
 * view disagree.
 */
function transcriptEvents(deps: Deps, agent: AgentEntry): ProviderEvent[] {
  const sessionId = deps.store.agent(agent.id)?.claudeSessionId
  if (!sessionId) return []
  const lines: TranscriptLine[] = readTranscript(deps.config.claudeProjectsDir, agent.cwd, sessionId)
  return pairToolNames(lines.flatMap((line) => messageToEvents(line.message)))
}

function agentHistory(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const agent = agentById(deps, String(params.agentId ?? ''))
  if (!agent) { sendError(res, id ?? null, 'not_found', 'no such agent'); return }

  const all = transcriptEvents(deps, agent)
  const rawLimit = typeof params.limit === 'number' ? params.limit : Number(params.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_HISTORY_LIMIT) : undefined
  const before = typeof params.before === 'string' && params.before ? params.before : undefined

  // The cursor is an INDEX into this agent's transcript, opaque to the client. It is derived rather
  // than stored on the event, because the objects handed back must be the ones the stream emitted.
  const cutoff = before ? Number(before.replace(/^evt_/, '')) : all.length
  const eligible = all.slice(0, Number.isFinite(cutoff) ? cutoff : all.length)

  if (!limit) {
    sendResult(res, id ?? null, { agentId: agent.id, events: eligible, truncated: false })
    return
  }
  const startAt = Math.max(0, eligible.length - limit)
  sendResult(res, id ?? null, {
    agentId: agent.id,
    events: eligible.slice(startAt),
    // Present only when older events remain. Its ABSENCE is how the client knows it reached the start.
    ...(startAt > 0 ? { nextBefore: `evt_${startAt}` } : {}),
    truncated: false,
  })
}

// ── turn.cancel ──────────────────────────────────────────────────────────────────────────────────

/** Always accepted: the client mints `turnId` before sending and may well cancel first. */
function turnCancel(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  if (!turnId) { sendError(res, id ?? null, 'invalid_request', 'turnId is required'); return }
  const live = deps.running.get(turnId)
  if (live) {
    // Kills the process group, so the tools it started die with it.
    live.abort()
    deps.running.delete(turnId)
  } else {
    // Swept here, the one place it can grow: a send that has not arrived within the window is not
    // coming, and an unmatched cancel must not be a slow memory leak.
    const now = Date.now()
    for (const [id, at] of deps.cancelledEarly) if (now - at > EARLY_CANCEL_TTL_MS) deps.cancelledEarly.delete(id)
    deps.cancelledEarly.set(turnId, now)
  }
  sendResult(res, id ?? null, { cancelled: true })
}

// ── agent.recap ──────────────────────────────────────────────────────────────────────────────────

function getRecap(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const agent = agentById(deps, String(params.agentId ?? ''))
  if (!agent) { sendError(res, id ?? null, 'not_found', 'no such agent'); return }
  // NO `recap` field before anything has been summarised: the device then shows nothing rather than
  // stale text. What goes out is the same object `recap_end` pushes on the turn's own stream.
  const last = deps.store.lastRecap(agent.id)
  sendResult(res, id ?? null, {
    agentId: agent.id,
    ...(last ? {
      recap: last.recap!,
      ...(last.body ? { text: last.body } : {}),
      // The turnId is what lets a client tell THIS turn's recap from the previous one's.
      turnId: last.turnId,
    } : {}),
  })
}

// ── agent.create / rename / delete ───────────────────────────────────────────────────────────────

/**
 * An agent here IS a directory, so these really do write to disk.
 *
 * A provider whose agents are managed elsewhere is free to answer `invalid_request` with a message
 * instead — that message is shown to the user, which beats a control that silently does nothing.
 */
function mutateAgent(
  res: ServerResponse,
  deps: Deps,
  method: string,
  params: Record<string, unknown>,
  id: RpcRequest['id'],
): void {
  try {
    if (method === 'agent.create') {
      const entry = createAgent(deps.config, String(params.name ?? ''), String(params.description ?? ''))
      sendResult(res, id ?? null, { id: entry.id, name: entry.name, description: entry.description ?? '' })
      return
    }
    if (method === 'agent.rename') {
      const entry = renameAgent(deps.config, String(params.agentId ?? ''), String(params.name ?? ''))
      sendResult(res, id ?? null, { id: entry.id, name: entry.name, description: entry.description ?? '' })
      return
    }
    deleteAgent(deps.config, String(params.agentId ?? ''))
    sendResult(res, id ?? null, { deleted: true })
  } catch (err) {
    if (err instanceof WorkspaceError) { sendError(res, id ?? null, 'invalid_request', err.message); return }
    throw err
  }
}

// ── Wire helpers ─────────────────────────────────────────────────────────────────────────────────

function openSse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
}

function writeSse(res: ServerResponse, event: ProviderEvent): void {
  if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const sendResult = (res: ServerResponse, id: RpcRequest['id'], result: unknown): void =>
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result })

/** `unauthenticated` also carries HTTP 401, so a client that never parses the body can still tell a
 *  rejected credential from an outage. */
function sendError(res: ServerResponse, id: RpcRequest['id'], code: ErrorCode, message?: string): void {
  const status = code === 'unauthenticated' ? 401 : 200
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, ...(message ? { message } : {}) } })
}

/** `Authorization: Bearer <credential>` — one header, by convention rather than by declaration. */
function bearer(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match ? match[1] : value
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────────

export function start(config = loadConfig(), port = config.port): Promise<{ url: string; close: () => Promise<void> }> {
  const { server } = createProviderServer(config)
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`
      resolve({ url, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  void start(config).then(({ url }) => {
    console.log(`[example-provider] ${url}  ·  POST / with \`Authorization: Bearer <credential>\``)
    console.log(`[example-provider] ${config.agents.length} agent(s): ${config.agents.map((a) => a.id).join(', ')}`)
  })
}
