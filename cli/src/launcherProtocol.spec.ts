import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { startHookServer, type HookServerHandlers } from './hookServer.js'
import { launcherSessions, MACHINE_WS_PATH } from './lib/launcherSessions.js'
import { SUPPORTED_PROTOCOLS } from './lib/launcherProtocol.js'

/**
 * THE COMPATIBILITY CONTRACT.
 *
 * OTA ships one bundle for both sides, but a running `harness <engine>` keeps its build for hours while
 * the daemon restarts onto the new one. So every launcher ever released keeps talking to today's daemon.
 *
 * The frames below are written out BY HAND on purpose — they are what an old launcher puts on the wire,
 * not something derived from the current types. If a change to the daemon makes this file red, a
 * launcher already in someone's terminal just broke; fix the daemon, do not "update" the frame.
 */

const servers: Array<{ close: () => void }> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const s of launcherSessions.list()) launcherSessions.close(s.launcherId)
})

async function boot(over: Partial<HookServerHandlers> = {}): Promise<number> {
  const { server } = await startHookServer(0, { onRegistered: () => {}, onSessionEnd: () => {}, ...over })
  servers.push({ close: () => server.close() })
  return (server.address() as AddressInfo).port
}

/** Open a socket, send `frame`, and resolve with the daemon's first reply (or null on close). */
async function exchange(port: number, frame: unknown): Promise<Record<string, unknown> | null> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${MACHINE_WS_PATH}`)
  await new Promise<void>((r) => ws.on('open', () => r()))
  const reply = new Promise<Record<string, unknown> | null>((resolve) => {
    ws.on('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
    ws.on('close', () => resolve(null))
  })
  ws.send(JSON.stringify(frame))
  const out = await reply
  try { ws.close() } catch { /* ignore */ }
  return out
}

describe('launcher↔daemon protocol contract', () => {
  it('accepts a hand-written v1 open frame — the shape released launchers send', async () => {
    const port = await boot()
    const reply = await exchange(port, {
      t: 'open',
      v: 1,
      launcherId: '11111111-2222-4333-8444-555555555555',
      engine: 'claude',
      tmuxPane: '%3',
      cwd: '/tmp/demo',
      version: '0.0.1',
    })
    expect(reply?.t).toBe('opened')
    expect(reply?.v).toBe(1)
    expect(typeof reply?.version).toBe('string') // the daemon's build, for the stale-build notice
    expect(launcherSessions.has('11111111-2222-4333-8444-555555555555')).toBe(true)
  })

  it('accepts a frame with NO version field at all (launchers released before versioning)', async () => {
    const port = await boot()
    const reply = await exchange(port, {
      t: 'open',
      launcherId: '22222222-2222-4333-8444-555555555555',
      engine: 'codex',
      tmuxPane: '%4',
      cwd: '/tmp/demo',
    })
    expect(reply?.t).toBe('opened')
    expect(launcherSessions.has('22222222-2222-4333-8444-555555555555')).toBe(true)
  })

  it('answers an unsupported protocol explicitly instead of ignoring it', async () => {
    const port = await boot()
    // Silence is the failure mode this replaces: the socket would stay open, so the launcher would see no
    // disconnect, while the session never registered.
    const reply = await exchange(port, {
      t: 'open', v: 99, launcherId: '33333333-2222-4333-8444-555555555555',
      engine: 'claude', tmuxPane: '%5', cwd: '/tmp/demo',
    })
    expect(reply?.t).toBe('error')
    expect(reply?.reason).toBe('unsupported_protocol')
    expect(reply?.supported).toEqual([...SUPPORTED_PROTOCOLS])
  })

  it('tells the launcher which engine binary to run, so binary policy lives in the daemon', async () => {
    const port = await boot()
    const reply = await exchange(port, {
      t: 'open', v: 1, launcherId: '44444444-2222-4333-8444-555555555555',
      engine: 'commandcode', tmuxPane: '%6', cwd: '/tmp/demo', version: '0.0.1',
    })
    // `commandcode` → `cmd` was a real rename; an old launcher must not be left spawning the old name.
    expect(reply?.bin).toBe('cmd')
  })

  it('never removes a protocol version — SUPPORTED_PROTOCOLS only grows', () => {
    // Dropping a version breaks launchers already running in someone's terminal. Adding is fine.
    expect(SUPPORTED_PROTOCOLS).toContain(1)
  })

  it('pushes a notice to a live launcher without disturbing its socket', async () => {
    const port = await boot()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MACHINE_WS_PATH}`)
    await new Promise<void>((r) => ws.on('open', () => r()))
    const frames: Array<Record<string, unknown>> = []
    let closed = false
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>) })
    ws.on('close', () => { closed = true })
    ws.send(JSON.stringify({
      t: 'open', v: 1, launcherId: '55555555-2222-4333-8444-555555555555',
      engine: 'claude', tmuxPane: '%9', cwd: '/tmp/demo', version: '0.0.1',
    }))
    await vi.waitFor(() => expect(frames.some((f) => f.t === 'opened')).toBe(true))

    // Unprompted: nothing on the launcher asked for this, which is the whole point of the frame.
    await launcherSessions.notifyAll({ t: 'notice', level: 'warn', text: 'restarting', durationMs: 8_000 })

    await vi.waitFor(() => expect(frames.some((f) => f.t === 'notice')).toBe(true))
    const notice = frames.find((f) => f.t === 'notice')
    expect(notice).toMatchObject({ level: 'warn', text: 'restarting', durationMs: 8_000 })
    // A notice is not a goodbye: the session stays live and the socket stays open.
    expect(closed).toBe(false)
    expect(launcherSessions.has('55555555-2222-4333-8444-555555555555')).toBe(true)
    ws.close()
  })

  it('delivers an exit request verbatim, and leaves the socket for the launcher to close', async () => {
    const port = await boot()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MACHINE_WS_PATH}`)
    await new Promise<void>((r) => ws.on('open', () => r()))
    const frames: Array<Record<string, unknown>> = []
    let closed = false
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>) })
    ws.on('close', () => { closed = true })
    const launcherId = '77777777-2222-4333-8444-555555555555'
    ws.send(JSON.stringify({
      t: 'open', v: 1, launcherId, engine: 'claude', tmuxPane: '%11', cwd: '/tmp/demo', version: '0.0.1',
    }))
    await vi.waitFor(() => expect(frames.some((f) => f.t === 'opened')).toBe(true))

    launcherSessions.get(launcherId)?.socket.send(JSON.stringify({ t: 'exit', reason: 'deleted' }))

    await vi.waitFor(() => expect(frames.some((f) => f.t === 'exit')).toBe(true))
    expect(frames.find((f) => f.t === 'exit')).toMatchObject({ reason: 'deleted' })
    // The daemon does NOT hang up: the launcher still needs the socket while it stops its engine, and the
    // close must come from its own child-exit path so teardown stays on one route.
    expect(closed).toBe(false)
    ws.close()
  })

  it('survives notifying a launcher that has already gone', async () => {
    const port = await boot()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MACHINE_WS_PATH}`)
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({
      t: 'open', v: 1, launcherId: '66666666-2222-4333-8444-555555555555',
      engine: 'claude', tmuxPane: '%10', cwd: '/tmp/demo', version: '0.0.1',
    }))
    await vi.waitFor(() => expect(launcherSessions.has('66666666-2222-4333-8444-555555555555')).toBe(true))
    ws.terminate() // the pane's terminal window was closed
    await vi.waitFor(() => expect(launcherSessions.has('66666666-2222-4333-8444-555555555555')).toBe(false))

    // The only caller so far is the update restart. A dead socket there must never throw, hang, or take
    // the restart down with it.
    await expect(launcherSessions.notifyAll({ t: 'notice', text: 'still here?' })).resolves.toBeUndefined()
  })
})
