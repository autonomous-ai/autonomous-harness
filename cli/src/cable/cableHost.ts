// Everything the cable session needs from the rest of the daemon, in one place.
//
// The session owns the protocol and nothing else; this owns the answers. Keeping them apart is what lets
// the protocol be tested against a fake host — the alternative is a suite that needs tmux, a microphone
// and a network to prove that `hello` gets a `welcome`.
//
// Nothing here is new machinery. The agent list is the registry the web and the backend socket already
// read, the router is the one the backend already calls for remote machines, and the turn events arrive
// as the very `commander_event` cards the WiFi device receives — teed at the socket rather than emitted
// again here, so the two device surfaces cannot drift.
import { join } from 'node:path'

import { AuthSessionManager, readAuthSession } from '../lib/authSession.js'
import { registry, projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { fetchRelease, loadImage, shouldOffer } from './fwPush.js'
import { routeVoiceTask, type RouterAgent } from '../lib/voiceRouter.js'
import { env } from '../config/env.js'

import type { CableAgent, CableHost, CableMachine, CableMachineSource, RouteDecision } from './cableSession.js'
import { FleetError, type FleetMachine, type MachineFleet } from './machineFleet.js'

/** One completed turn's recap, as the mirror keeps them. */
export interface RecentTurn {
  recap?: string
  text?: string
}

export interface CableHostWiring {
  machineName: () => string
  /** This computer's machineId, or '' when the daemon has never resolved one (signed out). */
  machineId: () => string
  /** A stable id for this computer, used to name the local row when there is no machineId yet. */
  computerId: () => string
  /** Deliver text into an agent. The SAME path the web and the WiFi device use — see cli.ts. */
  sendTurn: (agentId: string, text: string) => void
  stopTurn: (agentId: string) => void
  answer: (agentId: string, requestId: string, answers: Record<string, string>) => void
  /** Recaps of an agent's last `n` completed turns — for routing, and for redrawing a reattached dial. */
  recent: (agentId: string, n: number) => RecentTurn[]
  /** The opaque runtime-v1 profile, which is where the dial's Model/Effort chips come from. */
  runtimeProfile?: (session: RegisteredSession) => string | null
  updateAgent?: (agentId: string, model?: string, effort?: string) => void
  /** The runtime catalog, from the same provider the web and the WiFi device read. */
  listModels?: (agentId: string) => Promise<Array<{ id: string }>>
  /** The dial moved to another agent — the desktop window should show that one. */
  focused?: (agentId: string) => void
  /** A finger on the dial's glass, in pieces, while it is down. */
  scrolled?: (phase: 'down' | 'move' | 'up', dy: number, velocity: number) => void
  log: (line: string) => void
}

/**
 * A placeholder id for a machine this daemon does not know the real id of.
 *
 * A BELT, not a mode. `harness start` refuses to run without an SSO session and awaits
 * `resolveComputerMachine()` before it spawns the daemon, so by the time anything here runs the machineId
 * is real. The guard exists because the alternative failure is silent: an empty id makes a row that
 * renders, is tappable, and can never be selected. `cable:` is deliberately not machineId-shaped, so
 * nothing downstream mistakes it for one and announces it to the backend.
 */
function placeholderId(computerId: string): string {
  return `cable:${computerId}`
}

/** How often another machine's agent list is re-asked. Far slower than the dial's one-second tick: the
 *  list changes when a person starts an agent, not continuously. */
const REMOTE_REFRESH_MS = 5_000
/** How long a machine's last good list survives failures before its tiles leave the carousel. */
const REMOTE_GRACE_MS = 30_000

/** Whether an id is that placeholder rather than a machine the backend has heard of. */
function isPlaceholder(id: string): boolean {
  return id.startsWith('cable:')
}

/** A fleet row as the wire carries it. `authMode` does not travel: the dial has no use for the word, and
 *  `remote` is just `!local`, which the row already says. */
function toCableMachine(m: FleetMachine): CableMachine {
  return { id: m.machineId, name: m.name, state: m.state, local: false }
}

/** Split `runtime-v1:<sid>:<engine>:<model>@<effort>` back into the two words the dial's chips show. */
function chipsFromProfile(profile: string | null | undefined): { model?: string; effort?: string } {
  if (!profile || !profile.startsWith('runtime-v1:')) return {}
  const tail = profile.split(':').slice(3).join(':')
  if (!tail) return {}
  const [model, effort] = tail.split('@')
  return { model: model || undefined, effort: effort || undefined }
}

export class DaemonCableHost implements CableHost {
  /**
   * The machine whose agents are on the dial right now. Defaults to — and falls back to — the local one:
   * it is the only machine that is certainly reachable, so it is the honest thing to land on.
   *
   * Held in memory only. The dial deliberately does not remember a selection across its own reboot (a
   * restored id is meaningless until you know whose computer the cable is in), and this side does not
   * remember across a daemon restart either — that is when the registry reloads anyway.
   */
  private selected = ''

  /** Each other machine's agents, as last read. `asked` throttles the round; `at` ages the answer. */
  private readonly remoteAgents = new Map<string, { agents: CableAgent[]; at: number; asked: number }>()
  /** Machines with a list RPC in flight, so a slow machine is asked once rather than every tick. */
  private readonly inFlight = new Set<string>()
  /** agentId → machineId, rebuilt from the snapshot last handed to the dial. */
  private agentMachine = new Map<string, string>()

  /** `undefined` = no lane to any other machine exists; the wheel is the local row and nothing else. */
  constructor(private readonly wiring: CableHostWiring, private readonly fleet?: MachineFleet) {}

  /** The identity of the computer at the other end of the cable. */
  localMachine(): { id: string; name: string } {
    return { id: this.localId(), name: this.wiring.machineName() }
  }

  private localId(): string {
    return this.wiring.machineId() || placeholderId(this.wiring.computerId())
  }

  /** Whether the dial is looking at THIS computer. Everything forks on this one question. */
  isLocalSelected(): boolean {
    return this.selectedMachine() === this.localId()
  }

  selectedMachine(): string {
    return this.selected || this.localId()
  }

  async listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }> {
    const local: CableMachine = {
      id: this.localId(),
      // The machine's own name. What makes this row recognisable as the cabled one is its second line,
      // which the dial writes — see machine_meta_line.
      name: this.wiring.machineName(),
      // Always ready: the cable IS the evidence. Nothing else on this list can say that about itself.
      state: 'ready',
      local: true,
    }
    if (!this.fleet) return { machines: [local], source: 'signed-out' }
    const { machines, source } = await this.fleet.list()
    const rows: CableMachine[] = [local]
    for (const m of machines) {
      // The backend list contains THIS computer too. Dropped rather than rendered: the same machine on
      // the wheel twice, under two names, with the ✓ able to mark only one of them. Its name is already
      // here anyway — MACHINE_NAME_FILE is mirrored from the backend on every connect.
      if (m.machineId === local.id) continue
      rows.push(toCableMachine(m))
    }
    return { machines: rows, source }
  }

  async selectMachine(machineId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (machineId === this.localId()) {
      this.selected = machineId
      // Let go of the REMOTE machine after a linger, keeping the socket — then announce where the dial
      // actually is. `activeMachineId` on the account is then true for this machine too, instead of
      // silently going stale on whatever was selected last.
      this.fleet?.release()
      void this.announceSelection()
      return { ok: true }
    }
    if (!this.fleet) {
      return { ok: false, code: 'UNAVAILABLE', message: 'Sign in on this computer to reach other machines' }
    }
    try {
      await this.fleet.select(machineId)
    } catch (err) {
      if (err instanceof FleetError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'UNREACHABLE', message: (err as Error).message }
    }
    this.selected = machineId
    return { ok: true }
  }

  /**
   * The dial is on the wire again.
   *
   * If it left looking at another machine, the cloud lane has to be back UP before the state push that
   * follows — that push calls listAgents(), which for a remote machine is an RPC over exactly this lane.
   * Awaiting it here would block the greeting, so it is fired and the push retries on the next tick if
   * it loses the race; a failure marks the machine unreachable rather than pretending it has no agents.
   */
  onDialAttached(): void {
    if (!this.fleet) return
    const fleet = this.fleet
    this.wiring.log('cable: dial on the wire — opening the cloud lane')
    void (async () => {
      // The socket first, and unconditionally: it is what makes the machine wheel's dots live, and it is
      // held for as long as the dial is plugged in whether or not anything is selected.
      await fleet.online()
      await this.announceSelection()
    })().catch((err) => this.wiring.log(`cable: could not open the lane (${(err as Error).message})`))
  }

  /**
   * Tell the backend which machine the dial is on.
   *
   * Sent for the LOCAL machine too. It costs one frame and it is the only thing that makes
   * `DeviceBinding.activeMachineId` true rather than "whatever was selected last" — which is what the web
   * and the mobile app read to say where a dial is.
   *
   * Skipped only for the placeholder id, which is not a machineId and means nothing to the backend.
   */
  private async announceSelection(): Promise<void> {
    if (!this.fleet) return
    const machineId = this.selectedMachine()
    if (isPlaceholder(machineId)) return
    try {
      await this.fleet.select(machineId)
    } catch (err) {
      // Never fatal. The local machine in particular must stay usable with no backend at all — it is the
      // one machine the cable can vouch for on its own.
      this.wiring.log(`cable: could not announce ${machineId} (${(err as Error).message})`)
    }
  }

  /**
   * The dial is gone — cable pulled, or the far end stopped answering.
   *
   * Drop the lane NOW rather than lingering. The daemon holds it on the dial's behalf and nothing else in
   * this process uses it, so keeping it open leaves the account showing a device attached to a machine
   * while the dial sits unplugged in a drawer — and every card that machine produces would be relayed to
   * a screen that is not there.
   */
  onDialGone(): void {
    this.fleet?.release(true)
  }

  machineName(): string {
    return this.wiring.machineName()
  }

  appName(): string {
    return 'harness'
  }

  voiceLang(): string {
    // A PROPOSAL, not a decision. The dial keeps its own choice in NVS and states it on every capture —
    // the person holding it may well speak something other than this laptop is set to.
    const locale = process.env.LANG ?? ''
    return locale.startsWith('vi') ? 'vi' : 'en'
  }

  /** This computer's own agents, in the order every other surface reads them in. */
  private localAgents(): CableAgent[] {
    // `active()`, not `list()` — the SAME set `agents_list` answers the web and the desktop app with. They
    // read one registry and must not disagree about what is on it: a dead agent holding a tile on the dial
    // and nowhere else is a tile that cannot be driven and cannot be explained.
    const sessions = registry.active()
    // Oldest → newest, and TOTAL: the id breaks a tie so the order cannot fall through to array position,
    // which is Map insertion order and differs between daemon runs. Both producers sort identically, so
    // the dial and the app cannot drift apart while reading the same registry.
    sessions.sort((a, b) => a.registeredAt - b.registeredAt || a.agentId.localeCompare(b.agentId))
    const machineId = this.localId()
    const machine = this.wiring.machineName()
    return sessions.map((s) => ({
      id: s.agentId,
      name: projectDisplayName(s),
      engine: s.engine ?? '',
      machineId,
      machine,
      ...chipsFromProfile(this.wiring.runtimeProfile?.(s)),
    }))
  }

  /**
   * EVERY agent on EVERY machine, in the order the desktop app's rail reads them: this computer first,
   * then each other machine in wheel order, and within a machine whatever order that machine returns.
   *
   * Read from a CACHE, never from a live RPC. This is called on the session's one-second tick, and a
   * naive implementation would fire one cloud round trip per machine per second — the dial would spend
   * its whole life waiting on the network to answer a question whose answer changes every few minutes.
   * `refreshRemotes()` does the asking, off to the side, on its own slower clock.
   */
  async listAgents(): Promise<CableAgent[]> {
    const out = this.localAgents()
    const { machines } = await this.listMachines()
    for (const m of machines) {
      if (m.local) continue
      const entry = this.remoteAgents.get(m.id)
      if (entry) for (const a of entry.agents) out.push({ ...a, machineId: m.id, machine: m.name })
    }
    void this.refreshRemotes(machines)
    // Rebuilt from the SAME snapshot that is about to be pushed, so the map can never name a machine an
    // agent has already left. Every action the dial can take is routed through it.
    const next = new Map<string, string>()
    for (const a of out) if (a.machineId) next.set(a.id, a.machineId)
    this.agentMachine = next
    return out
  }

  /**
   * Which machine an agent lives on, or '' if the dial named one this daemon has never listed.
   *
   * NEVER falls back to the selected machine. A wrong answer here does not fail — it delivers the user's
   * turn to a different computer, which is the worst outcome this whole feature can produce.
   */
  private machineOf(agentId: string): string {
    return this.agentMachine.get(agentId) ?? ''
  }

  /** True when the agent belongs to this computer (or is unknown, which is handled at the call site). */
  private isLocalAgent(agentId: string): boolean {
    const machineId = this.machineOf(agentId)
    return !machineId || machineId === this.localId()
  }

  /**
   * Refresh the other machines' agent lists, on their own clock.
   *
   * Only `ready` machines are asked. An offline one has nothing to say and an unlinked one cannot be
   * read at all (no pinned key), and asking either costs a 15-second RPC timeout per machine per round.
   *
   * A machine that fails keeps its LAST GOOD list for `REMOTE_GRACE_MS` and only then goes empty. A cloud
   * blip is the common case, and dropping every one of a machine's tiles off the carousel for a few
   * seconds — then putting them back — is a far worse lie than briefly showing a list that is a minute
   * old.
   */
  private refreshRemotes(machines: CableMachine[]): void {
    if (!this.fleet) return
    const now = Date.now()
    for (const m of machines) {
      if (m.local) continue
      const entry = this.remoteAgents.get(m.id)
      if (m.state !== 'ready') {
        // Not an error and not worth a grace period: the machine itself says it has nothing to offer.
        if (entry && entry.agents.length) this.remoteAgents.set(m.id, { agents: [], at: now, asked: entry.asked })
        continue
      }
      if (entry && now - entry.asked < REMOTE_REFRESH_MS) continue
      if (this.inFlight.has(m.id)) continue
      this.inFlight.add(m.id)
      this.remoteAgents.set(m.id, { agents: entry?.agents ?? [], at: entry?.at ?? 0, asked: now })
      void this.fleet.listAgents(m.id)
        .then((agents) => {
          const before = this.remoteAgents.get(m.id)
          this.remoteAgents.set(m.id, { agents, at: Date.now(), asked: Date.now() })
          // One line per TRANSITION, not per round: this runs every few seconds forever, and a healthy
          // machine that logs each time buries everything else in the file.
          if (!before || before.agents.length !== agents.length) {
            this.wiring.log(`cable: ${m.name} → ${agents.length} agents`)
          }
        })
        .catch((err) => {
          const before = this.remoteAgents.get(m.id)
          const stale = before && Date.now() - before.at > REMOTE_GRACE_MS
          if (stale) this.remoteAgents.set(m.id, { agents: [], at: Date.now(), asked: Date.now() })
          if (before?.agents.length && stale) {
            this.wiring.log(`cable: ${m.name} dropped off the carousel (${(err as Error).message})`)
          }
        })
        .finally(() => this.inFlight.delete(m.id))
    }
  }

  sendTurn(agentId: string, text: string): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.sendTurn(this.machineOf(agentId), agentId, text); return }
    this.wiring.sendTurn(agentId, text)
  }

  stopTurn(agentId: string): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.stopTurn(this.machineOf(agentId), agentId); return }
    this.wiring.stopTurn(agentId)
  }

  answer(agentId: string, requestId: string, answers: Record<string, string>): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.answer(this.machineOf(agentId), agentId, requestId, answers); return }
    this.wiring.answer(agentId, requestId, answers)
  }


  focus(agentId: string): void {
    // A statement about where the user is looking, and the desktop window follows it: turning the dial to
    // an agent switches the terminal on screen to the same one. The daemon still has no window of its own
    // — it forwards, and the app decides what following means for it.
    // FORWARDED FOR EVERY AGENT, including one running on another computer. That used to be refused on
    // the grounds that there was no window here to move — which stopped being true when the desktop app
    // grew panes for remote machines. The hand is still at THIS desk; the pane it wants in front of it
    // may simply belong to a machine somewhere else, and the app is the side that decides what it can do
    // about an agent it does not have.
    this.wiring.log(`cable: focus ${agentId}`)

    this.wiring.focused?.(agentId)
  }

  scrolled(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void {
    // THE ENDS ARE LOGGED, THE MIDDLE IS NOT. A stroke is a `down`, a dozen `move`s and an `up`, several
    // times a second: logging the middle buries every other line in the file. But the failure this
    // protocol is most exposed to is a stroke that never CLOSES — the far side then holds a drag forever
    // and its list stops answering the mouse — and that failure is invisible without a matching pair to
    // look for. Two lines per swipe buys the one thing worth seeing.
    if (phase !== 'move') {

      this.wiring.log(phase === 'down' ? 'cable: scroll ↓' : `cable: scroll ↑ (v=${velocity})`)
    }
    this.wiring.scrolled?.(phase, dy, velocity)
  }

  updateAgent(agentId: string, model?: string, effort?: string): void {
    if (!this.isLocalAgent(agentId)) { this.fleet!.updateAgent(this.machineOf(agentId), agentId, model, effort); return }
    this.wiring.updateAgent?.(agentId, model, effort)
  }

  /** The last few turns, newest first, in the shape the dial's tile draws: a headline and a body. */
  async recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string }>> {
    const raw = this.isLocalAgent(agentId)
      ? this.wiring.recent(agentId, 3)
      : await this.fleet!.recentSummaries(this.machineOf(agentId), agentId)
    return raw.map((r) => ({ recap: r?.recap ?? '', text: r?.text ?? '' })).filter((s) => s.recap || s.text)
  }

  async listModels(agentId: string): Promise<string[]> {
    if (!this.isLocalAgent(agentId)) return this.fleet!.listModels(this.machineOf(agentId), agentId)

    const models = (await this.wiring.listModels?.(agentId)) ?? []
    return models.map((m) => m.id).filter(Boolean)
  }

  /**
   * The image to offer, or null for "nothing to do".
   *
   * Null covers three different situations on purpose, because the dial reacts to all of them the same
   * way — by carrying on: the dial is current, it is running a dev build that must not be touched, or the
   * manifest is unreachable. An update is an opportunity here, never a condition of working.
   */
  async firmwareFor(runningVersion: string): Promise<{ version: string; image: Buffer; sha256: string } | null> {
    if (env.CABLE_FW_DISABLE) return null
    const release = await fetchRelease(env.CABLE_FW_MANIFEST_URL)
    if (!release || !shouldOffer(runningVersion, release.version)) return null
    const image = await loadImage(release, join(env.ADAPTER_DATA_DIR, 'firmware'))
    if (!image) return null
    return { version: release.version, image, sha256: release.sha256 }
  }

  /**
   * Which agent the spoken words belong to.
   *
   * The daemon's own router: it scores by name and recent activity, and classifies with an engine CLI the
   * machine is ALREADY running when the score cannot separate the top two. No key, no relay, no network —
   * which is the whole reason voice on the cable does not inherit the hosted path's failure modes.
   */
  async route(transcript: string, agents: CableAgent[]): Promise<RouteDecision> {
    // Each agent's recaps come from ITS OWN machine — recentSummaries routes by agentId. Scored against
    // the wrong machine's history, a spoken turn is routed by what some other computer's agents were last
    // doing, which is both wrong and completely invisible, because the router always answers with
    // something. The machine name travels too, so two agents with the same name on two computers are
    // distinguishable by the only thing that separates them.
    const candidates: RouterAgent[] = await Promise.all(agents.map(async (a) => ({
      id: a.id,
      name: a.name,
      engine: a.engine,
      machine: a.machine,

      recentSummary: (await this.recentSummaries(a.id))
        .map((r) => r.recap || r.text || '')
        .filter(Boolean)
        .join(' · '),
    })))
    const decision = await routeVoiceTask(transcript, candidates)
    return { agentId: decision.agentId, confidence: decision.confidence, reason: decision.reason }
  }

  /**
   * Transcribe one capture.
   *
   * The dial records and the daemon transcribes. The device holds no cloud credential and never talks to
   * one; THIS side has an account — `harness login` leaves a real SSO session behind, and the endpoint is
   * gated by it like every other control-plane call.
   *
   * No shared secret, deliberately. This repository is public, so a key baked into it is a key everybody
   * has; a bearer token is issued per person, expires on its own and can be revoked.
   *
   * The 401 retry is not defensive padding. A token can expire between the moment the user pressed the
   * dial's button and the moment the upload finishes — a long dictation is minutes — and losing a spoken
   * sentence to a clock is the one failure the person cannot work around.
   */
  async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
    const session = readAuthSession()
    if (!session) throw new Error('Voice needs a signed-in harness — run `harness login`')

    const auth = new AuthSessionManager(this.backendHttpBase())
    const url = `${this.backendHttpBase()}${env.CABLE_STT_PATH}?lang=${encodeURIComponent(lang)}`
    // The WAV is built ONCE: it is the same bytes on a retry, and re-encoding megabytes to say the same
    // thing twice is time taken out of a person's turn.
    const boundary = `harness-${Math.random().toString(36).slice(2)}`
    const body = multipart(wav(pcm, sampleRate), 'voice.wav', 'audio/wav', boundary)

    const post = async (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autonomous-env': session.autonomousEnv,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      })

    let token = await auth.accessToken()
    let res = await post(token)
    if (res.status === 401) {
      // `failedToken` is what makes this one refresh rather than a loop: the manager only refreshes when
      // the token that failed is still the current one, so two callers racing a stale token do not each
      // burn a refresh.
      token = await auth.accessToken({ failedToken: token })
      res = await post(token)
    }
    if (!res.ok) throw new Error(`Transcription failed (HTTP ${res.status})`)

    const json = (await res.json()) as { success?: boolean; data?: { transcript?: string }; error?: { message?: string } }
    if (!json.success) throw new Error(json.error?.message ?? 'Transcription failed')
    return json.data?.transcript ?? ''
  }

  /** The control plane, derived from the socket URL the daemon already talks to. */
  private backendHttpBase(): string {
    return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  }

  log(line: string): void {
    this.wiring.log(line)
  }
}

