import { b64d, fingerprint } from '../e2ee/core.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { renameSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from '../secureState.js'
import { discoverDevices, type DiscoveredDevice } from './discovery.js'
import type { PairResult } from '../e2ee/manager.js'
export interface DirectDeviceHost {
  machineId: string
  label: string
  receive(connId: string, frame: Record<string, unknown>, pairingAllowed: boolean): Promise<void>
  attach(connId: string, send: (frame: Record<string, unknown>) => void): void
  detach(connId: string): void
  authenticatedFingerprint(connId: string): string | null
  pairedFingerprint(connId: string): string | null
  pending(): { pairId: string; role: string } | null
  pendingConnection(): string | null
  pair(code: string): Promise<PairResult>
  paired(): Array<{ fingerprint: string; role: string }>
}
interface Association { discoveryId: string; fingerprint: string }
interface Link { ws: WebSocket; connId: string; ready: Promise<void> }
/** Outbound direct sockets share the daemon's original E2eeManager; metadata contains no keys. */
export class AutonomousDeviceDirect {
  private readonly links = new Map<string, Link>()
  private readonly candidates = new Map<string, DiscoveredDevice>()
  private associations: Association[] = []
  private timer?: ReturnType<typeof setInterval>
  private discovering?: Promise<DiscoveredDevice[]>
  private stopping = false
  private pairing = false
  private readonly file: string
  constructor(private readonly host: DirectDeviceHost, private readonly dataDir: string, private readonly discovery = discoverDevices) {
    secureStateDirectory(dataDir); this.file = join(dataDir, 'autonomous-device-connections.json')
    if (hardenPrivateStateFileIfPresent(this.file, 65536)) {
      const value: unknown = JSON.parse(readPrivateStateFile(this.file, 65536))
      if (!Array.isArray(value) || value.some(r => !r || typeof r.discoveryId !== 'string' || typeof r.fingerprint !== 'string')) throw new Error('Invalid device connection metadata')
      this.associations = value
    }
  }
  private save(): void {
    secureStateDirectory(this.dataDir); hardenPrivateStateFileIfPresent(this.file, 65536)
    const temp = `${this.file}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(this.associations), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.file)
  }
  discover(): Promise<DiscoveredDevice[]> {
    if (!this.discovering) this.discovering = this.discovery().then(rows => { this.candidates.clear(); for (const row of rows) this.candidates.set(row.id, row); return rows }).finally(() => { this.discovering = undefined })
    return this.discovering
  }
  start(): void { this.stopping = false; void this.reconnect(); this.timer = setInterval(() => void this.reconnect(), 15000); this.timer.unref() }
  stop(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); for (const link of this.links.values()) link.ws.terminate(); this.links.clear() }
  connected(): number { return [...this.links.values()].filter(l => l.ws.readyState === WebSocket.OPEN).length }
  async pair(device: string, code: string): Promise<Record<string, unknown>> {
    if (this.pairing) throw Object.assign(new Error('Pairing already active'), { code: 'BUSY' })
    this.pairing = true
    let success = false
    try {
      await this.discover()
      const candidate = this.candidates.get(device)
      if (!candidate) throw Object.assign(new Error('Selected device is no longer discoverable'), { code: 'DEVICE_NOT_FOUND' })
      const old = this.links.get(device); if (old) { old.ws.terminate(); this.links.delete(device) }
      await this.connect(candidate, true)
      const link = this.links.get(device)!
      const deadline = Date.now() + 10000
      while (this.host.pendingConnection() !== link.connId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      if (this.host.pendingConnection() !== link.connId || this.host.pending()?.role !== 'device') throw Object.assign(new Error('Open pairing on the selected device'), { code: 'NO_INTENT' })
      const result = await this.host.pair(code)
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error })
      const peerFingerprint = this.host.pairedFingerprint(link.connId)
      if (!peerFingerprint) throw new Error('Paired device identity unavailable')
      const authDeadline = Date.now() + 15000
      while (!this.host.authenticatedFingerprint(link.connId) && Date.now() < authDeadline && link.ws.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 25))
      if (this.host.authenticatedFingerprint(link.connId) !== peerFingerprint) throw new Error('Paired device session did not authenticate')
      this.associations = this.associations.filter(a => a.discoveryId !== device && a.fingerprint !== peerFingerprint)
      this.associations.push({ discoveryId: device, fingerprint: peerFingerprint }); this.save()
      success = true
      return { state: 'paired', label: result.label, fingerprint: peerFingerprint ?? result.fingerprint }
    } finally { this.pairing = false; if (!success) { this.links.get(device)?.ws.terminate(); this.links.delete(device) } }
  }
  revoked(fingerprint: string): void {
    const ids = this.associations.filter(a => a.fingerprint === fingerprint).map(a => a.discoveryId)
    this.associations = this.associations.filter(a => a.fingerprint !== fingerprint)
    for (const id of ids) { this.links.get(id)?.ws.terminate(); this.links.delete(id) }
    this.save()
  }
  private async reconnect(): Promise<void> {
    if (this.stopping || this.pairing || !this.associations.length) return
    try {
      const trusted = new Set(this.host.paired().filter(p => p.role === 'device').map(p => p.fingerprint))
      for (const a of [...this.associations]) if (!trusted.has(a.fingerprint)) this.revoked(a.fingerprint)
      await this.discover()
      if (this.stopping || this.pairing) return
      for (const a of this.associations) { const candidate = this.candidates.get(a.discoveryId); if (candidate && !this.links.has(a.discoveryId)) await this.connect(candidate).catch(() => {}) }
    } catch { /* Offline discovery retries without changing trust. */ }
  }
  private connect(candidate: DiscoveredDevice, pairingAllowed = false): Promise<void> {
    const existing = this.links.get(candidate.id); if (existing) return existing.ready
    const url = new URL(`http://${candidate.host.includes(':') ? `[${candidate.host}]` : candidate.host}:${candidate.port}`); url.protocol = 'ws:'; url.pathname = '/api/harness/ws'
    const ws = new WebSocket(url, { maxPayload: 65536, handshakeTimeout: 10000 }), connId = `autonomous-direct:${randomUUID()}`
    const expected = pairingAllowed ? undefined : this.associations.find(a => a.discoveryId === candidate.id)?.fingerprint
    const authTimer = setTimeout(() => { if (!this.host.authenticatedFingerprint(connId)) ws.terminate() }, 20000)
    ws.once('close', () => clearTimeout(authTimer))
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Device connection timed out')) }, 10000)
      ws.once('open', () => {
        clearTimeout(timer)
        this.host.attach(connId, frame => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)) })
        ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: this.host.machineId, label: this.host.label } })); resolve()
      })
      ws.once('error', error => { clearTimeout(timer); reject(error) })
      ws.once('close', () => { clearTimeout(timer); reject(new Error('Device connection closed')); this.host.detach(connId); if (this.links.get(candidate.id)?.ws === ws) this.links.delete(candidate.id) })
    })
    ws.on('message', raw => { try { const frame = JSON.parse(raw.toString()) as Record<string, unknown>; if (frame && typeof frame === 'object' && !Array.isArray(frame)) void (async () => {
      if (expected && frame.type === 'e2e_hello') {
        const payload = frame.payload as { identityPub?: unknown } | undefined
        if (typeof payload?.identityPub !== 'string' || fingerprint(b64d(payload.identityPub)) !== expected) { ws.close(4401); return }
      }
      await this.host.receive(connId, frame, pairingAllowed && this.pairing)
      if (this.host.authenticatedFingerprint(connId)) clearTimeout(authTimer)
    })().catch(() => ws.close(1011)) } catch { ws.close(1007) } })
    this.links.set(candidate.id, { ws, connId, ready }); return ready
  }
}
