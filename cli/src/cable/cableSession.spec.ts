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
import { CableSession, type CableAgent, type CableHost, type CableMachine, type CablePort } from './cableSession.js'

/** A port whose two ends are both in this process. */
class LoopbackPort implements CablePort {
  readonly path = '/dev/loopback'
  isOpen = true
  /** Everything the daemon wrote, decoded back into messages. */
  readonly sent: Array<Record<string, unknown>> = []
  /** The raw bytes of every frame written, so a test can assert the 8 KB cap holds. */
  readonly frames: Uint8Array[] = []
  closedWith: string | null = null

  private decoder = new CableDecoder()

  constructor(
    private readonly onData: (chunk: Buffer) => void,
    private readonly onClosed: (why: string) => void = () => {},
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.frames.push(bytes)
    this.decoder.feed(Buffer.from(bytes), (frame) => {
      if (frame.type === CableType.Json) {
        this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
      }
    })
  }

  async close(why = 'closed'): Promise<void> {
    if (!this.isOpen) return
    this.isOpen = false
    this.closedWith = why
    // SerialLink announces its own close; a fake that stays quiet makes "the dial went away" untestable.
    this.onClosed(why)
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

const LOCAL_ROW: CableMachine = { id: 'mac-local', name: 'MacBook Pro', state: 'ready', local: true }

const AGENTS: CableAgent[] = [
  { id: 'a1', name: 'Fix login screen', engine: 'claude' },
  { id: 'a2', name: 'Device firmware voice', engine: 'codex' },
]

function makeHost(over: Partial<CableHost> = {}) {
  const host: CableHost = {
    localMachine: () => ({ id: 'mac-local', name: 'MacBook Pro' }),
    listMachines: async () => ({ machines: [LOCAL_ROW], source: 'backend' as const }),
    selectedMachine: () => 'mac-local',
    selectMachine: async () => ({ ok: true as const }),
    appName: () => 'harness',
    voiceLang: () => 'en',
    listAgents: async () => AGENTS,
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    scrolled: vi.fn(),
    answer: vi.fn(),
    focus: vi.fn(),
    updateAgent: vi.fn(),
    listModels: async () => ['runtime-v1:s1:claude:opus@high', 'runtime-v1:s1:claude:sonnet@low'],
    recentSummaries: async () => [],
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
  const session = new CableSession(host, logPath, async (onData, onClosed) => {
    port = new LoopbackPort(onData, onClosed)
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
    port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))

    expect(port.types()).toEqual(
      // Machines FIRST: the dial paints its machine name from this list, so an agent list that lands
      // ahead of it shows a nameless placeholder for a frame.
      ['welcome', 'machines.begin', 'machine', 'machines.end', 'agents.begin', 'agent', 'agent', 'agents.end'],
    )
    const welcome = port.sent[0]
    expect(welcome).toMatchObject({ t: 'welcome', app: 'harness', machine: { name: 'MacBook Pro' } })
    // Streamed one per message: a hundred agents do not fit in one 8 KB frame, and the dial must not have
    // to reassemble anything.
    expect(port.sent.find((m) => m.t === 'agent')).toMatchObject({ t: 'agent', id: 'a1', name: 'Fix login screen', engine: 'claude' })
    await session.stop()
  })

  it('answers a repeat hello WITHOUT re-pushing the list', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    // The dial greets every 15 s for as long as it is plugged in. Re-attaching on each of those re-sends
    // the whole state four times a minute and undoes the "say nothing when nothing changed" rule.
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    expect(port.types()).toEqual(['welcome'])
    await session.stop()
  })

