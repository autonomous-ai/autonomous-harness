import { describe, expect, it } from 'vitest'
import { TerminalP2pInitiator, TerminalP2pResponderPool } from './terminalP2p.js'

describe('terminal WebRTC data channel', () => {
  it('negotiates locally and carries ordered text and binary frames in both directions', async () => {
    let resolveResponderData!: (value: string) => void
    let resolveInitiatorData!: (value: Buffer) => void
    const responderData = new Promise<string>((resolve) => { resolveResponderData = resolve })
    const initiatorData = new Promise<Buffer>((resolve) => { resolveInitiatorData = resolve })
    let initiator!: TerminalP2pInitiator
    const responder = new TerminalP2pResponderPool({
      sendSignal: (_connId, type, payload) => { void initiator.handleSignal(type, payload) },
      onData: (_connId, data) => resolveResponderData(typeof data === 'string' ? data : data.toString()),
    })
    initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 1_500 },
      sendSignal: (type, payload) => { void responder.handleSignal('source-1', type, payload) },
      onData: (data) => resolveInitiatorData(typeof data === 'string' ? Buffer.from(data) : data),
    })

    try {
      initiator.start()
      expect(await initiator.waitUntilReady(5_000)).toBe(true)
      expect(initiator.send('terminal-input')).toBe(true)
      expect(await responderData).toBe('terminal-input')

      expect(responder.send('source-1', Buffer.from([0x48, 0x54, 0x52, 0x4d]))).toBe(true)
      expect(await initiatorData).toEqual(Buffer.from([0x48, 0x54, 0x52, 0x4d]))
    } finally {
      await initiator.stop('test_complete', false)
      await responder.stop()
    }
  }, 10_000)
})
