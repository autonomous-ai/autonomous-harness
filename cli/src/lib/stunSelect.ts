/**
 * Picks ONE reachable STUN server out of the list the backend hands us, by racing them all at once
 * with a raw RFC 5389 Binding Request and putting the first one that answers at the front.
 *
 * This exists because werift does not do STUN failover and never did. `parseIceServers()`
 * (werift/lib/webrtc/src/utils.js:96) folds the whole `iceServers` array into a SINGLE `stunServer`
 * — `if (!options.stunServer && parsed.kind === "stun") options.stunServer = parsed.address` — so the
 * first `stun:` url wins and every url behind it is dropped without a word. Measured on werift 0.24.4
 * against a blackholed first entry (198.51.100.1) with two live servers behind it: ZERO srflx
 * candidates, and gathering stalled 5.0s on werift's gather timeout instead of finishing in ~60ms.
 * Both halves hurt. We do not trickle ICE (nothing subscribes to onIceCandidate; the candidates ride
 * in the SDP because `setLocalDescription` awaits `gatherCandidates()`), so that 5s is paid on the
 * initiator AND again on the responder, inside one 10s TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS budget. A
 * single dead STUN server therefore does not merely lose srflx — it blows the whole negotiation.
 *
 * The peers do NOT have to agree on a server: a srflx candidate answers "what is my own public
 * address", so each side may ask whoever it likes. That is why nothing here touches the wire format —
 * `p2p_offer` keeps carrying the raw policy list and the responder races it independently.
 *
 * Two properties are load-bearing and must survive any edit:
 *   - `select()` NEVER rejects. It runs inside a long-lived daemon; an unhandled rejection here kills
 *     the process. Every failure path degrades to "return the list exactly as given", which is
 *     byte-for-byte today's behaviour — the cheapest possible proof this can never be worse.
 *   - A list of 0 or 1 urls is returned untouched with no probe at all. Production currently ships a
 *     single STUN url, so this module is provably a no-op there until the backend ships a longer one.
 */
import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'

const STUN_MAGIC_COOKIE = 0x2112a442
const STUN_BINDING_REQUEST = 0x0001
const STUN_BINDING_SUCCESS = 0x0101
const STUN_ATTR_MAPPED_ADDRESS = 0x0001
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
const STUN_HEADER_BYTES = 20

/** Measured RTT to cloudflare/google STUN is ~117ms, so this is ~3.4x headroom. It is only ever paid
 *  in full when EVERY server is dead — i.e. exactly when p2p was doomed anyway. */
const PROBE_TIMEOUT_MS = 400
/** One retransmit with the same transaction id absorbs a single lost datagram inside that budget. */
const PROBE_RETRANSMIT_MS = 150
const POSITIVE_TTL_MS = 5 * 60_000
/** Short, so a laptop coming off a captive portal heals on its own without any invalidation hook. */
const NEGATIVE_TTL_MS = 30_000

/** Resolves to the winner's IPv4 address, or null if this server did not answer. Never rejects. */
export type StunProbe = (url: string, timeoutMs: number, signal: AbortSignal) => Promise<string | null>

export interface StunSelection {
  /** The input list, winner first. Identical to the input (same order) when nothing answered. */
  urls: string[]
  /**
   * Did ANY configured STUN server answer over UDP?
   *
   * Tri-state on purpose. `null` means "not probed" — a list of 0 or 1 urls short-circuits without
   * sending a packet, so we know nothing either way. Collapsing that into `false` would tell
   * pickTurnUrl() that UDP is blocked on every single-STUN-url deployment and push all of them onto
   * TURN over TLS:443 for no reason.
   */
  udpReachable: boolean | null
}

export type StunSelector = (urls: string[]) => Promise<StunSelection>

export interface StunSelectorOptions {
  probe?: StunProbe
  now?: () => number
  ttlMs?: number
  negativeTtlMs?: number
  probeTimeoutMs?: number
}

