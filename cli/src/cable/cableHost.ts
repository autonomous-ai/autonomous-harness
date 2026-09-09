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
import { deskRing, type DeskEdge } from './deskRing.js'
import { join } from 'node:path'

import { AuthSessionManager, readAuthSession } from '../lib/authSession.js'
import { registry, projectDisplayName, type RegisteredSession } from '../lib/registry.js'
import { fetchRelease, loadImage, shouldOffer } from './fwPush.js'
import { routeVoiceTask, type RouterAgent, type RouterContinuity } from '../lib/voiceRouter.js'
import { env } from '../config/env.js'

import type { CableAgent, CableHost, CableMachine, CableMachineSource, RouteDecision } from './cableSession.js'
import type { WindowRoute } from './windowRoute.js'
import { FleetError, type FleetMachine, type MachineFleet } from './machineFleet.js'

/** One completed turn's recap, as the mirror keeps them. */
export interface RecentTurn {
  recap?: string
  text?: string
  /** What the USER asked on that turn. The topic lives here; the recap holds the answer. */
  ask?: string
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
  /** The dial moved to another agent — the desktop window should show that agent on its own machine. */
  focused?: (machineId: string, agentId: string, edge?: DeskEdge) => void
  /** A notification was tapped: the window gives that agent a tile of its own. */
  opened?: (machineId: string, agentId: string) => void
  /** A finger on the dial's glass, in pieces, while it is down. */
  scrolled?: (phase: 'down' | 'move' | 'up', dy: number, velocity: number) => void
  /** Offer a spoken task to the desktop window's palette. Omitted when there is no window plumbing. */
  routeInWindow?: (text: string, cmd?: string) => Promise<WindowRoute>
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
  /** The last turn this daemon delivered, for [lastRouted]. In memory only: a conversation that spans a
   *  daemon restart is not one the five-minute window would have carried anyway. */
  private lastTurn?: { agentId: string; at: number }

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
    // `advertised()`, not `list()` — the SAME set `agents_list` answers the web and the desktop app with. They
    // read one registry and must not disagree about what is on it: a dead agent holding a tile on the dial
    // and nowhere else is a tile that cannot be driven and cannot be explained.
    const sessions = registry.advertised()
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
  /**
   * The window's tiles, in tile order. Empty until the app says otherwise, and
   * empty is meaningful: with no tiles the ring is just the flat list.
   */
  private desk: string[] = []

  /** Which edge of the desk an off-desk agent belongs to. Rebuilt with the ring. */
  private deskEdge = new Map<string, DeskEdge>()

  /**
   * Every agent this daemon has listed since it started, by id.
   *
   * Kept for ONE purpose: a tile open in the window must always be a tile on the dial. A machine can
   * leave the list for reasons that have nothing to do with its agents — the backend going quiet, the
   * machine going offline while its work stays on screen — and a desk with a hole in it makes a swipe
   * skip a tile and an agent chosen in the window have nowhere to land.
   */
  private knownAgents = new Map<string, CableAgent>()

  /** Tiles currently held on the ring from that memory, so it is logged once and not every tick. */
  private deskHeld = new Set<string>()

  /** Last logged shape of the ring, so the line above prints on change only. */
  private deskShape = ''

  /**
   * The window changed which agents have a tile, or what order they are in.
   *
   * Order is the payload, not just membership: the dial walks the same grid the
   * eyes are on, so the tiles come first in the carousel and in their own order.
   */
  setDesk(agentIds: string[]): void {
    this.desk = [...agentIds]
  }

  async listAgents(): Promise<CableAgent[]> {
    const out = await this.listAgentsFlat()

    const ring = deskRing(out.map((a) => a.id), this.desk)
    this.deskEdge = ring.edgeOf
    // Walked agents first, then the ones the dial knows but does not walk to —
    // the session sends the count of the first group, so the order is the split.
    const listed = [...ring.order, ...ring.offRing]
    // One line per CHANGE. The failure this catches is silent by nature: tiles
    // whose ids this daemon does not know leave the ring flat and every agent
    // edgeless, which looks exactly like the feature not being installed.
    const onDesk = new Set(this.desk)
    const short = (id: string) => `${onDesk.has(id) ? '*' : ''}${id.slice(0, 4)}`
    // Both halves: what the thumb walks, and what the dial merely knows. Reading
    // only the first half is how "the dial says 5 agents" looked like a counting
    // bug rather than a list that had been cut in two.
    const shape = ring.order.map(short).join(' ')
      + (ring.offRing.length ? ` · off-ring ${ring.offRing.map(short).join(' ')}` : '')
    if (shape !== this.deskShape) {
      this.deskShape = shape
      // The WHOLE ring, marked: `*` is a tile. Short of this the shape has to be
      // guessed from behaviour, and every guess so far has been wrong about
      // which end the agents nobody stepped onto ended up at.
      this.wiring.log(`cable: ring ${shape}`)
    }
    const offRing = new Set(ring.offRing)
    const byId = new Map(out.map((a) => [a.id, a]))
    return listed
      .map((id) => byId.get(id))
      .filter((a): a is CableAgent => !!a)
      .map((a) => (offRing.has(a.id) ? { ...a, offRing: true } : a))
  }

