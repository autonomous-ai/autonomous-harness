import { describe, expect, it } from 'vitest'
import { AnalyticsReducer, mergeInterval, splitAcrossDays, unionMs } from './reducer.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const at = (iso: string): number => Date.parse(iso)

function reducer(): AnalyticsReducer {
  return new AnalyticsReducer()
}

describe('interval union', () => {
  it('merges overlapping intervals instead of adding them', () => {
    let merged: [number, number][] = []
    merged = mergeInterval(merged, 0, 25 * MIN)
    merged = mergeInterval(merged, 5 * MIN, 30 * MIN)

    expect(merged).toEqual([[0, 30 * MIN]])
    expect(unionMs(merged)).toBe(30 * MIN)
  })

  it('keeps disjoint intervals apart', () => {
    let merged: [number, number][] = []
    merged = mergeInterval(merged, 0, 10 * MIN)
    merged = mergeInterval(merged, 40 * MIN, 50 * MIN)

    expect(unionMs(merged)).toBe(20 * MIN)
  })

  it('closes a gap when a later interval bridges two existing ones', () => {
    let merged: [number, number][] = []
    merged = mergeInterval(merged, 0, 10 * MIN)
    merged = mergeInterval(merged, 40 * MIN, 50 * MIN)
    merged = mergeInterval(merged, 5 * MIN, 45 * MIN)

    expect(merged).toEqual([[0, 50 * MIN]])
  })
})

/**
 * The first of the two additivity fixtures the design requires as permanent regressions.
 */
describe('overlapping turns on different engines', () => {
  it('sums runtime but unions wall-clock time', () => {
    const r = reducer()
    r.turnStarted('a', at('2026-08-11T10:00:00Z'), 'claude', 'managed', 'human')
    r.turnStarted('b', at('2026-08-11T10:05:00Z'), 'codex', 'managed', 'human')
    r.turnFinished('a', at('2026-08-11T10:25:00Z'), 'completed')
    r.turnFinished('b', at('2026-08-11T10:30:00Z'), 'completed')

    const day = r.reportFor('2026-08-11', 'managed')!
    const runtime = day.buckets.reduce((acc, b) => acc + b.agentRuntimeMs, 0)

    expect(runtime).toBe(50 * MIN)
    expect(day.machineDay.wallClockActiveMs).toBe(30 * MIN)
  })
})

/**
 * The second fixture: one agent, two origins, must still be one active agent.
 */
describe('one agent across two origins', () => {
  it('counts the agent once while splitting its counters by origin', () => {
    const r = reducer()
    r.instruction(at('2026-08-11T09:00:00Z'), 'claude', 'managed', 'human', 'agent-1')
    r.instruction(at('2026-08-11T11:00:00Z'), 'claude', 'managed', 'human', 'agent-1')
    r.turnStarted('s', at('2026-08-11T12:00:00Z'), 'claude', 'managed', 'scheduled')
    r.turnFinished('s', at('2026-08-11T12:10:00Z'), 'completed')

    const day = r.reportFor('2026-08-11', 'managed')!

    expect(day.machineDay.activeAgents).toBe(1)
    expect(day.buckets).toHaveLength(2)
    expect(day.buckets.find((b) => b.origin === 'human')!.instructions).toBe(2)
    expect(day.buckets.find((b) => b.origin === 'scheduled')!.turnsCompleted).toBe(1)
  })

  it('does not count a scheduled turn towards active agents', () => {
    const r = reducer()
    r.instruction(at('2026-08-11T09:00:00Z'), 'claude', 'managed', 'scheduled', 'agent-1')

    expect(r.reportFor('2026-08-11', 'managed')!.machineDay.activeAgents).toBe(0)
  })
})

describe('midnight', () => {
  it('splits a turn across the UTC day boundary', () => {
    expect(splitAcrossDays(at('2026-08-11T23:30:00Z'), at('2026-08-12T00:30:00Z'))).toEqual([
      { start: at('2026-08-11T23:30:00Z'), end: at('2026-08-12T00:00:00Z') },
      { start: at('2026-08-12T00:00:00Z'), end: at('2026-08-12T00:30:00Z') },
    ])
  })

  it('attributes runtime to both days and the outcome to the day it ended', () => {
    const r = reducer()
    r.turnStarted('t', at('2026-08-11T23:30:00Z'), 'claude', 'managed', 'human')
    r.turnFinished('t', at('2026-08-12T00:30:00Z'), 'completed')

    const first = r.reportFor('2026-08-11', 'managed')!
    const second = r.reportFor('2026-08-12', 'managed')!

    expect(first.machineDay.wallClockActiveMs).toBe(30 * MIN)
    expect(second.machineDay.wallClockActiveMs).toBe(30 * MIN)
    expect(first.buckets.reduce((a, b) => a + b.turnsCompleted, 0)).toBe(0)
    expect(second.buckets.reduce((a, b) => a + b.turnsCompleted, 0)).toBe(1)
  })
})