interface StunTarget {
  scheme: 'stun' | 'stuns'
  host: string
  port: number
}

interface RaceResult {
  ordered: string[]
  /** false = every server failed, so `ordered` IS the input list and the result is cached briefly. */
  ok: boolean
}

interface CacheEntry {
  ordered: string[]
  ok: boolean
  at: number
}

/** Mirrors `parseIceServerUrl`/`parseAddress` in werift/lib/webrtc/src/utils.js:133-210 on purpose:
 *  disagreeing with werift about which host:port a url means would make the whole race meaningless. */
export function parseStunUrl(url: string): StunTarget | null {
  const matched = /^(stun|stuns):(.+)$/i.exec(url.trim())
  if (!matched) return null
  const scheme = matched[1]!.toLowerCase() as 'stun' | 'stuns'
  const fallbackPort = scheme === 'stuns' ? 5349 : 3478
  const [rest] = matched[2]!.split('?', 1)
  const authority = rest!.startsWith('//') ? rest!.slice(2) : rest!
  if (!authority) return null
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']')
    if (closing === -1) return null
    return { scheme, host: authority.slice(1, closing), port: parsePort(authority.slice(closing + 1), fallbackPort) }
  }
  const firstColon = authority.indexOf(':')
  const lastColon = authority.lastIndexOf(':')
  if (firstColon !== -1 && firstColon === lastColon) {
    return { scheme, host: authority.slice(0, firstColon), port: parsePort(authority.slice(firstColon + 1), fallbackPort) }
  }
  return { scheme, host: authority, port: fallbackPort }
}

function parsePort(value: string, fallbackPort: number): number {
  const port = Number.parseInt(value.startsWith(':') ? value.slice(1) : value, 10)
  return Number.isFinite(port) ? port : fallbackPort
}

/** Exported so the wire format can be unit-tested without a socket. */
export function buildBindingRequest(): { packet: Buffer; tid: Buffer } {
  const packet = Buffer.alloc(STUN_HEADER_BYTES)
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  packet.writeUInt16BE(0, 2)
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  // Crypto-random, not counter-based: an off-path spoofer must not be able to guess the id and win
  // the race with a forged success response pointing us at a server that never answered.
  const tid = randomBytes(12)
  tid.copy(packet, 8)
  return { packet, tid }
}

/**
 * True only for a success response that carries a well-formed mapped address. That is deliberately
 * the same bar werift's own gathering applies: `serverReflexiveCandidate`
 * (werift/lib/ice/src/iceBase.js:271-288) reads XOR-MAPPED-ADDRESS unconditionally and throws without
 * it, so "answered" alone would be a weaker predicate than "werift will succeed here".
 *
 * The mapped value itself is discarded — our source port differs from werift's by construction; all
 * we are establishing is reachability. Malformed input returns false and never throws.
 */
export function parseBindingResponse(buf: Buffer, tid: Buffer): boolean {
  if (buf.length < STUN_HEADER_BYTES) return false
  if (buf.readUInt16BE(0) !== STUN_BINDING_SUCCESS) return false // also rejects 0x0111 error responses
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return false
  if (!buf.subarray(8, STUN_HEADER_BYTES).equals(tid)) return false
  if (buf.readUInt16BE(2) !== buf.length - STUN_HEADER_BYTES) return false
  let off = STUN_HEADER_BYTES
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off)
    const len = buf.readUInt16BE(off + 2)
    if (off + 4 + len > buf.length) return false
    if (type === STUN_ATTR_XOR_MAPPED_ADDRESS || type === STUN_ATTR_MAPPED_ADDRESS) {
      const family = buf.readUInt8(off + 5)
      if ((family === 0x01 && len === 8) || (family === 0x02 && len === 20)) return true
    }
    off += 4 + len + ((4 - (len % 4)) % 4)
  }
  return false
}

