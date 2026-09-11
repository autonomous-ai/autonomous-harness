/**
 * SSRF guard for user-supplied provider endpoints.
 *
 * A `provider` machine is reached at a URL the OWNER typed. That is a deliberate product decision and
 * it puts an attacker-controlled string in front of an outbound request from our infrastructure — the
 * classic route to a cloud metadata endpoint or an internal service. This module is the mitigation,
 * and every request to a provider MUST go through `providerFetch`.
 *
 * The rule people usually miss is #3 below. Validating the URL when the machine is created is not
 * enough: DNS can return a public address at save time and a private one at request time (rebinding).
 * So validation happens **inside the socket's `lookup` hook**, on the address actually being dialled —
 * there is no window between the check and the connection.
 *
 * Deliberately built on `node:https` rather than `fetch`: only the raw request API exposes `lookup`,
 * and pinning the resolved address is the whole point. No new dependency either.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { env } from '../config/env.js'

export class ProviderUrlError extends Error {
  constructor(message: string, readonly code: ProviderUrlErrorCode) {
    super(message)
    this.name = 'ProviderUrlError'
  }
}

export type ProviderUrlErrorCode =
  | 'INVALID_URL'
  | 'INSECURE_SCHEME'
  | 'BLOCKED_ADDRESS'
  | 'DNS_FAILED'
  | 'REDIRECT_REFUSED'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'

/** Messages are shown to the owner in the create dialog, so they say what to do about it. */
const REASONS: Record<ProviderUrlErrorCode, string> = {
  INVALID_URL: 'That is not a valid URL',
  INSECURE_SCHEME: 'The provider URL must use https://',
  BLOCKED_ADDRESS: 'That URL points at a private or internal network address',
  DNS_FAILED: 'That hostname could not be resolved',
  REDIRECT_REFUSED: 'The provider redirected the request, which is not allowed',
  TIMEOUT: 'The provider did not respond in time',
  RESPONSE_TOO_LARGE: 'The provider sent more data than allowed',
}

export const reasonFor = (code: ProviderUrlErrorCode): string => REASONS[code]

// ── Address policy ───────────────────────────────────────────────────────────────────────────────

/**
 * True for an address we refuse to dial.
 *
 * `169.254.0.0/16` is the important one and the reason this list is not just "private ranges":
 * `169.254.169.254` is the cloud instance-metadata endpoint on AWS, GCP and Azure, and reaching it
 * from our infrastructure hands over instance credentials.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isBlockedIPv4(ip)
  if (family === 6) return isBlockedIPv6(ip)
  return true // not an address we can reason about → refuse
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true                        // 0.0.0.0/8 "this network"
  if (a === 10) return true                       // private
  if (a === 127) return true                      // loopback
  if (a === 169 && b === 254) return true         // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true         // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true           // IETF protocol assignments / 192.0.2.0 TEST-NET
  if (a >= 224) return true                       // multicast + reserved + broadcast
  return false
}

function isBlockedIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (ip === '::' || ip === '::1') return true    // unspecified, loopback
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms must be judged as IPv4, or every rule
  // above is trivially bypassed.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) return isBlockedIPv4(mapped[1]!)
  if (/^f[cd]/.test(ip)) return true              // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true           // fe80::/10 link-local
  if (/^ff/.test(ip)) return true                 // multicast
  return false
}

// ── URL policy ───────────────────────────────────────────────────────────────────────────────────

export interface CheckedTarget {
  /** Normalised absolute URL. */
  url: string
  hostname: string
  port: number
  /** The address it resolved to at check time — informational; the connection re-checks. */
  ip: string
}

function allowInsecure(): boolean {
  return env.PROVIDER_ALLOW_INSECURE_URLS === true
}

/**
 * The address policy, with the dev escape hatch applied.
 *
 * `isBlockedAddress` is the pure policy and stays that way so it can be asserted directly. This is
 * the enforcement point, and it has to honour the dev flag for the same reason the flag exists: a
 * local `example-provider` (autonomous-ai/autonomous-harness) lives at `http://127.0.0.1:4502`, which
 * is refused on BOTH counts —
 * plain http AND loopback. Lifting only the scheme left the flag unable to do the one job it was
 * added for, which is exactly what happened until someone tried to test locally.
 */
function refuseAddress(ip: string): boolean {
  return isBlockedAddress(ip) && !allowInsecure()
}

/**
 * Parse and vet a user-supplied URL. Throws `ProviderUrlError` with a code the UI can map.
 *
 * Passing this does NOT make the URL permanently safe — `providerFetch` re-checks at connect time.
 * This exists to reject obvious mistakes at the moment the owner types them, with a useful message.
 */
