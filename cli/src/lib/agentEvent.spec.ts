import { describe, expect, it } from 'vitest'
import { correlateAgentEvent, turnHeartbeatFrame } from './agentEvent.js'

describe('agent event correlation', () => {
  it.each(['turn_started', 'turn_ended'])('correlates %s to both agent and session identity', (type) => {
    expect(correlateAgentEvent({ type, payload: { value: 1 } }, 'session-1', 'agent-1')).toEqual({
      type,
      agentId: 'agent-1',
      dbSessionId: 'session-1',
      payload: { value: 1, agentId: 'agent-1', sessionId: 'session-1' },
    })
  })

  it('correlates turn heartbeats with the same wire shape', () => {
    expect(turnHeartbeatFrame('session-1', 'agent-1')).toEqual({
      type: 'turn_heartbeat',
      agentId: 'agent-1',
      dbSessionId: 'session-1',
      payload: { agentId: 'agent-1', sessionId: 'session-1' },
    })
  })
})
