/**
 * A real A2A provider backed by the local `claude` CLI.
 *
 * Conforms to `../spec/README.md`; clause IDs (HP-xxx) appear inline. The shape
 * deliberately mirrors `apps/reference-provider/src/server.ts` so the two can be read side by side —
 * that one is scripted, this one is real.
 *
 * ⚠ Runs Claude with `--dangerously-skip-permissions`. See README.md before pointing it anywhere.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative, resolve as resolvePath } from 'node:path'
import { buildAgentCard, EXT } from './agentCard.js'
import { runTurn } from './claude.js'
import { loadConfig, type AgentEntry, type Config } from './config.js'
import { createAgent, deleteAgent, renameAgent, WorkspaceError } from './workspace.js'
import { epoch, readTranscript, sliceByTime } from './jsonl.js'
import { summariseTurn } from './recap.js'
import { messageToParts, pairToolNames, sessionIdOf, streamLineToOutcome } from './mapper.js'
import { SessionStore, type TaskRecord } from './sessions.js'
import {
  isTerminal,
  RpcErrors,
  TaskState,
  type JsonRpcError,
  type JsonRpcRequest,
  type Message,
  type Part,
  type TaskStateValue,
  type TaskStatusUpdateEvent,
} from './types.js'

interface Deps {
  config: Config
  store: SessionStore
  /** Rebuilt whenever the agent list changes — the card IS the capability surface (HP-001). */
  card: Record<string, unknown>
  /** taskId → abort, so CancelTask can stop a running claude (HP-103). */
  running: Map<string, AbortController>
}

