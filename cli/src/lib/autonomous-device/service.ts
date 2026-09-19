import { createHash, randomUUID } from 'node:crypto'

export type AutonomousDeviceFrame = Record<string, unknown> & { type: string }
export type ReceiptState = 'queued' | 'delivered' | 'started' | 'completed' | 'rejected' | 'unknown'
export interface AutonomousDeviceReceipt {
  idempotencyKey: string; deliveryId: string; operation: string; state: ReceiptState
  agentId: string; machineId: string; serverInstanceId: string; turnId: string | null
  error: { code: string; message: string } | null; at: number
}
export interface AutonomousDeviceAgent { agentId: string; name: string; engine: string; state: string }

const AGENT_RECAP_MAX_CHARS = 200
export interface AutonomousDeviceDelivery { deliveryId: string; sessionId: string; state: ReceiptState; reason?: string }
export interface AutonomousDeviceServiceOptions {
  machineId: string; serverInstanceId?: string; now?: () => number
  agents: () => AutonomousDeviceAgent[]
  requestAppFocus?: (agentId: string, expiresAt: number, focusRevision: string) => boolean
  /**
   * Turn the app's focus one agent along the desk, the way the USB dial does — same ring, same wrap,
   * same `dial_focus` forward. Resolves to the agent it asked the app to show; the app's own `app_focus`
   * acknowledgment is what makes the move real. `'no_app'` when no Desktop window is connected.
   */
  stepFocus?: (direction: 'next' | 'previous', currentAgentId: string | undefined) => Promise<{ machineId: string; agentId: string } | 'no_agents' | 'no_app'>
  /**
   * One piece of a finger stroke for the focused terminal's scrollback, the way the USB dial's glass
   * reports it — same `dial_scroll` forward, the terminal does the arithmetic. `false` when no Desktop
   * window is connected to scroll.
   */
  scroll?: (phase: 'down' | 'move' | 'up', dy: number, velocity: number) => boolean
  submit: (agentId: string, text: string, deliveryId: string) => void
  cancelDelivery: (deliveryId: string) => boolean
  stop: (agentId: string) => Promise<boolean>
  answer: (agentId: string, questionRequestId: string, answers: Record<string, string>) => Promise<boolean>
  recent: (agentId: string, n: number) => unknown[]
  /**
   * The newest turn's COMPLETE final answer for an agent, or undefined.
   *
   * Read here rather than taken off the `commander_event` payload on purpose. That frame is broadcast to
   * every device on the account, and the USB dial's own encoder throws above an 8 KiB payload
   * (cable/cableFrame.ts) — widening the shared card to serve one consumer would put a limit nobody
   * looks at between the dial and its turn cards.
   */
  fullText?: (agentId: string) => string | undefined
  emit?: (frame: AutonomousDeviceFrame) => void
}
interface Entry { deviceId: string; digest: string; receipt: AutonomousDeviceReceipt }
const CAPABILITIES = ['focus.get', 'focus.ensure', 'focus.step', 'scroll', 'agents.list', 'turn.send', 'turn.stop', 'status', 'recap', 'question.answer', 'receipt.get'] as const
export const AUTONOMOUS_DEVICE_CAPABILITIES: string[] = [...CAPABILITIES]
const MUTATIONS = new Set(['turn.send', 'turn.stop', 'question.answer'])
const STEP_RESULTS_MAX = 512
const SCROLL_PHASES = new Set(['down', 'move', 'up'])
/** Device pixels per report and px/s: generous for any glass, tight enough that a bad value cannot fling a terminal for minutes. */
const SCROLL_DY_MAX = 4096
const SCROLL_VELOCITY_MAX = 100_000
const APP_FOCUS_WAIT_MS = 2000
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
export class AutonomousDeviceService {
  readonly serverInstanceId: string
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly deliveries = new Map<string, Entry>()
  private readonly turns = new Map<string, Entry>()
  private readonly questions = new Map<string, { requestId: string; questions: unknown }>()
  private events: AutonomousDeviceFrame[] = []
  private sequence = 0
  private focusOwner: string | undefined
  private focused: { machineId: string; agentId: string } | null = null
  private focusCounter = 0
  /** Only explicit app focus updates own this state; disconnects cannot clear a newer owner. */
  appFocus(machineId: string, agentId: string | null, connId: string): void {
    if (agentId === null && this.focusOwner !== connId) return
    if (machineId === this.options.machineId && agentId !== null && !this.options.agents().some(a => a.agentId === agentId)) agentId = null
    this.focusOwner = agentId === null ? undefined : connId
    if (agentId === null ? this.focused === null : this.focused?.machineId === machineId && this.focused?.agentId === agentId) return
    this.focused = agentId === null ? null : { machineId, agentId }
    this.focusCounter++
    this.event('focus.changed', undefined, this.focusSnapshot())
  }
  focusSnapshot(): { focus: { machineId: string; agentId: string; name?: string } | null; focusRevision: string } {
    const local = this.focused?.machineId === this.options.machineId
    const agent = local ? this.options.agents().find(a => a.agentId === this.focused?.agentId) : undefined
    if (local && !agent) {
      this.focused = null
      this.focusOwner = undefined
      this.focusCounter++
      const snapshot = { focus: null, focusRevision: `${this.serverInstanceId}:${this.focusCounter}` }
      this.event('focus.changed', undefined, snapshot)
      return snapshot
    }
    return { focus: this.focused ? { ...this.focused, ...(agent ? { name: agent.name } : {}) } : null,
      focusRevision: `${this.serverInstanceId}:${this.focusCounter}` }
  }
  private ensuringFocus: Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> | undefined
  /** Settled `focus.step` outcomes by (device, idempotencyKey): a retried gesture is one tick, not two. */
  private readonly steps = new Map<string, { deviceId: string; digest: string; result: Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> }>()

