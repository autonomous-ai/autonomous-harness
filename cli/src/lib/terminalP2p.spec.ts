import { describe, expect, it, vi } from 'vitest'
import {
  isRelayedPair,
  readTurn,
  TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS,
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
    const selectStunUrls = vi.fn<StunSelector>(async () => ({ urls: [], udpReachable: null }))
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
    let release!: (selection: { urls: string[]; udpReachable: boolean | null }) => void
    const gate = new Promise<{ urls: string[]; udpReachable: boolean | null }>((resolve) => { release = resolve })
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
      release({ urls: [], udpReachable: null })
      await initiator.stop('test_complete', false)
    }
  })

  it('builds nothing at all when stop() lands while the stun race is still in flight', async () => {
    let release!: (selection: { urls: string[]; udpReachable: boolean | null }) => void
    const gate = new Promise<{ urls: string[]; udpReachable: boolean | null }>((resolve) => { release = resolve })
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
    release({ urls: [], udpReachable: null })
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
      selectStunUrls: () => new Promise(() => { /* wedged on purpose */ }),
    })

    try {
      initiator.start()
      await vi.advanceTimersByTimeAsync(TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS + 1)
      expect(states).toContainEqual({ state: 'failed', reason: 'negotiation_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the responder the offered urls, filtered and capped, to race on its own', async () => {
    const selectStunUrls = vi.fn<StunSelector>(async (urls) => ({ urls, udpReachable: true }))
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
          'stun:4.example:3478', 'stun:5.example:3478', 'stun:6.example:3478',
          'stun:7.example:3478', 'stun:8.example:3478', 'stun:9.example:3478',
          'turn:10.example:3478', 42,
        ] as unknown as string[],
      })
      expect(selectStunUrls).toHaveBeenCalledWith([
        'stun:1.example:3478', 'stun:2.example:3478', 'stun:3.example:3478', 'stun:4.example:3478',
        'stun:5.example:3478', 'stun:6.example:3478', 'stun:7.example:3478', 'stun:8.example:3478',
      ])
    } finally {
      await responder.stop()
    }
  })

  it('forwards the turn credential in the offer so the responder can allocate too', async () => {
    // Loopback discard port: werift really does try to allocate against whatever we hand it, so a real
    // hostname here would make this test wait out a live TURN negotiation. A closed local port fails
    // immediately and still proves the credential travelled.
    const turn = { urls: ['turn:127.0.0.1:9?transport=udp'], username: 'cf-user', credential: 'cf-secret' }
    let resolveOffer!: (payload: TerminalP2pSignal) => void
    const offered = new Promise<TerminalP2pSignal>((resolve) => { resolveOffer = resolve })
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478'], openWaitMs: 1_500, turn },
      sendSignal: (type, payload) => { if (type === 'p2p_offer') resolveOffer(payload) },
      onData: () => { /* no peer in this test */ },
      selectStunUrls: async () => ({ urls: [], udpReachable: null }),
    })

    try {
      initiator.start()
      // The responder is never sent a policy of its own, so the offer is its only source of credentials.
      expect((await offered).turn).toEqual(turn)
    } finally {
      await initiator.stop('test_complete', false)
    }
  }, 15_000)

  it('gives the responder the offered turn credential, and drops a malformed one', async () => {
    const seen: Array<unknown> = []
    const responder = new TerminalP2pResponderPool({
      sendSignal: () => { /* the offers below are deliberately unanswerable */ },
      onData: () => { /* no data in this test */ },
      selectStunUrls: async (urls) => ({ urls, udpReachable: true }),
    })
    const offer = (turn: unknown, sessionId: string): Promise<boolean> => responder.handleSignal('source-1', 'p2p_offer', {
      sessionId,
      protocolVersion: 1,
      sdp: 'not-a-real-sdp',
      stunUrls: ['stun:1.example:3478'],
      turn,
    })

    try {
      await offer({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' },
        '00000000-0000-4000-8000-000000000001')
      seen.push(readTurn({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' }))
      // Each of these is rejected for a different reason; all must degrade to STUN-only, not throw.
      for (const bad of [
        undefined,
        { urls: [], username: 'u', credential: 'c' },
        { urls: ['stun:x:3478'], username: 'u', credential: 'c' },
        { urls: ['turn:x:3478'], username: '', credential: 'c' },
        { urls: ['turn:x:3478'], username: 'u', credential: 42 },
        'not-an-object',
      ]) {
        expect(readTurn(bad)).toBeUndefined()
        await offer(bad, '00000000-0000-4000-8000-000000000002')
      }
      expect(seen[0]).toEqual({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' })
    } finally {
      await responder.stop()
    }
  }, 15_000)

  // Real candidate lines, captured from a forced relay-only run against Cloudflare.
  const RELAY = 'candidate:856fe30cc 1 udp 16777215 104.30.136.14 29000 typ relay raddr 14.161.43.75 rport 55397'
  const SRFLX = 'candidate:2b1f0a4c9 1 udp 1686052607 14.161.43.75 55397 typ srflx raddr 192.168.1.16 rport 55397'
  const HOST = 'candidate:9d3e77bb1 1 udp 2130706431 192.168.1.16 55397 typ host'

  it('counts a pair as relayed when EITHER end is a turn allocation', () => {
    // The half that used to be missed: our side is srflx, the peer allocated the relay, and every byte
    // still crosses Cloudflare — reading only the local candidate reported that as direct and
    // under-counted the traffic that gets billed.
    expect(isRelayedPair(SRFLX, RELAY)).toBe(true)
    expect(isRelayedPair(RELAY, SRFLX)).toBe(true)
    expect(isRelayedPair(RELAY, RELAY)).toBe(true)
  })

  it('counts a pair as direct only when neither end relays', () => {
    expect(isRelayedPair(HOST, HOST)).toBe(false)
    expect(isRelayedPair(SRFLX, SRFLX)).toBe(false)
    expect(isRelayedPair(HOST, SRFLX)).toBe(false)
    expect(isRelayedPair(SRFLX)).toBe(false) // remote unknown
  })

  it('does not mistake a host address that merely contains the word', () => {
    expect(isRelayedPair('candidate:1 1 udp 1 10.0.0.1 1 typ host raddr relay.example')).toBe(false)
  })
})
