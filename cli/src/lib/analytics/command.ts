/**
 * `harness analytics` — the local off switch and disclosure.
 *
 * Design: `autonomous-code` docs/design/harness-analytics.md ("Consent and privacy surfaces").
 *
 * Collection is on by default. The web app owns the account-level switch; this command owns what a
 * person sitting at THIS computer can do without a browser: see exactly what is sent, and stop it.
 *
 * `off` writes a marker file rather than editing the daemon's state JSON, because these commands are
 * short-lived processes running alongside a live daemon — two writers on one JSON file is a
 * corrupted snapshot waiting to happen. The daemon polls the marker on its existing tick.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { env } from '../../config/env.js'
import { analyticsBaseUrl, analyticsStateFile } from './collector.js'
import type { DailyReportPayload } from './contract.js'

/** Presence of this file means "this computer does not report", whatever the account says. */
export function analyticsDisabledFile(): string {
  return join(env.ADAPTER_DATA_DIR, 'analytics', 'disabled')
}

export function isLocallyDisabled(): boolean {
  try { return existsSync(analyticsDisabledFile()) } catch { return false }
}

/** Every field that can leave this computer, in the order the collector sends it. */
export const UPLOADED_FIELDS: string[] = [
  'dayUtc', 'engine', 'mode', 'origin',
  'instructions', 'turnsStarted', 'turnsCompleted', 'turnsFailed',
  'turnsCancelled', 'turnsInputNeeded', 'agentRuntimeMs',
  'wallClockActiveMs', 'activeAgents', 'uptimeMs',
  'collectorVersion', 'engineCoverage', 'enginesPresent',
]

export const NEVER_SENT: string[] = [
  'what you typed, and what any engine replied',
  'file names, paths, code, or repository names',
  'tool names, tool arguments, or command output',
  'agent names, session ids, or workspace names',
  'any per-event timestamp — only daily totals',
]

interface PersistedState {
  version?: number
  consent?: string
  epoch?: number
  reducer?: unknown
}

function readState(): PersistedState | null {
  try { return JSON.parse(readFileSync(analyticsStateFile(), 'utf8')) as PersistedState } catch { return null }
}

/**
 * Render the local report.
 *
 * Deliberately reads the daemon's persisted snapshot rather than asking the backend: the whole point
 * is to show what WOULD be sent, from a computer that may never have uploaded anything.
 */
export function localReport(): { days: DailyReportPayload[]; consent: string; epoch: number } {
  const state = readState()
  const reducer = state?.reducer as { days?: Record<string, unknown> } | undefined
  const dayKeys = Object.keys(reducer?.days ?? {}).sort()
  const days: DailyReportPayload[] = []

  for (const key of dayKeys) {
    const day = (reducer?.days as Record<string, {
      buckets?: Record<string, Record<string, number>>
      intervals?: [number, number][]
      agents?: string[]
      uptimeMs?: number
    }>)[key]
    const buckets = Object.entries(day.buckets ?? {}).map(([bucketKey, counters]) => {
      const [engine, mode, origin] = bucketKey.split('|')
      return { engine, mode, origin, ...counters } as unknown as DailyReportPayload['buckets'][number]
    })
    days.push({
      dayUtc: key,
      machineDay: {
        wallClockActiveMs: (day.intervals ?? []).reduce((acc, [s, e]) => acc + (e - s), 0),
        activeAgents: (day.agents ?? []).length,
        uptimeMs: day.uptimeMs ?? 0,
        reported: true,
      },
      buckets,
    })
  }

  return { days, consent: state?.consent ?? 'on', epoch: state?.epoch ?? 0 }
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  const hours = Math.floor(minutes / 60)
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function renderPreview(): string {
  const { days, consent, epoch } = localReport()
  const out: string[] = []

  out.push('Harness Analytics — what this computer would send')
  out.push('')
  out.push(`  upload state   ${isLocallyDisabled() ? 'off on this computer' : describeConsent(consent)}`)
  out.push(`  endpoint       ${analyticsBaseUrl()}/api/analytics/report`)
  out.push(`  epoch          ${epoch}`)
  out.push('')
  out.push('FIELDS — one row per engine, per day')
  out.push('')
  for (const field of UPLOADED_FIELDS) out.push(`  ${field}`)
  out.push('')
  out.push('NEVER SENT')
  out.push('')
  for (const item of NEVER_SENT) out.push(`  ×  ${item}`)
  out.push('')

  if (days.length === 0) {
    out.push('Nothing recorded yet. Figures appear after your next agent turn.')
    return out.join('\n')
  }

  out.push(`RECORDED LOCALLY — ${days.length} day${days.length === 1 ? '' : 's'}`)
  out.push('')
  for (const day of days.slice(-14)) {
    const instructions = day.buckets.reduce((a, b) => a + b.instructions, 0)
    const completed = day.buckets.reduce((a, b) => a + b.turnsCompleted, 0)
    const failed = day.buckets.reduce((a, b) => a + b.turnsFailed + b.turnsCancelled, 0)
    out.push(
      `  ${day.dayUtc}   ${String(instructions).padStart(4)} instructions` +
      `   ${String(completed).padStart(4)} completed` +
      `   ${String(failed).padStart(3)} failed/cancelled` +
      `   ${duration(day.machineDay.wallClockActiveMs).padStart(8)} active`,
    )
  }
  out.push('')
  out.push('No prompt content is included, here or in what is uploaded.')
  return out.join('\n')
}

function describeConsent(consent: string): string {
  if (consent === 'off') return 'off (the account owner turned it off)'
  // Collection is on by default; anything that is not an explicit off is uploading.
  return 'uploading'
}

export function disableLocally(): string {
  const target = analyticsDisabledFile()
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${new Date().toISOString()}\n`, 'utf8')
  // Drop what was already collected: leaving it would upload the moment someone re-enabled.
  try { rmSync(analyticsStateFile(), { force: true }) } catch { /* nothing to drop */ }
  return 'Analytics is off on this computer. Local records were deleted.\nTurn it back on with: harness analytics on'
}

export function enableLocally(): string {
  try { rmSync(analyticsDisabledFile(), { force: true }) } catch { /* already on */ }
  return 'Analytics is on for this computer.'
}

/** Dispatch for `harness analytics [preview|on|off]`. */
export function runAnalyticsCommand(sub: string | undefined): string {
  if (sub === 'off') return disableLocally()
  if (sub === 'on') return enableLocally()
  if (!sub || sub === 'preview' || sub === 'status' || sub === 'report') return renderPreview()
  return `Unknown subcommand "${sub}".\nUsage: harness analytics [preview|on|off]`
}