describe('stale turns', () => {
  it('closes a turn the machine never finished, instead of losing the day', () => {
    const r = reducer()
    r.turnStarted('t', at('2026-08-11T10:00:00Z'), 'claude', 'managed', 'human')

    expect(r.closeStaleTurns(at('2026-08-11T12:00:00Z'))).toBe(0)
    expect(r.closeStaleTurns(at('2026-08-13T10:00:00Z'))).toBe(1)

    const day = r.reportFor('2026-08-12', 'managed')!
    expect(day.buckets.reduce((a, b) => a + b.turnsFailed, 0)).toBe(1)
  })

  it('ignores a turn_finished for an id it never saw start', () => {
    const r = reducer()
    r.turnFinished('ghost', at('2026-08-11T10:00:00Z'), 'completed')

    expect(r.reportFor('2026-08-11', 'managed')).toBeNull()
  })
})

describe('heartbeat and uptime', () => {
  it('emits reported:true on a day with no activity at all', () => {
    const r = reducer()
    r.tickUptime(at('2026-08-11T10:00:00Z'), 60_000, 90_000)

    const day = r.reportFor('2026-08-11', 'managed')!
    expect(day.machineDay.reported).toBe(true)
    expect(day.machineDay.wallClockActiveMs).toBe(0)
    expect(day.buckets).toHaveLength(0)
  })

  it('caps a single uptime credit so a suspended container cannot claim the gap', () => {
    const r = reducer()
    r.tickUptime(at('2026-08-11T10:00:00Z'), 6 * HOUR, 90_000)

    expect(r.reportFor('2026-08-11', 'managed')!.machineDay.uptimeMs).toBe(90_000)
  })

  it('splits an uptime credit that spans midnight', () => {
    const r = reducer()
    r.tickUptime(at('2026-08-12T00:00:30Z'), 60_000, 90_000)

    expect(r.reportFor('2026-08-11', 'managed')!.machineDay.uptimeMs).toBe(30_000)
    expect(r.reportFor('2026-08-12', 'managed')!.machineDay.uptimeMs).toBe(30_000)
  })
})

describe('persistence', () => {
  it('survives a restart with its open turns intact', () => {
    const first = reducer()
    first.turnStarted('t', at('2026-08-11T10:00:00Z'), 'claude', 'managed', 'human')

    const revived = new AnalyticsReducer(JSON.parse(JSON.stringify(first.snapshot())))
    revived.turnFinished('t', at('2026-08-11T10:20:00Z'), 'completed')

    expect(revived.reportFor('2026-08-11', 'managed')!.machineDay.wallClockActiveMs).toBe(20 * MIN)
  })

  it('forgets days already stored centrally', () => {
    const r = reducer()
    r.tickUptime(at('2026-08-09T10:00:00Z'), 60_000, 90_000)
    r.tickUptime(at('2026-08-11T10:00:00Z'), 60_000, 90_000)
    r.forgetBefore('2026-08-11')

    expect(r.reportableDays()).toEqual(['2026-08-11'])
  })

  it('keeps the local store bounded', () => {
    const r = reducer()
    const base = at('2020-01-01T00:00:00Z')
    for (let i = 0; i < 130; i++) r.tickUptime(base + i * DAY, 1000, 90_000)

    expect(r.reportableDays().length).toBeLessThanOrEqual(120)
  })
})

describe('privacy', () => {
  it('never puts an agent id on the wire', () => {
    const r = reducer()
    r.instruction(at('2026-08-11T09:00:00Z'), 'claude', 'managed', 'human', 'secret-agent-name')
    r.turnStarted('t', at('2026-08-11T09:00:00Z'), 'claude', 'managed', 'human')
    r.turnFinished('t', at('2026-08-11T09:10:00Z'), 'completed')

    const wire = JSON.stringify(r.reportFor('2026-08-11', 'managed'))
    expect(wire).not.toContain('secret-agent-name')
    expect(JSON.parse(wire).machineDay.activeAgents).toBe(1)
  })
})
