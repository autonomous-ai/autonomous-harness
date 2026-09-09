import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Frame, LocalClientSink } from './backendSocket.js'
import {
  decodeTerminalLocal,
  TERMINAL_BINARY_VERSION,
  TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES,
  type TerminalBinaryClear,
} from './lib/terminalBinary.js'
import { RelayConnectError, type RelaySession, type RemoteRelayPool } from './lib/remoteRelay.js'

export const LOCAL_WS_PATH = '/api/local-ws'
export const LOCAL_WS_PROTOCOL_VERSION = 1

const MAX_JSON_BYTES = 512 * 1024
// The `ws` library enforces this on EVERY message on this socket, JSON or binary — so it has to
// cover the largest binary frame this transport carries, not just JSON control frames. That is a
// paste (see TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES in terminalBinary.ts), plus a little slack for
// the local frame header; ordinary JSON frames stay bounded by MAX_JSON_BYTES regardless.
const MAX_WS_MESSAGE_BYTES = TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES + 4_096
const HEARTBEAT_MS = 20_000

import type { WindowVoiceReply } from './cable/windowRoute.js'

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
  /** The desktop app opened an agent's terminal — which agent, and on which machine. Lets the dial follow
   *  the window, so the two screens stay one desk. */
  onAppFocus?: (machineId: string, agentId: string) => void
  /** Every agent the window currently has a tile for, across all its machines. */
  onAppPanes?: (agentIds: string[]) => void
  /**
   * The window asked WHICH AGENT a typed task belongs to (⌘K). Answers, and sends NOTHING.
   *
   * Two frames rather than one, and the split is the design: the window decides whether the answer is
   * good enough to act on. Fold them together with a `commit` flag and the confidence threshold moves in
   * here, where nothing knows what the person is looking at.
   */
  onRouteTask?: (text: string) => Promise<RouteAnswer>
  /**
   * The window committed to an agent — deliver the task, and SAY whether it could be delivered.
   *
   * It answers for the same reason `route_task` does. The remote leg carries no ack of its own, so a
   * machine that has gone deaf takes the turn and nothing comes back; with the palette closing silently
   * on a confident route, that is a spoken instruction that vanishes with no mark anywhere.
   */
  onRouteSend?: (agentId: string, text: string) => { ok: true } | { ok: false; machine: string; reason: string }
  /**
   * The window answering a `voice_route_request` — words spoken into the dial that IT was asked to route.
   *
   * One-way and uncorrelated by `requestId`, unlike ⌘B above, because the question travelled the other
   * way: the daemon asked, so the daemon holds the pending id (`voiceId`) and the window is simply
   * reporting. `taken` first, then `sent` or `cancelled` — see cable/windowRoute.ts for why the ack is a
   * separate frame rather than a flag on the answer.
   */
  onVoiceRouteReply?: (voiceId: string, reply: WindowVoiceReply) => void
}

/** One candidate, as the window draws it in the picker. */
export interface RouteCandidate {
  agentId: string
  /** Which machine to open the pane on. Names are for reading; this is for acting. */
  machineId: string
  name: string
  /** Which computer it runs on. The list spans every machine, and two agents called "api" on two of them
   *  are otherwise the same row twice. */
  machine: string
  /** What it was last doing — the line under the name when the window has to ask. */
  recent: string
  /** Which CLI it runs on — 'claude', 'codex', … The window draws the same engine mark its rail does, so
   *  a row in the picker and the same agent in the rail are recognisably one thing. */
  engine: string
  /** How well the router thought this one fits, 0..1. DISPLAY ONLY — the pick is [RouteAnswer.agentId]
   *  and the number that gates it is [RouteAnswer.confidence]. 0 means the router said nothing about
   *  this candidate, which the window draws as no bar rather than as an empty one. */
  confidence: number
}

export interface RouteAnswer {
  agentId: string
  machineId: string
  name: string
  confidence: number
  reason: string
  /** The best few, most confident first. Only read when the window decides to ask. */
  candidates: RouteCandidate[]
  /** How many agents were weighed, and across how many computers — what the window shows while it waits.
   *  The candidate list is capped, so this is the only place that says whether the right agent was even
   *  in the running. */
  weighed: number
  machines: number
  /** 'model' when a classifier answered, 'heuristic' when name matching stood in for it. Both land on a
   *  low confidence by design; this is what lets the window say WHICH happened instead of showing the
   *  same sentence for a router that was unsure and one that never ran. */
  via: string
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
    maxPayload: MAX_WS_MESSAGE_BYTES,
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
    // Which machine THIS connection is bound to. The app opens one local socket per machine, so it is
    // fixed for the life of the connection — set once, beside `selected`.
    let boundMachineId: string | null = null
    let relay: RelaySession | null = null
    /** Whether this connection ever reported a tile roster — only then is clearing it ours to do. */
    let sentPanes = false
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
          if (typeof requestedMachineId === 'string') boundMachineId = requestedMachineId
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
          // The local client observed a live RPC time out against an otherwise-"connected" machine —
          // its pooled entry is suspect (most commonly the relayed machine's own Harness process
          // restarted, dropping its E2EE session without the transport itself ever closing). Drop it
          // so this select dials fresh instead of handing back the same dead session again.
          if (payload?.forceReconnect === true) options.relayPool.invalidate(requestedMachineId)
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

