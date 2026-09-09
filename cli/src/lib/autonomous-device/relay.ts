import { isWrapped } from '../e2ee/core.js'
import type { E2eeManager } from '../e2ee/manager.js'
import { AUTONOMOUS_DEVICE_CAPABILITIES, type AutonomousDeviceService, type AutonomousDeviceFrame } from './service.js'

type Frame = Record<string, unknown>
/** Application RPC over the existing relay E2EE session. No socket, identity, PAKE or trust of its own. */
export class AutonomousDeviceRelay {
  private readonly clients = new Map<string, { identity: string; tokens: number; at: number; active: number }>()
  constructor(private readonly crypto: Pick<E2eeManager, 'sessionIdentity' | 'sessionRole' | 'unwrapDown' | 'wrapTarget'>,
    private readonly send: (connId: string, frame: Frame) => void,
    private readonly service: AutonomousDeviceService, private readonly machineId: string, private readonly onReady?: () => void,
    private readonly onRemoteRevoke?: (identity: string) => void) {}
  count(include: (connId: string) => boolean = () => true): number { return [...this.clients].filter(([id, client]) => include(id) && this.crypto.sessionIdentity(id) === client.identity && this.crypto.sessionRole(id) === 'device').length }
  connected(): boolean { return this.count() > 0 }
  private sendTo(connId: string, identity: string, type: string, payload: Frame): void {
    if (this.crypto.sessionIdentity(connId) !== identity || this.crypto.sessionRole(connId) !== 'device') return
    const wrapped = this.crypto.wrapTarget(connId, type, payload)
    if (wrapped) this.send(connId, wrapped)
  }
  async handle(connId: string, frame: Frame): Promise<void> {
    for (const [id, client] of this.clients) if (this.crypto.sessionIdentity(id) !== client.identity) this.clients.delete(id)
    const identity = this.crypto.sessionIdentity(connId)
    if (!identity || this.crypto.sessionRole(connId) !== 'device' || !isWrapped(frame.payload) || frame.dbSessionId !== undefined) return
    const opened = this.crypto.unwrapDown(connId, frame)
    const req = opened?.payload as Frame | undefined
    if (!req || typeof req !== 'object' || Array.isArray(req)) return
    const reply = (payload: Frame) => this.sendTo(connId, identity, 'autonomous_device_result', payload)
    if (req.type === 'hello') {
      if (req.proto !== 1 || typeof req.requestId !== 'string') { reply({ type: 'hello_result', requestId: req.requestId, error: { code: 'PROTO_UNSUPPORTED', message: 'Protocol 1 required' } }); return }
      const current = this.clients.get(connId)
      this.clients.set(connId, current?.identity === identity ? current : { identity, tokens: 20, at: Date.now(), active: 0 })
      const resume = req.resume as { serverInstanceId?: unknown; cursor?: unknown } | undefined
      reply({ type: 'hello_result', requestId: req.requestId, proto: 1, machineId: this.machineId, serverInstanceId: this.service.serverInstanceId, capabilities: AUTONOMOUS_DEVICE_CAPABILITIES, ...this.service.resume(resume) })
      this.service.replay(resume, event => this.sendEvent(connId, identity, event))
      this.onReady?.()
      return
    }
    const client = this.clients.get(connId)
    if (!client || client.identity !== identity) { reply({ type: `${req.type}_result`, requestId: req.requestId, error: { code: 'HELLO_REQUIRED', message: 'Send application hello first' } }); return }
    // A device deleting its local trust must say so while the authenticated channel still exists.
    // A socket close alone is deliberately only an offline signal: treating it as revocation would
    // unpair users whenever their LAN briefly drops.
    if (req.type === 'pair.revoke') {
      if (typeof req.requestId !== 'string' || Object.keys(req).some(key => key !== 'type' && key !== 'requestId')) {
        reply({ type: 'pair.revoke_result', requestId: req.requestId, error: { code: 'INVALID_REQUEST', message: 'Invalid device revoke request' } })
        return
      }
      reply({ type: 'pair.revoke_result', requestId: req.requestId, revoked: true })
      this.onRemoteRevoke?.(identity)
      return
    }
    const now = Date.now(); client.tokens = Math.min(20, client.tokens + Math.max(0, now - client.at) / 1000); client.at = now
    const error = client.tokens < 1 ? 'RATE_LIMITED' : client.active >= 4 ? 'BACKPRESSURE' : null
    if (error) { reply({ type: `${req.type}_result`, requestId: req.requestId, error: { code: error, message: error } }); return }
    client.tokens--; client.active++
    try { reply(await this.service.request(identity, req)) } finally { client.active-- }
  }
  private sendEvent(connId: string, identity: string, event: AutonomousDeviceFrame): void {
    const p = event.payload as Frame | undefined
    if (typeof p?.idempotencyKey === 'string') {
      const own = this.service.receipt(identity, p.idempotencyKey)
      const receipt = p.receipt as Frame | undefined
      if (!own || (receipt && receipt.deliveryId !== own.deliveryId) || (p.turnId && p.turnId !== own.turnId)) return
    }
    this.sendTo(connId, identity, 'autonomous_device_event', event)
  }
  emit(event: AutonomousDeviceFrame): void { for (const [connId, client] of this.clients) this.sendEvent(connId, client.identity, event) }
  drop(connId: string): void { this.clients.delete(connId) }
  revoke(identity: string): void { for (const [connId, client] of this.clients) if (client.identity === identity) this.clients.delete(connId); this.service.revoke(identity) }
}