export function createProviderServer(config: Config): { server: Server; deps: Deps } {
  const deps: Deps = {
    config,
    store: new SessionStore(config.stateFile),
    card: buildAgentCard(config.agents),
    running: new Map(),
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

  // HP-020 — unauthenticated: a client must be able to read the security scheme before satisfying it.
  if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
    sendJson(res, 200, deps.card)
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

  // HP-011 / HP-013. This example has no user database: any non-empty key is a tenant, except the
  // literal `bad-key`, which exists so the conformance runner's --bad-key probe has something to hit.
  const credential = header(req, 'x-api-key')
  if (!credential || credential === 'bad-key') {
    sendRpcError(res, rpc.id ?? null, RpcErrors.UNAUTHENTICATED)
    return
  }

  const params = rpc.params ?? {}
  const id = rpc.id ?? null

  switch (rpc.method) {
    case 'SendStreamingMessage': return sendStreamingMessage(res, deps, params)
    case 'GetTask':             return getTask(res, deps, params, id)
    case 'ListTasks':           return listTasks(res, deps, params, id)
    case 'CancelTask':          return cancelTask(res, deps, params, id)

    // ── Extensions (HP-310: always `autonomous.<Verb>`) ────────────────────────────────────────
    case 'autonomous.ListFiles': return listFiles(res, deps, params, id)
    case 'autonomous.ReadFile':  return readFile(res, deps, params, id)
    case 'autonomous.GetRecap':  return getRecap(res, deps, params, id)

    // `workspace-write` — agents only; the card declares params.sessions: false.
    case 'autonomous.CreateAgent':
    case 'autonomous.RenameAgent':
    case 'autonomous.DeleteAgent':
      return workspaceWrite(res, deps, rpc.method, params, id)

    // HP-311 — undeclared extension methods MUST be rejected, or the Agent Card means nothing.
    // Session writes would mean editing the user's own Claude transcripts under ~/.claude.
    case 'autonomous.SetSessionTitle':
    case 'autonomous.DeleteSession':
    case 'autonomous.RouteVoice':
      sendRpcError(res, id, RpcErrors.METHOD_NOT_FOUND)
      return

    default:
      sendRpcError(res, id, RpcErrors.METHOD_NOT_FOUND)
  }
}

// ── Agent selection ──────────────────────────────────────────────────────────────────────────────

/**
 * Which configured agent a message targets.
 *
 * NOTE — spec gap: A2A carries no "which skill" selector on a Message, and the profile never says how
 * a client picks one. This reads `message.metadata['autonomous.ai/agentId']` and otherwise falls
 * back to the first configured agent, which keeps plain A2A clients (including the conformance
 * runner) working. Worth a clause in the spec.
 */
function pickAgent(deps: Deps, message: Message | undefined): AgentEntry {
  const requested = (message as { metadata?: Record<string, unknown> } | undefined)?.metadata?.['autonomous.ai/agentId']
  if (typeof requested === 'string') {
    const found = deps.config.agents.find((a) => a.id === requested)
    if (found) return found
  }
  return deps.config.agents[0]!
}

function agentById(deps: Deps, id: string): AgentEntry | undefined {
  return deps.config.agents.find((a) => a.id === id)
}

// ── SendStreamingMessage (HP-100 … HP-106) ───────────────────────────────────────────────────────

async function sendStreamingMessage(res: ServerResponse, deps: Deps, params: Record<string, unknown>): Promise<void> {
  const incoming = params.message as Message | undefined
  if (!incoming || !Array.isArray(incoming.parts)) {
    sendRpcError(res, null, RpcErrors.INVALID_PARAMS)
    return
  }

  // HP-106 — images travel as standard Parts. Claude Code's stream-json input does accept image
  // blocks, but wiring that is beyond this example, so refuse LOUDLY rather than drop them silently.
  if (incoming.parts.some((p) => p.raw && p.mediaType?.startsWith('image/'))) {
    openSse(res)
    const taskId = deps.store.nextTaskId()
    writeSse(res, {
      taskId,
      contextId: incoming.contextId ?? 'ctx-image-refused',
      status: {
        state: TaskState.FAILED,
        message: agentMessage(taskId, incoming.contextId ?? '', [{ text: 'This example provider cannot process image attachments.' }]),
      },
      final: true,
    })
    res.end()
    return
  }

  const text = incoming.parts.map((p) => p.text ?? '').join('').trim()
  if (!text) {
    sendRpcError(res, null, RpcErrors.INVALID_PARAMS)
    return
  }

  // HP-101 — a follow-up carries the existing taskId; a new chat carries only a contextId.
  const resuming = typeof incoming.taskId === 'string' ? deps.store.task(incoming.taskId) : undefined
  if (incoming.taskId && !resuming) {
    sendRpcError(res, null, RpcErrors.TASK_NOT_FOUND)
    return
  }
  if (resuming && isTerminal(resuming.state)) {
    sendRpcError(res, null, { code: -32004, message: 'Task is in a terminal state' })
    return
  }

  const contextId = resuming?.contextId ?? (typeof incoming.contextId === 'string' && incoming.contextId ? incoming.contextId : `ctx-${Date.now()}`)
  const agent = resuming ? agentById(deps, resuming.agentId) ?? pickAgent(deps, incoming) : pickAgent(deps, incoming)
  const context = deps.store.ensureContext(contextId, agent.id)

  const taskId = deps.store.nextTaskId()
  const startedAt = Date.now()
  deps.store.createTask({
    taskId,
    contextId,
    agentId: agent.id,
    state: TaskState.WORKING,
    startedAt,
    title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
  })

  const controller = new AbortController()
  deps.running.set(taskId, controller)

  openSse(res)
  writeSse(res, { taskId, contextId, status: { state: TaskState.WORKING } })

  const collected: Part[] = []
  let sawResult = false
  let failed = false
  let failDetail: string | undefined
  let stderr = ''

  const handle = runTurn(
    {
      claudeBin: deps.config.claudeBin,
      cwd: agent.cwd,
      text,
      resumeSessionId: context.claudeSessionId,
      model: deps.config.model,
      signal: controller.signal,
    },
    (line) => {
      const sid = sessionIdOf(line)
      if (sid) deps.store.setClaudeSession(contextId, sid)
      const outcome = streamLineToOutcome(line)
      if (outcome.kind === 'parts') {
        // Pair tool names across everything seen so far, so a tool_end is not left anonymous.
        const paired = pairToolNames([...collected, ...outcome.parts]).slice(collected.length)
        collected.push(...outcome.parts)
        writeSse(res, { taskId, contextId, status: { state: TaskState.WORKING, message: agentMessage(taskId, contextId, paired) } })
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
  deps.running.delete(taskId)

  // HP-102 — a terminal state on EVERY stream. A process that dies without emitting `result` is
  // still a finished turn from the client's point of view, and must be reported as failed rather
  // than leaving the stream hanging.
  let finalState: TaskStateValue = TaskState.COMPLETED
  let finalText: string | undefined
  if (killed) {
    finalState = TaskState.CANCELED
  } else if (failed) {
    finalState = TaskState.FAILED
    finalText = failDetail ?? 'claude reported an error'
  } else if (!sawResult) {
    finalState = TaskState.FAILED
    finalText = `claude exited without a result${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`
  }

  deps.store.finishTask(taskId, finalState)
  writeSse(res, {
    taskId,
    contextId,
    status: { state: finalState, ...(finalText ? { message: agentMessage(taskId, contextId, [{ text: finalText }]) } : {}) },
    final: true,
  })
  if (!res.destroyed) res.end()

  // HP-302 — summarise the turn AFTER closing the stream. Not awaited: the turn is over, and holding
  // the SSE response open for a summary would make every turn look slower than it was.
  // Only a turn that actually completed: summarising a failure produces a headline that reads like
  // an accomplishment.
  if (finalState === TaskState.COMPLETED) void recapTurn(deps, taskId, agent, collected)
}

/** Summarise one finished turn and persist it on the task, for `autonomous.GetRecap` to serve. */
async function recapTurn(deps: Deps, taskId: string, agent: AgentEntry, parts: Part[]): Promise<void> {
  // The assistant's own words only — thinking and tool output are not what the turn accomplished.
  const turnText = parts
    .filter((p) => p.metadata?.['autonomous.ai/kind'] === 'text_delta')
    .map((p) => p.text ?? '')
    .join('')
  try {
    const recap = await summariseTurn({
      claudeBin: deps.config.claudeBin,
      cwd: agent.cwd,
      turnText,
      model: deps.config.recapModel,
      disabled: deps.config.recapDisabled,
    })
    if (recap) deps.store.setRecap(taskId, recap.recap, recap.body)
  } catch (err) {
    // A recap is a nicety. It must never be able to retroactively fail a turn that succeeded.
    console.warn(`[example-provider] recap failed for ${taskId}:`, err instanceof Error ? err.message : String(err))
  }
}

// ── History (HP-200 … HP-202) ────────────────────────────────────────────────────────────────────

/**
 * HP-201 — the turn's messages, read back out of Claude's own transcript.
 *
 * Note the slice: the JSONL holds the whole SESSION, while an A2A task is one TURN, so the task's
 * timestamp window selects its share. A task still running has no end bound yet.
 */
function getTask(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const taskId = typeof params.taskId === 'string' ? params.taskId : ''
  const record = deps.store.task(taskId)
  if (!record) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_FOUND)
    return
  }
  sendRpcResult(res, id, taskToWire(deps, record))
}

/** HP-200 — grouping by contextId is what backs the session list. */
function listTasks(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const contextId = typeof params.contextId === 'string' ? params.contextId : undefined
  const tasks = deps.store.tasks(contextId).map((t) => taskToWire(deps, t, { history: false }))
  sendRpcResult(res, id, { tasks })
}

function taskToWire(deps: Deps, record: TaskRecord, opts: { history?: boolean } = {}): Record<string, unknown> {
  const withHistory = opts.history !== false
  let history: unknown[] = []
  if (withHistory) {
    const context = deps.store.context(record.contextId)
    const agent = agentById(deps, record.agentId)
    if (context?.claudeSessionId && agent) {
      const lines = sliceByTime(
        readTranscript(deps.config.claudeProjectsDir, agent.cwd, context.claudeSessionId),
        record.startedAt - 5_000, // Claude timestamps the line slightly before we record the task
        record.endedAt ? record.endedAt + 5_000 : undefined,
      )
      history = lines.map((line) => ({
        role: line.type === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
        messageId: line.uuid ?? '',
        taskId: record.taskId,
        contextId: record.contextId,
        parts: pairToolNames(messageToParts(line.message)),
      })).filter((m) => (m.parts as Part[]).length > 0)
    }
  }
  return {
    id: record.taskId,
    contextId: record.contextId,
    status: { state: record.state },
    history,
    metadata: { title: record.title, agentId: record.agentId },
  }
}

/** HP-103 — cancelling stops the process AND its tool subprocesses; the stream then terminates. */
function cancelTask(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const taskId = typeof params.taskId === 'string' ? params.taskId : ''
  const record = deps.store.task(taskId)
  if (!record) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_FOUND)
    return
  }
  if (isTerminal(record.state)) {
    sendRpcError(res, id, RpcErrors.TASK_NOT_CANCELABLE)
    return
  }
  deps.running.get(taskId)?.abort()
  deps.running.delete(taskId)
  deps.store.finishTask(taskId, TaskState.CANCELED)
  sendRpcResult(res, id, taskToWire(deps, deps.store.task(taskId)!, { history: false }))
}

