import { describe, expect, it, vi } from 'vitest'
import { RemoteRelayPool } from './remoteRelay.js'

/** Minimal fake of the private `Entry` shape `noteTerminalResponse`/`demoteP2p` operate on — exercised
 *  directly (bypassing the class's `private` marker, the lightest way to unit-test this without a real
 *  WebRTC negotiation or a live relay socket) since the reporting logic under test is pure bookkeeping
 *  derived from `p2pStreams`/`p2pPendingOpens`, not anything that needs a real transport underneath it. */
function fakeEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ws: { send: vi.fn() },
    crypto: { wrapOutgoing: (frame: unknown) => frame },
    sink: { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) },
    onClosed: null,
    lingerTimer: null,
    alive: true,
    heartbeatTimer: null,
    p2p: null,
    p2pPolicy: null,
    p2pPendingOpens: new Set<string>(),
    p2pStreams: new Set<string>(),
    ...overrides,
  }
}

describe('RemoteRelayPool reports terminal_link_mode to the local sink', () => {
  // Constructor args are never touched by the private methods under test — only entry-level state is.
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'unused' } as never,
    'ws://unused',
    { pub: new Uint8Array(), priv: new Uint8Array() } as never,
    { pin: () => {}, get: () => null } as never,
  ) as unknown as {
    noteTerminalResponse: (entry: ReturnType<typeof fakeEntry>, frame: Record<string, unknown>, transport: 'p2p' | 'relay') => void
    demoteP2p: (entry: ReturnType<typeof fakeEntry>, reason: string) => void
  }

  it('a terminal_ready confirmed on p2p reports mode:p2p, matching p2pStreams', () => {
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-1']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-1', streamId: 'stream-1' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-1')).toBe(true)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-1', mode: 'p2p' },
    })
  })

  it.each([
    ['relay', 'turn'],
    ['direct', 'p2p'],
    [null, 'p2p'],
  ])('a p2p terminal_ready whose ICE pair is %s reports mode:%s', (transport, expected) => {
    // The data channel is up either way; what differs is which candidate pair ICE nominated. A relay
    // pair means every byte is going through Cloudflare TURN, which is the state that costs money —
    // and the one the badge could not tell apart before. A null pair keeps the pre-TURN optimism.
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-turn']), p2p: { transport } })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-turn', streamId: 'stream-turn' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-turn')).toBe(true)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-turn', mode: expected },
    })
  })

  it('a stream with no data channel stays mode:relay however the ICE pair reads', () => {
    // Guards the additive rename: 'relay' must keep meaning "on the backend WebSocket" so an older
    // Desktop build can never read a TURN session as a WS one.
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-ws']), p2p: { transport: 'relay' } })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-ws', streamId: 'stream-ws' } }, 'relay')

    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-ws', mode: 'relay' },
    })
  })

  it('a terminal_ready delivered over relay reports mode:relay', () => {
    const entry = fakeEntry({ p2pPendingOpens: new Set(['req-2']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-2', streamId: 'stream-2' } }, 'relay')

    expect(entry.p2pStreams.has('stream-2')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-2', mode: 'relay' },
    })
  })

  it('a stale/unmatched requestId never reports p2p, even if the transport param says p2p', () => {
    const entry = fakeEntry() // no pending open for 'req-3' — delete() will return false
    pool.noteTerminalResponse(entry, { type: 'terminal_ready', payload: { requestId: 'req-3', streamId: 'stream-3' } }, 'p2p')

    expect(entry.p2pStreams.has('stream-3')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-3', mode: 'relay' },
    })
  })

  it('a non-ready frame for a p2p stream that arrives over relay quietly demotes just that stream, and reports it', () => {
    const entry = fakeEntry({ p2pStreams: new Set(['stream-4']) })
    pool.noteTerminalResponse(entry, { type: 'terminal_alive', payload: { streamId: 'stream-4' } }, 'relay')

    expect(entry.p2pStreams.has('stream-4')).toBe(false)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-4', mode: 'relay' },
    })
  })

  it('a frame for a stream not on p2p never spuriously reports anything', () => {
    const entry = fakeEntry()
    pool.noteTerminalResponse(entry, { type: 'terminal_output', payload: { streamId: 'stream-5' } }, 'relay')

    expect(entry.sink.sendFrame).not.toHaveBeenCalled()
  })

  it('demoteP2p reports mode:relay for every stream it drops', () => {
    const entry = fakeEntry({ p2pStreams: new Set(['stream-a', 'stream-b']) })
    pool.demoteP2p(entry, 'send_failed')

    expect(entry.p2pStreams.size).toBe(0)
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-a', mode: 'relay' },
    })
    expect(entry.sink.sendFrame).toHaveBeenCalledWith({
      type: 'terminal_link_mode',
      payload: { streamId: 'stream-b', mode: 'relay' },
    })
  })

  it('demoteP2p on a connection with no active p2p streams reports nothing', () => {
    const entry = fakeEntry()
    pool.demoteP2p(entry, 'send_failed')

    expect(entry.sink.sendFrame).not.toHaveBeenCalled()
  })
})
