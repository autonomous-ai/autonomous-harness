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

import type { CableAgent, CableHost, RouteDecision } from './cableSession.js'

/** One completed turn's recap, as the mirror keeps them. */
export interface RecentTurn {
  recap?: string
  text?: string
}

export interface CableHostWiring {
  machineName: () => string
  /** Deliver text into an agent. The SAME path the web and the WiFi device use — see cli.ts. */
  sendTurn: (agentId: string, text: string) => void
  stopTurn: (agentId: string) => void
  answer: (agentId: string, id: string, optionId: string) => void
  /** Recaps of an agent's last `n` completed turns, for routing. */
  recent: (agentId: string, n: number) => RecentTurn[]
  /** The opaque runtime-v1 profile, which is where the dial's Model/Effort chips come from. */
  runtimeProfile?: (session: RegisteredSession) => string | null
  updateAgent?: (agentId: string, model?: string, effort?: string) => void
  /** The runtime catalog, from the same provider the web and the WiFi device read. */
  listModels?: (agentId: string) => Promise<Array<{ id: string }>>
  log: (line: string) => void
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
  constructor(private readonly wiring: CableHostWiring) {}

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
    const sessions = registry.list()
    // Oldest → newest: a stable order that does not reshuffle as agents become active, which matters more
    // on a carousel than on a list — a tile that moves under a swipe is a tile you cannot aim at.
    sessions.sort((a, b) => a.registeredAt - b.registeredAt)
    return sessions.map((s) => ({
      id: s.agentId,
      name: projectDisplayName(s),
      engine: s.engine ?? '',
      ...chipsFromProfile(this.wiring.runtimeProfile?.(s)),
    }))
  }

  sendTurn(agentId: string, text: string): void {
    this.wiring.sendTurn(agentId, text)
  }

  stopTurn(agentId: string): void {
    this.wiring.stopTurn(agentId)
  }

  answer(agentId: string, id: string, optionId: string): void {
    this.wiring.answer(agentId, id, optionId)
  }

  focus(agentId: string): void {
    // A statement about where the user is looking. Nothing on this machine has to move for it yet — the
    // daemon has no window of its own — so it is recorded and logged rather than acted on.
    this.wiring.log(`cable: focus ${agentId}`)
  }

  updateAgent(agentId: string, model?: string, effort?: string): void {
    this.wiring.updateAgent?.(agentId, model, effort)
  }

  async listModels(agentId: string): Promise<string[]> {
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
    const candidates: RouterAgent[] = agents.map((a) => ({
      id: a.id,
      name: a.name,
      engine: a.engine,
      recentSummary: this.wiring
        .recent(a.id, 3)
        .map((r) => r?.recap || r?.text || '')
        .filter(Boolean)
        .join(' · '),
    }))
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
