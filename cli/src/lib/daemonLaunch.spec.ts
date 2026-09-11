import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LaunchDeps } from './daemonLaunch.js'

let dataDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonLaunch.js')
}

/** Deterministic deps: a virtual clock that advances on every sleep, a log that tests append to. */
function fakeDeps(overrides: Partial<LaunchDeps> = {}): LaunchDeps & { log: string[]; clock: { now: number } } {
  const clock = { now: 1_000_000 }
  const log: string[] = []
  return {
    log,
    clock,
    readPid: () => null,
    isAlive: () => false,
    readLogSlice: () => log.join('\n'),
    now: () => clock.now,
    // Advance the virtual clock and yield a real macrotask, so a test can change state "between" polls.
    sleep: (ms) => new Promise((r) => { clock.now += ms; setImmediate(r) }),
    port: 18473,
    ...overrides,
  }
}

describe('connectFailure', () => {
  it('classifies the log tail', async () => {
    const { connectFailure } = await load()
    expect(connectFailure('', 1)).toBeNull()
    expect(connectFailure('[backend] machine busy', 1)).toMatchObject({ busy: true, fatal: true })
    expect(connectFailure('Error: listen EADDRINUSE 127.0.0.1:18473', 18473)).toMatchObject({ fatal: true })
    expect(connectFailure('Error: listen EADDRINUSE 127.0.0.1:18473', 18473)?.detail).toContain('hook port 18473')
    expect(connectFailure('Unexpected server response: 401', 1)).toMatchObject({ deauth: true, fatal: true })
    expect(connectFailure('Unexpected server response: 409', 1)).toMatchObject({ busy: true })
    expect(connectFailure('Unexpected server response: 404', 1)).toMatchObject({ fatal: true, deauth: false })
    expect(connectFailure('Unexpected server response: 502', 1)).toMatchObject({ fatal: false })
    expect(connectFailure('getaddrinfo ENOTFOUND x', 1)).toMatchObject({ fatal: true })
    expect(connectFailure('connect ECONNREFUSED', 1)).toMatchObject({ fatal: false })
  })
})

describe('waitForReady', () => {
  it('returns connected as soon as the marker lands', async () => {
    const { waitForReady } = await load()
    const deps = fakeDeps()
    const p = waitForReady(0, 10_000, deps)
    deps.log.push('[cli] dialing', '[backend] connected → wss://x')
    await expect(p).resolves.toEqual({ state: 'connected' })
  })

  it('keeps waiting through transient failures and reports the last one on timeout', async () => {
    const { waitForReady } = await load()
    const deps = fakeDeps()
    deps.log.push('connect ECONNREFUSED')
    await expect(waitForReady(0, 2_000, deps)).resolves.toEqual({ state: 'unreachable', detail: 'connection refused' })
  })

  it('short-circuits on fatal, deauth and busy', async () => {
    const { waitForReady } = await load()
    for (const [line, state] of [
      ['Unexpected server response: 404', 'fatal'],
      ['Unexpected server response: 403', 'deauth'],
      ['[backend] machine busy', 'busy'],
    ] as const) {
      const deps = fakeDeps()
      deps.log.push(line)
      expect((await waitForReady(0, 10_000, deps)).state).toBe(state)
    }
  })
})

describe('waitForBind', () => {
  it('resolves bound once the pid file names the child', async () => {
    const { waitForBind } = await load()
    let pid: number | null = null
    const deps = fakeDeps({ readPid: () => pid })
    const p = waitForBind(42, () => false, 60_000, deps)
    pid = 41 // a stale file naming someone else is not our bind
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(deps.clock.now).toBeGreaterThan(1_000_000) // polled at least once while it was 41
    pid = 42
    await expect(p).resolves.toBe('bound')
  })

  it('resolves exited when the child dies first', async () => {
    const { waitForBind } = await load()
    let gone = false
    const deps = fakeDeps()
    const p = waitForBind(42, () => gone, 60_000, deps)
    gone = true
    await expect(p).resolves.toBe('exited')
  })

  it('resolves timeout when nothing happens', async () => {
    const { waitForBind } = await load()
    await expect(waitForBind(42, () => false, 5_000, fakeDeps())).resolves.toBe('timeout')
  })
})

describe('removePidFileIf', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-launch-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.ADAPTER_DATA_DIR })

  it('removes the file only when it names the given pid', async () => {
    const { removePidFileIf } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '777\n')
    expect(removePidFileIf(778)).toBe(false)
    expect(existsSync(PID_FILE)).toBe(true) // another daemon's record survives our failed child
    expect(removePidFileIf(undefined)).toBe(false)
    expect(removePidFileIf(777)).toBe(true)
    expect(existsSync(PID_FILE)).toBe(false)
  })
})