/**
 * Wrap raw 16-bit little-endian mono PCM in a WAV header.
 *
 * A self-describing container rather than raw samples, and the server depends on it: it forwards the file
 * under its own Content-Type with NO encoding or sample-rate hints, precisely so the container can state
 * its own rate. Headerless PCM would be read as if the first 44 bytes were audio.
 */
export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate: rate * channels * 2
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * One file as multipart/form-data, in the shape the endpoint's `req.file()` expects.
 *
 * Every newline is CRLF: the format requires it, and a bare \n produces a body some parsers accept and
 * Fastify's does not — surfacing as "Missing audio file" for a request that plainly contains one.
 */
export function multipart(file: Buffer, filename: string, mimeType: string, boundary: string): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  )
  return Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')])
}

/**
 * Translate one device-bound `commander_event` into the cable's vocabulary.
 *
 * Returns null for cards the dial has no use for. The kinds are the WiFi device's own, unchanged: a new
 * kind reaches the cable the day it reaches the socket.
 */
export function cableEventFor(
  frame: { type?: string; agentId?: string; payload?: { kind?: string; text?: string; recap?: string } },
): { kind: 'processing' | 'done' | 'summary' | 'error'; agentId: string; text: string; recap: string } | null {
  if (frame.type !== 'commander_event' || !frame.agentId) return null
  const kind = frame.payload?.kind
  if (kind !== 'processing' && kind !== 'done' && kind !== 'summary' && kind !== 'error') return null
  return { kind, agentId: frame.agentId, text: frame.payload?.text ?? '', recap: frame.payload?.recap ?? '' }
}

/**
 * Translate one device-bound `commander_question` into the dial's `question`.
 *
 * A sibling of `cableEventFor` rather than a branch inside it, because the shapes have nothing in common
 * — this one carries a requestId and an option list, not a card. Until this existed the dial's whole
 * question screen was complete, wired and unreachable: nothing on this side ever produced the message.
 */
export function cableQuestionFor(
  frame: { type?: string; agentId?: string; payload?: { requestId?: string; questions?: unknown } },
): { agentId: string; requestId: string; questions: unknown } | null {
  if (frame.type !== 'commander_question' || !frame.agentId) return null
  const requestId = frame.payload?.requestId
  const questions = frame.payload?.questions
  if (typeof requestId !== 'string' || !requestId || !Array.isArray(questions)) return null
  return { agentId: frame.agentId, requestId, questions }
}
