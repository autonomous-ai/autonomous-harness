import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, type RawData } from 'ws'
import { createWss, WS_LIMITS } from './wsServer.js'
import { authenticateAccessToken, type AuthUser } from './ssoAuth.js'
import { parseAutonomousEnvironment } from './autonomousEnvironment.js'
import { extractKey } from '../utils/crypto.js'
import { recipientShare } from '../routes/harnessShares.js'
import { publishDown, subscribeUp, subscribeShareChanged } from './bus.js'
import { guardedSendJson } from './wsSend.js'
import { trackSocketLiveness } from './hub.js'
import { createOrderedInbox } from './orderedInbox.js'

const wss = createWss(WS_LIMITS.web, { echoFirstProtocol: true })

export function handleObserverUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  void (async () => {
    const token = extractKey(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('share') ?? ''
    if (!token || !/^[a-f0-9-]{36}$/.test(id)) { socket.destroy(); return }
    const user = await authenticateAccessToken(token, parseAutonomousEnvironment(url.searchParams.get('autonomousEnv')))
    const share = await recipientShare(id, user)
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, ws => {
      if (!share) { ws.close(4403, 'Sharing ended or invitation expired'); return }
      void attachObserver(ws, user, share).catch(() => ws.close(1013, 'Sharing temporarily unavailable'))
    })
  })().catch(() => { if (!socket.destroyed) socket.destroy() })
}

/** Separate from the machine hub: no group key, machine inventory, P2P, or generic RPC route. */
export async function attachObserver(ws: WebSocket, user: AuthUser, share: NonNullable<Awaited<ReturnType<typeof recipientShare>>>): Promise<void> {
  const connId = `observer:${randomUUID()}`
  const send = (frame: unknown) => guardedSendJson(ws, frame, 'must')
  const disposers: Array<() => void> = [trackSocketLiveness(ws)]
  let closed = false
  let opened = false
  const down = (type: string, payload: unknown) => publishDown(share.machineId, { connId, frame: { type, payload } })
  const close = () => {
    closed = true
    for (const dispose of disposers.splice(0)) dispose()
    void down('observer_close', {}).catch(() => {})
  }
  ws.once('close', close)
  const check = async () => {
    try {
      if (!await recipientShare(share.id, user)) ws.close(4403, 'Sharing ended or invitation expired')
    } catch { ws.close(1013, 'Sharing temporarily unavailable') }
  }
  const timer = setInterval(() => { void check() }, 5000)
  timer.unref()
  disposers.push(() => clearInterval(timer))
  const keep = (dispose: () => void) => { if (closed) dispose(); else disposers.push(dispose) }
  keep(await subscribeShareChanged(share.id, () => { void check() }))
  keep(await subscribeUp(share.machineId, message => {
    if (closed) return
    const frame = message.frame
    if (frame.type === 'node_status' && (frame.payload as { online?: boolean })?.online === false) {
      ws.close(1012, 'Owner is offline'); return
    }
    if (message.targetConnId !== connId) return
    if (['observer_welcome', 'observer_frame', 'observer_closed'].includes(String(frame.type))) send(frame)
  }))
  if (closed) return
  await check()
  if (ws.readyState !== WebSocket.OPEN) return
  send({ type: 'observer_connected' })
  // Each message is bounded before decoding; encrypted content is interpreted only on the owner daemon.
  let windowStart = Date.now(), count = 0
  const inbox = createOrderedInbox<{ raw: RawData; binary: boolean }>(async ({ raw, binary }) => {
    if (closed) return
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0 }
    if (binary || (Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : raw.byteLength) > 64 * 1024 || ++count > 120) { ws.close(1008, 'Invalid observer message'); return }
    let frame: { type?: string; payload?: Record<string, unknown> }
    try { frame = JSON.parse(raw.toString()) } catch { ws.close(1008, 'Invalid observer message'); return }
    if (!opened && frame.type === 'observer_hello' && typeof frame.payload?.ephemeral === 'string'
      && /^[A-Za-z0-9+/]{43}=$/.test(frame.payload.ephemeral)) {
      opened = true
      await down('observer_open', { shareId: share.id, email: user.email.trim().toLowerCase(),
        ephemeral: frame.payload.ephemeral }).catch(() => ws.close(1013, 'Owner unavailable'))
    } else if (opened && frame.type === 'observer_frame' && frame.payload?.__e2e) {
      await down('observer_frame', frame.payload).catch(() => ws.close(1013, 'Owner unavailable'))
    } else ws.close(1008, 'Observer connections are view only')
  }, () => ws.close(1013, 'Sharing temporarily unavailable'), () => ws.close(1008, 'Too many observer messages'))
  ws.on('message', (raw, binary) => inbox.enqueue({ raw, binary }))
}