export async function checkProviderUrl(raw: string): Promise<CheckedTarget> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ProviderUrlError(REASONS.INVALID_URL, 'INVALID_URL')
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecure())) {
    throw new ProviderUrlError(
      url.protocol === 'http:' ? REASONS.INSECURE_SCHEME : REASONS.INVALID_URL,
      url.protocol === 'http:' ? 'INSECURE_SCHEME' : 'INVALID_URL',
    )
  }
  if (url.username || url.password) throw new ProviderUrlError(REASONS.INVALID_URL, 'INVALID_URL')

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))

  // A literal address skips DNS but not the policy.
  if (isIP(hostname)) {
    if (refuseAddress(hostname)) throw new ProviderUrlError(REASONS.BLOCKED_ADDRESS, 'BLOCKED_ADDRESS')
    return { url: url.toString(), hostname, port, ip: hostname }
  }

  const resolved = await resolveAll(hostname)
  // EVERY address must pass: a hostname with one public and one private A record is not safe just
  // because the resolver happened to return the public one first.
  for (const addr of resolved) {
    if (refuseAddress(addr)) throw new ProviderUrlError(REASONS.BLOCKED_ADDRESS, 'BLOCKED_ADDRESS')
  }
  return { url: url.toString(), hostname, port, ip: resolved[0]! }
}

async function resolveAll(hostname: string): Promise<string[]> {
  try {
    const entries = await dnsLookup(hostname, { all: true, verbatim: true })
    if (!entries.length) throw new Error('no addresses')
    return entries.map((e) => e.address)
  } catch {
    throw new ProviderUrlError(REASONS.DNS_FAILED, 'DNS_FAILED')
  }
}

// ── The guarded request ──────────────────────────────────────────────────────────────────────────

export interface ProviderRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Whole-request budget. Streaming callers pass a large value. */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ProviderResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** Raw stream — SSE callers read it incrementally. */
  stream: IncomingMessage
}

export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * Make a request to a provider with the address policy enforced **at connect time**.
 *
 * The `lookup` hook is the load-bearing part: it runs when the socket is about to connect, resolves
 * the name itself, and refuses to hand back a blocked address. There is no gap between validating an
 * address and connecting to it, which is what defeats DNS rebinding.
 */
export function providerFetch(target: string, init: ProviderRequestInit = {}): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      reject(new ProviderUrlError(REASONS.INVALID_URL, 'INVALID_URL'))
      return
    }
    const secure = url.protocol === 'https:'
    if (!secure && !(url.protocol === 'http:' && allowInsecure())) {
      reject(new ProviderUrlError(REASONS.INSECURE_SCHEME, 'INSECURE_SCHEME'))
      return
    }

    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const req = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (secure ? '443' : '80'),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        // THE guard. Called by the socket layer with the host it is about to connect to.
        lookup: guardedLookup,
        timeout: timeoutMs,
      },
      (res) => {
        // No redirects. Following one would re-open every check on a URL the owner never typed.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy()
          reject(new ProviderUrlError(REASONS.REDIRECT_REFUSED, 'REDIRECT_REFUSED'))
          return
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res })
      },
    )

    req.on('timeout', () => {
      req.destroy(new ProviderUrlError(REASONS.TIMEOUT, 'TIMEOUT'))
    })
    req.on('error', (err) => reject(err))
    init.signal?.addEventListener('abort', () => req.destroy(), { once: true })
    if (init.body) req.write(init.body)
    req.end()
  })
}

/** Matches Node's `net.LookupFunction` callback: `address` is required, so errors pass an empty one. */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void

/**
 * `dns.lookup`-shaped hook that refuses blocked addresses.
 *
 * Node calls this with the hostname at connect time; whatever it returns is what the socket dials.
 * Refusing here means a rebinding attack has nothing to rebind to.
 */
function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  if (isIP(hostname)) {
    if (refuseAddress(hostname)) {
      callback(new ProviderUrlError(REASONS.BLOCKED_ADDRESS, 'BLOCKED_ADDRESS') as NodeJS.ErrnoException, '', 0)
      return
    }
    callback(null, hostname, isIP(hostname))
    return
  }
  dnsLookup(hostname, { all: true, verbatim: true })
    .then((entries) => {
      const usable = entries.find((e) => !refuseAddress(e.address))
      const blocked = entries.some((e) => refuseAddress(e.address))
      // Any blocked address in the answer set disqualifies the host outright — picking the "good"
      // one would let an attacker keep a public A record purely to pass the check.
      if (blocked || !usable) {
        callback(new ProviderUrlError(REASONS.BLOCKED_ADDRESS, 'BLOCKED_ADDRESS') as NodeJS.ErrnoException, '', 0)
        return
      }
      callback(null, usable.address, usable.family)
    })
    .catch(() => callback(new ProviderUrlError(REASONS.DNS_FAILED, 'DNS_FAILED') as NodeJS.ErrnoException, '', 0))
}

/** Read a guarded response as text, refusing anything over the cap. */
export async function readBodyCapped(res: ProviderResponse, max = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res.stream) {
    size += (chunk as Buffer).length
    if (size > max) {
      res.stream.destroy()
      throw new ProviderUrlError(REASONS.RESPONSE_TOO_LARGE, 'RESPONSE_TOO_LARGE')
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
