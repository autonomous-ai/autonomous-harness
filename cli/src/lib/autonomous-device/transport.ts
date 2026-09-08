import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { aeadOpen, aeadSeal, b64d, b64e, cpaceGenerator, cpaceISK, cpaceShared, cpaceStart, fingerprint, kcKeys, macTag, macVerify, newEphemeral, newPairCode, pairBindSig, pairBindVerify, pairKey, sessionKeys, transcriptHash, unwrapPayload, utf8, wrapPayload, type Identity } from '../e2ee/core.js'
import { ReplayWindow } from '../e2ee/replayWindow.js'
import { decodeFixed, autonomousDeviceContext, signFrame, verifyFrame } from './crypto.js'
import { AutonomousDeviceStore } from './store.js'

export type AutonomousDeviceFrame = Record<string, unknown>
export type AutonomousDeviceSend = (frame: AutonomousDeviceFrame) => boolean
export interface AutonomousDeviceResume { serverInstanceId: string; cursor: number }
export interface AutonomousDeviceTransportOptions {
  machineId: string; machineName: string; identity: Identity; dataDir: string; serverInstanceId: string
  bind?: string; port?: number; capabilities: string[]; limits?: AutonomousDeviceFrame
  resume?: (resume?: AutonomousDeviceResume) => { resumed: boolean; cursor: number }
  onRequest: (deviceId: string, request: AutonomousDeviceFrame, send: AutonomousDeviceSend, capabilities: string[]) => void | Promise<void>
  onConnected?: (deviceId: string, resume: AutonomousDeviceResume | undefined, send: AutonomousDeviceSend) => void
  onDisconnected?: (deviceId: string) => void
  onRevoked?: (deviceId: string) => void
}
export class AutonomousDeviceTransportError extends Error {
  constructor(public readonly code: string, message = code) { super(message) }
}
interface PairWindow { code: string; expiresAt: number; attempts: number; socket?: WebSocket; pairId?: string; y?: bigint; ya?: Uint8Array; th?: Uint8Array; key?: Uint8Array; label?: string }
interface Session { ws: WebSocket; deviceId: string; pub: string; keys: ReturnType<typeof sessionKeys>; rx: ReplayWindow; tx: number; ready: boolean; capabilities: string[]; resume?: AutonomousDeviceResume; challenge: string }
export class AutonomousDeviceTransport {
  readonly store: AutonomousDeviceStore
  private server?: Server
  private wss?: WebSocketServer
  private opening?: Promise<void>
  private window?: PairWindow
  private pairState: AutonomousDeviceFrame = { state: 'idle' }
  private session?: Session
  private readonly sessions = new Map<WebSocket, Session>()
  private timer?: ReturnType<typeof setInterval>
  private actualPort = 0
  private readonly requests = new Map<string, { tokens: number; at: number; inFlight: number }>()
  private stopping = false
  private pairingStarting = false
  constructor(private readonly options: AutonomousDeviceTransportOptions) { this.store = new AutonomousDeviceStore(options.dataDir) }
  async start(): Promise<void> { if (this.store.paired() || this.store.pending()) await this.listen() }
  private async listen(): Promise<void> {
    if (this.opening) return this.opening
    if (this.server) return
    this.opening = new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => { res.writeHead(404); res.end() })
      const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })
      server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/api/autonomous-device-ws' || req.headers.origin || req.headers.authorization || req.headers.cookie || req.headers['sec-websocket-protocol'] || wss.clients.size >= 16) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => this.connect(ws))
      })
      const onError = (error: Error) => { server.close(); wss.close(); reject(error) }
      server.once('error', onError)
      server.listen(this.options.port ?? 18474, this.options.bind ?? '0.0.0.0', () => {
        server.removeListener('error', onError)
        server.on('error', () => { /* Socket errors must not reveal request content. */ })
        this.server = server; this.wss = wss
        this.actualPort = (server.address() as { port: number }).port
        this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); resolve()
      })
    }).finally(() => { this.opening = undefined })
    return this.opening
  }
  private tick(): void {
    this.store.expire()
    if (this.window && Date.now() >= this.window.expiresAt) this.finishPair('EXPIRED')
    if (!this.window && !this.store.paired() && !this.store.pending()) void this.stop()
  }
  private address(): string {
    let host = this.options.bind ?? '0.0.0.0'
    if (host === '0.0.0.0' || host === '::') host = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1'
    return `${host.includes(':') ? `[${host}]` : host}:${this.actualPort || this.options.port || 18474}`
  }
  async pairStart(input: { replace?: boolean } = {}): Promise<AutonomousDeviceFrame> {
    if (this.window || this.pairingStarting) throw new AutonomousDeviceTransportError('BUSY')
    if (this.store.paired() && !input.replace) throw new AutonomousDeviceTransportError('ALREADY_PAIRED')
    this.pairingStarting = true
    try { await this.listen() } finally { this.pairingStarting = false }
    this.store.clearPending()
    this.window = { code: newPairCode(), expiresAt: Date.now() + 60_000, attempts: 0 }
    this.pairState = { state: 'waiting', expiresAt: this.window.expiresAt }
    return { code: this.window.code, expiresAt: this.window.expiresAt, machineId: this.options.machineId, machineName: this.options.machineName, address: this.address(), fingerprint: fingerprint(this.options.identity.pub) }
  }
  pairCancel(): { cancelled: true } { this.finishPair('CANCELLED'); this.store.clearPending(); return { cancelled: true } }
  pairStatus(): AutonomousDeviceFrame { return { ...this.pairState } }
  list(): AutonomousDeviceFrame[] {
    return [this.store.paired(), this.store.pending()].filter(r => r !== null).map(r => ({ id: r.id, label: r.label, fingerprint: fingerprint(b64d(r.identityPub)), pairedAt: r.pairedAt, lastSeenAt: r.lastSeenAt, enabled: true, pendingFirstSession: r.pendingFirstSession, online: this.session?.deviceId === r.id && this.session.ready }))
  }
  status(): AutonomousDeviceFrame { return { listening: !!this.server, bind: this.options.bind ?? '0.0.0.0', port: this.actualPort || this.options.port || 18474, address: this.address(), paired: Number(!!this.store.paired()), sessions: Number(!!this.session?.ready), serverInstanceId: this.options.serverInstanceId, proto: 1 } }
  revoke(id: string): number {
    const ids = [this.store.paired(), this.store.pending()].filter(r => r && (id === 'all' || id === r.id)).map(r => r!.id)
    const count = this.store.revoke(id)
    if (id === 'all') this.finishPair('CANCELLED')
    for (const s of this.sessions.values()) if (ids.includes(s.deviceId)) this.drop(s, 4403, 'REVOKED')
    for (const deviceId of ids) { this.requests.delete(deviceId); this.options.onRevoked?.(deviceId) }
    return count
  }
  send(frame: AutonomousDeviceFrame): boolean { return this.session ? this.sendSession(this.session, frame) : false }
  private sendSession(s: Session, frame: AutonomousDeviceFrame): boolean {
    if (!s.ready || this.session !== s || s.ws.readyState !== WebSocket.OPEN) return false
    if (s.ws.bufferedAmount > 1024 * 1024) { this.drop(s, 1011, 'BACKPRESSURE'); return false }
    if (typeof frame.type !== 'string') return false
    const agentId = typeof frame.agentId === 'string' ? frame.agentId : undefined
    const wire = { type: frame.type, ...(agentId ? { agentId } : {}), payload: wrapPayload(s.keys.s2c, 'p', s.tx++, frame.type, agentId, frame) }
    if (Buffer.byteLength(JSON.stringify(wire)) > 65536) { this.drop(s, 4413, 'PAYLOAD_TOO_LARGE'); return false }
    s.ws.send(JSON.stringify(wire)); return true
  }
  private drop(s: Session, code: number, reason: string): void {
    s.ready = false
    this.sessions.delete(s.ws)
    if (this.session === s) { this.session = undefined; this.options.onDisconnected?.(s.deviceId) }
    s.ws.close(code, reason)
  }
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.opening) await this.opening.catch(() => {})
    this.finishPair('CANCELLED')
    if (this.timer) clearInterval(this.timer)
    for (const s of this.sessions.values()) this.drop(s, 1001, 'SHUTDOWN')
    for (const ws of this.wss?.clients ?? []) ws.terminate()
    const server = this.server; this.server = undefined
    this.wss?.close(); this.wss = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    this.stopping = false
  }
  private clear(ws: WebSocket, frame: AutonomousDeviceFrame): void { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)) }
  private deny(ws: WebSocket, code: string, close = 4401): void { this.clear(ws, { type: 'autonomous_device_denied', error: { code, message: code } }); ws.close(close, code) }
  private finishPair(error?: string): void {
    const w = this.window; this.window = undefined
    if (w?.socket && error) this.clear(w.socket, { type: 'autonomous_device_pair_error', error: { code: error, message: error } })
    if (w) this.pairState = error ? { state: 'failed', error } : { state: 'paired' }
  }
  private connect(ws: WebSocket): void {
    let alive = true
    const deadline = setTimeout(() => { if (!this.sessions.get(ws)?.ready && this.window?.socket !== ws) ws.close(4401, 'TIMEOUT') }, 10_000)
    const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return }; alive = false; ws.ping() }, 20_000)
    ws.on('pong', () => { alive = true })
    ws.on('error', () => {})
    ws.on('close', () => {
      clearTimeout(deadline); clearInterval(heartbeat)
      const s = this.sessions.get(ws); this.sessions.delete(ws)
      if (s && this.session === s) { this.session = undefined; this.options.onDisconnected?.(s.deviceId) }
      if (this.window?.socket === ws) this.finishPair('CANCELLED')
    })
    ws.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('binary frame')
        const f: unknown = JSON.parse(raw.toString())
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('invalid frame')
        this.receive(ws, f as AutonomousDeviceFrame)
      } catch { this.deny(ws, 'INVALID_FRAME') }
    })
  }
  private receive(ws: WebSocket, f: AutonomousDeviceFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const s = this.sessions.get(ws)
    if (s) {
      if (typeof f.type !== 'string' || (f.agentId !== undefined && typeof f.agentId !== 'string')) return
      const env = (f.payload as { __e2e?: Parameters<typeof unwrapPayload>[1] } | undefined)?.__e2e
      if (!env || env.v !== 1 || env.k !== 'p' || env.epoch !== undefined || typeof env.ct !== 'string' || !s.rx.allows(env.n)) return
      const value = unwrapPayload(s.keys.c2s, env, f.type, f.agentId as string | undefined)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const request = value as AutonomousDeviceFrame
      if (request.type !== f.type || request.agentId !== f.agentId) return
      s.rx.commit(env.n)
      if (!s.ready) {
        if (request.type !== 'autonomous_device_finished' || request.challenge !== s.challenge) return
        const old = this.store.paired()
        if (!this.store.find(s.pub)) { this.deny(ws, 'REVOKED', 4403); return }
        const confirmed = this.store.confirm(s.pub)
        this.pairState = { state: 'paired', pendingFirstSession: false, deviceLabel: confirmed.label, deviceFingerprint: fingerprint(b64d(s.pub)) }
        if (this.session) this.drop(this.session, old?.identityPub === s.pub ? 4408 : 4410, old?.identityPub === s.pub ? 'SUPERSEDED' : 'REPLACED')
        if (old && old.identityPub !== s.pub) { this.requests.delete(old.id); this.options.onRevoked?.(old.id) }
        s.ready = true; this.session = s
        this.sendSession(s, { type: 'autonomous_device_ready', serverInstanceId: this.options.serverInstanceId })
        this.options.onConnected?.(s.deviceId, s.resume, frame => this.sendSession(s, frame))
        return
      }
      if (this.session !== s) return
      const now = Date.now(), budget = this.requests.get(s.deviceId) ?? { tokens: 20, at: now, inFlight: 0 }
      budget.tokens = Math.min(20, budget.tokens + Math.max(0, now - budget.at) / 1000); budget.at = now
      this.requests.set(s.deviceId, budget)
      const error = budget.tokens < 1 ? 'RATE_LIMITED' : budget.inFlight >= 4 ? 'BACKPRESSURE' : null
      if (error) { this.sendSession(s, { type: `${request.type}_result`, requestId: request.requestId, error: { code: error, message: error } }); return }
      budget.tokens--; budget.inFlight++
      void Promise.resolve().then(() => { if (s.ready && this.session === s && this.store.find(s.pub)) return this.options.onRequest(s.deviceId, request, frame => this.sendSession(s, frame), s.capabilities) })
        .catch(() => this.sendSession(s, { type: `${request.type}_result`, requestId: request.requestId, error: { code: 'INTERNAL', message: 'Request failed' } }))
        .finally(() => { budget.inFlight-- })
      return
    }
    if (f.type === 'autonomous_device_pair_intent' || f.type === 'autonomous_device_pake') { this.pair(ws, f); return }
    if (f.type !== 'autonomous_device_hello') { this.deny(ws, 'UNAUTHORIZED'); return }
    if (f.machineId !== this.options.machineId) { this.deny(ws, 'MACHINE_MISMATCH'); return }
    const row = typeof f.deviceId === 'string' ? this.store.find(f.deviceId) : null
    if (!row) { this.deny(ws, 'UNKNOWN_DEVICE', 4404); return }
    if (!verifyFrame('hello', this.options.machineId, f, b64d(row.identityPub))) { this.deny(ws, 'UNAUTHORIZED'); return }
    if (f.proto !== 1) { this.deny(ws, 'PROTO_UNSUPPORTED', 4409); return }
    if (!Array.isArray(f.capabilities) || !f.capabilities.every(c => typeof c === 'string')) throw new Error('capabilities')
    const peerEph = decodeFixed(f.ephPub, 32), eph = newEphemeral()
    let resume: AutonomousDeviceResume | undefined
    if (f.resume !== undefined) {
      const r = f.resume as AutonomousDeviceResume
      if (!r || typeof r.serverInstanceId !== 'string' || !Number.isSafeInteger(r.cursor) || r.cursor < 0) throw new Error('resume')
      resume = { serverInstanceId: r.serverInstanceId, cursor: r.cursor }
    }
    const capabilities = this.options.capabilities.filter(c => (f.capabilities as string[]).includes(c))
    const session: Session = { ws, deviceId: row.id, pub: row.identityPub, keys: sessionKeys(eph.priv, peerEph, this.options.machineId, peerEph, eph.pub), rx: new ReplayWindow(), tx: 0, ready: false, capabilities, resume, challenge: randomUUID() }
    const welcome: AutonomousDeviceFrame = { type: 'autonomous_device_welcome', proto: 1, machineId: this.options.machineId, machineName: this.options.machineName, ephPub: b64e(eph.pub), serverInstanceId: this.options.serverInstanceId, capabilities, limits: { maxFrameBytes: 65536, maxPromptBytes: 16384, eventBufferSize: 500, dedupeEntries: 512, dedupeTtlMs: 1800000, requestBurst: 20, requestRefillPerSecond: 1, maxConcurrentRequests: 4, ...this.options.limits }, resumed: false, cursor: 0, ...this.options.resume?.(resume), challenge: session.challenge }
    welcome.sig = signFrame('welcome', this.options.machineId, welcome, this.options.identity.priv, peerEph)
    this.sessions.set(ws, session); this.clear(ws, welcome)
    const finishedDeadline = setTimeout(() => { if (!session.ready) this.drop(session, 4401, 'TIMEOUT') }, 10_000)
    finishedDeadline.unref()
    ws.once('close', () => clearTimeout(finishedDeadline))
  }
  private pair(ws: WebSocket, f: AutonomousDeviceFrame): void {
    const w = this.window
    if (!w || w.expiresAt <= Date.now()) { this.clear(ws, { type: 'autonomous_device_pair_error', error: { code: 'EXPIRED' } }); return }
    try {
      if (f.type === 'autonomous_device_pair_intent') {
        if (w.socket && w.socket !== ws) { this.clear(ws, { type: 'autonomous_device_pair_error', error: { code: 'BUSY' } }); return }
        if (w.attempts >= 3) { this.finishPair('RATE_LIMITED'); return }
        if (w.socket) throw new Error('unexpected intent')
        const pairId = decodeFixed(f.pairId, 16)
        if (f.role !== 'autonomous-device' || typeof f.label !== 'string' || f.label.length < 1 || f.label.length > 80 || /[\x00-\x1f\x7f]/.test(f.label)) throw new Error('invalid label')
        w.attempts++; w.socket = ws; w.pairId = f.pairId as string; w.label = f.label
        const start = cpaceStart(cpaceGenerator(w.code, pairId, autonomousDeviceContext(this.options.machineId)))
        w.y = start.y; w.ya = start.Y
        this.pairState = { state: 'running', expiresAt: w.expiresAt }
        this.clear(ws, { type: 'autonomous_device_pair_intent_result', accepted: true, machineId: this.options.machineId, machineName: this.options.machineName, ttl: Math.max(0, Math.floor((w.expiresAt - Date.now()) / 1000)) })
        this.clear(ws, { type: 'autonomous_device_pake', pairId: w.pairId, round: 1, ya: b64e(start.Y) }); return
      }
      if (w.socket !== ws || f.pairId !== w.pairId) throw new Error('no intent')
      const ci = autonomousDeviceContext(this.options.machineId)
      if (f.round === 2 && w.y && w.ya && !w.key) {
        const yb = decodeFixed(f.yb, 32), sid = decodeFixed(w.pairId, 16)
        const isk = cpaceISK(sid, cpaceShared(yb, w.y), w.ya, yb), th = transcriptHash(sid, ci, w.ya, yb), kc = kcKeys(isk, ci)
        if (!macVerify(kc.web, th, decodeFixed(f.mac, 32))) throw new Error('code mismatch')
        w.th = th; w.key = pairKey(isk, ci); w.y = undefined
        const id = this.options.identity
        this.clear(ws, { type: 'autonomous_device_pake', pairId: w.pairId, round: 3, mac: b64e(macTag(kc.adapter, th)), enc: b64e(aeadSeal(w.key, 3, utf8('e2e-id'), utf8(JSON.stringify({ id: b64e(id.pub), sig: b64e(pairBindSig(id.priv, th)) })))) }); return
      }
      if (f.round === 4 && w.key && w.th && typeof f.enc === 'string') {
        const raw = aeadOpen(w.key, 4, utf8('e2e-id'), b64d(f.enc))
        if (!raw) throw new Error('identity decrypt')
        const peer = JSON.parse(new TextDecoder().decode(raw)) as { id: string; sig: string }
        const pub = decodeFixed(peer.id, 32)
        if (!pairBindVerify(pub, w.th, decodeFixed(peer.sig, 64))) throw new Error('identity signature')
        const row = this.store.stage(peer.id, w.label!)
        this.clear(ws, { type: 'autonomous_device_pake', pairId: w.pairId, round: 5, ok: true, fingerprint: fingerprint(this.options.identity.pub), deviceId: row.id })
        this.finishPair(); this.pairState = { state: 'paired', pendingFirstSession: true, deviceLabel: row.label, deviceFingerprint: fingerprint(pub) }; return
      }
      throw new Error('unexpected round')
    } catch {
      this.clear(ws, { type: 'autonomous_device_pair_error', error: { code: 'CODE_MISMATCH' } })
      if (w.socket === ws) { w.socket = undefined; w.pairId = undefined; w.y = undefined; w.ya = undefined; w.key = undefined; w.th = undefined }
      if (w.attempts >= 3) this.finishPair('RATE_LIMITED')
    }
  }
}