// ── Extension: workspace-files (HP-300) ──────────────────────────────────────────────────────────

/** Resolve a wire path inside the agent's cwd, or throw. Path traversal is the obvious attack here. */
function safeJoin(root: string, rel: string): string {
  const target = resolvePath(root, normalize(rel))
  const inside = relative(root, target)
  if (inside.startsWith('..') || resolvePath(root, inside) !== target) throw new Error('path escapes the agent directory')
  return target
}

function listFiles(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const agent = agentById(deps, String(params.agentId ?? ''))
  if (!agent) { sendRpcError(res, id, RpcErrors.INVALID_PARAMS); return }
  let dir: string
  try {
    dir = params.path ? safeJoin(agent.cwd, String(params.path)) : agent.cwd
  } catch {
    sendRpcError(res, id, RpcErrors.INVALID_PARAMS)
    return
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { sendRpcError(res, id, RpcErrors.INVALID_PARAMS); return }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .slice(0, 500)
    .map((e) => {
      const node: Record<string, unknown> = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' }
      if (!e.isDirectory()) { try { node.size = statSync(join(dir, e.name)).size } catch { /* ignore */ } }
      return node
    })
  sendRpcResult(res, id, { files })
}

const MAX_FILE_BYTES = 512 * 1024

function readFile(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const agent = agentById(deps, String(params.agentId ?? ''))
  const path = typeof params.path === 'string' ? params.path : ''
  if (!agent || !path) { sendRpcError(res, id, RpcErrors.INVALID_PARAMS); return }
  let file: string
  try {
    file = safeJoin(agent.cwd, path)
  } catch {
    sendRpcError(res, id, RpcErrors.INVALID_PARAMS)
    return
  }
  if (!existsSync(file) || !statSync(file).isFile()) { sendRpcError(res, id, RpcErrors.INVALID_PARAMS); return }
  const raw = readFileSync(file, 'utf8')
  const truncated = raw.length > MAX_FILE_BYTES
  // Truncation is REPORTED, never silent — the same rule HP-203 sets for transcripts.
  sendRpcResult(res, id, { path, content: truncated ? raw.slice(0, MAX_FILE_BYTES) : raw, ...(truncated ? { truncated: true } : {}) })
}

/** HP-301 — agent create / rename / delete, all contained under the workspace root. */
function workspaceWrite(
  res: ServerResponse,
  deps: Deps,
  method: string,
  params: Record<string, unknown>,
  id: string | number | null,
): void {
  try {
    if (method === 'autonomous.CreateAgent') {
      const entry = createAgent(deps.config, String(params.name ?? ''), String(params.description ?? ''))
      // The card is BUILT from the agent list, so it has to be rebuilt for the new agent to be
      // discoverable at all — the card is the capability surface (HP-001).
      deps.card = buildAgentCard(deps.config.agents)
      sendRpcResult(res, id, { id: entry.id, name: entry.name, description: entry.description })
      return
    }
    if (method === 'autonomous.RenameAgent') {
      const entry = renameAgent(deps.config, String(params.agentId ?? ''), String(params.name ?? ''))
      deps.card = buildAgentCard(deps.config.agents)
      sendRpcResult(res, id, { id: entry.id, name: entry.name, description: entry.description })
      return
    }
    deleteAgent(deps.config, String(params.agentId ?? ''))
    deps.card = buildAgentCard(deps.config.agents)
    sendRpcResult(res, id, { ok: true })
  } catch (err) {
    if (err instanceof WorkspaceError) { sendRpcError(res, id, { code: -32602, message: err.message }); return }
    throw err
  }
}

// ── Extension: session-recap (HP-302) ────────────────────────────────────────────────────────────

/**
 * Recent turns for the device's tiles.
 *
 * Served from the task records, which is what makes these PER TURN — the unit HP-302 asks for. An
 * earlier version listed recent *sessions* and used each one's title, which was wrong twice over:
 * a session is not a turn, and a title is what the user ASKED rather than what the turn accomplished.
 *
 * `contextId` is the A2A context the client minted, never Claude's own session id. A client uses it
 * to reopen the conversation, so handing back an id we never issued would simply not resolve.
 */
function getRecap(res: ServerResponse, deps: Deps, params: Record<string, unknown>, id: string | number | null): void {
  const agent = agentById(deps, String(params.agentId ?? ''))
  if (!agent) { sendRpcError(res, id, RpcErrors.INVALID_PARAMS); return }
  const n = Math.max(1, Math.min(5, Number(params.n) || 2))
  // Empty until a turn has been summarised — which the schema calls correct. The device shows
  // nothing rather than resurrecting stale text.
  const entries = deps.store.recentRecaps(agent.id, n).map((t) => ({
    recap: t.recap!,
    body: t.body,
    contextId: t.contextId,
    taskId: t.taskId,
    timestamp: new Date(t.endedAt ?? t.startedAt).toISOString(),
  }))
  sendRpcResult(res, id, { agentId: agent.id, entries })
}

// ── Wire helpers ─────────────────────────────────────────────────────────────────────────────────

function agentMessage(taskId: string, contextId: string, parts: Part[]): Message {
  return { role: 'ROLE_AGENT', messageId: `m-${Date.now()}-${Math.round(epoch(undefined))}`, taskId, contextId, parts }
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
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
  sendJson(res, error.code === RpcErrors.UNAUTHENTICATED.code ? 401 : 200, { jsonrpc: '2.0', id, error })
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

export function start(config = loadConfig(), port = config.port): Promise<{ url: string; close: () => Promise<void> }> {
  const { server, deps } = createProviderServer(config)
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address()
      const actual = typeof address === 'object' && address ? address.port : port
      resolve({
        url: `http://127.0.0.1:${actual}`,
        close: () =>
          new Promise<void>((done) => {
            for (const c of deps.running.values()) c.abort()
            server.close(() => done())
          }),
      })
    })
  })
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const config = loadConfig()
    void start(config).then(({ url }) => {
      console.log(`[example-provider] listening on ${url}`)
      console.log(`[example-provider] claude: ${config.claudeBin}`)
      console.log(`[example-provider] agents: ${config.agents.map((a) => `${a.id} → ${a.cwd}`).join(', ')}`)
      console.log('[example-provider] ⚠ running with --dangerously-skip-permissions')
    })
  } catch (err) {
    console.error(`[example-provider] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
