/**
 * Backend side of the app-proxy tunnel — the PUBLIC terminator of `<sub>.<APP_DOMAIN_SUFFIX>`.
 *
 * A public HTTP request / WS upgrade becomes a per-request STREAM (`streamId`) tunnelled to the owning
 * agent's manager over the manager socket (no manager address needed). Two delivery modes, chosen per
 * stream at open time by whether THIS backend instance already holds the agent's app-pool manager socket:
 *
 *   LOCAL  (co-located): write frames straight to the local manager socket + register a local up-handler.
 *                        Zero Redis, native socket backpressure. (registry.appSocketFor(machineId))
 *   REDIS  (cross-instance): publishAppDown(machineId, …) → B_m; subscribe appup:{streamId} for the reply.
 *
 * Down (client→app): app_req | app_body | app_ws_* | app_abort.  Up (app→client): app_res | app_res_body
 * | app_ws_* | app_abort. Bodies ride chunked base64 frames so uploads/downloads/SSE stream.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { subscribeAppUp, publishAppDown } from './bus.js'
import * as registry from './registry.js'
import { env } from '../config/env.js'
import type {
  AppResEnvelope,
  AppBodyEnvelope,
  AppWsMsgEnvelope,
  AppWsCloseEnvelope,
  AppAbortEnvelope,
  AppDownFrame,
} from './tunnel.js'
import { logger } from '../utils/logger.js'

// No app_res within this window → the node app is unreachable / never answered → 502.
const RESPONSE_TIMEOUT_MS = 30_000

type UpFrame = AppResEnvelope | AppBodyEnvelope | AppWsMsgEnvelope | AppWsCloseEnvelope | AppAbortEnvelope

const wss = new WebSocketServer({ noServer: true })

// streamId → local up-handler, for streams whose manager socket is on THIS instance (LOCAL mode). The
// manager-ws message loop calls deliverAppUpLocal before falling back to publishAppUp.
const localStreams = new Map<string, (frame: UpFrame) => void>()

const MAX_REQUEST_BYTES = env.APP_PROXY_MAX_REQUEST_BYTES
const MAX_RESPONSE_BYTES = env.APP_PROXY_MAX_RESPONSE_BYTES
const MAX_WS_FRAME_BYTES = env.APP_PROXY_MAX_WS_FRAME_BYTES
const IDLE_TIMEOUT_MS = env.APP_PROXY_IDLE_TIMEOUT_MS
const MAX_STREAMS_PER_SUBDOMAIN = env.APP_PROXY_MAX_STREAMS_PER_SUBDOMAIN

const activeBySubdomain = new Map<string, number>()
const HTTP_STRIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function acquireSubdomainSlot(subdomain: string): (() => void) | null {
  const n = activeBySubdomain.get(subdomain) ?? 0
  if (n >= MAX_STREAMS_PER_SUBDOMAIN) return null
  activeBySubdomain.set(subdomain, n + 1)
  return () => {
    const cur = activeBySubdomain.get(subdomain) ?? 0
    if (cur <= 1) activeBySubdomain.delete(subdomain)
    else activeBySubdomain.set(subdomain, cur - 1)
  }
}

function sanitizeHttpHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HTTP_STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v
  }
  const remote = req.socket.remoteAddress
  const priorFor = req.headers['x-forwarded-for']
  headers['x-forwarded-for'] = [Array.isArray(priorFor) ? priorFor.join(', ') : priorFor, remote].filter(Boolean).join(', ')
  headers['x-forwarded-host'] = req.headers.host
  headers['x-forwarded-proto'] = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : (req.headers['x-forwarded-proto'] ?? 'https')
  if (remote) headers['x-real-ip'] = remote
  return headers
}

function sendWsJson(ws: WebSocket, frame: AppDownFrame): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('manager app socket is closed'))
  const payload = JSON.stringify(frame)
  return new Promise((resolve, reject) => {
    try {
      ws.send(payload, (err) => (err ? reject(err) : resolve()))
    } catch (err) {
      reject(err)
    }
  })
}

/** Deliver an app→client up-frame to a co-located stream. Returns true if a local handler consumed it. */
export function deliverAppUpLocal(streamId: string, frame: UpFrame): boolean {
  const h = localStreams.get(streamId)
  if (!h) return false
  h(frame)
  return true
}

/** Pick the down-channel for a new stream: local manager socket if held here, else Redis. */
function openChannel(machineId: string, streamId: string, onUp: (f: UpFrame) => void): {
  sendDown: (f: AppDownFrame) => Promise<void>
  teardown: () => void
} | Promise<{ sendDown: (f: AppDownFrame) => Promise<void>; teardown: () => void }> {
  const local = registry.appSocketFor(machineId)
  if (local) {
    localStreams.set(streamId, onUp)
    return {
      sendDown: (f) => sendWsJson(local, f),
      teardown: () => { localStreams.delete(streamId) },
    }
  }
  return subscribeAppUp(streamId, onUp as (m: unknown) => void).then((unsub) => ({
    sendDown: async (f: AppDownFrame) => {
      const subscribers = await publishAppDown(machineId, f)
      if (subscribers === 0) throw new Error('manager app socket is unreachable')
    },
    teardown: () => unsub(),
  }))
}

