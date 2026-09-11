import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envMock = {
  TERMINAL_P2P_TURN_KEY_ID: 'key-1',
  TERMINAL_P2P_TURN_API_TOKEN: 'token-1',
  TERMINAL_P2P_TURN_TTL_SECONDS: 7200,
  TERMINAL_P2P_TURN_TIMEOUT_MS: 5000,
}

vi.mock('../config/env.js', () => ({ env: envMock }))

const { resetTurnCredentialsForTest, turnCredentials, startTurnCredentialRefresh } =
  await import('./turnCredentials.js')

const TTL_MS = envMock.TERMINAL_P2P_TURN_TTL_SECONDS * 1000

function iceResponse(username = 'u1', credential = 'c1'): Response {
  return new Response(JSON.stringify({
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username,
        credential,
      },
    ],
  }), { status: 201, headers: { 'Content-Type': 'application/json' } })
}

/** Lets the queued microtasks behind the mocked fetch run before the next synchronous read. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let clock = 1_000_000

beforeEach(() => {
  clock = 1_000_000
  envMock.TERMINAL_P2P_TURN_KEY_ID = 'key-1'
  envMock.TERMINAL_P2P_TURN_API_TOKEN = 'token-1'
  resetTurnCredentialsForTest()
})

afterEach(() => {
  resetTurnCredentialsForTest()
  vi.clearAllMocks()
})

const now = (): number => clock

describe('Cloudflare TURN credentials', () => {
  it('mints once and then serves the snapshot synchronously', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
    expect(JSON.parse(String(init?.body))).toEqual({ ttl: 7200 })

    const creds = turnCredentials({ now, fetchImpl })
    expect(creds).toEqual({
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'u1',
      credential: 'c1',
    })
    // Repeated reads inside the ttl never touch the network — this is the whole point of the snapshot.
    turnCredentials({ now, fetchImpl })
    turnCredentials({ now, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps the stun-only entry out of the credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()
    expect(turnCredentials({ now, fetchImpl })!.urls.every((u) => u.startsWith('turn'))).toBe(true)
  })

  it('tops up in the background once past three quarters of the ttl, still serving the old one', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse('u1', 'c1'))
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()

    clock += TTL_MS * 0.5
    expect(turnCredentials({ now, fetchImpl })!.credential).toBe('c1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fetchImpl.mockImplementation(async () => iceResponse('u2', 'c2'))
    clock += TTL_MS * 0.3 // now 80% through, inside the refresh window
    // The read still answers with the live credential rather than blocking on the refresh.
    expect(turnCredentials({ now, fetchImpl })!.credential).toBe('c1')
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(turnCredentials({ now, fetchImpl })!.credential).toBe('c2')
  })

  it('keeps serving a still-valid credential when Cloudflare starts failing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()

    fetchImpl.mockImplementation(async () => new Response('nope', { status: 500 }))
    clock += TTL_MS * 0.8
    expect(turnCredentials({ now, fetchImpl })!.credential).toBe('c1')
    await settle()
    expect(turnCredentials({ now, fetchImpl })!.credential).toBe('c1')
  })

  it('degrades to null once the credential actually expires, and never throws', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()

    fetchImpl.mockImplementation(async () => { throw new Error('network down') })
    clock += TTL_MS + 1
    expect(turnCredentials({ now, fetchImpl })).toBeNull()
    await settle()
    expect(turnCredentials({ now, fetchImpl })).toBeNull()
  })

  it('backs off after a failure instead of refetching on every read', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('bad', { status: 401 }))
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i++) {
      expect(turnCredentials({ now, fetchImpl })).toBeNull()
      await settle()
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 60_001 // past the retry backoff
    turnCredentials({ now, fetchImpl })
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['not json', new Response('<html>', { status: 201 })],
    ['no iceServers', new Response(JSON.stringify({}), { status: 201 })],
    ['stun-only pool', new Response(JSON.stringify({ iceServers: [{ urls: ['stun:x:3478'] }] }), { status: 201 })],
    ['turn entry without credentials', new Response(JSON.stringify({ iceServers: [{ urls: ['turn:x:3478'] }] }), { status: 201 })],
  ])('treats a malformed response (%s) as no credential, without throwing', async (_label, body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => body.clone())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()
    expect(turnCredentials({ now, fetchImpl })).toBeNull()
  })

  it('de-duplicates concurrent mints', async () => {
    let release!: (value: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchImpl = vi.fn<typeof fetch>(() => gate)

    startTurnCredentialRefresh({ now, fetchImpl })
    turnCredentials({ now, fetchImpl })
    turnCredentials({ now, fetchImpl })
    release(iceResponse())
    await settle()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never touches the network when TURN is unconfigured', async () => {
    envMock.TERMINAL_P2P_TURN_KEY_ID = ''
    const fetchImpl = vi.fn<typeof fetch>(async () => iceResponse())
    startTurnCredentialRefresh({ now, fetchImpl })
    await settle()
    expect(turnCredentials({ now, fetchImpl })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
