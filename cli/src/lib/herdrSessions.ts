import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HerdrEndpointError, resolveHerdrEndpoint, type HerdrEndpoint } from './herdrApiClient.js'

const exec = promisify(execFile)
const MAX_LIST_BYTES = 512 * 1024

export interface HerdrSessionListRow {
  name: string
  running: boolean
  session_dir: string
  socket_path: string
}

export type HerdrTargetResolution =
  | { state: 'available'; sessionName: string; endpoint: HerdrEndpoint }
  | { state: 'unavailable'; sessionName: string; reason: string }

function validRow(value: unknown): value is HerdrSessionListRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<HerdrSessionListRow>
  return typeof row.name === 'string'
    && row.name.length <= 64
    && typeof row.running === 'boolean'
    && typeof row.session_dir === 'string'
    && row.session_dir.length <= 4_096
    && typeof row.socket_path === 'string'
    && row.socket_path.length <= 4_096
}

export function parseHerdrSessionList(stdout: string): HerdrSessionListRow[] {
  if (Buffer.byteLength(stdout) > MAX_LIST_BYTES) throw new Error('Herdr session list exceeds the size limit')
  const parsed = JSON.parse(stdout) as { sessions?: unknown }
  if (!Array.isArray(parsed.sessions) || !parsed.sessions.every(validRow)) {
    throw new Error('Herdr session list has an incompatible shape')
  }
  return parsed.sessions
}

/** CLI bootstrap contains no prompt/session transcript content and is never used for pane control. */
export async function listInstalledHerdrSessions(herdrBin = 'herdr'): Promise<HerdrSessionListRow[]> {
  const result = await exec(herdrBin, ['session', 'list', '--json'], {
    timeout: 2_000,
    maxBuffer: MAX_LIST_BYTES,
    encoding: 'utf8',
  })
  return parseHerdrSessionList(result.stdout)
}

export async function resolveConfiguredHerdrSessions(
  sessionNames: readonly string[],
  list: () => Promise<HerdrSessionListRow[]> = listInstalledHerdrSessions,
  resolveEndpoint: typeof resolveHerdrEndpoint = resolveHerdrEndpoint,
): Promise<HerdrTargetResolution[]> {
  let rows: HerdrSessionListRow[]
  try {
    rows = await list()
  } catch {
    return sessionNames.map((sessionName) => ({
      state: 'unavailable',
      sessionName,
      reason: 'Herdr session discovery failed',
    }))
  }

  const targets = await Promise.all(sessionNames.map(async (sessionName): Promise<HerdrTargetResolution> => {
    const matches = rows.filter((row) => row.name === sessionName)
    if (matches.length !== 1 || !matches[0].running) {
      return { state: 'unavailable', sessionName, reason: 'configured Herdr session is not running' }
    }
    try {
      return {
        state: 'available',
        sessionName,
        endpoint: await resolveEndpoint({ sessionName, socketPath: matches[0].socket_path }),
      }
    } catch (error) {
      return {
        state: 'unavailable',
        sessionName,
        reason: error instanceof HerdrEndpointError
          ? `configured Herdr endpoint failed validation (${error.code})`
          : 'configured Herdr endpoint failed validation',
      }
    }
  }))

  const canonicalPaths = new Map<string, number>()
  for (const target of targets) {
    if (target.state === 'available') {
      canonicalPaths.set(target.endpoint.socketPath, (canonicalPaths.get(target.endpoint.socketPath) ?? 0) + 1)
    }
  }
  return targets.map((target) => target.state === 'available'
    && (canonicalPaths.get(target.endpoint.socketPath) ?? 0) > 1
    ? {
        state: 'unavailable',
        sessionName: target.sessionName,
        reason: 'configured Herdr sessions resolve to the same canonical endpoint',
      }
    : target)
}
