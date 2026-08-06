/**
 * Reference provider for the Autonomous machine provider profile.
 *
 * See `../spec/README.md`. Clause IDs (HP-xxx) in the comments below point at the
 * requirement each block satisfies, so this file doubles as a worked reading of the spec.
 *
 * Zero runtime dependencies on purpose: node:http and nothing else. A partner should be able to read
 * this end to end and know exactly what their own endpoint has to do.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AGENT_CARD, SKILL_IDS } from './agentCard.js'
import { credentialAccepted, pickScenario, type Step } from './scenarios.js'
import { nextId, TaskStore } from './store.js'
import {
  isTerminal,
  RpcErrors,
  TaskState,
  type JsonRpcError,
  type JsonRpcRequest,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
} from './types.js'

/** Pause between streamed steps. 0 in tests; a small value locally so streaming is visible. */
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS ?? 20)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface ProviderServer {
  server: Server
  store: TaskStore
  url: string
  close: () => Promise<void>
}

export function createProviderServer(store = new TaskStore()): Server {
  return createServer((req, res) => {
    void handle(req, res, store).catch((err) => {
      // Never leak a stack to the wire; a provider's internal errors are its own business.
      console.error('[reference-provider] unhandled', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, store: TaskStore): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // HP-020 — the agent card is unauthenticated: a client must be able to discover the security
  // scheme before it can possibly satisfy it.
  if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
    sendJson(res, 200, AGENT_CARD)
    return
  }

  if (req.method !== 'POST' || url.pathname !== '/') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  let rpc: JsonRpcRequest
  try {
    rpc = JSON.parse(await readBody(req)) as JsonRpcRequest
  } catch {
    sendRpcError(res, null, RpcErrors.PARSE_ERROR)
    return
  }
  if (!rpc || typeof rpc.method !== 'string') {
    sendRpcError(res, rpc?.id ?? null, RpcErrors.INVALID_REQUEST)
    return
  }

  // HP-011/HP-012 — the credential arrives in the header the agent card declared, and identifies one
  // tenant. HP-013: a rejection is its own signal, never a generic failure.
  const credential = header(req, AGENT_CARD.securitySchemes.apiKey.name)
  if (!credentialAccepted(credential)) {
    sendRpcError(res, rpc.id ?? null, RpcErrors.UNAUTHENTICATED)
    return
  }

  const params = rpc.params ?? {}
  switch (rpc.method) {
    case 'SendStreamingMessage':
      await sendStreamingMessage(res, store, params)
      return
    case 'SendMessage':
      sendMessageSync(res, store, params, rpc.id ?? null)
      return
    case 'GetTask':
      getTask(res, store, params, rpc.id ?? null)
      return
    case 'ListTasks':
      listTasks(res, store, params, rpc.id ?? null)
      return
    case 'CancelTask':
      cancelTask(res, store, params, rpc.id ?? null)
      return

    // ── Extension methods (HP-310: always `autonomous.<Verb>`) ─────────────────────────────────
    // HP-311: an extension method whose URI is not in AgentCard.extensions MUST be rejected with
    // -32601. Answering an undeclared method would make the card untrustworthy.
    case 'autonomous.GetRecap':
      if (!declaresExtension(EXT.SESSION_RECAP)) { sendRpcError(res, rpc.id ?? null, RpcErrors.METHOD_NOT_FOUND); return }
      getRecap(res, store, params, rpc.id ?? null)
      return
    case 'autonomous.ListFiles':
    case 'autonomous.ReadFile':
      // `workspace-files` is deliberately NOT declared by this provider — see agentCard.ts.
      sendRpcError(res, rpc.id ?? null, RpcErrors.METHOD_NOT_FOUND)
      return
    case 'autonomous.CreateAgent':
    case 'autonomous.RenameAgent':
    case 'autonomous.DeleteAgent':
    case 'autonomous.SetSessionTitle':
    case 'autonomous.DeleteSession':
      // `workspace-write` is deliberately NOT declared either.
      sendRpcError(res, rpc.id ?? null, RpcErrors.METHOD_NOT_FOUND)
      return
    case 'autonomous.RouteVoice':
      sendRpcError(res, rpc.id ?? null, RpcErrors.METHOD_NOT_FOUND)
      return

    default:
      sendRpcError(res, rpc.id ?? null, RpcErrors.METHOD_NOT_FOUND)
  }
}

const EXT = {
  WORKSPACE_FILES: 'https://harness.autonomous.ai/api/a2a/ext/workspace-files',
  WORKSPACE_WRITE: 'https://harness.autonomous.ai/api/a2a/ext/workspace-write',
  SESSION_RECAP: 'https://harness.autonomous.ai/api/a2a/ext/session-recap',
  VOICE: 'https://harness.autonomous.ai/api/a2a/ext/voice',
} as const

const declaresExtension = (uri: string): boolean =>
  (AGENT_CARD.extensions as ReadonlyArray<{ uri: string }>).some((e) => e.uri === uri)

/**
 * HP-302 — `autonomous.GetRecap`. Headline-style summaries of recent turns, for the device's tiles.
 *
 * `recap` is what the turn ACCOMPLISHED, so it comes from the ASSISTANT's own words. It is emphatically
 * not `metadata.title`, which is the first user message — i.e. what was ASKED. An earlier version
 * returned the title, which made the device tile read the user's own prompt back at them.
 *
 * A real provider would summarise with a model. This one is scripted and must stay deterministic, so
 * it excerpts instead: headline = the reply's opening sentence, body = the reply. That is honest, and
 * it demonstrates the two-field shape a client renders (tile + tap-to-read).
 *
 * An empty array is the correct answer before anything has been summarised: the device shows nothing
 * rather than resurrecting stale text.
 */
function getRecap(res: ServerResponse, store: TaskStore, params: Record<string, unknown>, id: string | number | null): void {
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  if (!SKILL_IDS.includes(agentId)) {
    sendRpcError(res, id, RpcErrors.INVALID_PARAMS)
    return
  }
  const n = Math.max(1, Math.min(5, Number(params.n) || 2))
  const entries = store
    .list()
    .filter((t) => t.status.state === TaskState.COMPLETED) // a failed turn accomplished nothing
    .map((t) => ({ task: t, said: assistantTextOf(t) }))
    .filter((e) => !!e.said)
    .slice(0, n)
    .map((e) => ({
      recap: firstSentence(e.said).slice(0, 200), // `recapEntry.recap` is capped at 200 by the schema
      body: e.said.slice(0, 2000),
      contextId: e.task.contextId,
      taskId: e.task.id,
    }))
  sendRpcResult(res, id, { agentId, entries })
}

/** Everything the assistant said in a turn, flattened to the one line a tile renders. */
function assistantTextOf(task: Task): string {
  return task.history
    .filter((m) => m.role === 'ROLE_AGENT')
    .flatMap((m) => m.parts)
    .filter((p) => (p.metadata?.['autonomous.ai/kind'] ?? 'text_delta') === 'text_delta')
    .map((p) => p.text ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstSentence(text: string): string {
  const match = /[.!?](\s|$)/.exec(text)
  return match ? text.slice(0, match.index + 1) : text
}

// ── SendStreamingMessage (HP-100 … HP-106) ───────────────────────────────────────────────────────

async function sendStreamingMessage(res: ServerResponse, store: TaskStore, params: Record<string, unknown>): Promise<void> {
  const incoming = params.message as Message | undefined
  if (!incoming || !Array.isArray(incoming.parts)) {
    sendRpcError(res, null, RpcErrors.INVALID_PARAMS)
    return
  }

  // HP-106 — images ride as standard Parts. This provider cannot process them, so it says so rather
  // than silently discarding, which would read to the user as the agent ignoring what they sent.
  const images = incoming.parts.filter((p) => p.raw && p.mediaType?.startsWith('image/'))

  // HP-101 — a follow-up carries the existing taskId; a new chat carries only a fresh contextId.
  const resuming = typeof incoming.taskId === 'string' ? store.get(incoming.taskId) : undefined
  if (incoming.taskId && !resuming) {
    sendRpcError(res, null, RpcErrors.TASK_NOT_FOUND)
    return
  }
  if (resuming && isTerminal(resuming.status.state)) {
    // A2A: terminal tasks accept no further messages.
    sendRpcError(res, null, { code: -32004, message: 'Task is in a terminal state' })
    return
  }

  const contextId = resuming?.contextId ?? (typeof incoming.contextId === 'string' ? incoming.contextId : nextId('ctx'))
  const task = resuming ?? store.create(contextId, incoming)
  if (resuming) store.append(task.id, incoming)

  const controller = new AbortController()
  store.register(task.id, controller)

  openSse(res)
  const userText = incoming.parts.map((p) => p.text ?? '').join(' ')

  // HP-102 — every stream ends with a terminal state. The one exception is the `die` scenario, which
  // exists precisely so a client can be hardened against providers that get this wrong.
  const steps: Step[] = images.length
    ? [{ kind: 'state', state: TaskState.FAILED, text: 'This provider cannot process image attachments.' }]
    : pickScenario(userText).steps

  try {
    store.setState(task.id, TaskState.WORKING)
    writeSse(res, statusEvent(task, TaskState.WORKING))

    for (const step of steps) {
      if (controller.signal.aborted) break
      await sleep(STEP_DELAY_MS)
      if (controller.signal.aborted) break

      if (step.kind === 'die') {
        res.destroy() // no terminal state, mid-stream — deliberately non-conformant
        return
      }
      if (step.kind === 'parts') {
        writeSse(res, {
          taskId: task.id,
          contextId: task.contextId,
          status: {
            state: TaskState.WORKING,
            message: { role: 'ROLE_AGENT', messageId: nextId('m'), taskId: task.id, contextId: task.contextId, parts: step.parts },
          },
        })
        store.append(task.id, { role: 'ROLE_AGENT', messageId: nextId('m'), taskId: task.id, contextId: task.contextId, parts: step.parts })
        continue
      }
      // step.kind === 'state'
      const message: Message | undefined = step.text
        ? { role: 'ROLE_AGENT', messageId: nextId('m'), taskId: task.id, contextId: task.contextId, parts: [{ text: step.text }] }
        : undefined
      store.setState(task.id, step.state, message)
      writeSse(res, {
        taskId: task.id,
        contextId: task.contextId,
        status: { state: step.state, ...(message ? { message } : {}) },
        final: isTerminal(step.state),
      })
      // INPUT_REQUIRED is not terminal, but it does end this stream: the answer arrives as a new
      // request carrying the same taskId (HP-104).
      break
    }

    if (controller.signal.aborted) {
      writeSse(res, { taskId: task.id, contextId: task.contextId, status: { state: TaskState.CANCELED }, final: true })
    }
  } finally {
    store.release(task.id)
    if (!res.destroyed) res.end()
  }
}

// ── Non-streaming and read methods ───────────────────────────────────────────────────────────────

function sendMessageSync(res: ServerResponse, store: TaskStore, params: Record<string, unknown>, id: string | number | null): void {
  const incoming = params.message as Message | undefined
  if (!incoming || !Array.isArray(incoming.parts)) {
    sendRpcError(res, id, RpcErrors.INVALID_PARAMS)
    return
  }
  const contextId = typeof incoming.contextId === 'string' ? incoming.contextId : nextId('ctx')
  const task = store.create(contextId, incoming)
  store.setState(task.id, TaskState.COMPLETED, {
    role: 'ROLE_AGENT',
    messageId: nextId('m'),
    taskId: task.id,
    contextId,
    parts: [{ text: 'Non-streaming reply.' }],
  })
  sendRpcResult(res, id, store.get(task.id))
}

/** HP-201 — the full transcript in one response. Pagination is not part of this revision (HP-202). */
function getTask(res: ServerResponse, store: TaskStore, params: Record<string, unknown>, id: string | number | null): void {
  const taskId = typeof params.taskId === 'string' ? params.taskId : ''
  const task = store.get(taskId)
  if (!task) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_FOUND)
    return
  }
  sendRpcResult(res, id, task)
}

/** HP-200 — grouping by contextId is what backs the session list. */
function listTasks(res: ServerResponse, store: TaskStore, params: Record<string, unknown>, id: string | number | null): void {
  const contextId = typeof params.contextId === 'string' ? params.contextId : undefined
  sendRpcResult(res, id, { tasks: store.list(contextId) })
}

/** HP-103 — after a successful cancel the stream terminates and the task reports CANCELED. */
function cancelTask(res: ServerResponse, store: TaskStore, params: Record<string, unknown>, id: string | number | null): void {
  const taskId = typeof params.taskId === 'string' ? params.taskId : ''
  const task = store.get(taskId)
  if (!task) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_FOUND)
    return
  }
  if (!store.cancel(taskId)) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_CANCELABLE)
    return
  }
  sendRpcResult(res, id, store.get(taskId))
}

