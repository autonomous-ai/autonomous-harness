// The protocol, driven through a loopback port — no dial, no tmux, no network.
//
// What is worth testing here is not that JSON round-trips. It is the three rules the header names, each of
// which was paid for on real hardware and each of which is invisible until it is wrong:
//
//   · every `hello` is answered, but only an unfamiliar dial gets the whole state pushed again
//   · silence reopens the port, because a dead handle keeps accepting writes
//   · a voice turn with no agent named goes through the router before it goes anywhere
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, type CableAgent, type CableHost, type CablePort } from './cableSession.js'

/** A port whose two ends are both in this process. */
class LoopbackPort implements CablePort {
  readonly path = '/dev/loopback'
  isOpen = true
  /** Everything the daemon wrote, decoded back into messages. */
  readonly sent: Array<Record<string, unknown>> = []
  closedWith: string | null = null

  private decoder = new CableDecoder()

  constructor(private readonly onData: (chunk: Buffer) => void) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.decoder.feed(Buffer.from(bytes), (frame) => {
      if (frame.type === CableType.Json) {
        this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
      }
    })
  }

  async close(why = 'closed'): Promise<void> {
    this.isOpen = false
    this.closedWith = why
  }

  /** Speak as the dial. */
  say(msg: Record<string, unknown>): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8'))))
  }

  pcm(bytes: Buffer): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Pcm, bytes)))
  }

  /** A framed ESP_LOG line, as the dial sends while the daemon holds its only port. */
  logLine(text: string): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Log, Buffer.from(text, 'utf8'))))
  }

  /** Only the `t` of each message the daemon sent, in order. */
  types(): string[] {
    return this.sent.map((m) => m.t as string)
  }
}

const AGENTS: CableAgent[] = [
  { id: 'a1', name: 'Fix login screen', engine: 'claude' },
  { id: 'a2', name: 'Device firmware voice', engine: 'codex' },
]

function makeHost(over: Partial<CableHost> = {}) {
  const host: CableHost = {
    machineName: () => 'MacBook Pro',
    appName: () => 'harness',
    voiceLang: () => 'en',
    listAgents: async () => AGENTS,
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    answer: vi.fn(),
    focus: vi.fn(),
    updateAgent: vi.fn(),
    listModels: async () => ['runtime-v1:s1:claude:opus@high', 'runtime-v1:s1:claude:sonnet@low'],
    recentSummaries: () => [],
    transcribe: async () => 'fix the login screen',
    route: async () => ({ agentId: 'a1', confidence: 0.9, reason: 'name matched' }),
    log: () => {},
    ...over,
  }
  return host
}

/** Start a session on a loopback and hand back both ends. Never touches the real serial layer. */
async function connect(host: CableHost = makeHost(), logPath = '/dev/null') {
  let port!: LoopbackPort
  const session = new CableSession(host, logPath, async (onData) => {
    port = new LoopbackPort(onData)
    return port
  })
  session.start()
  await vi.waitFor(() => expect(port).toBeDefined())
  return { session, port, host }
}

