/**
 * Opt-in: needs live Cloudflare TURN credentials, so it is skipped unless you ask for it.
 *
 *   TURN_KEY_ID=… TURN_API_TOKEN=… RUN_REAL_TURN=1 npx vitest run src/lib/turnRelay.real.spec.ts
 *
 * It pins the one claim the whole TURN change rests on: forced onto relay-only, two werift peers can
 * still open a terminal data channel through Cloudflare and carry a full-size keyframe. Everything
 * else about TURN is a preference; this is the capability.
 */
import { RTCPeerConnection } from 'werift'
import { describe, expect, it } from 'vitest'

const enabled = process.env.RUN_REAL_TURN === '1'
  && !!process.env.TURN_KEY_ID && !!process.env.TURN_API_TOKEN
const realDescribe = enabled ? describe : describe.skip

async function iceServers(): Promise<object[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 3600 }),
    },
  )
  expect(res.status).toBe(201)
  const body = await res.json() as { iceServers: object[] }
  return body.iceServers
}

realDescribe('Cloudflare TURN relay', () => {
  it('carries a terminal data channel end to end with every direct path forbidden', async () => {
    const config = {
      iceServers: await iceServers(),
      iceTransportPolicy: 'relay',
      maxMessageSize: 512 * 1024,
    } as never
    const a = new RTCPeerConnection(config)
    const b = new RTCPeerConnection(config)

    try {
      const channel = a.createDataChannel('terminal-v1', { ordered: true })
      const inbox: Array<(value: number) => void> = []
      const nextEcho = (): Promise<number> => new Promise((resolve) => inbox.push(resolve))
      channel.onMessage.subscribe((data) => {
        inbox.shift()?.(typeof data === 'string' ? Buffer.byteLength(data) : data.length)
      })
      b.onDataChannel.subscribe((remote) => { remote.onMessage.subscribe((data) => remote.send(data)) })

      // Non-trickle, exactly like the CLI: every candidate rides in the SDP.
      await a.setLocalDescription(await a.createOffer())
      await b.setRemoteDescription(a.localDescription!)
      await b.setLocalDescription(await b.createAnswer())
      await a.setRemoteDescription(b.localDescription!)

      const types = new Set([...(a.localDescription?.sdp ?? '').matchAll(/typ (\w+)/g)].map((m) => m[1]))
      expect([...types]).toEqual(['relay']) // proves nothing direct was even on offer

      const open = await Promise.race([
        new Promise<boolean>((resolve) => {
          channel.stateChanged.subscribe((state) => { if (state === 'open') resolve(true) })
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25_000)),
      ])
      expect(open).toBe(true)

      const echoText = nextEcho()
      channel.send('terminal-input')
      expect(await echoText).toBe('terminal-input'.length)

      // 480 KiB is the biggest thing a terminal ever sends; it must survive SCTP fragmentation here too.
      const echoKeyframe = nextEcho()
      channel.send(Buffer.alloc(480 * 1024, 0x41))
      expect(await echoKeyframe).toBe(480 * 1024)
    } finally {
      await a.close()
      await b.close()
    }
  }, 60_000)
})
