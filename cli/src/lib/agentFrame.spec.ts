import { describe, expect, it } from 'vitest'
import { agentFrame } from './agentFrame.js'
import type { RegisteredSession } from './registry.js'

function session(grid: RegisteredSession['grid'], codexHome: RegisteredSession['codexHome'] = null): RegisteredSession {
  return {
    schemaVersion: 2,
    active: true,
    sessionId: 's1', engine: 'claude', agentId: 'h1', boundAt: 0, transcriptPath: null,
    projectDir: 'tmp', cwd: '/tmp', tmuxPane: '%1', source: null, title: null, model: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux/%1',
    cliVersion: '2.1.212', processIdentity: null, gateway: null, grid, codexHome,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

const assignment = { baseUrl: 'https://grid.autonomous.ai/grid-abc/relay', model: 'DeepSeek-V4-Flash-0731' }

describe('agentFrame', () => {
  // The regression this file exists for: `agent_synced` was built by a SECOND, hand-maintained copy
  // of this shape that never grew a `grid` field. The desktop rebuilds its Agent from every push, so
  // each sync reset an agent's grid to null and the "N agents are on an older target" banner came
  // back minutes after the user had already moved them onto the grid they picked.
  it('carries the grid assignment, so a push cannot erase what a list reported', async () => {
    expect(await agentFrame(session(assignment), { selectedModel: null, terminalAvailable: true }))
      .toMatchObject({ grid: assignment })
  })

  it('reports no assignment as null rather than omitting the field', async () => {
    const frame = await agentFrame(session(null), { selectedModel: null, terminalAvailable: true })
    expect(frame).toHaveProperty('grid', null)
  })

  it('carries the chosen Codex profile folder', async () => {
    expect(await agentFrame(session(null, '/Users/x/.codex-personal'), { selectedModel: null, terminalAvailable: true }))
      .toMatchObject({ codexHome: '/Users/x/.codex-personal' })
  })

  it('reports no Codex profile as null rather than omitting the field', async () => {
    const frame = await agentFrame(session(null), { selectedModel: null, terminalAvailable: true })
    expect(frame).toHaveProperty('codexHome', null)
  })

  it('passes through the caller-resolved model and terminal availability', async () => {
    expect(await agentFrame(session(null), { selectedModel: 'opus', terminalAvailable: false }))
      .toMatchObject({ selectedModel: 'opus', terminal: { available: false, primary: 'tmux/%1' } })
  })

  it('reports launch state and defaults legacy agents to ready', async () => {
    const legacy = session(null)
    expect(await agentFrame(legacy, { selectedModel: null, terminalAvailable: true }))
      .toMatchObject({ launch: { state: 'ready' } })
    legacy.launch = { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'See terminal.' }
    expect(await agentFrame(legacy, { selectedModel: null, terminalAvailable: true }))
      .toMatchObject({ launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'See terminal.' } })
  })
})
