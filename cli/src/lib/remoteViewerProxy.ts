import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Frame } from '../backendSocket.js'
import { VIEWER_MAX_STREAMS, VIEWER_UP_TYPES, ViewerWire, viewerHeaders, viewerTarget, type ViewerSend } from './viewerWire.js'

interface Gateway {
  agentId: string
  target: URL
  server: Server
  origin: string
  token: string
  cookie: string
  sockets: Set<Socket>
  wires: Set<ViewerWire>
}

const BOOTSTRAP = '/__harness_viewer/'
const MAX_VIEWERS = 64

/**
 * Runs on the desktop's daemon, after E2EE decryption. One private HTTP origin per remote viewer
 * preserves root-relative assets, iframes, EventSource, Range requests and WebSocket URLs. The
 * bootstrap URL establishes an HttpOnly cookie then redirects to the viewer's original path.
 * Cross-origin requests and requests without that cookie never reach the remote machine.
 */
export class RemoteViewerProxy {
  private readonly gateways = new Map<string, Gateway>()
  private readonly wires = new Map<string, { wire: ViewerWire; response: (payload: Record<string, unknown>) => void }>()
  private metadata = Promise.resolve()
  private generation = 0
  private disposed = false

  constructor(private readonly deps: {
    supported: () => boolean
    send: ViewerSend
    deliver: (frame: Frame) => void
  }) {}

  /** Viewer bytes are consumed here, never delivered to the desktop's control socket. */
  receive(frame: Frame): boolean {
    const type = typeof frame.type === 'string' ? frame.type : ''
    const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Record<string, unknown> : {}
    if (VIEWER_UP_TYPES.has(type)) {
      const stream = this.wires.get(String(payload.streamId))
      if (type === 'viewer_response') stream?.response(payload)
      else stream?.wire.handle(type, payload)
      return true
    }
    const metadata = ['agents_list_result', 'agent_synced', 'agent_created', 'agent_create_result', 'agent_create_status_result', 'agent_restart_result', 'agent_deleted'].includes(type)
    if (!metadata) return false
    const generation = this.generation
    this.metadata = this.metadata.then(async () => {
      if (this.disposed || generation !== this.generation) return
      const rewritten = await this.rewrite(frame)
      if (!this.disposed && generation === this.generation) this.deps.deliver(rewritten)
    }).catch(() => {
      // A local bind failure must not turn an agents_list RPC into a timeout.
      if (!this.disposed && generation === this.generation) this.deps.deliver(frameWithViewerError(frame))
    })
    return true
  }

  private async rewrite(frame: Frame): Promise<Frame> {
    const generation = this.generation
    const p = frame.payload as Record<string, unknown> | undefined
    if (!p) return frame
    if (frame.type === 'agent_deleted' && typeof p.agentId === 'string') this.remove(p.agentId)
    if (Array.isArray(p.agents)) {
      const ids = new Set(p.agents.map((a) => (a as { id?: unknown })?.id))
      for (const id of this.gateways.keys()) if (!ids.has(id)) this.remove(id)
      const agents = []
      for (const agent of p.agents) {
        if (this.disposed || generation !== this.generation) return frame
        agents.push(await this.rewriteAgent(agent))
      }
      return { ...frame, payload: { ...p, agents } }
    }
    if (p.agent) return { ...frame, payload: { ...p, agent: await this.rewriteAgent(p.agent) } }
    return frame
  }

  private async rewriteAgent(raw: unknown): Promise<unknown> {
    const generation = this.generation
    if (!raw || typeof raw !== 'object') return raw
    const agent = raw as Record<string, unknown>
    if (typeof agent.id !== 'string') return raw
    const target = viewerTarget(agent.viewerUrl)
    if (!target) {
      this.remove(agent.id)
      // Public HTTP(S) URLs remain ordinary URLs; remote loopback URLs must never be opened locally.
      if (agent.viewerUrl && isLoopbackUrl(agent.viewerUrl)) return { ...agent, viewerUrl: null, viewerError: 'This remote viewer requires an HTTP loopback URL.' }
      return raw
    }
    if (!this.deps.supported()) {
      this.remove(agent.id)
      return { ...agent, viewerUrl: null, viewerError: 'Update Harness on the remote machine to show its viewer.' }
    }
    let gateway = this.gateways.get(agent.id)
    if (gateway?.target.origin !== target.origin) { this.remove(agent.id); gateway = undefined }
    if (!gateway) {
      if (this.gateways.size >= MAX_VIEWERS) return { ...agent, viewerUrl: null, viewerError: 'Too many remote viewers are open.' }
      gateway = await this.createGateway(agent.id, target)
      if (this.disposed || generation !== this.generation) { this.closeGateway(gateway); return { ...agent, viewerUrl: null } }
      this.gateways.set(agent.id, gateway)
    }
    gateway.target = target
    const path = target.pathname + target.search + target.hash
    return { ...agent, viewerUrl: `${gateway.origin}${BOOTSTRAP}${gateway.token}?path=${encodeURIComponent(path)}`, viewerError: null }
  }

