import dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import {
  buildBindingRequest,
  createStunSelector,
  parseBindingResponse,
  parseStunUrl,
  type StunProbe,
} from './stunSelect.js'

const MAGIC = 0x2112a442

/** Builds a success response for `tid`, optionally with a bogus attribute set. */
function successResponse(tid: Buffer, opts: {
  type?: number
  attrType?: number
  family?: number
  attrLen?: number
  /** Length written INTO the attribute header, independent of how many bytes actually follow. */
  declaredAttrLen?: number
  declaredLength?: number
  omitAttribute?: boolean
} = {}): Buffer {
  const attrLen = opts.attrLen ?? (opts.family === 0x02 ? 20 : 8)
  const body = opts.omitAttribute ? Buffer.alloc(0) : Buffer.alloc(4 + attrLen)
  if (!opts.omitAttribute) {
    body.writeUInt16BE(opts.attrType ?? 0x0020, 0)
    body.writeUInt16BE(opts.declaredAttrLen ?? attrLen, 2)
    body.writeUInt8(0, 4)
    body.writeUInt8(opts.family ?? 0x01, 5)
    body.writeUInt16BE(0x1234 ^ (MAGIC >>> 16), 6)
    body.writeUInt32BE(0x0a000001 ^ MAGIC, 8)
  }
  const buf = Buffer.alloc(20 + body.length)
  buf.writeUInt16BE(opts.type ?? 0x0101, 0)
  buf.writeUInt16BE(opts.declaredLength ?? body.length, 2)
  buf.writeUInt32BE(MAGIC, 4)
  tid.copy(buf, 8)
  body.copy(buf, 20)
  return buf
}

describe('STUN url parsing', () => {
  it('matches werift: default ports, explicit ports, brackets, and query strings', () => {
    expect(parseStunUrl('stun:stun.example.com')).toEqual({ scheme: 'stun', host: 'stun.example.com', port: 3478 })
    expect(parseStunUrl('stun:stun.example.com:19302')).toEqual({ scheme: 'stun', host: 'stun.example.com', port: 19302 })
    expect(parseStunUrl('stuns:stun.example.com')).toEqual({ scheme: 'stuns', host: 'stun.example.com', port: 5349 })
    expect(parseStunUrl('stun://stun.example.com:1234')).toEqual({ scheme: 'stun', host: 'stun.example.com', port: 1234 })
    expect(parseStunUrl('stun:stun.example.com:3478?transport=udp')?.port).toBe(3478)
    expect(parseStunUrl('stun:[::1]:3478')).toEqual({ scheme: 'stun', host: '::1', port: 3478 })
    expect(parseStunUrl('  STUN:Stun.Example.com  ')?.host).toBe('Stun.Example.com')
  })

  it('rejects junk without throwing', () => {
    for (const bad of ['', 'stun:', 'turn:example.com', 'https://example.com', 'stun:[::1', 'nonsense']) {
      expect(parseStunUrl(bad)).toBeNull()
    }
  })
})

