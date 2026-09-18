import type { Identity } from '../lib/e2ee/core.js'
import { b64e } from '../lib/e2ee/core.js'
import { projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import type { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import { encodeTerminalLocal } from '../lib/terminalBinary.js'
import { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import { HarnessGrantStore, inviteSchema, type HarnessGrant } from './grants.js'
import { ownerHandshake, type ObserverCipher } from './crypto.js'

type Payload = Record<string, unknown>
interface Observer { grant: HarnessGrant; cipher: ObserverCipher }
export interface ShareOwnerDeps {
  machineId: () => string
  identity: Identity
  grants: HarnessGrantStore
  terminals: TerminalBackendCoordinator
  resolveAgent: (id: string) => RegisteredSession | undefined
  send: (connId: string, type: string, payload: Payload) => boolean
  publish: (method: 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  watchViewer?: (agentId: string, send: (payload: Payload) => void) => (() => void)
  now?: () => number
}

/** This is the complete observer dispatch surface. It never calls the ordinary daemon RPC switch. */
export class HarnessShareOwner {
  private readonly observers = new Map<string, Observer>()
  private readonly viewers = new Map<string, () => void>()
  private readonly streams: TerminalStreamManager
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private syncing: Promise<void> | null = null
  private mutation: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: ShareOwnerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.streams = new TerminalStreamManager({ readOnly: true, terminals: deps.terminals,
      resolveAgent: deps.resolveAgent, streamingAvailable: true,
      sendTarget: (id, type, payload) => this.send(id, { type, payload }),
      sendBinaryTarget: (id, frame) => {
        const bytes = encodeTerminalLocal(frame)
        return bytes !== null && this.send(id, { type: 'observer_binary',
          payload: { bytes: Buffer.from(bytes).toString('base64') } })
      },
    })
    let ticks = 0
    this.timer = setInterval(() => {
      for (const [id, observer] of this.observers) {
        if (!this.authorized(observer)) this.close(id, 'Sharing ended or invitation expired')
      }
      if (++ticks % 30 === 0) void this.sync()
    }, 1000)
    this.timer.unref()
  }
  private authorized(observer: Observer): boolean {
    return !!this.deps.grants.active(observer.grant.id, observer.grant.recipientEmail, this.deps.machineId())
      && !!this.deps.resolveAgent(observer.grant.agentId)
  }
  private send(connId: string, frame: Payload): boolean {
    const observer = this.observers.get(connId)
    if (!observer || !this.authorized(observer)) return false
    return this.deps.send(connId, 'observer_frame', observer.cipher.seal(frame) as unknown as Payload)
  }
  close(connId: string, reason = 'Observation ended', retry = false): void {
    if (!this.observers.delete(connId)) return
    this.viewers.get(connId)?.()
    this.viewers.delete(connId)
    void this.streams.closeConnection(connId)
    this.deps.send(connId, 'observer_closed', { reason, retry })
  }
  closeAll(): void { for (const id of this.observers.keys()) this.close(id, 'Owner disconnected', true) }
  async stop(): Promise<void> { clearInterval(this.timer); this.closeAll(); await this.streams.stop() }

  async receive(connId: string, type: string, payload: Payload): Promise<void> {
    if (!connId.startsWith('observer:')) return
    if (type === 'observer_close') { this.close(connId); return }
    if (type === 'observer_open') {
      if (this.observers.has(connId)) { this.close(connId, 'Invalid observer handshake'); return }
      const grant = this.deps.grants.active(String(payload.shareId), String(payload.email), this.deps.machineId())
      if (!grant || !this.deps.resolveAgent(grant.agentId) || this.observers.size >= 100) {
        this.deps.send(connId, 'observer_closed', { reason: 'Sharing ended or invitation expired' }); return
      }
      try {
        const { cipher, welcome } = ownerHandshake(this.deps.identity, grant.machineId, grant.id, String(payload.ephemeral))
        this.observers.set(connId, { grant, cipher })
        if (!this.deps.send(connId, 'observer_welcome', welcome)) this.close(connId)
      } catch { this.deps.send(connId, 'observer_closed', { reason: 'Invalid observer handshake' }) }
      return
    }
    const observer = this.observers.get(connId)
    if (!observer) return
    if (!this.authorized(observer)) { this.close(connId, 'Sharing ended or invitation expired'); return }
    const frame = type === 'observer_frame' ? observer.cipher.open(payload) : null
    if (!frame || typeof frame.type !== 'string' || !frame.payload || typeof frame.payload !== 'object') {
      this.close(connId, 'Invalid observer message'); return
    }
    const p = frame.payload as Payload
    const allowed = ['terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack',
      'terminal_resync', 'terminal_close', 'observer_viewer']
    if (!allowed.includes(frame.type) || (p.agentId !== undefined && p.agentId !== observer.grant.agentId)
      || (frame.type === 'terminal_open' && p.agentId !== observer.grant.agentId)) {
      this.send(connId, { type: 'terminal_error', payload: { requestId: p.requestId, code: 'VIEW_ONLY' } })
      return
    }
    if (frame.type === 'observer_viewer') {
      if (!this.viewers.has(connId) && this.deps.watchViewer) {
        this.viewers.set(connId, this.deps.watchViewer(observer.grant.agentId,
          data => { this.send(connId, { type: 'observer_viewer', payload: data }) }))
      }
      return
    }
    await this.streams.handleFrame(connId, frame.type, p)
  }

  /** Owner controls are serialized so a delayed publish cannot undo a subsequent removal. */
  manage(type: string, payload: Payload): Promise<Payload> {
    const work = this.mutation.then(() => this.manageOne(type, payload))
    this.mutation = work.catch(() => {})
    return work
  }
  private async manageOne(type: string, payload: Payload): Promise<Payload> {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const session = this.deps.resolveAgent(agentId)
    if (!session) return { error: 'HARNESS_NOT_FOUND', detail: 'This harness is no longer available.' }
    const machineId = this.deps.machineId()
    if (type === 'harness_share_invite') {
      const parsed = inviteSchema.safeParse(payload)
      if (!parsed.success) return { error: 'INVALID_INVITATION', detail: 'Enter valid email addresses and choose an expiry.' }
      for (const email of new Set(parsed.data.emails)) {
        this.deps.grants.invite({ machineId, agentId, recipientEmail: email,
          name: projectDisplayName(session), engine: session.engine,
          ownerPublicKey: b64e(this.deps.identity.pub),
          expiresAt: new Date(this.now() + parsed.data.days * 86400_000).toISOString() })
      }
      await this.syncing
      await this.sync()
    } else if (type === 'harness_share_remove') {
      if (typeof payload.id !== 'string' || !this.deps.grants.revoke(payload.id, machineId, agentId)) {
        return { error: 'INVITATION_NOT_FOUND', detail: 'This invitation is no longer available.' }
      }
      for (const [id, observer] of this.observers) if (observer.grant.id === payload.id) this.close(id, 'Access removed')
      await this.syncing
      await this.sync()
    } else if (type !== 'harness_share_list') return { error: 'UNSUPPORTED' }
    return { shares: this.deps.grants.list(machineId, agentId).map(grant => ({
      id: grant.id, email: grant.recipientEmail, expiresAt: grant.expiresAt,
      expired: Date.parse(grant.expiresAt) <= this.now(), pending: grant.pending, error: grant.publicationError,
      watching: [...this.observers.values()].filter(o => o.grant.id === grant.id).length,
    })) }
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing
    const run = async () => {
      for (const grant of this.deps.grants.all().filter(g => g.pending && g.machineId === this.deps.machineId())) {
        try {
          const result = await this.deps.publish(grant.revoked ? 'DELETE' : 'PUT', `/api/harness-shares/${grant.id}`,
            grant.revoked ? undefined : { machineId: grant.machineId, agentId: grant.agentId,
              recipientEmail: grant.recipientEmail, name: grant.name, engine: grant.engine,
              ownerPublicKey: grant.ownerPublicKey, expiresAt: grant.expiresAt })
          if (result.status >= 200 && result.status < 300 || grant.revoked && result.status === 404) {
            // A revoke may have happened while this network request was in flight.
            const current = this.deps.grants.all().find(g => g.id === grant.id)
            if (current?.revoked === grant.revoked && current.expiresAt === grant.expiresAt) this.deps.grants.synced(grant.id)
          } else if (!grant.revoked && [400, 403, 409, 422].includes(result.status)) {
            const body = result.body as { error?: { message?: string }; message?: string }
            const current = this.deps.grants.all().find(g => g.id === grant.id)
            if (current && !current.revoked && current.expiresAt === grant.expiresAt) {
              this.deps.grants.failed(grant.id, body.error?.message || body.message || 'This invitation could not be shared. Remove it or add the email again to retry.')
            }
          }
        } catch { /* Persisted pending change is retried, including after daemon restart. */ }
      }
    }
    this.syncing = run().finally(() => { this.syncing = null })
    return this.syncing
  }
}
