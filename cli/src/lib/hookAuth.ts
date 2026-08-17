import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { secureStateDirectory } from './secureState.js'

const FILE_NAME = 'hook-credential'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function hookCredentialPath(dataDir: string): string {
  return join(dataDir, FILE_NAME)
}

function secureDataDirectory(dataDir: string): boolean {
  try {
    secureStateDirectory(dataDir, false)
    return true
  } catch {
    return false
  }
}

export function readHookCredential(dataDir: string): string | null {
  let fd: number | null = null
  try {
    if (!secureDataDirectory(dataDir)) return null
    const file = hookCredentialPath(dataDir)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!stat.isFile() || stat.size > 128) return null
    if (uid !== null && stat.uid !== uid) return null
    if ((stat.mode & 0o777) !== 0o600) return null
    const value = readFileSync(fd, 'utf8').trim()
    return TOKEN_RE.test(value) ? value : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function loadOrCreateHookCredential(dataDir: string): string {
  const existing = readHookCredential(dataDir)
  if (existing) return existing
  try {
    secureStateDirectory(dataDir)
  } catch {
    throw new Error('hook credential directory has unsafe owner, mode, or type')
  }
  const value = randomBytes(32).toString('base64url')
  const file = hookCredentialPath(dataDir)
  let fd: number
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    const raced = readHookCredential(dataDir)
    if (raced) return raced
    throw error
  }
  try {
    writeFileSync(fd, `${value}\n`)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directoryFd = openSync(dataDir, 'r')
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  return value
}

export function hookCredentialMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}