describe('STUN binding request/response codec', () => {
  it('builds a well-formed 20-byte request with a fresh transaction id each time', () => {
    const a = buildBindingRequest()
    const b = buildBindingRequest()
    expect(a.packet.length).toBe(20)
    expect(a.packet.readUInt16BE(0)).toBe(0x0001)
    expect(a.packet.readUInt16BE(2)).toBe(0)
    expect(a.packet.readUInt32BE(4)).toBe(MAGIC)
    expect(a.tid.length).toBe(12)
    expect(a.packet.subarray(8, 20)).toEqual(a.tid)
    expect(a.tid.equals(b.tid)).toBe(false)
  })

  it('accepts a success response carrying a mapped address', () => {
    const { tid } = buildBindingRequest()
    expect(parseBindingResponse(successResponse(tid), tid)).toBe(true)
    expect(parseBindingResponse(successResponse(tid, { attrType: 0x0001 }), tid)).toBe(true)
    expect(parseBindingResponse(successResponse(tid, { family: 0x02 }), tid)).toBe(true)
  })

  it('rejects every malformed or foreign response, and never throws', () => {
    const { tid } = buildBindingRequest()
    const other = buildBindingRequest().tid
    const cases: Array<[string, Buffer]> = [
      ['transaction id from another probe', successResponse(other)],
      ['error class 0x0111', successResponse(tid, { type: 0x0111 })],
      ['truncated header', successResponse(tid).subarray(0, 12)],
      ['declared length disagrees with buffer', successResponse(tid, { declaredLength: 99 })],
      ['attribute claims more bytes than the buffer holds', successResponse(tid, { attrLen: 8, declaredAttrLen: 20 })],
      ['success with no mapped address', successResponse(tid, { omitAttribute: true })],
      ['mapped address with a length that does not match its family', successResponse(tid, { attrLen: 12 })],
      ['empty buffer', Buffer.alloc(0)],
      ['random bytes', Buffer.from([0xff, 0x00, 0x13, 0x37])],
    ]
    for (const [name, buf] of cases) {
      expect(parseBindingResponse(buf, tid), name).toBe(false)
    }
  })

  it('rejects a response whose magic cookie is wrong', () => {
    const { tid } = buildBindingRequest()
    const buf = successResponse(tid)
    buf.writeUInt32BE(0xdeadbeef, 4)
    expect(parseBindingResponse(buf, tid)).toBe(false)
  })
})

describe('STUN selection race', () => {
  const URLS = ['stun:a.example:3478', 'stun:b.example:3478', 'stun:c.example:3478']

  /** Answers after `delays[url]` ms; a url absent from the map never answers at all. */
  function fakeProbe(delays: Record<string, number>, address = '10.0.0.1'): StunProbe & { calls: string[] } {
    const calls: string[] = []
    const probe = ((url, _timeoutMs, signal) => {
      calls.push(url)
      const delay = delays[url]
      if (delay === undefined) return new Promise<string | null>(() => { /* never settles */ })
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(address), delay)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null) }, { once: true })
      })
    }) as StunProbe & { calls: string[] }
    probe.calls = calls
    return probe
  }

  it('puts the fastest responder first and keeps the losers in their original order', async () => {
    const probe = fakeProbe({ [URLS[2]!]: 10, [URLS[0]!]: 30 })
    const select = createStunSelector({ probe })
    expect(await select(URLS)).toEqual(['stun:10.0.0.1:3478', URLS[0], URLS[1]])
  })

  it('returns as soon as one answers, aborting the probes still outstanding', async () => {
    let aborted = false
    const probe: StunProbe = (url, _timeoutMs, signal) => {
      if (url === URLS[0]) return Promise.resolve('10.0.0.1')
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Promise(() => { /* would hang forever without the abort */ })
    }
    const select = createStunSelector({ probe })
    expect((await select(URLS))[0]).toBe('stun:10.0.0.1:3478')
    expect(aborted).toBe(true)
  })

  it('is never worse than today: when every server fails it returns the list untouched', async () => {
    const probe = vi.fn<StunProbe>(async () => null)
    const select = createStunSelector({ probe })
    expect(await select(URLS)).toEqual(URLS)
  })

  it('does not probe at all for a list of zero or one url', async () => {
    const probe = vi.fn<StunProbe>(async () => '10.0.0.1')
    const select = createStunSelector({ probe })
    expect(await select([])).toEqual([])
    expect(await select(['stun:only.example:3478'])).toEqual(['stun:only.example:3478'])
    expect(probe).not.toHaveBeenCalled()
  })

  it('never rejects, whether a probe throws synchronously or rejects', async () => {
    const thrower: StunProbe = (url) => {
      if (url === URLS[0]) throw new Error('sync boom')
      if (url === URLS[1]) return Promise.reject(new Error('async boom'))
      return Promise.resolve(null)
    }
    const select = createStunSelector({ probe: thrower })
    await expect(select(URLS)).resolves.toEqual(URLS)
  })

  it('leaves a winner that is already an IP literal alone, and never pins the losers', async () => {
    const urls = ['stun:198.51.100.7:3478', 'stun:b.example:3478']
    const probe: StunProbe = async (url) => (url === urls[0] ? '198.51.100.7' : null)
    const select = createStunSelector({ probe })
    expect(await select(urls)).toEqual(urls)
  })

  it('joins an in-flight race instead of starting a second one', async () => {
    const probe = fakeProbe({ [URLS[1]!]: 5 })
    const select = createStunSelector({ probe })
    const [first, second] = await Promise.all([select(URLS), select(URLS)])
    expect(first).toEqual(second)
    expect(probe.calls).toEqual(URLS) // one call per url, total
  })

  it('serves a hit from cache until the positive TTL expires', async () => {
    const probe = fakeProbe({ [URLS[0]!]: 1 })
    let clock = 1_000
    const select = createStunSelector({ probe, now: () => clock, ttlMs: 5_000, negativeTtlMs: 100 })
    await select(URLS)
    expect(probe.calls.length).toBe(3)
    clock += 4_999
    await select(URLS)
    expect(probe.calls.length).toBe(3)
    clock += 2
    await select(URLS)
    expect(probe.calls.length).toBe(6)
  })

  it('expires a total failure on the shorter negative TTL', async () => {
    const probe = vi.fn<StunProbe>(async () => null)
    let clock = 1_000
    const select = createStunSelector({ probe, now: () => clock, ttlMs: 5_000, negativeTtlMs: 100 })
    await select(URLS)
    expect(probe).toHaveBeenCalledTimes(3)
    clock += 99
    await select(URLS)
    expect(probe).toHaveBeenCalledTimes(3)
    clock += 2 // past the negative TTL but nowhere near the positive one
    await select(URLS)
    expect(probe).toHaveBeenCalledTimes(6)
  })

  it('keys the cache on the whole list, so a different list is decided on its own merits', async () => {
    const probe = fakeProbe({ [URLS[0]!]: 1, 'stun:d.example:3478': 1 })
    const select = createStunSelector({ probe })
    await select(URLS)
    await select(['stun:d.example:3478', 'stun:e.example:3478'])
    expect(probe.calls).toContain('stun:d.example:3478')
  })
})