        // THE APP MOVED — tell whoever wants to follow it, before the frame is dispatched either way.
        // Sniffed here rather than in the backend socket because that path never sees a RELAYED machine's
        // frames: those are forwarded upstream a few lines below and would be invisible, which is exactly
        // the case that matters — the dial has to follow the window onto ANOTHER machine too.
        // The window's tile ROSTER. Consumed here like `app_focus` — it describes
        // a screen at this desk, not anything the machine could act on.
        //
        // It carries every agent the window has open, INCLUDING ones belonging
        // to other machines, and the app sends the same list to every daemon it
        // is connected to. That is deliberate: the dial is served by whichever
        // daemon owns the cable, and only a full picture lets that one decide
        // whether a finished turn is already in front of the person.
        if (!isBinary && options.onAppPanes) {
          const roster = jsonFrame(raw)
          if (roster?.type === 'app_panes') {
            const raw = (roster.payload as Record<string, unknown> | undefined)?.agentIds
            const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : []
            sentPanes = true
            options.onAppPanes(ids)
            return
          }
        }
        // ⌘K: the only REQUEST/RESPONSE pair this socket serves. Everything else on it is one-way.
        //
        // It rides the app's OWN rpc convention — `payload.requestId` out, the same id back — which the
        // window already implements end to end: the pending map, the timeout, the queue-across-reconnect
        // and the logging are all there (ws_conn.dart `request()`). Inventing a second correlation field
        // here would have meant a second, thinner copy of all of it on the side that already had one.
        //
        // Consumed here like app_focus: it describes a hand at this desk, not anything the machine could
        // act on.
        if (!isBinary && (options.onRouteTask || options.onRouteSend || options.onVoiceRouteReply)) {
          const asked = jsonFrame(raw)
          if (asked?.type === 'route_task' && options.onRouteTask) {
            const payload = asked.payload as Record<string, unknown> | undefined
            const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
            const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
            // An answer ALWAYS goes back, even for a question we cannot serve: the window is holding a
            // spinner open on this id, and silence is the one reply it cannot recover from.
            let answer: RouteAnswer = { agentId: '', machineId: '', name: '', confidence: 0, reason: 'empty task', candidates: [], weighed: 0, machines: 0, via: '' }
            if (text) {
              try {
                answer = await options.onRouteTask(text)
              } catch (err) {
                answer = { agentId: '', machineId: '', name: '', confidence: 0, reason: (err as Error).message.slice(0, 120), candidates: [], weighed: 0, machines: 0, via: '' }
              }
            }
            sink.sendFrame({ type: 'route_result', payload: { requestId, ...answer } })
            return
          }
          if (asked?.type === 'voice_route_reply' && options.onVoiceRouteReply) {
            const payload = asked.payload as Record<string, unknown> | undefined
            const voiceId = typeof payload?.voiceId === 'string' ? payload.voiceId : ''
            const state = typeof payload?.state === 'string' ? payload.state : ''
            const agentId = typeof payload?.agentId === 'string' ? payload.agentId : ''
            // Unknown states are dropped rather than guessed at: an answer this side cannot read must
            // not settle a spoken turn as though it had been understood.
            if (voiceId) {
              if (state === 'taken') options.onVoiceRouteReply(voiceId, { t: 'taken' })
              else if (state === 'sent') options.onVoiceRouteReply(voiceId, { t: 'sent', agentId })
              else if (state === 'cancelled') options.onVoiceRouteReply(voiceId, { t: 'cancelled' })
            }
            return
          }
          if (asked?.type === 'route_send' && options.onRouteSend) {
            const payload = asked.payload as Record<string, unknown> | undefined
            const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
            const agentId = typeof payload?.agentId === 'string' ? payload.agentId : ''
            const text = typeof payload?.text === 'string' ? payload.text : ''
            let sent: { ok: true } | { ok: false; machine: string; reason: string } =
              { ok: false, machine: '', reason: 'nothing to send' }
            if (agentId && text) {
              try {
                sent = options.onRouteSend(agentId, text)
              } catch (err) {
                sent = { ok: false, machine: '', reason: (err as Error).message.slice(0, 120) }
              }
            }
            sink.sendFrame({
              type: 'route_send_result',
              payload: sent.ok
                ? { requestId, ok: true }
                : { requestId, ok: false, machine: sent.machine, reason: sent.reason },
            })
            return
          }
        }
        if (!isBinary && options.onAppFocus && boundMachineId) {
          const moved = jsonFrame(raw)
          const agentId = (moved?.payload as Record<string, unknown> | undefined)?.agentId
          if (typeof agentId === 'string' && agentId) {
            // `app_focus` is the window SAYING where it is looking. `terminal_open` is it being
            // inferred from a side effect, which is all there was when a window could only show one
            // terminal: every move opened a stream, so opening one meant it had moved.
            //
            // A pane grid breaks that equivalence. Clicking a tile that already holds a live session
            // opens nothing at all, so the dial never heard about it and stayed on the agent the last
            // rail click had opened. Both are still read: an older app build only sends the second.
            if (moved?.type === 'app_focus') {
              options.onAppFocus(boundMachineId, agentId)
              // Consumed here. It describes a hand at THIS desk and the machine has no use for it —
              // forwarding it would put an unknown frame type on the wire for every pane click.
              return
            }
            if (moved?.type === 'terminal_open') options.onAppFocus(boundMachineId, agentId)
          }
        }

        if (relay) {
          // The relay now terminates E2EE itself (lib/remoteRelay.ts) — every frame past this point is
          // already plaintext going in and out, so binary frames use the SAME local wire format as this
          // daemon's own machine.
          if (isBinary) {
            const clear = decodeTerminalLocal(binaryBytes(raw))
            if (!clear) { close(4400, 'invalid terminal frame'); return }
            await relay.sendBinary(clear)
            return
          }
          const frame = jsonFrame(raw)
          if (!frame) { close(4400, 'invalid json frame'); return }
          await relay.send(frame)
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
      // A window that went away has no tiles open. Left standing, the roster
      // would keep silencing the dial for agents nobody can see any more —
      // exactly backwards, and permanently.
      if (sentPanes) options.onAppPanes?.([])
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
