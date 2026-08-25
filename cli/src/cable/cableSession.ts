// The message layer: what the daemon and the dial SAY to each other, on top of the bytes serial.ts moves.
//
// Written twice — here and in apps/esp32-circle/main/cable_client.c of the autonomous-code repository —
// with no shared code, because the two halves ship from different repositories. The framing underneath
// agrees by shared vectors; this layer agrees by docs/cable-protocol.md and by being small enough to read
// in one sitting.
//
// THE VOCABULARY IS THE PRODUCT'S: machine → agent → session. The machine is this computer, the agents
// are what the registry holds, and a session is one conversation underneath an agent.
//
// Three rules here were paid for on real hardware and are not style:
//
//   1. ANSWER EVERY `hello`, RE-ATTACH ONLY FOR A DIAL NOT ALREADY GREETED. The dial greets on a cadence
//      because it has no port-open event to wait on. Attaching means "this device knows nothing" and
//      pushes the whole state again; doing that on every greeting re-sends everything every 15 seconds.
//
//   2. PING EVEN WHEN IDLE, AND REOPEN THE PORT ON SILENCE. After the dial reboots, macOS hands back a
//      `/dev/cu.usbmodem*` node with the same name, the same inode and the same device numbers. Writes to
//      the old handle keep succeeding, the read never completes, and nothing raises. Without a heartbeat
//      this daemon would talk to a dead file for as long as anyone watched.
//
//   3. SAY NOTHING WHEN NOTHING CHANGED. That is what keeps the link idle during a long turn, and it is
//      why rule 2 has to exist at all.
import { appendFile } from 'node:fs/promises'

import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { FirmwareTransfer } from './fwPush.js'
import { SerialLink, findDialPort } from './serial.js'

/** Bumped when the VOCABULARY changes. Separate from the frame version, which is the envelope. */
export const CABLE_PROTO_VERSION = 2

const PING_EVERY_MS = 5_000
/** No bytes of any kind for this long → the handle is dead. Longer than the dial's own 15 s window, so a
 *  single late message cannot trip both sides at once and have each conclude the other left. */
const SILENCE_MS = 20_000
const REOPEN_EVERY_MS = 2_000
/** How often the machine list is re-read. Slower than the agent list because it is an HTTP read, not a
 *  map lookup — and because a machine appearing is not something anyone is waiting on a stopwatch for. */
const MACHINES_POLL_MS = 15_000

/** What a `voice.begin` without an `sr` is assumed to be — firmware old enough not to say. */
const DEFAULT_VOICE_RATE = 16_000

/** A voice turn longer than this is a stuck dial, not a person talking. 16 kHz mono 16-bit ≈ 32 KB/s. */
const VOICE_MAX_BYTES = 10 * 60 * 32_000

export interface CableAgent {
  id: string
  name: string
  engine?: string
  model?: string
  effort?: string
}

/**
 * One row of the dial's machine wheel.
 *
 * `state` is the ONLY liveness word on the wire, deliberately as one tri-value rather than an `online`
 * boolean beside a `known` one: one field cannot contradict itself, two can — and would, the first time a
 * list refresh fails halfway through.
 */
export interface CableMachine {
  id: string
  name: string
  state: 'ready' | 'offline' | 'unknown' | 'needs-link'
  /** Exactly one row carries this: the computer at the other end of the cable. */
  local: boolean
}

/** Why the list is as short as it is. The dial renders this, instead of drawing an empty wheel. */
export type CableMachineSource = 'backend' | 'local' | 'signed-out'

export interface RouteDecision {
  agentId: string
  confidence: number
  reason: string
}

/**
 * Everything the session needs from the rest of the daemon. An interface rather than a direct import so
 * the protocol can be tested against a fake — the alternative is a suite that needs tmux, a microphone
 * and a network to prove that `hello` gets a `welcome`.
 */
