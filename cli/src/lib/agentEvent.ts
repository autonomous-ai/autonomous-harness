export interface AgentEvent extends Record<string, unknown> {
  type: string
  payload: Record<string, unknown>
}

/** Add stable agent identity without removing the engine session id used by transcript events. */
export function correlateAgentEvent(
  event: AgentEvent,
  sessionId: string,
  agentId: string,
): AgentEvent & { agentId: string; dbSessionId: string } {
  return {
    ...event,
    agentId,
    dbSessionId: sessionId,
    payload: { ...event.payload, agentId, sessionId },
  }
}

export function turnHeartbeatFrame(
  sessionId: string,
  agentId: string,
): AgentEvent & { agentId: string; dbSessionId: string } {
  return correlateAgentEvent({ type: 'turn_heartbeat', payload: {} }, sessionId, agentId)
}
