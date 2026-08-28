// `MachineFleet` for real: the REST machine list, plus one device socket to whichever machine the dial is
// currently on.
//
// The split is deliberate and load-bearing. The LIST costs an HTTP read and works signed-in-but-offline;
// the LANE costs a cloud socket and only exists while the user is actually looking at another machine. A
// dial parked on the local machine — which is where it sits most of the time — holds no socket at all.
import { FleetError, type FleetEvent, type FleetMachine, type MachineFleet } from '../cable/machineFleet.js'
import type { CableAgent } from '../cable/cableSession.js'
import type { RecentTurn } from '../cable/cableHost.js'
import type { MachineListCache } from './machineList.js'
import type { DeviceFrame, DeviceLink } from './deviceLink.js'

/** How long the socket lingers after the dial goes back to local, so flicking between two machines does
 *  not pay a full dial each way. Mirrors RemoteRelayPool's own linger for the same reason. */
const LINGER_MS = 60_000

/** Split `runtime-v1:<sid>:<engine>:<model>@<effort>` into the two words the dial's chips show. */
function chipsFromProfile(profile: unknown): { model?: string; effort?: string } {
  if (typeof profile !== 'string' || !profile.startsWith('runtime-v1:')) return {}
  const tail = profile.split(':').slice(3).join(':')
  if (!tail) return {}
  const [model, effort] = tail.split('@')
  return { model: model || undefined, effort: effort || undefined }
}

/** Map an `agents_list_result` row onto the cable's agent shape. */
function toCableAgent(raw: unknown): CableAgent {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: typeof r.id === 'string' ? r.id : '',
    name: typeof r.name === 'string' ? r.name : '',
    engine: typeof r.engine === 'string' ? r.engine : '',
    ...chipsFromProfile(r.selectedModel),
  }
}

export interface DeviceFleetOpts {
  list: MachineListCache
  link: DeviceLink
  /** Whether this daemon holds a pinned E2EE key for a machine — see `harness link connect`. */
  hasPeerLink: (machineId: string) => boolean
  log: (line: string) => void
}

export class DeviceFleet implements MachineFleet {
  private lingerTimer: NodeJS.Timeout | null = null
  private readonly recapCache = new Map<string, RecentTurn[]>()
  private readonly listeners = new Set<(e: FleetEvent) => void>()

  constructor(private readonly opts: DeviceFleetOpts) {
    this.opts.link.onFrame((frame) => this.onFrame(frame))
  }

  async list(): Promise<{ machines: FleetMachine[]; source: 'backend' | 'local' | 'signed-out' }> {
    const { machines, source } = this.opts.list.list()
    return {
      // The local row is added by the host, which knows facts about this computer that a snapshot cannot.
      machines: machines.filter((m) => !m.local).map((m) => ({
        ...m,
        // A machine with no pinned key is reachable but UNREADABLE: its agent list, its recaps and its
        // turn cards are all encrypted to a key this daemon does not hold. Saying so in the row is what
        // lets the wheel dim it and the guide behind it say which two commands fix it — far better than
        // letting the user tap it and meet an empty carousel.
        state: m.authMode === 'remote' && !this.opts.hasPeerLink(m.machineId) ? 'needs-link' as const : m.state,
      })),
      source,
    }
  }

  /**
   * The dial is plugged in: hold a socket for presence, attached to nothing.
   *
   * Cheap on purpose — see DeviceLink.online for why a held socket does not make any machine think a
   * commander is watching it.
   */
  async online(): Promise<void> {
    await this.opts.link.online()
  }