export interface CableHost {
  /** The computer at the other end of the cable — its identity, not "the" machine's. */
  localMachine(): { id: string; name: string }
  /** Every machine the owner has, local row included. Never rejects: `source` explains a short list. */
  listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }>
  /** Which one the agent list currently belongs to. */
  selectedMachine(): string
  /**
   * Switch. Resolves to a discriminated result and NEVER throws — a refusal is data here, the same way
   * `firmwareFor()` returning null is. `code` is the daemon's; `message` is shown to a person verbatim,
   * so the dial needs no table for a set it does not own.
   */
  selectMachine(machineId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  appName(): string
  voiceLang(): string
  listAgents(): Promise<CableAgent[]>
  sendTurn(agentId: string, text: string): void
  stopTurn(agentId: string): void
  /**
   * The user answered a `question`. `answers` is keyed by the QUESTION keys the daemon itself asked with
   * and travels verbatim — re-deriving it, or keying it by the requestId, is how a rename at either end
   * becomes an answer nobody gave.
   */
  answer(agentId: string, requestId: string, answers: Record<string, string>): void
  focus(agentId: string): void
  /** A finger moving on the dial's glass, on its way to whatever window is open on this computer. */
  scrolled(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void
  updateAgent(agentId: string, model?: string, effort?: string): void
  /** PCM is 16-bit mono at `sampleRate`; the daemon owns the credential this needs. */
  transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string>
  /** Which agent the words belong to. Scored locally first; only a genuine tie should cost a network call. */
  route(transcript: string, agents: CableAgent[]): Promise<RouteDecision>
  /** The runtime model/effort catalog for one agent, as opaque profile ids the dial groups and shows. */
  listModels(agentId: string): Promise<string[]>
  /** One agent's last turn summaries, newest first — what a reattached dial needs to redraw its tiles. */
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string }>>
  /**
   * The image to offer a dial running `runningVersion`, or null for "nothing to do" — which covers a
   * dial that is current, a dev build that must not be touched, and an unreachable manifest.
   */
  firmwareFor?(runningVersion: string): Promise<{ version: string; image: Buffer; sha256: string } | null>
  log(line: string): void
}

interface Message {
  t: string
  [key: string]: unknown
}

/**
 * The part of a port this layer uses. An interface rather than the class, so the protocol can be driven
 * by a loopback in tests — proving that `hello` gets a `welcome` should not require a dial on the desk.
 */
export interface CablePort {
  readonly path: string
  readonly isOpen: boolean
  write(bytes: Uint8Array): Promise<void>
  close(why?: string): Promise<void>
}

/** Open the dial's port, or null when it is not there. Both are ordinary answers. */
export type PortOpener = (
  onData: (chunk: Buffer) => void,
  onClosed: (why: string) => void,
) => Promise<CablePort | null>

/** The real one: find the tty by USB id, open it raw. */
export const openDialPort: PortOpener = async (onData, onClosed) => {
  const port = await findDialPort()
  if (!port) return null
  return SerialLink.open(port.path, onData, onClosed)
}

export class CableSession {
  private link: CablePort | null = null
  private decoder = new CableDecoder()
  private timer: NodeJS.Timeout | null = null
  private greetedMac: string | null = null
  private greetedFw: string | null = null
  private lastRx = 0
  private stopped = false

  /** What the dial was last told the agent list is. Empty = it has been told nothing. */
  private lastAgentsKey = ''
  /** The same, for the machine wheel. Both reset together on any new port — see `tryOpen`. */
  private lastMachinesKey = ''
  /** Throttle for the machine list, which costs an HTTP read where the agent list costs a map lookup. */
  private machinesAt = 0
  /**
   * Serialises every STREAMED push (begin / rows / end).
   *
   * ⚠️ NOT a precaution. `onMessage` is fired from the decoder callback and never awaited, so a dial that
   * greets and then asks for both lists has three pushes in flight at once — each awaiting a write
   * between every row. Their frames interleave, and the far end sees `begin, begin, 8 rows, end, end`:
   * it stages one machine list twice over and reports eight machines where the daemon sent four.
   *
   * Measured on hardware 2026-08-25, first plug-in of the proto-2 firmware. The dial's own hash gate does
   * not help here — it faithfully gates a list that was already shredded on the way in.
   */
  private pushChain: Promise<void> = Promise.resolve()

