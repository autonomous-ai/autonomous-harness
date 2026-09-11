// The dial's behaviour collector.
//
// Two properties carry this file. First, that it NEVER costs a turn: no throw
// reaches a caller, from a bad event, a dead network or an unwritable disk —
// this sits directly under the path carrying a person's words. Second, that a
// session with no network is not a session that was lost, because a dial driven
// on a shut laptop is the most interesting way the thing gets used.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'product-'))

vi.mock('../../config/env.js', () => ({
  env: { ADAPTER_DATA_DIR: join(dataDir, 'cli', 'data'), PRODUCT_ANALYTICS_DISABLED: false },
}))

const { ProductCollector, productSpoolFile, trackingDisabled } = await import('./collector.js')
const { dialEvents, isValidProductEvent } = await import('./events.js')

function make(send: (body: unknown) => Promise<boolean>) {
  return new ProductCollector({ computerId: () => 'computer-1', send })
}

beforeEach(() => {
  try {
    rmSync(productSpoolFile(), { force: true })
  } catch { /* nothing spooled yet */ }
  try {
    rmSync(join(dataDir, 'cli', 'desktop-app'), { recursive: true, force: true })
  } catch { /* no switch written */ }
})

afterEach(() => vi.restoreAllMocks())

describe('ProductCollector', () => {
  it('sends what it is given, with the computer id and the category', async () => {
    const sent: Array<Record<string, unknown>> = []
    const c = make(async (body) => { sent.push(body as Record<string, unknown>); return true })
    c.start()
    c.track(dialEvents.attached('0.0.49', 3))
    await c.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      event_name: 'dial_attached',
      user_pseudo_id: 'computer-1',
      category: 'harness-dial',
    })
  })

  it('keeps events across a restart when the network is down', async () => {
    // The case the desktop app's in-memory queue gives up on, and the reason
    // this one writes to disk: a laptop shut, moved, and opened somewhere else.
    const offline = make(async () => false)
    offline.start()
    offline.track(dialEvents.turnSent('claude', 'voice'))
    offline.track(dialEvents.navigated('scroll', 3))
    await offline.flush()
    expect(offline.pending()).toBe(2)

    const sent: unknown[] = []
    const later = make(async (body) => { sent.push(body); return true })
    later.start()
    expect(later.pending()).toBe(2)
    await later.flush()
    expect(sent).toHaveLength(2)
    expect(later.pending()).toBe(0)
  })

  it('drains oldest first and stops at the first refusal', async () => {
    // These are one person's session in order. Skipping past a failure would
    // leave the stream out of sequence for as long as the failure lasts.
    const seen: string[] = []
    let allow = 1
    const c = make(async (body) => {
      const name = (body as { event_name: string }).event_name
      if (seen.length >= allow) return false
      seen.push(name)
      return true
    })
    c.start()
    c.track(dialEvents.attached('1', 3))
    c.track(dialEvents.turnSent('claude', 'type'))
    c.track(dialEvents.detached('unplugged', 5))
    await c.flush()
    expect(seen).toEqual(['dial_attached'])
    expect(c.pending()).toBe(2)

    allow = 3
    await c.flush()
    expect(seen).toEqual(['dial_attached', 'dial_turn_sent', 'dial_detached'])
  })

  it('never throws when the transport does', async () => {
    const c = make(async () => { throw new Error('socket died') })
    c.start()
    c.track(dialEvents.fault('frozen'))
    await expect(c.flush()).resolves.toBeUndefined()
    expect(c.pending()).toBe(1)
  })

  it('refuses a malformed event rather than putting it in a shared stream', () => {
    const c = make(async () => true)
    c.start()
    c.track({ name: 'Dial Attached', params: {}, at: Date.now() })
    c.track({ name: 'ok_name', params: { bad: { nested: 1 } as never }, at: Date.now() })
    expect(c.pending()).toBe(0)
  })

  it('queues nothing before start', () => {
    const c = make(async () => true)
    c.track(dialEvents.attached('1', 3))
    expect(c.pending()).toBe(0)
  })

  it('drops a 4xx rather than blocking everything behind it', async () => {
    // Retrying an event the service has refused would wedge the queue for good.
    let calls = 0
    const c = new ProductCollector({
      computerId: () => 'c',
      send: undefined,
    })
    vi.stubGlobal('fetch', async () => { calls++; return new Response('no', { status: 422 }) })
    c.start()
    c.track(dialEvents.answer('answered'))
    await c.flush()
    expect(calls).toBe(1)
    expect(c.pending()).toBe(0)
  })

  it('caps the spool and keeps the NEWEST', async () => {
    const c = make(async () => false)
    c.start()
    for (let i = 0; i < 520; i++) c.track(dialEvents.navigated('scroll', i))
    expect(c.pending()).toBe(500)
    const spooled = JSON.parse(readFileSync(productSpoolFile(), 'utf8')) as Array<{ params: { ring_depth: number } }>
    expect(spooled[spooled.length - 1].params.ring_depth).toBe(519)
  })

  it('survives a corrupt spool instead of refusing to start', () => {
    mkdirSync(dirname(productSpoolFile()), { recursive: true })
    writeFileSync(productSpoolFile(), '{ not json')
    const c = make(async () => true)
    c.start()
    expect(c.pending()).toBe(0)
  })
})