  private async createGateway(agentId: string, target: URL): Promise<Gateway> {
    const token = randomBytes(24).toString('hex')
    const server = createServer()
    const gateway: Gateway = { agentId, target, server, token, cookie: `hv_${token}`, origin: '', sockets: new Set(), wires: new Set() }
    server.on('connection', (socket) => {
      gateway.sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => gateway.sockets.delete(socket))
    })
    server.on('request', (req, res) => this.serve(gateway, req, res))
    server.on('upgrade', (req, socket, head) => this.serveUpgrade(gateway, req, socket, head))
    server.on('connect', (_req, socket) => socket.destroy())
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', () => this.remove(agentId))
    server.unref()
    gateway.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return gateway
  }

  private allowed(gateway: Gateway, req: IncomingMessage): boolean {
    return req.headers.host === new URL(gateway.origin).host
      && (!req.headers.origin || req.headers.origin === gateway.origin)
      && !['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']))
      && (!req.headers.referer || req.headers.referer.startsWith(`${gateway.origin}/`))
  }

  private authenticated(gateway: Gateway, req: IncomingMessage): boolean {
    return String(req.headers.cookie ?? '').split(';').some((part) => part.trim() === `${gateway.cookie}=${gateway.token}`)
  }

  private serve(gateway: Gateway, req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    if (!this.allowed(gateway, req)) { res.writeHead(403).end('Viewer access denied'); return }
    const requestPath = req.url ?? '/'
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || /[\s\\]/.test(requestPath)) {
      res.writeHead(400).end('Invalid viewer path'); return
    }
    const url = new URL(requestPath, gateway.origin)
    if (req.method === 'GET' && url.pathname === `${BOOTSTRAP}${gateway.token}`) {
      const path = url.searchParams.get('path') ?? '/'
      if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) { res.writeHead(400).end(); return }
      res.setHeader('Set-Cookie', `${gateway.cookie}=${gateway.token}; Path=/; HttpOnly; SameSite=Strict`)
      res.writeHead(302, { Location: path }).end()
      return
    }
    if (!this.authenticated(gateway, req)) { res.writeHead(403).end('Viewer access denied'); return }
    let responded = false
    const wire = this.open(gateway, req, false, (p, stream) => {
      if (responded) { stream.destroy(new Error('Duplicate viewer response')); return }
      try {
        const status = Number(p.status)
        if (!Number.isInteger(status) || status < 200 || status > 599 || p.upgrade === true) throw new Error('Invalid response')
        responded = true
        res.writeHead(status, this.responseHeaders(gateway, p.headers))
        res.flushHeaders()
        stream.ready()
        stream.pipe(res)
      } catch { stream.destroy(new Error('Invalid viewer response')) }
    })
    if (!wire) { res.writeHead(503).end('Too many viewer requests'); return }
    wire.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end('The remote viewer disconnected. Reload to try again.')
    })
    res.on('close', () => wire.destroy())
    req.on('error', () => wire.destroy(new Error('Viewer request interrupted')))
    req.pipe(wire)
  }

  private serveUpgrade(gateway: Gateway, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.allowed(gateway, req) || !this.authenticated(gateway, req) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    let responded = false
    const wire = this.open(gateway, req, true, (p, stream) => {
      if (responded) { stream.destroy(); return }
      responded = true
      if (p.status !== 101 || p.upgrade !== true) { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); stream.destroy(); return }
      try {
        const headers = this.responseHeaders(gateway, p.headers, true)
        const lines = Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`))
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
        stream.ready()
        if (head.length) stream.write(head)
        socket.pipe(stream).pipe(socket)
      } catch { stream.destroy() }
    })
    if (!wire) { socket.destroy(); return }
    wire.on('error', () => socket.destroy())
    wire.on('close', () => socket.destroy())
    socket.on('error', () => wire.destroy())
    socket.on('close', () => wire.destroy())
  }

  private open(gateway: Gateway, req: IncomingMessage, upgrade: boolean, response: (p: Record<string, unknown>, wire: ViewerWire) => void): ViewerWire | null {
    if (this.disposed || this.wires.size >= VIEWER_MAX_STREAMS) return null
    const id = randomUUID()
    const wire = new ViewerWire(id, this.deps.send)
    this.wires.set(id, { wire, response: (p) => response(p, wire) })
    gateway.wires.add(wire)
    wire.on('close', () => { this.wires.delete(id); gateway.wires.delete(wire) })
    try {
      const headers = viewerHeaders(req.headers, upgrade)
      headers.host = gateway.target.host
      if (headers.origin) headers.origin = gateway.target.origin
      if (headers.referer) headers.referer = String(headers.referer).replace(gateway.origin, gateway.target.origin)
      // Cookies are scoped to hosts, not ports. Only this gateway's namespaced viewer cookies cross
      // the wire; the bootstrap credential and other loopback apps' cookies stay on this computer.
      const cookies = String(headers.cookie ?? '').split(';').map((s) => s.trim())
        .filter((s) => s.startsWith(`${gateway.cookie}_`)).map((s) => s.slice(gateway.cookie.length + 1))
      delete headers.cookie
      if (cookies.length) headers.cookie = cookies.join('; ')
      if (!this.deps.send('viewer_request', {
        streamId: id, agentId: gateway.agentId, origin: gateway.target.origin,
        path: req.url, method: req.method, headers, upgrade,
      })) queueMicrotask(() => wire.destroy(new Error('Viewer connection closed')))
    } catch { queueMicrotask(() => wire.destroy(new Error('Invalid viewer request'))) }
    return wire
  }

  private responseHeaders(gateway: Gateway, raw: unknown, upgrade = false): ReturnType<typeof viewerHeaders> {
    const headers = viewerHeaders(raw, upgrade)
    if (typeof headers.location === 'string') {
      const location = new URL(headers.location, gateway.target)
      if (location.origin === gateway.target.origin) headers.location = gateway.origin + location.pathname + location.search + location.hash
    }
    if (headers['set-cookie']) {
      const values = headers['set-cookie']
      headers['set-cookie'] = (Array.isArray(values) ? values : [values]).map((value) =>
        `${gateway.cookie}_${value.replace(/;\s*Domain=[^;]*/ig, '')}`)
    }
    headers['referrer-policy'] = 'no-referrer'
    return headers
  }

  private closeGateway(gateway: Gateway): void {
    for (const wire of gateway.wires) wire.destroy()
    for (const socket of gateway.sockets) socket.destroy()
    gateway.server.close()
  }

  private remove(agentId: string): void {
    const gateway = this.gateways.get(agentId)
    this.gateways.delete(agentId)
    if (gateway) this.closeGateway(gateway)
  }

  /** Detach closes all access immediately, even though the terminal relay pool lingers. */
  reset(): void {
    this.generation++
    for (const id of this.gateways.keys()) this.remove(id)
  }

  close(): void { this.disposed = true; this.reset() }
}

function isLoopbackUrl(raw: unknown): boolean {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(raw)).hostname) } catch { return false }
}

function frameWithViewerError(frame: Frame): Frame {
  const p = frame.payload as Record<string, unknown> | undefined
  if (!p) return frame
  const failed = (a: unknown): unknown => a && typeof a === 'object' && isLoopbackUrl((a as Record<string, unknown>).viewerUrl)
    ? { ...a, viewerUrl: null, viewerError: 'The remote viewer could not be opened. Reconnect to try again.' } : a
  return { ...frame, payload: { ...p, ...(p.agent ? { agent: failed(p.agent) } : {}), ...(Array.isArray(p.agents) ? { agents: p.agents.map(failed) } : {}) } }
}
