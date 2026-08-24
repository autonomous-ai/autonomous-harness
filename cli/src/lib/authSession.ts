import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface AuthSession {
  version: 1
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  autonomousEnv: 'prod' | 'stag'
  computerId: string
  machineId?: string
  updatedAt: number
}

export class AuthSessionError extends Error {
  constructor(message: string, readonly code: 'MISSING' | 'INVALID_REFRESH' | 'UNAVAILABLE') {
    super(message)
    this.name = 'AuthSessionError'
  }
}

// HARNESS_AUTH_DIR exists for isolated test processes. Product installs always use ~/.harness/auth.
export const AUTH_DIR = process.env.HARNESS_AUTH_DIR?.trim() || join(homedir(), '.harness', 'auth')
export const AUTH_SESSION_FILE = join(AUTH_DIR, 'session.json')
const LOCK_FILE = join(AUTH_DIR, 'session.lock')
const LOCK_STALE_MS = 30_000
const REFRESH_SKEW_MS = 60_000

function parse(raw: string): AuthSession | null {
  try {
    const value = JSON.parse(raw) as Partial<AuthSession>
    if (value.version !== 1 || typeof value.accessToken !== 'string' || !value.accessToken ||
      typeof value.computerId !== 'string' || !value.computerId ||
      (value.autonomousEnv !== 'prod' && value.autonomousEnv !== 'stag')) return null
    return {
      version: 1,
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === 'string' && value.refreshToken ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
      autonomousEnv: value.autonomousEnv,
      computerId: value.computerId,
      ...(typeof value.machineId === 'string' && value.machineId ? { machineId: value.machineId } : {}),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    }
  } catch { return null }
}

export function readAuthSession(): AuthSession | null {
  try { return parse(readFileSync(AUTH_SESSION_FILE, 'utf8')) } catch { return null }
}

export function hasAuthSession(): boolean { return readAuthSession() !== null }

function ensureDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(AUTH_DIR, 0o700) } catch { /* best effort on non-POSIX */ }
}

export function writeAuthSession(session: AuthSession): void {
  ensureDir()
  const temp = join(AUTH_DIR, `.session.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(session) + '\n', { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* best effort on non-POSIX */ }
    renameSync(temp, AUTH_SESSION_FILE)
    try { chmodSync(AUTH_SESSION_FILE, 0o600) } catch { /* best effort on non-POSIX */ }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
}

export function clearAuthSession(): void {
  try { rmSync(AUTH_SESSION_FILE, { force: true }) } catch { /* ignore */ }
}

async function withLock<T>(action: () => Promise<T>): Promise<T> {
  ensureDir()
  let deadline = Date.now() + LOCK_STALE_MS
  let reclaimedStaleLock = false
  while (true) {
    let fd: number
    try {
      fd = openSync(LOCK_FILE, 'wx', 0o600)
    } catch {
      if (Date.now() >= deadline) {
        let removed = false
        try {
          const age = Date.now() - statSync(LOCK_FILE).mtimeMs
          if (age >= LOCK_STALE_MS) {
            rmSync(LOCK_FILE, { force: true })
            removed = true
          }
        } catch { /* lock disappeared or is unreadable */ }
        if (removed && !reclaimedStaleLock) {
          reclaimedStaleLock = true
          deadline = Date.now() + LOCK_STALE_MS
          continue
        }
        throw new AuthSessionError('Another Harness process is refreshing SSO credentials. Please retry.', 'UNAVAILABLE')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      continue
    }
    try {
      return await action()
    } finally {
      closeSync(fd)
      try { rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }
    }
  }
}

type RefreshResult = { token: string; refreshToken?: string; expiresIn?: number }

async function refreshRequest(baseUrl: string, current: AuthSession): Promise<RefreshResult> {
  if (!current.refreshToken) throw new AuthSessionError('No SSO refresh token. Run `harness login`.', 'MISSING')
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken, autonomousEnv: current.autonomousEnv }),
    })
  } catch {
    throw new AuthSessionError('SSO refresh service is unavailable.', 'UNAVAILABLE')
  }
  const body = await response.json().catch(() => ({})) as {
    success?: boolean; data?: { token?: unknown; refreshToken?: unknown; expiresIn?: unknown }; error?: { code?: unknown; message?: unknown }
  }
  if (response.status === 401 || body.error?.code === 'REFRESH_TOKEN_INVALID') {
    throw new AuthSessionError('SSO refresh token is invalid. Run `harness login`.', 'INVALID_REFRESH')
  }
  if (!response.ok || body.success === false || typeof body.data?.token !== 'string' || !body.data.token) {
    throw new AuthSessionError(typeof body.error?.message === 'string' ? body.error.message : 'SSO refresh service is unavailable.', 'UNAVAILABLE')
  }
  return {
    token: body.data.token,
    ...(typeof body.data.refreshToken === 'string' && body.data.refreshToken ? { refreshToken: body.data.refreshToken } : {}),
    ...(typeof body.data.expiresIn === 'number' && body.data.expiresIn > 0 ? { expiresIn: body.data.expiresIn } : {}),
  }
}

/** One in-process refresh plus a file lock for daemon/command races. */
export class AuthSessionManager {
  private refreshInFlight: Promise<string> | null = null
  constructor(private readonly backendBaseUrl: string) {}

  session(): AuthSession | null { return readAuthSession() }

  async accessToken(opts: { force?: boolean; failedToken?: string } = {}): Promise<string> {
    const current = readAuthSession()
    if (!current) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
    if (opts.failedToken && current.accessToken !== opts.failedToken) return current.accessToken
    const needsRefresh = opts.force === true || (current.expiresAt != null && current.expiresAt <= Date.now() + REFRESH_SKEW_MS)
    if (!needsRefresh) return current.accessToken
    if (this.refreshInFlight) return this.refreshInFlight
    const running = withLock(async () => {
      const latest = readAuthSession()
      if (!latest) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
      if (opts.failedToken && latest.accessToken !== opts.failedToken) return latest.accessToken
      const stillNeedsRefresh = opts.force === true || (latest.expiresAt != null && latest.expiresAt <= Date.now() + REFRESH_SKEW_MS)
      if (!stillNeedsRefresh) return latest.accessToken
      try {
        const refreshed = await refreshRequest(this.backendBaseUrl, latest)
        const next: AuthSession = {
          ...latest,
          accessToken: refreshed.token,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresIn ? { expiresAt: Date.now() + refreshed.expiresIn * 1000 } : {}),
          updatedAt: Date.now(),
        }
        writeAuthSession(next)
        return next.accessToken
      } catch (err) {
        if (err instanceof AuthSessionError && err.code === 'INVALID_REFRESH') clearAuthSession()
        throw err
      }
    })
    this.refreshInFlight = running
    try { return await running } finally { if (this.refreshInFlight === running) this.refreshInFlight = null }
  }

  updateMachineId(machineId: string): void {
    const current = readAuthSession()
    if (!current || current.machineId === machineId) return
    writeAuthSession({ ...current, machineId, updatedAt: Date.now() })
  }
}
