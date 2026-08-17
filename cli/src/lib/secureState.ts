import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function ownerUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function secureStateDirectory(directory: string, create = true): void {
  if (create) mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const stat = fstatSync(fd)
    const uid = ownerUid()
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error('state directory has unsafe owner or type')
    }
    const mode = stat.mode & 0o777
    if ((mode & 0o022) !== 0) throw new Error('state directory is group/world writable')
    if (mode !== PRIVATE_DIRECTORY_MODE) {
      fchmodSync(fd, PRIVATE_DIRECTORY_MODE)
      if ((fstatSync(fd).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error('state directory permissions could not be tightened')
      }
    }
  } finally {
    closeSync(fd)
  }
}

function inspectPrivateStateFile(fd: number, maxBytes: number): void {
  const stat = fstatSync(fd)
  const uid = ownerUid()
  if (!stat.isFile() || (uid !== null && stat.uid !== uid)) {
    throw new Error('state file has unsafe owner or type')
  }
  if (stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  const mode = stat.mode & 0o777
  if ((mode & 0o022) !== 0) throw new Error('state file is group/world writable')
  if (mode !== PRIVATE_FILE_MODE) {
    fchmodSync(fd, PRIVATE_FILE_MODE)
    if ((fstatSync(fd).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

export function readPrivateStateFile(file: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function hardenPrivateStateFileIfPresent(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return true
  } finally {
    closeSync(fd)
  }
}
