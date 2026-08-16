import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TerminalConfig } from '../config/terminalConfig.js'
import type { HerdrEndpoint } from './herdrApiClient.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'
import type { TerminalBackendName } from './terminalTypes.js'

const SNAPSHOT_FILE = 'terminal-config.json'
const MAX_SNAPSHOT_BYTES = 64 * 1024

export interface TerminalConfigEndpointSnapshot {
  sessionName: string
  endpointId: string
  socketPath: string
  generation: { device: number; inode: number }
}

export interface TerminalConfigSnapshot {
  version: 1
  updatedAt: number
  backends: TerminalBackendName[]
  herdrEndpoints: TerminalConfigEndpointSnapshot[]
}

export function terminalConfigSnapshotPath(dataDir: string): string {
  return join(dataDir, SNAPSHOT_FILE)
}

export function writeTerminalConfigSnapshot(
  dataDir: string,
  config: TerminalConfig,
  endpoints: readonly HerdrEndpoint[],
): TerminalConfigSnapshot {
  const allowed = new Set(config.herdrSessions)
  const herdrEndpoints = endpoints
    .filter((endpoint) => allowed.has(endpoint.sessionName))
    .sort((a, b) => config.herdrSessions.indexOf(a.sessionName) - config.herdrSessions.indexOf(b.sessionName))
    .map(({ sessionName, endpointId, socketPath, generation }) => ({
      sessionName,
      endpointId,
      socketPath,
      generation: { ...generation },
    }))
  const snapshot: TerminalConfigSnapshot = {
    version: 1,
    updatedAt: Date.now(),
    backends: [...config.backends],
    herdrEndpoints,
  }
  secureStateDirectory(dataDir)
  const file = terminalConfigSnapshotPath(dataDir)
  hardenPrivateStateFileIfPresent(file, MAX_SNAPSHOT_BYTES)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`)
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    renamed = true
    const directoryFd = openSync(dataDir, 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
  return snapshot
}

function validString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

export function readTerminalConfigSnapshot(dataDir: string): TerminalConfigSnapshot | null {
  const file = terminalConfigSnapshotPath(dataDir)
  try {
    secureStateDirectory(dataDir, false)
    const parsed = JSON.parse(readPrivateStateFile(file, MAX_SNAPSHOT_BYTES)) as Partial<TerminalConfigSnapshot>
    if (parsed.version !== 1 || !Number.isFinite(parsed.updatedAt)) return null
    if (!Array.isArray(parsed.backends)
      || parsed.backends.some((backend) => backend !== 'tmux' && backend !== 'herdr')
      || new Set(parsed.backends).size !== parsed.backends.length) return null
    if (!Array.isArray(parsed.herdrEndpoints)) return null
    for (const endpoint of parsed.herdrEndpoints) {
      if (!endpoint || typeof endpoint !== 'object') return null
      if (!validString(endpoint.sessionName, 64)
        || !validString(endpoint.endpointId)
        || !validString(endpoint.socketPath, 4_096)
        || !isAbsolute(endpoint.socketPath)
        || !Number.isSafeInteger(endpoint.generation?.device)
        || !Number.isSafeInteger(endpoint.generation?.inode)) return null
    }
    return parsed as TerminalConfigSnapshot
  } catch {
    return null
  }
}