  async select(machineId: string): Promise<void> {
    const row = this.opts.list.find(machineId)
    if (!row) throw new FleetError('UNKNOWN_MACHINE', 'That machine is not on your account')
    // THIS computer is `authMode: 'remote'` like any other computer-backed machine, and it has no pinned
    // key for itself — nor does it need one. Selecting it announces where the dial is; the agents behind
    // it are read in-process, never over the relay, so there is nothing to encrypt and nothing to link.
    if (!row.local && row.authMode === 'remote' && !this.opts.hasPeerLink(machineId)) {
      // Checked HERE, locally and for free, so the guide appears instantly instead of after a connect
      // that was always going to fail.
      throw new FleetError('NEEDS_LINK', `Link ${row.name} to this computer first`)
    }
    if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = null }
    try {
      await this.opts.link.attach(machineId)
    } catch (err) {
      const message = (err as Error).message
      throw new FleetError(this.codeFor(message), this.messageFor(message, row.name))
    }
    // ONLY this machine's recaps. Clearing the whole cache was right when a select meant "throw away the
    // machine you were reading and pick up another one"; now every other machine's tiles are still on the
    // dial's carousel, and blanking them would make a select look like N agents forgetting their work.
    for (const key of [...this.recapCache.keys()]) if (key.startsWith(`${machineId}:`)) this.recapCache.delete(key)
    // NOTHING is read over the lane for this computer. Selecting it is an ANNOUNCEMENT — it tells the
    // backend where the dial is — and its agents, turns and recaps all come from this process. Asking the
    // cloud for them instead round-trips to ourselves and, because a computer-backed machine is
    // `authMode: 'remote'`, is refused outright with E2EE_REQUIRED.
    if (row.local) return
    // Prefetch the recaps SERIALLY. Not caution — the contract: the agent list stays metadata-only and
    // recaps are fetched one at a time precisely so no giant frame is ever built.
    void this.prefetchRecaps(machineId)
  }

  /**
   * `immediate` = the dial is gone, so the socket goes with it. Anything else is a NO-OP, and the reason
   * is worth stating because this used to detach after a linger.
   *
   * Detaching sent `machine_deselect`, which drops the backend's ACTIVE machine pointer — and the backend
   * refuses `agents_list`/`message` outright while there is no active machine, tagged for another machine
   * or not (deviceWs's ensureActiveReady). So the linger would have quietly killed the carousel a minute
   * after the user went back to the local machine. There is also nothing left for it to buy: with the
   * `multi_machine` cap the backend holds a commander on every machine for as long as the socket lives,
   * so detaching one of them frees nothing.
   */
  release(immediate = false): void {
    if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = null }
    if (!immediate) return
    this.opts.link.release()
    this.recapCache.clear()
  }


  // ── EVERY method below NAMES ITS MACHINE ────────────────────────────────────────────────────────
  // These used to `void machineId` and let the frame land on whatever machine was attached, because
  // exactly one ever was. The dial now holds every machine's agents in one carousel, so the machine is
  // no longer implied by the selection and has to travel with the frame: the backend routes a device
  // frame by its outer `machineId` tag (deviceWs.handleFrame) and answers from THAT machine's node.
  // Dropping the tag would not fail loudly — it would quietly ask the wrong computer.

  async listAgents(machineId: string): Promise<CableAgent[]> {
    const res = await this.opts.link.rpc('agents_list', {}, machineId)
    const raw = Array.isArray(res.agents) ? res.agents : []
    return raw.map(toCableAgent).filter((a) => a.id)
  }

  sendTurn(machineId: string, agentId: string, text: string): void {
    // `resumeLatest` matches what the backend's own voice path dispatches, so a dial turn and a spoken
    // turn land on the same session rather than one of them starting a new one.
    this.tagged(machineId, { type: 'message', payload: { content: text, agentId, mode: 'auto', resumeLatest: true } })
  }

  stopTurn(machineId: string, agentId: string): void {
    this.tagged(machineId, { type: 'cancel', payload: { agentId } })
  }

  answer(machineId: string, agentId: string, requestId: string, answers: Record<string, string>): void {
    this.tagged(machineId, { type: 'question_response', payload: { agentId, requestId, answers } })
  }

  updateAgent(machineId: string, agentId: string, model?: string, effort?: string): void {
    if (!model) return
    // The far end owns what the profile means; this only reassembles the opaque string it round-trips.
    const selectedModel = `runtime-v1:${agentId}:claude:${model}@${effort || 'auto'}`
    void this.opts.link.rpc('agent_update', { agentId, selectedModel }, machineId)
      .catch((err) => this.opts.log(`device: agent_update failed (${(err as Error).message})`))
  }

  async listModels(machineId: string, agentId: string): Promise<string[]> {

    // `compact` is what keeps the catalog inside the dial's picker; the backend trims to ≤24 entries.
    const res = await this.opts.link.rpc('models_list', { agentId, compact: true }, machineId)

    const raw = Array.isArray(res.models) ? res.models : []
    return raw.map((m) => (typeof m === 'string' ? m : String((m as Record<string, unknown>)?.id ?? ''))).filter(Boolean)
  }

  async recentSummaries(machineId: string, agentId: string): Promise<RecentTurn[]> {
    const key = `${machineId}:${agentId}`
    const cached = this.recapCache.get(key)
    if (cached) return cached
    try {
      const res = await this.opts.link.rpc('agent_recent', { agentId, n: 3 }, machineId)

      const events = Array.isArray(res.events) ? res.events : []
      const turns = events.map((e) => {
        const r = (e ?? {}) as Record<string, unknown>
        return { recap: typeof r.recap === 'string' ? r.recap : '', text: typeof r.text === 'string' ? r.text : '' }
      })
      this.recapCache.set(key, turns)

      return turns
    } catch (err) {
      this.opts.log(`device: agent_recent ${agentId} failed (${(err as Error).message})`)
      return []
    }
  }

  onEvent(cb: (event: FleetEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  /** Send a frame addressed to one machine. The tag is what the backend routes on. */
  private tagged(machineId: string, frame: DeviceFrame): void {
    this.opts.link.send({ ...frame, machineId })
  }

  private async prefetchRecaps(machineId: string): Promise<void> {

    try {
      const agents = await this.listAgents(machineId)
      for (const a of agents) await this.recentSummaries(machineId, a.id)
    } catch (err) {
      this.opts.log(`device: recap prefetch failed (${(err as Error).message})`)
    }
  }

  private onFrame(frame: DeviceFrame): void {
    const selected = this.opts.link.selectedMachine
    // WHICH MACHINE SENT IT. The hub stamps `machineId` on every frame it fans out to a commander
    // client, and since the dial's carousel spans machines, that tag is the answer rather than a filter:
    // a card from a machine the user is not looking at still belongs to a tile that is on screen.
    //
    // This used to DROP anything not wearing the selected machine's tag. That was right when one machine
    // was attached at a time and is exactly wrong now — it would silence every tile but one, and the
    // silence would look like agents that simply never finish a turn.
    const from = typeof frame.machineId === 'string' && frame.machineId ? frame.machineId : selected


    // OUR OWN cards, come back to us the long way. Selecting the local machine attaches a commander to
    // it, so everything this daemon emits for the dial is fanned back down this socket — and the dial has
    // already had it, in-process, milliseconds earlier. Dropping it here rather than at the consumer
    // keeps the echo out of the event stream entirely.
    if (frame.machineId && this.opts.list.find(frame.machineId)?.local) return

    const payload = (frame.payload ?? {}) as Record<string, unknown>
    if (frame.type === 'commander_event' && frame.agentId) {
      const kind = payload.kind
      if (kind !== 'processing' && kind !== 'done' && kind !== 'summary' && kind !== 'error') return
      this.emit({
        machineId: from,
        kind,

        agentId: frame.agentId,
        text: typeof payload.text === 'string' ? payload.text : '',
        recap: typeof payload.recap === 'string' ? payload.recap : '',
      })
      return
    }
    if (frame.type === 'commander_question' && frame.agentId) {
      const requestId = payload.requestId
      if (typeof requestId !== 'string' || !Array.isArray(payload.questions)) return
      this.emit({ machineId: from, kind: 'question', agentId: frame.agentId, requestId, questions: payload.questions })

      return
    }
    if (frame.type === 'node_status') {
      this.emit({ machineId: from, kind: 'state', state: payload.online === true ? 'ready' : 'offline' })

      return
    }
    // The live machine list. This is what the held socket buys: without it the wheel's dots are a REST
    // snapshot up to a minute old, and a machine that just came up stays grey while the user looks at it.
    if (frame.type === 'machines_status') {
      const rows = Array.isArray(payload.statuses) ? payload.statuses : []
      if (this.opts.list.applyLive(rows as Array<{ machineId?: unknown; online?: unknown }>)) {
        this.emit({ machineId: from, kind: 'state', state: 'ready' })

      }
    }
  }

  private emit(event: FleetEvent): void {
    for (const cb of this.listeners) cb(event)
  }

  /** Map the far end's words onto a code the dial can act on. Unknown reasons stay unreachable. */
  private codeFor(message: string): string {
    if (message.includes('NOT_YOUR_MACHINE')) return 'NOT_YOURS'
    if (message.includes('MACHINE_ENV_MISMATCH')) return 'NOT_YOURS'
    if (message.includes('PAYMENT') || message.includes('SUBSCRIPTION')) return 'BILLING'
    if (message.includes('START_FAILED')) return 'UNREACHABLE'
    return 'UNREACHABLE'
  }

  private messageFor(message: string, name: string): string {
    if (message.includes('NOT_YOUR_MACHINE') || message.includes('MACHINE_ENV_MISMATCH')) {
      return `${name} is not on this account`
    }
    if (message.includes('PAYMENT') || message.includes('SUBSCRIPTION')) return `${name} needs a subscription`
    return `Can’t reach ${name}`
  }
}