  /**
   * The same agents in LIST order — this computer first, then each machine in wheel order — with no ring
   * laid over them.
   *
   * It is the order the desktop app's rail draws, and the two must not drift: ⌘K reads this to decide
   * which agents a typed task is weighed against, and a person looking at their rail while they type has
   * every right to expect "the first fifteen" to mean the first fifteen they can see. `listAgents()` is
   * the DIAL's view of the same snapshot — the same agents, re-cut around the tiles the window has open,
   * which is a different question with a different right answer.
   */
  async listAgentsFlat(): Promise<CableAgent[]> {
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

    // The order the dial actually walks: the window's tiles in the middle, and
    // the rest arranged around them so one step off either edge is one step
    // along the list from the tile you left. Computed HERE, on the same
    // snapshot, because this is the only place that holds every machine's
    // agents in one list — the window knows its tiles, not the wheel order they
    // sit in.
    const byId = new Map(out.map((a) => [a.id, a]))

    for (const a of out) this.knownAgents.set(a.id, a)
    // A tile the window has open, whose agent has left the list. Put it back — under the name and
    // machine it was last seen with, so the dial's tile keeps saying what the window's tile says.
    //
    // Gated on being ON THE DESK, and only that: an agent that was deleted, or one simply never
    // opened, must not be resurrected by this memory. The window holding a tile is the whole warrant.
    const missing = this.desk.filter((id) => !byId.has(id))
    for (const id of missing) {
      const remembered = this.knownAgents.get(id)
      if (!remembered) continue
      // Appended, not slotted back where it was. When a machine drops out none of its agents are left
      // to sit beside, so the end of the list is the only honest place; and the ring is built around
      // the DESK, so where a tile sits in the flat list only shifts which agents the arcs reach.
      // Never routed by position either — `agentMachine` below is what sends a turn home.
      out.push(remembered)
      byId.set(id, remembered)
      if (remembered.machineId) this.agentMachine.set(id, remembered.machineId)
      if (!this.deskHeld.has(id)) {
        this.deskHeld.add(id)
        this.wiring.log(`cable: holding ${id.slice(0, 8)} on the ring — the window has a tile for it`)
      }
    }
    for (const id of [...this.deskHeld]) if (!missing.includes(id)) this.deskHeld.delete(id)

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

  openAgent(agentId: string): void {
    const machineId = this.machineOf(agentId)
    if (!machineId) {
      // Same rule as focus: an agent id without its machine is not routable, and guessing is how a
      // remote move used to land on a local agent.
      this.wiring.log(`cable: ignored open for unknown agent ${agentId}`)
      return
    }
    this.wiring.log(`cable: open ${machineId}/${agentId} (notification)`)
    this.wiring.opened?.(machineId, agentId)
  }

  /** Whether this daemon's last list held that agent — see CableHost.knows. */
  knows(agentId: string): boolean {
    return this.agentMachine.has(agentId)
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
   *
   * `unknown` is NOT a reason to drop anything, and reading it as one cost a morning. It means the
   * backend could not be asked — `MachineListCache.degrade()` sets every machine to it in one go when
   * the list cannot be refreshed, on the stated principle that the rows are "stale but not wrong". The
   * agents follow the rows: kept, with no timer, until the backend actually says offline. Measured on
   * the real dial, the old reading emptied a remote machine off the carousel mid-session with no log
   * line, while the window went on showing those agents — which is what made a swipe run out of agents
   * early, and an agent chosen in the window have no tile to move to.
   */
  private refreshRemotes(machines: CableMachine[]): void {
    if (!this.fleet) return
    const now = Date.now()
    for (const m of machines) {
      if (m.local) continue
      const entry = this.remoteAgents.get(m.id)
      if (m.state === 'offline' || m.state === 'needs-link') {
        // The machine ITSELF says it has nothing to offer, which is different from not being able to
        // ask it. No grace period, but never silently: an agent leaving the carousel is exactly the
        // event that is impossible to diagnose after the fact from its absence.
        if (entry && entry.agents.length) {
          this.remoteAgents.set(m.id, { agents: [], at: now, asked: entry.asked })
          this.wiring.log(`cable: ${m.name} is ${m.state} — its ${entry.agents.length} agents left the carousel`)
        }
        continue
      }
      // Not ready and not refused: the backend could not be asked. Keep what it last said.
      if (m.state !== 'ready') continue
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

  /**
   * Deliver a turn, and SAY whether it could be.
   *
   * The remote leg is fire-and-forget by protocol — `message` frames carry no ack — so a machine that
   * has stopped answering takes the turn and nothing comes back. Measured: the fleet's own `agents_list`
   * was timing out every twenty seconds while a ⌘K route was handed to an agent on that machine, and
   * every side stayed silent about it. The E2EE session still said `ready`, because it handshook while
   * the machine was alive; the backend's list still called it online.
   *
   * So the check is the one thing that actually knows: did the LAST request to that machine come back.
   * Never asked (null) is not a refusal — a cold start must not read as a failure.
   *
   * Callers that do not care may ignore the result; nothing here changes for them.
   */
  sendTurn(agentId: string, text: string): { ok: true } | { ok: false; machine: string; reason: string } {
    if (!this.isLocalAgent(agentId)) {
      const machineId = this.machineOf(agentId)
      const machine = this.knownAgents.get(agentId)?.machine || machineId.slice(0, 8)
      if (!machineId) return { ok: false, machine, reason: 'that agent has no machine on this daemon' }
      const seen = this.fleet?.reachable?.(machineId)
      if (seen && !seen.ok) {
        const ago = Math.round((Date.now() - seen.at) / 1000)
        this.wiring.log(`cable: refused a turn for ${agentId.slice(0, 8)} — ${machine} last failed ${ago}s ago`)
        return { ok: false, machine, reason: 'the last request to it did not come back' }
      }
      this.fleet!.sendTurn(machineId, agentId, text)
      this.spokeTo(agentId)
      return { ok: true }
    }
    this.wiring.sendTurn(agentId, text)
    this.spokeTo(agentId)
    return { ok: true }
  }

  /**
   * Remember who this person is talking to.
   *
   * Recorded HERE because every path that actually delivers a turn passes through sendTurn — the
   * window's palette, the dial naming a tile, and the router's own fallback — so there is one fact and
   * one place it is written. Recorded only on a delivery that was accepted: a turn refused because its
   * machine went deaf is not a conversation anybody is in the middle of.
   */
  private spokeTo(agentId: string): void {
    if (agentId) this.lastTurn = { agentId, at: Date.now() }
  }

  /** Who the last delivered turn went to, and how long ago — the router's continuity signal. */
  lastRouted(): RouterContinuity | undefined {
    if (!this.lastTurn) return undefined
    return { agentId: this.lastTurn.agentId, agoMs: Date.now() - this.lastTurn.at }
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
    const machineId = this.machineOf(agentId)
    if (!machineId) {
      // An agent id without its machine is not routable. Guessing the selected or local machine is how a
      // remote dial move used to yank the desktop back to a local agent.
      this.wiring.log(`cable: ignored focus for unknown agent ${agentId}`)
      return
    }
    // Which tile the window should put this agent in, for one it has no tile
    // for: the edge of the desk the agent belongs to. The dial never says which
    // way the thumb went — it does not have to, because an agent's side of the
    // ring already answers it.
    const edge = this.deskEdge.get(agentId)
    this.wiring.log(`cable: focus ${machineId}/${agentId}${edge ? ` (off-desk, ${edge})` : ''}`)
    this.wiring.focused?.(machineId, agentId, edge)
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
  async recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string }>> {
    const raw = this.isLocalAgent(agentId)
      ? this.wiring.recent(agentId, 3)
      : await this.fleet!.recentSummaries(this.machineOf(agentId), agentId)
    return raw
      .map((r) => ({ recap: r?.recap ?? '', text: r?.text ?? '', ask: r?.ask ?? '' }))
      .filter((s) => s.recap || s.text || s.ask)
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
  /**
   * Give the window first refusal on a spoken task.
   *
   * A pass-through by design: everything interesting — whether a window is even attached, the two-phase
   * wait, the deadlines — belongs to the router in windowRoute.ts, which is testable without a socket.
   * This exists so the session can ask through the same host it asks everything else through.
   */
  async routeInWindow(text: string, cmd?: string): Promise<WindowRoute> {
    if (!this.wiring.routeInWindow) return { t: 'unavailable' }
    try {
      return await this.wiring.routeInWindow(text, cmd)
    } catch (err) {
      // Never let a broken window path swallow a sentence a person spoke: fall back to routing here.
      this.wiring.log(`cable: the window route failed (${(err as Error).message}) — routing here`)
      return { t: 'unavailable' }
    }
  }

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

      // THE QUESTION, not the answer. A recap summarises what the agent replied — "1945." is a correct
      // recap and a useless routing signal, and the next question about the same conversation matches
      // nothing in it. The ask carries the topic, so it wins when there is one; the recap stands in for
      // turns recorded before this was stored, and for agents on other machines.
      recentSummary: (await this.recentSummaries(a.id))
        .map((r) => r.ask || r.recap || r.text || '')
        .filter(Boolean)
        .join(' · '),
    })))
    const decision = await routeVoiceTask(transcript, candidates, undefined, undefined, this.lastRouted())
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

/**
 * Translate one device-bound `commander_question_close` into the dial's `question.close`.
 *
 * The other half of `cableQuestionFor`. A question is a TUI dialog in a pane, not a server-side object,
 * so "somebody answered it" reaches this daemon as "the dialog is no longer on the pane" — and every
 * client still drawing it has to be told, or it sits waiting for an answer nobody can give any more.
 */
export function cableQuestionCloseFor(
  frame: { type?: string; agentId?: string; payload?: { requestId?: string } },
): { agentId: string; requestId: string } | null {
  if (frame.type !== 'commander_question_close' || !frame.agentId) return null
  const requestId = frame.payload?.requestId
  if (typeof requestId !== 'string' || !requestId) return null
  return { agentId: frame.agentId, requestId }
}