/** Tunnel one public HTTP request to the agent's app over the manager socket. */
export async function tunnelHttp(
  req: IncomingMessage,
  res: ServerResponse,
  machineId: string,
  subdomain: string,
): Promise<void> {
  const streamId = randomUUID()
  const releaseSlot = acquireSubdomainSlot(subdomain)
  if (!releaseSlot) {
    res.writeHead(429, { 'content-type': 'text/plain' })
    res.end('Too many active app streams')
    logger.warn('app-tunnel stream rejected: concurrency limit', { machineId, subdomain })
    return
  }
  const release = releaseSlot
  let settled = false
  let headWritten = false
  let requestBytes = 0
  let responseBytes = 0
  let bodyChain: Promise<void> = Promise.resolve()
  let writeChain: Promise<void> = Promise.resolve()

  const responseTimer = setTimeout(() => {
    fail(502, 'App did not respond', 'response_timeout')
  }, RESPONSE_TIMEOUT_MS)
  let idleTimer: NodeJS.Timeout | null = null
  const refreshIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fail(504, 'App stream timed out', 'idle_timeout'), IDLE_TIMEOUT_MS)
  }

  logger.info('app-tunnel http open', { machineId, subdomain, streamId, method: req.method, url: req.url })

  const writeBody = (buf: Buffer): Promise<void> => new Promise((resolve) => {
    if (settled || res.destroyed) { resolve(); return }
    try {
      if (res.write(buf)) { resolve(); return }
      res.once('drain', resolve)
    } catch {
      resolve()
    }
  })

  const onUp = (f: UpFrame): void => {
    if (f.streamId !== streamId) return
    refreshIdle()
    switch (f.t) {
      case 'app_res':
        headWritten = true
        clearTimeout(responseTimer)
        try { res.writeHead(f.status, f.headers as Record<string, string | string[]>) } catch { /* ignore */ }
        break
      case 'app_res_body':
        if (f.chunk) {
          const buf = Buffer.from(f.chunk, 'base64')
          responseBytes += buf.length
          if (MAX_RESPONSE_BYTES > 0 && responseBytes > MAX_RESPONSE_BYTES) {
            fail(502, 'App response too large', 'response_too_large')
            return
          }
          writeChain = writeChain.then(() => writeBody(buf))
        }
        if (f.end) {
          void writeChain.finally(() => {
            if (!settled) { try { res.end() } catch { /* ignore */ }; cleanup('complete') }
          })
        }
        break
      case 'app_abort':
        fail(headWritten ? 502 : 502, 'App error', f.reason ?? 'app_abort')
        break
      default:
        break
    }
  }

  let channel: Awaited<ReturnType<typeof openChannel>>
  try {
    channel = await openChannel(machineId, streamId, onUp)
  } catch (err) {
    clearTimeout(responseTimer)
    if (idleTimer) clearTimeout(idleTimer)
    release()
    logger.warn('app-tunnel http channel open failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
    if (!res.headersSent) {
      try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('App unavailable') } catch { /* ignore */ }
    }
    return
  }
  const { sendDown, teardown } = channel

  function cleanup(reason: string): void {
    if (settled) return
    settled = true
    clearTimeout(responseTimer)
    if (idleTimer) clearTimeout(idleTimer)
    teardown()
    release()
    logger.info('app-tunnel http close', { machineId, subdomain, streamId, reason, requestBytes, responseBytes })
  }

  function fail(status: number, message: string, reason: string): void {
    if (settled) return
    void sendDown({ t: 'app_abort', streamId, reason }).catch(() => { /* ignore */ })
    if (!res.headersSent) {
      try { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(message) } catch { /* ignore */ }
    } else {
      try { res.end() } catch { /* ignore */ }
    }
    cleanup(reason)
  }

  // Open the stream, then pipe the request body as chunked frames.
  try {
    await sendDown({ t: 'app_req', streamId, subdomain, method: req.method ?? 'GET', url: req.url ?? '/', headers: sanitizeHttpHeaders(req) })
    refreshIdle()
  } catch (err) {
    logger.warn('app-tunnel http open failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
    fail(502, 'App unavailable', 'open_failed')
    return
  }
  req.on('data', (chunk: Buffer) => {
    if (settled) return
    requestBytes += chunk.length
    if (MAX_REQUEST_BYTES > 0 && requestBytes > MAX_REQUEST_BYTES) {
      req.pause()
      fail(413, 'Request body too large', 'request_too_large')
      return
    }
    req.pause()
    bodyChain = bodyChain
      .then(() => sendDown({ t: 'app_body', streamId, chunk: Buffer.from(chunk).toString('base64') }))
      .catch((err) => {
        logger.warn('app-tunnel request body send failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
        fail(502, 'App unavailable', 'send_failed')
      })
      .finally(() => { if (!settled) req.resume() })
  })
  req.on('end', () => {
    bodyChain = bodyChain
      .then(() => (settled ? undefined : sendDown({ t: 'app_body', streamId, end: true })))
      .catch((err) => {
        logger.warn('app-tunnel request end send failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
        fail(502, 'App unavailable', 'send_failed')
      })
  })
  const abort = (): void => {
    if (!settled) sendDown({ t: 'app_abort', streamId, reason: 'client closed' })
      .catch(() => { /* ignore */ })
      .finally(() => cleanup('client_closed'))
  }
  req.on('error', abort)
  res.on('close', () => { if (!settled) abort() })
}

/** Tunnel one public WebSocket upgrade to the agent's app over the manager socket. */
export async function tunnelWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  machineId: string,
  subdomain: string,
): Promise<void> {
  const streamId = randomUUID()
  const releaseSlot = acquireSubdomainSlot(subdomain)
  if (!releaseSlot) {
    try { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
    socket.destroy()
    logger.warn('app-tunnel ws rejected: concurrency limit', { machineId, subdomain })
    return
  }
  const release = releaseSlot
  const ws = await new Promise<WebSocket>((resolve) => {
    wss.handleUpgrade(req, socket, head, (client) => resolve(client))
  })

  let closed = false
  let inBytes = 0
  let outBytes = 0
  let idleTimer: NodeJS.Timeout | null = null
  const refreshIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => close(1001), IDLE_TIMEOUT_MS)
  }
  const close = (code?: number): void => {
    if (closed) return
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    try { ws.close(code) } catch { /* ignore */ }
    void sendDown({ t: 'app_ws_close', streamId, code })
      .catch(() => { /* ignore */ })
    teardown()
    release()
    logger.info('app-tunnel ws close', { machineId, subdomain, streamId, code, inBytes, outBytes })
  }

  const onUp = (f: UpFrame): void => {
    if (f.streamId !== streamId) return
    refreshIdle()
    if (f.t === 'app_ws_msg') {
      const data = Buffer.from(f.data, 'base64')
      outBytes += data.length
      if (MAX_WS_FRAME_BYTES > 0 && data.length > MAX_WS_FRAME_BYTES) { close(1009); return }
      try { ws.send(data, { binary: f.binary }) } catch { /* ignore */ }
    } else if (f.t === 'app_ws_close') {
      closed = true
      if (idleTimer) clearTimeout(idleTimer)
      try { ws.close(f.code) } catch { /* ignore */ }
      teardown()
      release()
      logger.info('app-tunnel ws close', { machineId, subdomain, streamId, code: f.code, inBytes, outBytes })
    } else if (f.t === 'app_abort') {
      closed = true
      if (idleTimer) clearTimeout(idleTimer)
      try { ws.close(1011) } catch { /* ignore */ }
      teardown()
      release()
      logger.warn('app-tunnel ws abort', { machineId, subdomain, streamId, reason: f.reason, inBytes, outBytes })
    }
  }

  let channel: Awaited<ReturnType<typeof openChannel>>
  try {
    channel = await openChannel(machineId, streamId, onUp)
  } catch (err) {
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    release()
    logger.warn('app-tunnel ws channel open failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
    try { ws.close(1011) } catch { /* ignore */ }
    return
  }
  const { sendDown, teardown } = channel

  logger.info('app-tunnel ws open', { machineId, subdomain, streamId, url: req.url })
  try {
    await sendDown({ t: 'app_ws_open', streamId, subdomain, url: req.url ?? '/', headers: sanitizeHttpHeaders(req) })
    refreshIdle()
  } catch (err) {
    logger.warn('app-tunnel ws open failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
    close(1011)
    return
  }

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (closed) return
    inBytes += data.length
    refreshIdle()
    if (MAX_WS_FRAME_BYTES > 0 && data.length > MAX_WS_FRAME_BYTES) { close(1009); return }
    void sendDown({ t: 'app_ws_msg', streamId, data: Buffer.from(data).toString('base64'), binary: isBinary })
      .catch((err) => {
        logger.warn('app-tunnel ws msg send failed', { machineId, subdomain, streamId, error: err instanceof Error ? err.message : String(err) })
        close(1011)
      })
  })
  ws.on('close', (code: number) => close(code))
  ws.on('error', (err: Error) => { logger.warn('app-tunnel client ws error', { subdomain, error: err.message }); close(1011) })
}
