import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { cleanDevinErrorMessage, DevinErrorTail, devinLogPathForSession } from './errorLog.js'

/** The exact line Devin logged when the live session `tested-crabapple` lost its turn. */
const REAL_ERROR = "2026-07-28T06:38:22.096212Z  WARN chisel_core::translator: ACP: agent error (Internal):"
  + " Permission denied: Permission denied: We're currently facing high demand for this model."
  + " Please try again later. (trace ID: acb60788b786ddfb16a00ddb3d83b053)"
const NOISE = [
  '2026-07-28T06:38:10.872387Z  WARN chisel_api::telemetry::unleash_sampling: sentry sampling poll failed: error decoding response body',
  "2026-07-28T06:38:11.066878Z  WARN toolbox::tools::mcp: server=\"gitnexus\" error=connection closed: initialize response",
].join('\n')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function devinHome(pid = 39022, sessionId = 'tested-crabapple'): { home: string; log: string } {
  const home = mkdtempSync(join(tmpdir(), 'adapter-devin-logs-'))
  dirs.push(home)
  mkdirSync(join(home, 'session_locks'), { recursive: true })
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(join(home, 'session_locks', `${sessionId}.lock`), String(pid))
  const log = join(home, 'logs', `devin_20260728-133808_${pid}.log`)
  writeFileSync(log, '')
  return { home, log }
}

describe('devin error log', () => {
  it('resolves a session log through its lock PID', () => {
    const { home, log } = devinHome()
    // A log belonging to another devin process must not match.
    writeFileSync(join(home, 'logs', 'devin_20260728-133746_37518.log'), '')

    expect(devinLogPathForSession(home, 'tested-crabapple')).toBe(log)
    expect(devinLogPathForSession(home, 'no-such-session')).toBeNull()
  })

  it('reports the agent error and ignores unrelated WARN noise', () => {
    const { home, log } = devinHome()
    const tail = new DevinErrorTail(home, 'tested-crabapple')
    tail.seekToEnd()

    appendFileSync(log, NOISE + '\n')
    expect(tail.poll()).toEqual([])

    appendFileSync(log, REAL_ERROR + '\n')
    expect(tail.poll()).toEqual([
      "Permission denied: We're currently facing high demand for this model. Please try again later.",
    ])
    expect(tail.poll()).toEqual([]) // consumed — never re-reported
  })

  it('never replays a failure logged before the watcher attached', () => {
    const { home, log } = devinHome()
    appendFileSync(log, REAL_ERROR + '\n')

    const tail = new DevinErrorTail(home, 'tested-crabapple')
    tail.seekToEnd()
    expect(tail.poll()).toEqual([])
  })

  it('recovers when the log is truncated or rotated under it', () => {
    const { home, log } = devinHome()
    const tail = new DevinErrorTail(home, 'tested-crabapple')
    tail.seekToEnd()
    appendFileSync(log, NOISE + '\n')
    tail.poll()

    writeFileSync(log, REAL_ERROR + '\n') // shorter than the old offset
    expect(tail.poll()).toHaveLength(1)
  })

  it('binds late when the lock exists before the log file does', () => {
    const home = mkdtempSync(join(tmpdir(), 'adapter-devin-logs-'))
    dirs.push(home)
    mkdirSync(join(home, 'session_locks'), { recursive: true })
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'session_locks', 'late-session.lock'), '4242')

    const tail = new DevinErrorTail(home, 'late-session')
    tail.seekToEnd()
    expect(tail.poll()).toEqual([])

    const log = join(home, 'logs', 'devin_20260728-140000_4242.log')
    writeFileSync(log, '')
    expect(tail.poll()).toEqual([]) // first poll binds and seeks to end
    appendFileSync(log, REAL_ERROR + '\n')
    expect(tail.poll()).toHaveLength(1)
  })

  it('collapses Devin\'s doubled prefix and drops the trace id', () => {
    expect(cleanDevinErrorMessage('Permission denied: Permission denied: Too busy. (trace ID: abc123)'))
      .toBe('Permission denied: Too busy.')
    expect(cleanDevinErrorMessage('Internal error: something broke')).toBe('Internal error: something broke')
  })
})