// ── Wire helpers ─────────────────────────────────────────────────────────────────────────────────

function statusEvent(task: Task, state: TaskStatusUpdateEvent['status']['state']): TaskStatusUpdateEvent {
  return { taskId: task.id, contextId: task.contextId, status: { state } }
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function writeSse(res: ServerResponse, event: TaskStatusUpdateEvent): void {
  if (res.destroyed) return
  res.write(`event: status-update\ndata: ${JSON.stringify(event)}\n\n`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function sendRpcResult(res: ServerResponse, id: string | number | null, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result })
}

function sendRpcError(res: ServerResponse, id: string | number | null, error: JsonRpcError): void {
  // JSON-RPC transports errors in the body with HTTP 200; an authentication failure additionally
  // deserves a real 401 so ordinary HTTP tooling sees it.
  const status = error.code === RpcErrors.UNAUTHENTICATED.code ? 401 : 200
  sendJson(res, status, { jsonrpc: '2.0', id, error })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 5 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────────

/** Starts on an ephemeral port when `port` is 0 — how the tests use it. */
export function start(port = Number(process.env.PORT ?? 4501)): Promise<ProviderServer> {
  const store = new TaskStore()
  const server = createProviderServer(store)
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      resolve({
        server,
        store,
        url: `http://127.0.0.1:${actual}`,
        close: () =>
          new Promise<void>((done) => {
            store.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

// Only auto-start when run directly, so importing this module in a test does not bind a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void start().then(({ url }) => {
    console.log(`[reference-provider] listening on ${url}`)
    console.log(`[reference-provider] agent card: ${url}/.well-known/agent-card.json`)
  })
}
