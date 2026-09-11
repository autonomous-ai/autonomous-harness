import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StopDeps } from './daemonStop.js'

let dataDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonStop.js')
}

function fakeDeps(state: { pid: number | null; alive: Set<number>; killed: string[]; locked: number; released: number }, overrides: Partial<StopDeps> = {}): StopDeps {
  const clock = { now: 0 }
  return {
    readPid: () => state.pid,
    isAlive: (pid) => state.alive.has(pid),
    kill: (pid, signal) => {
      state.killed.push(`${pid}:${signal}`)
      if (signal === 'SIGKILL') state.alive.delete(pid)
    },
    sleep: async (ms) => { clock.now += ms },
    now: () => clock.now,
    lock: async () => { state.locked += 1; return () => { state.released += 1 } },
    warn: () => {},
    ...overrides,
  }
}

describe('stopDaemonProcess', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-stop-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.ADAPTER_DATA_DIR })

  it('takes the spawn lock, SIGTERMs, escalates to SIGKILL, and clears the pid file it stopped', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '500\n')
    const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
    const r = await stopDaemonProcess(fakeDeps(state))
    expect(r).toEqual({ pid: 500, stopped: true })
    expect(state.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
    expect(state.locked).toBe(1)
    expect(state.released).toBe(1)
    expect(existsSync(PID_FILE)).toBe(false)
  })

  it('does not delete a pid file that a different daemon wrote meanwhile', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '500\n')
    const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
    const deps = fakeDeps(state, {
      kill: (pid, signal) => {
        state.killed.push(`${pid}:${signal}`)
        state.alive.delete(pid)
        state.pid = 501 // the file now names someone else
        writeFileSync(PID_FILE, '501\n')
      },
    })
    await stopDaemonProcess(deps)
    expect(state.killed).toEqual(['500:SIGTERM'])
    expect(existsSync(PID_FILE)).toBe(true)
  })

  it('clears a pid file naming a dead process and reports nothing stopped', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '9\n')
    const state = { pid: 9, alive: new Set<number>(), killed: [] as string[], locked: 0, released: 0 }
    await expect(stopDaemonProcess(fakeDeps(state))).resolves.toEqual({ pid: null, stopped: false })
    expect(existsSync(PID_FILE)).toBe(false)
    expect(state.released).toBe(1)
  })
})