  private stepFocus(deviceId: string, req: Record<string, unknown>): Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> {
    if (req.direction !== 'next' && req.direction !== 'previous') fail('INVALID_REQUEST', 'direction must be next or previous')
    if (!KEY.test(String(req.idempotencyKey ?? ''))) fail('INVALID_REQUEST', 'Invalid idempotencyKey')
    if (typeof req.focusRevision !== 'string' || !req.focusRevision) fail('INVALID_REQUEST', 'focusRevision must be a nonempty string')
    const digest = createHash('sha256').update(canonical({ ...req, requestId: null, idempotencyKey: null })).digest('hex')
    const key = this.key(deviceId, String(req.idempotencyKey))
    const previous = this.steps.get(key)
    if (previous) {
      if (previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different operation or payload')
      return previous.result
    }
    const result = this.performStep(req.direction, req.focusRevision)
    result.catch(() => undefined) // settled either way; the retry re-awaits it
    this.steps.set(key, { deviceId, digest, result })
    // ponytail: FIFO eviction, no TTL — a step result is a snapshot, nothing waits on it like a receipt.
    if (this.steps.size > STEP_RESULTS_MAX) this.steps.delete(this.steps.keys().next().value as string)
    return result
  }

  private async performStep(direction: 'next' | 'previous', focusRevision: string): Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> {
    const before = this.focusSnapshot()
    if (focusRevision !== before.focusRevision) fail('FOCUS_CHANGED', 'App focus changed before the step; nothing was moved')
    if (!this.options.stepFocus) fail('FOCUS_UNAVAILABLE', 'Stepping focus is not wired on this machine')
    const target = await this.options.stepFocus(direction, before.focus?.agentId)
    if (target === 'no_agents') fail('NO_AGENTS', 'No agent is on the desk to step to')
    if (target === 'no_app') fail('FOCUS_UNAVAILABLE', 'Open Harness Desktop to select an agent')
    // A desk of one: the only neighbour is the agent already in front — nothing to move, nothing to await.
    if (before.focus?.machineId === target.machineId && before.focus.agentId === target.agentId) return before
    return this.waitForAppFocus(Date.now() + APP_FOCUS_WAIT_MS, s => s.focusRevision !== before.focusRevision)
  }

  /**
   * A stroke is a stream, not a mutation: no idempotency key, no receipt, nothing retained. A lost `move`
   * is a shorter scroll; a lost `up` is what the next `down` closes on the app side, as for the dial.
   */
  private scroll(req: Record<string, unknown>): void {
    const phase = req.phase
    if (typeof phase !== 'string' || !SCROLL_PHASES.has(phase)) fail('INVALID_REQUEST', 'phase must be down, move or up')
    const dy = req.dy ?? 0, velocity = req.velocity ?? 0
    if (!Number.isInteger(dy) || Math.abs(dy as number) > SCROLL_DY_MAX) fail('INVALID_REQUEST', `dy must be an integer within ±${SCROLL_DY_MAX}`)
    if (!Number.isInteger(velocity) || Math.abs(velocity as number) > SCROLL_VELOCITY_MAX) fail('INVALID_REQUEST', `velocity must be an integer within ±${SCROLL_VELOCITY_MAX}`)
    if (!this.options.scroll) fail('FOCUS_UNAVAILABLE', 'Scrolling is not wired on this machine')
    if (!this.options.scroll(phase as 'down' | 'move' | 'up', dy as number, velocity as number)) fail('FOCUS_UNAVAILABLE', 'Open Harness Desktop to scroll a terminal')
  }

  /** Enable-time fallback only. The desktop must acknowledge its selected pane. */
  private ensureFocus(): Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> {
    const current = this.focusSnapshot()
    if (current.focus) return Promise.resolve(current)
    if (this.ensuringFocus) return this.ensuringFocus
    const first = this.options.agents()[0]
    if (!first) fail('NO_AGENTS', 'No local agent is available')
    const expiresAt = Date.now() + APP_FOCUS_WAIT_MS
    if (!this.options.requestAppFocus?.(first.agentId, expiresAt, current.focusRevision)) {
      fail('FOCUS_UNAVAILABLE', 'Open Harness Desktop to select an agent')
    }
    this.ensuringFocus = this.waitForAppFocus(expiresAt, s => !!s.focus).finally(() => { this.ensuringFocus = undefined })
    return this.ensuringFocus
  }

  private async waitForAppFocus(expiresAt: number, done: (s: ReturnType<AutonomousDeviceService['focusSnapshot']>) => boolean): Promise<ReturnType<AutonomousDeviceService['focusSnapshot']>> {
    for (;;) {
      const snapshot = this.focusSnapshot()
      if (done(snapshot)) return snapshot
      if (Date.now() >= expiresAt) fail('FOCUS_UNAVAILABLE', 'Harness Desktop did not acknowledge focus')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  constructor(private readonly options: AutonomousDeviceServiceOptions) {
    this.serverInstanceId = options.serverInstanceId ?? randomUUID()
    this.now = options.now ?? Date.now
  }
  private key(deviceId: string, key: string): string { return `${deviceId}:${key}` }
  /** The newest `recap` turn's headline for an agent, or undefined when no turn has been summarised. */
  private latestRecap(agentId: string): string | undefined {
    const first = this.options.recent(agentId, 1)[0]
    const recap = object(first) && typeof first.recap === 'string' ? first.recap.replace(/\s+/g, ' ').trim() : ''
    return recap ? recap.slice(0, AGENT_RECAP_MAX_CHARS) : undefined
  }
  receipt(deviceId: string, key: string): AutonomousDeviceReceipt | null {
    this.prune()
    const value = this.entries.get(this.key(deviceId, key))?.receipt
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
  delivery(event: AutonomousDeviceDelivery): void {
    const entry = this.deliveries.get(event.deliveryId)
    if (!entry) return
    this.update(entry, event.state, event.reason)
  }
  revoke(deviceId: string): void {
    for (const [key, entry] of this.entries) if (entry.deviceId === deviceId) {
      this.options.cancelDelivery(entry.receipt.deliveryId)
      this.deliveries.delete(entry.receipt.deliveryId)
      if (this.turns.get(entry.receipt.agentId) === entry) this.turns.delete(entry.receipt.agentId)
      this.entries.delete(key)
    }
    for (const [key, step] of this.steps) if (step.deviceId === deviceId) this.steps.delete(key)
    // A newly paired identity cannot replay the previous device's request receipts.
    this.events = []
  }
  event(kind: string, agentId: string | undefined, payload: Record<string, unknown>): void {
    const frame: AutonomousDeviceFrame = { type: 'event', eventId: ++this.sequence, serverInstanceId: this.serverInstanceId,
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
  replay(resume: { serverInstanceId?: unknown; cursor?: unknown } | undefined, send: (frame: AutonomousDeviceFrame) => unknown): void {
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
      const full = p.kind === 'summary' ? this.options.fullText?.(agentId) : undefined
      this.event(p.kind === 'summary' ? 'turn.summary' : p.kind === 'tool' ? 'turn.tool' : 'agent.error', agentId, full ? { ...p, fullText: full } : p)
    }
  }
  async request(deviceId: string, req: Record<string, unknown>): Promise<AutonomousDeviceFrame> {
    const type = typeof req.type === 'string' ? req.type : 'invalid'
    const response = (data: Record<string, unknown>): AutonomousDeviceFrame => ({ type: `${type}_result`, requestId: req.requestId, ...data })
    let reserved: Entry | undefined
    try {
      if (!UUID.test(String(req.requestId))) fail('INVALID_REQUEST', 'requestId must be a UUIDv4')
      if (!AUTONOMOUS_DEVICE_CAPABILITIES.includes(type)) fail('UNSUPPORTED_CAPABILITY', 'Operation is not supported')
      const allowed = ['type', 'requestId', ...(['agents.list', 'focus.get', 'focus.ensure'].includes(type) ? [] : type === 'receipt.get' ? ['idempotencyKey'] : type === 'focus.step' ? ['direction', 'idempotencyKey', 'focusRevision'] : type === 'scroll' ? ['phase', 'dy', 'velocity'] : ['machineId', 'agentId']),
        ...(MUTATIONS.has(type) ? ['idempotencyKey'] : []), ...(type === 'turn.send' ? ['text', 'focusRevision'] : type === 'question.answer' ? ['questionRequestId', 'answers', 'focusRevision'] : type === 'recap' ? ['n'] : [])]
      if (Object.keys(req).some(k => !allowed.includes(k))) fail('INVALID_REQUEST', 'Unknown request field')
      if (type === 'receipt.get') {
        if (!KEY.test(String(req.idempotencyKey ?? ''))) fail('INVALID_REQUEST', 'Invalid idempotencyKey')
        return response({ receipt: this.receipt(deviceId, String(req.idempotencyKey)) })
      }
      if (type === 'focus.get') return response(this.focusSnapshot())
      if (type === 'focus.ensure') return response(await this.ensureFocus())
      if (type === 'focus.step') return response(await this.stepFocus(deviceId, req))
      if (type === 'scroll') { this.scroll(req); return response({}) }
      if ('focusRevision' in req && (typeof req.focusRevision !== 'string' || !req.focusRevision)) fail('INVALID_REQUEST', 'focusRevision must be a nonempty string')
      if (type === 'agents.list') {
        return response({ machineId: this.options.machineId, agents: this.options.agents().map(a => {
          const recap = this.latestRecap(a.agentId)
          return { ...a, machineId: this.options.machineId, ...(recap ? { recap } : {}) }
        }) })
      }
      if (typeof req.agentId !== 'string' || !req.agentId || typeof req.machineId !== 'string') fail('MISSING_TARGET', 'machineId and agentId are required')
      if (req.machineId !== this.options.machineId) fail('MACHINE_MISMATCH', 'Only the paired machine is available')
      const agentId = req.agentId as string
      if (type === 'turn.send' && (typeof req.text !== 'string' || !req.text.trim())) fail('INVALID_REQUEST', 'text must be nonempty')
      if (type === 'turn.send' && Buffer.byteLength(String(req.text)) > 16384) fail('PAYLOAD_TOO_LARGE', 'Prompt exceeds 16 KiB')
      if (type === 'question.answer' && (typeof req.questionRequestId !== 'string' || !req.questionRequestId || !object(req.answers)
        || !Object.keys(req.answers).length || Object.values(req.answers).some(v => typeof v !== 'string'))) fail('INVALID_REQUEST', 'questionRequestId and string answers are required')
      if (MUTATIONS.has(type) && !KEY.test(String(req.idempotencyKey ?? ''))) fail('INVALID_REQUEST', 'Invalid idempotencyKey')
      const digest = createHash('sha256').update(canonical({ ...req, requestId: null, idempotencyKey: null })).digest('hex')
      const key = this.key(deviceId, String(req.idempotencyKey))
      this.prune()
      const previous = MUTATIONS.has(type) ? this.entries.get(key) : undefined
      if (previous) {
        if (previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different operation or payload')
        return response({ status: 'duplicate', receipt: structuredClone(previous.receipt) })
      }
      if ('focusRevision' in req) {
        const snapshot = this.focusSnapshot()
        if (req.focusRevision !== snapshot.focusRevision || snapshot.focus?.machineId !== req.machineId || snapshot.focus?.agentId !== agentId) {
          fail('FOCUS_CHANGED', 'App focus changed before dispatch; no operation was reserved')
        }
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
      const entry: Entry = { deviceId, digest, receipt: { idempotencyKey: String(req.idempotencyKey), deliveryId: randomUUID(), operation: type,
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
