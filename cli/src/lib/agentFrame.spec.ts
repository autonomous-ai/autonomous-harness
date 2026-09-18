import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('never carries the grid launch — the key stays in the registry', async () => {
    const row = session(assignment)
    row.gridLaunch = { networkId: 'grid-abc', networkName: 'Team grid', baseUrl: assignment.baseUrl, apiKey: 'gridkey-SECRET' }
    const frame = await agentFrame(row, { selectedModel: null, terminalAvailable: true })
    expect(frame).not.toHaveProperty('gridLaunch')
    expect(JSON.stringify(frame)).not.toContain('gridkey-SECRET')
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

  it('carries the viewer pane’s name with the harness, and null for a plain engine', async () => {
    const withViewer = await agentFrame(session(null), {
      selectedModel: null, terminalAvailable: true,
      dsh: { id: 'autonomous/blender', name: 'Blender', viewerUrl: 'http://127.0.0.1:4100/', viewerName: '3D Viewer', verdict: null },
    })
    expect(withViewer).toMatchObject({ dsh: 'autonomous/blender', dshName: 'Blender', viewerName: '3D Viewer' })
    const older = await agentFrame(session(null), {
      selectedModel: null, terminalAvailable: true,
      dsh: { id: 'autonomous/blender', name: 'Blender', viewerUrl: null, verdict: null },
    })
    expect(older).toHaveProperty('viewerName', null)
    expect(await agentFrame(session(null), { selectedModel: null, terminalAvailable: true })).toHaveProperty('viewerName', null)
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

describe('agentFrame updatedAt', () => {
  const context = { selectedModel: null, terminalAvailable: true }
  const lastHook = Date.UTC(2026, 8, 17, 7)

  // The regression: discovery rewrites the registry's `updatedAt` on every pass, so an agent with no
  // readable transcript was stamped "now" forever and a phone sorting by recency put it on top.
  it('follows the last hook without a transcript, never the bookkeeping clock', async () => {
    const row = { ...session(null), updatedAt: Date.now(), lastHookAt: lastHook }
    expect((await agentFrame(row, context)).updatedAt).toBe('2026-09-17T07:00:00.000Z')
  })

  it('an unreadable transcript falls back to the last hook too', async () => {
    const row = { ...session(null), transcriptPath: '/nonexistent/agent-frame.jsonl', updatedAt: Date.now(), lastHookAt: lastHook }
    expect((await agentFrame(row, context)).updatedAt).toBe('2026-09-17T07:00:00.000Z')
  })

  it("prefers the transcript's mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-frame-'))
    try {
      const transcriptPath = join(dir, 'session.jsonl')
      await writeFile(transcriptPath, '{}\n')
      const written = new Date('2026-09-18T01:02:03.000Z')
      await utimes(transcriptPath, written, written)
      const row = { ...session(null), transcriptPath, updatedAt: Date.now(), lastHookAt: lastHook }
      expect((await agentFrame(row, context)).updatedAt).toBe(written.toISOString())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