describe('the user switch', () => {
  const switchFile = () => join(dataDir, 'cli', 'desktop-app', 'analytics.json')

  it('is off when the desktop app says tracking is off', () => {
    // ONE switch for one person. Honouring it in the window and not in the
    // daemon would make the setting a lie.
    mkdirSync(dirname(switchFile()), { recursive: true })
    writeFileSync(switchFile(), JSON.stringify({ enabled: false }))
    expect(trackingDisabled()).toBe(true)
  })

  it('is on when the file says so, and when there is no file at all', () => {
    mkdirSync(dirname(switchFile()), { recursive: true })
    writeFileSync(switchFile(), JSON.stringify({ enabled: true }))
    expect(trackingDisabled()).toBe(false)
    rmSync(switchFile())
    // A computer that has never run the desktop app is not one that opted out.
    expect(trackingDisabled()).toBe(false)
  })

  it('queues nothing while it is off', () => {
    mkdirSync(dirname(switchFile()), { recursive: true })
    writeFileSync(switchFile(), JSON.stringify({ enabled: false }))
    const c = make(async () => true)
    c.start()
    c.track(dialEvents.turnSent('claude', 'voice'))
    expect(c.pending()).toBe(0)
    rmSync(switchFile())
  })

  it('throws away what was already spooled when it is turned off', async () => {
    const c = make(async () => false)
    c.start()
    c.track(dialEvents.turnSent('claude', 'voice'))
    expect(c.pending()).toBe(1)
    mkdirSync(dirname(switchFile()), { recursive: true })
    writeFileSync(switchFile(), JSON.stringify({ enabled: false }))
    await c.flush()
    // Turning it off has to reach the backlog too, or the next time the network
    // comes back it sends everything the person just said no to.
    expect(c.pending()).toBe(0)
    rmSync(switchFile())
  })
})

describe('the events themselves', () => {
  it('carry no names, no text and no paths', () => {
    // The rule this stream is held to, checked on the shapes rather than trusted
    // to review: counts, durations, short codes and ids.
    const all = [
      dialEvents.attached('0.0.49', 3),
      dialEvents.detached('unplugged', 12),
      dialEvents.heartbeat(5, 210),
      dialEvents.turnSent('claude', 'voice'),
      dialEvents.voice('sent', 4, 'window'),
      dialEvents.navigated('swipe', 2),
      dialEvents.machineSelected(),
      dialEvents.agentOpened('dial'),
      dialEvents.answer('answered'),
      dialEvents.settingChanged('brightness'),
      dialEvents.firmwareUpdate('0.0.48', '0.0.49', 'installed'),
      dialEvents.fault('frozen'),
    ]
    for (const event of all) {
      expect(isValidProductEvent(event), event.name).toBe(true)
      for (const value of Object.values(event.params)) {
        if (typeof value !== 'string') continue
        expect(value).not.toMatch(/[/\\]/)
        expect(value.length).toBeLessThan(40)
      }
    }
  })

  it('rounds durations, so a timing is never a fingerprint', () => {
    expect(dialEvents.heartbeat(5.7, 3).params.minutes).toBe(6)
    expect(dialEvents.voice('sent', 4.49, 'window').params.seconds).toBe(4)
  })
})
