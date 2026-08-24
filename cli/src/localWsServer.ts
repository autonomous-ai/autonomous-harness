import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Frame, LocalClientSink } from './backendSocket.js'
import { decodeTerminalLocal, TERMINAL_BINARY_VERSION, type TerminalBinaryClear } from './lib/terminalBinary.js'
import { RelayConnectError, type RelaySession, type RemoteRelayPool } from './lib/remoteRelay.js'

export const LOCAL_WS_PATH = '/api/local-ws'
export const LOCAL_WS_PROTOCOL_VERSION = 1

const MAX_JSON_BYTES = 512 * 1024
const HEARTBEAT_MS = 20_000

export interface LocalWsBackend {
  registerLocalClient: (connId: string, sink: LocalClientSink) => boolean
  unregisterLocalClient: (connId: string) => Promise<void>
  handleLocalFrame: (connId: string, frame: Frame) => void
  handleLocalBinary: (connId: string, frame: TerminalBinaryClear) => Promise<void>
}

export interface LocalWsServerOptions {
  machineId: string
  backend: LocalWsBackend
  /** Serves a `machine_select` for any OTHER machine this signed-in user owns, by relaying to
   *  backend's `/api/web-ws` — see lib/remoteRelay.ts. Omit to keep today's own-machine-only behavior. */
  relayPool?: RemoteRelayPool
  autonomousEnv?: string
}

export interface LocalWsServer {
  close: () => Promise<void>
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n',
  )
}

function jsonFrame(raw: RawData): Frame | null {
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.alloc(0)
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) return null
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const frame = value as Frame
    return typeof frame.type === 'string' && frame.type.length <= 100 ? frame : null
  } catch {
    return null
  }
}

function binaryBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw))
  return new Uint8Array()
}

/**
 * Add an internal loopback WebSocket endpoint to the CLI's existing HTTP server. It intentionally has
 * no credential: loopback-only, no Origin header, and the desktop computer-id validation identify the
 * local process without placing SSO credentials on this transport.
 */
export function attachLocalWsServer(server: http.Server, options: LocalWsServerOptions): LocalWsServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_JSON_BYTES,
    // The loopback endpoint deliberately has no credential. Echo a protocol only for generic WS
    // clients that insist on proposing one; it carries no authority and is never inspected.
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  })

  const onUpgrade = (req: http.IncomingMessage, socket: Socket, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== LOCAL_WS_PATH) return
    if (!isLoopback(req.socket.remoteAddress)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (req.headers.origin) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  server.on('upgrade', onUpgrade)

  wss.on('connection', (ws) => {
    const connId = `local:${randomUUID()}`
    let selected = false
    let relay: RelaySession | null = null
    let alive = true
    let chain = Promise.resolve()

    const sink: LocalClientSink = {
      sendFrame: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        try { ws.send(JSON.stringify(frame)); return true } catch { return false }
      },
      sendBinary: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        try { ws.send(frame, { binary: true }); return true } catch { return false }
      },
    }

    const close = (code: number, reason: string): void => {
      try { ws.close(code, reason) } catch { ws.terminate() }
    }

    ws.on('pong', () => { alive = true })
    ws.on('message', (raw, isBinary) => {
      chain = chain.then(async () => {
        if (!selected) {
          if (isBinary) { close(4400, 'machine_select required'); return }
          const frame = jsonFrame(raw)
          const payload = frame?.payload as Record<string, unknown> | undefined
          const requestedMachineId = payload?.machineId
          if (frame?.type !== 'machine_select'
            || typeof requestedMachineId !== 'string'
            || payload?.localProtocolVersion !== LOCAL_WS_PROTOCOL_VERSION) {
            close(4403, 'machine mismatch')
            return
          }
          if (requestedMachineId === options.machineId) {
            if (!options.backend.registerLocalClient(connId, sink)) {
              close(1011, 'local registration failed')
              return
            }
            selected = true
            sink.sendFrame({
              type: 'connected',
              payload: {
                machineId: options.machineId,
                transport: 'local',
                localProtocolVersion: LOCAL_WS_PROTOCOL_VERSION,
                terminalProtocolVersion: TERMINAL_BINARY_VERSION,
                e2ee: false,
              },
            })
            return
          }
          // Not this daemon's own machine — relay to backend for the other machines this same
          // signed-in user owns, if the daemon was wired up to do that (see lib/remoteRelay.ts).
          if (!options.relayPool || !options.autonomousEnv) {
            close(4403, 'machine mismatch')
            return
          }
          try {
            relay = await options.relayPool.acquire(requestedMachineId, options.autonomousEnv, frame, sink, close)
            selected = true
          } catch (err) {
            const noPeerLink = err instanceof RelayConnectError && err.message === 'NO_PEER_LINK'
            const code = noPeerLink ? 4404 : err instanceof RelayConnectError && err.closeCode ? err.closeCode : 1011
            close(code, err instanceof Error ? err.message.slice(0, 120) : 'relay failed')
          }
          return
        }

        if (relay) {
          // The relay now terminates E2EE itself (lib/remoteRelay.ts) — every frame past this point is
          // already plaintext going in and out, so binary frames use the SAME local wire format as this
          // daemon's own machine.
          if (isBinary) {
            const clear = decodeTerminalLocal(binaryBytes(raw))
            if (!clear) { close(4400, 'invalid terminal frame'); return }
            relay.sendBinary(clear)
            return
          }
          const frame = jsonFrame(raw)
          if (!frame) { close(4400, 'invalid json frame'); return }
          relay.send(frame)
          return
        }

        if (isBinary) {
          const frame = decodeTerminalLocal(binaryBytes(raw))
          if (!frame) { close(4400, 'invalid terminal frame'); return }
          await options.backend.handleLocalBinary(connId, frame)
          return
        }
        const frame = jsonFrame(raw)
        if (!frame) { close(4400, 'invalid json frame'); return }
        options.backend.handleLocalFrame(connId, frame)
      }).catch(() => close(1011, 'local dispatch failed'))
    })

    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return }
      alive = false
      try { ws.ping() } catch { ws.terminate() }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      if (relay) { relay.detach(); relay = null }
      else if (selected) void options.backend.unregisterLocalClient(connId)
      selected = false
    }
    ws.once('close', cleanup)
    ws.once('error', () => { /* close performs cleanup */ })
  })

  return {
    close: async () => {
      server.off('upgrade', onUpgrade)
      for (const client of wss.clients) client.close(1001, 'server shutting down')
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
