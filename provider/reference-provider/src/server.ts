/**
 * Reference provider for the Autonomous machine provider protocol.
 *
 * See `../../spec/README.md`. This file doubles as a worked reading of it.
 *
 * Zero runtime dependencies on purpose: `node:http` and nothing else. A partner should be able to read
 * this end to end and know exactly what their own endpoint has to do.
 *
 * There is no discovery step and nothing to declare: one URL, one credential header, eight methods.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AgentError, CREDENTIAL_HEADER, createAgent, deleteAgent, hasAgent, listAgents, renameAgent } from './agents.js'
import { credentialAccepted, pickScenario, RESUMED, type Step } from './scenarios.js'
import { Store } from './store.js'
import type { ErrorCode, ProviderEvent, RpcRequest } from './types.js'

/** Pause between streamed events. 0 in tests; a small value locally so streaming is visible. */
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 20)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ProviderServer {
  server: Server
  store: Store
  url: string
  close: () => Promise<void>
}

export function createProviderServer(store = new Store()): Server {
  return createServer((req, res) => {
    void handle(req, res, store).catch((err) => {
      // Never leak a stack to the wire; a provider's internal errors are its own business.
      console.error('[reference-provider] unhandled', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
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

  // The credential identifies one tenant. A rejection is its own error code, never a generic failure:
  // "your credential is wrong" and "the provider is down" need different words in front of the user.
  if (!credentialAccepted(bearer(header(req, CREDENTIAL_HEADER)))) {
    sendError(res, rpc.id ?? null, 'unauthenticated', 'credential rejected')
    return
  }

  const id = rpc.id ?? null
  const params = rpc.params ?? {}
  switch (rpc.method) {
    case 'agent.list':
      sendResult(res, id, { agents: listAgents() })
      return
    case 'agent.send':
      await agentSend(res, store, params)
      return
    case 'agent.history':
      agentHistory(res, store, params, id)
      return
    case 'turn.cancel':
      turnCancel(res, store, params, id)
      return
    case 'agent.recap':
      agentRecap(res, store, params, id)
      return
    case 'agent.create':
    case 'agent.rename':
    case 'agent.delete':
      mutateAgent(res, rpc.method, params, id)
      return
    default:
      sendError(res, id, 'unsupported', `unknown method ${rpc.method}`)
  }
}

// ── agent.send ───────────────────────────────────────────────────────────────────────────────────

/**
 * Stream Server-Sent Events, one JSON object per `data:` frame.
 *
 * The response is opened before any work happens: the whole point is that partial output reaches the
 * user while the turn runs.
 */
async function agentSend(res: ServerResponse, store: Store, params: Record<string, unknown>): Promise<void> {
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  const message = (params.message ?? {}) as { text?: unknown }
  const text = typeof message.text === 'string' ? message.text : ''

  // These are stream-level errors, so they are answered as JSON before the stream opens rather than
  // as an event inside it — a client that asked for a nonexistent agent has no turn to fail.
  if (!turnId) { sendError(res, null, 'invalid_request', 'turnId is required'); return }
  if (!hasAgent(agentId)) { sendError(res, null, 'not_found', `no agent ${agentId}`); return }

  const resume = params.resume === true
  const steps: Step[] = resume ? RESUMED : pickScenario(text).steps

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const emit = (event: ProviderEvent): void => {
    store.append(agentId, event)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // A cancel that arrived BEFORE this turn started still has to stop it. Checking here is what makes
  // a client-minted `turnId` worth anything: a user who presses stop in the first 200ms would
  // otherwise be ignored by the engine while the API said "cancelled".
  if (store.takeEarlyCancel(turnId)) {
    emit({ kind: 'turn_cancelled' })
    res.end()
    return
  }

  const abort = new AbortController()
  store.register(turnId, abort)

  emit({ kind: 'turn_started', turnId, agentId, at: new Date().toISOString() })
  // The user's own message belongs in the transcript — a refresh must show the conversation, not one
  // side of it. Appended rather than emitted: the client already has the text it just sent.
  if (text) store.append(agentId, { kind: 'user_message', text })

  try {
    for (const step of steps) {
      if (abort.signal.aborted) {
        emit({ kind: 'turn_cancelled' })
        res.end()
        return
      }
      if (step.kind === 'die') {
        // The one-terminal-frame rule violated ON PURPOSE: the socket dies with no terminal event, so
        // a client can be hardened against it and the conformance runner can be shown catching it.
        res.destroy()
        return
      }
      emit(step.event)
      if (step.event.kind === 'turn_input_required') store.pause(turnId, agentId)
      if (step.event.kind === 'recap_end' && step.event.recap) {
        store.pushRecap(agentId, { recap: step.event.recap, text: step.event.text, turnId })
      }
      await sleep(STEP_DELAY_MS)
    }
    res.end()
  } finally {
    store.release(turnId)
  }
}

// ── agent.history ────────────────────────────────────────────────────────────────────────────────

/**
 * One agent's transcript, windowed, in the SAME event objects the stream emitted. There is nothing to
 * translate on the way out, which is exactly the property that keeps a replayed transcript and the
 * live view from disagreeing.
 */
function agentHistory(res: ServerResponse, store: Store, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  if (!hasAgent(agentId)) { sendError(res, id ?? null, 'not_found', `no agent ${agentId}`); return }
  const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : undefined
  const before = typeof params.before === 'string' && params.before ? params.before : undefined

  const window = store.history(agentId, limit, before)
  sendResult(res, id ?? null, {
    agentId,
    events: window.events,
    // Present only when older events remain. Its ABSENCE is how a client knows it reached the start.
    ...(window.nextBefore ? { nextBefore: window.nextBefore } : {}),
    // This provider never truncates, so it says so rather than omitting the field: the rule is about
    // never truncating SILENTLY.
    truncated: false,
  })
}

// ── turn.cancel ──────────────────────────────────────────────────────────────────────────────────

/** Always accepted, including for a turn that has not started (see `Store.cancel`). */
function turnCancel(res: ServerResponse, store: Store, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const turnId = typeof params.turnId === 'string' ? params.turnId : ''
  if (!turnId) { sendError(res, id ?? null, 'invalid_request', 'turnId is required'); return }
  store.cancel(turnId)
  sendResult(res, id ?? null, { cancelled: true })
}

// ── agent.recap ──────────────────────────────────────────────────────────────────────────────────

function agentRecap(res: ServerResponse, store: Store, params: Record<string, unknown>, id: RpcRequest['id']): void {
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  if (!hasAgent(agentId)) { sendError(res, id ?? null, 'not_found', `no agent ${agentId}`); return }
  // NO `recap` field is correct before any turn has been summarised — the device then shows nothing
  // rather than resurrecting stale text. The object spread out here is the same one `recap_end`
  // pushes on a turn's own stream.
  const entry = store.lastRecap(agentId)
  sendResult(res, id ?? null, { agentId, ...(entry ?? {}) })
}

// ── agent.create / rename / delete ───────────────────────────────────────────────────────────────

/**
 * Mutations on the agent list.
 *
 * A provider whose agents are managed elsewhere answers `invalid_request` with a message instead —
 * that message is shown to the user, which is more useful than a control that is silently missing.
 * This one really mutates, so the conformance runner has something to exercise.
 */
function mutateAgent(res: ServerResponse, method: string, params: Record<string, unknown>, id: RpcRequest['id']): void {
  try {
    if (method === 'agent.create') {
      return sendResult(res, id ?? null, createAgent(String(params.name ?? ''), params.description as string | undefined))
    }
    if (method === 'agent.rename') {
      return sendResult(res, id ?? null, renameAgent(String(params.agentId ?? ''), String(params.name ?? '')))
    }
    deleteAgent(String(params.agentId ?? ''))
    sendResult(res, id ?? null, { deleted: true })
  } catch (err) {
    if (err instanceof AgentError) { sendError(res, id ?? null, 'invalid_request', err.message); return }
    throw err
  }
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────────────────

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const sendResult = (res: ServerResponse, id: RpcRequest['id'], result: unknown): void =>
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result })

/**
 * `unauthenticated` also carries HTTP 401, so a client that never parses the body can still tell a
 * rejected credential from an outage.
 */
function sendError(res: ServerResponse, id: RpcRequest['id'], code: ErrorCode, message?: string): void {
  const status = code === 'unauthenticated' ? 401 : 200
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, ...(message ? { message } : {}) } })
}

/** Boot on an ephemeral port. Used by the tests and by the e2e harness. */
export async function start(port = 0): Promise<ProviderServer> {
  const store = new Store()
  const server = createProviderServer(store)
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`
  return { server, store, url, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// `npm run dev` / `npm start`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/src|\/dist)/, ''))) {
  void start(Number(process.env.PORT ?? 4319)).then(({ url }) => {
    console.log(`[reference-provider] ${url}  ·  POST / with \`Authorization: Bearer <credential>\``)
  })
}
