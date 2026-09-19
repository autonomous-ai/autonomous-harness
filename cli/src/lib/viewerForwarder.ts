import { request } from 'node:http'
import { VIEWER_MAX_STREAMS, ViewerWire, viewerHeaders, viewerStreamId, viewerTarget, type ViewerSend } from './viewerWire.js'

interface Forward {
  connId: string
  agentId: string
  origin: string
  wire: ViewerWire
}

/** Runs on the harness's machine. A request names an agent, never a destination host or port. */
export class ViewerForwarder {
  private readonly streams = new Map<string, Forward>()

  constructor(private readonly deps: {
    target: (agentId: string) => string | null
    send: (connId: string, type: string, payload: Record<string, unknown>) => boolean
  }) {}

  handle(connId: string, type: string, payload: Record<string, unknown>): void {
    const id = payload.streamId
    if (!viewerStreamId(id)) return
    const key = `${connId}/${id}`
    if (type !== 'viewer_request') {
      this.streams.get(key)?.wire.handle(type, payload)
      return
    }
    // Reusing a live id never replaces its request or changes its agent.
    if (this.streams.has(key)) { this.streams.get(key)!.wire.destroy(new Error('Duplicate viewer stream')); return }
    const send: ViewerSend = (t, p) => this.deps.send(connId, t, p)
    const refuse = (error: string): void => { send('viewer_close', { streamId: id, error }) }
    const agentId = payload.agentId
    const target = typeof agentId === 'string' ? viewerTarget(this.deps.target(agentId)) : null
    if (!target || target.origin !== payload.origin) { refuse('Viewer is no longer available'); return }
    if (this.streams.size >= VIEWER_MAX_STREAMS * 4
      || [...this.streams.values()].filter((s) => s.connId === connId).length >= VIEWER_MAX_STREAMS) {
      refuse('Too many viewer requests'); return
    }
    const path = payload.path
    const method = payload.method
    const upgrade = payload.upgrade === true
    if (typeof path !== 'string' || path.length > 16 * 1024 || !path.startsWith('/') || path.startsWith('//')
      || /[\s\x00-\x1f\x7f\\]/.test(path) || typeof method !== 'string'
      || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
      || (upgrade && method !== 'GET')) {
      refuse('Invalid viewer request'); return
    }
    let headers: ReturnType<typeof viewerHeaders>
    try { headers = viewerHeaders(payload.headers, upgrade) } catch { refuse('Invalid viewer headers'); return }
    headers.host = target.host
    const wire = new ViewerWire(id, send)
    this.streams.set(key, { connId, agentId: agentId as string, origin: target.origin, wire })
    try {
      const upstream = request({
        // The viewer manager checks its allocated port; pin localhost to the loopback literal.
        hostname: target.hostname === '[::1]' ? '::1' : '127.0.0.1',
        port: target.port, path, method, headers, agent: false,
      })
      const reply = (status: number, rawHeaders: unknown, switched = false): void => {
        wire.ready()
        if (!send('viewer_response', { streamId: id, status, headers: viewerHeaders(rawHeaders, switched), upgrade: switched })) wire.destroy()
      }
      upstream.on('response', (response) => {
        try { reply(response.statusCode ?? 502, response.headers) } catch { wire.destroy(); return }
        response.on('error', () => wire.destroy(new Error('Viewer response interrupted')))
        if (upgrade) wire.resume() // An unsuccessful upgrade has no request body to consume.
        response.pipe(wire)
      })
      upstream.on('upgrade', (response, socket, head) => {
        if (!upgrade || response.statusCode !== 101) { socket.destroy(); wire.destroy(); return }
        try { reply(101, response.headers, true) } catch { socket.destroy(); wire.destroy(); return }
        socket.on('error', () => wire.destroy(new Error('Viewer WebSocket interrupted')))
        socket.on('close', () => wire.destroy())
        wire.on('close', () => socket.destroy())
        if (head.length) wire.write(head)
        socket.pipe(wire).pipe(socket)
      })
      upstream.on('error', () => wire.destroy(new Error('Viewer did not answer')))
      wire.on('close', () => { this.streams.delete(key); upstream.destroy() })
      if (upgrade) upstream.end()
      else wire.pipe(upstream)
    } catch {
      this.streams.delete(key)
      wire.destroy(new Error('Invalid viewer request'))
    }
  }

  /** Called on port changes/stop, before another process can reuse the old viewer port. */
  refresh(agentId: string): void {
    const origin = viewerTarget(this.deps.target(agentId))?.origin
    for (const stream of this.streams.values()) {
      if (stream.agentId === agentId && stream.origin !== origin) stream.wire.destroy()
    }
  }

  closeConnection(connId: string): void {
    for (const stream of this.streams.values()) if (stream.connId === connId) stream.wire.destroy()
  }

  closeAll(): void { for (const stream of this.streams.values()) stream.wire.destroy() }
}