/** werift resolves STUN hosts as IPv4 (ice/src/stun/transaction.js:18-24) and only ever gathers srflx
 *  from IPv4 host candidates (ice/src/ice.js:861), so probing anything else would measure a path it
 *  cannot use. Note stun.cloudflare.com is dual-stack, so an unqualified lookup can hand back AAAA. */
function resolveIpv4(host: string, done: (address: string | null) => void): void {
  const literal = isIP(host)
  if (literal === 4) { done(host); return }
  if (literal === 6) { done(null); return }
  lookup(host, { family: 4 }, (err, address) => done(err ? null : address))
}

const probeStun: StunProbe = (url, timeoutMs, signal) => {
  const target = parseStunUrl(url)
  // stuns: is STUN-over-TLS/TCP. werift asks over UDP, so such an entry is unusable there anyway and
  // a UDP probe could not measure it honestly either.
  if (!target || target.scheme !== 'stun') return Promise.resolve(null)
  return new Promise<string | null>((resolve) => {
    if (signal.aborted) { resolve(null); return }
    let socket: dgram.Socket | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let retransmit: ReturnType<typeof setTimeout> | null = null
    let done = false
    const { packet, tid } = buildBindingRequest()

    const finish = (address: string | null): void => {
      if (done) return
      done = true
      if (deadline) clearTimeout(deadline)
      if (retransmit) clearTimeout(retransmit)
      signal.removeEventListener('abort', onAbort)
      try { socket?.close() } catch { /* never opened, or already closed */ }
      resolve(address)
    }
    function onAbort(): void { finish(null) }
    signal.addEventListener('abort', onAbort, { once: true })

    deadline = setTimeout(() => finish(null), timeoutMs)
    deadline.unref?.()

    resolveIpv4(target.host, (address) => {
      if (done) return
      if (!address) { finish(null); return }
      try {
        socket = dgram.createSocket('udp4')
      } catch { finish(null); return }
      // A probe must never be the reason the daemon stays alive.
      socket.unref()
      // Mandatory: a closed port answers with ICMP unreachable, which dgram raises as an 'error'
      // EVENT. Unhandled, that throws out of the event loop and takes the process with it.
      socket.on('error', () => finish(null))
      socket.on('message', (msg) => { if (parseBindingResponse(msg, tid)) finish(address) })
      socket.send(packet, target.port, address, (err) => { if (err) finish(null) })
      retransmit = setTimeout(() => {
        // Errors are ignored here: the first send already succeeded, so a failing retransmit should
        // let the deadline decide rather than cut short a response still in flight.
        if (!done) socket?.send(packet, target.port, address, () => { /* deadline decides */ })
      }, PROBE_RETRANSMIT_MS)
      retransmit.unref?.()
    })
  })
}

/** Only the winner, only for `stun:`, only when it was a name: we measured THAT address, and a host
 *  with several A records could resolve elsewhere inside werift's own lookup, quietly invalidating the
 *  race we just ran. Bounded by the positive TTL; a stale pin costs one slow gather, i.e. today. */
function pinWinner(url: string, address: string): string {
  const target = parseStunUrl(url)
  if (!target || target.scheme !== 'stun' || isIP(target.host)) return url
  return `stun:${address}:${target.port}`
}

