/** Opt-in two-machine fixture for Desktop's remote_media_smoke_test.dart.
 * A relays loopback app frames; B serves real files. Both use production E2EE
 * handshake/wrapping and media reads, with isolated identities and data dirs. */
import { WebSocket, WebSocketServer } from 'ws'
import { newIdentity, b64e, isWrapped } from '../src/lib/e2ee/core.js'
import { E2eeStore } from '../src/lib/e2ee/store.js'
import { E2eeManager } from '../src/lib/e2ee/manager.js'
import { RelaySessionCrypto } from '../src/lib/e2ee/relayClient.js'
import { MediaPreviewError, readMediaPreviewChunk } from '../src/lib/mediaPreview.js'

if (process.env.HARNESS_MEDIA_SMOKE !== '1' || !process.env.ADAPTER_DATA_DIR || !process.argv[2]) {
  throw new Error('This test fixture requires explicit smoke mode, an isolated data directory and an artifact directory.')
}
const root = process.argv[2]
const identityA = newIdentity()
const storeB = new E2eeStore()
const identityB = storeB.init()
storeB.addPaired(b64e(identityA.pub), 'Smoke machine A', Date.now())
const connections = new Map<string, WebSocket>()
let encryptedRequests = 0
let encryptedReplies = 0
let maxFrameBytes = 0
const managerB = new E2eeManager({
  machineId: 'smoke-B', isConnected: () => true,
  sendTo: (id, frame) => connections.get(id)?.send(JSON.stringify(frame)),
})
const peerB = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>(resolve => peerB.once('listening', resolve))
let sequence = 0
peerB.on('connection', socket => {
  const id = `smoke-A-${++sequence}`
  connections.set(id, socket)
  socket.on('close', () => { connections.delete(id); managerB.dropSession(id) })
  socket.on('message', async raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type.startsWith('e2e_')) { managerB.handleFrame(id, frame); return }
    if (frame.type !== 'agent_read_file' || !isWrapped(frame.payload)) throw new Error('Media request was not encrypted')
    encryptedRequests++
    const decoded = managerB.unwrapDown(id, frame)
    if (!decoded) throw new Error('Media request failed authentication')
    const payload = decoded.payload as Record<string, unknown>
    // Network fault injection is confined to this opt-in fixture.
    if (Number(payload.offset) > 0 && payload.smokeDisconnect) { socket.close(); return }
    if (Number(payload.offset) > 0 && payload.smokeDelay) await new Promise(resolve => setTimeout(resolve, 100))
    let result: Record<string, unknown>
    try {
      result = { ...await readMediaPreviewChunk(root, String(payload.path), payload.offset, payload.revision) }
    } catch (error) {
      result = { error: error instanceof MediaPreviewError ? error.message : 'MEDIA_READ_FAILED' }
    }
    if (socket.readyState !== WebSocket.OPEN) return
    const wrapped = managerB.wrapRpcReply(id, 'agent_read_file_result', payload.requestId, result)
    if (!wrapped || !isWrapped(wrapped.payload)) throw new Error('Media reply was not encrypted')
    const wire = JSON.stringify(wrapped)
    maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(wire))
    encryptedReplies++
    socket.send(wire)
  })
})

const appA = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>(resolve => appA.once('listening', resolve))
appA.on('connection', local => {
  const cryptoA = new RelaySessionCrypto({ machineId: 'smoke-B', selfIdentity: identityA, peerPub: identityB.pub })
  const peer = new WebSocket(`ws://127.0.0.1:${(peerB.address() as { port: number }).port}`)
  peer.on('open', () => peer.send(JSON.stringify(cryptoA.helloFrame())))
  peer.on('message', raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type === 'e2e_welcome') {
      if (!cryptoA.handleWelcome(frame.payload)) throw new Error('Smoke handshake failed')
      local.send(JSON.stringify({ type: 'connected', payload: { machineId: 'smoke-B' } }))
      return
    }
    const decoded = cryptoA.unwrapIncoming(frame)
    if (!decoded) throw new Error('Media reply failed authentication')
    if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(decoded))
  })
  peer.on('close', () => local.close())
  local.on('close', () => peer.close())
  local.on('message', raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type === 'machine_select') return
    if (frame.type === 'smoke_stats') {
      local.send(JSON.stringify({ type: 'smoke_stats_result', payload: {
        requestId: frame.payload.requestId, encryptedRequests, encryptedReplies, maxFrameBytes,
      } }))
      return
    }
    if (!cryptoA.ready) throw new Error('App sent media before the handshake')
    peer.send(JSON.stringify(cryptoA.wrapOutgoing(frame)))
  })
})
console.log(JSON.stringify({ port: (appA.address() as { port: number }).port }))
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