  it('re-attaches for a DIFFERENT dial', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'hello', product: 'harness', mac: 'cc:dd' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.types()).toEqual(
      // Machines FIRST: the dial paints its machine name from this list, so an agent list that lands
      // ahead of it shows a nameless placeholder for a frame.
      ['welcome', 'machines.begin', 'machine', 'machines.end', 'agents.begin', 'agent', 'agent', 'agents.end'],
    )
    await session.stop()
  })

  it('delivers a turn through the host, not through the protocol', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'turn.send', agentId: 'a2', text: 'flash it' })
    await settle()
    expect(host.sendTurn).toHaveBeenCalledWith('a2', 'flash it')
    await session.stop()
  })

  it("refuses a dial that names another product, and lets go of its port", async () => {
    // The framing magic should already have made this greeting unreadable — reaching here means something
    // this code cannot see has changed (a re-unified magic, a fork of the firmware, a third product). The
    // safe reading of "I do not recognise you" is never "you are probably mine".
    const host = makeHost()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'grid', fw: '0.1.2', proto: 1, mac: 'aa:bb' })
    await settle()

    // No welcome: a welcome is what starts a session, and there is no session to have with someone
    // else's dial. And the port is released, because two daemons reading one tty take turns stealing
    // each other's bytes — a stalemate that breaks BOTH links, not just this one.
    expect(port.types()).not.toContain('welcome')
    expect(port.closedWith).toBe('another product')
    await session.stop()
  })

  it('refuses a greeting that names no product at all', async () => {
    // Absence has to mean no. Reading it as "probably ours" puts the hole straight back: the firmware
    // that predates this field is exactly the firmware the sibling product can still capture.
    const host = makeHost()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', fw: '0.0.39', proto: 2, mac: 'aa:bb' })
    await settle()

    expect(port.types()).not.toContain('welcome')
    await session.stop()
  })

  it('writes a given image to a given dial once, however many sessions it takes', async () => {
    // `offered` is per SESSION and every flash ends in a reboot that starts a new one, so it cannot see a
    // loop. Two daemons disagreeing about who owns a board flash it every fifteen seconds — 3 MB a time,
    // ~700 MB an hour — and the dial pays in erase cycles. This is the memory that outlives the port.
    const image = Buffer.alloc(2048, 9)
    const host = makeHost({
      firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }),
    })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)

    // A new session for the same dial — what a reboot looks like from here.
    port.sent.length = 0
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types()).not.toContain('fw.offer')
    await session.stop()
  })

  it('offers the image to a SECOND dial, even after a first one took it', async () => {
    // Found in the field: one dial updated, was unplugged, and a second still on the old image was plugged
    // into the same daemon and never offered anything. `offered` held bare version strings, so it was a
    // statement about the IMAGE rather than about the board — the second dial was refused because that
    // version had been offered to someone else, and nothing in the log said so.
    const image = Buffer.alloc(2048, 9)
    const host = makeHost({
      firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }),
    })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)

    // The first dial takes it and reboots. Without this the transfer is still in flight and the guard
    // that refuses a SECOND concurrent offer would be what answers below — a different rule, and the
    // wrong one to be testing here.
    port.say({ t: 'fw.done' })
    await settle()

    // A different board, same daemon, same port — the port does not close when a dial reboots, which is
    // why the session's memory of what it has offered outlives the dial it offered to.
    port.sent.length = 0
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'cc:dd' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)
    await session.stop()
  })

  it('does not wedge forever when opening the port hangs', async () => {
    // The `opening` guard keeps two opens from racing on one tty — a race that once left five read loops
    // shredding a single byte stream. But a guard released only when the attempt FINISHES is a guard held
    // forever by an attempt that never does, and the dial is then gone until the daemon is restarted:
    // no error, no retry, no line in the log saying why. Seen once in the field — the link closed and
    // nothing tried again for twelve minutes, after the dial re-enumerated mid-flash.
    vi.useFakeTimers()
    try {
      let attempts = 0
      const session = new CableSession(makeHost(), '/dev/null', async (onData, onClosed) => {
        attempts += 1
        if (attempts === 1) return new Promise<never>(() => {})   // the hang
        return new LoopbackPort(onData, onClosed)
      })
      session.start()
      await vi.advanceTimersByTimeAsync(20_000)

      expect(attempts).toBeGreaterThan(1)
      await session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('brings the dial to the agent the window opened', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    await session.followApp('', 'a2')
    await settle()

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
    await session.stop()
  })

  it("never echoes the dial's own move back at it", async () => {
    // THE RING: the dial's carousel reports `focus` up, the daemon hands that to the window, the window
    // opens that agent's terminal, and a window opening a terminal is exactly what calls followApp. Left
    // unguarded that answers the dial with the move it just made. It settles today only because the far
    // end does not re-report a carousel that never moved — a property of its UI, not of this protocol.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'focus', agentId: 'a2' })   // the dial moved itself
    await settle()
    port.sent.length = 0

    await session.followApp('', 'a2')          // the window caught up
    await settle()

    expect(port.sent.filter((m) => m.t === 'focus')).toEqual([])
    await session.stop()
  })

  it('ignores stale dial focus while the app switches to a remote machine', async () => {
    let selected = 'mac-local'
    let finishSelection!: () => void
    const selectionGate = new Promise<void>((resolve) => { finishSelection = resolve })
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        await selectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    const following = session.followApp('remote-machine', 'r1')
    await settle()
    port.say({ t: 'focus', agentId: 'a1' }) // old tile reported while the list is rebuilding
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    finishSelection()
    await following
    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toContain('r1')

    port.say({ t: 'focus', agentId: 'a1' }) // stale old tile, delivered just after the switch completed
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'r1' }) // echo of the app-driven focus
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'r2' }) // a real subsequent dial move
    await settle()
    expect(host.focus).toHaveBeenCalledWith('r2')
    await session.stop()
  })

  it('does not bounce a local app selection back to the previous remote agent', async () => {
    let selected = 'remote-machine'
    let finishSelection!: () => void
    const selectionGate = new Promise<void>((resolve) => { finishSelection = resolve })
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        await selectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    const following = session.followApp('mac-local', 'a2')
    await settle()
    port.say({ t: 'focus', agentId: 'r1' })
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    finishSelection()
    await following
    port.say({ t: 'focus', agentId: 'r1' }) // late report from the previous remote tile
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'a2' }) // acknowledgement of the commanded local tile
    await settle()
    port.say({ t: 'focus', agentId: 'r2' }) // subsequent physical dial move still works
    await settle()
    expect(host.focus).toHaveBeenCalledTimes(1)
    expect(host.focus).toHaveBeenCalledWith('r2')
    await session.stop()
  })

  it('coalesces quick app selections so the newest one focuses last', async () => {
    let selected = 'mac-local'
    let finishFirstSelection!: () => void
    const firstSelectionGate = new Promise<void>((resolve) => { finishFirstSelection = resolve })
    let selections = 0
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        selections += 1
        if (selections === 1) await firstSelectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    const oldSelection = session.followApp('remote-machine', 'r1')
    await settle()
    const newestSelection = session.followApp('mac-local', 'a2')
    finishFirstSelection()
    await Promise.all([oldSelection, newestSelection])

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
    expect(selected).toBe('mac-local')
    await session.stop()
  })

  it('forwards a whole stroke, including the reports that carry no travel', async () => {
    // The ends of a stroke are the point of the message, not padding around it: a `down` with nothing in
    // it is what stops a fling still running on the far side, and an `up` with nothing in it is a finger
    // that came to rest before it lifted and must land as a stop rather than a throw. A forwarder that
    // "optimised away" the empty ones would leave the window holding a drag forever.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'scroll', phase: 'down', dy: 0 })
    port.say({ t: 'scroll', phase: 'move', dy: 12 })
    port.say({ t: 'scroll', phase: 'up', dy: 3, v: -1800 })
    await settle()

    expect(host.scrolled).toHaveBeenNthCalledWith(1, 'down', 0, 0)
    expect(host.scrolled).toHaveBeenNthCalledWith(2, 'move', 12, 0)
    expect(host.scrolled).toHaveBeenNthCalledWith(3, 'up', 3, -1800)
    await session.stop()
  })

  it('drops a stroke whose phase is not one of the three', async () => {
    // The dial is the only thing that speaks this today, but the decoder hands up whatever arrives, and a
    // phase nobody understands must not reach the window as a drag it can never close.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'scroll', phase: 'sideways', dy: 40 })
    await settle()

    expect(host.scrolled).not.toHaveBeenCalled()
    await session.stop()
  })

  it('routes a voice turn that names no agent', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
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
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
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
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
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
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(64))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))

    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.error', message: 'Voice needs CABLE_STT_API_KEY' })
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })

  it('corrects a list it sent before the registry was ready', async () => {
    // THE BUG THIS EXISTS FOR: a daemon that has just restarted answers `hello` before its registry has
    // finished loading, so the honest answer at that instant is "no agents" — and under a rule that only
    // speaks when something changed, that one answer stood forever. The dial removed every tile and sat
    // empty while the daemon knew about two.
    let agents: CableAgent[] = []
    const { session, port } = await connect(makeHost({ listAgents: async () => agents }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(0)

    port.sent.length = 0
    agents = AGENTS                                    // the registry finishes loading
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'), { timeout: 3000 })
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(2)
    await session.stop()
  })

  it('stays quiet while the list is unchanged', async () => {
    // The other half of the same rule. A push per tick would re-send the whole board every second and
    // undo the thing that keeps an idle link idle.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0
    await new Promise((r) => setTimeout(r, 2500))      // two ticks
    expect(port.types().filter((t) => t.startsWith('agents'))).toEqual([])
    await session.stop()
  })

  it('redraws a reattached dial with what each agent was last doing', async () => {
    // The summaries were on disk the whole time; a tile with a name and no recap has forgotten the work
    // it belongs to. Newest LAST on the wire so it ends up on top of the tile's stack.
    const host = makeHost({
      recentSummaries: async (id) =>
        id === 'a1' ? [{ recap: 'newest', text: 'b2' }, { recap: 'older', text: 'b1' }] : [],
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
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
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0
    port.say({ t: 'models.list', agentId: 'a1', mode: 'model' })
    await vi.waitFor(() => expect(port.types()).toContain('models'))
    expect(port.sent.at(-1)).toMatchObject({ t: 'models', agentId: 'a1', items: [] })
    await session.stop()
  })

  it('answers models.list when the provider throws', async () => {
    const { session, port } = await connect(makeHost({ listModels: async () => { throw new Error('no engine') } }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
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
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.pcm(Buffer.alloc(3200, 9))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })
  // ── the machine wheel ─────────────────────────────────────────────────────────────────────────────

  it('streams the machine list and names the selected one', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))

    expect(port.sent.find((m) => m.t === 'machine')).toMatchObject({
      t: 'machine', id: 'mac-local', name: 'MacBook Pro', state: 'ready', local: true,
    })
    expect(port.sent.find((m) => m.t === 'machines.end')).toMatchObject({ selected: 'mac-local', source: 'backend' })
    await session.stop()
  })

  it('names the CABLED computer in welcome, not the dial', async () => {
    // Until proto 2 this carried the dial's own MAC as the machine id — a value nothing could ever select.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('welcome'))
    expect(port.sent[0]).toMatchObject({ t: 'welcome', machine: { id: 'mac-local' }, selected: 'mac-local' })
    await session.stop()
  })

  it('says nothing about machines when nothing changed', async () => {
    // The 15s hello cadence and every port reopen would otherwise re-push a list the dial already has —
    // the flap that measured out at 31 session restarts an hour, with the agent list wiped each time.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))
    const before = port.types().filter((t) => t === 'machines.begin').length

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })   // same dial, same firmware: a keepalive
    await settle()
    expect(port.types().filter((t) => t === 'machines.begin')).toHaveLength(before)
    await session.stop()
  })

  it('acks a select, then pushes THAT machine\'s agents', async () => {
    const other: CableMachine = { id: 'm2', name: 'office-imac', state: 'ready', local: false }
    const remote: CableAgent[] = [{ id: 'r1', name: 'api refactor', engine: 'codex' }]
    let selected = 'mac-local'
    const host = makeHost({
      listMachines: async () => ({ machines: [LOCAL_ROW, other], source: 'backend' as const }),
      selectedMachine: () => selected,
      selectMachine: async (id: string) => { selected = id; return { ok: true as const } },
      listAgents: async () => (selected === 'm2' ? remote : AGENTS),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.selected'))
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(1)
    expect(port.sent.find((m) => m.t === 'agent')).toMatchObject({ id: 'r1' })
    await session.stop()
  })

  it('sends the new list even when it hashes identically to the old one', async () => {
    // Two machines whose agents share names and engines produce an EQUAL agentsKey. Without resetting it
    // on a switch, the dial would keep the previous machine's tiles and nothing would ever correct it.
    const twin: CableAgent[] = [...AGENTS]
    let selected = 'mac-local'
    const host = makeHost({
      listMachines: async () => ({
        machines: [LOCAL_ROW, { id: 'm2', name: 'twin', state: 'ready' as const, local: false }],
        source: 'backend' as const,
      }),
      selectedMachine: () => selected,
      selectMachine: async (id: string) => { selected = id; return { ok: true as const } },
      listAgents: async () => twin,
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(2)
    await session.stop()
  })

  it('reports a refused select and leaves the selection alone', async () => {
    const host = makeHost({
      selectMachine: async () => ({ ok: false as const, code: 'NEEDS_LINK', message: 'Run harness link import' }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.error'))
    expect(port.sent.find((m) => m.t === 'machine.error')).toMatchObject({
      machineId: 'm2', code: 'NEEDS_LINK', message: 'Run harness link import',
    })
    expect(port.types()).not.toContain('agents.begin')   // the old machine's tiles stay put
    await session.stop()
  })

  it('answers a select of the machine already selected instead of going quiet', async () => {
    // Silence here strands the dial on its spinner until its own deadline, which reads as a hang.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'mac-local' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.selected'))
    await session.stop()
  })

  it('shows one row and says why when there is no lane to anywhere else', async () => {
    const host = makeHost({ listMachines: async () => ({ machines: [LOCAL_ROW], source: 'signed-out' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))
    expect(port.sent.filter((m) => m.t === 'machine')).toHaveLength(1)
    expect(port.sent.find((m) => m.t === 'machines.end')).toMatchObject({ source: 'signed-out' })
    await session.stop()
  })

  it('forwards a question answer verbatim, keyed by the QUESTION keys', async () => {
    // The dial has always sent {agentId, requestId, answers}; this case used to demand {id, optionId} and
    // silently dropped every answer the question screen produced.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'answer', agentId: 'a1', requestId: 'req-7', answers: { scope: 'wide', mode: 'plan' } })
    await vi.waitFor(() => expect(host.answer).toHaveBeenCalled())
    expect(host.answer).toHaveBeenCalledWith('a1', 'req-7', { scope: 'wide', mode: 'plan' })
    await session.stop()
  })

  it('fits ten machines with long names into single frames', async () => {
    const many: CableMachine[] = Array.from({ length: 10 }, (_, i) => ({
      id: `machine-${String(i).padStart(30, 'x')}`,
      name: 'x'.repeat(39),
      state: 'ready' as const,
      local: i === 0,
    }))
    const host = makeHost({ listMachines: async () => ({ machines: many, source: 'backend' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'machine')).toHaveLength(10))
    for (const frame of port.frames) expect(frame.length).toBeLessThan(8192)
    await session.stop()
  })
  it('never interleaves two streamed pushes', async () => {
    // MEASURED ON HARDWARE, 2026-08-25, first plug-in of the proto-2 firmware: the dial reported EIGHT
    // machines while the daemon's own log said it had sent four, three times.
    //
    // `onMessage` is fired from the decoder and never awaited, so a dial that greets and then asks for
    // both lists has three pushes in flight at once — and each row parks on an await. Unserialised, the
    // wire carried `begin begin begin row×6 end end end`: the dial reset its staging on every begin,
    // accumulated every push's rows, and committed the pile on the first end.
    //
    // THE SLOW PORT IS THE TEST. With a write that resolves synchronously the three pushes run to
    // completion one at a time and this passes with or without the fix — which is exactly what the first
    // version of this test did, and why it proved nothing. A real tty accepts a few hundred bytes at a
    // time; every frame parks.
    class SlowPort implements CablePort {
      readonly path = 'slow'
      isOpen = true
      readonly sent: Array<Record<string, unknown>> = []
      private decoder = new CableDecoder()
      constructor(private readonly onData: (chunk: Buffer) => void) {}
      async write(bytes: Uint8Array): Promise<void> {
        await new Promise((r) => setTimeout(r, 0))
        this.decoder.feed(Buffer.from(bytes), (frame) => {
          if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')))
        })
      }
      async close(): Promise<void> { this.isOpen = false }
      say(msg: Record<string, unknown>): void {
        this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8'))))
      }
    }

    const rows: CableMachine[] = [
      LOCAL_ROW,
      { id: 'm2', name: 'office-imac', state: 'ready', local: false },
    ]
    const host = makeHost({ listMachines: async () => ({ machines: rows, source: 'backend' as const }) })
    let port!: SlowPort
    const session = new CableSession(host, '/dev/null', async (onData) => {
      port = new SlowPort(onData)
      return port
    })
    session.start()
    await vi.waitFor(() => expect(port).toBeTruthy())

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    port.say({ t: 'machines.list' })
    port.say({ t: 'agents.list' })
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.t === 'machines.end').length).toBeGreaterThanOrEqual(3)
    })

    // Walk the wire: a `begin` may never open inside another, and each pair must hold the rows of ONE list.
    let open = false
    let seen = 0
    for (const m of port.sent) {
      if (m.t === 'machines.begin') { expect(open, 'a begin arrived inside another begin').toBe(false); open = true; seen = 0 }
      else if (m.t === 'machine') { expect(open, 'a row arrived outside a begin/end pair').toBe(true); seen++ }
      else if (m.t === 'machines.end') { expect(open).toBe(true); expect(seen).toBe(rows.length); open = false }
    }
    expect(open, 'a begin was never closed').toBe(false)
    await session.stop()
  })
  it('tells the host when the dial arrives and when it goes', async () => {
    // The daemon's cloud lane is held on the dial's behalf, so these two are what open and close it. A
    // port that goes silent must look identical to a cable that was pulled — both are "no dial".
    const host = makeHost()
    host.onDialAttached = vi.fn()
    host.onDialGone = vi.fn()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(host.onDialAttached).toHaveBeenCalledTimes(1))

    // A keepalive greeting from the same dial is not a new arrival — re-opening the lane on every one
    // would dial the cloud every fifteen seconds for as long as the dial sits there.
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    expect(host.onDialAttached).toHaveBeenCalledTimes(1)

    await session.stop()
    expect(host.onDialGone).toHaveBeenCalled()
  })
})