  /** Run `body` after every push already queued, and before any queued later. */
  private queued(body: () => Promise<void>): Promise<void> {
    const next = this.pushChain.then(body)
    // The tail swallows so one failed push cannot strand the ones behind it; the caller still sees it.
    this.pushChain = next.catch(() => {})
    return next
  }

  /** A firmware transfer in flight, and the versions already tried this session. */
  private transfer: FirmwareTransfer | null = null
  private offered = new Set<string>()

  /** Voice capture in flight: PCM chunks as they arrive, plus what `voice.begin` said about them. */
  private voice: { agentId?: string; cmd?: string; lang: string; rate: number; chunks: Buffer[]; bytes: number } | null = null

  constructor(
    private readonly host: CableHost,
    /** Where framed device logs are appended. The dial has one USB port, so this file is its console. */
    private readonly logPath: string,
    private readonly openPort: PortOpener = openDialPort,
  ) {}

  get isConnected(): boolean {
    return this.link?.isOpen === true && this.greetedMac !== null
  }

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => void this.tick(), 1_000)
    void this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.link?.close('daemon stopping')
    this.link = null
  }

  // ── port lifecycle ────────────────────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (!this.link?.isOpen) {
      await this.tryOpen()
      return
    }
    // Rule 2. The read never fails on a dead handle, so silence is the only symptom there is.
    if (Date.now() - this.lastRx > SILENCE_MS) {
      this.host.log('cable: silent, reopening the port')
      await this.link.close('silence')
      this.link = null
      return
    }
    // The cadence is the contract: the dial reads a gap as absence, and the tick that watches for that
    // gap runs far more often than the ping that prevents it.
    if (Date.now() - this.lastPing >= PING_EVERY_MS) {
      this.lastPing = Date.now()
      await this.send({ t: 'ping' })
    }

    // "Say nothing when nothing changed" has to be paired with "say something when something did".
    // Without this the list was sent ONCE per session and never corrected — and a daemon that has just
    // restarted greets the dial before its registry has finished loading, so the one thing it ever said
    // was "no agents". The dial removed both tiles and sat empty while the daemon knew about two.
    if (this.greetedMac !== null) {
      // Machines FIRST. The dial paints its Overview eyebrow from the machine list, so an agent list that
      // lands first shows a nameless "Machine" for a frame.
      if (Date.now() - this.machinesAt >= MACHINES_POLL_MS) {
        this.machinesAt = Date.now()
        await this.syncMachines()
      }
      await this.syncAgents()
    }
  }

  private openAt = 0
  private opening = false
  private lastPing = 0

  /**
   * Open the dial's port, at most ONE attempt at a time.
   *
   * ⚠️ THE `opening` FLAG IS THE FIX FOR A BUG THAT LOOKED LIKE BROKEN HARDWARE. `tick()` is fired by
   * setInterval and never awaited, so runs overlap freely, and opening a port is not instant — it spawns
   * `stty` and waits for it before it opens the descriptor. Under load that outlasts REOPEN_EVERY_MS, the
   * next tick walks straight past the throttle below, and a second open begins while the first is still in
   * flight. Only the last one is stored in `this.link`. The others are orphaned WITH THEIR READ LOOPS
   * STILL RUNNING.
   *
   * That is not a descriptor quietly wasted. Every orphan reads the SAME tty and feeds the SAME decoder,
   * so one byte stream arrives interleaved from several readers: frames are shredded, CRCs fail, and the
   * dial's greetings disappear into the noise.
   *
   * Measured 2026-08-24 — five descriptors open on one port inside one process (`lsof` names them all),
   * the daemon receiving 4 of the dial's 22 greetings in 45s, and a 20-byte ping taking 15 SECONDS to
   * write. That last number is the dial's own silence deadline, so the session died and restarted forever
   * and the screen sat on "0 agents" while this side logged, truthfully, that it had sent two.
   *
   * The dial was never at fault: sniffed directly with the daemon stopped, it emits one clean 71-byte
   * greeting every 2.0s, indefinitely.
   */
  private async tryOpen(): Promise<void> {
    if (this.opening) return
    if (Date.now() - this.openAt < REOPEN_EVERY_MS) return
    this.opening = true
    this.openAt = Date.now()
    let opened: CablePort | null
    try {
      opened = await this.openPort(
        (chunk) => this.onBytes(chunk),
        (why) => this.onClosed(why),
      )
    } catch (err) {
      // A port that another process holds is the ordinary case, not a fault: esptool, a serial monitor,
      // or a second daemon. Say so and try again on the next tick.
      this.host.log(`cable: cannot open the dial: ${(err as Error).message}`)
      return
    } finally {
      this.opening = false
    }
    if (!opened) return   // no dial plugged in — this daemon's resting state
    // Nothing reaches this line holding a live port — tick() only calls in when the link is closed — but
    // assigning over one would strand it exactly as above, and the cost of being sure is one branch.
    if (this.link) await this.link.close('replaced')
    this.link = opened
    // Leftover bytes belong to a session that has ended; carrying them across would put a stale
    // half-frame in front of the first real frame of the new one.
    this.decoder.reset()
    this.greetedMac = null
    this.greetedFw = null
    // A new port is a new dial until proven otherwise; tell it everything.
    this.lastAgentsKey = ''
    this.lastMachinesKey = ''
    this.lastRx = Date.now()
    this.host.log(`cable: open on ${opened.path}`)
  }

  private onClosed(why: string): void {
    this.host.log(`cable: closed (${why})`)
    this.link = null
    this.greetedMac = null
    this.greetedFw = null
    this.lastAgentsKey = ''
    this.lastMachinesKey = ''
    this.voice = null
    // The dial keeps its running image; the half-written slot is erased again by the next accepted offer.
    this.transfer?.finish('interrupted by the port closing')
    this.transfer = null
  }

  // ── inbound ───────────────────────────────────────────────────────────────────────────────────────

  private onBytes(chunk: Buffer): void {
    this.lastRx = Date.now()
    this.decoder.feed(chunk, (frame) => {
      if (frame.type === CableType.Json) {
        let msg: Message
        try {
          msg = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Message
        } catch {
          return // unreadable payloads are counted by the decoder, never fatal
        }
        void this.onMessage(msg)
        return
      }
      if (frame.type === CableType.Log) {
        // The dial's console. It shares its one USB port with this protocol, so these frames are the only
        // way its log survives at all while the daemon holds the port.
        const line = Buffer.from(frame.payload).toString('utf8')
        void appendFile(this.logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {})
        return
      }
      if (frame.type === CableType.Pcm) {
        this.onPcm(Buffer.from(frame.payload))
        return
      }
      // An unknown type is a dial running ahead of this daemon. Visible, never fatal.
      this.host.log(`cable: unknown frame type 0x${frame.type.toString(16)}`)
    })
  }

  private async onMessage(msg: Message): Promise<void> {
    const str = (key: string): string | undefined =>
      typeof msg[key] === 'string' ? (msg[key] as string) : undefined

    switch (msg.t) {
      case 'hello': {
        const mac = str('mac') ?? ''
        // Rule 1: every greeting is answered, but only an unfamiliar dial gets the full state.
        await this.send({
          t: 'welcome',
          proto: CABLE_PROTO_VERSION,
          app: this.host.appName(),
          // The CABLED computer's identity — no longer "the one machine". It was the dial's own mac here
          // until proto 2, which was simply wrong: a mac is not a machine id and nothing could select it.
          machine: this.host.localMachine(),
          // Stated up front so the ✓ is correct from the first frame, before any list arrives — which
          // matters after a dial reboot that lands mid-session on a remote selection.
          selected: this.host.selectedMachine(),
          voiceLang: this.host.voiceLang(),
        })
        // Log a dial that is new OR that came back running something else. The version half of that test
        // is not decoration: a dial reboots into its new image after an update and greets with the SAME
        // mac, so keying the line on the mac alone suppresses the one line anybody wants after an OTA —
        // "it came back, and on which version". Losing it left a successful 0.0.37 install unverifiable
        // from the log on 2026-08-24.
        const fw = str('fw') ?? '?'
        if (mac !== this.greetedMac || fw !== this.greetedFw) {
          const returning = mac === this.greetedMac
          this.greetedMac = mac
          this.greetedFw = fw
          this.host.log(`cable: dial ${mac} ${returning ? 'back ' : ''}on fw ${fw} proto ${msg.proto}`)
          // Both halves of the test above mean the same thing to this line: a dial with nothing on its
          // screen. A repeat greeting from the same dial on the same image is a keepalive and is skipped,
          // which is the whole reason the branch exists.
          await this.pushAgents()
        }
        // Offered on every greeting, but only ONCE per version per session: accepting makes the dial erase
        // a flash slot before it answers, so a cadence of retries would spend erase cycles on the user's
        // hardware every fifteen seconds, and nothing about the next greeting changes what went wrong.
        await this.maybeOfferFirmware(str('fw') ?? '')
        return
      }
      case 'pong':
        return
      case 'agents.list':
        await this.pushAgents()
        return
      case 'machines.list':
        await this.syncMachines(true)
        return
      case 'machine.select':
        await this.selectMachine(str('machineId') ?? '')
        return
      case 'models.list': {
        // The one round trip in this protocol: the dial cannot draw a picker until the catalog is in hand,
        // so it waits on this — briefly, and off its own UI task.
        const agentId = str('agentId') ?? ''
        let items: string[] = []
        try {
          items = await this.host.listModels(agentId)
        } catch (err) {
          this.host.log(`cable: models for ${agentId} failed (${(err as Error).message})`)
        }
        // Answered either way. An empty catalog closes the dial's picker cleanly; silence strands it on a
        // spinner until its own timeout, which reads as a hang rather than "this engine has no choices".
        await this.send({ t: 'models', agentId, items: items.map((id) => ({ id })) })
        return
      }
      case 'focus':
        if (str('agentId')) this.host.focus(str('agentId')!)
        return
      case 'scroll': {
        // Forwarded verbatim, including the reports carrying no travel: the two ends of a stroke are the
        // whole point of the message. A `down` with nothing in it stops a fling still running, and an `up`
        // with nothing in it is a finger that came to rest before it lifted and must not be thrown.
        const phase = str('phase')
        if (phase !== 'down' && phase !== 'move' && phase !== 'up') return
        const dy = typeof msg.dy === 'number' ? msg.dy : 0
        const v = typeof msg.v === 'number' ? msg.v : 0
        this.host.scrolled(phase, dy, v)
        return
      }
      case 'turn.send':
        if (str('agentId') && str('text')) this.host.sendTurn(str('agentId')!, str('text')!)
        return
      case 'turn.stop':
        if (str('agentId')) this.host.stopTurn(str('agentId')!)
        return
      case 'answer': {
        // `answers` is the dial's own object, one entry per question, keyed by the keys WE asked with. It
        // travels verbatim. Until proto 2 this case demanded `{id, optionId}` — a shape the dial has never
        // sent — so every answer from the question screen was silently dropped on the floor.
        const agentId = str('agentId')
        const requestId = str('requestId')
        const answers = msg.answers
        if (agentId && requestId && answers && typeof answers === 'object' && !Array.isArray(answers)) {
          const flat: Record<string, string> = {}
          for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
            if (typeof v === 'string') flat[k] = v
          }
          this.host.answer(agentId, requestId, flat)
        }
        return
      }
      case 'agent.update':
        if (str('agentId')) this.host.updateAgent(str('agentId')!, str('model'), str('effort'))
        return
      case 'voice.begin':
        this.voice = {
          agentId: str('agentId'),
          cmd: str('cmd'),
          lang: str('lang') ?? this.host.voiceLang(),
          // The DIAL's rate, never this side's guess. Describing 8 kHz audio as 16 kHz does not make the
          // speech sound fast — the transcriber is handed a container that lies about itself and answers
          // with nothing at all.
          rate: typeof msg.sr === 'number' && msg.sr > 0 ? msg.sr : DEFAULT_VOICE_RATE,
          chunks: [],
          bytes: 0,
        }
        return
      case 'voice.abort':
        this.voice = null
        return
      case 'voice.end':
        await this.finishVoice()
        return
      case 'voice.confirm':
        if (str('routeId') && str('agentId')) this.host.focus(str('agentId')!)
        return
      case 'fw.accept':
        // The dial has erased its slot and is expecting bytes. Nothing was sent before this.
        await this.transfer?.pump()
        return
      case 'fw.progress':
        // Not only a progress bar: this ack IS the credit that lets the next slices go.
        if (typeof msg.written === 'number') await this.transfer?.onProgress(msg.written)
        return
      case 'fw.done':
        this.transfer?.finish('installed — the dial is rebooting')
        this.transfer = null
        return
      case 'fw.error':
        this.transfer?.finish(`refused: ${str('message') ?? 'no reason given'}`)
        this.transfer = null
        return
      default:
        this.host.log(`cable: unhandled message '${msg.t}'`)
    }
  }

  /** Offer an update if there is one, the dial is not on it, and this session has not tried it already. */
  private async maybeOfferFirmware(runningVersion: string): Promise<void> {
    if (!this.host.firmwareFor || this.transfer || !runningVersion) return
    const candidate = await this.host.firmwareFor(runningVersion).catch(() => null)
    if (!candidate || this.offered.has(candidate.version)) return
    this.offered.add(candidate.version)

    this.host.log(`cable: offering firmware ${candidate.version} (${candidate.image.length} B)`)
    this.transfer = new FirmwareTransfer(
      candidate.image,
      candidate.version,
      async (slice) => {
        if (!this.link?.isOpen) throw new Error('port closed mid-transfer')
        await this.link.write(encodeCableFrame(CableType.Fw, slice))
      },
      (line) => this.host.log(line),
    )
    await this.send({ t: 'fw.offer', version: candidate.version, size: candidate.image.length, sha256: candidate.sha256 })
  }

  private onPcm(chunk: Buffer): void {
    if (!this.voice) return // audio outside a turn is a dial that restarted mid-capture
    this.voice.bytes += chunk.length
    if (this.voice.bytes > VOICE_MAX_BYTES) {
      this.host.log('cable: voice over the length cap, dropped')
      this.voice = null
      return
    }
    this.voice.chunks.push(chunk)
  }

  private async finishVoice(): Promise<void> {
    const turn = this.voice
    this.voice = null
    if (!turn || turn.bytes === 0) {
      await this.send({ t: 'voice.error', message: "Didn't catch that" })
      return
    }

    const seconds = turn.bytes / (turn.rate * 2)
    this.host.log(`cable: voice ${seconds.toFixed(1)}s (${Math.round(turn.bytes / 1024)} KB) → stt`)

    let transcript: string
    try {
      transcript = (await this.host.transcribe(Buffer.concat(turn.chunks), turn.rate, turn.lang)).trim()
    } catch (err) {
      await this.send({ t: 'voice.error', message: (err as Error).message })
      return
    }
    if (!transcript) {
      await this.send({ t: 'voice.error', message: "Didn't catch that" })
      return
    }

    // Named an agent: the dial was on a tile and there is nothing to decide.
    let agentId = turn.agentId
    let agentName = ''
    const agents = await this.host.listAgents()
    if (!agentId) {
      try {
        const decision = await this.host.route(transcript, agents)
        agentId = decision.agentId
        this.host.log(`cable: routed → ${agentId} (${decision.reason})`)
      } catch (err) {
        await this.send({ t: 'voice.error', message: (err as Error).message })
        return
      }
    }
    agentName = agents.find((a) => a.id === agentId)?.name ?? ''

    if (!agentId) {
      await this.send({ t: 'voice.error', message: 'No agent to send that to' })
      return
    }
    const text = turn.cmd ? `/${turn.cmd} ${transcript}` : transcript
    this.host.sendTurn(agentId, text)
    await this.send({ t: 'voice.transcript', routeId: '', text: transcript, agentId, agentName, needsConfirm: false })
  }

  // ── outbound ──────────────────────────────────────────────────────────────────────────────────────

  private async send(msg: Message): Promise<boolean> {
    if (!this.link?.isOpen) return false
    try {
      await this.link.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8')))
      return true
    } catch (err) {
      this.host.log(`cable: write failed (${(err as Error).message})`)
      await this.link.close('write failed')
      return false
    }
  }

  /**
   * Push the agent list, STREAMED — begin, one message per agent, end.
   *
   * A frame is capped at 8 KB and a hundred agents do not fit in it. One agent per message needs no chunk
   * arithmetic on either side and bounds the message length by construction rather than by hoping the
   * names stay short.
   */
  /** What the dial has been told, as one comparable string. */
  private static agentsKey(agents: CableAgent[]): string {
    return agents.map((a) => `${a.id}:${a.name}:${a.engine ?? ''}:${a.model ?? ''}:${a.effort ?? ''}`).join('|')
  }

  /**
   * Send the agent list IF it differs from what the dial was last told.
   *
   * Called on attach and on every tick. The tick is not belt-and-braces: the list can be wrong through no
   * fault of the dial — a daemon restarting answers `hello` before its registry has finished loading, and
   * the honest answer at that instant is "no agents". Something has to say the true one a second later.
   */
  async syncAgents(force = false): Promise<void> {
    return this.queued(() => this.syncAgentsNow(force))
  }

  private async syncAgentsNow(force: boolean): Promise<void> {
    const agents = await this.host.listAgents()
    const key = CableSession.agentsKey(agents)
    if (!force && key === this.lastAgentsKey) return
    this.lastAgentsKey = key
    // Every push, and only pushes. The dial showing a different number from the daemon is a question this
    // line answers in one look: either the daemon never said it, or it said it and the dial disagreed.
    this.host.log(`cable: agents → ${agents.length}${force ? ' (attach)' : ''}`)

    await this.send({ t: 'agents.begin' })
    for (const a of agents) {
      await this.send({ t: 'agent', id: a.id, name: a.name, engine: a.engine ?? '', model: a.model ?? '', effort: a.effort ?? '' })
    }
    await this.send({ t: 'agents.end' })
  }

  /**
   * What each agent was last doing.
   *
   * A tile with a name and no recap has forgotten the work it belongs to, and that is what a dial shows
   * every time it is replugged or the daemon restarts — the summaries were on disk the whole time, nobody
   * had sent them.
   *
   * `restore: true` is the load-bearing part: history, not news. No beep, no notification, no busy state.
   * Without it, plugging the cable in announces every turn that finished while it was unplugged.
   *
   * Sent on attach only. The list is re-sent whenever it changes; the history behind it does not, or every
   * rename would replay a week of recaps.
   */
  async pushRestores(): Promise<void> {
    return this.queued(() => this.pushRestoresNow())
  }

  private async pushRestoresNow(): Promise<void> {
    for (const a of await this.host.listAgents()) {
      const past = await this.host.recentSummaries(a.id)
      // Oldest first, so the newest ends up on top of the tile's stack.
      for (const s of [...past].reverse()) {
        if (!s.recap && !s.text) continue
        await this.send({ t: 'summary', agentId: a.id, recap: s.recap, text: s.text, restore: true })
      }
    }
  }

  /** Attach: tell the dial everything, whether or not any of it looks unchanged from here. */
  async pushAgents(): Promise<void> {
    await this.syncMachines(true)
    await this.syncAgents(true)
    await this.pushRestores()
  }

  // ── machines ──────────────────────────────────────────────────────────────────────────────────────

  /** What the dial has been told about the wheel, as one comparable string. Order counts: it is render
   *  order, so two lists that differ only by a swap are a real change. */
  private static machinesKey(machines: CableMachine[], source: string, selected: string): string {
    return `${source}|${selected}|${machines
      .map((m) => `${m.id}:${m.name}:${m.state}:${m.local ? 1 : 0}`)
      .join('|')}`
  }

  /**
   * Push the machine wheel IF it differs from what the dial was last told.
   *
   * The diff is not an optimisation. `ui_local_machine_set` on the dial once rebuilt its wheel on every
   * arriving greeting, on the USB reader task, and that measured out at 31 session restarts an hour with
   * the agent list wiped each time — the screen sat on "0 agents" while the daemon believed it had said
   * otherwise. The dial hashes the rows again on its side; this is the half that stops the bytes leaving.
   */
  async syncMachines(force = false): Promise<void> {
    return this.queued(() => this.syncMachinesNow(force))
  }

  private async syncMachinesNow(force: boolean): Promise<void> {
    const { machines, source } = await this.host.listMachines()
    const selected = this.host.selectedMachine()
    const key = CableSession.machinesKey(machines, source, selected)
    if (!force && key === this.lastMachinesKey) return
    this.lastMachinesKey = key
    this.host.log(`cable: machines → ${machines.length} (${source})${force ? ' [push]' : ''}`)

    await this.send({ t: 'machines.begin' })
    for (const m of machines) {
      await this.send({ t: 'machine', id: m.id, name: m.name, state: m.state, local: m.local })
    }
    await this.send({ t: 'machines.end', selected, source })
  }

  /**
   * Switch the dial to another machine.
   *
   * Always answered, including for the machine already selected: silence strands the dial on a spinner
   * until its own deadline, which reads as a hang rather than as "done, nothing changed" — the same rule
   * `models.list` follows.
   */
  private async selectMachine(machineId: string): Promise<void> {
    if (!machineId) return
    if (machineId === this.host.selectedMachine()) {
      await this.send({ t: 'machine.selected', machineId })
      await this.syncAgents(true)
      await this.pushRestores()
      return
    }
    const result = await this.host.selectMachine(machineId)
    if (!result.ok) {
      this.host.log(`cable: machine.select ${machineId} refused (${result.code})`)
      await this.send({ t: 'machine.error', machineId, code: result.code, message: result.message })
      return
    }
    this.host.log(`cable: machine.select → ${machineId}`)
    // REQUIRED, not hygiene: two machines whose agents happen to share names and engines produce an equal
    // agentsKey, and the new machine's list would then never be sent at all.
    this.lastAgentsKey = ''
    await this.send({ t: 'machine.selected', machineId })
    await this.syncAgents(true)
    await this.pushRestores()
    await this.syncMachines(true)   // the ✓ moved, and the agent counts with it
  }

  /** One row changed — liveness, a rename, a count. Cheaper than re-streaming the wheel. */
  async machineState(machine: CableMachine): Promise<void> {
    await this.send({ t: 'machine.updated', id: machine.id, name: machine.name, state: machine.state, local: machine.local })
  }

  // Turn state is UNSOLICITED: the daemon reports every turn in every agent, including ones started at the
  // keyboard. A dial that only saw answers to its own sends would sit idle through most of what the
  // machine actually does.
  /**
   * `text` is the status line the tile draws — "Working…", the tool that is running, what it is waiting on.
   * It travels because without it the dial gets a card with a state and nothing to render: the tile knows
   * a turn is live and shows the user nothing that says so.
   */
  async turnStarted(agentId: string, text = ''): Promise<void> {
    await this.send({ t: 'turn.started', agentId, text })
  }
  async turnDone(agentId: string): Promise<void> {
    await this.send({ t: 'turn.done', agentId })
  }
  async summary(agentId: string, recap: string, text: string): Promise<void> {
    await this.send({ t: 'summary', agentId, recap, text })
  }
  async turnError(agentId: string, message: string): Promise<void> {
    await this.send({ t: 'turn.error', agentId, message })
  }
  async question(agentId: string, id: string, questions: unknown): Promise<void> {
    await this.send({ t: 'question', agentId, id, questions })
  }
  async focusAgent(agentId: string): Promise<void> {
    await this.send({ t: 'focus', agentId })
  }
  async toast(text: string): Promise<void> {
    await this.send({ t: 'toast', text })
  }
}