export function createStunSelector(opts: StunSelectorOptions = {}): StunSelector {
  const probe = opts.probe ?? probeStun
  const now = opts.now ?? ((): number => Date.now())
  const ttlMs = opts.ttlMs ?? POSITIVE_TTL_MS
  const negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const cache = new Map<string, CacheEntry>()
  const pending = new Map<string, Promise<StunSelection>>()

  const race = (urls: string[]): Promise<RaceResult> => new Promise<RaceResult>((resolve) => {
    const controller = new AbortController()
    let settled = false
    let outstanding = urls.length
    const finish = (ordered: string[], ok: boolean): void => {
      if (settled) return
      settled = true
      controller.abort() // closes every losing socket and clears its timers at once
      resolve({ ordered, ok })
    }
    const lost = (): void => { if (--outstanding <= 0) finish(urls, false) }
    urls.forEach((url, index) => {
      let result: Promise<string | null>
      try {
        result = probe(url, probeTimeoutMs, controller.signal)
      } catch {
        lost() // a probe that throws synchronously is just a failed probe
        return
      }
      result.then(
        (address) => {
          if (!address) { lost(); return }
          finish([pinWinner(url, address), ...urls.filter((_, i) => i !== index)], true)
        },
        () => lost(),
      )
    })
  })

  return async (urls) => {
    // Zero or one url: nothing to choose between, so do not spend a single packet deciding. Reachability
    // stays UNKNOWN here rather than false — we never asked.
    if (urls.length <= 1) return { urls, udpReachable: null }
    const key = urls.map((url) => url.trim().toLowerCase()).join(' ')
    const hit = cache.get(key)
    if (hit && now() - hit.at < (hit.ok ? ttlMs : negativeTtlMs)) {
      return { urls: hit.ordered, udpReachable: hit.ok }
    }
    const inflight = pending.get(key)
    if (inflight) return inflight
    const run = race(urls)
      .then(({ ordered, ok }) => {
        cache.set(key, { ordered, ok, at: now() })
        return { urls: ordered, udpReachable: ok }
      })
      .catch(() => ({ urls, udpReachable: null })) // the contract is that this function never rejects
      .finally(() => { pending.delete(key) })
    pending.set(key, run)
    return run
  }
}

/**
 * Which of Cloudflare's five TURN urls to hand werift — it reads only the FIRST `turn:` entry
 * (webrtc/src/utils.js parseIceServers) and never falls over to the rest, exactly like the STUN bug
 * this module already works around. Its own udp→tcp retry stays on port 3478, which a network that
 * drops UDP usually blocks too, so the 443 choice has to be made here.
 *
 * The STUN race already answered the only question that matters — does UDP leave this host — so this
 * costs no extra packets. Both misreads are safe: guessing "blocked" merely picks the slower TLS path
 * (measured 404ms vs 115ms to allocate), and guessing "open" falls back to werift's own tcp retry.
 */
export function pickTurnUrl(turnUrls: string[], udpReachable: boolean | null): string | null {
  const usable = turnUrls.filter((url) => /^turns?:/i.test(url.trim()))
  if (usable.length === 0) return null
  if (udpReachable === false) {
    const tls = usable.find((url) => /^turns:/i.test(url.trim()) && parseStunUrlPort(url) === 443)
      ?? usable.find((url) => /^turns:/i.test(url.trim()))
    if (tls) return tls
  }
  if (udpReachable === true) {
    const udp = usable.find((url) => /[?&]transport=udp/i.test(url))
    if (udp) return udp
  }
  // Unknown, or the list carries no url of the preferred kind: behave exactly like werift does today.
  return usable[0] ?? null
}

function parseStunUrlPort(url: string): number | null {
  const match = /^turns?:(?:\/\/)?([^?]+)/i.exec(url.trim())
  if (!match) return null
  const authority = match[1]!
  const lastColon = authority.lastIndexOf(':')
  if (lastColon === -1 || authority.indexOf(':') !== lastColon) return null
  const port = Number.parseInt(authority.slice(lastColon + 1), 10)
  return Number.isFinite(port) ? port : null
}

/** Process-wide selector: one shared cache, so a warm-up on one relay pays for every later peer. */
export const selectStunUrls: StunSelector = createStunSelector()

/** Fire-and-forget: start the race the moment the url list is known, so its cost hides behind the
 *  round trip that follows. Callers join the same in-flight promise; nothing waits on this. */
export function warmStunUrls(urls: string[]): void {
  void selectStunUrls(urls).catch(() => { /* selectStunUrls never rejects; this is belt and braces */ })
}
