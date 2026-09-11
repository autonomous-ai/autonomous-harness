import { publishDown } from './bus.js'
import { routeDown } from './providerLink.js'
import { logger } from '../utils/logger.js'

/**
 * Trigger a turn in one of an agent's projects from the BACKEND (e.g. after voice STT).
 *
 * Inverted transport: instead of opening a WS to the manager, we `publishDown` the same inbound
 * `message` envelope the device/web use. It reaches the machine's node over the hub (down:{machineId} →
 * manager → node); the node creates/continues the session and runs the turn, and `done`/`result`
 * flow back to whatever commander sockets are connected (incl. the device). Fire-and-forget.
 */
export async function sendMessageToMachine(
  machineId: string,
  agentId: string,
  content: string,
  sessionId?: string | null,
): Promise<void> {
  // Continue the SAME session the device last saw for this project (from its tracked completion
  // events); on the first turn fall back to resumeLatest so the node picks the project's most recent
  // session rather than fragmenting history into a fresh session per utterance.
  const payload = sessionId
    ? { content, agentId, mode: 'auto', sessionId }
    : { content, agentId, mode: 'auto', resumeLatest: true }
  const down = { connId: '', frame: { type: 'message', payload } }
  await routeDown(machineId, down, () => publishDown(machineId, down))
  logger.info('voice turn dispatched', { machineId, agentId })
}
