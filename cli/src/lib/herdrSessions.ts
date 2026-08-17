import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'
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

/**
 * Does a hook's terminal hint identify THIS already-resolved endpoint?
 *
 * Measured on herdr 0.8.0: a pane's environment carries `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`,
 * `HERDR_ENV`, `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` — and **no `HERDR_SESSION`**. Matching a backend
 * by session name alone therefore rejected every real Herdr hook (`no_matching_engine_process`, 37 times
 * in one afternoon here), so no session ever bound: a resumed session showed a blank conversation and a
 * turn typed in the pane produced no frames at all.
 *
 * The socket path is the better key anyway — it is what the endpoint IS, while the session name is a
 * label for it. Both are accepted, whichever the running Herdr exports, and a field that is present but
 * disagrees disqualifies the match.
 *
 * This only ever SELECTS among endpoints already validated at discovery: a hook cannot introduce a
 * socket, only point at one we resolved ourselves. Symlinked paths are compared canonically so a hook
 * reporting `~/.config/...` still matches an endpoint resolved through `/System/Volumes/Data/...`.
 */
export function herdrHintSelects(
  endpoint: Pick<HerdrEndpoint, 'sessionName' | 'socketPath'>,
  hint: { sessionName?: string; socketPath?: string },
): boolean {
  const wantsName = !!hint.sessionName
  const wantsPath = !!hint.socketPath
  if (!wantsName && !wantsPath) return false
  if (wantsName && endpoint.sessionName !== hint.sessionName) return false
  if (wantsPath && !samePath(endpoint.socketPath, hint.socketPath!)) return false
  return true
}

function samePath(left: string, right: string): boolean {
  if (left === right) return true
  try { return realpathSync(left) === realpathSync(right) } catch { return false }
}

/**
 * Is a Herdr binary visible to this user, without spawning anything?
 *
 * Auto-detection runs before every reconcile pass, and the overwhelmingly common machine has no Herdr
 * at all — so the negative case must cost nothing. A PATH walk with `accessSync(X_OK)` is a handful of
 * stat calls (the same technique `engineBin.commandCandidates` uses to resolve vendor CLIs); spawning
 * `herdr session list` only to watch it fail with ENOENT twelve times a minute is not acceptable as a
 * default. An absolute `HERDR_BIN` is checked directly.
 */
export function herdrBinaryAvailable(herdrBin = 'herdr'): boolean {
  const candidates = herdrBin.includes('/')
    ? [herdrBin]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, herdrBin))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch { /* keep looking */ }
  }
  return false
}

/**
 * Every Herdr session that is currently RUNNING, resolved the same way a configured one is.
 *
 * This is what "no configuration" means in practice: the names come from the user's own `herdr session
 * list`, not from an env var they have to know about, so starting a session — with any name, at any
 * time — makes its panes discoverable on the next pass. Nothing about the trust model changes: every
 * endpoint still goes through `resolveHerdrEndpoint`'s canonical-path, owner, type, mode and
 * socket-generation checks, and a hook-supplied socket path still never widens what is adopted here.
 *
 * Returns [] when Herdr is absent or reports nothing, which is the quiet path for a tmux-only machine.
 */
export async function discoverRunningHerdrSessions(
  herdrBin = 'herdr',
  list: () => Promise<HerdrSessionListRow[]> = () => listInstalledHerdrSessions(herdrBin),
  resolveEndpoint: typeof resolveHerdrEndpoint = resolveHerdrEndpoint,
): Promise<HerdrTargetResolution[]> {
  if (!herdrBinaryAvailable(herdrBin)) return []
  let rows: HerdrSessionListRow[]
  try {
    rows = await list()
  } catch {
    // Installed but unusable (a broken build, a version whose `session list --json` shape moved). Not an
    // error the operator asked for, so it is simply nothing to adopt.
    return []
  }
  const running = rows.filter((row) => row.running).map((row) => row.name)
  if (!running.length) return []
  return resolveConfiguredHerdrSessions(running, async () => rows, resolveEndpoint)
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