describe('STUN probe over a real socket', () => {
  it('skips a closed port and picks the server that actually answers', async () => {
    const server = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve))
    server.on('message', (msg, rinfo) => {
      const tid = msg.subarray(8, 20)
      server.send(successResponse(tid), rinfo.port, rinfo.address)
    })
    const livePort = server.address().port

    // Take a port and release it, so nothing is listening there: on loopback that surfaces as an
    // ICMP-unreachable -> dgram 'error' EVENT, which is the path that crashes the daemon if unhandled.
    const scratch = dgram.createSocket('udp4')
    await new Promise<void>((resolve) => scratch.bind(0, '127.0.0.1', resolve))
    const deadPort = scratch.address().port
    await new Promise<void>((resolve) => scratch.close(resolve))

    try {
      const select = createStunSelector({ probeTimeoutMs: 1_000 })
      const ordered = await select([`stun:127.0.0.1:${deadPort}`, `stun:127.0.0.1:${livePort}`])
      expect(ordered[0]).toBe(`stun:127.0.0.1:${livePort}`)
    } finally {
      await new Promise<void>((resolve) => server.close(resolve))
    }
  }, 10_000)

  it('resolves to the untouched list when nothing answers, without leaking the process', async () => {
    const select = createStunSelector({ probeTimeoutMs: 300 })
    // TEST-NET-3, guaranteed unroutable, so both probes hit the deadline rather than any error path.
    const urls = ['stun:203.0.113.1:3478', 'stun:203.0.113.2:3478']
    expect(await select(urls)).toEqual(urls)
  }, 10_000)
})
