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

/** How the local row names itself before the daemon has ever resolved a machineId for this computer. */
function localFallbackId(computerId: string): string {
  return `cable:${computerId}`
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

  /** `undefined` = no lane to any other machine exists; the wheel is the local row and nothing else. */
  constructor(private readonly wiring: CableHostWiring, private readonly fleet?: MachineFleet) {}

  /** The identity of the computer at the other end of the cable. */
  localMachine(): { id: string; name: string } {
    return { id: this.localId(), name: this.wiring.machineName() }
  }

  private localId(): string {
    return this.wiring.machineId() || localFallbackId(this.wiring.computerId())
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
      this.fleet?.release()
      this.selected = machineId
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

  async listAgents(): Promise<CableAgent[]> {
    if (!this.isLocalSelected()) return this.fleet!.listAgents(this.selectedMachine())
    // `active()`, not `list()` — the SAME set `agents_list` answers the web and the desktop app with. They
    // read one registry and must not disagree about what is on it: a dead agent holding a tile on the dial
    // and nowhere else is a tile that cannot be driven and cannot be explained.
    const sessions = registry.active()
    // Oldest → newest, and TOTAL: the id breaks a tie so the order cannot fall through to array position,
    // which is Map insertion order and differs between daemon runs. Both producers sort identically, so
    // the dial and the app cannot drift apart while reading the same registry.
    sessions.sort((a, b) => a.registeredAt - b.registeredAt || a.agentId.localeCompare(b.agentId))
    return sessions.map((s) => ({
      id: s.agentId,
      name: projectDisplayName(s),
      engine: s.engine ?? '',
      ...chipsFromProfile(this.wiring.runtimeProfile?.(s)),
    }))
  }

  sendTurn(agentId: string, text: string): void {
    if (!this.isLocalSelected()) { this.fleet!.sendTurn(this.selectedMachine(), agentId, text); return }
    this.wiring.sendTurn(agentId, text)
  }

  stopTurn(agentId: string): void {
    if (!this.isLocalSelected()) { this.fleet!.stopTurn(this.selectedMachine(), agentId); return }
    this.wiring.stopTurn(agentId)
  }

  answer(agentId: string, requestId: string, answers: Record<string, string>): void {
    if (!this.isLocalSelected()) { this.fleet!.answer(this.selectedMachine(), agentId, requestId, answers); return }
    this.wiring.answer(agentId, requestId, answers)
  }

  focus(agentId: string): void {
    // A statement about where the user is looking, and the desktop window follows it: turning the dial to
    // an agent switches the terminal on screen to the same one. The daemon still has no window of its own
    // — it forwards, and the app decides what following means for it.
    // Local only, and not an oversight: this says where a hand at THIS desk is looking. There is no
    // window here to move for an agent running on another computer, and moving one there is not what the
    // person turning the dial asked for.
    if (!this.isLocalSelected()) return
    this.wiring.log(`cable: focus ${agentId}`)
    this.wiring.focused?.(agentId)
  }

  scrolled(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void {
    // THE ENDS ARE LOGGED, THE MIDDLE IS NOT. A stroke is a `down`, a dozen `move`s and an `up`, several
    // times a second: logging the middle buries every other line in the file. But the failure this
    // protocol is most exposed to is a stroke that never CLOSES — the far side then holds a drag forever
    // and its list stops answering the mouse — and that failure is invisible without a matching pair to
    // look for. Two lines per swipe buys the one thing worth seeing.
    if (!this.isLocalSelected()) return   // same reasoning as focus(): a finger on this glass, this desk
    if (phase !== 'move') {
      this.wiring.log(phase === 'down' ? 'cable: scroll ↓' : `cable: scroll ↑ (v=${velocity})`)
    }
    this.wiring.scrolled?.(phase, dy, velocity)
  }

  updateAgent(agentId: string, model?: string, effort?: string): void {
    if (!this.isLocalSelected()) { this.fleet!.updateAgent(this.selectedMachine(), agentId, model, effort); return }
    this.wiring.updateAgent?.(agentId, model, effort)
  }

  /** The last few turns, newest first, in the shape the dial's tile draws: a headline and a body. */
  async recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string }>> {
    const raw = this.isLocalSelected()
      ? this.wiring.recent(agentId, 3)
      : await this.fleet!.recentSummaries(this.selectedMachine(), agentId)
    return raw.map((r) => ({ recap: r?.recap ?? '', text: r?.text ?? '' })).filter((s) => s.recap || s.text)
  }

  async listModels(agentId: string): Promise<string[]> {
    if (!this.isLocalSelected()) return this.fleet!.listModels(this.selectedMachine(), agentId)
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
    // The recaps must come from the SELECTED machine. Scored against this computer's history instead, a
    // spoken turn meant for a remote agent is routed by what the agents HERE were last doing — which is
    // both wrong and completely invisible, because the router always answers with something.
    const candidates: RouterAgent[] = await Promise.all(agents.map(async (a) => ({
      id: a.id,
      name: a.name,
      engine: a.engine,
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
