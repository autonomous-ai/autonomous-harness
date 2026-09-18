import { WebSocket } from 'ws'
import { b64e, newEphemeral } from '../lib/e2ee/core.js'
import type { AuthSessionManager } from '../lib/authSession.js'
import type { Frame, LocalClientSink } from '../backendSocket.js'
import type { RelaySession } from '../lib/remoteRelay.js'
import { recipientHandshake, type ObserverCipher } from './crypto.js'
import { watchSocketLiveness } from '../lib/wsLiveness.js'

export interface SharedHarnessReference {
  id: string; agentId: string; name: string; engine: string | null; ownerPublicKey: string; expiresAt: string
}
export interface SharedMachineReference {
  machineId: string; name: string | null; ownerName: string; status: string; shares: SharedHarnessReference[]
}

export class SharingEndedError extends Error {}

/** One invitation per connection. Never promoted into a full machine link or a shared connection pool. */
export class HarnessShareRelay {
  private sessions = new Set<() => void>()
  constructor(private readonly auth: AuthSessionManager, private readonly backendWsBase: string,
    private readonly environment: string, private readonly discover: () => Promise<SharedMachineReference[]>) {}
  async acquire(machineId: string, shareId: string, sink: LocalClientSink,
    onClosed: (code: number, reason: string) => void): Promise<RelaySession> {
    const machines = await this.discover()
    const machine = machines.find(m => m.machineId === machineId)
    const share = machine?.shares.find(s => s.id === shareId)
    if (!share) throw new SharingEndedError('Sharing ended or invitation expired')
    const token = await this.auth.accessToken()
    const url = `${this.backendWsBase.replace(/\/$/, '')}/api/observer-ws?share=${encodeURIComponent(shareId)}&autonomousEnv=${encodeURIComponent(this.environment)}`
    const ws = new WebSocket(url, [token], { handshakeTimeout: 10_000, maxPayload: 3 * 1024 * 1024 })
    const ephemeral = newEphemeral()
    let cipher: ObserverCipher | null = null, detached = false, settled = false
    let heartbeat: ReturnType<typeof watchSocketLiveness> | null = null
    const detach = () => { detached = true; heartbeat?.stop(); this.sessions.delete(detach); ws.terminate() }
    this.sessions.add(detach)
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('The owner’s machine is not responding.')); detach() }, 15_000)
        const ready = () => {
          settled = true; clearTimeout(timeout)
          sink.sendFrame({ type: 'connected', payload: { machineId, e2ee: false, readOnly: true } })
          resolve()
        }
        ws.on('error', () => { if (!settled) { clearTimeout(timeout); reject(new Error('Could not connect to the shared harness.')) } })
        ws.on('close', (code, reason) => {
          clearTimeout(timeout); heartbeat?.stop(); this.sessions.delete(detach)
          if (!settled) reject(new Error(reason.toString() || 'The owner’s machine is offline.'))
          if (!detached) onClosed(code === 4403 ? 4403 : 1012, reason.toString() || 'Owner disconnected')
        })
        ws.on('open', () => { heartbeat = watchSocketLiveness(ws) })
        ws.on('message', raw => {
          try {
            const frame = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> }
            if (frame.type === 'observer_connected') {
              ws.send(JSON.stringify({ type: 'observer_hello', payload: { ephemeral: b64e(ephemeral.pub) } }))
            } else if (frame.type === 'observer_welcome' && !cipher) {
              cipher = recipientHandshake(ephemeral, machineId, shareId, share.ownerPublicKey, frame.payload)
              ready()
            } else if (frame.type === 'observer_closed') {
              onClosed(frame.payload?.retry === true ? 1012 : 4403, String(frame.payload?.reason || 'Sharing ended'))
              if (!settled) { clearTimeout(timeout); reject(new Error('Sharing ended')) }
              detach()
            } else if (frame.type === 'observer_frame' && cipher) {
              const clear = cipher.open(frame.payload)
              if (!clear) { onClosed(1011, 'Shared harness verification failed'); detach(); return }
              if (clear.type === 'observer_binary') {
                const bytes = (clear.payload as { bytes?: unknown })?.bytes
                if (typeof bytes === 'string') sink.sendBinary(Buffer.from(bytes, 'base64'))
              } else sink.sendFrame(clear)
            }
          } catch {
            clearTimeout(timeout)
            if (settled) onClosed(1011, 'The shared harness identity could not be verified.')
            reject(new Error('The shared harness identity could not be verified.')); detach()
          }
        })
      })
    } catch (error) { detach(); throw error }
    return {
      send: async (frame: Frame) => {
        if (!cipher || detached || ws.readyState !== WebSocket.OPEN) return
        // The owner repeats this check after decrypting. Restrict here too so a local client cannot
        // accidentally send terminal responses, resize events or pasted data into an observer stream.
        if (!['terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack', 'terminal_resync',
          'terminal_close', 'observer_viewer'].includes(String(frame.type))) {
          sink.sendFrame({ type: `${String(frame.type)}_result`, payload: {
            requestId: (frame.payload as { requestId?: unknown })?.requestId, error: 'VIEW_ONLY',
          } }); return
        }
        ws.send(JSON.stringify({ type: 'observer_frame', payload: cipher.seal(frame) }))
      },
      sendBinary: async () => { /* Observers never send terminal bytes. */ },
      detach,
    }
  }
  close(): void { for (const stop of [...this.sessions]) stop() }
}