/** Let the microtask queue drain — every send is async. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('cable session', () => {
  it('answers hello with welcome and pushes the agent list once', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))

    expect(port.types()).toEqual(['welcome', 'agents.begin', 'agent', 'agent', 'agents.end'])
    const welcome = port.sent[0]
    expect(welcome).toMatchObject({ t: 'welcome', app: 'harness', machine: { name: 'MacBook Pro' } })
    // Streamed one per message: a hundred agents do not fit in one 8 KB frame, and the dial must not have
    // to reassemble anything.
    expect(port.sent[2]).toMatchObject({ t: 'agent', id: 'a1', name: 'Fix login screen', engine: 'claude' })
    await session.stop()
  })

  it('answers a repeat hello WITHOUT re-pushing the list', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    // The dial greets every 15 s for as long as it is plugged in. Re-attaching on each of those re-sends
    // the whole state four times a minute and undoes the "say nothing when nothing changed" rule.
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    expect(port.types()).toEqual(['welcome'])
    await session.stop()
  })

  it('re-attaches for a DIFFERENT dial', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'hello', mac: 'cc:dd' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.types()).toEqual(['welcome', 'agents.begin', 'agent', 'agent', 'agents.end'])
    await session.stop()
  })

  it('delivers a turn through the host, not through the protocol', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'turn.send', agentId: 'a2', text: 'flash it' })
    await settle()
    expect(host.sendTurn).toHaveBeenCalledWith('a2', 'flash it')
    await session.stop()
  })

  it('routes a voice turn that names no agent', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    port.say({ t: 'voice.begin', lang: 'vi' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.transcript'))

    // The transcript went to the router's pick, and the dial was told which tile to land on.
    expect(host.sendTurn).toHaveBeenCalledWith('a1', 'fix the login screen')
    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.transcript', agentId: 'a1', agentName: 'Fix login screen' })
    await session.stop()
  })

  it('sends a voice turn straight to the agent the dial named', async () => {
    const route = vi.fn()
    const host = makeHost({ route })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'voice.begin', agentId: 'a2', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 1))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalled())

    // Naming a tile IS the decision. Asking a router to confirm it is latency spent to reach the same answer.
    expect(route).not.toHaveBeenCalled()
    expect(host.sendTurn).toHaveBeenCalledWith('a2', 'fix the login screen')
    await session.stop()
  })

  it('transcribes at the rate the dial states, not a guess', async () => {
    // 8 kHz described as 16 kHz is not slightly-off speech: the container lies about itself and the
    // transcriber answers with an empty string.
    let sawRate = 0
    const host = makeHost({
      transcribe: async (_pcm, rate) => { sawRate = rate; return 'xin chào' },
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'voice.begin', lang: 'vi', sr: 8000 })
    port.pcm(Buffer.alloc(1600, 3))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(sawRate).toBe(8000))
    await session.stop()
  })

  it('says so rather than guessing when transcription fails', async () => {
    const host = makeHost({
      transcribe: async () => {
        throw new Error('Voice needs CABLE_STT_API_KEY')
      },
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(64))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))

    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.error', message: 'Voice needs CABLE_STT_API_KEY' })
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })

  it('redraws a reattached dial with what each agent was last doing', async () => {
    // The summaries were on disk the whole time; a tile with a name and no recap has forgotten the work
    // it belongs to. Newest LAST on the wire so it ends up on top of the tile's stack.
    const host = makeHost({
      recentSummaries: (id) =>
        id === 'a1' ? [{ recap: 'newest', text: 'b2' }, { recap: 'older', text: 'b1' }] : [],
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types().filter((t) => t === 'summary')).toHaveLength(2))

    const restores = port.sent.filter((m) => m.t === 'summary')
    expect(restores.map((m) => m.recap)).toEqual(['older', 'newest'])
    // Every one is marked history. Without this, plugging the cable in announces every turn that
    // finished while it was unplugged — a beep and a notification each.
    expect(restores.every((m) => m.restore === true)).toBe(true)
    await session.stop()
  })

  it('answers models.list even when the catalog is empty', async () => {
    // The dial BLOCKS on this one message — it cannot draw a picker until the catalog is in hand. Silence
    // strands it on a spinner until its own timeout, which reads as a hang rather than "no choices here".
    const { session, port } = await connect(makeHost({ listModels: async () => [] }))
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0
    port.say({ t: 'models.list', agentId: 'a1', mode: 'model' })
    await vi.waitFor(() => expect(port.types()).toContain('models'))
    expect(port.sent.at(-1)).toMatchObject({ t: 'models', agentId: 'a1', items: [] })
    await session.stop()
  })

  it('answers models.list when the provider throws', async () => {
    const { session, port } = await connect(makeHost({ listModels: async () => { throw new Error('no engine') } }))
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'models.list', agentId: 'a1' })
    await vi.waitFor(() => expect(port.types()).toContain('models'))
    await session.stop()
  })

  it('files framed device logs instead of losing them', async () => {
    // The dial has ONE USB port, shared by its console and this protocol. While the daemon holds it,
    // these frames are the only copy of that console which exists anywhere — `idf.py monitor` cannot open
    // the port at the same time.
    const path = join(mkdtempSync(join(tmpdir(), 'cable-')), 'dial.log')
    const { session, port } = await connect(makeHost(), path)
    port.logLine('I (1234) cable: link up')
    await vi.waitFor(() => expect(readFileSync(path, 'utf8')).toContain('I (1234) cable: link up'))
    await session.stop()
  })

  it('drops audio that arrives outside a turn', async () => {
    // A dial that rebooted mid-capture starts sending PCM again with no `voice.begin` in front of it.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', mac: 'aa:bb' })
    await settle()
    port.pcm(Buffer.alloc(3200, 9))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })
})
