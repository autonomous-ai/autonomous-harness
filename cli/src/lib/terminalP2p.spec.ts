import { describe, expect, it, vi } from 'vitest'
import {
  TerminalP2pInitiator,
  TerminalP2pResponderPool,
  type TerminalP2pSignal,
} from './terminalP2p.js'
import type { StunSelector } from './stunSelect.js'

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

  it('races the policy stun urls but still offers the raw list, since peers need not agree', async () => {
    const policyUrls = ['stun:a.example:3478', 'stun:b.example:3478']
    // Returning [] keeps werift on host candidates, so the offer is emitted immediately instead of
    // waiting out a gather against hosts that do not resolve.
    const selectStunUrls = vi.fn<StunSelector>(async () => [])
    let resolveOffer!: (payload: TerminalP2pSignal) => void
    const offered = new Promise<TerminalP2pSignal>((resolve) => { resolveOffer = resolve })
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: policyUrls, openWaitMs: 1_500 },
      sendSignal: (type, payload) => { if (type === 'p2p_offer') resolveOffer(payload) },
      onData: () => { /* no peer in this test */ },
      selectStunUrls,
    })

    try {
      initiator.start()
      const offer = await offered
      expect(selectStunUrls).toHaveBeenCalledTimes(1)
      expect(selectStunUrls).toHaveBeenCalledWith(policyUrls)
      // The winner is deliberately NOT pinned into the offer: the responder races the same list for
      // itself, and a srflx candidate is each peer's own public address, so they need not agree.
      expect(offer.stunUrls).toEqual(policyUrls)
    } finally {
      await initiator.stop('test_complete', false)
    }
  }, 15_000)

  it('builds one peer connection when start() is called twice during the stun race', async () => {
    let release!: (urls: string[]) => void
    const gate = new Promise<string[]>((resolve) => { release = resolve })
    const selectStunUrls = vi.fn<StunSelector>(() => gate)
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: () => { /* nothing to signal in this test */ },
      onData: () => { /* no peer in this test */ },
      selectStunUrls,
    })

    try {
      initiator.start()
      initiator.start()
      expect(selectStunUrls).toHaveBeenCalledTimes(1)
    } finally {
      release([])
      await initiator.stop('test_complete', false)
    }
  })

  it('builds nothing at all when stop() lands while the stun race is still in flight', async () => {
    let release!: (urls: string[]) => void
    const gate = new Promise<string[]>((resolve) => { release = resolve })
    const states: string[] = []
    const signals: string[] = []
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: (type) => { signals.push(type) },
      onData: () => { /* no peer in this test */ },
      onState: (state) => { states.push(state) },
      selectStunUrls: () => gate,
    })

    initiator.start()
    const ready = initiator.waitUntilReady(5_000)
    await initiator.stop('test_complete', false)
    release([])
    await new Promise((resolve) => setTimeout(resolve, 20))

    // No offer was ever sent, which is the observable proof no RTCPeerConnection was constructed —
    // one built after stop() would be an orphan with live UDP sockets nothing would ever close.
    expect(signals).not.toContain('p2p_offer')
    expect(await ready).toBe(false)
    expect(states).toEqual(['connecting', 'closed'])
  })

  it('fails on the negotiation timeout even if the stun race never settles', async () => {
    vi.useFakeTimers()
    const states: Array<{ state: string; reason?: string }> = []
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: () => { /* nothing to signal in this test */ },
      onData: () => { /* no peer in this test */ },
      onState: (state, _setupMs, reason) => { states.push({ state, reason }) },
      selectStunUrls: () => new Promise<string[]>(() => { /* wedged on purpose */ }),
    })

    try {
      initiator.start()
      await vi.advanceTimersByTimeAsync(10_001)
      expect(states).toContainEqual({ state: 'failed', reason: 'negotiation_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the responder the offered urls, filtered and capped, to race on its own', async () => {
    const selectStunUrls = vi.fn<StunSelector>(async (urls) => urls)
    const responder = new TerminalP2pResponderPool({
      sendSignal: () => { /* the offer below is deliberately unanswerable */ },
      onData: () => { /* no data in this test */ },
      selectStunUrls,
    })

    try {
      await responder.handleSignal('source-1', 'p2p_offer', {
        sessionId: '00000000-0000-4000-8000-000000000000',
        protocolVersion: 1,
        sdp: 'not-a-real-sdp',
        stunUrls: [
          'stun:1.example:3478', 'stun:2.example:3478', 'stun:3.example:3478',
          'stun:4.example:3478', 'stun:5.example:3478', 'turn:6.example:3478', 42,
        ] as unknown as string[],
      })
      expect(selectStunUrls).toHaveBeenCalledWith([
        'stun:1.example:3478', 'stun:2.example:3478', 'stun:3.example:3478', 'stun:4.example:3478',
      ])
    } finally {
      await responder.stop()
    }
  })
})
