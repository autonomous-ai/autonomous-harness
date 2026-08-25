// The daemon's view of the OTHER machines the owner has, and the one lane that reaches them.
//
// Split out of cableHost.ts so the cable protocol layer never learns the word "relay": everything the dial
// can ask for is answered either from this process (the cabled computer's own registry) or through this
// interface, and `DaemonCableHost` is the single place that decides which.
//
// THE LOCAL MACHINE NEVER COMES THROUGH HERE. Its agents, turns and recaps are in this process already;
// routing them through the cloud to reach a dial plugged into this very computer would add a network
// round trip, a failure mode and an audience — for nothing.
import type { CableAgent } from './cableSession.js'
import type { RecentTurn } from './cableHost.js'

/** One of the owner's machines, as the fleet knows it. The local row is added by the host, not here. */
export interface FleetMachine {
  machineId: string
  name: string
  /** `ready` = reachable now · `offline` = known but not reachable · `unknown` = the list itself is stale
   *  · `needs-link` = reachable, but this daemon holds no pinned key for it, so nothing can be read. */
  state: 'ready' | 'offline' | 'unknown' | 'needs-link'
  authMode: 'self' | 'managed' | 'remote' | 'provider'
}

/** A refusal that a person can act on. `message` reaches the dial's screen verbatim. */
export class FleetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FleetError'
  }
}

/** A card from an attached machine, already translated into the dial's four kinds. */
export type FleetEvent =
  | { machineId: string; kind: 'processing' | 'done' | 'summary' | 'error'; agentId: string; text: string; recap: string }
  | { machineId: string; kind: 'question'; agentId: string; requestId: string; questions: unknown }
  | { machineId: string; kind: 'state'; state: FleetMachine['state'] }

/**
 * Everything the dial needs from a machine that is NOT this computer.
 *
 * Deliberately an interface: it lets the whole cable half be built, tested and flashed against a fleet
 * that knows only the local machine, long before a lane to anywhere else exists.
 */
export interface MachineFleet {
  /**
   * The owner's machines, EXCLUDING this computer.
   *
   * Must resolve rather than reject when the backend is unreachable — `source` is how a short list
   * explains itself, and a dial whose daemon is offline still has one machine that works perfectly.
   */
  list(): Promise<{ machines: FleetMachine[]; source: 'backend' | 'local' | 'signed-out' }>
  /** Attach to a machine. Throws `FleetError` on refusal. */
  select(machineId: string): Promise<void>
  /** Release whatever `select` acquired. Called when the dial goes back to the local machine. */
  release(): void
  listAgents(machineId: string): Promise<CableAgent[]>
  sendTurn(machineId: string, agentId: string, text: string): void
  stopTurn(machineId: string, agentId: string): void
  answer(machineId: string, agentId: string, requestId: string, answers: Record<string, string>): void
  updateAgent(machineId: string, agentId: string, model?: string, effort?: string): void
  listModels(machineId: string, agentId: string): Promise<string[]>
  recentSummaries(machineId: string, agentId: string): Promise<RecentTurn[]>
  /** Cards + liveness from the attached machine. Returns an unsubscribe. */
  onEvent(cb: (event: FleetEvent) => void): () => void
}
