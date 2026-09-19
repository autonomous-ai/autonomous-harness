import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewerWire, VIEWER_CHUNK_BYTES, VIEWER_WINDOW_BYTES, viewerHeaders, viewerStreamId, viewerTarget } from './viewerWire.js'

afterEach(() => vi.useRealTimers())

describe('viewer protocol validation', () => {
  it.each([undefined, '', 'not a url', 'http://[', 'http://127.0.0.1:123/a b', 'x'.repeat(8193),
    'https://127.0.0.1:123/', 'http://example.com:123/', 'http://user:password@localhost:123/', 'http://localhost/'])('rejects destination %s', (url) => {
    expect(viewerTarget(url)).toBeNull()
  })
  it.each(['http://127.0.0.1:123/', 'http://localhost:123/?file=a', 'http://[::1]:123/'])('accepts an explicit HTTP loopback port %s', (url) => {
    expect(viewerTarget(url)?.href).toBe(url)
  })
  it('requires a bounded stream id and bounded valid headers', () => {
    for (const id of [null, 1, '', 'a/b', 'a'.repeat(65)]) expect(viewerStreamId(id)).toBe(false)
    expect(viewerStreamId('valid-id')).toBe(true)
    for (const headers of [null, [], 'header', { 'Bad:Key': 'value' }, { valid: [1] }, { valid: 'bad\r\nvalue' }, { valid: 'x'.repeat(32769) }]) {
      expect(() => viewerHeaders(headers)).toThrow()
    }
    expect(viewerHeaders({ connection: 'x-private, keep-alive', 'x-private': 'hidden', 'set-cookie': ['a=b', 'c=d'] }))
      .toEqual({ 'set-cookie': ['a=b', 'c=d'] })
  })
})

describe('viewer stream lifecycle and failure handling', () => {
  it('expires unopened connections and stalled transfers, while idle live streams stay open', async () => {
    vi.useFakeTimers()
    const unopened = new ViewerWire('a', () => true)
    await vi.advanceTimersByTimeAsync(30001)
    expect(unopened.destroyed).toBe(true)
    const active = new ViewerWire('b', () => true)
    active.ready()
    await vi.advanceTimersByTimeAsync(60000)
    expect(active.destroyed).toBe(false)
    active.write(Buffer.from('data'))
    await vi.advanceTimersByTimeAsync(30001)
    expect(active.destroyed).toBe(true)
    // Upload credit is not an HTTP response. A fully accepted POST still needs a header deadline.
    const upload = new ViewerWire('c', () => true)
    upload.write(Buffer.from('body'))
    upload.handle('viewer_ack', { bytes: 4 })
    await vi.advanceTimersByTimeAsync(30001)
    expect(upload.destroyed).toBe(true)
    // Headers do not forgive a stalled body in the opposite direction either.
    const duplex = new ViewerWire('d', () => true)
    duplex.write(Buffer.from('body'))
    duplex.ready()
    await vi.advanceTimersByTimeAsync(30001)
    expect(duplex.destroyed).toBe(true)
  })

  it('handles failed sends, cancellation with queued writes and data arriving after close', () => {
    const failed = new ViewerWire('a', () => false)
    failed.write(Buffer.from('data'), () => {})
    expect(failed.destroyed).toBe(true)
    failed.handle('viewer_data', { data: 'not read' })
    expect((failed as any).emitWire('viewer_ack')).toBe(false)
    const cancelled = new ViewerWire('b', () => true)
    cancelled.write(Buffer.alloc(VIEWER_WINDOW_BYTES * 2), () => {})
    cancelled.destroy()
    const done = new ViewerWire('c', () => true)
    done.destroy(new Error('cancelled'))
    expect(done.destroyed).toBe(true)
  })

  it.each([
    { data: 1 }, { data: 'a'.repeat(50000) }, { data: '?' }, { data: 'YQ' }, { data: '' },
  ])('refuses malformed data %j', (payload) => {
    const stream = new ViewerWire('a', () => true)
    stream.handle('viewer_data', payload)
    expect(stream.destroyed).toBe(true)
  })

  it('does not accept data after end, repeat end, zero credit or oversized credit', () => {
    const stream = new ViewerWire('a', () => true)
    stream.handle('viewer_end', {})
    stream.handle('viewer_end', {})
    stream.handle('viewer_data', { data: 'YQ==' })
    expect(stream.destroyed).toBe(true)
    for (const bytes of [0, 1, '1', -1, 1.5]) {
      const stream = new ViewerWire('b', () => true)
      stream.handle('viewer_ack', { bytes })
      expect(stream.destroyed).toBe(true)
    }
  })

  it('accepts partial credit, resumes a held read and handles peer cancellation without echoing it', async () => {
    const send = vi.fn((_type: string, _payload: Record<string, unknown>) => true)
    const stream = new ViewerWire('a', send)
    stream.handle('unknown_viewer_frame', {})
    stream.write(Buffer.alloc(10))
    stream.handle('viewer_ack', { bytes: 5 })
    stream.handle('viewer_ack', { bytes: 5 })
    stream.handle('viewer_data', { data: Buffer.alloc(VIEWER_CHUNK_BYTES).toString('base64') })
    stream.resume()
    await new Promise((resolve) => setImmediate(resolve))
    expect(send).toHaveBeenCalledWith('viewer_ack', expect.objectContaining({ bytes: VIEWER_CHUNK_BYTES }))
    stream.handle('viewer_close', {})
    expect(send.mock.calls.some(([type]) => type === 'viewer_close')).toBe(false)
    const second = new ViewerWire('b', () => true)
    second.handle('viewer_close', { error: 'remote stopped' })
  })
})
