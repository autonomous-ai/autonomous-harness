import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { startHookServer, type HookServerHandlers } from './hookServer.js'
import { launcherSessions, MACHINE_WS_PATH } from './lib/launcherSessions.js'
import { markDeleted, resetDeleted } from './lib/deletedSessions.js'

/**
 * The launcher socket is the adapter's liveness signal: while it is open the session exists, and its
 * close is what drops the tile. These tests pin that contract plus the upgrade gate.
 */

const servers: Array<{ close: () => void }> = []

afterEach(() => {
  resetDeleted()
  for (const s of servers.splice(0)) s.close()
  for (const s of launcherSessions.list()) launcherSessions.close(s.launcherId)
})

const noopHandlers = (over: Partial<HookServerHandlers> = {}): HookServerHandlers => ({
  onRegistered: () => {},
  onSessionEnd: () => {},
  ...over,
})

async function boot(over: Partial<HookServerHandlers> = {}): Promise<number> {
  const { server } = await startHookServer(0, noopHandlers(over))
  servers.push({ close: () => server.close() })
  return (server.address() as AddressInfo).port
}

function connect(port: number, headers?: Record<string, string>, path = MACHINE_WS_PATH): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
}

const OPEN = {
  t: 'open',
  launcherId: '11111111-2222-4333-8444-555555555555',
  engine: 'claude',
  tmuxPane: '%3',
  cwd: '/tmp/demo',
}

describe('harness launcher socket', () => {
  it('registers the session while the socket is open, and drops it the moment it closes', async () => {
    const closed: string[] = []
    const port = await boot({ onLauncherClosed: (id) => closed.push(id) })
    const ws = connect(port)
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify(OPEN))

    await vi.waitFor(() => expect(launcherSessions.has(OPEN.launcherId)).toBe(true))
    // Only a live id makes a hook registration count as an agent (hookServer gates on this).
    expect(launcherSessions.get(OPEN.launcherId)?.tmuxPane).toBe('%3')

    ws.close()
    await vi.waitFor(() => expect(launcherSessions.has(OPEN.launcherId)).toBe(false))
    expect(closed).toEqual([OPEN.launcherId]) // → forgetSession, no reaper, no polling
  })

  it('will not let a just-deleted session register itself again', async () => {
    // Deleting an agent no longer kills its pane, so the engine keeps running for a moment and its catch
    // hook (every turn boundary) still POSTs here. The launcher IS alive, which is all this endpoint used
    // to check — so without the tombstone the tile the user deleted comes straight back.
    const registered: string[] = []
    const port = await boot({ onRegistered: (entry) => registered.push(entry.sessionId) })
    const ws = connect(port)
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify(OPEN))
    await vi.waitFor(() => expect(launcherSessions.has(OPEN.launcherId)).toBe(true))

    const post = (sessionId: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/hook/session-start`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId, launcherId: OPEN.launcherId, engine: 'cursor', tmuxPane: '%3',
        cwd: '/tmp/demo', hookEvent: 'UserPromptSubmit',
      }),
    })

    await post('live-session')
    await vi.waitFor(() => expect(registered).toEqual(['live-session']))

    markDeleted('doomed-session')
    const res = await post('doomed-session')
    expect(await res.json()).toMatchObject({ ignored: true, reason: 'deleted' })
    expect(registered).toEqual(['live-session'])

    ws.close()
  })

  it('waits for a transcript the engine announced but has not written yet', async () => {
    // Claude fires SessionStart BEFORE creating the file — measured 3s apart on a real pane. Registration
    // requires a real file behind a session, so the announcement used to be refused outright and the agent
    // stayed off the list until something else stumbled on it.
    const projects = mkdtempSync(join(tmpdir(), 'hookwait-'))
    const transcriptPath = join(projects, 'late-session.jsonl')
    process.env.CLAUDE_PROJECTS_DIR = projects
    vi.resetModules()
    const { startHookServer: freshServer } = await import('./hookServer.js')
    const { launcherSessions: freshBook, MACHINE_WS_PATH: freshPath } = await import('./lib/launcherSessions.js')
    const registered: string[] = []
    const { server } = await freshServer(0, { onRegistered: (e) => registered.push(e.sessionId), onSessionEnd: () => {} })
    servers.push({ close: () => { server.close(); rmSync(projects, { recursive: true, force: true }) } })
    const port = (server.address() as { port: number }).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}${freshPath}`)
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify(OPEN))
    await vi.waitFor(() => expect(freshBook.has(OPEN.launcherId)).toBe(true))

    const res = await fetch(`http://127.0.0.1:${port}/api/hook/session-start`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'late-session', launcherId: OPEN.launcherId, engine: 'claude',
        tmuxPane: '%3', cwd: '/tmp/demo', transcriptPath, hookEvent: 'SessionStart',
      }),
    })
    expect(await res.json()).toMatchObject({ pending: true })
    expect(registered).toEqual([])           // nothing to register yet — and nothing refused either

    writeFileSync(transcriptPath, '{}\n')   // the engine finishes starting up
    await vi.waitFor(() => expect(registered).toEqual(['late-session']), { timeout: 5_000 })
    ws.close()
    freshBook.close(OPEN.launcherId)
  })

  it('refuses an upgrade that carries an Origin header (i.e. from a web page)', async () => {
    const port = await boot()
    // A browser cannot omit Origin, and unlike fetch() it can open a loopback WebSocket freely — so this
    // is the WS-side equivalent of the x-adapter-local gate on the mutating HTTP routes.
    const ws = connect(port, { Origin: 'http://evil.example' })
    const outcome = await new Promise<string>((r) => {
      ws.on('open', () => r('open'))
      ws.on('error', () => r('refused'))
      ws.on('close', () => r('refused'))
    })
    expect(outcome).toBe('refused')
  })

  it('refuses an upgrade on any other path', async () => {
    const port = await boot()
    const ws = connect(port, undefined, '/api/not-machine')
    const outcome = await new Promise<string>((r) => {
      ws.on('open', () => r('open'))
      ws.on('error', () => r('refused'))
      ws.on('close', () => r('refused'))
    })
    expect(outcome).toBe('refused')
  })

  it('drops a socket whose open payload is invalid', async () => {
    const port = await boot()
    const ws = connect(port)
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ ...OPEN, tmuxPane: 'not-a-pane' }))
    await new Promise<void>((r) => ws.on('close', () => r()))
    expect(launcherSessions.has(OPEN.launcherId)).toBe(false)
  })

  it('lets a reconnect reclaim the same id without the old socket evicting it', async () => {
    const closed: string[] = []
    const port = await boot({ onLauncherClosed: (id) => closed.push(id) })

    const first = connect(port)
    await new Promise<void>((r) => first.on('open', () => r()))
    first.send(JSON.stringify(OPEN))
    await vi.waitFor(() => expect(launcherSessions.has(OPEN.launcherId)).toBe(true))

    // Same launcher reconnecting (e.g. after a daemon self-update restart) re-announces the SAME id.
    const second = connect(port)
    await new Promise<void>((r) => second.on('open', () => r()))
    second.send(JSON.stringify(OPEN))
    await vi.waitFor(() => expect(launcherSessions.get(OPEN.launcherId)).toBeTruthy())

    // The superseded socket closing must NOT take the session down with it.
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED))
    await new Promise((r) => setTimeout(r, 50))
    expect(launcherSessions.has(OPEN.launcherId)).toBe(true)
    expect(closed).toEqual([])
  })
})
