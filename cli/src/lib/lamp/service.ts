import { createHash, randomUUID } from 'node:crypto'

export type LampFrame = Record<string, unknown> & { type: string }
export type ReceiptState = 'queued' | 'delivered' | 'started' | 'completed' | 'rejected' | 'unknown'
export interface LampReceipt {
  idempotencyKey: string; deliveryId: string; operation: string; state: ReceiptState
  agentId: string; machineId: string; serverInstanceId: string; turnId: string | null
  error: { code: string; message: string } | null; at: number
}
export interface LampAgent { agentId: string; name: string; engine: string; state: string }
export interface LampDelivery { deliveryId: string; sessionId: string; state: ReceiptState; reason?: string }
export interface LampServiceOptions {
  machineId: string; serverInstanceId?: string; now?: () => number
  agents: () => LampAgent[]
  submit: (agentId: string, text: string, deliveryId: string) => void
  cancelDelivery: (deliveryId: string) => boolean
  stop: (agentId: string) => Promise<boolean>
  answer: (agentId: string, questionRequestId: string, answers: Record<string, string>) => Promise<boolean>
  recent: (agentId: string, n: number) => unknown[]
  emit?: (frame: LampFrame) => void
}
interface Entry { lampId: string; digest: string; receipt: LampReceipt }
const CAPABILITIES = ['agents.list', 'turn.send', 'turn.stop', 'status', 'recap', 'question.answer', 'receipt.get'] as const
export const LAMP_CAPABILITIES: string[] = [...CAPABILITIES]
const MUTATIONS = new Set(['turn.send', 'turn.stop', 'question.answer'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_-]{1,64}$/
const TTL = 30 * 60_000
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
class RequestError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function fail(code: string, message: string): never { throw new RequestError(code, message) }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Pure local-agent facade. Transport authenticates identity; this layer never guesses a target. */
export class LampService {
  readonly serverInstanceId: string
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly deliveries = new Map<string, Entry>()
  private readonly turns = new Map<string, Entry>()
  private readonly questions = new Map<string, { requestId: string; questions: unknown }>()
  private events: LampFrame[] = []
  private sequence = 0
  constructor(private readonly options: LampServiceOptions) {
    this.serverInstanceId = options.serverInstanceId ?? randomUUID()
    this.now = options.now ?? Date.now
  }
  private key(lampId: string, key: string): string { return `${lampId}:${key}` }
  receipt(lampId: string, key: string): LampReceipt | null {
    this.prune()
    const value = this.entries.get(this.key(lampId, key))?.receipt
    return value ? structuredClone(value) : null
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (['completed', 'rejected'].includes(entry.receipt.state) && this.now() - entry.receipt.at > TTL) {
        this.entries.delete(key); this.deliveries.delete(entry.receipt.deliveryId)
      }
    }
  }
  private reserveCapacity(): void {
    if (this.entries.size < 512) return
    // Evict only settled work. Dropping a live/ambiguous reservation permits duplicate execution.
    let oldest: [string, Entry] | undefined
    for (const candidate of this.entries) {
      if (!['completed', 'rejected'].includes(candidate[1].receipt.state)) continue
      if (!oldest || candidate[1].receipt.at < oldest[1].receipt.at) oldest = candidate
    }
    if (!oldest) fail('BACKPRESSURE', 'Receipt capacity contains unresolved work; reconcile before sending more')
    this.entries.delete(oldest[0]); this.deliveries.delete(oldest[1].receipt.deliveryId)
  }
  private update(entry: Entry, state: ReceiptState, code?: string): void {
    if (['completed', 'rejected'].includes(entry.receipt.state)) return
    if (state === 'delivered' && entry.receipt.state === 'started') return
    entry.receipt.state = state
    entry.receipt.at = this.now()
    entry.receipt.error = code ? { code, message: code === 'NOT_CONFIRMED' ? 'Delivery could not be confirmed; inspect the agent before retrying.' : code } : null
    if (state === 'started') {
      entry.receipt.turnId ??= randomUUID()
      this.turns.set(entry.receipt.agentId, entry)
    }
    this.event('receipt.updated', entry.receipt.agentId, { receipt: structuredClone(entry.receipt), idempotencyKey: entry.receipt.idempotencyKey })
  }
  delivery(event: LampDelivery): void {
    const entry = this.deliveries.get(event.deliveryId)
    if (!entry) return
    this.update(entry, event.state, event.reason)
  }
  revoke(lampId: string): void {
    for (const [key, entry] of this.entries) if (entry.lampId === lampId) {
      this.options.cancelDelivery(entry.receipt.deliveryId)
      this.deliveries.delete(entry.receipt.deliveryId)
      if (this.turns.get(entry.receipt.agentId) === entry) this.turns.delete(entry.receipt.agentId)
      this.entries.delete(key)
    }
    // A newly paired identity cannot replay the previous lamp's request receipts.
    this.events = []
  }
  event(kind: string, agentId: string | undefined, payload: Record<string, unknown>): void {
    const frame: LampFrame = { type: 'event', eventId: ++this.sequence, serverInstanceId: this.serverInstanceId,
      machineId: this.options.machineId, ...(agentId ? { agentId } : {}), kind, payload }
    this.events.push(frame)
    if (this.events.length > 500) this.events.shift()
    this.options.emit?.(frame)
  }
  resume(resume?: { serverInstanceId?: unknown; cursor?: unknown }): { resumed: boolean; cursor: number } {
    const cursor = resume?.cursor
    return { resumed: resume?.serverInstanceId === this.serverInstanceId && Number.isSafeInteger(cursor)
      && (cursor as number) >= (Number(this.events[0]?.eventId ?? this.sequence + 1) - 1) && (cursor as number) <= this.sequence,
    cursor: this.sequence }
  }
  replay(resume: { serverInstanceId?: unknown; cursor?: unknown } | undefined, send: (frame: LampFrame) => unknown): void {
    if (!this.resume(resume).resumed) {
      send({ type: 'resync', reason: resume?.serverInstanceId === this.serverInstanceId ? 'cursor_too_old' : 'instance_changed', serverInstanceId: this.serverInstanceId, cursor: this.sequence })
      return
    }
    for (const event of this.events) if (Number(event.eventId) > Number(resume?.cursor)) send(event)
  }
  turnStarted(agentId: string): void {
    const entry = this.turns.get(agentId)
    this.event('turn.started', agentId, entry ? { turnId: entry.receipt.turnId, idempotencyKey: entry.receipt.idempotencyKey } : {})
  }
  turnEnded(agentId: string, aborted = false): void {
    const entry = this.turns.get(agentId)
    if (entry) {
      this.update(entry, aborted ? 'unknown' : 'completed', aborted ? 'TURN_INTERRUPTED' : undefined)
      this.turns.delete(agentId)
    }
    this.event(aborted ? 'turn.error' : 'turn.done', agentId, entry ? { turnId: entry.receipt.turnId, idempotencyKey: entry.receipt.idempotencyKey } : {})
  }
  commander(frame: Record<string, unknown>): void {
    const agentId = typeof frame.agentId === 'string' ? frame.agentId : undefined
    const p = object(frame.payload) ? frame.payload : {}
    if (frame.type === 'commander_question' && agentId && typeof p.requestId === 'string') {
      this.questions.set(agentId, { requestId: p.requestId, questions: p.questions })
      this.event('question.open', agentId, { questionRequestId: p.requestId, questions: p.questions })
    } else if (frame.type === 'commander_question_close' && agentId) {
      if (this.questions.get(agentId)?.requestId === p.requestId) this.questions.delete(agentId)
      this.event('question.close', agentId, { questionRequestId: p.requestId })
    } else if (frame.type === 'commander_event' && agentId && ['summary', 'tool', 'error'].includes(String(p.kind))) {
      this.event(p.kind === 'summary' ? 'turn.summary' : p.kind === 'tool' ? 'turn.tool' : 'agent.error', agentId, p)
    }
  }
  async request(lampId: string, req: Record<string, unknown>): Promise<LampFrame> {
    const type = typeof req.type === 'string' ? req.type : 'invalid'
    const response = (data: Record<string, unknown>): LampFrame => ({ type: `${type}_result`, requestId: req.requestId, ...data })
    let reserved: Entry | undefined
    try {
      if (!UUID.test(String(req.requestId))) fail('INVALID_REQUEST', 'requestId must be a UUIDv4')
      if (!LAMP_CAPABILITIES.includes(type)) fail('UNSUPPORTED_CAPABILITY', 'Operation is not supported')
      const allowed = ['type', 'requestId', ...(type === 'agents.list' ? [] : type === 'receipt.get' ? ['idempotencyKey'] : ['machineId', 'agentId']),
        ...(MUTATIONS.has(type) ? ['idempotencyKey'] : []), ...(type === 'turn.send' ? ['text'] : type === 'question.answer' ? ['questionRequestId', 'answers'] : type === 'recap' ? ['n'] : [])]
      if (Object.keys(req).some(k => !allowed.includes(k))) fail('INVALID_REQUEST', 'Unknown request field')
      if (type === 'receipt.get') {
        if (!KEY.test(String(req.idempotencyKey ?? ''))) fail('INVALID_REQUEST', 'Invalid idempotencyKey')
        return response({ receipt: this.receipt(lampId, String(req.idempotencyKey)) })
      }
      if (type === 'agents.list') return response({ machineId: this.options.machineId, agents: this.options.agents().map(a => ({ ...a, machineId: this.options.machineId })) })
      if (typeof req.agentId !== 'string' || !req.agentId || typeof req.machineId !== 'string') fail('MISSING_TARGET', 'machineId and agentId are required')
      if (req.machineId !== this.options.machineId) fail('MACHINE_MISMATCH', 'Only the paired machine is available')
      const agentId = req.agentId as string
      if (type === 'turn.send' && (typeof req.text !== 'string' || !req.text.trim())) fail('INVALID_REQUEST', 'text must be nonempty')
      if (type === 'turn.send' && Buffer.byteLength(String(req.text)) > 16384) fail('PAYLOAD_TOO_LARGE', 'Prompt exceeds 16 KiB')
      if (type === 'question.answer' && (typeof req.questionRequestId !== 'string' || !req.questionRequestId || !object(req.answers)
        || !Object.keys(req.answers).length || Object.values(req.answers).some(v => typeof v !== 'string'))) fail('INVALID_REQUEST', 'questionRequestId and string answers are required')
      if (MUTATIONS.has(type) && !KEY.test(String(req.idempotencyKey ?? ''))) fail('INVALID_REQUEST', 'Invalid idempotencyKey')
      const digest = createHash('sha256').update(canonical({ ...req, requestId: null, idempotencyKey: null })).digest('hex')
      const key = this.key(lampId, String(req.idempotencyKey))
      this.prune()
      const previous = MUTATIONS.has(type) ? this.entries.get(key) : undefined
      if (previous) {
        if (previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different operation or payload')
        return response({ status: 'duplicate', receipt: structuredClone(previous.receipt) })
      }
      const agent = this.options.agents().find(a => a.agentId === agentId)
      if (!agent) fail('AGENT_NOT_FOUND', 'Agent is not available on the paired machine')
      if (type === 'status') return response({ machineId: this.options.machineId, agentId, state: agent.state, openQuestion: this.questions.get(agentId) ?? null })
      if (type === 'recap') {
        const n = req.n ?? 3
        if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > 5) fail('INVALID_REQUEST', 'n must be from 1 to 5')
        return response({ machineId: this.options.machineId, agentId, turns: this.options.recent(agentId, Number(n)) })
      }
      if (type === 'question.answer' && this.questions.get(agentId)?.requestId !== req.questionRequestId) fail('QUESTION_STALE', 'Question is no longer open')
      this.reserveCapacity()
      const entry: Entry = { lampId, digest, receipt: { idempotencyKey: String(req.idempotencyKey), deliveryId: randomUUID(), operation: type,
        machineId: this.options.machineId, agentId, state: 'queued', turnId: null, serverInstanceId: this.serverInstanceId, error: null, at: this.now() } }
      this.entries.set(key, entry); this.deliveries.set(entry.receipt.deliveryId, entry); reserved = entry
      try {
        if (type === 'turn.send') this.options.submit(agentId, String(req.text), entry.receipt.deliveryId)
        else {
          const ok = type === 'turn.stop' ? await this.options.stop(agentId) : await this.options.answer(agentId, String(req.questionRequestId), req.answers as Record<string, string>)
          if (this.entries.get(key) !== entry) {
            // A reserved mutation always has a receipt, even if its authorization disappears.
            return response({ status: 'accepted', receipt: { ...structuredClone(entry.receipt), state: 'unknown', at: this.now(), error: { code: 'REVOKED', message: 'Pairing was revoked during the command; execution may already have occurred' } } })
          }
          this.update(entry, ok ? 'completed' : 'unknown', ok ? undefined : 'NOT_CONFIRMED')
          if (ok && type === 'question.answer') this.questions.delete(agentId)
        }
      } catch {
        if (this.entries.get(key) === entry) this.update(entry, 'unknown', 'NOT_CONFIRMED')
      }
      if (this.entries.get(key) !== entry) return response({ status: 'accepted', receipt: { ...structuredClone(entry.receipt), state: 'unknown', at: this.now(), error: { code: 'REVOKED', message: 'Pairing was revoked during the command; execution may already have occurred' } } })
      return response({ status: 'accepted', receipt: structuredClone(entry.receipt) })
    } catch (e) {
      if (reserved) {
        reserved.receipt.state = 'unknown'; reserved.receipt.at = this.now()
        reserved.receipt.error = { code: 'INTERNAL', message: 'Reserved operation could not be confirmed' }
        return response({ status: 'accepted', receipt: structuredClone(reserved.receipt) })
      }
      return response({ error: { code: e instanceof RequestError ? e.code : 'INTERNAL', message: e instanceof RequestError ? e.message : 'Request failed' } })
    }
  }
}
